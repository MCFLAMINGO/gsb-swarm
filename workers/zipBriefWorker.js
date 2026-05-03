'use strict';
/**
 * zipBriefWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds deterministic market intelligence briefs for every enriched ZIP.
 * Zero API calls. Zero cost. Pure math from the data we already have.
 *
 * Output: zip_briefs table in Postgres.
 *
 * Postgres-first contract:
 *   1. START → query Postgres for ZIPs with fresh briefs (skip those)
 *   2. WORK → only build briefs for ZIPs without a fresh row
 *   3. END   → upsert brief into zip_briefs
 *   4. REDEPLOY SAFE — step 1 naturally skips everything still fresh
 *   5. FULL_REFRESH=true ignores skip logic
 *
 * Cycle: runs once at startup, then every 4 hours.
 */

const db = require('../lib/db');
const { validateAll } = require('./briefValidator');

const CYCLE_MS   = 4 * 60 * 60 * 1000; // 4 hours
const STAGGER_MS = 3 * 60 * 1000;       // 3 min after startup
const FRESH_INTERVAL = '7 days';
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';

// ── Category → group mapping ────────────────────────────────────────────────
const CAT_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','alcohol'],
  retail:   ['supermarket','convenience','clothes','hairdresser','beauty','chemist',
             'mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre',
             'sports_centre','swimming_pool','pharmacy','optician','physiotherapist'],
  finance:  ['bank','atm','estate_agent','insurance','accountant'],
  civic:    ['school','place_of_worship','church','library','post_office',
             'police','fire_station','community_centre','social_centre'],
  services: ['fuel','car_wash','car_repair','hotel','office','coworking',
             'contractor','plumber','electrician','hvac'],
  legal:    ['legal','attorney','notary'],
};

function getGroup(cat) {
  if (!cat) return 'other';
  const c = cat.toLowerCase();
  for (const [g, cats] of Object.entries(CAT_GROUPS)) {
    if (cats.includes(c)) return g;
  }
  if (/restaurant|dining|cafe|food|eatery|diner|pizza|sushi|bbq|seafood/i.test(c)) return 'food';
  if (/clinic|dental|doctor|physician|health|therapy|pharmacy|medical/i.test(c)) return 'health';
  if (/retail|store|shop|boutique|apparel|fashion|grocery/i.test(c)) return 'retail';
  if (/bank|finance|insurance|accountant|invest/i.test(c)) return 'finance';
  if (/legal|attorney|lawyer|law/i.test(c)) return 'legal';
  if (/contractor|builder|plumb|electr|hvac|roofi|construct/i.test(c)) return 'services';
  if (/school|church|worship|civic|librar/i.test(c)) return 'civic';
  return 'other';
}

const ZIP_LABELS = {
  '32082': 'Ponte Vedra Beach', '32081': 'Nocatee', '32084': 'St. Augustine',
  '32086': 'St. Augustine South', '32092': 'World Golf Village', '32080': 'St. Augustine Beach',
  '32095': 'Palm Valley', '32259': 'Fruit Cove / Saint Johns', '32250': 'Jacksonville Beach',
  '32266': 'Neptune Beach', '32233': 'Atlantic Beach', '32034': 'Fernandina Beach',
  '32097': 'Yulee', '32073': 'Orange Park', '32003': 'Fleming Island',
  '32256': 'Baymeadows', '32257': 'Mandarin', '32216': 'Southside Jacksonville',
  '32217': 'San Jose', '32207': 'Jacksonville Southbank', '32225': 'Arlington',
  '32246': 'Regency', '32258': 'Bartram Park', '32224': 'Southside',
};

const SATURATION = {
  food:     { saturated: 40, healthy: 20, sparse: 8 },
  health:   { saturated: 30, healthy: 15, sparse: 5 },
  retail:   { saturated: 50, healthy: 25, sparse: 10 },
  finance:  { saturated: 20, healthy: 10, sparse: 3 },
  services: { saturated: 40, healthy: 20, sparse: 8 },
  legal:    { saturated: 25, healthy: 12, sparse: 4 },
};

const POP_ESTIMATES = {
  '32082': 22000, '32081': 35000, '32084': 28000, '32086': 32000,
  '32092': 30000, '32080': 8000,  '32095': 12000, '32259': 45000,
  '32250': 22000, '32266': 8000,  '32233': 13000, '32034': 16000,
  '32097': 18000, '32073': 32000, '32003': 28000, '32256': 38000,
  '32257': 42000, '32216': 35000, '32217': 28000, '32207': 18000,
  '32225': 45000, '32246': 52000, '32258': 38000, '32224': 35000,
};

// ── Brief builder ─────────────────────────────────────────────────────────────
function buildBrief(zip, businesses) {
  const label   = ZIP_LABELS[zip] || `ZIP ${zip}`;
  const pop     = POP_ESTIMATES[zip] || 25000;
  const total   = businesses.length;

  if (total === 0) {
    return {
      zip, label, total: 0,
      narrative: `No business data available for ${label} (${zip}) yet.`,
      generated_at: new Date().toISOString(),
      data_grade: 'F',
    };
  }

  const byCat   = {};
  const byGroup = {};
  const anchors = [];

  for (const b of businesses) {
    const cat = (b.category || 'other').toLowerCase();
    const grp = getGroup(cat);
    byCat[cat]   = (byCat[cat]   || 0) + 1;
    byGroup[grp] = (byGroup[grp] || 0) + 1;
    const conf = (b.confidence || b.confidence_score || 0);
    if (conf >= 0.9 || conf >= 90 || b.claimed) anchors.push(b);
  }

  const topCats = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cat, count]) => ({ cat, count }));

  const confValues = businesses.map(b => {
    const c = b.confidence ?? b.confidence_score ?? 0;
    return c <= 1 ? Math.round(c * 100) : Math.round(c);
  });
  const avgConf     = Math.round(confValues.reduce((s, c) => s + c, 0) / total);
  const withPhone   = businesses.filter(b => b.phone).length;
  const withHours   = businesses.filter(b => b.hours).length;
  const withCoords  = businesses.filter(b => b.lat && b.lon).length;
  const claimed     = businesses.filter(b => b.claimed).length;
  const maybeClosed = businesses.filter(b => b.possibly_closed).length;

  const coveragePct = Math.round((withPhone / total) * 100);
  const dataGrade   = avgConf >= 80 && coveragePct >= 80 ? 'A'
                    : avgConf >= 70 && coveragePct >= 60 ? 'B'
                    : avgConf >= 60 ? 'C' : 'D';

  const per10k = (count) => Math.round((count / pop) * 10000);
  const signals = [];
  const gaps    = [];

  for (const [grp, sat] of Object.entries(SATURATION)) {
    const count = byGroup[grp] || 0;
    const density = per10k(count);
    if (density >= sat.saturated) {
      signals.push({ type: 'saturated', group: grp, count, density, per10k: density });
    } else if (density <= sat.sparse && count > 0) {
      gaps.push({ type: 'gap', group: grp, count, density, signal: `Only ${count} ${grp} businesses for ${pop.toLocaleString()} residents — potential opportunity` });
    } else if (count === 0) {
      gaps.push({ type: 'absent', group: grp, count: 0, density: 0, signal: `No ${grp} businesses mapped yet — may be missing data or genuine gap` });
    }
  }

  const notables = anchors
    .sort((a, b) => (b.confidence || b.confidence_score || 0) - (a.confidence || a.confidence_score || 0))
    .slice(0, 8)
    .map(b => ({
      name:        b.name,
      category:    b.category,
      address:     b.address,
      phone:       b.phone,
      website:     b.website || null,
      claimed:     !!b.claimed,
      description: b.description || null,
      tags:        Array.isArray(b.tags) ? b.tags : [],
    }));

  const spotlightLines = notables
    .filter(b => b.description || b.tags.length > 0)
    .slice(0, 3)
    .map(b => {
      const parts = [];
      if (b.description) parts.push(b.description);
      else if (b.tags.length) parts.push(`Known for: ${b.tags.slice(0,4).join(', ')}`);
      return `${b.name}: ${parts.join(' ')}`;
    });

  const gapList = gaps.filter(g => g.type === 'gap').map(g => g.group).join(', ') || 'none identified';
  const foodCount = byGroup.food || 0;
  const narrative = [
    `${label} (${zip}) has ${total.toLocaleString()} verified businesses.`,
    foodCount > 0 ? `${foodCount} food & dining options.` : '',
    spotlightLines.length > 0 ? spotlightLines.join(' ') : '',
    gaps.filter(g => g.type === 'gap').length > 0
      ? `Local gaps: ${gapList} — undersupplied relative to ${pop.toLocaleString()} residents.`
      : '',
  ].filter(Boolean).join(' ');

  return {
    zip,
    label,
    total,
    population_estimate: pop,
    by_group:   byGroup,
    by_category: topCats,
    avg_confidence:  avgConf,
    data_grade:      dataGrade,
    coverage: {
      with_phone:  withPhone,
      with_hours:  withHours,
      with_coords: withCoords,
      claimed,
      possibly_closed: maybeClosed,
      phone_pct:   coveragePct,
    },
    saturation_signals: signals,
    gaps,
    notable_businesses: notables,
    narrative,
    generated_at: new Date().toISOString(),
    source: 'zipBriefWorker_deterministic',
  };
}

// ── Postgres I/O ──────────────────────────────────────────────────────────────
async function getFreshZipSet() {
  if (FULL_REFRESH) return new Set();
  try {
    const rows = await db.query(
      `SELECT zip FROM zip_briefs WHERE generated_at > NOW() - INTERVAL '${FRESH_INTERVAL}'`
    );
    return new Set(rows.map(r => r.zip));
  } catch (e) {
    console.warn('[zip-brief] fresh-zip lookup failed:', e.message);
    return new Set();
  }
}

async function getDistinctZips() {
  const rows = await db.query(
    `SELECT DISTINCT zip FROM businesses WHERE status != 'inactive' AND zip IS NOT NULL ORDER BY zip`
  );
  return rows.map(r => r.zip);
}

async function getBusinessesForZip(zip) {
  return await db.query(
    `SELECT * FROM businesses WHERE zip = $1 AND status != 'inactive'`, [zip]
  );
}

async function saveBrief(zip, brief) {
  await db.query(
    `INSERT INTO zip_briefs (zip, brief_json, generated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (zip) DO UPDATE SET brief_json = EXCLUDED.brief_json, generated_at = NOW()`,
    [zip, JSON.stringify(brief)]
  );
}

// ── Run one pass ──────────────────────────────────────────────────────────────
async function runBriefPass() {
  const allZips = await getDistinctZips();
  const freshSet = await getFreshZipSet();
  console.log(
    `[zip-brief] ${allZips.length} ZIPs in businesses; ${freshSet.size} have fresh briefs ` +
    `(FULL_REFRESH=${FULL_REFRESH})`
  );

  let built = 0, skipped = 0, errors = 0;

  for (const zip of allZips) {
    if (freshSet.has(zip)) { skipped++; continue; }

    try {
      const businesses = await getBusinessesForZip(zip);
      if (!Array.isArray(businesses)) { errors++; continue; }

      const brief = buildBrief(zip, businesses);
      await saveBrief(zip, brief);
      built++;

      if (built % 20 === 0) {
        console.log(`[zip-brief] Built ${built}/${allZips.length} briefs`);
      }
    } catch (err) {
      console.warn(`[zip-brief] Error building brief for ${zip}:`, err.message);
      errors++;
    }

    if (built % 10 === 0) await new Promise(r => setImmediate(r));
  }

  console.log(`[zip-brief] Pass complete — built:${built} skipped:${skipped} errors:${errors}`);
  return { built, skipped, errors, total: allZips.length };
}

// ── Daemon ────────────────────────────────────────────────────────────────────
(async function main() {
  console.log('[zip-brief] ZIP brief worker started — Postgres-only deterministic builds');
  await new Promise(r => setTimeout(r, STAGGER_MS));

  while (true) {
    try {
      const passResult = await runBriefPass();

      if (passResult && passResult.built > 0) {
        console.log('[zip-brief] Running validation pass on all briefs');
        try {
          const report = await validateAll();
          if (report) {
            const failedZips = report.failed_zips || [];
            if (failedZips.length > 0) {
              console.warn(`[zip-brief] ${failedZips.length} briefs failed validation: ${failedZips.join(', ')}`);
              console.warn('[zip-brief] These ZIPs will be force-rebuilt next cycle');
              // Force rebuild by deleting failed brief rows
              for (const zip of failedZips) {
                try {
                  await db.query(`DELETE FROM zip_briefs WHERE zip = $1`, [zip]);
                } catch (_) {}
              }
            } else {
              console.log(`[zip-brief] All ${report.total_checked} briefs passed validation ✓`);
            }
          }
        } catch (e) {
          console.warn('[zip-brief] Validation skipped:', e.message);
        }
      }
    } catch (err) {
      console.error('[zip-brief] Pass error:', err.message);
    }
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
})();
