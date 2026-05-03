'use strict';

/**
 * workers/hoursParseWorker.js
 *
 * Parses OSM-format hours strings → hours_json JSONB for all businesses.
 * Runs once on startup (batch pass), then daily to catch newly enriched rows.
 *
 * OSM hours format examples:
 *   "Mo-Fr 09:00-17:00"
 *   "Mo-Sa 10:00-21:00; Su 11:00-19:00"
 *   "Tu-Th 11:30-23:00; Fr,Sa 11:30-24:00; Su,Mo 11:30-22:00"
 *   "24/7"
 *   "Mo-Su"  (open all day, no times)
 *   "Mo-Sa 06:00-22:00; Su off"
 *
 * Output hours_json shape:
 * {
 *   Monday:    { open: true, from: "09:00", to: "17:00" },
 *   Tuesday:   { open: true, from: "09:00", to: "17:00" },
 *   ...
 *   Saturday:  { open: true, from: "09:00", to: "14:00" },
 *   Sunday:    { open: false }
 * }
 *
 * Zero LLM. Deterministic OSM parser.
 */

const db = require('../lib/db');

const DAYS_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
const DAY_MAP = {
  mo: 'Monday', tu: 'Tuesday', we: 'Wednesday', th: 'Thursday',
  fr: 'Friday', sa: 'Saturday', su: 'Sunday',
};

// Expand a day range like "Mo-Fr" or "Tu,Th" into array of full day names
function expandDays(token) {
  const t = token.trim().toLowerCase();
  // Comma-separated individual days: "Fr,Sa" or "Su,Mo"
  if (t.includes(',')) {
    return t.split(',').flatMap(d => expandDays(d.trim()));
  }
  // Range: "Mo-Fr"
  if (t.includes('-')) {
    const [start, end] = t.split('-').map(d => d.trim());
    const si = DAYS_FULL.indexOf(DAY_MAP[start]);
    const ei = DAYS_FULL.indexOf(DAY_MAP[end]);
    if (si === -1 || ei === -1) return [];
    // Handle wrap-around: "Su-Tu" (Sun, Mon, Tue)
    if (si <= ei) return DAYS_FULL.slice(si, ei + 1);
    return [...DAYS_FULL.slice(si), ...DAYS_FULL.slice(0, ei + 1)];
  }
  // Single day: "Mo"
  const full = DAY_MAP[t];
  return full ? [full] : [];
}

// Parse a single segment like "Mo-Fr 09:00-17:00" or "Su off" or "24/7"
function parseSegment(seg, result) {
  const s = seg.trim();
  if (!s) return;

  // 24/7 — all days open all day
  if (/^24\/7$/i.test(s)) {
    DAYS_FULL.forEach(d => { result[d] = { open: true, from: '00:00', to: '24:00' }; });
    return;
  }

  // Split day part from time part.
  // Day part: all characters up to (but not including) the first HH:MM time pattern.
  // Handles "Mo-Tu, Th 08:30-14:30" → dayPart="Mo-Tu, Th" timePart="08:30-14:30"
  // Also handles "Mo-Fr 09:00-17:00", "Su off", "Mo-Su" (no time)
  const timeIdx = s.search(/\d{1,2}:\d{2}/);
  let dayRaw, timeRaw;
  if (timeIdx === -1) {
    dayRaw  = s;
    timeRaw = '';
  } else {
    dayRaw  = s.slice(0, timeIdx).trim();
    timeRaw = s.slice(timeIdx).trim();
  }
  // Also handle "off" / "closed" as text-only time part
  const offMatch = s.match(/^([A-Za-z,\-\s]+)\s+(off|closed)$/i);
  if (offMatch) { dayRaw = offMatch[1].trim(); timeRaw = offMatch[2].trim(); }
  const match = [null, dayRaw, timeRaw];
  if (!match[1]) return;

  const dayPart  = match[1];
  const timePart = (match[2] || '').trim().toLowerCase();
  const days     = expandDays(dayPart);
  if (!days.length) return;

  // "off" or "closed" = explicitly closed; empty time = open all day (no hours given)
  if (timePart === 'off' || timePart === 'closed') {
    days.forEach(d => { result[d] = { open: false }; });
    return;
  }
  if (!timePart) {
    days.forEach(d => { result[d] = { open: true, from: null, to: null }; });
    return;
  }

  // Time range: "09:00-17:00" or "09:00-17:00,18:00-20:00" (take first span)
  const timeMatch = timePart.match(/(\d{1,2}:\d{2})-(\d{1,2}:\d{2})/);
  if (timeMatch) {
    days.forEach(d => { result[d] = { open: true, from: timeMatch[1], to: timeMatch[2] }; });
  } else {
    // Has time text but unparseable — mark open, no times
    days.forEach(d => { result[d] = { open: true, from: null, to: null }; });
  }
}

/**
 * parseHours(str) → hours_json object or null
 */
function parseHours(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (!s) return null;

  // 24/7 shortcut
  if (/^24\/7$/i.test(s)) {
    const result = {};
    DAYS_FULL.forEach(d => { result[d] = { open: true, from: '00:00', to: '24:00' }; });
    return result;
  }

  const result = {};
  // Split on semicolons or commas-between-day-groups
  // Use semicolon as primary separator; also handle ", Mo" as a new segment
  // Primary split on semicolons
  const semiSegs = s.split(/\s*;\s*/);
  const finalSegs = [];
  for (const seg of semiSegs) {
    // Within a semicolon-segment, split on ", DayDay" ONLY when followed by a
    // day abbrev that is then followed by another day/range/comma (not a time).
    // Pattern: comma + space? + 2alpha + (dash|comma|space+digit = time starts)
    // We split ONLY where the comma separates a complete day-group+time from the next.
    // Simplest safe rule: split on ", " before a 2-alpha that is NOT followed by digits.
    // i.e. ", Fr 11:30" stays together; ", Mo-Fr" splits.
    // Split ONLY on ", " (comma + space) before a 2-alpha day abbreviation.
    // This preserves "Fr,Sa" (no space = same group sharing a time) while splitting
    // "Mo 09:00-17:00, Tu-Th 09:00-21:00" into separate segments.
    const parts = seg.split(/,\s+(?=[A-Za-z]{2}(?:[-,\s]|$))/);
    // If a part has no time (day-only), merge it with the next time-bearing part
    const merged = [];
    let pending = '';
    for (const part of parts) {
      const hasTimes = /\d{1,2}:\d{2}/.test(part);
      if (!hasTimes) {
        pending = pending ? pending + ', ' + part.trim() : part.trim();
      } else if (pending) {
        merged.push(pending + ', ' + part.trim());
        pending = '';
      } else {
        merged.push(part.trim());
      }
    }
    if (pending) merged.push(pending);
    finalSegs.push(...merged);
  }
  for (const seg of finalSegs) {
    parseSegment(seg.trim(), result);
  }

  return Object.keys(result).length ? result : null;
}

/**
 * isOpenNow(hours_json) → boolean
 * Uses server local time (Eastern — Railway runs UTC, convert)
 */
function isOpenNow(hoursJson) {
  if (!hoursJson) return null; // unknown
  try {
    // Railway is UTC — convert to US/Eastern
    const now = new Date();
    const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
    const et = new Date(etStr);
    const dayName = DAYS_FULL[et.getDay() === 0 ? 6 : et.getDay() - 1]; // getDay(): 0=Sun
    // Fix: JS getDay 0=Sun,1=Mon...6=Sat → our index Mon=0..Sun=6
    const jsDay = et.getDay(); // 0=Sun
    const ourDay = jsDay === 0 ? 6 : jsDay - 1;
    const dayFull = DAYS_FULL[ourDay];

    const entry = hoursJson[dayFull];
    if (!entry) return null;
    if (!entry.open) return false;
    if (!entry.from || !entry.to) return true; // open but no hours specified

    const [fh, fm] = entry.from.split(':').map(Number);
    const [th, tm] = entry.to.split(':').map(Number);
    const nowMins = et.getHours() * 60 + et.getMinutes();
    const fromMins = fh * 60 + fm;
    const toMins = th * 60 + tm;

    // Handle midnight close (24:00 = 1440)
    return nowMins >= fromMins && nowMins < (toMins === 1440 ? 1440 : toMins);
  } catch (_) {
    return null;
  }
}

// ── Worker batch run ────────────────────────────────────────────────────────

const BATCH = 500;
let running = false;

async function runParseBatch() {
  if (running) return;
  running = true;
  let total = 0, errors = 0;

  try {
    // Count remaining
    const countRow = await db.query(
      `SELECT COUNT(*) AS n FROM businesses WHERE hours IS NOT NULL AND hours_json IS NULL AND status != 'inactive'`
    );
    const remaining = parseInt(countRow[0]?.n || 0);
    if (!remaining) {
      console.log('[hoursParseWorker] All hours already parsed.');
      running = false;
      return;
    }
    console.log(`[hoursParseWorker] Starting parse pass — ${remaining} rows to process`);

    let offset = 0;
    while (true) {
      const rows = await db.query(
        `SELECT business_id, hours FROM businesses
         WHERE hours IS NOT NULL AND hours_json IS NULL AND status != 'inactive'
         ORDER BY business_id
         LIMIT $1`,
        [BATCH]
      );
      if (!rows.length) break;

      // Build bulk update values
      const updates = [];
      for (const row of rows) {
        const parsed = parseHours(row.hours);
        if (parsed) {
          updates.push({ id: row.business_id, json: JSON.stringify(parsed) });
        } else {
          // Mark as attempted with sentinel so we don't retry forever
          updates.push({ id: row.business_id, json: JSON.stringify({ _unparseable: true }) });
          errors++;
        }
      }

      // Update in parallel chunks of 50
      const CHUNK = 50;
      for (let i = 0; i < updates.length; i += CHUNK) {
        const chunk = updates.slice(i, i + CHUNK);
        await Promise.all(chunk.map(u =>
          db.query(
            `UPDATE businesses SET hours_json = $1::jsonb, has_hours = true WHERE business_id = $2`,
            [u.json, u.id]
          )
        ));
      }

      total += rows.length;
      offset += rows.length;
      if (total % 5000 === 0) {
        console.log(`[hoursParseWorker] Parsed ${total} so far...`);
      }

      // Small yield to avoid overwhelming Postgres
      await new Promise(r => setTimeout(r, 50));
    }

    console.log(`[hoursParseWorker] Done — parsed ${total} rows, ${errors} unparseable`);
  } catch (e) {
    console.error('[hoursParseWorker] Error:', e.message);
  } finally {
    running = false;
  }
}

module.exports = { runParseBatch, parseHours, isOpenNow };

// ── Forkable entry point ────────────────────────────────────────────────────
// When run as a forked worker process, do one batch pass then schedule daily.
if (require.main === module) {
  const DAILY = 24 * 60 * 60 * 1000;
  (async () => {
    console.log('[hoursParseWorker] Starting initial batch pass...');
    await runParseBatch();
    // Schedule daily re-runs to catch newly enriched rows
    setInterval(runParseBatch, DAILY);
  })();
}
