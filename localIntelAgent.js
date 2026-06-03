'use strict';
/**
 * Local Intel Agent — GSB Swarm
 *
 * ACP offering: local_intel_query
 * Serves hyperlocal business intelligence for any US zip code.
 *
 * Covers: all FL ZIPs (1,473) from fl_zip_geo. Blueprint for multi-state expansion via TARGET_STATE env var.
 *
 * Data sources:
 *   - OpenStreetMap (OSM) — named businesses, amenities, services
 *   - US Census ACS 2022 — population, income, housing, rent vs own
 *   - SJC Business Tax Receipts — active licensed businesses (pending)
 *   - FL Sunbiz — registered corporations (pending)
 *
 * Endpoints consumed by ACP jobs:
 *   POST /api/local-intel  { zip, query, category, limit }
 *   GET  /api/local-intel/zones  — spending zone summary
 *   GET  /api/local-intel/stats  — coverage stats
 */

/**
 * Normalized LocalIntel intent shape.
 *
 * Documentation only — no runtime validation, no class, no new file.
 * Every LocalIntel entry path should normalize into this shape before
 * routing or logging: search/ask/MCP, Twilio voice, RFQ SMS/email/callback,
 * and later Siri/Gemini adapter layers.
 *
 * @typedef {Object} LocalIntelIntent
 * @property {'search'|'ask'|'mcp'|'twilio_voice'|'rfq_sms'|'rfq_email'|'rfq_callback'} source
 * Source rail that produced the intent.
 *
 * @property {Object} actor
 * @property {'human'|'business'|'agent'|'provider'} actor.type
 * @property {string|null} actor.phone
 * @property {string|null} actor.email
 * @property {string|null} actor.agent_key
 * @property {string|null} actor.session_id
 * @property {string|null} actor.call_sid
 *
 * @property {string} raw_input
 * Original user text, transcript, SMS body, or inbound email text before routing.
 *
 * @property {Object} command
 * @property {'local_intel'|'voice_order'|'rfq'|'identity'} command.family
 * @property {'query'|'nearby'|'ask'|'oracle'|'place_order'|'service_request'|'rfq_yes'|'rfq_select'|'confirm_email'|'attach_wallet'} command.name
 * Operational command name. Keep adapter-friendly and route-specific.
 * @property {string|null} command.stage
 * Optional current stage for multi-turn flows, e.g. greeting, menu_presented,
 * order_building, order_confirmed.
 *
 * @property {Object} task
 * @property {string|null} task.category
 * @property {string|number|null} task.business_id
 * @property {string|null} task.business_name
 * @property {string|null} task.zip
 * @property {string|null} task.city
 * @property {number|null} task.lat
 * @property {number|null} task.lon
 * @property {number|null} task.radius_miles
 * @property {string|null} task.description
 * @property {Array<Object>} task.items
 * Parsed order items or structured requested items when applicable.
 *
 * @property {Object} task.constraints
 * @property {number|null} task.constraints.budget
 * @property {number|null} task.constraints.eta_minutes
 * @property {string|null} task.constraints.time_window
 *
 * @property {Object} routing
 * @property {'answer'|'business_search'|'pos_router'|'rfq_broadcast'|'identity_update'|'callback_flow'} routing.destination
 * @property {string|null} routing.pos_type
 * Read from businesses.pos_config->>'pos_type' when a business is selected.
 * @property {number|null} routing.confidence
 * Optional normalized confidence score if a handler computes one.
 * @property {string|null} routing.fallback_reason
 * Why the request fell back to RFQ, callback, clarification, or manual handling.
 *
 * @property {Object} delivery
 * @property {'voice'|'sms'|'email'|'json'} delivery.channel
 * @property {boolean} delivery.reply_expected
 * Whether the current channel expects a user reply or next-step interaction.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { paymentMiddleware } = require('x402-express');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { createPublicClient, createWalletClient, http, getAddress, publicActions } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const { exact } = require('x402/schemes');

// ── API key middleware (pathUSD + USDC, Postgres-backed) ─────────────────────
const { createApiKeyMiddleware } = require('./lib/apiKeyMiddleware');
const { harvestGuard } = require('./lib/harvestGuard');
const db = require('./lib/db');
const { resolveIntent, detectOpenIntent } = require('./lib/intentMap');
const { resolveIntent: resolveNlIntentFromRegistry } = require('./lib/intentRegistry');
const { expandZips } = require('./lib/geoExpand');
const { detectTaskIntent, getTaskFollowUp, setTaskFollowUp, clearTaskFollowUp } = require('./lib/taskIntent');
const { isOpenNow } = require('./workers/hoursParseWorker');
const { classifyIntent } = require('./workers/intentRouter');
const { dispatchTask } = require('./lib/taskDispatch');
const { resolveBusinessAlias } = require('./lib/aliasResolver');
const { injectShowcase } = require('./lib/showcaseBiz');
const { getDiscoveryManifest, handleMcpRequest, probeEndpoint } = require('./lib/businessMcp');
// B53: resolvePlace — FL place name → ZIP, fully from Postgres (migration 028)
// Priority: explicit ZIP → county_alias → county → city → default 32082
async function resolvePlace(question) {
  const q = String(question || '').toLowerCase();

  // 1. Explicit 5-digit ZIP in question
  const zipMatch = q.match(/\b(\d{5})\b/);
  if (zipMatch) return { zip: zipMatch[1], isCounty: false, countyKey: null, countyZips: null };

  // 2. County aliases (longer phrases checked first to avoid partial matches)
  const aliasRows = await db.query(
    `SELECT name_normalized, primary_zip, county_key FROM fl_place_index
     WHERE place_type = 'county_alias' ORDER BY length(name_normalized) DESC`
  ).catch(() => []);
  for (const row of aliasRows) {
    if (q.includes(row.name_normalized)) {
      const czRows = await db.query(
        `SELECT zip FROM fl_county_zips WHERE county_key = $1 ORDER BY sort_order`,
        [row.county_key]
      ).catch(() => []);
      const countyZips = czRows.map(r => r.zip);
      return {
        zip: row.primary_zip || null,
        isCounty: true,
        countyKey: row.county_key,
        countyZips: countyZips.length ? countyZips : null,
      };
    }
  }

  // 3. County names (longer names first)
  const countyRows = await db.query(
    `SELECT name_normalized, primary_zip, county_key FROM fl_place_index
     WHERE place_type = 'county' ORDER BY length(name_normalized) DESC`
  ).catch(() => []);
  for (const row of countyRows) {
    if (q.includes(row.name_normalized)) {
      const czRows = await db.query(
        `SELECT zip FROM fl_county_zips WHERE county_key = $1 ORDER BY sort_order`,
        [row.county_key]
      ).catch(() => []);
      const countyZips = czRows.map(r => r.zip);
      return {
        zip: row.primary_zip || null,
        isCounty: true,
        countyKey: row.county_key,
        countyZips: countyZips.length ? countyZips : null,
      };
    }
  }

  // 4. City / neighborhood names (longer names first)
  const cityRows = await db.query(
    `SELECT name_normalized, primary_zip FROM fl_place_index
     WHERE place_type = 'city' ORDER BY length(name_normalized) DESC`
  ).catch(() => []);
  for (const row of cityRows) {
    if (q.includes(row.name_normalized)) {
      return { zip: row.primary_zip || null, isCounty: false, countyKey: null, countyZips: null };
    }
  }

  // 5. Default
  return { zip: null, isCounty: false, countyKey: null, countyZips: null };
}
const { logDeadEnd } = require('./lib/deadEndLog');
const { logSmsQuery } = require('./lib/smsQueryLog');
const { appendTurn, getContext } = require('./lib/conversationThread');
// B62: unified site intelligence scoring engine
const { scoreZipForConcept } = require('./lib/scoringEngine');
const { CONCEPT_PROFILES } = require('./lib/conceptProfiles');
const { detectConcept } = require('./lib/detectConcept');
const { buildConceptOrderBy } = require('./lib/searchRank');

// B62: statewide normalization bounds (lazy-cached per-process for 5min).
let _statewideBoundsCache = null;
let _statewideBoundsAt = 0;
async function getStatewideBounds() {
  const now = Date.now();
  if (_statewideBoundsCache && (now - _statewideBoundsAt) < 5 * 60 * 1000) {
    return _statewideBoundsCache;
  }
  try {
    const rows = await db.query(`
      SELECT
        MIN(fdot_max_aadt) as aadt_min, MAX(fdot_max_aadt) as aadt_max,
        MIN(acs_median_hhi) as hhi_min, MAX(acs_median_hhi) as hhi_max,
        MIN(lodes_jobs_here) as lodes_min, MAX(lodes_jobs_here) as lodes_max,
        MIN(sig_growth_score) as growth_min, MAX(sig_growth_score) as growth_max,
        MIN(sig_opportunity_score) as opp_min, MAX(sig_opportunity_score) as opp_max,
        MIN(acs_population) as pop_min, MAX(acs_population) as pop_max,
        MIN(acs_owner_occ_pct) as own_min, MAX(acs_owner_occ_pct) as own_max,
        MIN(acs_median_age) as age_min, MAX(acs_median_age) as age_max,
        MAX(osm_golf_count) as golf_max, MAX(osm_arts_count) as arts_max,
        MAX(osm_worship_count) as worship_max, MAX(osm_fitness_count) as fitness_max,
        MIN(sig_wallet_rate)  as wallet_min,  MAX(sig_wallet_rate)  as wallet_max,
        MIN(sig_task_density) as taskden_min, MAX(sig_task_density) as taskden_max
      FROM zip_signals
      WHERE fdot_max_aadt IS NOT NULL
    `);
    const r = (Array.isArray(rows) && rows[0]) ? rows[0] : {};
    _statewideBoundsCache = {
      aadt:        { min: Number(r.aadt_min) || 0,    max: Number(r.aadt_max) || 100000 },
      hhi:         { min: Number(r.hhi_min) || 20000, max: Number(r.hhi_max) || 200000 },
      daytime_pop: { min: 0,                          max: (Number(r.lodes_max) || 0) + (Number(r.pop_max) || 0) || 200000 },
      food_gap:    { min: 0,                          max: 100 },
      growth:      { min: Number(r.growth_min) || 0,  max: Number(r.growth_max) || 100 },
      opportunity: { min: Number(r.opp_min) || 0,     max: Number(r.opp_max) || 100 },
      population:  { min: Number(r.pop_min) || 0,     max: Number(r.pop_max) || 500000 },
      owner_occ:   { min: Number(r.own_min) || 0,     max: Number(r.own_max) || 100 },
      age_index:   { min: Number(r.age_min) || 25,    max: Number(r.age_max) || 65 },
      psycho_index:{ min: 0,                          max: 100 },
      // B65 — business-layer signal bounds (businessSignalWorker)
      sig_wallet_rate:  { min: Number(r.wallet_min)  || 0, max: Number(r.wallet_max)  || 100 },
      sig_task_density: { min: Number(r.taskden_min) || 0, max: Number(r.taskden_max) || 100 },
      // Per-component maxes used by computePsychoIndex for sane normalization.
      golf_max:    Number(r.golf_max)    || 10,
      arts_max:    Number(r.arts_max)    || 20,
      worship_max: Number(r.worship_max) || 50,
      fitness_max: Number(r.fitness_max) || 30,
    };
    _statewideBoundsAt = now;
    return _statewideBoundsCache;
  } catch (e) {
    console.warn('[localIntelAgent] statewide bounds load failed:', e.message);
    return {
      aadt:        { min: 0, max: 100000 },
      hhi:         { min: 20000, max: 200000 },
      daytime_pop: { min: 0, max: 200000 },
      food_gap:    { min: 0, max: 100 },
      growth:      { min: 0, max: 100 },
      opportunity: { min: 0, max: 100 },
      population:  { min: 0, max: 500000 },
      owner_occ:   { min: 0, max: 100 },
      age_index:   { min: 25, max: 65 },
      psycho_index:{ min: 0, max: 100 },
      sig_wallet_rate:  { min: 0, max: 100 },
      sig_task_density: { min: 0, max: 100 },
      golf_max:    10,
      arts_max:    20,
      worship_max: 50,
      fitness_max: 30,
    };
  }
}

// B64: enrich MCP tool/call responses (oracle/signal/sector_gap) with site_intelligence.
// Parses content[0].text JSON, attaches scoring block, re-serializes. Never throws —
// any failure returns the original data untouched so routing/billing never breaks.
async function enrichMcpResponseWithScore(data, toolName, args) {
  try {
    if (!data || !data.result || !Array.isArray(data.result.content)) return data;
    const textNode = data.result.content.find(c => c && c.type === 'text' && typeof c.text === 'string');
    if (!textNode) return data;

    let payload;
    try { payload = JSON.parse(textNode.text); } catch (_) { return data; }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return data;

    const zip = (payload.zip || args?.zip || '').toString().replace(/\D/g, '').slice(0, 5);
    if (!zip) return data;

    // Concept text: prefer explicit query; for sector_gap fall back to gap category.
    const queryText =
      args?.query ||
      args?.question ||
      args?.q ||
      (toolName === 'local_intel_sector_gap'
        ? (args?.category || args?.sector || payload.category || payload.sector || '')
        : '');
    const concept = detectConcept(queryText || '') || 'GENERAL';
    const profile = CONCEPT_PROFILES[concept] || CONCEPT_PROFILES.GENERAL;

    const sigRows = await db.query(
      `SELECT * FROM zip_signals WHERE zip = $1 LIMIT 1`,
      [zip]
    );
    if (!Array.isArray(sigRows) || sigRows.length === 0) return data;

    const bounds = await getStatewideBounds();
    const scoreResult = scoreZipForConcept(sigRows[0], profile, bounds);

    payload.site_intelligence = {
      concept_detected:      concept,
      concept_name:          profile.name,
      total_score:           scoreResult.total_score,
      factor_breakdown:      scoreResult.factor_breakdown,
      hard_floor_triggered:  scoreResult.hard_floor_triggered,
      hard_floor_reason:     scoreResult.hard_floor_reason,
      psycho_index:          scoreResult.psycho_index,
    };

    textNode.text = JSON.stringify(payload, null, 2);
    return data;
  } catch (e) {
    console.warn('[localIntelAgent] enrichMcpResponseWithScore failed:', e.message);
    return data;
  }
}

const apiKeyMiddleware = createApiKeyMiddleware(db);

// B16 — fire-and-forget SMS query history. Only logs for Twilio channel
// (customerId starts with '+', E.164). NEVER blocks the response.
function maybeLogSms(req, { customerId, query, zip, intent, resolvedVia, responsePreview }) {
  if (!customerId || !String(customerId).startsWith('+')) return;
  logSmsQuery({
    messageSid: req?.body?.MessageSid || null,
    callerId: customerId,
    query: query || '',
    zip: zip || null,
    intent: intent || 'unmatched',
    resolvedVia: resolvedVia || 'unmatched',
    responsePreview: responsePreview || null,
  });
}

// Phase 2 — multi-ZIP fanout when caller doesn't pin a ZIP
// Seeded from fl_zip_geo on startup — all FL ZIPs statewide
// Falls back to a broad FL bootstrap set (not SJC-specific) if DB not ready at startup
let TARGET_ZIPS = ['32202','32207','32216','32244','32256','32073','33602','33629','33647','32714','32801','32804','33179','33025','33060','32901','33401','34202','32601','32304'];

(async () => {
  try {
    const { getAllZipsFromGeo } = require('./lib/pgStore');
    const zips = await getAllZipsFromGeo();
    if (zips && zips.length > 0) {
      TARGET_ZIPS = zips;
      console.log(`[localIntelAgent] TARGET_ZIPS loaded from fl_zip_geo: ${zips.length} FL ZIPs`);
    } else {
      console.warn('[localIntelAgent] fl_zip_geo empty or not ready — using NE FL bootstrap ZIPs');
    }
  } catch (e) {
    console.warn('[localIntelAgent] TARGET_ZIPS DB load failed, using bootstrap:', e.message);
  }

  // Warm the trade-signals cache on startup so the first dashboard load
  // never sees empty even if the DB pool is busy during the boot burst.
  // Retries every 5s for up to 60s to survive the boot burst window.
  (async () => {
    for (let attempt = 0; attempt < 12; attempt++) {
      try {
        await new Promise(r => setTimeout(r, attempt === 0 ? 2000 : 5000));
        const rows = await db.query(`
          SELECT DISTINCT ON (ticker)
                 id, ticker, company, direction, confidence, thesis,
                 signal_source, signal_value, data_vintage, options_note,
                 risk_note, status, scored_at, expires_at
          FROM trade_signals
          WHERE status = 'active'
            AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY ticker, scored_at DESC, confidence DESC
        `);
        if (rows.length > 0) {
          _signalsCache = { signals: rows, generated_at: new Date().toISOString() };
          console.log(`[localIntelAgent] trade-signals cache warmed: ${rows.length} signals`);
          break;
        }
        // Table empty — keep retrying; tradeSignalWorker may still be writing
      } catch (_) {
        // Pool busy during boot — retry
      }
    }
  })();
})();

// Step 3 — fire-and-forget write to resolution_history. Never blocks the
// response, never throws — failures log only. Call from any path that has
// resolved or failed to resolve a user query.
function recordResolution({ query, intent, zip, businessId, resolved, resolvedVia, resultCount, startTime }) {
  const ms = startTime ? Date.now() - startTime : null;
  db.query(
    `INSERT INTO resolution_history
       (query, intent_class, intent_group, cuisine, zip, business_id, resolved, resolved_via, result_count, response_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      query,
      intent?.taskClass ?? null,
      intent?.group     ?? null,
      intent?.cuisine   ?? null,
      zip               ?? null,
      businessId        ?? null,
      resolved,
      resolvedVia       ?? null,
      resultCount       ?? 0,
      ms
    ]
  ).catch(err => console.error('[resolution_history] write failed:', err.message));
}

// Step 4 — temporal post-filter. Returns true if the business should be
// included for the given temporalContext. CRITICAL: every uncertain or
// error path returns true (include) — never silently exclude on bad data.
function isOpenDuringWindow(business, temporalContext) {
  if (!temporalContext) return true;
  if (!business || !business.hours) return true;

  try {
    const now = new Date();
    const currentHour = now.getHours() + now.getMinutes() / 60;
    const dayShortNames = ['Su','Mo','Tu','We','Th','Fr','Sa'];
    const dayLongNames  = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const todayShort = dayShortNames[now.getDay()];
    const todayLong  = dayLongNames[now.getDay()];

    // Window definitions (24h, end may exceed 24 to indicate overnight)
    const windows = {
      open_now:   null,
      happy_hour: [15, 19],
      late_night: [22, 26],
      morning:    [6,  11],
      midday:     [11, 14],
      evening:    [17, 22],
    };

    let intervals = []; // [{ open, close }] for today, in 24h hours; close may be > 24

    let raw = business.hours;

    // JSON object format (defensive — not the actual prod format, but safe to handle)
    if (typeof raw === 'object' && raw !== null) {
      const todayObj = raw[todayLong] || raw[todayShort.toLowerCase()] || raw['*'];
      if (todayObj) {
        const parseHM = (s) => {
          if (s == null) return null;
          const [h, m] = String(s).split(':').map(Number);
          return isNaN(h) ? null : h + (isNaN(m) ? 0 : m / 60);
        };
        const o = parseHM(todayObj.open  ?? todayObj.opens  ?? todayObj[0]);
        const c = parseHM(todayObj.close ?? todayObj.closes ?? todayObj[1]);
        if (o !== null && c !== null) {
          intervals.push({ open: o, close: c < o ? c + 24 : c });
        }
      }
    } else if (typeof raw === 'string') {
      // OSM-style: "Mo-Sa 11:00-20:00; Su 11:00-18:00"
      // Try JSON first (in case some rows are stringified JSON)
      let asJson = null;
      const trimmed = raw.trim();
      if (trimmed.startsWith('{')) {
        try { asJson = JSON.parse(trimmed); } catch (_) {}
      }
      if (asJson) {
        return isOpenDuringWindow({ hours: asJson }, temporalContext);
      }

      // OSM parser
      const parseHM = (s) => {
        const [h, m] = String(s).split(':').map(Number);
        if (isNaN(h)) return null;
        return h + (isNaN(m) ? 0 : m / 60);
      };
      const dayIdx = (abbr) => dayShortNames.indexOf(abbr);
      const todayIdx = dayIdx(todayShort);

      const segments = raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
      for (const seg of segments) {
        // Match "DayRange Time-Time" or "Day Time-Time"
        const m = seg.match(/^([A-Za-z]{2})(?:-([A-Za-z]{2}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
        if (!m) continue;
        const startDay = dayIdx(m[1]);
        const endDay   = m[2] ? dayIdx(m[2]) : startDay;
        if (startDay < 0 || endDay < 0) continue;

        // Day range may wrap (e.g. Fr-Mo) — check both ways
        let dayMatch = false;
        if (startDay <= endDay) {
          dayMatch = todayIdx >= startDay && todayIdx <= endDay;
        } else {
          dayMatch = todayIdx >= startDay || todayIdx <= endDay;
        }
        if (!dayMatch) continue;

        const openH  = parseHM(m[3]);
        let   closeH = parseHM(m[4]);
        if (openH === null || closeH === null) continue;
        // OSM "00:00" close means midnight (24:00). "02:00" close after open=11 means next-day 2am.
        if (closeH === 0) closeH = 24;
        if (closeH < openH) closeH += 24;
        intervals.push({ open: openH, close: closeH });
      }
    } else {
      return true; // unknown shape — include
    }

    if (intervals.length === 0) return true; // no parseable today hours — include

    if (temporalContext === 'open_now') {
      // current time inside any interval (account for overnight where close > 24)
      const t  = currentHour;
      const tNext = currentHour + 24;
      return intervals.some(iv =>
        (t >= iv.open && t < iv.close) || (tNext >= iv.open && tNext < iv.close)
      );
    }

    const win = windows[temporalContext];
    if (!win) return true; // unknown context — include
    const [winStart, winEnd] = win;
    // Business hours overlap with the window
    return intervals.some(iv => iv.open < winEnd && iv.close > winStart);

  } catch (err) {
    console.error('[temporal] filter error:', err.message);
    return true;
  }
}

// Step 5 — fire-and-forget upsert into customer_sessions. Keyed on phone
// (E.164 from Twilio) for SMS callers, skipped entirely for anonymous web.
// Never awaited, never throws — failures log only.
function upsertCustomerSession({ customerId, idType, query, businessId, group }) {
  if (!customerId) return;
  db.query(
    `INSERT INTO customer_sessions
       (customer_id, id_type, last_query, last_business_id, preferred_group, query_count, last_seen)
     VALUES ($1, $2, $3, $4, $5, 1, NOW())
     ON CONFLICT (customer_id) DO UPDATE SET
       last_query       = EXCLUDED.last_query,
       last_business_id = COALESCE(EXCLUDED.last_business_id, customer_sessions.last_business_id),
       preferred_group  = EXCLUDED.preferred_group,
       query_count      = customer_sessions.query_count + 1,
       last_seen        = NOW()`,
    [
      customerId,
      idType    ?? 'anonymous',
      query     ?? null,
      businessId ?? null,
      group      ?? null
    ]
  ).catch(err => console.error('[customer_session] upsert failed:', err.message));
}

// Step 5 — personalize result ordering for known customers. Boosts last
// engaged business to position 0, then pulls preferred_group matches forward.
// Fields on result rows: business_id (UUID), category_group (text). Never
// throws — falls back to original order on any error.
function personalizeResults(results, customerSession) {
  if (!customerSession || !Array.isArray(results) || results.length <= 1) return results;
  try {
    let out = results.slice();

    if (customerSession.last_business_id) {
      const idx = out.findIndex(r => r && r.business_id === customerSession.last_business_id);
      if (idx > 0) {
        const [boosted] = out.splice(idx, 1);
        boosted._boosted = true;
        out.unshift(boosted);
      }
    }

    if (customerSession.preferred_group) {
      const pg = customerSession.preferred_group;
      const head = out.length && out[0]._boosted ? [out.shift()] : [];
      const groupMatches = out.filter(r => r && (r.category_group === pg || r.group === pg));
      const rest        = out.filter(r => r && r.category_group !== pg && r.group !== pg);
      out = [...head, ...groupMatches, ...rest];
    }

    return out;
  } catch (err) {
    console.error('[personalize] failed:', err.message);
    return results;
  }
}

// Coerce hours from row → object so isOpenNow can read it. The DB can hand back
// either a JSON string (jsonb-as-text) or a parsed object depending on the column.
function _parseHours(h) {
  if (!h) return null;
  if (typeof h === 'object') return h;
  try { return JSON.parse(h); } catch (_) { return null; }
}

// Phase 2 — category-filter search. Returns flat array (db.query returns array).
async function searchByCategory(intent, zip, limit = 50, concept = 'GENERAL') {
  const cats = intent.categories;
  const cuisine = intent.cuisine || null;
  const zips = (!zip || zip === 'all') ? TARGET_ZIPS : [zip];

  // Build WHERE clause dynamically so cuisine filter can be added when present.
  const conditions = [
    `b.status != 'inactive'`,
    `b.zip = ANY($1::text[])`,
    `(b.category = ANY($2::text[]) OR b.tags && $2::text[])`,
  ];
  const params = [zips, cats];
  let p = 3;

  if (cuisine) {
    conditions.push(`(b.cuisine ILIKE $${p} OR b.description ILIKE $${p} OR b.category ILIKE $${p})`);
    params.push(`%${cuisine}%`);
    p++;
  }
  params.push(limit);

  const sql = `
    SELECT
      b.business_id, b.name, b.address, b.city, b.zip, b.phone, b.website,
      b.hours, b.category, b.category_group, b.tags, b.description, b.cuisine,
      b.confidence_score AS confidence, b.confidence_score, b.lat, b.lon, b.sunbiz_doc_number,
      b.claimed_at IS NOT NULL AS claimed,
      b.wallet,
      b.pos_config->>'pos_type' AS pos_type,
      CASE WHEN b.wallet IS NOT NULL THEN 1 ELSE 0 END AS has_wallet,
      b.is_showcase
    FROM businesses b
    LEFT JOIN zip_signals zs ON zs.zip = b.zip
    WHERE ${conditions.join(' AND ')}
    ORDER BY ${buildConceptOrderBy(concept, 'zs', 'b')}
    LIMIT $${p}
  `;
  const rows = await db.query(sql, params);
  if (intent.needsOpenNow) {
    const filtered = rows.filter(r => {
      const parsed = _parseHours(r.hours);
      const open   = isOpenNow(parsed);
      // Treat unknown (null) as "maybe open" so we don't hide everything
      return open === null || open === true;
    });
    // Safety valve: if open-now filter drops ALL results (e.g. 1 AM — gas stations
    // with no hours data all got filtered), fall back to the full unfiltered set
    // tagged with needsOpenNow=false so the caller still surfaces real businesses
    // rather than falling through to a wrong-category tsvector fallback.
    if (filtered.length === 0 && rows.length > 0) {
      console.log(`[searchByCategory] needsOpenNow dropped all ${rows.length} rows — returning unfiltered (hours unknown)`);
      return rows;
    }
    return filtered;
  }
  return rows;
}

// Phase 2 — tsvector full-text search.
async function searchByText(query, zip, limit = 50, concept = 'GENERAL') {
  const tokens = String(query || '').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const tsq = tokens.join(' & ');
  const zips = (!zip || zip === 'all') ? TARGET_ZIPS : [zip];
  const sql = `
    SELECT
      b.business_id, b.name, b.address, b.city, b.zip, b.phone, b.website,
      b.hours, b.category, b.category_group, b.tags, b.description, b.cuisine,
      b.confidence_score AS confidence, b.confidence_score, b.lat, b.lon, b.sunbiz_doc_number,
      b.claimed_at IS NOT NULL AS claimed,
      b.wallet,
      b.pos_config->>'pos_type' AS pos_type,
      ts_rank(b.search_vector, to_tsquery('english', $2)) AS rank,
      CASE WHEN b.wallet IS NOT NULL THEN 1 ELSE 0 END AS has_wallet,
      b.is_showcase
    FROM businesses b
    LEFT JOIN zip_signals zs ON zs.zip = b.zip
    WHERE b.status != 'inactive'
      AND b.zip = ANY($1::text[])
      AND b.search_vector @@ to_tsquery('english', $2)
    ORDER BY ts_rank(b.search_vector, to_tsquery('english', $2)) DESC, ${buildConceptOrderBy(concept, 'zs', 'b')}
    LIMIT $3
  `;
  return db.query(sql, [zips, tsq, limit]);
}

// Phase 4 — human-readable reason a business matched the query.
const _CATEGORY_LABELS = {
  bar: 'Bar & cocktails', liquor_store: 'Liquor store',
  restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Fast food',
  grocery: 'Grocery', convenience: 'Convenience store',
  pharmacy: 'Pharmacy', hardware: 'Hardware store',
  gas_station: 'Gas station', car_repair: 'Auto repair',
  pet: 'Pet supplies', veterinary: 'Veterinary',
  beauty: 'Beauty & salon', hairdresser: 'Hair salon',
  fitness: 'Gym & fitness', wellness: 'Spa & wellness',
  laundry: 'Laundry & dry cleaning', florist: 'Florist',
  bank: 'Bank & ATM', hotel: 'Hotel',
  bakery: 'Bakery', deli: 'Deli',
};

function buildMatchReason(biz, intent, query) {
  const parts = [];
  const hours = _parseHours(biz.hours);
  if (hours && isOpenNow(hours) === true) parts.push('Open now');
  if (biz.category && biz.category !== 'LocalBusiness') {
    parts.push(_CATEGORY_LABELS[biz.category] || biz.category);
  }
  if (biz.cuisine) {
    parts.push(biz.cuisine.charAt(0).toUpperCase() + biz.cuisine.slice(1));
  }
  if (biz.wallet) parts.push('✓ Accepts crypto');
  const conf = biz.confidence_score != null ? biz.confidence_score : biz.confidence;
  if (conf != null && conf >= 0.8) parts.push('Verified');
  return parts.slice(0, 3).join(' · ') || null;
}

// Phase 4 — sort results: open first, then claimed (wallet), then confidence.
function sortResults(rows) {
  rows.sort((a, b) => {
    const aHours = _parseHours(a.hours);
    const bHours = _parseHours(b.hours);
    const aOpen = aHours && isOpenNow(aHours) === true ? 1 : 0;
    const bOpen = bHours && isOpenNow(bHours) === true ? 1 : 0;
    if (bOpen !== aOpen) return bOpen - aOpen;
    const aWallet = a.wallet ? 1 : 0;
    const bWallet = b.wallet ? 1 : 0;
    if (bWallet !== aWallet) return bWallet - aWallet;
    const aConf = a.confidence_score != null ? a.confidence_score : (a.confidence || 0);
    const bConf = b.confidence_score != null ? b.confidence_score : (b.confidence || 0);
    return bConf - aConf;
  });
  return rows;
}

// ── x402 payment config ───────────────────────────────────────────────
// TREASURY receives USDC on Base mainnet.
// Agents without a Base wallet still use the Tempo/pathUSD endpoint (/api/local-intel/mcp).
// This x402 gate is ADDITIVE — a second payment rail, not a replacement.
// Base mainnet USDC treasury — separate from Tempo treasury
const X402_TREASURY = process.env.BASE_TREASURY || '0x1447612B0Dc9221434bA78F63026E356de7F30FA';

// ── Self-hosted facilitator (avoids x402.org/facilitator which is testnet-only) ──
// Uses exact.evm.verify (local EIP-3009 sig check) + exact.evm.settle (on-chain USDC transfer).
// TREASURY_PK is used to submit the transferWithAuthorization settlement tx.
// Client is extended with publicActions so exact.evm.settle can call verifyTypedData internally.
const _treasuryRaw = process.env.THROW_TREASURY_PK || '';
const TREASURY_PK  = _treasuryRaw.startsWith('0x') ? _treasuryRaw : (_treasuryRaw ? '0x' + _treasuryRaw : null);

const basePublicClient = createPublicClient({ chain: base, transport: http() });
// Extended wallet = walletClient + publicActions (needed for exact.evm.settle which calls verifyTypedData)
const baseTreasuryWallet = TREASURY_PK
  ? createWalletClient({ account: privateKeyToAccount(TREASURY_PK), chain: base, transport: http() }).extend(publicActions)
  : null;

// Self-facilitator: verify + settle EIP-3009 payments directly on Base
const selfFacilitator = {
  // x402-express calls {url}/verify and {url}/settle — we mount these as routes below
  // and pass the URL to paymentMiddleware
  url: 'http://localhost:3001/api/local-intel/x402-facilitator',
};

// NOTE: Route keys must be router-relative paths (req.path inside mounted router),
// not the full /api/local-intel/* paths. The middleware uses req.path for matching.
const x402Middleware = paymentMiddleware(
  X402_TREASURY,
  {
    'POST /mcp/x402': {
      price: '$0.01',
      network: 'base',
      config: {
        description: 'LocalIntel MCP — standard local business intelligence query. Returns businesses, demographics, sector gaps, and market data for any Florida ZIP code.',
        discoverable: true,
        inputSchema: {
          type: 'object',
          properties: {
            method:  { type: 'string', enum: ['tools/call'] },
            tool:    { type: 'string', description: 'MCP tool name, e.g. local_intel_query, local_intel_ask, local_intel_zone' },
            zip:     { type: 'string', description: 'Target ZIP code (Florida)' },
            query:   { type: 'string', description: 'Natural language query, e.g. "best restaurants near 32082"' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            businesses: { type: 'array',  description: 'Matched business records with name, address, phone, category, confidence' },
            zip:        { type: 'string',  description: 'ZIP code queried' },
            total:      { type: 'number',  description: 'Total businesses in dataset for this ZIP' },
            vertical:   { type: 'string',  description: 'Detected vertical: food, health, retail, auto, legal, financial, etc.' },
          },
        },
        ...declareDiscoveryExtension({
          output: {
            example: { businesses: [{ name: 'Example Cafe', address: '123 Main St, Ponte Vedra Beach, FL', category: 'restaurant', confidence: 85 }], zip: '32082', total: 557, vertical: 'food' },
            schema: {
              type: 'object',
              properties: {
                businesses: { type: 'array' },
                zip:        { type: 'string' },
                total:      { type: 'number' },
                vertical:   { type: 'string' },
              },
            },
          },
        }),
      },
    },
    'POST /mcp/x402/premium': {
      price: '$0.05',
      network: 'base',
      config: {
        description: 'LocalIntel MCP — deep composite analysis. Returns full market brief, spending zones, sector gap analysis, and demographic overlay for a Florida ZIP code.',
        discoverable: true,
        inputSchema: {
          type: 'object',
          properties: {
            zip:   { type: 'string', description: 'Target ZIP code (Florida)' },
            query: { type: 'string', description: 'Deep analysis query' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            brief:         { type: 'object', description: 'Full ZIP market brief with narrative, group breakdown, gaps, and saturation signals' },
            spending_zones: { type: 'array',  description: 'Consumer spending zone scores by sector' },
            demographics:  { type: 'object', description: 'Census ACS demographics: population, income, housing, ownership rate' },
            sector_gaps:   { type: 'array',  description: 'Underserved business categories with opportunity scores' },
          },
        },
        ...declareDiscoveryExtension({
          output: {
            example: { brief: { zip: '32082', label: 'Ponte Vedra Beach', total: 557, narrative: 'Upscale coastal market...' }, spending_zones: [], demographics: { population: 28000, median_hhi: 142000 }, sector_gaps: [{ category: 'urgent_care', score: 0.87 }] },
            schema: {
              type: 'object',
              properties: {
                brief:          { type: 'object' },
                spending_zones: { type: 'array' },
                demographics:   { type: 'object' },
                sector_gaps:    { type: 'array' },
              },
            },
          },
        }),
      },
    },
  },
  selfFacilitator
);

const router = express.Router();

// ── CORS — open for all origins (frontend + agents call from vercel/thelocalintel.com) ──
router.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-agent-id, x-session-id, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Usage ledger middleware ──────────────────────────────────────────────────────
// Logs every query to Postgres usage_ledger. This is the billing layer.
// caller_id = x-agent-id header | x-api-key first 8 chars | ip
// credits_charged: oracle=1, brief=1, nl-query=5
async function logUsage(callerId, queryType, zip, credits) {
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  try {
    const db = require('./lib/db');
    await db.query(
      `INSERT INTO usage_ledger (caller_id, query_type, zip, credits_charged)
       VALUES ($1, $2, $3, $4)`,
      [callerId, queryType, zip || null, credits]
    );
  } catch (e) { /* non-fatal — never block a query over billing */ }
}
function getCallerId(req) {
  return req.headers['x-agent-id']
    || (req.headers['x-api-key'] ? req.headers['x-api-key'].slice(0,8) : null)
    || req.ip
    || 'anon';
}

// ── Narrative builder ────────────────────────────────────────────────────────
// Pure, deterministic, no I/O — never throws. Reads results/nlIntent/meta and
// returns a single human sentence to render above search cards.
function buildNarrative(results, nlIntent, meta) {
  try {
    const count    = results?.length ?? 0;
    const group    = nlIntent?.group ?? 'local';
    const cuisine  = nlIntent?.cuisine;
    const category = nlIntent?.category;
    const temporal = nlIntent?.temporalContext;
    const taskClass = nlIntent?.taskClass ?? 'DISCOVER';
    const zip = meta?.zip ?? 'your area';

    if (taskClass === 'RFQ') {
      const cat = category ?? group;
      if ((meta?.businesses_notified ?? 0) > 0) {
        return `We notified ${meta.businesses_notified} ${cat}(s) in your area about your request. You'll hear back shortly.`;
      }
      return `We don't have ${cat}s in our network for this area yet — we're working on it.`;
    }

    if (count === 0) {
      if (meta?.gap) return `No results found yet — we've flagged this as a gap in our network and we're on it.`;
      return `No results found for that search in your area.`;
    }

    const timePhrase = temporal === 'open_now'   ? ', open right now'
      : temporal === 'happy_hour' ? ' with happy hour'
      : temporal === 'late_night' ? ', open late tonight'
      : temporal === 'morning'    ? ' open for breakfast'
      : temporal === 'midday'     ? ' open for lunch'
      : temporal === 'evening'    ? ' open for dinner'
      : '';

    const howPhrase = meta?.semantic_search ? ' (found by meaning, not just keywords)' : '';

    // Relevance gate — when the query has a cuisine, only describe results as
    // that cuisine when the top result actually matches. Otherwise we'd be
    // dressing up an unrelated claimed/wallet business (e.g. McFlamingo
    // surfacing first on an "italian" query) with a confidently-wrong blurb.
    if (cuisine) {
      const top = results[0] || {};
      const cuisineLc = String(cuisine).toLowerCase();
      const fields = [top.cuisine, top.category, top.description]
        .filter(Boolean)
        .map(s => String(s).toLowerCase());
      const topMatchesCuisine = fields.some(f => f.includes(cuisineLc));
      if (topMatchesCuisine) {
        return `Found ${count} ${cuisine} restaurant${count !== 1 ? 's' : ''}${timePhrase} near you${howPhrase}.`;
      }
      // Top result doesn't match the cuisine — fall through to a neutral
      // narrative rather than claiming N "<cuisine> restaurants".
    }
    if (category) {
      return `Found ${count} ${category}${count !== 1 ? 's' : ''}${timePhrase} near you${howPhrase}.`;
    }
    const groupLabel = group === 'food' ? 'restaurant'
      : group === 'bar' ? 'bar'
      : group === 'health' ? 'health provider'
      : 'business';
    return `Found ${count} ${groupLabel}${count !== 1 ? 's' : ''}${timePhrase} near you${howPhrase}.`;
  } catch (_) {
    return null;
  }
}

// ── Load dataset ──────────────────────────────────────────────────────────────
// In production this would be a DB — for now it's the JSON file written by the pull script
const DATA_PATH = path.join(__dirname, 'data', 'localIntel.json');
const ZONES_PATH = path.join(__dirname, 'data', 'spendingZones.json');
const LEDGER_PATH = path.join(__dirname, 'data', 'usageLedger.json');
const ZIPS_DIR_AGENT = path.join(__dirname, 'data', 'zips');

function loadData() {
  // Merge seed file + all accumulated zip files so tools see the full dataset
  const seen = new Set();
  const all  = [];
  const addBiz = (b) => {
    const key = `${(b.name||'').toLowerCase()}|${b.zip||''}|${b.lat||''}|${b.lon||''}`;
    if (!seen.has(key)) { seen.add(key); all.push(b); }
  };
  try { JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).forEach(addBiz); } catch {}
  try {
    if (fs.existsSync(ZIPS_DIR_AGENT)) {
      fs.readdirSync(ZIPS_DIR_AGENT).filter(f => f.endsWith('.json')).forEach(f => {
        try { JSON.parse(fs.readFileSync(path.join(ZIPS_DIR_AGENT, f), 'utf8')).forEach(addBiz); } catch {}
      });
    }
  } catch {}
  return all;
}

function loadZones() {
  try { return JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); }
  catch { return {}; }
}

// ── Category normalizer ───────────────────────────────────────────────────────
const CATEGORY_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','food_court','alcohol'],
  retail:   ['supermarket','convenience','clothes','shoes','electronics','hairdresser','beauty',
              'chemist','mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre','gym',
              'sports_centre','swimming_pool','yoga'],
  finance:  ['bank','atm','estate_agent','insurance','financial','accountant'],
  civic:    ['school','college','place_of_worship','church','library','post_office',
              'police','fire_station','government','social_centre','community_centre'],
  services: ['fuel','car_wash','car_repair','hotel','motel','office','coworking'],
};

function getGroup(cat) {
  for (const [group, cats] of Object.entries(CATEGORY_GROUPS)) {
    if (cats.includes(cat)) return group;
  }
  return 'other';
}

// ── RFQ — Twilio SMS dispatch for non-food service verticals (Step 8) ─────────
// Sends a bid request to up to 5 matching businesses in the caller's ZIP and
// logs everything to rfq_requests_v2 / rfq_responses_v2. YES/NO replies are
// handled by dashboard-server.js sms-inbound (matches by business phone +
// pending response row).
async function sendRfqSms(toE164, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    console.warn('[rfq] Twilio env not configured — skipping SMS to', toE164);
    return { sent: false, reason: 'twilio_not_configured' };
  }
  let twilio;
  try { twilio = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN); }
  catch (e) {
    console.warn('[rfq] twilio module missing:', e.message);
    return { sent: false, reason: 'twilio_module_missing' };
  }
  const msg = await twilio.messages.create({ body, from: TWILIO_FROM_NUMBER, to: toE164 });
  return { sent: true, sid: msg.sid };
}

// Normalize phone-ish strings to E.164 (US) for Twilio. Returns null if it
// looks unusable (we just skip those businesses — no silent failure).
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits.length >= 11 ? digits : null;
  const ten = digits.replace(/\D/g, '');
  if (ten.length === 10) return `+1${ten}`;
  if (ten.length === 11 && ten.startsWith('1')) return `+${ten}`;
  return null;
}

async function handleRFQ(req, res, nlIntent, userQuery, customerId, zip, serviceAddress) {
  const _start = Date.now();
  try {
    const targetZips = (!zip || zip === 'all') ? TARGET_ZIPS : [zip];

    // 1. Match businesses in ZIP whose category or description mentions the
    //    requested service. LIMIT 5 keeps SMS volume reasonable.
    const businesses = await db.query(
      `SELECT business_id AS id, name, phone, zip, category, wallet, description
         FROM businesses
        WHERE zip = ANY($1::text[])
          AND (category ILIKE $2 OR description ILIKE $2)
          AND phone IS NOT NULL
          AND status != 'inactive'
        LIMIT 5`,
      [targetZips, `%${nlIntent.category}%`]
    );

    // 2. Insert RFQ request row (status=open, businesses_notified=0 for now)
    // B9: when a service address was extracted ("landscaper at 205 Odoms Mill Blvd"),
    // embed it in the description so the bidder sees it in the dashboard view.
    const rfqDescription = serviceAddress
      ? `${userQuery} | service address: ${serviceAddress}`
      : userQuery;
    const rfqRows = await db.query(
      `INSERT INTO rfq_requests_v2
         (customer_id, query, intent_group, category, zip, description, businesses_notified)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        customerId ?? 'anonymous',
        userQuery,
        nlIntent.group,
        nlIntent.category,
        zip || (targetZips[0] || 'unknown'),
        rfqDescription,
        0
      ]
    );
    const rfqId = rfqRows[0]?.id;
    if (!rfqId) throw new Error('rfq insert returned no id');

    // 3. Twilio fan-out — never blocks on a single failure
    let notified = 0;
    for (const biz of businesses) {
      const e164 = toE164(biz.phone);
      try {
        await db.query(
          `INSERT INTO rfq_responses_v2
             (rfq_id, business_id, business_name, business_phone, response)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [rfqId, biz.id, biz.name, e164 || biz.phone]
        );

        if (!e164) {
          console.warn(`[rfq] skipping ${biz.name} — unparseable phone:`, biz.phone);
          continue;
        }

        const smsBody = serviceAddress
          ? `[LocalIntel] New job request: ${nlIntent.category} at ${serviceAddress}` +
            `${zip ? ` (${zip})` : ''}. Reply YES to connect with this customer or NO to pass. ` +
            `Ref: RFQ-${rfqId}`
          : `[LocalIntel] New job request in ${zip || 'your area'}: "${userQuery}". ` +
            `Reply YES to connect with this customer or NO to pass. Ref: RFQ-${rfqId}`;
        const sendResult = await sendRfqSms(e164, smsBody);
        if (sendResult.sent) notified++;
        else console.warn(`[rfq] SMS not sent to ${biz.name}: ${sendResult.reason}`);
      } catch (err) {
        console.error(`[rfq] failed to notify ${biz.name}:`, err.message);
      }
    }

    // 4. Update notified count
    await db.query(
      `UPDATE rfq_requests_v2 SET businesses_notified = $1 WHERE id = $2`,
      [notified, rfqId]
    ).catch(err => console.error('[rfq] update notified failed:', err.message));

    // 5. Customer-facing message + optional SMS reply
    const customerMsg = notified > 0
      ? `We found ${notified} ${nlIntent.category}(s) in your area and sent them your request. You'll hear back shortly. (RFQ-${rfqId})`
      : `We don't have ${nlIntent.category}s in our network for ZIP ${zip || 'that area'} yet — we're working on it.`;

    if (notified === 0) {
      logDeadEnd({
        query: userQuery,
        zip,
        channel: req.body?.channel || (customerId && String(customerId).startsWith('+') ? 'twilio' : 'web'),
        failReason: 'rfq_fail',
        intentPath: `rfq:${nlIntent?.category || nlIntent?.group || 'unknown'}`,
        callerId: customerId || null,
      });
    }

    if (customerId && String(customerId).startsWith('+')) {
      sendRfqSms(customerId, customerMsg).catch(err =>
        console.error('[rfq] customer SMS failed:', err.message)
      );
    }

    // 6. Resolution history (RFQ counts as resolved when ≥1 notified)
    db.query(
      `INSERT INTO resolution_history
         (query, intent_class, intent_group, cuisine, zip, business_id, resolved, resolved_via, result_count, response_ms)
       VALUES ($1, 'RFQ', $2, NULL, $3, NULL, $4, 'rfq', $5, $6)`,
      [userQuery, nlIntent.group, zip || null, notified > 0, notified, Date.now() - _start]
    ).catch(err => console.error('[rfq] resolution_history write failed:', err.message));

    const _rfqMeta = {
      intent_class: 'RFQ',
      intent_group: nlIntent.group,
      resolves_via: 'rfq',
      businesses_notified: notified,
    };
    _rfqMeta.narrative = buildNarrative([], nlIntent, { ..._rfqMeta, zip });

    maybeLogSms(req, {
      customerId,
      query: userQuery,
      zip,
      intent: nlIntent?.category || nlIntent?.group || 'rfq',
      resolvedVia: 'rfq',
      responsePreview: customerMsg,
    });

    // B41: Append turns (fire-and-forget)
    appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: userQuery,   zip, intent: nlIntent?.category || nlIntent?.group || 'rfq' }).catch(() => {});
    appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: customerMsg, zip, rfqId, resolvesVia: 'rfq' }).catch(() => {});

    return res.json({
      ok: true,
      rfq_id: rfqId,
      status: 'dispatched',
      businesses_notified: notified,
      category: nlIntent.category,
      zip: zip || null,
      message: customerMsg,
      meta: _rfqMeta
    });

  } catch (err) {
    console.error('[rfq] handleRFQ error:', err.message);
    logDeadEnd({
      query: userQuery,
      zip,
      channel: req.body?.channel || (customerId && String(customerId).startsWith('+') ? 'twilio' : 'web'),
      failReason: 'rfq_fail',
      intentPath: `rfq:${nlIntent?.category || nlIntent?.group || 'unknown'}`,
      callerId: customerId || null,
    });
    return res.status(500).json({ ok: false, error: 'RFQ dispatch failed', detail: err.message });
  }
}

// ── Reservation handler (resolvesVia === 'reservation') ──────────────────────
// Web: returns phone + website message + structured results.
// Twilio SMS: sends a reservation contact SMS to the caller.
// (Twilio voice <Dial> is handled in lib/voiceIntake.js — voice transcripts
//  don't route through this POST handler.)
async function handleReservation(req, res, query, customerId, zip) {
  try {
    // 1. Extract the business name from the query, if any.
    //    Examples: "reservation at st augustine fish camp", "book a table at medure",
    //    "do you take reservations at aqua grill"
    const bizNameMatch = query.match(
      /(?:reservations?\s+at|reserve\s+at|book\s+(?:a\s+table\s+)?at|table\s+at|get\s+a\s+table\s+at)\s+(.+?)(?:\s+(?:in|near|for|on)\s+\S|\s*$)/i
    );
    const bizNameRaw = bizNameMatch ? bizNameMatch[1].trim() : null;

    // Resolve alias (Tier 2 instant, Tier 1 DB) before business lookup.
    const _resvAlias = bizNameRaw ? await resolveBusinessAlias(bizNameRaw) : { canonical: null, business_id: null };
    const bizName = _resvAlias.canonical || bizNameRaw;
    const pinnedResvBusinessId = _resvAlias.business_id || null;

    // 2. ZIP expansion — pull in city ZIPs when a city name appears in the query.
    const searchZips = expandZips(query, zip);

    // 3. Look up matching businesses.
    let businesses = [];
    if (pinnedResvBusinessId) {
      businesses = await db.query(
        `SELECT business_id AS id, name, phone, zip, city, website, category, address
           FROM businesses
          WHERE business_id = $1
            AND status != 'inactive'
          LIMIT 1`,
        [pinnedResvBusinessId]
      ).catch(err => { console.error('[reservation] pinned biz lookup error:', err.message); return []; });
    }
    if (!businesses.length && bizName) {
      businesses = await db.query(
        `SELECT business_id AS id, name, phone, zip, city, website, category, address
           FROM businesses
          WHERE zip = ANY($1::text[])
            AND name ILIKE $2
            AND status != 'inactive'
          ORDER BY
            CASE WHEN zip = ANY($3::text[]) THEN 0 ELSE 1 END,
            length(name)
          LIMIT 3`,
        [searchZips, `%${bizName}%`, zip ? [zip] : ['32082','32081']]
      );

      // Fallback — word-by-word AND match for multi-word names.
      if (!businesses.length) {
        const words = bizName.split(/\s+/).filter(w => w.length > 2);
        if (words.length) {
          const likeClause = words.map((_, i) => `name ILIKE $${i + 2}`).join(' AND ');
          businesses = await db.query(
            `SELECT business_id AS id, name, phone, zip, city, website, category, address
               FROM businesses
              WHERE zip = ANY($1::text[])
                AND (${likeClause})
                AND status != 'inactive'
              LIMIT 3`,
            [searchZips, ...words.map(w => `%${w}%`)]
          );
        }
      }
    }
    if (!businesses.length && !bizNameRaw) {
      // No specific business — surface top restaurants in the area that have a phone.
      businesses = await db.query(
        `SELECT business_id AS id, name, phone, zip, city, website, category, address
           FROM businesses
          WHERE zip = ANY($1::text[])
            AND (category ILIKE ANY(ARRAY['%restaurant%','%dining%','%seafood%','%fine_dining%','%bistro%']))
            AND phone IS NOT NULL
            AND status != 'inactive'
          ORDER BY
            CASE WHEN wallet IS NOT NULL THEN 0 ELSE 1 END,
            name
          LIMIT 5`,
        [searchZips]
      );
    }

    if (!businesses.length) {
      const cityHint = bizNameRaw ? ` matching "${bizNameRaw}"` : '';
      logDeadEnd({
        query,
        zip,
        channel: req.body?.channel || (customerId && String(customerId).startsWith('+') ? 'twilio' : 'web'),
        failReason: 'reservation_fail',
        intentPath: `reservation:${bizNameRaw || 'no_name'}`,
        callerId: customerId || null,
      });
      const _resvNotFoundMsg = `I couldn't find a restaurant${cityHint} in that area. Try a different name or check the spelling.`;
      maybeLogSms(req, {
        customerId,
        query,
        zip,
        intent: 'reservation',
        resolvedVia: 'unmatched',
        responsePreview: _resvNotFoundMsg,
      });
      // B41: Append turns (fire-and-forget)
      appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,             zip, intent: 'reservation' }).catch(() => {});
      appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _resvNotFoundMsg,  zip, resolvesVia: 'reservation' }).catch(() => {});
      return res.json({
        ok: true,
        type: 'reservation_not_found',
        message: _resvNotFoundMsg,
        results: [],
        meta: { resolves_via: 'reservation' }
      });
    }

    const biz = businesses[0];
    const phone = biz.phone || null;
    const website = biz.website || null;

    // 4. Detect channel — Twilio identifiers come in as E.164 (+1...).
    const isTwilio = customerId && String(customerId).startsWith('+');

    // 5. Channel-appropriate message.
    let message;
    if (website && website.toLowerCase().includes('opentable')) {
      message = `Reserve a table at ${biz.name} online: ${website}`;
    } else if (isTwilio) {
      message = `${biz.name} reservations: call ${phone || 'them directly'}${website ? ` or visit ${website}` : ''}.`;
      const smsBody = `LocalIntel: ${biz.name} — reservations at ${phone || 'call them'}${website ? `, ${website}` : ''}`;
      sendRfqSms(customerId, smsBody).catch(err =>
        console.error('[reservation] customer SMS failed:', err.message)
      );
    } else {
      const parts = [`To make a reservation, call ${biz.name}`];
      if (phone)   parts.push(`at ${phone}`);
      if (website) parts.push(`or visit ${website}`);
      message = parts.join(' ') + '.';
    }

    // 6. Log to resolution_history (fire-and-forget — never block on logging).
    db.query(
      `INSERT INTO resolution_history
         (query, intent_class, intent_group, cuisine, zip, business_id, resolved, resolved_via, result_count, response_ms)
       VALUES ($1, 'RESERVATION', 'food', NULL, $2, $3, true, 'reservation', $4, 0)`,
      [query, zip || searchZips[0], biz.id, businesses.length]
    ).catch(err => console.error('[reservation] resolution_history write failed:', err.message));

    maybeLogSms(req, {
      customerId,
      query,
      zip,
      intent: 'reservation',
      resolvedVia: 'reservation',
      responsePreview: message,
    });

    // B41: Append turns (fire-and-forget)
    appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,   zip, intent: 'reservation' }).catch(() => {});
    appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: message, zip,
      businessId:   biz.id,
      businessName: biz.name,
      resolvesVia:  'reservation' }).catch(() => {});

    return res.json({
      ok: true,
      type: 'reservation',
      message,
      results: businesses.map(b => ({
        id:       b.id,
        name:     b.name,
        phone:    b.phone,
        address:  b.address,
        zip:      b.zip,
        city:     b.city,
        website:  b.website,
        category: b.category,
      })),
      meta: {
        resolves_via:  'reservation',
        business_name: biz.name,
        channel:       isTwilio ? 'twilio' : 'web',
        booking_url:   biz.website || null,
        zips_searched: searchZips,
      }
    });

  } catch (err) {
    console.error('[reservation] handleReservation error:', err.message);
    logDeadEnd({
      query,
      zip,
      channel: req.body?.channel || (customerId && String(customerId).startsWith('+') ? 'twilio' : 'web'),
      failReason: 'reservation_fail',
      intentPath: 'reservation:exception',
      callerId: customerId || null,
    });
    return res.status(500).json({ ok: false, error: 'Reservation lookup failed', detail: err.message });
  }
}

// ── POST /api/local-intel — main query endpoint ───────────────────────────────
// NL intent → group/tag mapping lives in lib/intentRegistry.js (single source of truth).

router.post('/', async (req, res) => {
  const _reqStart = Date.now();
  let { zip, query, category, group, limit = 50, minConfidence = 0 } = req.body || {};
  // B41: thread-resolvable business reference (filled by getContext below).
  let businessId = null;
  let businessName = null;

  // Step 5 — customer identity. Twilio sends phone in `From` (E.164). Web
  // callers send nothing → anonymous (no personalization, no upsert).
  const customerId = req.body?.From || req.body?.from || req.body?.phone || null;
  const customerIdType = customerId ? 'phone' : 'anonymous';

  // ── B66: CLAIM reply handler ────────────────────────────────────────────────
  // When a business owner replies "CLAIM" to the outreach SMS sent by
  // claimOutreachWorker, this catches it BEFORE all other intent routing so
  // the reply gets a claim link instead of being misrouted to search/RFQ/etc.
  try {
    const _from = req.body?.From || req.body?.from || null;
    const _smsBody = (req.body?.Body || req.body?.body || req.body?.query || '').toString();
    const _isClaimReply = /^\s*CLAIM\s*$/i.test(_smsBody.trim());
    if (_isClaimReply && _from) {
      const _digits = String(_from).replace(/\D/g, '');
      const bizRows = await db.query(
        `SELECT business_id, name, zip FROM businesses
          WHERE phone ILIKE $1 OR phone = $2
          LIMIT 1`,
        [`%${_digits}%`, _from]
      );

      if (bizRows.length > 0) {
        const biz = bizRows[0];
        await db.query(
          `UPDATE claim_outreach
              SET replied = true, reply_at = NOW(), reply_body = $1
            WHERE business_id = $2 AND replied = false`,
          [_smsBody, biz.business_id]
        );
        const replyMsg = `Thanks! Claim your LocalIntel profile here: https://thelocalintel.com/claim?biz=${biz.business_id}\nQuestions? Reply or call us.`;
        await sendRfqSms(_from, replyMsg).catch(err =>
          console.warn('[claim-reply] sendRfqSms failed:', err.message)
        );
        return res.json({ ok: true, intent: 'claim_reply', business_id: biz.business_id });
      }

      // No business matched by phone — still respond with a generic claim link.
      const replyMsg = `Thanks for your interest! Start your claim here: https://thelocalintel.com/claim\nQuestions? Text us anytime.`;
      await sendRfqSms(_from, replyMsg).catch(err =>
        console.warn('[claim-reply] sendRfqSms failed:', err.message)
      );
      return res.json({ ok: true, intent: 'claim_reply_no_match' });
    }
  } catch (e) {
    console.error('[claim-reply] handler error:', e.message);
    // Fall through to normal routing on failure.
  }

  // Step 5 — fetch customer session up-front so both Phase 2 and legacy paths
  // can personalize. Best-effort — any failure leaves customerSession null and
  // every personalization call no-ops.
  let customerSession = null;
  if (customerId) {
    try {
      const csRows = await db.query(
        'SELECT * FROM customer_sessions WHERE customer_id = $1 LIMIT 1',
        [customerId]
      );
      customerSession = csRows[0] ?? null;
    } catch (err) {
      console.error('[customer_session] fetch failed:', err.message);
    }
  }

  // B41: Load conversation thread context (rolling window keyed on customerId)
  const threadCtx = customerId
    ? await getContext(customerId, query || '').catch(() => null)
    : null;
  if (threadCtx) {
    // Fill missing ZIP from thread history
    if (!zip && threadCtx.zip) zip = threadCtx.zip;
    // Referential resolution: "that place", "same spot", "that one"
    if (threadCtx.isReferential && threadCtx.lastBusinessId && !businessId) {
      businessId   = threadCtx.lastBusinessId;
      businessName = threadCtx.lastBusinessName;
    }
    // ZIP proxy: "near here", "same area" — use last known zip
    if (threadCtx.isZipProxy && threadCtx.zip && !zip) {
      zip = threadCtx.zip;
    }
  }

  try {
    const db = require('./lib/db');

    // ── Plain-language TASK intent (pickup / dropoff / errand) ──────────────
    // Runs BEFORE intent resolution so "get me dry cleaning picked up" is not
    // misrouted to a category search. Same pipeline serves SMS, voice, and
    // the web search bar.
    const _taskSessionId = customerId
      || (req.headers && (req.headers['x-session-id'] || req.headers['x-forwarded-for']))
      || req.socket?.remoteAddress
      || req.ip
      || null;
    const _taskSession = _taskSessionId
      ? String(_taskSessionId).toString().split(',')[0].trim()
      : null;

    // ── B7: Detect "SLANG = BUSINESS NAME" submission format ────────────────
    // If user typed "X = Y" or "X equals Y" in the main search bar, return a
    // helpful hint redirecting them to the slang submission flow rather than
    // running an irrelevant search.
    if (query) {
      const { parseSlangSubmission } = require('./lib/slangParser');
      const slangParsed = parseSlangSubmission(query);
      if (slangParsed) {
        const _slangMsg = `Looks like a slang submission! Use: POST /api/local-intel/slang with { query: "${query}" } or tap the "Add Slang" button.`;
        maybeLogSms(req, {
          customerId,
          query,
          zip,
          intent: 'slang',
          resolvedVia: 'alias',
          responsePreview: _slangMsg,
        });
        // B41: Append turns (fire-and-forget)
        appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,     zip, intent: 'slang' }).catch(() => {});
        appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _slangMsg, zip, resolvesVia: 'slang_submission' }).catch(() => {});
        return res.json({
          ok: true,
          type: 'slang_submission_hint',
          message: _slangMsg,
          parsed: slangParsed,
          meta: { resolves_via: 'slang_submission' }
        });
      }
    }

    if (query && _taskSession) {
      // 1. If a follow-up is pending, this message answers it.
      const pending = await getTaskFollowUp(_taskSession);
      if (pending) {
        const venueAnswer = String(query).trim();
        await clearTaskFollowUp(_taskSession);
        const isNone = /^(none|cancel|skip|no(ne)?|n\/a|na)$/i.test(venueAnswer);
        const enrichedQuery = isNone
          ? `Task: ${pending.taskType || 'errand'} — ${pending.cat}`
          : `Task: ${pending.taskType || 'errand'} — ${pending.cat} (${pending.followUpKey || 'venue'}: ${venueAnswer})`;
        const nlIntentForTask = {
          taskClass: 'TASK',
          group:     pending.cat,
          category:  pending.cat,
          tags:      null,
          cuisine:   null,
          resolvesVia: 'rfq',
          temporalContext: null,
        };
        return await handleRFQ(req, res, nlIntentForTask, enrichedQuery, customerId, zip || pending.zip || null);
      }

      // B9: "service at address" detection — "i need landscaper at 205 Odoms Mill Blvd"
      // must route as RFQ with the address embedded, not get the address mis-parsed
      // as a business name. Fire BEFORE detectTaskIntent so the address path wins.
      const SERVICE_AT_ADDRESS_RE = /\b(landscap(?:er|ing|e)?|plumb(?:er|ing)?|electr(?:ician|ical)?|hvac|handyman|roofer|roofing|painter|painting|cleaner|cleaning\s+service|pest\s*control|pool\s*service|carpenter|contractor|exterminator)\b.{0,30}\bat\s+(\d+\s+\w[\w\s]{2,40}(?:blvd|boulevard|rd|road|st|street|ave|avenue|dr|drive|ln|lane|ct|court|cir|circle|way|pl|place|pkwy|parkway|hwy|highway)\b[\w\s]{0,30})/i;
      const _svcAtAddrMatch = query.match(SERVICE_AT_ADDRESS_RE);
      if (_svcAtAddrMatch) {
        const serviceAddress = _svcAtAddrMatch[2].trim().replace(/[?.!,]+$/, '');
        const _svcRaw = _svcAtAddrMatch[1].toLowerCase();
        // Normalize verb form → category token used downstream (matches rfq_requests
        // categories: landscaping, plumbing, electrical, etc.).
        const _svcMap = {
          landscaper: 'landscaping', landscape: 'landscaping', landscaping: 'landscaping',
          plumber: 'plumbing', plumbing: 'plumbing',
          electrician: 'electrical', electrical: 'electrical',
          hvac: 'hvac', handyman: 'handyman',
          roofer: 'roofing', roofing: 'roofing',
          painter: 'painting', painting: 'painting',
          cleaner: 'cleaning', 'cleaning service': 'cleaning',
          'pest control': 'pest_control', 'pool service': 'pool_service',
          carpenter: 'carpentry', contractor: 'general_contractor', exterminator: 'pest_control',
        };
        const category = _svcMap[_svcRaw] || _svcRaw.replace(/\s+/g, '_');
        const nlIntentForAddr = {
          taskClass: 'RFQ',
          group: 'home',
          category,
          tags: null,
          cuisine: null,
          resolvesVia: 'rfq',
          temporalContext: null,
        };
        const enrichedQuery = `${query} (service address: ${serviceAddress})`;
        return await handleRFQ(req, res, nlIntentForAddr, enrichedQuery, customerId, zip, serviceAddress);
      }

      // 2. Otherwise detect a fresh task intent.
      const taskIntent = detectTaskIntent(query);
      if (taskIntent && taskIntent.isTask) {
        // Store allTasks for multi-task sequential routing
        await setTaskFollowUp(_taskSession, {
          taskType:    taskIntent.taskType,
          cat:         taskIntent.cat,
          followUpKey: taskIntent.followUpKey,
          zip:         zip || null,
          allTasks:    taskIntent.allTasks || [],
        });
        // Build multi-task hint for UI if more than one task detected
        const multiHint = (taskIntent.allTasks && taskIntent.allTasks.length > 1)
          ? ` (I also see ${taskIntent.allTasks.slice(1).map(t => t.cat.replace(/_/g,' ')).join(' and ')} — we\'ll handle those next)`
          : '';
        const _followupMsg = taskIntent.followUp + multiHint;
        maybeLogSms(req, {
          customerId,
          query,
          zip,
          intent: taskIntent.cat || 'task',
          resolvedVia: 'task_followup',
          responsePreview: _followupMsg,
        });
        // B41: Append turns (fire-and-forget)
        appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,         zip, intent: taskIntent.cat || 'task' }).catch(() => {});
        appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _followupMsg,  zip, resolvesVia: 'task_followup' }).catch(() => {});
        return res.json({
          ok: true,
          type: 'followup',
          message: _followupMsg,
          results: [],
          meta: {
            task_type:     taskIntent.taskType,
            category:      taskIntent.cat,
            follow_up_key: taskIntent.followUpKey,
            resolves_via:  'task_followup',
            all_tasks:     taskIntent.allTasks || [],
          },
        });
      }
    }

    // Resolve NL intent up front so every path (Phase 2 + legacy) can read
    // shared fields like `temporalContext`. Cheap, deterministic, no I/O.
    const nlIntentEarly = (query && !group && !category)
      ? resolveNlIntentFromRegistry(query)
      : { taskClass: null, group: null, tags: null, cuisine: null, category: null, resolvesVia: 'search', temporalContext: null };

    // ── B19: SHORT_NAME_FOOD_RE — short prefix + food place type ──────────────
    // Queries like "V pizza", "V's kitchen", "JJ tacos" should attempt a name
    // search FIRST (against businesses table) before falling through to the
    // generic category search. Without this, "V pizza" never matches V Pizza
    // by name and gets bucketed as a pizza-category search returning every
    // pizza place in the ZIP. If 0 name hits, fall through to normal routing.
    const SHORT_NAME_FOOD_RE = /^([a-z]{1,4}['s]*)\s+(pizza|burger|grill|kitchen|cafe|bar|wings|sushi|tacos?|bbq|diner|bistro|tavern|pub|grille|house|shack|joint)\b/i;
    if (query && !group && !category && SHORT_NAME_FOOD_RE.test(String(query).trim())) {
      try {
        // Resolve Tier 2/Tier 1 alias first ("v pizza" → "V Pizza")
        const _b19Alias = await resolveBusinessAlias(query).catch(() => ({ canonical: null, business_id: null }));
        const _b19Name = _b19Alias?.canonical || String(query).trim();
        const _b19Pinned = _b19Alias?.business_id || null;
        const _b19Zips = zip ? [zip] : TARGET_ZIPS;
        let _b19Rows = [];
        if (_b19Pinned) {
          _b19Rows = await db.query(
            `SELECT business_id, name, address, city, zip, phone, website,
                    hours, category, category_group, tags, description, cuisine,
                    confidence_score AS confidence, confidence_score, lat, lon,
                    sunbiz_doc_number, claimed_at IS NOT NULL AS claimed, wallet,
                    pos_config->>'pos_type' AS pos_type, is_showcase
               FROM businesses
              WHERE business_id = $1 AND status != 'inactive'
              LIMIT 1`,
            [_b19Pinned]
          ).catch(err => { console.error('[B19] pinned name lookup error:', err.message); return []; });
        }
        if (!_b19Rows.length) {
          _b19Rows = await db.query(
            `SELECT business_id, name, address, city, zip, phone, website,
                    hours, category, category_group, tags, description, cuisine,
                    confidence_score AS confidence, confidence_score, lat, lon,
                    sunbiz_doc_number, claimed_at IS NOT NULL AS claimed, wallet,
                    pos_config->>'pos_type' AS pos_type, is_showcase
               FROM businesses
              WHERE status != 'inactive'
                AND zip = ANY($1::text[])
                AND name ILIKE $2
              ORDER BY
                CASE WHEN zip = ANY($3::text[]) THEN 0 ELSE 1 END,
                (claimed_at IS NOT NULL) DESC,
                confidence_score DESC
              LIMIT 10`,
            [_b19Zips, `%${_b19Name}%`, zip ? [zip] : ['32082','32081']]
          ).catch(err => { console.error('[B19] name search error:', err.message); return []; });
        }
        if (_b19Rows && _b19Rows.length > 0) {
          const _b19Sorted = sortResults(_b19Rows.slice());
          let _b19Enriched = _b19Sorted.map(r => {
            const out = { ...r };
            if (r.pos_type === 'other' && r.wallet) {
              out.ucp_order_url = 'https://surge.basalthq.com/api/ucp/checkout-sessions';
              out.ucp_wallet    = r.wallet;
              out.ucp_note      = 'POST ucp_order_url with shopSlug resolved via GET https://surge.basalthq.com/api/directory/shops?q=' + encodeURIComponent(r.name);
            }
            delete out.pos_type;
            delete out.has_wallet;
            delete out.confidence_score;
            return out;
          });
          if (customerSession) {
            _b19Enriched = personalizeResults(_b19Enriched, customerSession);
          }
          recordResolution({
            query,
            intent: { taskClass: 'NAME_SEARCH', group: nlIntentEarly.group, cuisine: nlIntentEarly.cuisine },
            zip,
            businessId: _b19Enriched[0]?.business_id ?? null,
            resolved: true,
            resolvedVia: 'name_search',
            resultCount: _b19Enriched.length,
            startTime: _reqStart
          });
          upsertCustomerSession({
            customerId,
            idType: customerIdType,
            query,
            businessId: _b19Enriched[0]?.business_id ?? null,
            group: nlIntentEarly.group
          });
          const _b19Meta = {
            source:        'postgres+name_prefix',
            intent_type:   'NAME_SEARCH',
            resolves_via:  'name_search',
            matched_pattern: 'short_name_food',
            personalized:  !!customerSession,
            customer_query_count: customerSession?.query_count ?? null,
            coverage:      '113,684 businesses — Florida statewide',
          };
          _b19Meta.narrative = buildNarrative(
            _b19Enriched,
            { ...nlIntentEarly, category: nlIntentEarly.category || 'restaurant' },
            { ..._b19Meta, zip }
          );
          maybeLogSms(req, {
            customerId,
            query,
            zip,
            intent: 'name_search',
            resolvedVia: 'name_search',
            responsePreview: _b19Meta.narrative
              || (_b19Enriched[0] && `Top result: ${_b19Enriched[0].name}`)
              || '',
          });
          // B41: Append turns (fire-and-forget)
          {
            const _b41Top = _b19Enriched[0] || null;
            const _b41Summary = _b19Meta.narrative
              || (_b41Top && `Top result: ${_b41Top.name}`)
              || `${_b19Enriched.length} name match(es)`;
            appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,        zip, intent: 'name_search' }).catch(() => {});
            appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _b41Summary,  zip,
              businessId:   _b41Top?.business_id ?? null,
              businessName: _b41Top?.name        ?? null,
              resolvesVia:  'name_search' }).catch(() => {});
          }
          return res.json({
            ok:       true,
            total:    _b19Enriched.length,
            returned: _b19Enriched.length,
            zips:     zip ? [zip] : TARGET_ZIPS,
            results:  _b19Enriched,
            meta:     _b19Meta,
          });
        }
        // 0 rows → fall through to normal intent routing (category search will handle it)
      } catch (err) {
        console.error('[B19] short-name food search failed:', err.message);
        // swallow and fall through
      }
    }

    // ── Step 6 — Resolution path routing (How dimension) ────────────────────
    // Registry's resolvesVia drives where this request goes. ORDER → /place-order,
    // STATUS → /order-status, search/dispatch → continue below. Returns a clear
    // structured 400 with a redirect hint instead of running an irrelevant SQL search.
    const resolvesVia = nlIntentEarly.resolvesVia ?? 'search';
    if (resolvesVia === 'surge') {
      return res.status(400).json({
        ok: false,
        error: 'Order intents must use the /place-order endpoint',
        redirect: '/api/local-intel/place-order',
        intent_class: nlIntentEarly.taskClass,
        resolves_via: 'surge',
        meta: { resolves_via: 'surge' },
      });
    }
    if (resolvesVia === 'status') {
      return res.status(400).json({
        ok: false,
        error: 'Status intents must use the /order-status endpoint',
        redirect: '/api/local-intel/order-status',
        intent_class: nlIntentEarly.taskClass,
        resolves_via: 'status',
        meta: { resolves_via: 'status' },
      });
    }
    // ── Step 8 — RFQ routing (non-food service verticals) ──────────────────
    // Plumber, electrician, HVAC, roofer, handyman, painter, landscaper,
    // cleaner, mechanic, towing → handleRFQ broadcasts a Twilio SMS bid to
    // matching businesses and notifies the customer.
    // B19: FOOD_RFQ_BLOCK guard — food categories must never broadcast an RFQ
    // bid to restaurants. "V pizza" with no exact match was hitting RFQ as a
    // catch-all and texting Domino's a service-bid SMS. If a food category
    // tries to route to RFQ, reroute to search (fall through to Phase 2).
    const FOOD_RFQ_BLOCK = new Set([
      'restaurant','food','pizza','dessert','grocery','coffee',
      'bakery','seafood','sushi','tacos','wings','burger','bbq',
      'breakfast','brunch','lunch','dinner','takeout','delivery_food'
    ]);
    if (resolvesVia === 'rfq'
        && nlIntentEarly?.category
        && FOOD_RFQ_BLOCK.has(nlIntentEarly.category)) {
      console.log(`[B19] food RFQ block — rerouting "${query}" (cat=${nlIntentEarly.category}) from RFQ to SEARCH`);
      // fall through — Phase 2 search below will handle it via searchByCategory
    } else if (resolvesVia === 'rfq') {
      return await handleRFQ(req, res, nlIntentEarly, query, customerId, zip);
    }
    // ── Reservation routing ────────────────────────────────────────────────
    // "reservation at X", "book a table at X", "do you take reservations" →
    // handleReservation surfaces the restaurant's phone + website (web) and
    // sends an SMS confirmation (Twilio SMS channel). Voice channel handled
    // separately in lib/voiceIntake.js with a TwiML <Dial>.
    if (resolvesVia === 'reservation') {
      return await handleReservation(req, res, query, customerId, zip);
    }
    // resolvesVia === 'search' or 'dispatch' — continue to SQL search
    // 'dispatch' is handled by the existing 0-result dispatchTask path below.

    // ── Phase 2 — intent-aware search bar path ──────────────────────────────
    // Only kicks in for free-text queries (no explicit category/group filter).
    // ORDER_ITEM falls through to the legacy handler (Basalt order flow lives there).
    // _phase2Intent hoisted — lets tsvector fallback scope by category (Fix 3)
    let _phase2Intent = null;
    if (query && !category && !group) {
      const intent = classifyIntent(query, { cuisine: nlIntentEarly.cuisine || null });
      _phase2Intent = intent;
      if (intent.type === 'CATEGORY_SEARCH' || intent.type === 'TEXT_SEARCH') {
        try {
          const lim = Math.min(Number(limit) || 50, 200);
          const phase2Concept = detectConcept(query || '') || 'GENERAL';
          let phase2Rows = intent.type === 'CATEGORY_SEARCH'
            ? await searchByCategory(intent, zip, lim, phase2Concept)
            : await searchByText(intent.raw, zip, lim, phase2Concept);

          // Step 4 — temporal post-filter (When dimension). Same data-hole
          // protection as legacy path: if the filter would drop every row,
          // keep originals (missing hours data must not silently exclude).
          if (nlIntentEarly.temporalContext && phase2Rows && phase2Rows.length > 0) {
            const filtered = phase2Rows.filter(b => isOpenDuringWindow(b, nlIntentEarly.temporalContext));
            if (filtered.length > 0) phase2Rows = filtered;
          }

          if (phase2Rows && phase2Rows.length > 0) {
            const sorted = sortResults(phase2Rows.slice());
            let enriched = sorted.map(r => {
              const out = { ...r };
              if (r.pos_type === 'other' && r.wallet) {
                out.ucp_order_url = 'https://surge.basalthq.com/api/ucp/checkout-sessions';
                out.ucp_wallet    = r.wallet;
                out.ucp_note      = 'POST ucp_order_url with shopSlug resolved via GET https://surge.basalthq.com/api/directory/shops?q=' + encodeURIComponent(r.name);
              }
              out.matchReason = buildMatchReason(r, intent, query);
              delete out.pos_type;
              delete out.has_wallet;
              delete out.confidence_score;
              return out;
            });
            // Step 5 — personalize ordering for known customers
            if (customerSession) {
              enriched = personalizeResults(enriched, customerSession);
            }
            recordResolution({
              query,
              intent: { taskClass: intent.type, group: null, cuisine: null },
              zip,
              businessId: enriched[0]?.business_id ?? null,
              resolved: true,
              resolvedVia: 'search',
              resultCount: enriched.length,
              startTime: _reqStart
            });
            // Step 5 — fire-and-forget customer session upsert
            upsertCustomerSession({
              customerId,
              idType: customerIdType,
              query,
              businessId: enriched[0]?.business_id ?? null,
              group: nlIntentEarly.group
            });
            // Inject showcase businesses (ZIP-agnostic, cuisine-gated)
            const cuisineForShowcase = nlIntentEarly?.cuisine || intent?.cuisine || null;
            enriched = await injectShowcase(enriched, cuisineForShowcase);
            const _phase2Meta = {
              source:        'postgres+intent',
              intent_type:   intent.type,
              categories:    intent.categories || null,
              needs_open:    !!intent.needsOpenNow,
              matched_keyword: intent.matchedKeyword || null,
              temporal:      nlIntentEarly.temporalContext ?? null,
              personalized:  !!customerSession,
              customer_query_count: customerSession?.query_count ?? null,
              resolves_via:  resolvesVia,
              coverage:      '113,684 businesses — Florida statewide',
            };
            _phase2Meta.narrative = buildNarrative(
              enriched,
              { ...nlIntentEarly, category: (intent.categories && intent.categories[0]) || nlIntentEarly.category },
              { ..._phase2Meta, zip }
            );
            maybeLogSms(req, {
              customerId,
              query,
              zip,
              intent: (intent.categories && intent.categories[0]) || intent.type || 'search',
              resolvedVia: 'search',
              responsePreview: _phase2Meta.narrative
                || (enriched[0] && `Top result: ${enriched[0].name}`)
                || '',
            });
            // B41: Append turns (fire-and-forget)
            {
              const _b41Top = enriched[0] || null;
              const _b41Summary = _phase2Meta.narrative
                || (_b41Top && `Top result: ${_b41Top.name}`)
                || `${enriched.length} result(s)`;
              const _b41Intent = (intent.categories && intent.categories[0]) || intent.type || 'search';
              appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,       zip, intent: _b41Intent }).catch(() => {});
              appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _b41Summary, zip,
                businessId:   _b41Top?.business_id ?? null,
                businessName: _b41Top?.name        ?? null,
                resolvesVia:  'search' }).catch(() => {});
            }
            return res.json({
              ok:       true,
              total:    enriched.length,
              returned: enriched.length,
              zips:     zip ? [zip] : TARGET_ZIPS,
              results:  enriched,
              meta:     _phase2Meta,
            });
          }
          // 0 rows from Phase 2 → dispatch as a task to the agent network.
          // ORDER_ITEM intent stays out of the dispatch loop (Basalt order flow handles it).
          if (intent && intent.type !== 'ORDER_ITEM') {
            try {
              const task = await dispatchTask(intent, query, zip);
              recordResolution({
                query,
                intent: { taskClass: intent.type || 'DISCOVER', group: null, cuisine: null },
                zip,
                businessId: null,
                resolved: false,
                resolvedVia: 'dispatch',
                resultCount: 0,
                startTime: _reqStart
              });
              upsertCustomerSession({
                customerId,
                idType: customerIdType,
                query,
                businessId: null,
                group: nlIntentEarly.group
              });
              const _gapMeta = {
                source:     'task_dispatch',
                gap:        true,
                gap_query:  query,
                gap_intent: intent.type || 'DISCOVER',
                temporal:   nlIntentEarly.temporalContext ?? null,
                personalized:  !!customerSession,
                customer_query_count: customerSession?.query_count ?? null,
                resolves_via: resolvesVia,
              };
              _gapMeta.narrative = buildNarrative([], nlIntentEarly, { ..._gapMeta, zip });
              const _gapMsg = `We're on it — looking for "${query}" in ${zip || 'your area'}. You'll hear back shortly.`;
              maybeLogSms(req, {
                customerId,
                query,
                zip,
                intent: intent.type || 'DISCOVER',
                resolvedVia: 'unmatched',
                responsePreview: _gapMsg,
              });
              // B41: Append turns (fire-and-forget)
              appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,   zip, intent: intent.type || 'DISCOVER' }).catch(() => {});
              appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _gapMsg, zip, resolvesVia: 'dispatch' }).catch(() => {});
              return res.json({
                ok: true,
                taskCreated: true,
                taskId: task.task_id,
                message: _gapMsg,
                businesses: [],
                results: [],
                total: 0,
                returned: 0,
                meta: _gapMeta,
              });
            } catch (taskErr) {
              console.error('[taskDispatch] failed to create task:', taskErr.message);
              // Fall through to normal empty/legacy response — never block the user.
            }
          }
          // 0 rows → fall through to legacy ILIKE path below
        } catch (phase2Err) {
          console.error('[local-intel phase2 search]', phase2Err.message);
          // fall through to legacy path
        }
      }
    }

    // ── Resolve NL intent ────────────────────────────────────────────────────
    const nlIntent = (!group && !category)
      ? resolveNlIntentFromRegistry(query)
      : { taskClass: null, group: null, tags: null, cuisine: null, category: null, resolvesVia: 'search' };
    const effectiveGroup    = group || nlIntent.group;
    const effectiveCategory = category || nlIntent.category;

    // ── Tier 2/Tier 1 alias resolution for named-business search ─────────────
    // Only matters when the user typed a name (no group/category match).
    let resolvedQuery = query;
    let pinnedAliasBusinessId = null;
    if (query && !effectiveGroup && !effectiveCategory) {
      try {
        const aliasRes = await resolveBusinessAlias(query);
        if (aliasRes && aliasRes.canonical) resolvedQuery = aliasRes.canonical;
        pinnedAliasBusinessId = aliasRes?.business_id || null;
      } catch (err) {
        console.error('[local-intel] alias resolve error:', err.message);
      }
    }

    // ── Build Postgres query — all filtering in SQL ──────────────────────────
    const conditions = ["status != 'inactive'"]; // matches active + null, excludes only explicitly inactive
    const params = [];
    let p = 1;

    if (zip) {
      conditions.push(`zip = $${p++}`);
      params.push(zip);
    } else {
      // No ZIP pinned — enforce TARGET_ZIPS so statewide businesses never leak into local results
      conditions.push(`zip = ANY($${p++}::text[])`);
      params.push(TARGET_ZIPS);
    }
    if (effectiveCategory) {
      conditions.push(`category = $${p++}`);
      params.push(effectiveCategory);
    }
    if (effectiveGroup && !effectiveCategory) {
      // Use the CATEGORY_GROUPS mapping — pass the categories that belong to this group
      const groupCats = CATEGORY_GROUPS[effectiveGroup];
      if (groupCats && groupCats.length) {
        conditions.push(`category = ANY($${p++})`);
        params.push(groupCats);
      }
    }
    if (minConfidence) {
      conditions.push(`confidence_score >= $${p++}`);
      params.push(minConfidence);
    }

    // Cuisine filter — additive when NL intent resolved a cuisine
    if (nlIntent.cuisine) {
      conditions.push(`(cuisine = $${p} OR cuisine ILIKE $${p + 1} OR description ILIKE $${p + 1})`);
      params.push(nlIntent.cuisine);
      params.push(`%${nlIntent.cuisine}%`);
      p += 2;
    }

    // Name/address text search
    let orderBy = 'confidence_score DESC, name ASC';
    if (query && !effectiveGroup && !effectiveCategory) {
      if (pinnedAliasBusinessId) {
        conditions.push(`(business_id = $${p} OR name ILIKE $${p + 1} OR category ILIKE $${p + 1} OR address ILIKE $${p + 1} OR description ILIKE $${p + 1})`);
        params.push(pinnedAliasBusinessId);
        params.push(`%${resolvedQuery}%`);
        p += 2;
      } else {
        conditions.push(`(
          name ILIKE $${p} OR
          category ILIKE $${p} OR
          address ILIKE $${p} OR
          description ILIKE $${p}
        )`);
        params.push(`%${resolvedQuery}%`);
        p++;
      }
    }

    // Tag boost for semantic queries (e.g. "healthy food")
    let tagBoost = '';
    if (nlIntent.tags && nlIntent.tags.length) {
      tagBoost = `, CASE WHEN tags && $${p++}::text[] THEN 1 ELSE 0 END AS tag_score`;
      params.push(nlIntent.tags);
      orderBy = 'tag_score DESC, confidence_score DESC';
    }

    const lim = Math.min(Number(limit) || 50, 200);
    params.push(lim);

    const sql = `
      SELECT
        business_id, name, address, city, zip, phone, website,
        hours, category, category_group, tags, description, cuisine,
        confidence_score AS confidence, confidence_score, lat, lon, sunbiz_doc_number,
        claimed_at IS NOT NULL AS claimed,
        wallet,
        pos_config->>'pos_type' AS pos_type,
        is_showcase
        ${tagBoost}
      FROM businesses
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${p}
    `;

    let rawRows = await db.query(sql, params);

    // ── tsvector fallback — main ILIKE returned 0 rows but the user typed a meaningful query ──
    // Fix 3: if Phase 2 was a CATEGORY_SEARCH, scope this fallback to those categories
    // so "gas station near me" never returns auto_repair results via raw text match.
    let usedTsFallback = false;
    if ((!rawRows || rawRows.length === 0) && query && typeof query === 'string') {
      const _STOPWORDS = new Set([
        'the','a','an','is','are','can','i','where','get','find','nearest','closest',
        'me','my','to','for','of','in','on','at','or','and','do','you','any','some',
      ]);
      const tokens = String(query).toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t && !_STOPWORDS.has(t));
      if (tokens.length) {
        const tsq = tokens.join(' & ');
        const fbZips = zip ? [zip] : TARGET_ZIPS;
        // If Phase 2 classified this as CATEGORY_SEARCH, scope fallback to those
        // categories — prevents "gas" token from matching auto_repair businesses.
        const _fbCats = (_phase2Intent && _phase2Intent.type === 'CATEGORY_SEARCH' && _phase2Intent.categories && _phase2Intent.categories.length)
          ? _phase2Intent.categories
          : null;
        // B70: concept-aware ORDER BY (zip_signals weighted by detected concept).
        const _fbConcept = detectConcept(query || '') || 'GENERAL';
        const _fbRanked  = buildConceptOrderBy(_fbConcept, 'zs', 'b');
        const fbSql = _fbCats
          ? `
          SELECT
            b.business_id, b.name, b.address, b.city, b.zip, b.phone, b.website,
            b.hours, b.category, b.category_group, b.tags, b.description, b.cuisine,
            b.confidence_score AS confidence, b.confidence_score, b.lat, b.lon, b.sunbiz_doc_number,
            b.claimed_at IS NOT NULL AS claimed,
            b.wallet,
            b.pos_config->>'pos_type' AS pos_type,
            b.is_showcase,
            ts_rank(b.search_vector, to_tsquery('english', $1)) AS rank
          FROM businesses b
          LEFT JOIN zip_signals zs ON zs.zip = b.zip
          WHERE b.status != 'inactive'
            AND b.zip = ANY($2::text[])
            AND b.category = ANY($3::text[])
            AND b.search_vector @@ to_tsquery('english', $1)
          ORDER BY rank DESC, ${_fbRanked}
          LIMIT 20
          `
          : `
          SELECT
            b.business_id, b.name, b.address, b.city, b.zip, b.phone, b.website,
            b.hours, b.category, b.category_group, b.tags, b.description, b.cuisine,
            b.confidence_score AS confidence, b.confidence_score, b.lat, b.lon, b.sunbiz_doc_number,
            b.claimed_at IS NOT NULL AS claimed,
            b.wallet,
            b.pos_config->>'pos_type' AS pos_type,
            b.is_showcase,
            ts_rank(b.search_vector, to_tsquery('english', $1)) AS rank
          FROM businesses b
          LEFT JOIN zip_signals zs ON zs.zip = b.zip
          WHERE b.status != 'inactive'
            AND b.zip = ANY($2::text[])
            AND b.search_vector @@ to_tsquery('english', $1)
          ORDER BY rank DESC, ${_fbRanked}
          LIMIT 20
        `;
        try {
          rawRows = _fbCats
            ? await db.query(fbSql, [tsq, fbZips, _fbCats])
            : await db.query(fbSql, [tsq, fbZips]);
          usedTsFallback = (rawRows && rawRows.length > 0);
        } catch (tsErr) {
          // Bad tsquery (e.g. reserved chars) — non-fatal, keep empty results
          console.error('[local-intel ts-fallback]', tsErr.message);
          rawRows = [];
        }
      }
    }

    // ── Semantic search fallback (pgvector) — fires when tsvector also returns 0 ──
    // Only runs if EMBEDDING_SERVICE_URL is configured. Failure → rawRows stays
    // empty → falls through to dispatchTask. Never crashes.
    let usedSemantic = false;
    if ((!rawRows || rawRows.length === 0) && query && typeof query === 'string'
        && process.env.EMBEDDING_SERVICE_URL) {
      try {
        const { embedText } = require('./lib/embedderClient');
        const queryVector = await embedText(query);
        if (queryVector) {
          const detectedZips = zip ? [zip] : TARGET_ZIPS;
          const semanticResults = await db.query(
            `SELECT
                business_id, name, address, city, zip, phone, website,
                hours, category, category_group, tags, description, cuisine,
                confidence_score AS confidence, confidence_score, lat, lon, sunbiz_doc_number,
                claimed_at IS NOT NULL AS claimed,
                wallet,
                pos_config->>'pos_type' AS pos_type,
                is_showcase,
                (embedding <=> $1::vector) AS semantic_distance
             FROM businesses
             WHERE zip = ANY($2::text[])
               AND embedding IS NOT NULL
               AND status != 'inactive'
             ORDER BY semantic_distance ASC
             LIMIT 20`,
            [`[${queryVector.join(',')}]`, detectedZips]
          );
          if (semanticResults && semanticResults.length > 0) {
            rawRows = semanticResults;
            usedSemantic = true;
            console.log(`[localintel] semantic search found ${rawRows.length} results for: ${query}`);
          }
        }
      } catch (semErr) {
        console.error('[local-intel semantic-fallback]', semErr.message);
        // rawRows stays empty — fall through to dispatchTask
      }
    }

    // ── Step 4 — temporal post-filter (When dimension) ──────────────────────
    // Applies after BOTH the main ILIKE (Path A) and the tsvector fallback (Path B),
    // since rawRows holds whichever produced results. Missing/unparseable hours
    // ALWAYS include — never silently exclude on uncertainty. If the filter would
    // eliminate every result (data hole, not closed businesses), keep originals.
    if (nlIntent.temporalContext && rawRows && rawRows.length > 0) {
      const filtered = rawRows.filter(b => isOpenDuringWindow(b, nlIntent.temporalContext));
      if (filtered.length > 0) {
        rawRows = filtered;
      }
    }

    // ── 0-result task dispatch — open the loop to the agent network ──
    // Skip when caller pinned a category/group filter (they got an empty page from a real filter,
    // not a free-text search miss) and when the NL intent looks like ORDER/STATUS (Basalt order
    // flow handles those separately).
    let dispatchedGap = false;
    if ((!rawRows || rawRows.length === 0) && query && !category && !group
        && nlIntent.taskClass !== 'ORDER' && nlIntent.taskClass !== 'STATUS') {
      try {
        const dispatchIntent = {
          type: 'TEXT_SEARCH',
          categories: nlIntent.category ? [nlIntent.category] : [],
          cuisines:   nlIntent.cuisine  ? [nlIntent.cuisine]  : [],
          group:      nlIntent.group    || null,
          taskClass:  nlIntent.taskClass || 'DISCOVER',
          raw:        query,
        };
        // Fire and forget — never block the user response on dispatch.
        Promise.resolve()
          .then(() => dispatchTask(dispatchIntent, query, zip))
          .catch(e => console.error('[taskDispatch legacy 0-result]', e.message));
        dispatchedGap = true;

        // Step 7 — Self-monitoring: alert when same group+ZIP repeatedly fails.
        // Fire-and-forget — never blocks response.
        db.query(
          `SELECT COUNT(*) AS cnt
           FROM resolution_history
           WHERE resolved = false
             AND intent_group = $1
             AND zip = $2`,
          [nlIntent.group ?? null, zip ?? null]
        ).then(rows => {
          const cnt = Number(rows[0]?.cnt ?? 0);
          if (cnt >= 5) {
            console.warn(`[GAP ALERT] "${nlIntent.group}" in ZIP ${zip} has ${cnt} unresolved queries — acquisition target`);
          }
        }).catch(() => {}); // never throws
      } catch (dispatchInitErr) {
        console.error('[taskDispatch legacy init]', dispatchInitErr.message);
      }
    }

    // Enrich rows with UCP order URL for Surge-connected businesses + matchReason
    let rows = (rawRows || []).map(r => {
      const enriched = { ...r };
      if (r.pos_type === 'other' && r.wallet) {
        // Surge shop slug derived from wallet — agents can also use /api/directory/shops to discover
        enriched.ucp_order_url = 'https://surge.basalthq.com/api/ucp/checkout-sessions';
        enriched.ucp_wallet    = r.wallet;
        enriched.ucp_note      = 'POST ucp_order_url with shopSlug resolved via GET https://surge.basalthq.com/api/directory/shops?q=' + encodeURIComponent(r.name);
      }
      try {
        enriched.matchReason = buildMatchReason(r, nlIntent, query);
      } catch (_) {
        enriched.matchReason = null;
      }
      // Remove internal fields agents don't need
      delete enriched.pos_type;
      delete enriched.confidence_score;
      return enriched;
    });

    // ── Notify claimed businesses ────────────────────────────────────────────
    if (zip && effectiveGroup) {
      try {
        const nq = require('./lib/notificationQueue');
        const subject = `Market query in your area — ${zip}`;
        const payload = {
          body: `An agent queried the ${effectiveGroup} market in ZIP ${zip}.`,
          zip, category_group: effectiveGroup,
          cta_url: 'https://thelocalintel.com', cta_label: 'View Details',
        };
        setImmediate(() =>
          nq.enqueueForZipCategory(zip, effectiveGroup, subject, payload)
            .then(n => { if (n > 0) return nq.processQueue(20); })
            .catch(e => console.error('[query-notify]', e.message))
        );
      } catch (notifyErr) {
        console.error('[query-notify-init]', notifyErr.message);
      }
    }

    // Real total: COUNT(*) with same WHERE but no LIMIT — so callers know the full set size.
    // Skip when the tsvector fallback ran (those rows were resolved via search_vector, not the
    // ILIKE WHERE clause built above, so the COUNT would not represent that result set).
    let realTotal = rows.length;
    if (!usedTsFallback && !usedSemantic) {
      try {
        // countParams = everything except the final LIMIT param
        const countParams  = params.slice(0, -1);
        const countSql     = `SELECT COUNT(*) AS total FROM businesses WHERE ${conditions.join(' AND ')}`;
        const countRows    = await db.query(countSql, countParams);
        realTotal          = parseInt(countRows[0]?.total || rows.length, 10);
      } catch (_) { /* non-fatal — fall back to page size */ }
    }

    // ── Step 5 — personalize ordering for known customers ───────────────────
    if (customerSession) {
      rows = personalizeResults(rows, customerSession);
    }

    // ── Inject showcase businesses (ZIP-agnostic, cuisine-gated) ────────────
    const cuisineForShowcase = nlIntent?.cuisine || nlIntentEarly?.cuisine || null;
    rows = await injectShowcase(rows, cuisineForShowcase);

    // ── Step 5 — fire-and-forget customer session upsert ────────────────────
    upsertCustomerSession({
      customerId,
      idType: customerIdType,
      query,
      businessId: rows[0]?.business_id ?? null,
      group: nlIntent.group
    });

    // ── Step 3 — record resolution outcome (fire-and-forget) ─────────────────
    if (rows.length > 0) {
      recordResolution({
        query,
        intent: nlIntent,
        zip,
        businessId: rows[0]?.business_id ?? null,
        resolved: true,
        resolvedVia: usedSemantic ? 'pgvector' : (usedTsFallback ? 'tsvector' : 'search'),
        resultCount: rows.length,
        startTime: _reqStart
      });
    } else if (dispatchedGap) {
      recordResolution({
        query,
        intent: nlIntent,
        zip,
        businessId: null,
        resolved: false,
        resolvedVia: 'dispatch',
        resultCount: 0,
        startTime: _reqStart
      });
    }

    // ── B10 — dead-end logging (fire-and-forget) ────────────────────────────
    // Capture every 0-result response so we can surface intent gaps later.
    if (rows.length === 0) {
      const _channel = req.body?.channel || (customerId && String(customerId).startsWith('+') ? 'twilio' : 'web');
      const _failReason = nlIntent?.taskClass || effectiveCategory || effectiveGroup
        ? 'no_results'
        : 'no_intent';
      const _intentPath = effectiveCategory
        ? `searchByCategory:${effectiveCategory}`
        : (effectiveGroup
            ? `searchByGroup:${effectiveGroup}`
            : (nlIntent?.taskClass ? `legacy:${nlIntent.taskClass}` : 'unmatched'));
      logDeadEnd({
        query,
        zip,
        channel: _channel,
        failReason: _failReason,
        intentPath: _intentPath,
        callerId: customerId || null,
      });
    }

    const _meta = {
      source:        usedSemantic ? 'postgres+pgvector' : (usedTsFallback ? 'postgres+tsvector' : 'postgres'),
      intent_class:  nlIntent.taskClass || null,
      intent_group:  nlIntent.group     || null,
      intent_cuisine: nlIntent.cuisine  || null,
      temporal:      nlIntent.temporalContext ?? null,
      ts_fallback:   usedTsFallback && !usedSemantic,
      semantic_search: usedSemantic,
      personalized:  !!customerSession,
      customer_query_count: customerSession?.query_count ?? null,
      resolves_via:  resolvesVia,
      ...(dispatchedGap && {
        gap:                true,
        gap_query:          query,
        gap_intent:         nlIntent.taskClass || 'DISCOVER',
        acquisition_signal: true,
      }),
      coverage:      '113,684 businesses — Florida statewide',
    };
    _meta.narrative = buildNarrative(rows, nlIntent, { ..._meta, zip });

    const _legacyResolvedVia = rows.length > 0
      ? (pinnedAliasBusinessId ? 'alias' : (usedSemantic ? 'pgvector' : (usedTsFallback ? 'tsvector' : 'search')))
      : 'unmatched';
    const _legacyIntent = effectiveCategory
      || effectiveGroup
      || nlIntent?.taskClass
      || (pinnedAliasBusinessId ? 'alias' : 'search');
    maybeLogSms(req, {
      customerId,
      query,
      zip,
      intent: _legacyIntent,
      resolvedVia: _legacyResolvedVia,
      responsePreview: _meta.narrative
        || (rows[0] && `Top result: ${rows[0].name}`)
        || (rows.length === 0 ? `No results for "${query}" in ${zip || 'your area'}` : ''),
    });

    // B41: Append turns (fire-and-forget)
    {
      const _b41Top = rows[0] || null;
      const _b41Summary = _meta.narrative
        || (_b41Top && `Top result: ${_b41Top.name}`)
        || (rows.length === 0 ? `No results for "${query}" in ${zip || 'your area'}` : `${rows.length} result(s)`);
      appendTurn({ callerId: customerId, channel: 'sms', role: 'user',   content: query,       zip, intent: _legacyIntent }).catch(() => {});
      appendTurn({ callerId: customerId, channel: 'sms', role: 'system', content: _b41Summary, zip,
        businessId:   _b41Top?.business_id ?? null,
        businessName: _b41Top?.name        ?? null,
        resolvesVia:  _legacyResolvedVia }).catch(() => {});
    }
    // B64: non-blocking ZIP score enrichment — wrapped in try/catch so scoring
    // failure never breaks routing. zip_score is null when ZIP unknown / no signals.
    let zipScore = null;
    if (zip) {
      try {
        const sigRows = await db.query(
          `SELECT * FROM zip_signals WHERE zip = $1 LIMIT 1`,
          [zip]
        );
        if (Array.isArray(sigRows) && sigRows.length > 0) {
          const concept = detectConcept(query || '') || 'GENERAL';
          const profile = CONCEPT_PROFILES[concept] || CONCEPT_PROFILES.GENERAL;
          const bounds = await getStatewideBounds();
          const scoreResult = scoreZipForConcept(sigRows[0], profile, bounds);
          zipScore = {
            zip,
            concept_detected: concept,
            total_score:      scoreResult.total_score,
            factor_breakdown: scoreResult.factor_breakdown,
            psycho_index:     scoreResult.psycho_index,
          };
        }
      } catch (_) { /* non-blocking */ }
    }

    res.json({
      ok:       true,
      total:    realTotal,
      returned: rows.length,
      zips:     zip ? [zip] : [],
      results:  rows,
      meta:     _meta,
      zip_score: zipScore,
    });
  } catch (e) {
    console.error('[local-intel query]', e.message);
    logDeadEnd({
      query,
      zip,
      channel: req.body?.channel || (customerId && String(customerId).startsWith('+') ? 'twilio' : 'web'),
      failReason: 'unknown',
      intentPath: `exception:${e.message?.slice(0, 80) || 'unknown'}`,
      callerId: customerId || null,
    });
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/local-intel/zones — spending zone summary ────────────────────────
// ── Census layer endpoint — industry breakdown per ZIP ─────────────────────
router.get('/census', async (req, res) => {
  const { zip } = req.query;
  if (!zip) return res.status(400).json({ error: 'zip required' });
  try {
    const rows = await db.query(
      'SELECT layer_json, confidence, updated_at FROM census_layer WHERE zip = $1', [zip]
    );
    if (!rows.length) return res.json({ zip, available: false });

    const layer = rows[0].layer_json || {};
    const conf  = rows[0].confidence || {};

    // Build clean investor-facing response
    const cbpSectors = layer.cbp?.sectors || {};
    const sectors = Object.entries(cbpSectors).map(([code, s]) => ({
      naics:          code,
      label:          s.label,
      establishments: s.establishments,
      employees:      s.employees,
      payroll_k:      s.payroll_k,
      county_emp_share_pct: s.county_emp_share_pct,
    })).sort((a, b) => b.establishments - a.establishments);

    // Permit signals — county_permits (Census BPS, all FL counties) + sjc_permits (SJC individual)
    let permitSignals = null;
    try {
      // 1. County-level from Census BPS — covers all 67 FL counties
      // Join ZIP → county via zip_intelligence.county field
      const countyRow = await db.query(
        `SELECT county FROM zip_intelligence WHERE zip = $1 LIMIT 1`, [zip]
      );
      const countyName = countyRow[0]?.county;

      if (countyName) {
        // Find most recent monthly record for this county
        const cpRows = await db.query(
          `SELECT res_1unit, res_2unit, res_multifam, total_units, total_value, period_key
             FROM county_permits
            WHERE state_fips = '12'
              AND LOWER(county_name) LIKE LOWER($1)
              AND period_type = 'monthly'
            ORDER BY period_key DESC
            LIMIT 1`,
          ['%' + countyName.split(' ')[0] + '%']
        );
        if (cpRows.length) {
          const cp = cpRows[0];
          permitSignals = {
            residential : cp.res_1unit + cp.res_2unit,
            multifamily : cp.res_multifam,
            total_units : cp.total_units,
            total_value : cp.total_value,
            period      : cp.period_key,
            source      : 'census_bps',
          };
        }
      }

      // 2. SJC individual permits — augment commercial count if available
      const sjcRows = await db.query(
        `SELECT permit_type, COUNT(*) as cnt
           FROM sjc_permits
          WHERE zip = $1 AND fetched_at > NOW() - INTERVAL '6 months'
          GROUP BY permit_type`, [zip]
      );
      if (sjcRows.length) {
        const sjcMap = {};
        sjcRows.forEach(r => { sjcMap[r.permit_type] = parseInt(r.cnt); });
        if (!permitSignals) permitSignals = { source: 'sjc_arcgis' };
        permitSignals.commercial = (sjcMap['commercial'] || 0);
        if (!permitSignals.residential) permitSignals.residential = sjcMap['residential'] || 0;
        if (!permitSignals.total_units) permitSignals.total_units =
          Object.values(sjcMap).reduce((a, b) => a + b, 0);
      }
    } catch (permErr) {
      console.warn('[census] permit lookup failed:', permErr.message);
    }

    // IRS income data
    let incomeData = null;
    try {
      const iRows = await db.query(
        'SELECT irs_agi_median, irs_returns, irs_wage_share FROM zip_intelligence WHERE zip = $1', [zip]
      );
      if (iRows.length && iRows[0].irs_agi_median) {
        incomeData = {
          median_agi:  iRows[0].irs_agi_median,
          total_returns: iRows[0].irs_returns,
          wage_share_pct: iRows[0].irs_wage_share,
        };
      }
    } catch (_) {}

    // Permit signals: reshape into consistent output
    let permitOut = null;
    if (permitSignals) {
      permitOut = {
        commercial  : permitSignals.commercial  || 0,
        residential : permitSignals.residential || 0,
        multifamily : permitSignals.multifamily || 0,
        total       : permitSignals.total_units || (permitSignals.residential + (permitSignals.multifamily||0) + (permitSignals.commercial||0)),
        total_value : permitSignals.total_value || null,
        period      : permitSignals.period      || null,
        source      : permitSignals.source      || 'unknown',
      };
    }

    // income: use consistent keys
    const incomeOut = incomeData ? {
      irs_agi_median:  incomeData.median_agi,
      irs_returns:     incomeData.total_returns,
      irs_wage_share:  incomeData.wage_share_pct,
    } : { irs_agi_median: null, irs_returns: null, irs_wage_share: null };

    // confidence tier string
    const confidenceTier = conf?.confidence_tier || conf?.tier || 'SPARSE';

    res.json({
      zip,
      available:    true,
      updated_at:   rows[0].updated_at,
      confidence:   confidenceTier,
      county_industry_breakdown: sectors,
      permit_signals_6mo: permitOut,
      income: incomeOut,
      pdb: layer.pdb ? {
        low_response_score: layer.pdb.low_response_score,
        college_pct:        layer.pdb.college_pct,
        poverty_pct:        layer.pdb.poverty_pct,
        new_units_added:    layer.pdb.new_units_added,
        vacancy_pct_tract:  layer.pdb.vacancy_pct_tract,
        vintage:            layer.pdb.pdb_vintage,
      } : null,
    });
  } catch (e) {
    console.error('[/census]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── All FL ZIPs — returns full FL ZIP list with county + lat/lon ────────────
// GET /api/local-intel/zips-all
// Used by generate-zip-pages.js and Explore Markets section to discover all ZIPs.
// Source of truth: zip_intelligence joined against FL_ZIP_SEED metadata.
router.get('/zips-all', async (req, res) => {
  try {
    // Pull all FL ZIPs from zip_intelligence (IRS SOI worker already seeded 1,109 rows)
    // Join with census_layer for county metadata where available
    const rows = await db.query(`
      SELECT
        zi.zip,
        COALESCE(cl.layer_json->>'county', zi.county_name) AS county,
        COALESCE(cl.layer_json->>'county_fips', zi.county_fips) AS county_fips,
        zi.city_name AS city,
        zi.lat,
        zi.lon
      FROM zip_intelligence zi
      LEFT JOIN census_layer cl ON cl.zip = zi.zip
      WHERE zi.zip IS NOT NULL
      ORDER BY county, zi.zip
    `);

    // If zip_intelligence doesn't have county columns yet, fall back to FL_ZIP_SEED
    // loaded from the census worker
    if (rows.length === 0 || rows.every(r => !r.county)) {
      // Return the seed data embedded in the worker
      const seed = require('./workers/flZipSeed.json');
      return res.json({ source: 'seed', zips: seed });
    }

    res.json({ source: 'postgres', count: rows.length, zips: rows });
  } catch (e) {
    console.error('[/zips-all]', e.message);
    // Always fall back to seed — never block SEO generation
    try {
      const seed = require('./workers/flZipSeed.json');
      res.json({ source: 'seed', count: seed.length, zips: seed });
    } catch (e2) {
      res.status(500).json({ error: e.message });
    }
  }
});

// ── ZIP Intel Query — LLM synthesis over Postgres data ─────────────────────
// POST /api/local-intel/zip-intel-query
// Body: { zip, question }
// Flow: pull structured data from Postgres → build context string → Perplexity sonar synthesis
router.post('/zip-intel-query', async (req, res) => {
  const { zip, question } = req.body || {};
  if (!zip || !question) return res.status(400).json({ error: 'zip and question required' });

  const PPLX_KEY = process.env.PERPLEXITY_API_KEY;
  if (!PPLX_KEY) return res.status(503).json({ error: 'PERPLEXITY_API_KEY not set on Railway' });

  try {
    // 1. Pull all structured data from Postgres — deterministic, no LLM
    const [censusRows, intelRows, permitRows] = await Promise.all([
      db.query('SELECT layer_json, confidence FROM census_layer WHERE zip = $1', [zip]),
      db.query(
        `SELECT population, median_household_income, total_businesses, market_opportunity_score,
                consumer_profile, growth_state, dominant_sector, business_density,
                irs_agi_median, irs_returns, irs_wage_share
         FROM zip_intelligence WHERE zip = $1`, [zip]
      ),
      db.query(
        `SELECT permit_type, COUNT(*) as cnt
         FROM sjc_permits WHERE zip = $1 AND fetched_at > NOW() - INTERVAL '6 months'
         GROUP BY permit_type ORDER BY cnt DESC`, [zip]
      ).catch(() => []),
    ]);

    const layer  = censusRows[0]?.layer_json || {};
    const conf   = censusRows[0]?.confidence || {};
    const intel  = intelRows[0] || {};
    const cbp    = layer.cbp?.sectors || {};
    const pdb    = layer.pdb || {};

    // Top 5 sectors by establishments
    const topSectors = Object.entries(cbp)
      .map(([code, s]) => `${s.label}: ${s.establishments} estab, ${s.county_emp_share_pct}% of county employment`)
      .sort()
      .slice(0, 5)
      .join('\n');

    const permitSummary = permitRows.length
      ? permitRows.map(r => `${r.permit_type}: ${r.cnt}`).join(', ')
      : 'No permit data (non-SJC ZIP)';

    // 2. Build structured context string
    const context = [
      `ZIP: ${zip}`,
      `Population: ${intel.population || 'unknown'}`,
      `Total businesses indexed: ${intel.total_businesses || 'unknown'}`,
      `IRS Median AGI: $${intel.irs_agi_median || 'unknown'}`,
      `IRS Returns (households): ${intel.irs_returns || 'unknown'}`,
      `Wage share of income: ${intel.irs_wage_share || 'unknown'}%`,
      `Median household income (ACS): $${intel.median_household_income || 'unknown'}`,
      `Market opportunity score: ${intel.market_opportunity_score || 'unknown'}/100`,
      `Consumer profile: ${intel.consumer_profile || 'unknown'}`,
      `Growth state: ${intel.growth_state || 'unknown'}`,
      `Dominant sector: ${intel.dominant_sector || 'unknown'}`,
      `Business density: ${intel.business_density || 'unknown'}`,
      `Data confidence: ${conf.confidence_tier || conf.tier || 'SPARSE'}`,
      `\nCounty industry breakdown (top sectors):\n${topSectors}`,
      `\nPDB (Census Planning Database):\n  College attainment: ${pdb.college_pct || 'unknown'}%\n  Poverty rate: ${pdb.poverty_pct || 'unknown'}%\n  New housing units: ${pdb.new_units_added || 'unknown'}\n  Vacancy rate: ${pdb.vacancy_pct_tract || 'unknown'}%`,
      `\nConstruction/permit signals (6mo): ${permitSummary}`,
    ].join('\n');

    // 3. Perplexity sonar synthesis — LLM only interprets, never invents
    const pplxRes = await fetch('https://api.perplexity.ai/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PPLX_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'sonar',
        messages: [
          {
            role: 'system',
            content: `You are a local market intelligence analyst for LocalIntel, an agentic business discovery platform. You answer questions strictly based on the structured Postgres data provided. Never invent facts, never hallucinate statistics. If data is missing say so. Be concise and actionable — max 3-4 sentences. Focus on what the data means for business deployment decisions.`,
          },
          {
            role: 'user',
            content: `Data for ZIP ${zip}:\n\n${context}\n\nQuestion: ${question}`,
          },
        ],
        max_tokens: 300,
        temperature: 0.2,
      }),
    });

    const pplxJson = await pplxRes.json();
    const answer = pplxJson.choices?.[0]?.message?.content || 'No answer returned.';

    res.json({ zip, question, answer, data_confidence: conf.confidence_tier || 'SPARSE' });
  } catch (e) {
    console.error('[/zip-intel-query]', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/zones', (req, res) => {
  const zones = loadZones();
  res.json({ ok: true, ...zones });
});

// ── ZIP SEO Data — static-page build-time aggregates ──────────────────────────
// GET /api/local-intel/zip-seo-data?zip=XXXXX
// Public, read-only aggregate. Called by generate-zip-pages.js at landing-site
// build time (~1,474 ZIPs, sequential) to bake unique per-ZIP stats into static
// HTML and fix the thin-content problem flagged in Google Search Console.
router.get('/zip-seo-data', async (req, res) => {
  const zip = (req.query.zip || '').toString().trim();
  if (!zip) return res.status(400).json({ error: 'zip required' });

  try {
    const [topCatRows, totalRows, intelRows, hoodRows] = await Promise.all([
      db.query(
        `SELECT category, COUNT(*)::int AS cnt
           FROM businesses
          WHERE zip = $1 AND status != 'inactive'
          GROUP BY category
          ORDER BY cnt DESC
          LIMIT 3`,
        [zip]
      ).catch(() => []),
      db.query(
        `SELECT COUNT(*)::int AS total
           FROM businesses
          WHERE zip = $1 AND status != 'inactive'`,
        [zip]
      ).catch(() => [{ total: 0 }]),
      (async () => {
        try {
          const rows = await db.query(
            `SELECT city_name, county_name,
                    population,
                    median_household_income AS median_income,
                    median_home_value,
                    affluence_pct
               FROM zip_intelligence
              WHERE zip = $1
              LIMIT 1`,
            [zip]
          );
          if (rows.length) return rows;
        } catch (_) { /* table or column missing — fall through */ }
        try {
          return await db.query(
            `SELECT city_name, county_name,
                    population,
                    median_household_income AS median_income,
                    median_home_value,
                    affluence_pct
               FROM zip_signals
              WHERE zip = $1
              LIMIT 1`,
            [zip]
          );
        } catch (_) { return []; }
      })(),
      db.query(
        `SELECT DISTINCT name
           FROM neighborhoods
          WHERE $1 = ANY(zip_codes)
          ORDER BY name
          LIMIT 5`,
        [zip]
      ).catch(() => []),
    ]);

    const total = totalRows[0]?.total || 0;
    const intel = intelRows[0] || {};
    const hasIntel = intelRows.length > 0;

    if (total === 0 && !hasIntel) {
      return res.status(404).json({ error: 'not_found' });
    }

    res.json({
      zip,
      city:              intel.city_name   || null,
      county:            intel.county_name || null,
      business_count:    total,
      top_categories:    topCatRows.map(r => r.category).filter(c => c && c !== 'LocalBusiness').slice(0, 3),
      population:        intel.population        ?? null,
      median_income:     intel.median_income     ?? null,
      median_home_value: intel.median_home_value ?? null,
      affluence_pct:     intel.affluence_pct     ?? null,
      neighborhoods:     hoodRows.map(r => r.name).filter(Boolean),
    });
  } catch (e) {
    console.error('[/zip-seo-data]', zip, e.message);
    res.status(500).json({ error: e.message });
  }
});


// ─── CLAIM ENDPOINTS ──────────────────────────────────────────────────────────

// GET /api/local-intel/claim/lookup?name=&zip=
router.get('/claim/lookup', async (req, res) => {
  const { name, zip } = req.query;
  if (!name && !zip) return res.status(400).json({ error: 'name or zip required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `SELECT business_id, name, address, city, zip, phone, website,
              category, category_group, status, lat, lon,
              sunbiz_doc_number,
              (claimed_at IS NOT NULL) as is_claimed
         FROM businesses
        WHERE status != 'inactive'
          AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR zip = $2)
        ORDER BY
          CASE WHEN claimed_at IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN lat IS NOT NULL THEN 0 ELSE 1 END,
          name ASC
        LIMIT 10`,
      [name || null, zip || null]
    );
    res.json({ results: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/local-intel/claim/start
router.post('/claim/start', express.json(), async (req, res) => {
  const { business_id, contact_email, contact_phone, carrier,
          notify_sms, notify_email, notify_push, notify_web, wallet } = req.body || {};
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!contact_email && !contact_phone) return res.status(400).json({ error: 'email or phone required' });
  try {
    const db     = require('./lib/db');
    const crypto = require('crypto');
    const nq     = require('./lib/notificationQueue');

    const [biz] = await db.query(
      `SELECT business_id, name, claimed_at FROM businesses WHERE business_id = $1 AND status = 'active'`,
      [business_id]
    );
    if (!biz)           return res.status(404).json({ error: 'business not found' });
    // Already claimed = returning owner. Still send a code so they can re-verify and get their inbox link.
    // Do NOT block here — fall through to send the code.

    const token    = String(Math.floor(100000 + Math.random() * 900000));
    const tokenExp = new Date(Date.now() + 30 * 60 * 1000);

    await db.query(
      `UPDATE businesses SET
         claim_token        = $1, claim_token_exp   = $2,
         notification_phone = $3, notification_email = $4,
         notify_sms = $5, notify_email = $6, notify_push = $7, notify_web = $8,
         wallet = COALESCE($9, wallet)
       WHERE business_id = $10`,
      [token, tokenExp, contact_phone||null, contact_email||null,
       !!notify_sms, !!notify_email, !!notify_push, !!notify_web,
       wallet||null, business_id]
    );

    const verifyChannel = contact_email ? 'email' : 'sms';
    await nq.enqueue(business_id,
      `Your LocalIntel code: ${token}`,
      { body: `Verification code: ${token}. Expires in 30 minutes.`, code: token, carrier: carrier||'verizon' },
      [verifyChannel]
    );
    setImmediate(() => nq.processQueue(5).catch(e => console.error('[notify]', e.message)));
    res.json({ ok: true, channel: verifyChannel, expires_in: 30 });
  } catch (err) {
    console.error('[claim/start]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/local-intel/claim/verify
router.post('/claim/verify', express.json(), async (req, res) => {
  const { business_id, token } = req.body || {};
  if (!business_id || !token) return res.status(400).json({ error: 'business_id and token required' });
  try {
    const db  = require('./lib/db');
    const nq  = require('./lib/notificationQueue');
    const [biz] = await db.query(
      `SELECT business_id, name, claim_token, claim_token_exp, claimed_at, dispatch_token,
              notify_sms, notify_email, notify_push, notify_web
         FROM businesses WHERE business_id = $1 AND status = 'active'`,
      [business_id]
    );
    if (!biz)             return res.status(404).json({ error: 'business not found' });
    if (!biz.claim_token) return res.status(400).json({ error: 'no pending claim' });
    if (biz.claim_token !== String(token)) return res.status(401).json({ error: 'invalid code' });
    if (new Date(biz.claim_token_exp) < new Date()) return res.status(401).json({ error: 'code expired' });

    // Already claimed — returning owner verified. Return their existing inbox link.
    if (biz.claimed_at && biz.dispatch_token) {
      return res.json({
        ok: true,
        returning: true,
        business_id:    biz.business_id,
        name:           biz.name,
        dispatch_token: biz.dispatch_token,
        inbox_url:      `https://www.thelocalintel.com/inbox?token=${biz.dispatch_token}`,
      });
    }

    // Generate a persistent dispatch_token — this is their inbox login, never expires
    const { randomUUID } = require('crypto');
    const dispatchToken = randomUUID();
    // sunbiz_id may be passed from claim flow step 3 (verifyDoc field)
    const sunbizId = req.body?.sunbiz_id || null;
    await db.query(
      `UPDATE businesses
          SET claimed_at = NOW(), claim_token = NULL, claim_token_exp = NULL,
              dispatch_token = $2
              ${sunbizId ? ', sunbiz_id = $3' : ''}
        WHERE business_id = $1`,
      sunbizId ? [business_id, dispatchToken, sunbizId] : [business_id, dispatchToken]
    );

    // Register business in agent_registry so deposit listener can credit their wallet
    // Each business gets a unique deposit address derived deterministically
    const pool = db.getPool ? db.getPool() : db;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        token              TEXT PRIMARY KEY,
        label              TEXT,
        type               TEXT NOT NULL DEFAULT 'agent',
        balance_usd_micro  BIGINT NOT NULL DEFAULT 0,
        total_spent_micro  BIGINT NOT NULL DEFAULT 0,
        total_queries      BIGINT NOT NULL DEFAULT 0,
        deposit_address    TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at       TIMESTAMPTZ
      )
    `);
    await pool.query(`ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'agent'`);
    // Generate a deterministic deposit address placeholder — real address assigned by Treasury in v2
    const depositAddr = '0x' + Buffer.from(business_id + dispatchToken).toString('hex').slice(0, 40);
    await pool.query(
      `INSERT INTO agent_registry (token, label, type, deposit_address)
       VALUES ($1, $2, 'business', $3)
       ON CONFLICT (token) DO UPDATE SET label = EXCLUDED.label, deposit_address = EXCLUDED.deposit_address`,
      [dispatchToken, biz.name, depositAddr]
    );

    const channels = ['web'];
    if (biz.notify_sms)   channels.push('sms');
    if (biz.notify_email) channels.push('email');
    await nq.enqueue(business_id,
      `Welcome to LocalIntel, ${biz.name}`,
      { body: `Your listing is claimed. You'll receive market intelligence when agents query your area.`, cta_url: 'https://thelocalintel.com', cta_label: 'View Dashboard' },
      channels
    );
    setImmediate(() => nq.processQueue(5).catch(() => {}));
    res.json({ ok: true, claimed: true, business_id, name: biz.name,
      dispatch_token: dispatchToken,
      deposit_address: depositAddr,
      inbox_url: `https://www.thelocalintel.com/inbox?token=${dispatchToken}` });
  } catch (err) {
    console.error('[claim/verify]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/claim/notifications?business_id=&since=
router.get('/claim/notifications', async (req, res) => {
  const { business_id, since } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const db   = require('./lib/db');
    const rows = await db.query(
      `SELECT id, channel, subject, payload, status, created_at, sent_at
         FROM notification_queue
        WHERE business_id = $1
          AND ($2::timestamptz IS NULL OR created_at > $2)
        ORDER BY created_at DESC LIMIT 50`,
      [business_id, since || null]
    );
    res.json({ notifications: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/local-intel/claim (legacy — same as /claim/start)
router.post('/claim', express.json(), async (req, res) => {
  res.redirect(307, '/api/local-intel/claim/start');
});

// ── Magic link login ──────────────────────────────────────────────────────────
// POST /api/local-intel/auth/magic
// Body: { email }
// Looks up business by notification_email, sends Resend magic link to inbox.
// Returns { ok: true } regardless (no email enumeration).
router.post('/auth/magic', express.json(), async (req, res) => {
  try {
    const db  = require('./lib/db');
    const nq  = require('./lib/notificationQueue');
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }

    // Always return ok — don't reveal whether email exists
    res.json({ ok: true });

    // Look up claimed business by notification_email
    const [biz] = await db.query(
      `SELECT business_id, name, dispatch_token, notification_email
         FROM businesses
        WHERE LOWER(notification_email) = $1
          AND claimed_at IS NOT NULL
          AND status = 'active'
        LIMIT 1`,
      [email]
    );

    if (!biz || !biz.dispatch_token) return; // no match — silent

    const inboxUrl = `https://www.thelocalintel.com/inbox.html?token=${biz.dispatch_token}`;

    // Send directly via Resend — do not use notificationQueue (wrong signature for custom to)
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from:    'LocalIntel <intel@thelocalintel.com>',
      to:      biz.notification_email,
      subject: 'Your LocalIntel dashboard link',
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
  <p style="font-size:18px;font-weight:700;color:#111827;margin-bottom:4px;">LocalIntel</p>
  <p style="color:#6B7280;font-size:13px;margin-bottom:28px;">thelocalintel.com</p>
  <p style="font-size:15px;color:#111827;">Hi <strong>${biz.name}</strong>,</p>
  <p style="font-size:15px;color:#374151;margin-top:12px;">Here is your permanent dashboard link:</p>
  <p style="margin:28px 0;">
    <a href="${inboxUrl}" style="background:#16A34A;color:#fff;padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open My Dashboard &rarr;</a>
  </p>
  <p style="font-size:13px;color:#6B7280;">Or copy this link:<br><a href="${inboxUrl}" style="color:#16A34A;word-break:break-all;">${inboxUrl}</a></p>
  <p style="font-size:13px;color:#6B7280;margin-top:20px;">Bookmark it — this link never expires.</p>
  <hr style="border:none;border-top:1px solid #E5E7EB;margin:28px 0;">
  <p style="font-size:12px;color:#9CA3AF;">LocalIntel Data Services &mdash; thelocalintel.com</p>
</div>`,
    });
    console.log(`[auth/magic] sent to ${biz.notification_email} — id: ${result.data?.id}, err: ${result.error?.message}`);
  } catch (err) {
    console.error('[auth/magic]', err.message);
    // Response already sent, just log
  }
});

// ── Merchant portal ───────────────────────────────────────────────────────────
// POST /api/local-intel/merchant/request-link
// GET  /api/local-intel/merchant/dashboard/:token
// (mounted under /api/local-intel; landing-side fetch hits /api/merchant/* via app-level alias below)

router.post('/merchant/request-link', express.json(), async (req, res) => {
  const { email, name, address, phone, zip, category } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });

  try {
    const db = require('./lib/db');
    const normEmail = String(email).toLowerCase().trim();

    let [business] = await db.query(
      'SELECT * FROM businesses WHERE merchant_email = $1 LIMIT 1',
      [normEmail]
    );

    if (!business) {
      if (!name || !zip) {
        return res.status(200).json({
          error: 'new_merchant',
          message: 'Business not found. Please provide name and zip to claim your listing.'
        });
      }
      const [inserted] = await db.query(
        `INSERT INTO businesses (name, phone, zip, category, merchant_email, claimed, status)
         VALUES ($1, $2, $3, $4, $5, true, 'active')
         RETURNING *`,
        [name, phone ?? null, zip, category ?? 'general', normEmail]
      );
      business = inserted;
    }

    const token = require('crypto').randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await db.query(
      `UPDATE businesses
         SET dashboard_token = $1, token_expires_at = $2, claimed = true
       WHERE business_id = $3`,
      [token, expires, business.business_id]
    );

    const dashboardUrl = `https://www.thelocalintel.com/inbox.html?token=${token}`;

    try {
      const { Resend } = require('resend');
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: 'LocalIntel <intel@thelocalintel.com>',
        to: normEmail,
        subject: 'Your LocalIntel merchant dashboard',
        html: `
          <div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
            <p style="font-size:15px;color:#111827;">Hi <strong>${(business.name || '').replace(/</g,'&lt;')}</strong>,</p>
            <p style="font-size:15px;color:#374151;">Here's your private merchant dashboard link:</p>
            <p style="margin:28px 0;">
              <a href="${dashboardUrl}" style="background:#16A34A;color:#fff;padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open My Dashboard &rarr;</a>
            </p>
            <p style="font-size:13px;color:#6B7280;">Or copy this link:<br><a href="${dashboardUrl}" style="color:#16A34A;word-break:break-all;">${dashboardUrl}</a></p>
            <p style="font-size:13px;color:#6B7280;margin-top:20px;">This link expires in 24 hours.</p>
            <hr style="border:none;border-top:1px solid #E5E7EB;margin:28px 0;">
            <p style="font-size:12px;color:#9CA3AF;">LocalIntel · thelocalintel.com</p>
          </div>`
      });
    } catch (emailErr) {
      console.error('[merchant] email send failed:', emailErr.message);
      // non-fatal — link is in response payload for dev
    }

    return res.json({
      success: true,
      message: `Dashboard link sent to ${normEmail}`,
      ...(process.env.NODE_ENV === 'production' ? {} : { dashboard_url: dashboardUrl })
    });
  } catch (err) {
    console.error('[merchant] request-link error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.get('/merchant/dashboard/:token', async (req, res) => {
  const { token } = req.params;
  if (!token) return res.status(400).json({ error: 'token required' });

  try {
    const db = require('./lib/db');
    // dispatch_token is permanent — no expiry check needed
    const [business] = await db.query(
      `SELECT * FROM businesses
        WHERE dispatch_token = $1
          AND status != 'inactive'
        LIMIT 1`,
      [token]
    );

    if (!business) {
      return res.status(401).json({
        error: 'invalid_or_expired',
        message: 'This link has expired. Request a new one at thelocalintel.com/claim'
      });
    }

    const [stats] = await db.query(
      `SELECT
         COUNT(*)                                                    AS total_routed,
         COUNT(*) FILTER (WHERE resolved = true)                     AS resolved_count,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS this_month
       FROM resolution_history
       WHERE business_id = $1`,
      [business.business_id]
    );

    const topQueries = await db.query(
      `SELECT query, COUNT(*) AS cnt
         FROM resolution_history
        WHERE business_id = $1
        GROUP BY query
        ORDER BY cnt DESC
        LIMIT 5`,
      [business.business_id]
    );

    const rfqStats = await db.query(
      `SELECT
         COUNT(*)                                  AS total_rfq,
         COUNT(*) FILTER (WHERE response = 'yes')  AS matched
         FROM rfq_responses_v2
        WHERE business_id = $1`,
      [business.business_id]
    );
    const [rfq] = rfqStats;

    // Surge menu status — try live fetch, non-blocking
    let surgeMenu = null;
    if (business.wallet) {
      try {
        const surge = require('./lib/surgeAgent');
        const menu  = await surge.fetchMenu(business.business_id);
        const items = menu.items || menu;
        if (Array.isArray(items)) {
          const orderable = items.filter(i => i.attributes?.onlineOrderingEnabled !== false);
          surgeMenu = {
            connected:      true,
            total_items:    items.length,
            orderable_items: orderable.length,
            categories:     [...new Set(items.map(i => i.category).filter(Boolean))],
          };
        }
      } catch (_) {
        surgeMenu = { connected: false };
      }
    }

    // Fetch wallet balance from agent_registry via dispatch_token
    let reg = null;
    if (business.dispatch_token) {
      const regRows = await db.query(
        `SELECT balance_usd_micro, deposit_address FROM agent_registry WHERE token = $1`,
        [business.dispatch_token]
      ).catch(() => []);
      reg = regRows[0] || null;
    }

    return res.json({
      business: {
        id:            business.business_id,
        name:          business.name,
        address:       business.address ?? null,
        zip:           business.zip,
        category:      business.category,
        category_group: business.category_group ?? null,
        wallet:        business.wallet ?? null,
        claimed:       business.claimed === true || business.claimed_at != null,
        services_json: business.services_json ?? null,
        services_text: business.services_text ?? null,
        menu_url:      business.menu_url ?? null,
        menu_fetch_error: business.menu_fetch_error ?? null,
        dispatch_token: business.dispatch_token ?? null,
        pos_type:      business.pos_config?.pos_type ?? null,
        legacy_order_url: business.menu_url ?? null,
      },
      stats: {
        total_routed: Number(stats?.total_routed ?? 0),
        resolved:     Number(stats?.resolved_count ?? 0),
        this_month:   Number(stats?.this_month ?? 0),
        rfq_sent:     Number(rfq?.total_rfq ?? 0),
        rfq_matched:  Number(rfq?.matched   ?? 0)
      },
      top_queries:     topQueries,
      wallet_connected: !!business.wallet,
      wallet_funded:   reg ? (reg.balance_usd_micro || 0) > 0 : false,
      balance_usd_micro: reg ? (reg.balance_usd_micro || 0) : 0,
      surge_menu:      surgeMenu,
    });
  } catch (err) {
    console.error('[merchant] dashboard error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── RFQ Inbox API ─────────────────────────────────────────────────────────────

/**
 * GET /api/local-intel/inbox?token=<dispatch_token>
 * Returns business info + open RFQs matching their zip+category.
 */
router.get('/inbox', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const rfqService = require('./lib/rfqService');
    // Look up by dispatch_token (set during claim flow or migration)
    const [biz] = await db.query(
      `SELECT business_id, name, address, zip, category, category_group,
              wallet, notification_email,
              notify_push, claimed_at,
              COALESCE(has_hours, false) AS has_hours,
              COALESCE(sunbiz_id, sunbiz_doc_number) AS sunbiz_id,
              hours_json, services_text, menu_url, menu_fetched_at, menu_fetch_error, services_json,
              CASE WHEN pos_config IS NOT NULL THEN (pos_config->>'pos_type') ELSE NULL END AS pos_type
         FROM businesses
        WHERE dispatch_token = $1
          AND status != 'inactive'
        LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    // Fetch wallet balance from agent_registry
    const pool = db.getPool ? db.getPool() : db;
    const { rows: [reg] } = await pool.query(
      `SELECT balance_usd_micro, deposit_address FROM agent_registry WHERE token = $1`,
      [token]
    ).catch(() => ({ rows: [null] }));

    const open_rfqs = await rfqService.getOpenRfqs(biz.zip, biz.category);

    // Stats + top queries (same as /merchant/dashboard — enables single-page dashboard)
    const [stats] = await db.query(
      `SELECT
         COUNT(*)                                                        AS total_routed,
         COUNT(*) FILTER (WHERE resolved = true)                         AS resolved_count,
         COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days') AS this_month
       FROM resolution_history
       WHERE business_id = $1`,
      [biz.business_id]
    );

    const topQueries = await db.query(
      `SELECT query, COUNT(*) AS cnt
         FROM resolution_history
        WHERE business_id = $1
        GROUP BY query
        ORDER BY cnt DESC
        LIMIT 5`,
      [biz.business_id]
    );

    const [rfqStat] = await db.query(
      `SELECT
         COUNT(*)                                  AS total_rfq,
         COUNT(*) FILTER (WHERE response = 'yes')  AS matched
         FROM rfq_responses_v2
        WHERE business_id = $1`,
      [biz.business_id]
    ).catch(() => [{ total_rfq: 0, matched: 0 }]);

    // Surge menu (non-blocking)
    let surgeMenu = null;
    if (biz.wallet) {
      try {
        const surge = require('./lib/surgeAgent');
        const menu  = await surge.fetchMenu(biz.business_id);
        const items = menu.items || menu;
        if (Array.isArray(items)) {
          const orderable = items.filter(i => i.attributes?.onlineOrderingEnabled !== false);
          surgeMenu = {
            connected:       true,
            total_items:     items.length,
            orderable_items: orderable.length,
            categories:      [...new Set(items.map(i => i.category).filter(Boolean))],
          };
        }
      } catch (_) {
        surgeMenu = { connected: false };
      }
    }

    // Fetch agent profile for mcp_endpoint, industry_type, notify_push, auto-probe tools
    const agentProfile = await db.queryOne(
      `SELECT mcp_endpoint, industry_type, notify_push FROM business_agent_profiles WHERE business_id = $1 LIMIT 1`,
      [biz.business_id]
    ).catch(() => null);
    let mcpTools = null;
    if (agentProfile?.mcp_endpoint) {
      const { probeEndpoint } = require('./lib/businessMcp');
      const probeResult = await probeEndpoint(agentProfile.mcp_endpoint).catch(() => null);
      // probeEndpoint returns { tools: [...] } or [...] — normalize to array
      if (Array.isArray(probeResult)) mcpTools = probeResult;
      else if (probeResult?.tools && Array.isArray(probeResult.tools)) mcpTools = probeResult.tools;
    }

    res.json({
      business_name:     biz.name,
      zip:               biz.zip,
      category:          biz.category,
      business_id:       biz.business_id,
      mcp_endpoint:      agentProfile ? (agentProfile.mcp_endpoint || null) : null,
      mcp_tools:         mcpTools,
      industry_type:     agentProfile ? (agentProfile.industry_type || null) : null,
      notify_push:       biz.notify_push || false,
      claimed_at:        biz.claimed_at || null,
      has_hours:         biz.has_hours  || false,
      sunbiz_id:         biz.sunbiz_id  || null,
      sunbiz_verified:   !!biz.sunbiz_id,
      balance_usd_micro: reg ? reg.balance_usd_micro : 0,
      wallet_funded:     reg ? (reg.balance_usd_micro || 0) > 0 : false,
      deposit_address:   reg ? reg.deposit_address : null,
      open_rfqs,
      hours_json:       biz.hours_json      || null,
      services_text:    biz.services_text   || null,
      menu_url:         biz.menu_url        || null,
      menu_fetched_at:  biz.menu_fetched_at || null,
      menu_fetch_error: biz.menu_fetch_error|| null,
      services_json:    biz.services_json   || null,
      pos_type:         biz.pos_type        || null,
      // Dashboard overview fields
      address:          biz.address          || null,
      wallet:           biz.wallet           || null,
      category_group:   biz.category_group   || null,
      claimed:          !!biz.claimed_at,
      legacy_order_url: biz.menu_url         || null,
      stats: {
        total_routed: Number(stats?.total_routed  ?? 0),
        resolved:     Number(stats?.resolved_count ?? 0),
        this_month:   Number(stats?.this_month     ?? 0),
        rfq_sent:     Number(rfqStat?.total_rfq    ?? 0),
        rfq_matched:  Number(rfqStat?.matched      ?? 0),
      },
      top_queries:  topQueries,
      surge_menu:   surgeMenu,
    });
  } catch (err) {
    console.error('[inbox GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/local-intel/inbox/respond
 * Body: { token, rfq_id, quote_usd, message, eta_minutes }
 */
router.post('/inbox/respond', express.json(), async (req, res) => {
  const { token, rfq_id, quote_usd, message, eta_minutes } = req.body || {};
  if (!token)  return res.status(401).json({ error: 'token required' });
  if (!rfq_id) return res.status(400).json({ error: 'rfq_id required' });
  try {
    const rfqService = require('./lib/rfqService');
    const [biz] = await db.query(
      `SELECT business_id, name FROM businesses
        WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    const result = await rfqService.submitResponse(
      rfq_id,
      biz.business_id,
      { quote_usd: quote_usd || null, message: message || null, eta_minutes: eta_minutes || null }
    );
    res.json(result);
  } catch (err) {
    console.error('[inbox/respond POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/local-intel/inbox/book
 * Body: { token, rfq_id, response_id }
 * For approve/human autonomy — human confirms a booking.
 */
router.post('/inbox/book', express.json(), async (req, res) => {
  const { token, rfq_id, response_id } = req.body || {};
  if (!token)      return res.status(401).json({ error: 'token required' });
  if (!rfq_id)     return res.status(400).json({ error: 'rfq_id required' });
  if (!response_id) return res.status(400).json({ error: 'response_id required' });
  try {
    const rfqService = require('./lib/rfqService');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses
        WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    const result = await rfqService.bookRfq(rfq_id, response_id, 'confirmed by human');
    res.json(result);
  } catch (err) {
    console.error('[inbox/book POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/rfq/submit — public job submission (quote.html) ──────
// Body: { description, category, zip, budget_usd, is_same_day, customer_phone,
//         customer_email, ref_tag, pickup_address }
// Returns: { rfq_id, magic_token, quote_url, bid_window_type, deadline_at,
//            matched_count, notified_count }
router.post('/rfq/submit', express.json(), async (req, res) => {
  try {
    const rfqService = require('./lib/rfqService');
    const {
      description, category, zip, budget_usd, is_same_day,
      customer_phone, customer_email, ref_tag, pickup_address,
    } = req.body || {};
    if (!description) return res.status(400).json({ error: 'description is required' });
    if (!zip)         return res.status(400).json({ error: 'zip is required' });
    const result = await rfqService.createRfq({
      job_type:       'proposal',
      category:       category || null,
      zip,
      description,
      pickup_address: pickup_address || null,
      budget_usd:     budget_usd     || null,
      is_same_day:    !!is_same_day,
      customer_phone: customer_phone || null,
      customer_email: customer_email || null,
      ref_tag:        ref_tag        || null,
      autonomy:       'human',
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[rfq/submit]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/rfq/status/:token — bid comparison data ──────────────
// Accepts UUID rfq_id OR magic_token. Used by rfq/[token].html page + agents.
router.get('/rfq/status/:token', async (req, res) => {
  try {
    const rfqService = require('./lib/rfqService');
    const data = await rfqService.getRfqStatus(req.params.token);
    if (data.error) return res.status(404).json(data);
    // Sanitise — never expose customer_phone/email to public poll
    const rfq = { ...data.rfq };
    delete rfq.customer_phone;
    delete rfq.customer_email;
    delete rfq.caller_key;
    delete rfq.notify_email;
    res.json({ ...data, rfq });
  } catch (err) {
    console.error('[rfq/status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/rfq/book — customer picks a bid ─────────────────────
// Body: { magic_token, response_id }
router.post('/rfq/book', express.json(), async (req, res) => {
  try {
    const rfqService = require('./lib/rfqService');
    const { magic_token, response_id } = req.body || {};
    if (!magic_token)  return res.status(400).json({ error: 'magic_token required' });
    if (!response_id)  return res.status(400).json({ error: 'response_id required' });
    // Resolve rfq_id from magic_token
    const status = await rfqService.getRfqStatus(magic_token);
    if (status.error || !status.rfq) return res.status(404).json({ error: 'RFQ not found' });
    if (status.rfq.status === 'booked') return res.status(409).json({ error: 'already booked' });
    const result = await rfqService.bookRfq(status.rfq.id, response_id, 'customer selection');
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[rfq/book]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/rfq-contact — attach email or phone to a job for async callback ──
// Body: { job_code, email?, phone? }
router.post('/rfq-contact', express.json(), async (req, res) => {
  try {
    const { job_code, email, phone } = req.body || {};
    if (!job_code) return res.status(400).json({ ok: false, error: 'job_code required' });
    if (!email && !phone) return res.status(400).json({ ok: false, error: 'email or phone required' });

    // Basic validation
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRe = /^[\d\s\(\)\-\+]{7,15}$/;
    if (email && !emailRe.test(email)) return res.status(400).json({ ok: false, error: 'invalid email' });
    if (phone && !phoneRe.test(phone)) return res.status(400).json({ ok: false, error: 'invalid phone' });

    // Upsert contact info onto the rfq_jobs row
    const rows = await db.query(
      `UPDATE rfq_jobs SET
         contact_email = COALESCE($1, contact_email),
         contact_phone = COALESCE($2, contact_phone),
         updated_at = NOW()
       WHERE code = $3
       RETURNING id, code, category, zip, contact_email, contact_phone`,
      [email || null, phone || null, job_code]
    );

    if (!rows.length) return res.status(404).json({ ok: false, error: 'Job not found' });

    console.log(`[rfq-contact] Job ${job_code} — contact saved (email=${!!email} phone=${!!phone})`);
    return res.json({
      ok: true,
      message: email
        ? `Got it — we’ll email you at ${email} when a provider responds.`
        : `Got it — we’ll text or call ${phone} when a provider responds.`,
      job_code,
    });
  } catch (err) {
    console.error('[rfq-contact]', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── GET /api/local-intel/surge/menu/:id — fetch live Surge menu (UUID or Sunbiz ID) ──
router.get('/surge/menu/:id', async (req, res) => {
  try {
    const db   = require('./lib/db');
    const id   = req.params.id;
    // Accept either internal UUID or Sunbiz ID
    const isUuid = /^[0-9a-f-]{36}$/.test(id);
    const [biz] = await db.query(
      isUuid
        ? `SELECT business_id FROM businesses WHERE business_id = $1 LIMIT 1`
        : `SELECT business_id FROM businesses WHERE sunbiz_id = $1 OR sunbiz_doc_number = $1 LIMIT 1`,
      [id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });
    const surge = require('./lib/surgeAgent');
    const menu  = await surge.fetchMenu(biz.business_id);
    res.json({ ok: true, business_id: biz.business_id, menu });
  } catch (err) {
    console.error('[surge/menu]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/surge/order — place order + send SMS payment link ──
router.post('/surge/order', express.json(), async (req, res) => {
  const { business_id, sunbiz_id, customer_phone, order_text, jurisdiction_code } = req.body || {};
  const lookupId = business_id || sunbiz_id;
  if (!lookupId)   return res.status(400).json({ error: 'business_id or sunbiz_id required' });
  if (!order_text) return res.status(400).json({ error: 'order_text required' });
  try {
    const db     = require('./lib/db');
    const isUuid = /^[0-9a-f-]{36}$/.test(lookupId);
    const [biz]  = await db.query(
      isUuid
        ? `SELECT business_id FROM businesses WHERE business_id = $1 LIMIT 1`
        : `SELECT business_id FROM businesses WHERE sunbiz_id = $1 OR sunbiz_doc_number = $1 LIMIT 1`,
      [lookupId]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });
    const surge  = require('./lib/surgeAgent');
    const result = await surge.placeOrderFromVoice({
      businessId:      biz.business_id,
      customerPhone:   customer_phone || null,
      orderText:       order_text,
      jurisdictionCode: jurisdiction_code || 'US-FL',
    });
    res.json(result);
  } catch (err) {
    console.error('[surge/order]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/surge/webhook — receive Surge payment status events ──
router.post('/surge/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const deliveryId = req.headers['x-basaltsurge-delivery'];
    const signature  = req.headers['x-basaltsurge-signature'];
    const rawBody    = req.body?.toString('utf8') || '';
    const payload    = JSON.parse(rawBody);
    const receiptId  = payload.receiptId || payload.id;
    const status     = payload.status;

    console.log(`[surge/webhook] delivery=${deliveryId} status=${status} receiptId=${receiptId}`);

    // TODO: look up order by receiptId, verify signature, update rfq_bookings, release escrow on paid
    // For now: log and acknowledge
    const db = require('./lib/db');
    await db.query(
      `INSERT INTO rfq_gaps (raw_text, source, created_at)
       VALUES ($1, 'surge_webhook', NOW())
       ON CONFLICT DO NOTHING`,
      [JSON.stringify({ receiptId, status, deliveryId })]
    ).catch(() => {});

    if (status === 'paid' || status === 'checkout_success') {
      console.log(`[surge/webhook] PAYMENT CONFIRMED for receipt ${receiptId}`);
      // TODO: release escrow, notify business, update booking status
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[surge/webhook]', err.message);
    res.status(200).json({ ok: true }); // always 200 to Surge
  }
});

// ── POST /api/local-intel/inbox/hours — save business hours ──────────────────
router.post('/inbox/hours', express.json(), async (req, res) => {
  const { token, hours } = req.body || {};
  if (!token) return res.status(401).json({ error: 'token required' });
  if (!hours || typeof hours !== 'object') return res.status(400).json({ error: 'hours object required' });
  try {
    const db = require('./lib/db');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    await db.query(
      `UPDATE businesses SET hours_json = $1, has_hours = true WHERE business_id = $2`,
      [JSON.stringify(hours), biz.business_id]
    );
    console.log(`[inbox/hours] saved for ${biz.business_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[inbox/hours POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/inbox/services — save services text + menu URL ───────
router.post('/inbox/services', express.json(), async (req, res) => {
  const { token, services_text, services_json, menu_url } = req.body || {};
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const db = require('./lib/db');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    // Build agent-readable description from services_json if provided
    let agentDescription = services_text || null;
    if (services_json && typeof services_json === 'object') {
      const sj = services_json;
      const parts = [];
      if (sj.what_we_do)     parts.push(sj.what_we_do);
      if (sj.specialties?.length) parts.push('Specialties: ' + sj.specialties.join(', ') + '.');
      if (sj.price_range)    parts.push('Pricing: ' + sj.price_range + '.');
      if (sj.service_area)   parts.push('Service area: ' + sj.service_area + '.');
      if (sj.response_time)  parts.push('Response time: ' + sj.response_time + '.');
      if (sj.availability)   parts.push('Available: ' + sj.availability + '.');
      if (parts.length) agentDescription = parts.join(' ');
    }

    await db.query(
      `UPDATE businesses SET
         services_text    = COALESCE($1, services_text),
         services_json    = COALESCE($2, services_json),
         menu_url         = COALESCE($3, menu_url),
         menu_fetched_at  = NULL
       WHERE business_id = $4`,
      [
        agentDescription || null,
        services_json ? JSON.stringify(services_json) : null,
        menu_url || null,
        biz.business_id
      ]
    );

    // If menu_url provided, trigger async fetch
    if (menu_url) {
      setImmediate(async () => {
        try {
          const menuFetch = require('./workers/menuFetchAgent');
          await menuFetch.fetchMenuForBusiness(biz.business_id, menu_url);
          console.log(`[inbox/services] menu fetch complete for ${biz.business_id}`);
        } catch (e) {
          console.warn('[inbox/services] menu fetch error:', e.message);
          const db2 = require('./lib/db');
          await db2.query(
            `UPDATE businesses SET menu_fetch_error = $1 WHERE business_id = $2`,
            [e.message.slice(0, 500), biz.business_id]
          ).catch(() => {});
        }
      });
    }
    console.log(`[inbox/services] saved services_json + text for ${biz.business_id}`);
    res.json({ ok: true, menu_fetch_queued: !!menu_url, agent_description: agentDescription });
  } catch (err) {
    console.error('[inbox/services POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/inbox/wallet — save wallet address ───────────────────
router.post('/inbox/wallet', express.json(), async (req, res) => {
  const { token, wallet } = req.body || {};
  if (!token)  return res.status(401).json({ error: 'token required' });
  if (!wallet) return res.status(400).json({ error: 'wallet address required' });
  // Basic EVM address validation
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet.trim())) {
    return res.status(400).json({ error: 'Invalid wallet address — must be 0x followed by 40 hex characters' });
  }
  try {
    const db = require('./lib/db');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    await db.query(
      `UPDATE businesses SET wallet = $1 WHERE business_id = $2`,
      [wallet.trim(), biz.business_id]
    );
    console.log(`[inbox/wallet] wallet saved for ${biz.business_id}`);
    res.json({ ok: true, wallet: wallet.trim() });
  } catch (err) {
    console.error('[inbox/wallet POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/inbox/pos — save POS credentials (AES-256 encrypted) ─
router.post('/inbox/pos', express.json(), async (req, res) => {
  const { token, pos_type, credentials } = req.body || {};
  if (!token)       return res.status(401).json({ error: 'token required' });
  if (!pos_type)    return res.status(400).json({ error: 'pos_type required (toast|square|clover|other)' });
  if (!credentials) return res.status(400).json({ error: 'credentials object required' });
  try {
    const db     = require('./lib/db');
    const crypto = require('crypto');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    // AES-256-GCM encrypt credentials
    const key = Buffer.from(
      (process.env.POS_ENCRYPT_KEY || 'localintel-pos-key-32-bytes-here!').padEnd(32).slice(0, 32)
    );
    const iv         = crypto.randomBytes(12);
    const cipher     = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted  = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    const authTag    = cipher.getAuthTag();
    const posConfig  = {
      pos_type,
      iv:      iv.toString('hex'),
      tag:     authTag.toString('hex'),
      data:    encrypted.toString('hex'),
      saved_at: new Date().toISOString()
    };

    await db.query(
      `UPDATE businesses SET pos_config = $1 WHERE business_id = $2`,
      [JSON.stringify(posConfig), biz.business_id]
    );
    console.log(`[inbox/pos] saved ${pos_type} credentials for ${biz.business_id}`);
    res.json({ ok: true, pos_type });
  } catch (err) {
    console.error('[inbox/pos POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/push/vapid-public-key — return VAPID public key for subscription ──
router.get('/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

// ── POST /api/local-intel/push/subscribe — save push subscription for a business ──
router.post('/push/subscribe', express.json(), async (req, res) => {
  const { token, subscription } = req.body || {};
  if (!token)        return res.status(401).json({ error: 'token required' });
  if (!subscription) return res.status(400).json({ error: 'subscription required' });
  try {
    const pool = db.getPool ? db.getPool() : db;
    // Ensure push_subscriptions table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id  TEXT NOT NULL,
        endpoint     TEXT NOT NULL UNIQUE,
        p256dh       TEXT,
        auth         TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `);
    // notify_push column added via migration 060
    // Look up business by dispatch_token
    const { rows: [biz] } = await pool.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    // Upsert subscription
    await pool.query(
      `INSERT INTO push_subscriptions (business_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET business_id = EXCLUDED.business_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             last_used_at = NOW()`,
      [biz.business_id, subscription.endpoint,
       subscription.keys?.p256dh || null, subscription.keys?.auth || null]
    );
    // Mark business as push-enabled
    await pool.query(
      `UPDATE businesses SET notify_push = true WHERE business_id = $1`,
      [biz.business_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/push/unsubscribe — remove push subscription ──
router.post('/push/unsubscribe', express.json(), async (req, res) => {
  const { token, endpoint } = req.body || {};
  if (!token || !endpoint) return res.status(400).json({ error: 'token and endpoint required' });
  try {
    const pool = db.getPool ? db.getPool() : db;
    const { rows: [biz] } = await pool.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 LIMIT 1`, [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND business_id = $2`,
      [endpoint, biz.business_id]);
    // Check if any subs remain
    const { rows } = await pool.query(
      `SELECT id FROM push_subscriptions WHERE business_id = $1 LIMIT 1`, [biz.business_id]
    );
    if (rows.length === 0) {
      await pool.query(`UPDATE businesses SET notify_push = false WHERE business_id = $1`, [biz.business_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── B7: Community slang (Tier 3 aliases) ─────────────────────────────────────
// POST /api/local-intel/slang — submit a community slang term
// Body: { term, businessName, creditedTo?, zip? } OR { query: "SLANG = BUSINESS", creditedTo?, zip? }
router.options('/slang', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
router.post('/slang', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { parseSlangSubmission } = require('./lib/slangParser');
    const submittedBy = req.body?.From || req.body?.from || req.body?.phone ||
      req.headers['x-session-id'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress || 'anonymous';

    let slangTerm, descriptionRaw;
    if (req.body?.query) {
      const parsed = parseSlangSubmission(req.body.query);
      if (!parsed) {
        return res.status(400).json({ ok: false, error: 'Use format: SLANG = DESCRIPTION' });
      }
      slangTerm = parsed.slangTerm;
      descriptionRaw = parsed.businessQuery;
    } else {
      slangTerm = (req.body?.term || '').trim();
      // support both legacy 'businessName' and new 'description' field
      descriptionRaw = (req.body?.description || req.body?.businessName || '').trim();
    }

    if (!slangTerm || !descriptionRaw) {
      return res.status(400).json({ ok: false, error: 'Both a slang term and a description are required.' });
    }

    const NEGATIVE_RE = /\b(shit|fuck|crap|ass|bitch|damn|hell|suck|stupid|awful|terrible|worst|hate|racist|sexist|slur)\b/i;
    const isNegative = NEGATIVE_RE.test(slangTerm);
    const creditedTo = (req.body?.creditedTo || '').trim() || null;

    // Try to match a business — but it's optional now.
    // Slang can describe neighborhoods, streets, landmarks, vibes, anything local.
    const { canonical, business_id: pinnedId } = await resolveBusinessAlias(descriptionRaw);
    const searchZips = req.body?.zip ? [req.body.zip] : TARGET_ZIPS;

    let business = null;
    if (pinnedId) {
      const rows = await db.query(
        `SELECT business_id, name FROM businesses WHERE business_id = $1 AND status != 'inactive' LIMIT 1`,
        [pinnedId]
      );
      business = rows[0] || null;
    }
    if (!business) {
      const rows = await db.query(
        `SELECT business_id, name FROM businesses
          WHERE zip = ANY($1::text[]) AND name ILIKE $2 AND status != 'inactive'
          ORDER BY confidence_score DESC LIMIT 1`,
        [searchZips, `%${canonical}%`]
      );
      business = rows[0] || null;
    }

    // Check for duplicate — match on term + (business_id if found, else description)
    const existing = business
      ? await db.query(
          `SELECT id, submitted_by, credited_to, votes FROM business_slang
            WHERE term_lower = lower(trim($1)) AND business_id = $2 LIMIT 1`,
          [slangTerm, business.business_id]
        )
      : await db.query(
          `SELECT id, submitted_by, credited_to, votes FROM business_slang
            WHERE term_lower = lower(trim($1)) AND business_id IS NULL
              AND lower(trim(description)) = lower(trim($2)) LIMIT 1`,
          [slangTerm, descriptionRaw]
        );

    if (existing.length) {
      const e = existing[0];
      const label = business ? business.name : descriptionRaw;
      const isOriginator = e.submitted_by === submittedBy;
      return res.json({
        ok: true,
        already_exists: true,
        message: isOriginator
          ? `You already submitted "${slangTerm}" for ${label}. You're immortalized.`
          : `"${slangTerm}" for ${label} was already submitted by ${e.credited_to || 'someone in the community'}. You can upvote it instead.`,
        votes: e.votes,
        credited_to: e.credited_to || null,
      });
    }

    if (business) {
      await db.query(
        `INSERT INTO business_slang (term, business_id, description, submitted_by, is_negative, credited_to)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [slangTerm, business.business_id, business.name, submittedBy, isNegative, creditedTo]
      );
    } else {
      // No business match — store as a free-form local knowledge entry
      await db.query(
        `INSERT INTO business_slang (term, business_id, description, submitted_by, is_negative, credited_to)
         VALUES ($1, NULL, $2, $3, $4, $5)`,
        [slangTerm, descriptionRaw, submittedBy, isNegative, creditedTo]
      );
    }

    const label = business ? business.name : descriptionRaw;
    const msg = isNegative
      ? `Thanks — "${slangTerm}" has been submitted for review. It will be visible once approved.`
      : `"${slangTerm}" = ${label} has been added! ${creditedTo ? `${creditedTo} gets` : 'You get'} credit for being first to immortalize it.`;

    return res.json({
      ok: true,
      message: msg,
      slang_term: slangTerm,
      description: label,
      business_id: business ? business.business_id : null,
      credited_to: creditedTo,
      is_negative: isNegative,
      pending_review: isNegative,
    });
  } catch (err) {
    console.error('[slang] POST /slang error:', err.message);
    return res.status(500).json({ ok: false, error: 'Slang submission failed', detail: err.message });
  }
});

// POST /api/local-intel/slang/vote — upvote a slang term (auto-verifies at 3 votes)
router.post('/slang/vote', express.json(), async (req, res) => {
  try {
    const { slangId, term, businessId } = req.body || {};
    const voter = req.body?.From || req.body?.phone ||
      req.headers['x-session-id'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress || 'anonymous';

    let rows;
    if (slangId) {
      rows = await db.query(
        `SELECT id, term, business_id, votes, verified, credited_to FROM business_slang WHERE id = $1 LIMIT 1`,
        [slangId]
      );
    } else if (term && businessId) {
      rows = await db.query(
        `SELECT id, term, business_id, votes, verified, credited_to FROM business_slang
          WHERE term_lower = lower(trim($1)) AND business_id = $2 LIMIT 1`,
        [term, businessId]
      );
    }
    if (!rows || !rows.length) {
      return res.status(404).json({ ok: false, error: 'Slang term not found' });
    }
    const entry = rows[0];

    await db.query(`UPDATE business_slang SET votes = votes + 1 WHERE id = $1`, [entry.id]);

    const newVotes = entry.votes + 1;
    if (newVotes >= 3 && !entry.verified) {
      await db.query(`UPDATE business_slang SET verified = TRUE WHERE id = $1`, [entry.id]);
    }

    return res.json({
      ok: true,
      votes: newVotes,
      verified: newVotes >= 3,
      voter,
      message: newVotes >= 3
        ? `"${entry.term}" is now officially in LocalIntel slang!`
        : `Vote counted. ${3 - newVotes} more vote${3 - newVotes !== 1 ? 's' : ''} to go live.`,
    });
  } catch (err) {
    console.error('[slang] POST /slang/vote error:', err.message);
    return res.status(500).json({ ok: false, error: 'Vote failed', detail: err.message });
  }
});

// GET /api/local-intel/slang?businessId=UUID|zip=XXXXX — fetch slang for a business or ZIP
router.get('/slang', async (req, res) => {
  try {
    const { businessId, zip } = req.query;
    if (!businessId && !zip) {
      return res.status(400).json({ ok: false, error: 'businessId or zip required' });
    }
    let rows;
    if (businessId) {
      rows = await db.query(
        `SELECT bs.id, bs.term, bs.votes, bs.verified, bs.credited_to, bs.submitted_at, b.name AS business_name
           FROM business_slang bs
           JOIN businesses b ON b.business_id = bs.business_id
          WHERE bs.business_id = $1 AND bs.is_negative = FALSE
          ORDER BY bs.votes DESC, bs.submitted_at ASC`,
        [businessId]
      );
    } else {
      rows = await db.query(
        `SELECT bs.id, bs.term, bs.votes, bs.verified, bs.credited_to, bs.submitted_at, b.name AS business_name
           FROM business_slang bs
           JOIN businesses b ON b.business_id = bs.business_id
          WHERE b.zip = $1 AND bs.is_negative = FALSE AND bs.verified = TRUE
          ORDER BY bs.votes DESC LIMIT 50`,
        [zip]
      );
    }
    return res.json({ ok: true, slang: rows });
  } catch (err) {
    console.error('[slang] GET /slang error:', err.message);
    return res.status(500).json({ ok: false, error: 'Slang fetch failed', detail: err.message });
  }
});

router.post('/ingest', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const body = JSON.stringify(req.body || {});
    const response = await fetch('http://localhost:3005/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'DataIngestWorker unavailable: ' + e.message });
  }
});

// ── GET /api/local-intel/ingest/log — proxy to DataIngestWorker log ────────────
router.get('/ingest/log', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3005/ingest/log');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'DataIngestWorker unavailable: ' + e.message });
  }
});

// ── Server-card at the MCP path — Smithery fetches .well-known relative to the URL given
// If URL given is /api/local-intel/mcp, they fetch /api/local-intel/.well-known/mcp/server-card.json
router.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({
    serverInfo: { name: 'LocalIntel by MCFLAMINGO', version: '1.1.0', description: 'Agentic business intelligence for St. Johns County FL (32081 + 32082). 18 MCP tools across 5 verticals. Composite NL query via local_intel_ask. Two payment rails: $0.01–$0.05/call USDC on Base (x402) or pathUSD on Tempo mainnet.' },
    authentication: {
      required: true,
      type: 'apiKey',
      header: 'X-LocalIntel-Key',
      description: 'Agent key from POST /api/local-intel/register. Fund wallet to unlock paid tools. Discovery calls (tools/list, initialize, ping, notifications/*) are free.',
      register: 'https://gsb-swarm-production.up.railway.app/api/local-intel/register',
    },
    tools: [
      { name: 'local_intel_ask',       description: 'BEST FIRST CALL. Composite NL query layer — ask any plain-English question about a ZIP and get a synthesized, sourced answer with confidence score. Routes internally to zone, oracle, search, bedrock, signal, tide, corridor, changes, and nearby. Single entry point for humans and LLMs.', inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string', description: 'Plain English question', examples: ['What restaurant categories are missing in 32082?', 'Investment signals for 32081', 'Healthcare provider gaps near A1A'] }, zip: { type: 'string', description: 'ZIP code — optional, extracted from question if present' } } } },
      { name: 'local_intel_context',   description: 'Full spatial context block for a ZIP or lat/lon. Returns anchor business, nearby businesses in distance rings, zone intelligence, and category breakdown.', inputSchema: { type: 'object', properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] }, lat: { type: 'number', description: 'Latitude' }, lon: { type: 'number', description: 'Longitude' } } } },
      { name: 'local_intel_search',    description: 'Search businesses by name, category, or semantic group (food, retail, health, finance, civic, services).', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'Business name, category, or group', examples: ['restaurants', 'dentist', 'coffee'] }, zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_nearby',    description: 'Find businesses within a radius of any lat/lon point, sorted by distance with compass bearing.', inputSchema: { type: 'object', required: ['lat', 'lon'], properties: { lat: { type: 'number', description: 'Center latitude' }, lon: { type: 'number', description: 'Center longitude' }, radius: { type: 'number', description: 'Radius in miles (default: 1)' } } } },
      { name: 'local_intel_zone',      description: 'Spending zone and demographic data for a ZIP: population, income, home value, rent, ownership rate, zone score.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_corridor',  description: 'Businesses along a named street corridor (e.g. A1A, Palm Valley Road).', inputSchema: { type: 'object', required: ['street'], properties: { street: { type: 'string', description: 'Street or corridor name', examples: ['A1A', 'Palm Valley Road'] }, zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_changes',   description: 'Recently added or owner-verified business listings. Detect new openings or data updates.', inputSchema: { type: 'object', properties: { zip: { type: 'string', description: 'Optional ZIP filter' }, days: { type: 'number', description: 'Look back N days (default: 30)' } } } },
      { name: 'local_intel_stats',     description: 'Dataset coverage stats: total businesses, confidence scores, query volume, revenue earned.', inputSchema: { type: 'object', properties: { zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_tide',      description: 'Tidal momentum reading for a ZIP — temperature 0-100, direction (surging/heating/stable/cooling/receding), seasonal context.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_signal',    description: 'Investment signal score 0-100 for a ZIP with band (strong_buy/accumulate/hold/reduce/avoid), top reasons, and avoid flags.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_bedrock',   description: 'Infrastructure momentum score from permits, road projects, flood zones, utility extensions. Predicts conditions 12-36 months ahead.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_for_agent', description: 'PREMIUM ($0.05). Declare agent_type and intent, receive pre-ranked top-10 signals from all 4 data layers personalized for your use case.', inputSchema: { type: 'object', required: ['agent_type', 'intent'], properties: { agent_type: { type: 'string', description: 'Agent role', examples: ['real_estate', 'restaurant', 'investor'] }, intent: { type: 'string', description: 'What the agent is trying to accomplish' }, zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_oracle',    description: 'Pre-baked economic oracle for a ZIP. Returns restaurant saturation, price-tier gap analysis, growth trajectory, and 3 pre-formed questions with answers. Time-series trend tracking across 6h cycles.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_realtor',   description: 'Real estate intelligence for a ZIP: demographics, commercial gaps, flood risk, infrastructure momentum, market signals. Trained on 100 realtor business prompts.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about real estate or demographics', examples: ['What is the average household income?', 'Are there commercial vacancies?'] }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_healthcare', description: 'Healthcare market intelligence: provider density, demographics, patient demand gaps, senior population signals.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about healthcare market' }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_retail',    description: 'Retail market intelligence: store categories, spending capture, consumer profile, undersupplied niches.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about retail market' }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_construction', description: 'Construction and home services intelligence: active permits, contractor density, population growth driving demand.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about construction market' }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_restaurant', description: 'Restaurant and food service market intelligence: saturation scores, price-tier gaps, capture rates, corridor analysis, tidal momentum. Trained on 100 restaurant prompts.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about restaurant market' }, zip: { type: 'string', description: 'ZIP code' } } } },
    ],
    resources: [],
    prompts: [
      { name: 'restaurant_viability', description: "Analyze whether a ZIP code can support another restaurant. Returns saturation status, demand capture rate, price-tier gaps, and a plain-English recommendation.", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32081, 32082)", "required": true}] },
      { name: 'investment_signal', description: "Get the investment signal score and growth trajectory for a ZIP. Returns composite score 0-100, band (strong_buy to avoid), top reasons, and infrastructure momentum.", arguments: [{"name": "zip", "description": "ZIP code to score (e.g. 32081, 32082)", "required": true}] },
      { name: 'missing_category', description: "Identify which business category or price tier is most undersupplied in a ZIP relative to its income and population. Returns top gap with supporting data.", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32081, 32082)", "required": true}] },
      { name: 're_demographic_profile', description: "[Real Estate] What is the demographic profile and income level of buyers in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_commercial_gaps', description: "[Real Estate] Are there commercial gaps that signal neighborhood appreciation potential?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_flood_risk', description: "[Real Estate] What is the flood zone risk percentage for this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_infrastructure', description: "[Real Estate] What infrastructure projects are active near this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_new_businesses', description: "[Real Estate] What businesses are opening or recently added in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_owner_occupancy', description: "[Real Estate] What is the owner-occupancy rate and home value median?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 're_undersupplied_retail', description: "[Real Estate] What upscale dining or retail is undersupplied in this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_investment_signal', description: "[Real Estate] What is the investment signal score for this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_a1a_corridor', description: "[Real Estate] What restaurants are on the A1A corridor?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_healthcare_access', description: "[Real Estate] What healthcare providers are accessible in this neighborhood?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_tidal_momentum', description: "[Real Estate] What is the tidal momentum direction for buyer activity in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_school_services', description: "[Real Estate] What school-related businesses or services are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_fb_saturation', description: "[Real Estate] What is the market saturation status for food and beverage?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_growth_trajectory', description: "[Real Estate] What growth trajectory is this ZIP on \u2014 growing, stable, or transitioning?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_contractors', description: "[Real Estate] What construction or remodeling contractors operate in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_income_32084', description: "[Real Estate] What is the household income and consumer profile for this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 're_business_count', description: "[Real Estate] How many businesses are in this ZIP and what categories dominate?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32086"}] },
      { name: 're_capture_rate', description: "[Real Estate] What is the capture rate for food spending in this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32092"}] },
      { name: 're_nearby_coords', description: "[Real Estate] What businesses are near latitude 30.189 longitude -81.38?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_opportunity_signals', description: "[Real Estate] What are the top market opportunity signals for a residential buyer?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'hc_dentists', description: "[Healthcare] What dentists operate in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_pharmacies', description: "[Healthcare] What pharmacies are accessible in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_physicians', description: "[Healthcare] How many physicians or clinics are in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_income', description: "[Healthcare] What is the median household income of patients in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_undersupplied', description: "[Healthcare] What healthcare services are undersupplied relative to population?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_senior_pop', description: "[Healthcare] What is the senior population percentage that drives home health demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_mental_health', description: "[Healthcare] What mental health or counseling services exist in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_wellness', description: "[Healthcare] What fitness or wellness businesses operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_nearby_3mi', description: "[Healthcare] What healthcare businesses are within 3 miles of Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_consumer_profile', description: "[Healthcare] What is the consumer profile \u2014 does it skew toward affluent established patients?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_optometrists', description: "[Healthcare] What optometrists or vision care providers are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'hc_physical_therapy', description: "[Healthcare] What physical therapy or rehab centers operate in St Johns County?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32092"}] },
      { name: 'hc_population_growth', description: "[Healthcare] What is the population growth trend that affects patient demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'hc_new_businesses', description: "[Healthcare] What are new healthcare businesses recently added to this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_urgent_care', description: "[Healthcare] What urgent care or walk-in clinics are in this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32086"}] },
      { name: 'rx_grocery', description: "[Retail] What grocery stores or supermarkets operate in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_undersupplied', description: "[Retail] What retail categories are undersupplied for the income level here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_consumer_profile', description: "[Retail] What is the consumer spending profile \u2014 affluent or budget-conscious?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_a1a_specialty', description: "[Retail] What specialty retail shops operate on A1A in Ponte Vedra?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_hardware', description: "[Retail] What hardware or home improvement stores are nearby?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_apparel', description: "[Retail] What clothing or apparel retailers serve this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_total_retail', description: "[Retail] How many retail businesses are in this ZIP total?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_pet_supply', description: "[Retail] What pet supply or pet service businesses exist here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_nocatee_convenience', description: "[Retail] What convenience stores operate in Nocatee?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'rx_capture_rate', description: "[Retail] What is the capture rate for retail spending in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_new_openings', description: "[Retail] What businesses have recently opened in this retail market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_wine_liquor', description: "[Retail] What wine or liquor stores operate in Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_florists', description: "[Retail] What florists or gift shops are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_hhi_tier', description: "[Retail] What is the household income that determines retail price tier demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_bookstores', description: "[Retail] What bookstores or stationery shops exist in St Johns County?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'cx_general_contractors', description: "[Construction] What general contractors operate in Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_roofing', description: "[Construction] What roofing companies serve this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_plumbing', description: "[Construction] What plumbing businesses are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_hvac', description: "[Construction] What HVAC or air conditioning companies operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_electricians', description: "[Construction] What electricians serve Nocatee and surrounding ZIPs?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'cx_landscaping', description: "[Construction] What landscaping companies operate in St Johns County?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_infrastructure_score', description: "[Construction] What is the infrastructure momentum score \u2014 are there active permits?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_active_projects', description: "[Construction] What new construction or development projects are active in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_pool_builders', description: "[Construction] What pool builders or outdoor construction companies are nearby?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_population_growth', description: "[Construction] What is the population growth rate that drives construction demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'cx_painters', description: "[Construction] What painting or interior finishing contractors operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_flooring', description: "[Construction] What flooring or tile companies serve this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_home_inspection', description: "[Construction] What home inspection services are available in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_windows_doors', description: "[Construction] What window or door replacement companies serve this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'cx_pest_control', description: "[Construction] What pest control or remediation businesses operate in 32086?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32086"}] },
      { name: 'fb_pvb_restaurants', description: "[Restaurant] What restaurants are in Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_upscale_gap', description: "[Restaurant] Is the upscale dining market undersupplied in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_saturation', description: "[Restaurant] What is the restaurant saturation status \u2014 room for more or oversupplied?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_fast_casual_nocatee', description: "[Restaurant] What fast casual restaurants operate in Nocatee?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'fb_capture_rate', description: "[Restaurant] What is the food and beverage capture rate for this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_fine_dining', description: "[Restaurant] What fine dining options exist in 32082?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_bars_nightlife', description: "[Restaurant] What bars or nightlife venues operate in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_breakfast_brunch', description: "[Restaurant] What breakfast or brunch spots are in Ponte Vedra?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_a1a_corridor', description: "[Restaurant] How many restaurants are on the A1A corridor?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_meal_demand', description: "[Restaurant] What is the estimated daily meal demand vs. current capacity?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_coffee_cafes', description: "[Restaurant] What coffee shops or cafes serve this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_food_trucks', description: "[Restaurant] What food trucks or pop-up food businesses operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_hhi_tier', description: "[Restaurant] What is the median household income that determines restaurant price tier demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_sushi_st_aug', description: "[Restaurant] What sushi or Asian cuisine restaurants are in St Augustine?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'fb_tidal_momentum', description: "[Restaurant] What is the tidal momentum for food and beverage investment in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
    ],
    configSchema: { type: 'object', properties: {}, required: [] },
  });
});

// ── GET /api/local-intel/mcp — Smithery/scanner discovery ──────────────────
// Streamable HTTP spec: GET returns server info so scanners don't fall through
// to the static HTML handler.
router.get('/mcp', async (req, res) => {
  try {
    // Forward to internal MCP server for tools/list so Smithery sees real tools
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const data = await response.json();
    // Return as MCP initialize shape with embedded tools for discovery
    res.json({
      jsonrpc: '2.0',
      id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'localintel', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: data?.result?.tools || [],
      },
    });
  } catch (e) {
    res.json({
      jsonrpc: '2.0',
      id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'localintel', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
  }
});

// ── Caller source detection ───────────────────────────────────────────────────
function detectSource(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const xc = (req.headers['x-caller'] || req.headers['x-agent-id'] || '').toLowerCase();
  if (xc) return xc;
  if (ua.includes('smithery'))   return 'smithery';
  if (ua.includes('claude'))     return 'claude';
  if (ua.includes('cursor'))     return 'cursor';
  if (ua.includes('copilot'))    return 'copilot';
  if (ua.includes('openai') || ua.includes('gpt')) return 'openai';
  if (ua.includes('perplexity')) return 'perplexity';
  if (ua.includes('python'))     return 'python-client';
  if (ua.includes('node') || ua.includes('undici')) return 'node-client';
  if (ua.includes('postman'))    return 'postman';
  if (ua)                        return ua.split('/')[0].slice(0, 32);
  return 'unknown';
}

// ── POST /api/mcp — proxy to MCP server on port 3004 ───────────────────────
// This is the public MCP endpoint agents call from outside Railway.
// Full URL: https://gsb-swarm-production.up.railway.app/api/mcp
// Payment: X-LocalIntel-Key required. pathUSD (Tempo) or USDC (Base). Free: tools/list, notifications.
router.post('/mcp', express.json(), harvestGuard, apiKeyMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    // MCP notifications have no "id" — return 204 immediately, never proxy
    // (Smithery + other clients send notifications/initialized before tools/list)
    if (body.method && body.method.startsWith('notifications/') && body.id === undefined) {
      return res.status(204).end();
    }
    // Inject caller source into params so MCP server can log it
    if (body.method === 'tools/call' && body.params) {
      body.params._caller = detectSource(req);
      body.params._entry  = 'free';
      const _intent = {
        source: 'mcp',
        actor: {
          type: 'agent',
          phone: null,
          email: null,
          agent_key: req.headers['x-localintel-key'] || null,
          session_id: null,
          call_sid: null,
        },
        raw_input: body.params.arguments?.query || body.params.arguments?.prompt || '',
        command: {
          family: 'local_intel',
          name: (
            body.params.name === 'local_intel_nearby' ? 'nearby' :
            body.params.name === 'local_intel_ask'    ? 'ask'    :
            body.params.name === 'local_intel_oracle' ? 'oracle' :
            body.params.name === 'local_intel_rfq'    ? 'service_request' :
            'query'
          ),
          stage: null,
        },
        task: {
          category:      body.params.arguments?.category     || null,
          business_id:   null,
          business_name: null,
          zip:           body.params.arguments?.zip          || null,
          city:          null,
          lat:           null,
          lon:           null,
          radius_miles:  body.params.arguments?.radius_miles || null,
          description:   body.params.arguments?.query || body.params.arguments?.prompt || null,
          items: [],
          constraints: { budget: null, eta_minutes: null, time_window: null },
        },
        routing: {
          destination: (
            body.params.name === 'local_intel_rfq'    ? 'rfq_broadcast'   :
            body.params.name === 'local_intel_nearby' ? 'business_search' :
            'answer'
          ),
          pos_type: null, confidence: null, fallback_reason: null,
        },
        delivery: { channel: 'json', reply_expected: false },
      };
      console.log('[mcp] intent', JSON.stringify(_intent));
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = await response.json();
    // B64: enrich oracle/signal/sector_gap responses with site_intelligence scoring
    if (body.method === 'tools/call'
        && ['local_intel_oracle','local_intel_signal','local_intel_sector_gap'].includes(body.params?.name)) {
      data = await enrichMcpResponseWithScore(data, body.params.name, body.params.arguments || {});
    }
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP server unavailable: ' + e.message } });
  }
});

// ── x402 whitelist — agents in WHITELIST_USER_AGENTS bypass the payment gate ──
// Set Railway env var: WHITELIST_USER_AGENTS=lovable,smithery  (comma-separated, case-insensitive)
// Clear or remove the var to re-enable billing for all agents without a deploy.
const _x402Whitelist = (process.env.WHITELIST_USER_AGENTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isX402Whitelisted(req) {
  if (_x402Whitelist.length === 0) return false;
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const match = _x402Whitelist.find(agent => ua.includes(agent));
  if (match) console.log(`[x402] whitelisted bypass for agent: ${match}`);
  return !!match;
}

// ── x402 MCP endpoints — Base/USDC payment rail (additive alongside pathUSD) ──
// Standard: $0.01 USDC on Base  |  Premium (local_intel_for_agent): $0.05 USDC
// Agents without Base wallets continue using /api/local-intel/mcp (Tempo/pathUSD)
// x402Middleware is scoped ONLY to these two routes — does NOT touch /mcp
router.post('/mcp/x402', express.json(), async (req, res, next) => {
  if (isX402Whitelisted(req)) return next();
  x402Middleware(req, res, next);
}, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.method && body.method.startsWith('notifications/') && body.id === undefined) {
      return res.status(204).end();
    }
    if (body.method === 'tools/call' && body.params) {
      body.params._caller = detectSource(req);
      body.params._entry  = 'x402';
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data = await response.json();
    // B64: enrich oracle/signal/sector_gap responses with site_intelligence scoring
    if (body.method === 'tools/call'
        && ['local_intel_oracle','local_intel_signal','local_intel_sector_gap'].includes(body.params?.name)) {
      data = await enrichMcpResponseWithScore(data, body.params.name, body.params.arguments || {});
    }
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP unavailable: ' + e.message } });
  }
});

router.post('/mcp/x402/premium', express.json(), async (req, res, next) => {
  if (isX402Whitelisted(req)) return next();
  x402Middleware(req, res, next);
}, async (req, res) => {
  try {
    const body = req.body || {};
    // Force premium tool so agents can't use the $0.05 endpoint for cheap calls
    if (body.method === 'tools/call' && body.params?.name !== 'local_intel_for_agent') {
      return res.status(400).json({ jsonrpc: '2.0', id: body.id || null, error: { code: -32600, message: 'Premium endpoint is for local_intel_for_agent only' } });
    }
    if (body.method === 'tools/call' && body.params) {
      body.params._caller = detectSource(req);
      body.params._entry  = 'x402-premium';
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP unavailable: ' + e.message } });
  }
});

// ── GET /api/mcp/manifest — MCP tool discovery ────────────────────────────────
router.get('/mcp/manifest', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3004/manifest');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'MCP server unavailable' });
  }
});

// ── GET /api/local-intel/osm-queue — proxy to worker ─────────────────────────
router.get('/osm-queue', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3003/osm-queue');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Local Intel Worker unavailable: ' + e.message });
  }
});

// ── GET /api/local-intel/stats — coverage stats (Florida only) ──────────────
router.get('/stats', async (req, res) => {
  // Active states only — controlled by ACTIVE_STATES env var (default: FL)
  const { isActiveZip, coverageSummary } = require('./lib/stateConfig');
  try {
    // Group counts directly from Postgres — never .rows, db.query returns array.
    const zipRows = await db.query(
      `SELECT zip, COUNT(*)::int AS count, AVG(confidence_score)::float AS avg_conf
         FROM businesses
        WHERE status != 'inactive' AND zip IS NOT NULL
        GROUP BY zip`
    );
    const groupRows = await db.query(
      `SELECT COALESCE(category_group, 'other') AS grp, COUNT(*)::int AS count
         FROM businesses
        WHERE status != 'inactive'
        GROUP BY 1`
    );

    const byZip = {};
    let total = 0, confSum = 0, confCount = 0;
    for (const r of zipRows) {
      if (!isActiveZip(r.zip)) continue;
      byZip[r.zip] = r.count;
      total += r.count;
      if (r.avg_conf !== null && r.avg_conf !== undefined) {
        confSum += r.avg_conf * r.count;
        confCount += r.count;
      }
    }
    const byGroup = {};
    for (const r of groupRows) byGroup[r.grp] = r.count;

    // Confidence is stored 0..1 in Postgres; legacy JSON returned 0..100 — keep that shape.
    const avgConfRaw = confCount ? confSum / confCount : 0;
    const avgConf = avgConfRaw <= 1 ? Math.round(avgConfRaw * 100) : Math.round(avgConfRaw);

    res.json({
      ok: true,
      totalBusinesses: total,
      avgConfidence:   avgConf,
      coverage:        coverageSummary(),
      byZip,
      byGroup,
      sources: ['OSM','Census ACS 2022','FL Sunbiz'],
      pendingSources: ['SJC BTR','SJC Permits'],
      lastSync: new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    console.error('[stats] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/local-intel/agent-card ────────────────────────────────────────────────
const AGENT_CARD = {
  schema_version: 'v1',
  name: 'LocalIntel Data Services',
  description: 'Hyperlocal business intelligence for AI agents. ZIP-level business data covering Florida and expanding across the Sunbelt. Phone, hours, foot traffic proxy, categories, confidence scores. Pay-per-query via pathUSD.',
  url: 'https://gsb-swarm-production.up.railway.app',
  mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  a2a_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  skills: ['nearby_businesses', 'corridor_data', 'zip_stats', 'zone_context', 'business_search', 'change_detection'],
  pricing: { per_call: '$0.01-0.05', currency: 'pathUSD', subscription: '$49-499/month' },
  coverage: { current: 'Florida SJC zips + expanding', target: 'Florida 983 zips, then full Sunbelt' },
  contact: 'localintel@mcflamingo.com',
  provider: 'LocalIntel Data Services / MCFL Restaurant Holdings LLC',
};

router.get('/agent-card', (req, res) => {
  res.json(AGENT_CARD);
});

// ── GET /api/local-intel/revenue-summary ──────────────────────────────────────────────
router.get('/revenue-summary', (req, res) => {
  let ledger = [];
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
  } catch (e) {
    // Return zeros on parse error
  }

  const now = Date.now();
  const startOfToday   = new Date(); startOfToday.setUTCHours(0,0,0,0);
  const sevenDaysAgo   = now - 7  * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo  = now - 30 * 24 * 60 * 60 * 1000;

  function summarise(entries) {
    return {
      calls: entries.length,
      revenue_pathusd: parseFloat(entries.reduce((s, e) => s + (e.amount || 0), 0).toFixed(6)),
    };
  }

  const todayEntries  = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= startOfToday.getTime());
  const weekEntries   = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const monthEntries  = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= thirtyDaysAgo);

  // Top tools
  const toolMap = {};
  for (const e of ledger) {
    const key = e.tool || 'unknown';
    if (!toolMap[key]) toolMap[key] = { tool: key, calls: 0, revenue: 0 };
    toolMap[key].calls += 1;
    toolMap[key].revenue += (e.amount || 0);
  }
  const topTools = Object.values(toolMap)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(t => ({ ...t, revenue: parseFloat(t.revenue.toFixed(6)) }));

  // Top callers
  const callerMap = {};
  for (const e of ledger) {
    const key = e.caller || 'unknown';
    if (!callerMap[key]) callerMap[key] = { caller: key, calls: 0, revenue: 0 };
    callerMap[key].calls += 1;
    callerMap[key].revenue += (e.amount || 0);
  }
  const topCallers = Object.values(callerMap)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(c => ({ ...c, revenue: parseFloat(c.revenue.toFixed(6)) }));

  // Last call
  const sorted = [...ledger].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const lastCall = sorted.length ? sorted[0].timestamp : null;

  res.json({
    today:      summarise(todayEntries),
    week:       summarise(weekEntries),
    month:      summarise(monthEntries),
    allTime:    summarise(ledger),
    topTools,
    topCallers,
    lastCall,
    generatedAt: new Date().toISOString(),
  });
});

// ── Dashboard data proxy routes ──────────────────────────────────────────────
// These aggregate data files so the Vercel dashboard can poll one origin.

// ── GET /api/local-intel/call-log — last N calls with full trace ───────────────
router.get('/call-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  try {
    // Auto-create per spec — no-op if existing usage_ledger has the legacy shape.
    await db.query(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(),
        tool TEXT, caller TEXT, entry TEXT, zip TEXT, intent TEXT,
        latency INTEGER, cost NUMERIC, paid BOOLEAN DEFAULT false
      )
    `);

    // Detect schema (existing schema may use called_at/tool_name/cost_path_usd).
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_ledger'`
    );
    const have = new Set(cols.map(c => c.column_name));
    const tsCol     = have.has('ts')          ? 'ts'          : (have.has('called_at')     ? 'called_at'     : null);
    const toolCol   = have.has('tool')        ? 'tool'        : (have.has('tool_name')     ? 'tool_name'     : null);
    const costCol   = have.has('cost')        ? 'cost'        : (have.has('cost_path_usd') ? 'cost_path_usd' : null);
    const callerCol = have.has('caller')      ? 'caller'      : (have.has('agent_token')   ? 'agent_token'   : null);
    const latCol    = have.has('latency')     ? 'latency'     : (have.has('response_ms')   ? 'response_ms'   : null);
    const orderCol  = tsCol || 'id';

    const sql = `SELECT
      ${tsCol     ? tsCol     + ' AS ts'      : 'NULL AS ts'},
      ${toolCol   ? toolCol   + ' AS tool'    : "'unknown' AS tool"},
      ${callerCol ? callerCol + ' AS caller'  : "'unknown' AS caller"},
      ${have.has('entry')    ? 'entry'    : "'free' AS entry"},
      ${have.has('zip')      ? 'zip'      : 'NULL AS zip'},
      ${have.has('intent')   ? 'intent'   : 'NULL AS intent'},
      ${latCol    ? latCol    + ' AS latency' : 'NULL AS latency'},
      ${costCol   ? costCol   + ' AS cost'    : '0 AS cost'},
      ${have.has('paid')     ? 'paid'     : 'false AS paid'}
      FROM usage_ledger ORDER BY ${orderCol} DESC LIMIT $1`;
    const rows = await db.query(sql, [limit]);

    const calls = rows.map(e => ({
      ts:      e.ts ? new Date(e.ts).toISOString() : null,
      tool:    e.tool    || 'unknown',
      caller:  e.caller  || 'unknown',
      entry:   e.entry   || 'free',
      zip:     e.zip     || null,
      intent:  e.intent  || null,
      latency: e.latency || null,
      cost:    Number(e.cost) || 0,
      paid:    !!e.paid,
    }));

    res.json({ count: calls.length, calls, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[call-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const DATA_DIR_AGENT = path.join(__dirname, 'data');

router.get('/coverage-stats', async (req, res) => {
  try {
    const { isActiveZip: isActiveZip2 } = require('./lib/stateConfig');

    const rows = await db.query(`
      SELECT zip, COUNT(*)::int AS businesses,
             AVG(confidence_score)::float AS conf,
             MAX(created_at) AS completed_at
        FROM businesses
       WHERE status != 'inactive' AND zip IS NOT NULL
       GROUP BY zip ORDER BY zip
    `);

    let totalBusinesses = 0, confSum = 0, confCount = 0;
    const completedZips = [];
    for (const r of rows) {
      if (!isActiveZip2(r.zip)) continue;
      // Persist confidence as 0..100 in the response (legacy shape).
      const confPct = r.conf == null ? 0 : (r.conf <= 1 ? r.conf * 100 : r.conf);
      completedZips.push({
        zip: r.zip,
        businesses: r.businesses,
        confidence: Math.round(confPct),
        completedAt: r.completed_at,
        source: 'businesses',
      });
      totalBusinesses += r.businesses;
      confSum += confPct * r.businesses;
      confCount += r.businesses;
    }

    // Queue progress comes from zip_queue if available.
    let inProgress = 0, pending = 0, failed = 0, queueTotal = 0;
    try {
      const queueRows = await db.query(
        `SELECT status, COUNT(*)::int AS n FROM zip_queue GROUP BY status`
      );
      for (const q of queueRows) {
        queueTotal += q.n;
        if (q.status === 'inProgress' || q.status === 'in_progress') inProgress = q.n;
        else if (q.status === 'pending') pending = q.n;
        else if (q.status === 'failed') failed = q.n;
      }
    } catch (_) {}

    const queueTotalDynamic = queueTotal > 0 ? queueTotal : 1013;

    const recentZips = [...completedZips]
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
      .slice(0, 20);

    let lastRun = null;
    try {
      const lr = await db.query(`SELECT MAX(updated_at) AS t FROM businesses`);
      lastRun = lr[0]?.t ? new Date(lr[0].t).toISOString() : null;
    } catch (_) {}

    res.json({
      zipsCompleted:    completedZips.length,
      zipsTotal:        queueTotalDynamic,
      totalBusinesses,
      avgConfidence:    confCount ? Math.round(confSum / confCount) : 0,
      activeAgents:     inProgress,
      pendingZips:      pending,
      failedZips:       failed,
      recentZips,
      lastRun,
      generatedAt:      new Date().toISOString(),
    });
  } catch(e) {
    console.error('[coverage-stats] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/source-log', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT worker_name AS source, event_type, error_message, meta, created_at AS timestamp
         FROM worker_events ORDER BY created_at DESC LIMIT 200`
    );
    // Latest status per source — derive status from event_type + error_message
    const sources = {};
    for (const r of rows) {
      const cur = sources[r.source];
      if (!cur || new Date(r.timestamp) > new Date(cur.checked_at)) {
        const status = r.error_message
          ? 'error'
          : (r.event_type === 'complete' || r.event_type === 'done' || r.event_type === 'success')
            ? 'ok'
            : 'unavailable';
        sources[r.source] = {
          checked_at: r.timestamp,
          event_type: r.event_type,
          status,
          meta: r.meta,
        };
      }
    }
    res.json({ sources, raw: rows, generatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('[source-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/enrichment-log', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT worker_name, event_type, meta, output_summary, created_at
         FROM worker_events
        WHERE worker_name = 'enrichmentAgent'
        ORDER BY created_at DESC LIMIT 100`
    );
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const enrichedToday = rows.filter(e => e.created_at && new Date(e.created_at) >= today).length;
    const recent = rows.slice(0, 20).map(r => ({
      worker_name:   r.worker_name,
      event_type:    r.event_type,
      business_name: r.meta?.business_name || r.output_summary || '',
      zip:           r.meta?.zip || '',
      confidence:    r.meta?.confidence || 0,
      sources_used:  r.meta?.sources || [],
      enrichedAt:    r.created_at,
    }));
    res.json({ enrichedToday, recent, total: rows.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('[enrichment-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/broadcast-log', async (req, res) => {
  try {
    // Auto-create — safe, no-op if already there.
    await db.query(`
      CREATE TABLE IF NOT EXISTS acp_broadcast_log (
        id SERIAL PRIMARY KEY, zip TEXT, registry TEXT, status TEXT,
        business_count INTEGER, message TEXT,
        broadcast_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const rows = await db.query(
      `SELECT id, zip, registry, status, business_count, message, broadcast_at
         FROM acp_broadcast_log ORDER BY broadcast_at DESC LIMIT 50`
    );
    const recent = rows.slice(0, 10).map(r => ({
      ...r,
      timestamp: r.broadcast_at,
    }));
    const lastByRegistry = {};
    for (const r of rows) {
      const ok = (r.status || '').includes('reachable') || r.status === 'ok' || r.status === 'cycle_complete';
      if (ok) {
        if (!lastByRegistry[r.registry] || new Date(r.broadcast_at) > new Date(lastByRegistry[r.registry])) {
          lastByRegistry[r.registry] = r.broadcast_at;
        }
      }
    }
    res.json({ recent, lastByRegistry, total: rows.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('[broadcast-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/mcp-probe-log', async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS mcp_probe_log (
        id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(),
        persona TEXT, tool TEXT, zip TEXT, score INTEGER, reason TEXT, error TEXT
      )
    `);
    const log = await db.query(
      `SELECT ts, persona, tool, zip, score, reason, error
         FROM mcp_probe_log ORDER BY ts DESC LIMIT 500`
    );
    const byPersona = {};
    for (const e of log) {
      if (!byPersona[e.persona]) byPersona[e.persona] = { total: 0, totalScore: 0, errors: 0, noData: 0 };
      byPersona[e.persona].total++;
      byPersona[e.persona].totalScore += (e.score || 0);
      if (e.error) byPersona[e.persona].errors++;
      if (e.reason === 'no_data' || e.reason === 'empty_response') byPersona[e.persona].noData++;
    }
    const summary = Object.entries(byPersona).map(([persona, s]) => ({
      persona,
      queries:   s.total,
      avg_score: s.total ? Math.round(s.totalScore / s.total) : 0,
      errors:    s.errors,
      no_data:   s.noData,
    }));
    const recent = [...log].sort((a,b) => new Date(b.ts) - new Date(a.ts)).slice(0, 50);
    res.json({ summary, recent, total: log.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/brief/:zip', async (req, res) => {
  try {
    const zip  = (req.params.zip || '').replace(/\D/g, '').slice(0, 5);
    const row  = await pgStore.getZipBrief(zip);
    if (!row) return res.status(404).json({ error: `No brief for ZIP ${zip} yet — check back after next brief worker cycle` });
    logUsage(getCallerId(req), 'brief', zip, 1);
    res.json(row.brief_json || row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/briefs', async (req, res) => {
  try {
    const rows = await pgStore.getAllZipBriefs ? await pgStore.getAllZipBriefs() :
      await db.query('SELECT zip, brief_json, generated_at FROM zip_briefs ORDER BY zip');
    const summaries = rows.map(r => {
      const b = r.brief_json || r;
      return { zip: b.zip || r.zip, label: b.label, total: b.total, data_grade: b.data_grade, generated_at: r.generated_at || b.generated_at };
    }).filter(Boolean).sort((a,b) => (b.total||0)-(a.total||0));
    res.json({ count: summaries.length, zips: summaries });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/router-learning', async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS router_learning_log (
        id SERIAL PRIMARY KEY, run_at TIMESTAMPTZ DEFAULT NOW(),
        new_terms JSONB, failing_queries JSONB,
        improvement_rate NUMERIC, patch_summary TEXT
      )
    `);
    const runs = await db.query(
      `SELECT id, run_at, new_terms, failing_queries, improvement_rate, patch_summary
         FROM router_learning_log ORDER BY run_at DESC LIMIT 50`
    );
    if (runs.length === 0) {
      return res.json({ status: 'no_data_yet', message: 'Router learning worker has not run a cycle yet — check back in 35 minutes' });
    }
    const lastRun = runs[0];
    const recentPatches = runs.slice(0, 20).flatMap(r =>
      Array.isArray(r.new_terms) ? r.new_terms.map(p => ({ ts: r.run_at, ...p })) : []
    );
    const scoreTrend = runs.slice(0, 10).map(r => ({ ts: r.run_at, improvement_rate: r.improvement_rate }));
    res.json({
      total_patches_applied: recentPatches.reduce((s, p) => s + (p.terms?.length || 0), 0),
      last_run:              lastRun,
      recent_patches:        recentPatches,
      score_trend:           scoreTrend,
      verticals:             null,
      generatedAt:           new Date().toISOString(),
    });
  } catch(e) {
    console.error('[router-learning] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/router-learning/report ──────────────────────────────
// Structured patch history: score_before, score_after, delta per vertical per run.
// Query params:
//   ?vertical=restaurant   — filter to one vertical
//   ?limit=N               — last N patches (default 50)
//   ?runs=1                — include run-level summary alongside patches
router.get('/router-learning/report', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'router_learning.json');
    if (!fs.existsSync(file)) {
      return res.json({
        status:  'no_data_yet',
        message: 'Router learning worker has not run yet — check back in ~35 minutes',
      });
    }

    const data     = JSON.parse(fs.readFileSync(file));
    const limit    = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const vertical = req.query.vertical || null;
    const includeRuns = req.query.runs === '1';

    // ── Patch history ─────────────────────────────────────────────────────────
    let patches = (data.patches || []).slice(-limit);
    if (vertical) patches = patches.filter(p => p.vertical === vertical);

    // Enrich each patch with a human-readable summary line
    const patchRows = patches.map(p => ({
      ts:           p.ts,
      cycle:        p.cycle,
      vertical:     p.vertical,
      terms_added:  p.terms || [],
      score_before: p.score_before ?? null,
      score_after:  p.score_after  ?? null,
      delta:        p.delta        ?? null,
      improved:     typeof p.delta === 'number' ? p.delta > 0 : null,
      confirmations: (p.confirmations || []).map(c => ({
        query:        c.query,
        zip:          c.zip,
        score_before: c.score_before,
        score_after:  c.score_after,
        delta:        c.delta,
      })),
    }));

    // ── Per-vertical aggregate ─────────────────────────────────────────────────
    const VERTICALS = ['restaurant','healthcare','retail','construction','realtor'];
    const verticalSummary = {};
    for (const v of VERTICALS) {
      const vPatches = (data.patches || []).filter(p => p.vertical === v);
      const withDelta = vPatches.filter(p => typeof p.delta === 'number');
      const avgBefore = withDelta.length
        ? Math.round(withDelta.reduce((s, p) => s + p.score_before, 0) / withDelta.length)
        : null;
      const avgAfter = withDelta.length
        ? Math.round(withDelta.reduce((s, p) => s + p.score_after, 0) / withDelta.length)
        : null;
      const totalImproved = withDelta.filter(p => p.delta > 0).length;
      const totalDegraded = withDelta.filter(p => p.delta < 0).length;
      // Latest score trend from rolling history
      const vHistory = data.verticals?.[v];
      const latestBefore = vHistory?.avg_score_before?.slice(-1)[0] ?? null;
      const latestAfter  = vHistory?.avg_score_after?.slice(-1)[0]  ?? null;
      verticalSummary[v] = {
        total_patches:   vPatches.length,
        patches_with_measurement: withDelta.length,
        avg_score_before: avgBefore,
        avg_score_after:  avgAfter,
        avg_delta:        avgBefore !== null && avgAfter !== null ? avgAfter - avgBefore : null,
        patches_improved: totalImproved,
        patches_degraded: totalDegraded,
        latest_score_before: latestBefore,
        latest_score_after:  latestAfter,
        latest_delta: latestBefore !== null && latestAfter !== null ? latestAfter - latestBefore : null,
        terms_learned: (vHistory?.patches || []).length,
      };
    }

    // ── Overall health score ───────────────────────────────────────────────────
    const allWithDelta = (data.patches || []).filter(p => typeof p.delta === 'number');
    const overallAvgDelta = allWithDelta.length
      ? Math.round(allWithDelta.reduce((s, p) => s + p.delta, 0) / allWithDelta.length)
      : null;
    const improvementRate = allWithDelta.length
      ? Math.round(allWithDelta.filter(p => p.delta > 0).length / allWithDelta.length * 100)
      : null;

    const payload = {
      generated_at:           new Date().toISOString(),
      total_patches_applied:  data.total_patches_applied || 0,
      patches_with_measurement: allWithDelta.length,
      overall_avg_delta:      overallAvgDelta,
      improvement_rate_pct:   improvementRate,
      last_run_at:            data.runs?.[data.runs.length - 1]?.ts || null,
      total_runs:             data.runs?.length || 0,
      vertical_summary:       verticalSummary,
      patches:                patchRows,
    };

    if (includeRuns) {
      payload.runs = (data.runs || []).slice(-20).map(r => ({
        ts:             r.ts,
        cycle:          r.cycle,
        log_entries:    r.log_entries,
        failures_found: r.failures_found,
        patches_count:  r.patches?.length || 0,
        score_trends:   r.score_trends,
      }));
    }

    res.json(payload);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/zip-queue', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    const queue = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    res.json({
      total:      queue.length,
      pending:    queue.filter(z => z.status === 'pending').length,
      inProgress: queue.filter(z => z.status === 'inProgress').length,
      complete:   queue.filter(z => z.status === 'complete').length,
      failed:     queue.filter(z => z.status === 'failed').length,
      active:     queue.filter(z => z.status === 'inProgress'),
      generatedAt: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/local-intel/reset-queue ───────────────────────────────────────────────
// Queue lives in Postgres (zip_coverage table via zipCoordinatorWorker).
// Reset by clearing done/failed rows so the coordinator re-queues them on next cycle.
router.post('/reset-queue', async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE zip_coverage SET status = 'pending', attempts = 0, started_at = NULL
        WHERE status IN ('done', 'failed')`
    );
    const reset = result?.rowCount || 0;
    res.json({ ok: true, reset, message: `${reset} ZIPs reset to pending in Postgres — zipCoordinatorWorker will re-queue on next cycle` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/budget-status ────────────────────────────────────────────────
// Proxies from zipCoordinatorWorker (port 3006) and normalises to snake_case
router.get('/budget-status', async (req, res) => {
  try {
    const r = await fetch('http://localhost:3006/budget-status', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`zip-coordinator HTTP ${r.status}`);
    const d = await r.json();
    res.json({
      concurrent_agents: d.concurrentAgents ?? null,
      gate_status:       d.gateStatus       ?? 'normal',
      revenue_7d:        d.revenue7d        ?? 0,
      generatedAt:       d.generatedAt,
    });
  } catch (e) {
    // Return safe defaults so the dashboard doesn’t break
    res.json({ concurrent_agents: null, gate_status: 'normal', revenue_7d: 0, error: e.message });
  }
});

// ── POST /api/local-intel/nl-query — NIM natural language → structured oracle ──
// Parses free-text queries like "high-income ZIPs near Jacksonville with low WFH"
// into structured filters, runs oracle on matching ZIPs, returns ranked results.
router.post('/nl-query', express.json(), async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question required' });
    }
    logUsage(getCallerId(req), 'nl-query', null, 5);

    const nvim = require('./lib/nvim');
    const { getAllZips } = require('./workers/flZipRegistry');

    // Step 1 — NIM parses intent into structured filters
    const systemPrompt = `You are a geospatial query parser for a Florida local business intelligence platform.
Extract search filters from the user's natural language query and return ONLY valid JSON.

Fields you can extract (all optional):
- near_city: string — city name (e.g. "Jacksonville", "Tampa", "Miami")
- min_income: number — minimum median household income in USD
- max_income: number — maximum median household income in USD  
- min_population: number — minimum ZIP population
- max_wfh_pct: number — maximum WFH saturation (0-100)
- min_wfh_pct: number — minimum WFH saturation (0-100)
- growth_state: string — one of: growing, stable, transitioning, transient
- vertical: string — one of: restaurant, retail, health, finance, services
- saturation: string — one of: undersupplied, oversupplied, balanced
- limit: number — max ZIPs to return (default 5, max 10)
- intent: string — 1 sentence description of what the user wants

Return ONLY a JSON object with these fields. No explanation.`;

    const userPrompt = `Query: "${question}"`;

    let filters = {};
    try {
      const raw = await nvim.nvimChat(systemPrompt, userPrompt, 300);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) filters = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[nl-query] NIM parse failed:', e.message);
      return res.status(500).json({ error: 'NIM unavailable — set NVIDIA_API_KEY in Railway' });
    }

    // Step 2 — Load oracle index + ZIP registry, apply filters
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR_NL = path.join(__dirname, 'data');

    // City → lat/lon for proximity filter
    const CITY_COORDS = {
      'jacksonville': { lat: 30.33, lon: -81.66 },
      'tampa':        { lat: 27.95, lon: -82.46 },
      'orlando':      { lat: 28.54, lon: -81.38 },
      'miami':        { lat: 25.77, lon: -80.19 },
      'fort lauderdale': { lat: 26.12, lon: -80.14 },
      'gainesville':  { lat: 29.65, lon: -82.32 },
      'tallahassee':  { lat: 30.44, lon: -84.28 },
      'sarasota':     { lat: 27.34, lon: -82.53 },
      'fort myers':   { lat: 26.64, lon: -81.87 },
      'pensacola':    { lat: 30.42, lon: -87.22 },
      'daytona':      { lat: 29.21, lon: -81.02 },
      'st augustine': { lat: 29.89, lon: -81.32 },
      'ponte vedra':  { lat: 30.19, lon: -81.38 },
      'nocatee':      { lat: 30.11, lon: -81.42 },
    };

    function haversine(lat1, lon1, lat2, lon2) {
      const R = 3958.8; // miles
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    const allZips = getAllZips();
    const oracleDir = path.join(DATA_DIR_NL, 'oracle');
    const censusDir = path.join(DATA_DIR_NL, 'census_layer');
    const limit = Math.min(filters.limit || 5, 10);

    // ── Postgres pre-load: bulk fetch oracle + census for all ZIPs ──────────
    // Primary source = Postgres; flat files are fallback only
    const pgStore = require('./lib/pgStore');
    const oraclePgMap  = new Map(); // zip -> oracle_json
    const censusPgMap  = new Map(); // zip -> layer_json
    try {
      const dbMod = require('./lib/db');
      if (dbMod.isReady()) {
        const [oracleRows, censusRows] = await Promise.all([
          dbMod.query('SELECT zip, oracle_json FROM zip_intelligence').catch(() => ({ rows: [] })),
          dbMod.query('SELECT zip, layer_json FROM census_layer').catch(() => ({ rows: [] })),
        ]);
        for (const r of (oracleRows.rows || [])) if (r.oracle_json) oraclePgMap.set(r.zip, r.oracle_json);
        for (const r of (censusRows.rows || [])) if (r.layer_json) censusPgMap.set(r.zip, r.layer_json);
      }
    } catch (_pgErr) { /* DB not ready — fall through to flat files */ }

    // Proximity center
    const cityKey = (filters.near_city || '').toLowerCase().trim();
    const cityCenter = CITY_COORDS[cityKey] || null;
    const RADIUS_MILES = 60; // default search radius

    // Score + filter each ZIP
    const candidates = [];
    for (const zipEntry of allZips) {
      const { zip, population, median_hhi, lat, lon } = zipEntry;

      // Proximity filter
      if (cityCenter) {
        if (!lat || !lon) continue;
        const dist = haversine(cityCenter.lat, cityCenter.lon, lat, lon);
        if (dist > RADIUS_MILES) continue;
      }

      // Income filter (use registry median_hhi as fast fallback)
      const income = median_hhi || 0;
      if (filters.min_income && income < filters.min_income) continue;
      if (filters.max_income && income > filters.max_income) continue;

      // Population filter
      if (filters.min_population && (population || 0) < filters.min_population) continue;

      // Load oracle data — Postgres first, flat file fallback
      let oracle = oraclePgMap.get(zip) || null;
      if (!oracle) {
        const oracleFile = path.join(oracleDir, `${zip}.json`);
        if (fs.existsSync(oracleFile)) {
          try { oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8')); } catch {}
        }
      }

      // Load census layer — Postgres first, flat file fallback
      let census = censusPgMap.get(zip) || null;
      if (!census) {
        const censusFile = path.join(censusDir, `${zip}.json`);
        if (fs.existsSync(censusFile)) {
          try { census = JSON.parse(fs.readFileSync(censusFile, 'utf8')); } catch {}
        }
      }

      const wfhPct = census?.wfh_pct || oracle?.demographics?.wfh_pct || null;

      // WFH filter
      if (filters.max_wfh_pct != null && wfhPct != null && wfhPct > filters.max_wfh_pct) continue;
      if (filters.min_wfh_pct != null && wfhPct != null && wfhPct < filters.min_wfh_pct) continue;

      // Growth state filter
      if (filters.growth_state && oracle?.growth_trajectory?.state !== filters.growth_state) continue;

      // Saturation filter
      if (filters.saturation && oracle?.restaurant_capacity?.saturation_status !== filters.saturation) continue;

      // Score: higher income + matching oracle signals = higher rank
      const score = (income / 1000) +
        (oracle ? 20 : 0) +
        (wfhPct != null ? (filters.max_wfh_pct ? (filters.max_wfh_pct - wfhPct) : wfhPct) : 0) +
        (cityCenter && lat && lon ? Math.max(0, RADIUS_MILES - haversine(cityCenter.lat, cityCenter.lon, lat, lon)) : 0);

      candidates.push({
        zip,
        name: oracle?.name || zip,
        population: population || oracle?.demographics?.population || 0,
        median_household_income: income || oracle?.demographics?.median_household_income || 0,
        wfh_pct: wfhPct,
        growth_trajectory: oracle?.growth_trajectory || null,
        saturation_status: oracle?.restaurant_capacity?.saturation_status || null,
        gap_count: oracle?.restaurant_capacity?.gap_count || 0,
        oracle_narrative: oracle?.oracle_narrative || null,
        top_gap: oracle?.market_gaps?.top_gap || null,
        has_oracle: !!oracle,
        score,
      });
    }

    // Sort by score desc, return top N
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, limit);

    res.json({
      ok: true,
      question,
      intent: filters.intent || question,
      filters_applied: filters,
      total_matched: candidates.length,
      results: top,
    });

  } catch (err) {
    console.error('[nl-query] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/oracle?zip=XXXXX ───────────────────────────────────
// Returns pre-baked economic narrative for a ZIP: restaurant capacity, market gaps, growth
router.get('/oracle', async (req, res) => {
  try {
    const zip = (req.query.zip || '').replace(/\D/g, '').slice(0, 5);
    logUsage(getCallerId(req), 'oracle', zip || 'all', 1);
    const oracleDir = path.join(DATA_DIR_AGENT, 'oracle');

    if (zip) {
      // Single ZIP — Postgres first, flat file fallback for local dev
      let oracleData = null;
      if (process.env.LOCAL_INTEL_DB_URL) {
        try {
          const { getZipIntelligenceRow } = require('./lib/pgStore');
          oracleData = await getZipIntelligenceRow(zip);
        } catch (_) {}
      }
      if (!oracleData) {
        const file = path.join(oracleDir, `${zip}.json`);
        if (fs.existsSync(file)) {
          try { oracleData = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
        }
      }
      if (!oracleData) {
        return res.status(404).json({ error: `No oracle data for ${zip}. Oracle worker may still be computing.` });
      }

      // ── Notify claimed businesses in this ZIP about the market query ──
      // Fire-and-forget — never block the oracle response
      try {
        const nq = require('./lib/notificationQueue');
        // Determine top gap category group from oracle, fallback to 'services'
        const topGroup = oracleData?.market_gaps?.top_gap?.category_group
          || oracleData?.restaurant_capacity?.top_gap_group
          || null;
        if (topGroup) {
          const subject = `Market query in your area — ${zip}`;
          const payload = {
            body: `An agent queried the ${topGroup} market in ZIP ${zip}. Check LocalIntel for full details.`,
            zip,
            category_group: topGroup,
            cta_url: `https://thelocalintel.com/claim.html?business_id=`,
            cta_label: 'View Market Intelligence',
          };
          setImmediate(() =>
            nq.enqueueForZipCategory(zip, topGroup, subject, payload)
              .then(n => { if (n > 0) return nq.processQueue(20); })
              .catch(e => console.error('[oracle-notify]', e.message))
          );
        }
      } catch (notifyErr) {
        console.error('[oracle-notify-init]', notifyErr.message);
      }

      return res.json(oracleData);
    }

    // No ZIP specified — build index from Postgres (durable), flat file fallback
    if (process.env.LOCAL_INTEL_DB_URL) {
      try {
        const db2 = require('./lib/db');
        const rows = await db2.query(
          `SELECT zip, name, saturation_status, growth_state, consumer_profile, computed_at, oracle_json
           FROM zip_intelligence WHERE oracle_json IS NOT NULL ORDER BY zip`
        );
        const zips = {};
        for (const r of rows) {
          const oj = r.oracle_json || {};
          zips[r.zip] = {
            name:             r.name,
            saturation_status: r.saturation_status || oj.restaurant_capacity?.saturation_status,
            capture_rate_pct: oj.restaurant_capacity?.capture_rate_pct,
            growth_state:     r.growth_state || oj.growth_trajectory?.state,
            consumer_profile: r.consumer_profile,
            top_gap:          oj.market_gaps?.top_gap?.tier || null,
            computed_at:      r.computed_at,
          };
        }
        return res.json({ generated_at: new Date().toISOString(), source: 'postgres', zips });
      } catch (_) {}
    }
    // Flat file fallback (local dev)
    const indexFile = path.join(oracleDir, '_index.json');
    if (!fs.existsSync(indexFile)) {
      return res.status(404).json({ error: 'Oracle index not ready yet. Check back in 60 seconds.' });
    }
    res.json(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/oracle/history?zip=XXXXX ─────────────────────────────
// Returns full time-series array for a ZIP (up to 180 snapshots)
// Optional ?limit=N to get last N entries
// ── Business pins endpoint — lat/lon + name/category for map markers ──────────
router.get('/pins', async (req, res) => {
  try {
    const zip = (req.query.zip || '').replace(/\D/g, '').slice(0, 5);
    if (!zip) return res.status(400).json({ error: 'zip required' });
    const rows = await db.query(
      `SELECT name, lat, lon, category_group, category, claimed
       FROM businesses
       WHERE zip = $1 AND lat IS NOT NULL AND lon IS NOT NULL
       ORDER BY claimed DESC NULLS LAST, name ASC`,
      [zip]
    );
    res.json({ zip, count: rows.length, pins: rows.map(r => ({
      name: r.name,
      lat:  parseFloat(r.lat),
      lon:  parseFloat(r.lon),
      group: r.category_group || 'services',
      category: (r.category || '').replace(/_/g, ' '),
      claimed: !!r.claimed,
    })) });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/oracle/history', (req, res) => {
  try {
    const zip = (req.query.zip || '').replace(/\D/g, '').slice(0, 5);
    const limit = parseInt(req.query.limit || '90', 10);
    if (!zip) return res.status(400).json({ error: 'zip required' });
    const histFile = path.join(DATA_DIR_AGENT, 'oracle', 'history', `${zip}.json`);
    if (!fs.existsSync(histFile)) {
      return res.status(404).json({ error: `No history for ${zip} yet. Will populate after first oracle cycle.`, cycles: 0, history: [] });
    }
    const history = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    const slice = Array.isArray(history) ? history.slice(-limit) : [];
    return res.json({ zip, cycles: slice.length, history: slice });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Self-hosted x402 facilitator endpoints ───────────────────────────────────
// Called by x402-express paymentMiddleware when verifying / settling payments.
// Avoids dependency on x402.org/facilitator (testnet-only for Base mainnet).
// Mounted at /api/local-intel/x402-facilitator/verify and /settle

router.post('/x402-facilitator/verify', express.json(), async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ isValid: false, invalidReason: 'missing_parameters', error: 'Missing paymentPayload or paymentRequirements' });
    }
    // Local EIP-3009 signature verification — no external service needed
    const result = await exact.evm.verify(basePublicClient, paymentPayload, paymentRequirements);
    res.json(result);
  } catch (e) {
    console.error('[x402-facilitator] verify error:', e.message);
    res.status(500).json({ isValid: false, invalidReason: 'unexpected_error', error: e.message });
  }
});

router.post('/x402-facilitator/settle', express.json(), async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ success: false, error: 'Missing paymentPayload or paymentRequirements' });
    }
    if (!baseTreasuryWallet) {
      return res.status(503).json({ success: false, error: 'THROW_TREASURY_PK not configured — cannot settle' });
    }
    // On-chain USDC transferWithAuthorization — executes the actual payment
    const result = await exact.evm.settle(baseTreasuryWallet, paymentPayload, paymentRequirements);
    res.json(result);
  } catch (e) {
    console.error('[x402-facilitator] settle error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// /supported — tells paymentMiddleware what schemes/networks this facilitator handles
// ── GET /api/local-intel/x402/listing — Coinbase Payments Bazaar discovery manifest ──
// This is what the Bazaar crawler reads to list LocalIntel as a payable x402 service.
// Format follows x402 Resource Object spec: https://x402.org/spec
router.get('/x402/listing', (req, res) => {
  res.json({
    name:        'LocalIntel — Hyperlocal Business Intelligence',
    description: 'Agentic ground-truth local business data for Florida and the Sunbelt. 1,000+ ZIPs, 30k+ businesses, OSM POI layer, Census demographics, sector gap analysis, and market briefs. LLMs pay instead of hallucinating. Zero hallucinations — all data is sourced from public records, OSM, and verified business registries.',
    url:         'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp/x402',
    pricing: [
      { endpoint: 'POST /api/local-intel/mcp/x402',         price: '$0.01', currency: 'USDC', network: 'base', description: 'Standard query — ZIP business lookup, sector search, demographics' },
      { endpoint: 'POST /api/local-intel/mcp/x402/premium', price: '$0.05', currency: 'USDC', network: 'base', description: 'Deep analysis — composite local intel with gaps, spending zones, and market brief' },
    ],
    payment_required: true,
    payment_scheme:   'x402',
    networks:         ['base'],
    categories:       ['local-intelligence', 'business-data', 'real-estate', 'market-research', 'geospatial'],
    coverage: {
      states:     ['FL'],
      expanding:  ['GA', 'TX', 'NC', 'SC', 'AZ', 'TN'],
      zip_count:  1013,
      business_count: '30000+',
    },
    discovery_feed:   'https://gsb-swarm-production.up.railway.app/api/sector-gap/feed',
    mcp_server_card:  'https://gsb-swarm-production.up.railway.app/api/local-intel/.well-known/mcp/server-card.json',
    smithery:         'https://smithery.ai/servers/erik-7clt/local-intel',
    contact:          'erik@mcflamingo.com',
    version:          '1.1.0',
    updated_at:       new Date().toISOString(),
  });
});

// ── GET /api/local-intel/usage — agent billing ledger ──────────────────────────
router.get('/usage', async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.json({ error: 'no_db', queries: [], totals: { queries: '0', total_credits: '0' } });
  try {
    const db = require('./lib/db');
    // db.query returns rows array directly
    const rows = await db.query(
      `SELECT caller_id, query_type, zip, credits_charged, ts
       FROM usage_ledger ORDER BY ts DESC LIMIT 100`
    );
    const totalsRow = await db.queryOne(
      `SELECT COUNT(*) as queries, COALESCE(SUM(credits_charged),0) as total_credits FROM usage_ledger`
    );
    res.json({ queries: rows, totals: totalsRow });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/x402-facilitator/supported', (req, res) => {
  res.json({
    kinds: [
      { scheme: 'exact', network: 'base' },
    ],
  });
});

// ── Agent self-registration ───────────────────────────────────────────────────────────────
// POST /api/local-intel/register
// Body: { wallet: '0x...', label: 'my-agent' }
// Returns: { token, tier, daily_limit, mcp_endpoint, instructions }
// The token goes in Authorization: Bearer <token> on every MCP call.
router.post('/register', express.json(), async (req, res) => {
  const { wallet, label } = req.body || {};
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'wallet required — must be a valid 0x EVM address' });
  }
  try {
    const crypto = require('crypto');
    const { registerToken } = require('./lib/agentRegistry');
    // Generate a secure random token
    const token = `li_${crypto.randomBytes(24).toString('hex')}`;
    await registerToken({ token, wallet, tier: 'paid', daily_limit: 10000, label: label || null });
    return res.json({
      token,
      tier:         'paid',
      daily_limit:  10000,
      wallet,
      mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
      auth_header:  `Authorization: Bearer ${token}`,
      tool_costs: {
        local_intel_compare:  '$0.08 pathUSD per call',
        local_intel_oracle:   '$0.03 pathUSD per call',
        local_intel_ask:      '$0.05 pathUSD per call',
        local_intel_search:   '$0.01 pathUSD per call',
        local_intel_realtor:  '$0.02 pathUSD per call',
      },
      payment_rails: [
        { network: 'base',  asset: 'USDC',    method: 'x402 — send X-PAYMENT header with Base tx hash' },
        { network: 'tempo', asset: 'pathUSD', method: 'bearer token — sponsor-tx pulled on each call' },
      ],
      instructions: 'Include Authorization: Bearer <token> in every MCP request. Your registered wallet will be debited pathUSD on Tempo mainnet per tool call. Top up your wallet at thelocalintel.com.',
    });
  } catch (e) {
    console.error('[register] error:', e.message);
    res.status(500).json({ error: 'Registration failed', detail: e.message });
  }
});

// GET /api/local-intel/register/info — pricing + docs, no auth needed
router.get('/register/info', (req, res) => {
  res.json({
    product:      'LocalIntel MCP — Agentic Local Business Intelligence',
    coverage:     '113k+ businesses, 360 FL ZIPs with ACS demographics, oracle narratives, sector gap analysis',
    tools:        21,
    smithery_score: 90,
    registry:     'io.github.MCFLAMINGO/local-intel',
    mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
    register_endpoint: 'POST https://gsb-swarm-production.up.railway.app/api/local-intel/register',
    register_body: { wallet: '0xYourEVMWallet', label: 'my-agent-name' },
    free_tier: '3 calls/day (no token required)',
    x402: {
      supported: true,
      networks: ['base (USDC)', 'tempo (pathUSD)'],
      facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
      note: 'Any x402-fetch compatible agent auto-pays on call. No registration needed for x402 path.',
    },
    tool_costs: {
      local_intel_compare:     0.08,
      local_intel_ask:         0.05,
      local_intel_oracle:      0.03,
      local_intel_signal:      0.03,
      local_intel_query:       0.03,
      local_intel_sector_gap:  0.03,
      local_intel_search:      0.01,
    },
    contact: 'erik@mcflamingo.com',
  });
});

// ── Jobs table auto-create ────────────────────────────────────────────────────
// McFlamingo back door + booths = job #1 test case
// All jobs are ZIP-routed. Accepting agent declares their wallet. Completion requires proof.
async function ensureJobsTable() {
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  try {
    const db = require('./lib/db');
    await db.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title         TEXT NOT NULL,
        description   TEXT,
        project_type  TEXT,
        zip           TEXT,
        budget_usd    NUMERIC(12,2),
        poster_wallet TEXT,
        poster_email  TEXT,
        acceptor_wallet TEXT,
        status        TEXT NOT NULL DEFAULT 'open',
        proof         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        accepted_at   TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        meta          JSONB
      )
    `);
  } catch (e) {
    console.error('[localIntelAgent] ensureJobsTable failed:', e.message);
  }
}
ensureJobsTable();

// POST /job/create — create a new job posting
router.post('/job/create', express.json(), async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { title, description, project_type, zip, budget_usd, poster_wallet, poster_email, meta } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `INSERT INTO jobs (title, description, project_type, zip, budget_usd, poster_wallet, poster_email, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING id, title, status, created_at`,
      [title, description||null, project_type||null, zip||null,
       budget_usd||null, poster_wallet||null, poster_email||null,
       meta ? JSON.stringify(meta) : null]
    );
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /job/feed — list open jobs (filter by zip or project_type)
router.get('/job/feed', async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { zip, project_type, limit = 20 } = req.query;
  try {
    const db = require('./lib/db');
    const conditions = ["status = 'open'"];
    const vals = [];
    if (zip)          { vals.push(zip);          conditions.push(`zip = $${vals.length}`); }
    if (project_type) { vals.push(project_type); conditions.push(`project_type = $${vals.length}`); }
    vals.push(Math.min(Number(limit)||20, 100));
    const rows = await db.query(
      `SELECT id, title, description, project_type, zip, budget_usd,
              poster_wallet, status, created_at, meta
       FROM jobs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${vals.length}`,
      vals
    );
    res.json({ ok: true, jobs: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /job/accept — claim a job (agent declares their wallet)
router.post('/job/accept', express.json(), async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { job_id, acceptor_wallet } = req.body || {};
  if (!job_id || !acceptor_wallet) return res.status(400).json({ error: 'job_id + acceptor_wallet required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `UPDATE jobs
       SET status='accepted', acceptor_wallet=$1, accepted_at=NOW()
       WHERE id=$2 AND status='open'
       RETURNING id, title, status, acceptor_wallet, accepted_at`,
      [acceptor_wallet, job_id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'Job not found or already taken' });
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /job/complete — mark a job done + attach proof (tx_hash, url, note, etc.)
router.post('/job/complete', express.json(), async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { job_id, acceptor_wallet, proof } = req.body || {};
  if (!job_id || !acceptor_wallet) return res.status(400).json({ error: 'job_id + acceptor_wallet required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `UPDATE jobs
       SET status='completed', proof=$1, completed_at=NOW()
       WHERE id=$2 AND acceptor_wallet=$3 AND status='accepted'
       RETURNING id, title, status, proof, completed_at`,
      [proof||null, job_id, acceptor_wallet]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'Job not found, already completed, or wrong wallet' });
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PIPELINE CRON ENDPOINT ──────────────────────────────────────────────────
// POST /api/local-intel/admin/pipeline/reclassify
// Triggered by Railway cron (nightly 2am ET) or manually.
// Runs full self-healing pipeline: classify → enrich → validate → consolidate.
// Self-improves until health_score >= 80. Detects stalls and flags them.
// Protected by PIPELINE_SECRET env var.
router.post('/admin/pipeline/reclassify', express.json(), async (req, res) => {
  const secret = req.headers['x-pipeline-secret'] || req.body?.secret;
  if (process.env.PIPELINE_SECRET && secret !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Respond immediately — pipeline runs async, can take 15-30min for full YP enrich
  res.json({ status: 'pipeline started', timestamp: new Date().toISOString() });

  setImmediate(async () => {
    try {
      const { runPipeline } = require('./scripts/pipeline_runner');
      const result = await runPipeline();
      console.log('[cron] pipeline complete. health_score:', result.health?.health_score, '| stall:', result.stall);
    } catch (err) {
      console.error('[cron] pipeline FATAL:', err.message);
    }
  });
});

// GET /api/local-intel/admin/pipeline/runs — view pipeline history + health trend
router.get('/admin/pipeline/runs', async (req, res) => {
  try {
    const db = require('./lib/db');
    const runs = await db.query(
      `SELECT run_id, pipeline, started_at, finished_at, total_scanned, matched, unmatched, downgraded, notes
         FROM pipeline_runs ORDER BY started_at DESC LIMIT 20`
    );
    const health = await db.query(
      `SELECT health_id, run_at, health_score, pct_classified, pct_confident,
              avg_confidence, local_business_cnt, uncategorized_cnt,
              duplicate_cnt, shell_candidate_cnt, needs_review_cnt, stall_flag, notes
         FROM pipeline_health ORDER BY run_at DESC LIMIT 10`
    );
    res.json({ runs, health_trend: health });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUBLIC ASK ROUTE ────────────────────────────────────────────────────────────────────────────
// GET  /api/local-intel/ask?q=<question>&zip=<zip>
// POST /api/local-intel/ask  { "q": "...", "zip": "32082" }
//
// Public, no auth, no payment gate. Natural language in → LocalIntel intel out.
// Used by the search page, external agents, and any direct browser link.
// Routes through the same handleQuery / handleAsk path as the MCP tools.
// Rate-limited: 20 req/min per IP via X-Forwarded-For.
// CORS: open (*) so any frontend or agent can call it.
//
// Response: { answer, zip, category, sources, tool_used, latency_ms }

const _askRateMap = new Map(); // ip → { count, reset }
function _askRateLimit(ip) {
  const now = Date.now();
  const entry = _askRateMap.get(ip);
  if (!entry || now > entry.reset) {
    _askRateMap.set(ip, { count: 1, reset: now + 60_000 });
    return false; // not limited
  }
  if (entry.count >= 20) return true; // limited
  entry.count++;
  return false;
}

async function handleAskRequest(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (_askRateLimit(ip)) {
    return res.status(429).json({ error: 'rate_limit', message: 'Max 20 requests per minute.' });
  }

  const q   = (req.method === 'GET' ? req.query.q   : req.body?.q)   || '';
  const zip = (req.method === 'GET' ? req.query.zip : req.body?.zip) || null;
  const cat = (req.method === 'GET' ? req.query.cat : req.body?.cat) || null;

  /** @type {LocalIntelIntent} */
  const intent = {
    source: 'ask',
    actor: { type: 'human', phone: null, email: null, agent_key: null, session_id: null, call_sid: null },
    raw_input: q || zip || '',
    command: { family: 'local_intel', name: 'ask', stage: null },
    task: {
      category: cat || null, business_id: null, business_name: null,
      zip: zip || null, city: null, lat: null, lon: null, radius_miles: null,
      description: q || null, items: [],
      constraints: { budget: null, eta_minutes: null, time_window: null },
    },
    routing: { destination: 'answer', pos_type: null, confidence: null, fallback_reason: null },
    delivery: { channel: 'json', reply_expected: false },
  };
  console.log('[/ask] intent', JSON.stringify(intent));

  if (!q && !zip) {
    return res.status(400).json({
      error: 'query required',
      message: 'Pass ?q=<question> or POST { "q": "..." }. Optional: zip, cat.',
      examples: [
        '/ask?q=What restaurants are in 32082',
        '/ask?q=Is there an urgent care gap in Nocatee&zip=32081',
        '/ask?q=roofing contractors&zip=32082&cat=Construction',
      ],
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const t0 = Date.now();
  try {
    const { handleRPC } = require('./localIntelMCP');

    // Build a tools/call RPC for local_intel_query — the fuzzy intent router
    const rpc = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'local_intel_query',
        arguments: { query: [q, cat, zip].filter(Boolean).join(' ') },
      },
    };

    const callerInfo = { tier: 'sandbox', caller: ip, agentSessionId: null };
    const result = await handleRPC(rpc, callerInfo);

    const answer = result?.result?.content?.[0]?.text
      || result?.result
      || result;

    return res.json({
      answer,
      zip:      intent.task.zip,
      category: intent.task.category,
      tool_used: 'local_intel_query',
      latency_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[/ask] error:', e.message);
    return res.status(500).json({ error: e.message, latency_ms: Date.now() - t0 });
  }
}

router.options('/ask', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
router.get('/ask',  handleAskRequest);
router.post('/ask', express.json(), handleAskRequest);

// ── Service-request detector for /search ───────────────────────────────────────────
// Deterministic vocabulary scoring — same approach as voiceIntake, no LLM.
// Returns { isRequest: bool, category: string|null }
const _SVC_MAP = {
  // Landscaping
  'lawn':'landscaping','mow':'landscaping','mowing':'landscaping','landscap':'landscaping',
  'grass':'landscaping','yard':'landscaping','tree trimm':'landscaping','tree service':'landscaping',
  'tree cut':'landscaping','cut down tree':'landscaping','cut tree':'landscaping',
  'stump':'landscaping','arborist':'landscaping','tree removal':'landscaping',
  'hedge':'landscaping','trim':'landscaping','bush':'landscaping','mulch':'landscaping',
  'irrigation':'landscaping','sprinkler':'landscaping',
  // Cleaning
  'clean':'cleaning','maid':'cleaning','housekeep':'cleaning','janitorial':'cleaning',
  'pressure wash':'cleaning','window clean':'cleaning',
  // Plumbing
  'plumb':'plumbing','pipe':'plumbing','leak':'plumbing','drain':'plumbing',
  'water heater':'plumbing','toilet':'plumbing','faucet':'plumbing',
  // Electrical
  'electric':'electrical','wiring':'electrical','outlet':'electrical','breaker':'electrical',
  'panel':'electrical','street light':'electrical','light fix':'electrical','light out':'electrical',
  // HVAC
  'hvac':'hvac','air condition':'hvac','heat pump':'hvac','furnace':'hvac','duct':'hvac',
  // Roofing
  'roof':'roofing','shingle':'roofing','gutter':'roofing',
  // Painting
  'paint':'painting','stain':'painting','drywall':'painting',
  // Moving
  'mov':'moving','haul':'moving','junk':'moving','removal':'moving',
  // Handyman
  'handyman':'handyman','fix':'handyman','repair':'handyman','install':'handyman',
  // Pest
  'pest':'pest_control','bug':'pest_control','termite':'pest_control','exterminate':'pest_control',
  'mosquito':'pest_control',
  // Flooring
  'floor':'flooring','tile':'flooring','carpet':'flooring','hardwood':'flooring',
  // Pool
  'pool':'pool_service',
  // Concrete
  'concrete':'concrete','driveway':'concrete',
  // Contractor
  'remodel':'contractor','renovate':'contractor','construction':'contractor',
  // Restaurant / food
  'deliver':'restaurant','delivery':'restaurant','pick up':'restaurant','pickup':'restaurant',
  'order food':'restaurant','takeout':'restaurant','restaurant':'restaurant',
  'food from':'restaurant','catering':'catering','cater':'catering',
  // Pest / auto / IT
  'mechanic':'auto','oil change':'auto','car wash':'auto','tire':'auto',
  'computer repair':'it_support','wifi':'it_support','tech support':'it_support',
  // Healthcare
  'doctor':'healthcare','physician':'healthcare','medical':'healthcare',
  'urgent care':'healthcare','clinic':'healthcare','dentist':'healthcare',
  'dental':'healthcare','therapist':'healthcare','therapy':'healthcare',
  'chiropractor':'healthcare','chiropractic':'healthcare','optometrist':'healthcare',
  'optician':'healthcare','eye doctor':'healthcare','dermatologist':'healthcare',
  'dermatology':'healthcare','pediatrician':'healthcare','pediatric':'healthcare',
  'psychiatrist':'healthcare','psychiatry':'healthcare','counseling':'healthcare',
  'mental health':'healthcare','physical therapy':'healthcare','pt ':'healthcare',
  'cardiologist':'healthcare','orthopedic':'healthcare','surgeon':'healthcare',
  'specialist':'healthcare','primary care':'healthcare','family doctor':'healthcare',
  'health':'healthcare','nurse':'healthcare','prescription':'healthcare',
  'pharmacy':'pharmacy','drug store':'pharmacy',
  'veterinarian':'veterinary','vet ':'veterinary','animal hospital':'veterinary',
  'pet care':'veterinary','pet ':'veterinary',
  // Legal
  'lawyer':'legal','attorney':'legal','legal help':'legal','lawsuit':'legal',
  'notary':'legal','paralegal':'legal',
  // Financial
  'accountant':'financial','tax prep':'financial','bookkeeping':'financial',
  'financial advisor':'financial','insurance':'insurance','insure':'insurance',
  // Real estate
  'realtor':'real_estate','real estate':'real_estate','home buy':'real_estate',
  'mortgage':'real_estate','home loan':'real_estate',
  // Childcare
  'daycare':'childcare','day care':'childcare','babysit':'childcare',
  'nanny':'childcare','afterschool':'childcare','preschool':'childcare',
  // Tutoring / education
  'tutor':'tutoring','tutoring':'tutoring','homework help':'tutoring',
  // Beauty / wellness
  'haircut':'beauty','barber':'beauty','salon':'beauty','nail':'beauty',
  'massage':'wellness','spa':'wellness',
  // Security
  'security system':'security','alarm':'security','camera install':'security',
};
// Phrases that signal "I want a service done" (not a business name search)
const _REQUEST_PHRASES = [
  'i need','i want','i have a','fix my','fix the','repair my','repair the',
  'find me a','find me an','get me a','get me an','looking for a','looking for an',
  'need a','need an','need someone','need help','help me','can someone',
  'who can','who does','where can i','how do i','my [a-z]+ is broken',
  'my [a-z]+ is leaking','my [a-z]+ is not working','broken','not working',
  'clogged','flooded','flooring replaced','replace my','replace the',
];
const _REQUEST_RE = new RegExp(_REQUEST_PHRASES.join('|'), 'i');

function detectServiceRequest(raw) {
  const lower = raw.toLowerCase();
  const isRequest = _REQUEST_RE.test(lower);
  if (!isRequest) return { isRequest: false, category: null };
  // Find best category match
  let category = null;
  for (const [kw, cat] of Object.entries(_SVC_MAP)) {
    if (lower.includes(kw)) { category = cat; break; }
  }
  return { isRequest: true, category };
}

// ── ORDER_ITEM intent: route "order ITEM at/from BIZ" → menu fetch + match ────
// User specifies what they want (item) AND where (biz) — agent will fuzzy-match
// against the live Basalt inventory. Distinct from _ORDER_INTENT_RE (routing).
// "order me chicken and broccoli on rice at McFlamingo"
// "order [item] from [biz]" / "I want [item] from [biz]" / "I'd like [item] at [biz]"
// "get me [item] from [biz]" / "can I get [item] from [biz]" / "bring me [item] from [biz]"
const _ORDER_ITEM_RE = /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)\s+(?:from|at)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i;
const _WANT_ITEM_RE  = /\b(?:i(?:'d| would)?(?:\s+like)?|(?:can|could)\s+i(?:\s+get)?|get\s+me|bring\s+me)\s+(.+?)\s+(?:from|at)\s+(.+?)$/i;

// Item-only (no business yet) — used for two-turn pending intent flow.
const _ORDER_ITEM_PARTIAL_RE = /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)(?:\s+(?:in|near)\s+.+)?$/i;
// "at McFlamingo" / "from McFlamingo" — resolves a pending order intent.
const _AT_BIZ_RE = /^(?:at|from)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i;

// Pending ORDER_ITEM intents awaiting business name — keyed by sessionId.
// 5-minute TTL; stored entries: { item, ts }.
const _pendingOrderIntent = new Map();
const _PENDING_ORDER_TTL_MS = 300_000;

// Venue context for follow-up questions ("can I buy a ticket", "how do I get there").
// 10-minute TTL; stored entries: a single venue result object + ts.
const _pendingVenueContext = new Map();
const _VENUE_CTX_TTL_MS = 600_000;
const _VENUE_FOLLOWUP_RE = /\b(?:buy\s+(?:a\s+)?ticket|get\s+ticket|purchase\s+ticket|tickets?\b|how\s+do\s+i\s+get\s+there|directions?\b|where\s+is\s+it|phone\s+number|call\s+them|their\s+website|website\b|what\s+time|hours\b|when\s+do\s+they\s+open|when\s+are\s+they\s+open)\b/i;

function _getVenueContext(sessionId) {
  if (!sessionId) return null;
  const entry = _pendingVenueContext.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.ts > _VENUE_CTX_TTL_MS) {
    _pendingVenueContext.delete(sessionId);
    return null;
  }
  return entry;
}

// Guard: recurring/scheduling language → not a single order intent.
// Used in both detectOrderItemIntent and detectOrderItemPartial so multi-day
// scheduling queries fall through to discovery instead of the two-turn order flow.
const RECURRING_ORDER_RE = /\b(\d+\s+day(s)?\s+a\s+week|each\s+day|every\s+day|daily|weekly|different\s+restaurant\s+each|rotating|weekly\s+plan|meal\s+plan|subscription|recurring|repeat\s+order|5\s+days?|monday\s+through|mon.*fri)\b/i;

// B9 guards — keep discovery/grocery/pharmacy queries OUT of the two-turn order flow.
// DISCOVERY_PREFIX_RE: "where can i get tacos" is a search, not an order. Any
// query starting with where/how/find/looking-for-style language is discovery.
const DISCOVERY_PREFIX_RE = /^(where\s+(can\s+i|do\s+i|can\s+you|do\s+you|is|are|will\s+i|would\s+i)|how\s+(can\s+i|do\s+i)|what\s+(is|are|restaurants?|places?|spots?)|which\s+(restaurant|place|spot)|find\s+(me\s+)?a|looking\s+for|searching\s+for|show\s+me)/i;
// GROCERY_ITEM_RE: eggs/milk/creamer/bread etc → grocery discovery, never restaurant ordering.
const GROCERY_ITEM_RE = /\b(eggs?|milk|butter|cream(er)?|bread|produce|fruit|vegetable|veggies?|yogurt|cheese|flour|sugar|coffee\s+beans?|ground\s+coffee|orange\s+juice|OJ|cereal|oatmeal|bacon|deli\s+meat|cold\s+cuts|toilet\s+paper|paper\s+towel|laundry|detergent|dish\s+soap|shampoo|conditioner|toothpaste|deodorant|sunscreen|batteries|lightbulb|garbage\s+bag|zip\s+lock|aluminum\s+foil|plastic\s+wrap|sponge|cleaning\s+spray)\b/i;
// PHARMACY guards: medication/rx/cvs/walgreens → fall through to detectTaskIntent
// pharmacy pickup, not the wallet-required ordering flow.
const PHARMACY_ITEM_RE = /\b(prescription|medication|meds?|rx\b|pills?|refill|medicine|pharmacy|insulin|inhaler|antibiotics?)\b/i;
const PHARMACY_BIZ_RE = /\b(cvs|walgreens?|rite\s*aid|publix\s*pharm|winn\s*dixie\s*pharm|walgreen|pharmacy|drug\s*store)\b/i;

// Detects whether a string is a comma/and-separated list of business names.
// Returns array of trimmed names if 2+ detected, else null.
// e.g. "mcflamingo, medure, aqua bar and grill, starbucks, and dicks"
//      → ['mcflamingo', 'medure', 'aqua bar and grill', 'starbucks', 'dicks']
function detectMultiBizList(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim();
  // Must contain at least one comma (single " and " alone isn't enough — too ambiguous
  // with multi-word names like "aqua bar and grill").
  if (!/,/.test(t)) return null;
  // Split on comma first to preserve "X and Y" inside a single name.
  // Then for the LAST comma-segment only, split on " and " to capture Oxford-comma lists
  // ("a, b, and c"). This keeps "aqua bar and grill" intact as one name.
  const commaParts = t.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  if (commaParts.length < 2) return null;
  let parts = commaParts.slice(0, -1);
  const last = commaParts[commaParts.length - 1];
  const andSplit = last.split(/\s+and\s+/i).map(s => s.trim()).filter(Boolean);
  parts = parts.concat(andSplit);
  parts = parts.map(s => s.replace(/^and\s+/i, '').trim()).filter(s => s.length > 1 && s.length < 60);
  if (parts.length < 2) return null;
  // Reject if any part looks like a sentence (contains a verb/question word)
  const SENTENCE_RE = /\b(want|need|get|find|looking|help|can|should|would|please|where|what|how|why|is|are|have|has)\b/i;
  if (parts.some(p => SENTENCE_RE.test(p))) return null;
  return parts;
}

// Look up multiple business names in parallel. Returns array of { queried, found }.
// Uses ILIKE + word-by-word fallback (same pattern as single-biz lookup elsewhere
// in this file). Each catch logs to console.error — never silently fails.
async function lookupMultiBiz(db, names, searchZips) {
  const zips = (searchZips && searchZips.length)
    ? searchZips
    : ['32082','32081','32250','32266','32233','32259','32034'];
  const results = await Promise.all(names.map(async (raw) => {
    const trimmedRaw = raw.trim();
    const aliasRes = await resolveBusinessAlias(trimmedRaw);
    const name = aliasRes.canonical || trimmedRaw;
    // If Tier 1 pinned a business_id, fetch directly.
    if (aliasRes.business_id) {
      try {
        const pinned = await db.query(
          `SELECT business_id AS id, name, phone, zip, city, address, website, category, wallet
             FROM businesses
            WHERE business_id = $1 AND status != 'inactive'
            LIMIT 1`,
          [aliasRes.business_id]
        );
        if (pinned.length) return { queried: raw, found: pinned[0] };
      } catch (err) {
        console.error('[lookupMultiBiz] pinned biz lookup error for', raw, err.message);
      }
    }
    let rows = [];
    try {
      rows = await db.query(
        `SELECT business_id AS id, name, phone, zip, city, address, website, category, wallet
           FROM businesses
          WHERE zip = ANY($1::text[])
            AND name ILIKE $2
            AND status != 'inactive'
          ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
          LIMIT 1`,
        [zips, `%${name}%`]
      );
    } catch (err) {
      console.error('[lookupMultiBiz] direct ILIKE error for', name, err.message);
      rows = [];
    }
    if (rows.length) return { queried: raw, found: rows[0] };

    // Word-by-word fallback for multi-word names.
    const words = name.split(/\s+/).filter(w => w.length > 2);
    if (words.length >= 2) {
      try {
        rows = await db.query(
          `SELECT business_id AS id, name, phone, zip, city, address, website, category, wallet
             FROM businesses
            WHERE zip = ANY($1::text[])
              AND (${words.map((_, i) => `name ILIKE $${i + 2}`).join(' AND ')})
              AND status != 'inactive'
            ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
            LIMIT 1`,
          [zips, ...words.map(w => `%${w}%`)]
        );
      } catch (err) {
        console.error('[lookupMultiBiz] word-fallback error for', name, err.message);
        rows = [];
      }
      if (rows.length) return { queried: raw, found: rows[0] };
    }
    return { queried: raw, found: null };
  }));
  return results;
}

function detectOrderItemIntent(raw) {
  if (!raw) return { isOrderItem: false, itemQuery: null, bizName: null };
  const trimmed = raw.trim();
  // Skip if it's a bare "order food from X" / "order from X" — that's the routing
  // intent below, not item-level. We require an item phrase between "order" and "from/at".
  // Pre-check: rule out queries where the only thing between order and from/at is
  // "food" / "some food" / "from" (ie. routing).
  const routingOnly = /^\s*(?:i(?:'d| would| wanna| want to| 'd like to| would like to)?\s+(?:like\s+to\s+)?)?(?:place\s+an?\s+order|order(?:\s+(?:some\s+)?food)?|get\s+(?:some\s+)?food|grab\s+(?:some\s+)?food|food)\s+(?:from|at)\s+/i;
  if (routingOnly.test(trimmed)) return { isOrderItem: false, itemQuery: null, bizName: null };
  if (RECURRING_ORDER_RE.test(trimmed)) return { isOrderItem: false, itemQuery: null, bizName: null };
  // B9 Bug 1: discovery prefix wins — "where can i get tacos" is search, not order.
  if (DISCOVERY_PREFIX_RE.test(trimmed)) return { isOrderItem: false, itemQuery: null, bizName: null };
  // B9 Bug 2: grocery items never trigger restaurant ordering. Check raw early
  // (itemQuery may not be extracted yet).
  if (GROCERY_ITEM_RE.test(trimmed)) return { isOrderItem: false, itemQuery: null, bizName: null };
  // B9 Bug 3: pharmacy items/businesses — fall through to detectTaskIntent.
  if (PHARMACY_ITEM_RE.test(trimmed)) return { isOrderItem: false, itemQuery: null, bizName: null };

  let m = trimmed.match(_ORDER_ITEM_RE);
  if (!m) m = trimmed.match(_WANT_ITEM_RE);
  if (!m) return { isOrderItem: false, itemQuery: null, bizName: null };

  let itemQuery = (m[1] || '').trim();
  let bizName   = (m[2] || '').trim();
  // Strip trailing punctuation / "please" / "now" / "in <zip>"
  bizName = bizName
    .replace(/\s+(?:please|now|today|tonight)\.?\s*$/i, '')
    .replace(/\s+in\s+\d{5}\s*$/i, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  itemQuery = itemQuery.replace(/[?.!,]+$/, '').trim();

  if (!itemQuery || !bizName) return { isOrderItem: false, itemQuery: null, bizName: null };
  // Reject obviously-too-short item or biz names (avoid false positives)
  if (itemQuery.length < 2 || bizName.length < 2) {
    return { isOrderItem: false, itemQuery: null, bizName: null };
  }
  // B9 Bug 3: pharmacy item or pharmacy-chain biz → not an order, taskIntent owns it.
  if (PHARMACY_ITEM_RE.test(itemQuery) || PHARMACY_BIZ_RE.test(bizName)) {
    return { isOrderItem: false, itemQuery: null, bizName: null };
  }
  // B9 Bug 2: grocery item leaked through (rare — "get me eggs from publix" splits cleanly).
  if (GROCERY_ITEM_RE.test(itemQuery)) {
    return { isOrderItem: false, itemQuery: null, bizName: null };
  }
  // Guard: reject non-food item queries even when a business name is present.
  // "I need my back fire door fixed at McFlamingo" should NOT trigger order flow.
  const NON_FOOD_FULL_RE = /\b(?:fixed|repair(?:ed)?|install(?:ed)?|replac(?:ed)?|clean(?:ed)?|paint(?:ed)?|built?|constructed?|renovated?|restor(?:ed)?|inspect(?:ed)?|servic(?:ed)?|maintain(?:ed)?|upgrad(?:ed)?|door|window|roof|wall|floor|ceiling|pipe|drain|wir(?:e|ing)|outlet|breaker|hvac|ac\s+unit|furnace|gutter|shingle|fence|deck|driveway|sidewalk|bathroom|kitchen\s+remodel|haircut|hair\s+cut|manicure|pedicure|massage|facial|wax|blowout|dental|teeth|oil\s+change|tire|alignment|brake|transmission|tow|locksmith|prescription|refill|vaccine|injection|room|hotel|flight|ticket|seat|parking|storage|unit|locker|beach\s+chair|beach\s+umbrella|kayak|paddleboard|surfboard|drill|power\s+tool|hardware|lumber|furniture|mattress|sofa|couch|clothing|apparel|shirt|pants|shoes|boots|jacket|sunscreen|sunblock|cleats|jersey|uniform|equipment|gear|supplies|supplies)\b/i;
  if (NON_FOOD_FULL_RE.test(itemQuery)) return { isOrderItem: false, itemQuery: null, bizName: null };
  return { isOrderItem: true, itemQuery, bizName };
}

// Partial: caller said an item but no business yet. Used to set up a pending
// two-turn intent ("order chicken" → "which restaurant?" → "from McFlamingo").
function detectOrderItemPartial(raw) {
  if (!raw) return { isPartial: false, itemQuery: null };
  const trimmed = raw.trim();
  // Don't treat full matches as partial — caller should check full first.
  if (_ORDER_ITEM_RE.test(trimmed) || _WANT_ITEM_RE.test(trimmed)) {
    return { isPartial: false, itemQuery: null };
  }
  // Skip routing-only phrases.
  const routingOnly = /^\s*(?:i(?:'d| would| wanna| want to| 'd like to| would like to)?\s+(?:like\s+to\s+)?)?(?:place\s+an?\s+order|order(?:\s+(?:some\s+)?food)?|get\s+(?:some\s+)?food|grab\s+(?:some\s+)?food|food)\s*$/i;
  if (routingOnly.test(trimmed)) return { isPartial: false, itemQuery: null };
  // Guard: recurring/scheduling language should fall through to discovery, not pending order flow.
  if (RECURRING_ORDER_RE.test(trimmed)) return { isPartial: false, itemQuery: null };
  // B9 guards mirror detectOrderItemIntent — keep discovery/grocery/pharmacy
  // queries out of the two-turn ordering flow.
  if (DISCOVERY_PREFIX_RE.test(trimmed)) return { isPartial: false, itemQuery: null };
  if (GROCERY_ITEM_RE.test(trimmed))     return { isPartial: false, itemQuery: null };
  if (PHARMACY_ITEM_RE.test(trimmed))    return { isPartial: false, itemQuery: null };

  const m = trimmed.match(_ORDER_ITEM_PARTIAL_RE);
  if (!m) return { isPartial: false, itemQuery: null };
  let itemQuery = (m[1] || '')
    .replace(/^(?:to\s+)?(?:order|get|have)\s+(?:a\s+|an\s+|some\s+)?/i, '') // strip 'to order a', 'to get some', etc.
    .replace(/[?.!,]+$/, '')
    .replace(/\s+(?:please|now|today|tonight)$/i, '')
    .trim();
  if (!itemQuery || itemQuery.length < 2) return { isPartial: false, itemQuery: null };
  // Reject pure routing words.
  if (/^(?:food|some\s+food)$/i.test(itemQuery)) return { isPartial: false, itemQuery: null };

  // Guard: reject clearly non-food phrases — real estate, services, info requests, etc.
  // "rent a property", "find a landscaper", "know where", "book a table", etc.
  const NON_FOOD_RE = /\b(?:rent|lease|buy|purchase|book(?:\s+a\s+(?:flight|hotel|venue))?|property|condo|apartment|house|home|land|real\s*estate|landscap|plumb|electr|construct|repair|install|service(?:s)?|hire|find\s+a|search\s+for|know\s+where|tell\s+me|show\s+me|recommend\s+a|suggest\s+a|looking\s+for\s+a\s+(?:home|house|property|place\s+to\s+live)|move|relocat|invest|hotel|vacation|travel|flight|airbnb|vrbo|haircut|hair\s+cut|hair\s+style|blowout|manicure|pedicure|nail|massage|facial|wax|barbershop|salon|spa|gym|workout|yoga|pilates|crossfit|fitness|dentist|dental|doctor|urgent\s+care|prescription|pharmacy|lawyer|attorney|accountant|insurance|mechanic|oil\s+change|car\s+wash|tire|tow|locksmith|pest\s+control|pool\s+service|landscap|irrigation|gutter|roofing|flooring|drywall|painting|fence|deck|remodel|renovation|beach\s+chair|beach\s+umbrella|beach\s+gear|beach\s+supply|outdoor\s+gear|camping\s+gear|sporting\s+goods|kayak|paddleboard|surfboard|fishing\s+gear|bike|bicycle|scooter|drill|power\s+tool|hardware|lumber|screwdriver|wrench|ladder|chainsaw|lawn\s+mower|leaf\s+blower|pressure\s+washer|furniture|mattress|sofa|couch|desk|chair|lamp|shelf|closet|mirror|clothing|apparel|shirt|pants|dress|shoes|sneakers|boots|jacket|coat|hat|sunglasses|swimsuit|flip\s+flops|sunscreen|sunblock|lotion|deodorant|shampoo|soap|toothpaste|toilet\s+paper|paper\s+towel|laundry|detergent|batteries|lightbulb|extension\s+cord|phone\s+charger|laptop|computer|printer|tv|television|speaker|headphones|camera|gift\s+card|flowers|florist|balloon|decoration)\b/i;
  if (NON_FOOD_RE.test(itemQuery)) return { isPartial: false, itemQuery: null };

  return { isPartial: true, itemQuery };
}

function detectAtBiz(raw) {
  if (!raw) return { isAtBiz: false, bizName: null };
  const m = raw.trim().match(_AT_BIZ_RE);
  if (!m) return { isAtBiz: false, bizName: null };
  let bizName = (m[1] || '')
    .replace(/\s+(?:please|now|today|tonight)\.?\s*$/i, '')
    .replace(/\s+in\s+\d{5}\s*$/i, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  if (!bizName || bizName.length < 2) return { isAtBiz: false, bizName: null };
  return { isAtBiz: true, bizName };
}

function _getPendingOrderIntent(sessionId) {
  if (!sessionId) return null;
  const entry = _pendingOrderIntent.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.ts > _PENDING_ORDER_TTL_MS) {
    _pendingOrderIntent.delete(sessionId);
    return null;
  }
  return entry;
}

// ── ORDER intent: route "order food from X" → focused order CTA ───────────────
// Patterns recognized: "order food from X", "order from X", "place an order at X",
// "i want to order [from X]", "get food from X", "i'd like to order [from X]",
// "order at X", "food from X".
const _ORDER_INTENT_RE = /\b(?:(?:i(?:'d| would| wanna| want to| 'd like to| would like to)?\s+(?:like\s+to\s+)?)?(?:place\s+an?\s+order|order(?:\s+(?:some\s+)?food)?|get\s+(?:some\s+)?food|grab\s+(?:some\s+)?food|food))\s+(?:from|at)\s+(.+?)$/i;

function detectOrderIntent(raw) {
  if (!raw) return { isOrder: false, name: null };
  const m = raw.trim().match(_ORDER_INTENT_RE);
  if (!m) {
    // Bare "i want to order" / "i'd like to order" with no business name
    if (/\b(?:i(?:'d| would)?\s+(?:like\s+to|want\s+to|wanna)\s+order)\b/i.test(raw)) {
      return { isOrder: true, name: null };
    }
    return { isOrder: false, name: null };
  }
  let name = (m[1] || '').trim();
  // Strip trailing "please" / "now" / punctuation / "in <zip>"
  name = name.replace(/\s+(?:please|now|today|tonight)\.?\s*$/i, '')
             .replace(/\s+in\s+\d{5}\s*$/i, '')
             .replace(/[?.!]+$/, '')
             .trim();
  return { isOrder: true, name: name || null };
}

// GET /api/local-intel/search?q=<name>&zip=<zip>&cat=<cat>&limit=20
// Direct Postgres business search — no MCP routing chain, no LLM, instant results.
// Used by the search UI for reliable name/category/ZIP lookups.
router.options('/search', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
router.get('/search', harvestGuard, async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const t0 = Date.now();
  const raw   = (req.query.q   || '').trim();
  let   zip   = (req.query.zip || '').trim() || null;
  let cat   = (req.query.cat || '').trim() || null;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  if (!raw && !zip && !cat) {
    return res.status(400).json({ error: 'q, zip, or cat required' });
  }

  try {
    const db = require('./lib/db');

    // ── ORDER_ITEM intent detection ────────────────────────────────────────────
    // Matches "order ITEM at BIZ" — user specifies an item. Frontend will then
    // fetch the menu and fuzzy-match. Checked BEFORE generic order-routing so
    // "order chicken and broccoli at McFlamingo" returns an item-search intent
    // (not the simple routing card).
    //
    // Two-turn flow: if only the item is given, we store a pending intent keyed
    // by sessionId and ask which restaurant. The next message ("at McFlamingo")
    // is resolved against the pending intent.
    const sessionId = (req.headers['x-session-id'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').toString().split(',')[0].trim() || null;

    // B145: Load conversation thread context for web sessions.
    // x-session-id from browser sessionStorage ties turns together within a tab.
    // Enables: ZIP carry-forward, referential resolution ("that place", "them"),
    // sub-category narrowing ("I need a doctor" → "for a mammogram").
    let _webThreadCtx = null;
    if (sessionId && raw) {
      _webThreadCtx = await getContext(sessionId, raw).catch(() => null);
      if (_webThreadCtx) {
        // Carry ZIP forward when user didn't supply one
        if (!zip && _webThreadCtx.zip) zip = _webThreadCtx.zip;
        // Carry category forward for sub-category narrowing
        if (!cat && _webThreadCtx.lastIntent) cat = _webThreadCtx.lastIntent;
      }
    }

    // Venue follow-up: "can I buy a ticket", "how do I get there", etc.
    // Resolves against the most-recent single venue result stored for this session.
    if (sessionId && raw) {
      const venueCtx = _getVenueContext(sessionId);
      if (venueCtx && _VENUE_FOLLOWUP_RE.test(raw)) {
        const v = venueCtx;
        const staticParts = [`${v.name} is your best bet.`];
        if (v.phone) staticParts.push(`Call them at ${v.phone}.`);
        if (v.website) staticParts.push(`Tickets and info at ${v.website}.`);
        if (v.address) staticParts.push(`Located at ${v.address}.`);
        const staticNarrative = staticParts.join(' ');

        let answer = staticNarrative;
        const tmKey = process.env.Ticketmaster_Consumer_Key;
        if (tmKey && v.name) {
          try {
            const tmUrl = `https://app.ticketmaster.com/discovery/v2/events.json?keyword=${encodeURIComponent(v.name)}&postalCode=${v.zip || '32082'}&size=3&apikey=${tmKey}`;
            const tmResp = await fetch(tmUrl, { signal: AbortSignal.timeout(3000) });
            if (tmResp.ok) {
              const tmData = await tmResp.json();
              const events = tmData && tmData._embedded && Array.isArray(tmData._embedded.events) ? tmData._embedded.events.slice(0, 3) : [];
              if (events.length) {
                const lines = [`Upcoming at ${v.name}:`];
                for (const ev of events) {
                  const artist = ev.name || 'TBA';
                  const localDate = ev.dates && ev.dates.start && ev.dates.start.localDate;
                  let when = 'TBA';
                  if (localDate) {
                    const d = new Date(localDate + 'T00:00:00');
                    if (!isNaN(d.getTime())) {
                      when = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
                    }
                  }
                  const url = ev.url || '';
                  lines.push(`• ${artist} — ${when}${url ? ` · Buy: ${url}` : ''}`);
                }
                const tail = `Call ${v.phone || '(904) 209-0881'} or visit ${v.website || 'https://www.pvconcerthall.com'} for more.`;
                answer = `${lines.join('\n')}\n${tail}`;
              }
            }
          } catch (_e) {
            // silent fallback to static narrative
          }
        }

        return res.json({
          ok: true,
          answer,
          results: [v],
          intent: { taskClass: 'entertainment', group: 'entertainment' },
          followUp: true,
          latency_ms: Date.now() - t0,
        });
      }
    }

    const _resolveOrderItem = async (itemQuery, bizNameInput) => {
      // Resolve alias (Tier 2 instant, Tier 1 DB) before business lookup.
      const aliasRes = await resolveBusinessAlias(bizNameInput);
      const bizName = aliasRes.canonical || bizNameInput;
      const pinnedBusinessId = aliasRes.business_id || null;
      let bizRows = [];
      if (pinnedBusinessId) {
        bizRows = await db.query(
          `SELECT business_id, name, zip
             FROM businesses
            WHERE business_id = $1 AND status != 'inactive'
            LIMIT 1`,
          [pinnedBusinessId]
        ).catch(err => { console.error('[order-item] pinned biz lookup error:', err.message); return []; });
      }
      const nameLike = `%${bizName}%`;
      if (!bizRows.length && zip) {
        bizRows = await db.query(
          `SELECT business_id, name, zip
             FROM businesses
            WHERE status != 'inactive'
              AND name ILIKE $1
              AND zip = $2
            ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
            LIMIT 1`,
          [nameLike, zip]
        );
      }
      if (!bizRows.length) {
        bizRows = await db.query(
          `SELECT business_id, name, zip
             FROM businesses
            WHERE status != 'inactive'
              AND name ILIKE $1
              AND zip BETWEEN '32004' AND '34997'
            ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
            LIMIT 1`,
          [nameLike]
        );
      }
      if (!bizRows.length) {
        logDeadEnd({
          query: raw || bizName || '',
          zip,
          channel: req.body?.channel || 'web',
          failReason: 'no_results',
          intentPath: 'ordering:no_biz',
          callerId: req.body?.From || req.body?.from || req.body?.phone || null,
        });
        return res.json({
          intent: 'order_not_found',
          message: `I couldn't find '${bizName}' in this area.`,
          latency_ms: Date.now() - t0,
        });
      }
      const b = bizRows[0];
      return res.json({
        intent:        'order_item_search',
        business_id:   b.business_id,
        business_name: b.name,
        item_query:    itemQuery,
        message:       `Looking up ${b.name}'s menu for '${itemQuery}'...`,
        latency_ms:    Date.now() - t0,
      });
    };

    if (raw) {
      const itemDetect = detectOrderItemIntent(raw);
      if (itemDetect.isOrderItem) {
        if (sessionId) _pendingOrderIntent.delete(sessionId);
        return _resolveOrderItem(itemDetect.itemQuery, itemDetect.bizName);
      }

      // Multi-business comma/and-separated list as follow-up reply to
      // "Which restaurant?" — look up each in parallel, return summary.
      // Checked BEFORE single-name _AT_BIZ_RE so a 5-name list isn't mangled
      // into a single failing biz lookup.
      if (sessionId) {
        const pendingForMulti = _getPendingOrderIntent(sessionId);
        if (pendingForMulti) {
          const multiBizNames = detectMultiBizList(raw);
          if (multiBizNames) {
            _pendingOrderIntent.delete(sessionId);
            const searchZips = zip ? [zip] : ['32082','32081','32250','32266','32233','32259','32034'];
            const bizResults = await lookupMultiBiz(db, multiBizNames, searchZips);
            const found    = bizResults.filter(r => r.found);
            const notFound = bizResults.filter(r => !r.found).map(r => r.queried);
            const resultBlocks = found.map(r => r.found);
            let message = found.length > 0
              ? `Found ${found.length} of ${multiBizNames.length} restaurants:`
              : `Couldn't find any of those restaurants in our network yet.`;
            if (notFound.length > 0) {
              message += ` (Not found: ${notFound.join(', ')})`;
            }
            if (found.length === 0) {
              logDeadEnd({
                query: raw,
                zip,
                channel: req.body?.channel || 'web',
                failReason: 'no_results',
                intentPath: `ordering:multi_biz:${notFound.join('|')}`,
                callerId: req.body?.From || req.body?.from || req.body?.phone || null,
              });
            }
            return res.json({
              ok: true,
              type: 'multi_biz_lookup',
              intent: 'multi_biz_lookup',
              message,
              results: resultBlocks,
              meta: {
                queried: multiBizNames,
                found_count: found.length,
                not_found: notFound,
                resolves_via: 'multi_biz_lookup',
                pending_item: pendingForMulti.item,
              },
              latency_ms: Date.now() - t0,
            });
          }
        }
      }

      // Business-only follow-up resolves a pending item.
      // Handles both "from McFlamingo" and bare "McFlamingo" when a pending intent exists.
      const atBiz = detectAtBiz(raw);
      if (atBiz.isAtBiz) {
        const pending = _getPendingOrderIntent(sessionId);
        if (pending) {
          _pendingOrderIntent.delete(sessionId);
          return _resolveOrderItem(pending.item, atBiz.bizName);
        }
      }
      // Bare name fallback: if pending intent exists and raw looks like just a business name
      // (no item-detection patterns), treat it as the restaurant selection.
      if (sessionId) {
        const pending = _getPendingOrderIntent(sessionId);
        if (pending && raw && raw.trim().length >= 2 && !atBiz.isAtBiz) {
          // Only treat as bare biz name if it doesn't match any other pattern
          const looksLikeBizName = !/\b(?:order|book|find|search|show|list|where|what|how|service|request|quote|rfq)\b/i.test(raw);
          if (looksLikeBizName) {
            _pendingOrderIntent.delete(sessionId);
            return _resolveOrderItem(pending.item, raw.trim());
          }
        }
      }

      // Item-only: store pending intent and ask which restaurant.
      const partial = detectOrderItemPartial(raw);
      if (partial.isPartial && sessionId) {
        _pendingOrderIntent.set(sessionId, { item: partial.itemQuery, ts: Date.now() });
        return res.json({
          intent: 'ORDER_ITEM_PARTIAL',
          item_query: partial.itemQuery,
          message: `Which restaurant would you like ${partial.itemQuery} from?`,
          latency_ms: Date.now() - t0,
        });
      }
    }

    // ── ORDER intent detection ─────────────────────────────────────────────────
    // Checked BEFORE service-request and name search so "order food from McFlamingo"
    // returns a focused order-start CTA (not a business list).
    if (raw) {
      const orderDetect = detectOrderIntent(raw);
      if (orderDetect.isOrder) {
        const reqIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown').toString().split(',')[0].trim();

        let bizRows = [];
        if (orderDetect.name) {
          const nameLike = `%${orderDetect.name}%`;
          if (zip) {
            bizRows = await db.query(
              `SELECT business_id, name, phone, menu_url, website, description,
                      address, zip, wallet, hours_json, category_intel
                 FROM businesses
                WHERE status != 'inactive'
                  AND name ILIKE $1
                  AND zip = $2
                ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
                LIMIT 1`,
              [nameLike, zip]
            );
          }
          if (!bizRows.length) {
            // Fall back to all NE FL ZIPs
            bizRows = await db.query(
              `SELECT business_id, name, phone, menu_url, website, description,
                      address, zip, wallet, hours_json, category_intel
                 FROM businesses
                WHERE status != 'inactive'
                  AND name ILIKE $1
                  AND zip BETWEEN '32004' AND '34997'
                ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
                LIMIT 1`,
              [nameLike]
            );
          }
        }

        if (!bizRows.length) {
          logDeadEnd({
            query: raw,
            zip,
            channel: req.body?.channel || 'web',
            failReason: 'no_results',
            intentPath: `ordering:no_biz:${orderDetect.name || 'unnamed'}`,
            callerId: req.body?.From || req.body?.from || req.body?.phone || null,
          });
          return res.json({
            intent: 'order_not_found',
            message: `I couldn't find a business called '${orderDetect.name || raw}' in this area.`,
            latency_ms: Date.now() - t0,
          });
        }

        const b = bizRows[0];

        // Log the routing event — never block the response on ledger errors.
        try {
          await db.query(
            `INSERT INTO usage_ledger (id, caller_id, zip, query_type, tool_name, cost_path_usd, called_at)
             VALUES (gen_random_uuid(), $1, $2, 'order_routing', $3, 0, NOW())`,
            [reqIp, b.zip || null, b.name]
          );
        } catch (ledgerErr) {
          console.error('[search order] usage_ledger insert error:', ledgerErr.message);
        }

        const ctaUrl = b.menu_url || b.website || null;

        return res.json({
          intent: 'order',
          business: {
            name:        b.name,
            phone:       b.phone        || '',
            address:     b.address      || '',
            zip:         b.zip          || '',
            description: b.description  || '',
            menu_url:    b.menu_url     || '',
            website:     b.website      || '',
            wallet:      b.wallet       || '',
          },
          message:        `Starting your order at ${b.name} — tap below to go to their menu.`,
          cta_label:      'Start Order →',
          cta_url:        ctaUrl,
          fallback_phone: b.phone || '',
          latency_ms:     Date.now() - t0,
        });
      }
    }

    // ── Service request detection: route natural-language requests to category search
    // Must happen before name matching so "I need my street light fixed" doesn't
    // match businesses with "need" in their name.
    if (raw) {
      const svcDetect = detectServiceRequest(raw);
      if (svcDetect.isRequest) {
        // ── Extract ZIP from query text if not supplied via filter ─────────────
        // e.g. "in ponte vedra" → 32082, "in nocatee" → 32081, bare 5-digit ZIP
        const PLACE_TO_ZIP = {
          'ponte vedra beach': '32082', 'ponte vedra': '32082', 'pvb': '32082',
          'nocatee': '32081', 'twenty mile': '32081',
          'jacksonville beach': '32250', 'jax beach': '32250',
          'neptune beach': '32266',
          'atlantic beach': '32233',
          'st johns': '32259', 'saint johns': '32259',
          'fernandina': '32034', 'fernandina beach': '32034', 'amelia island': '32034',
          'st augustine': '32084', 'saint augustine': '32084',
          'world golf': '32092', 'wgv': '32092',
        };
        // Neighboring ZIPs for fallback expansion (ordered by proximity)
        const ZIP_NEIGHBORS = {
          '32082': ['32081','32250','32266','32233','32259'],
          '32081': ['32082','32259','32250','32266','32092'],
          '32250': ['32266','32233','32082','32081','32256'],
          '32266': ['32250','32233','32082','32081','32256'],
          '32233': ['32266','32250','32082','32081','32256'],
          '32259': ['32081','32082','32092','32084','32084'],
          '32034': ['32082','32081','32259','32250','32266'],
          '32092': ['32081','32259','32084','32082','32256'],
          '32084': ['32080','32092','32259','32081','32082'],
        };
        const rawLower = (raw||'').toLowerCase();
        let resolvedZip = zip || null;
        if (!resolvedZip) {
          // Try bare 5-digit ZIP in text
          const zipMatch = rawLower.match(/(3[0-9]{4})/);
          if (zipMatch) {
            resolvedZip = zipMatch[1];
          } else {
            // Try place names
            for (const [place, z] of Object.entries(PLACE_TO_ZIP)) {
              if (rawLower.includes(place)) { resolvedZip = z; break; }
            }
          }
        }
        const resolvedCat = svcDetect.category;

        // ── Provider lookup with automatic neighbor expansion on zero results ──
        // B70: concept-aware ranking via zip_signals JOIN.
        const _svcConcept = detectConcept(raw || resolvedCat || '') || 'GENERAL';
        const _svcRanked  = buildConceptOrderBy(_svcConcept, 'zs', 'b');
        const SVC_PROVIDER_QUERY = `SELECT b.name, b.zip, b.address, b.city, b.phone, b.website, b.category, b.lat, b.lon,
                    b.confidence_score, b.claimed_at, b.wallet`;
        let providerCount = 0;
        let topProviders  = [];
        let actualZip     = resolvedZip; // may change to a neighbor ZIP
        if (resolvedCat) {
          // Helper: query providers for a given zip (null = all NE FL)
          const fetchProviders = async (z) => {
            const p = z ? [`%${resolvedCat}%`, z, 5] : [`%${resolvedCat}%`, 5];
            const clause = z ? ' AND b.zip = $2' : '';
            const lim = z ? '$3' : '$2';
            return db.query(
              SVC_PROVIDER_QUERY + ` FROM businesses b
               LEFT JOIN zip_signals zs ON zs.zip = b.zip
               WHERE b.status != 'inactive'
                 AND (b.category ILIKE $1 OR b.category_group ILIKE $1)${clause}
               ORDER BY ${_svcRanked}
               LIMIT ${lim}`, p
            );
          };

          let provRows = await fetchProviders(resolvedZip);

          // Zero results in specific ZIP → try each neighbor ZIP in order
          if (!provRows.length && resolvedZip && ZIP_NEIGHBORS[resolvedZip]) {
            for (const neighborZip of ZIP_NEIGHBORS[resolvedZip]) {
              provRows = await fetchProviders(neighborZip);
              if (provRows.length) { actualZip = neighborZip; break; }
            }
          }
          // Still zero → try all NE FL
          if (!provRows.length) {
            provRows = await fetchProviders(null);
            if (provRows.length) actualZip = null;
          }

          providerCount = provRows.length;
          topProviders  = provRows;
        }
        // (legacy path kept for shape compatibility below)
        if (false) { const provRows = await db.query(
            `SELECT name, zip, address, city, phone, website, category, lat, lon,
                    confidence_score, claimed_at, wallet
             FROM businesses
             WHERE status != 'inactive'
               AND (category ILIKE $1 OR category_group ILIKE $1)${zipClause}
             ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
             LIMIT ${lim}`,
            params
          );
          providerCount = provRows.length;
          topProviders  = provRows;
        }

        // Build a service-request narrative
        const catLabel   = resolvedCat ? resolvedCat.replace(/_/g, ' ') : 'service';
        let srNarrative;
        let jobCode = null;

        // ── Broadcast RFQ to all matching providers ──────────────────────────────
        // Web searches don't have a callerPhone, so we don't know who to call back.
        // We create the job anyway (for tracking) but skip the outbound callback.
        // The caller can see job status at thelocalintel.com/jobs/[code]
        if (resolvedCat) {
          try {
            const rfqBroadcast = require('./lib/rfqBroadcast');
            const { jobId, code } = await rfqBroadcast.createJob({
              callerPhone:  'web-search',
              callerName:   null,
              category:     resolvedCat,
              zip:          resolvedZip,
              description:  raw,
            });
            jobCode = code;
            // Fire broadcast non-blocking
            rfqBroadcast.broadcastJob({ jobId, code, callerName: null, category: resolvedCat, zip: resolvedZip, description: raw })
              .catch(e => console.error('[search svc-req] broadcastJob error:', e.message));
          } catch (rfqErr) {
            console.error('[search svc-req] RFQ create error:', rfqErr.message);
          }
        }

        if (providerCount > 0) {
          const topName  = topProviders[0].name;
          const expanded  = actualZip && resolvedZip && actualZip !== resolvedZip;
          const areaStr   = actualZip
            ? (expanded ? ` in nearby ${actualZip} (nearest available)` : ` in ${actualZip}`)
            : ' in Northeast Florida';
          srNarrative =
            `We found ${providerCount} verified ${catLabel} provider${providerCount > 1 ? 's' : ''}${areaStr} ` +
            `and notified them about your request${jobCode ? ' (Job ' + jobCode + ')' : ''}. ` +
            `Top match: ${topName}. Leave your email or phone below and we’ll send you their response.`;
        } else if (resolvedCat) {
          srNarrative =
            `We don’t have a verified ${catLabel} provider${resolvedZip ? ' in ' + resolvedZip + ' or nearby ZIPs' : ''} yet` +
            `${jobCode ? ' — but we logged your request as Job ' + jobCode + '.' : '.'} ` +
            `Leave your contact info below and we’ll reach out when one becomes available.`;
        } else {
          srNarrative =
            `We heard your request but couldn’t match it to a service category yet. ` +
            `Leave your email or phone number and describe what you need — we’ll route it to the right provider.`;
        }

        return res.json({
          type:         'service_request',
          query:        raw,
          zip:          resolvedZip,
          category:     resolvedCat,
          job_code:     jobCode,
          total:        providerCount,
          narrative:    srNarrative,
          contact_prompt: true,  // frontend: show email/phone collection widget
          results:    topProviders.map(r => ({
            name:       r.name,
            zip:        r.zip,
            address:    r.address  || '',
            city:       r.city     || '',
            phone:      r.phone    || '',
            website:    r.website  || '',
            category:   r.category || 'business',
            group:      r.category_group || 'services',
            lat:        r.lat  != null ? parseFloat(r.lat)  : null,
            lon:        r.lon  != null ? parseFloat(r.lon)  : null,
            confidence: r.confidence_score ? parseFloat(r.confidence_score) * 100 : 50,
            claimed:    !!r.claimed_at,
            wallet:     r.wallet || null,
          })),
          latency_ms: Date.now() - t0,
        });
      }
    }

    // ── NL intent → category (lib/intentMap.js — shared with voiceIntake) ──────
    let nlTags = null;
    let nlDeflect = false;
    let nlIntentResolved = false; // true if resolveIntent produced a cat from raw text
    let openIntent = null; // 'now' | 'late' | 'early' | 'weekend' | null
    if (raw) {
      openIntent = detectOpenIntent(raw);
      if (!cat) {
        const intent = resolveIntent(raw);
        if (intent.deflect) {
          nlDeflect = true;
        } else if (intent.cat) {
          cat    = intent.cat;
          nlTags = intent.tags || null;
          nlIntentResolved = true;
        }
      } else {
        nlIntentResolved = true; // caller supplied an explicit cat
      }
    }

    // Strip interrogative prefixes and about-business question patterns
    const INTERO = /^(?:where(?:\s+is)?|who(?:\s+is)?|what(?:\s+is)?|find(?:\s+me)?|show(?:\s+me)?|look\s+up|search(?:\s+for)?|tell\s+me\s+about|info(?:rmation)?\s+on|get\s+me)\s+/i;
    // Strip "what kind of X does Y do" → extract Y (business name)
    const ABOUT_BIZ_RE = /^(?:what\s+(?:kind\s+of\s+\S+|type\s+of\s+\S+|services?|work)\s+does\s+(.+?)\s+(?:do|offer|provide|specialize in|handle)[?]?$|(?:tell\s+me\s+about|info(?:rmation)?\s+(?:on|about))\s+(.+)$)/i;
    const aboutMatch = raw.match(ABOUT_BIZ_RE);
    const aboutName  = aboutMatch ? (aboutMatch[1] || aboutMatch[2] || '').trim() : null;
    const q = aboutName || raw.replace(INTERO, '').trim();
    const isAboutQuery = !!aboutName;

    // Stop words — never use these as standalone search tokens
    const PG_STOP = new Set(['for','the','and','near','in','at','of','a','an','show','me','find','get','list','what','where','who','how','is','are','there','does','do','kind','type','services','work','offer','provide','can','you','your','their','its','this','that','which']);

    // Florida ZIP prefix ranges for state-scoping fallback results
    const FL_ZIPS = (z) => { const n = parseInt(z,10); return n >= 32004 && n <= 34997; };

    // B70: aliased + LEFT JOIN zip_signals so concept-profile ORDER BY can read zs.*
    // signals. LEFT JOIN keeps businesses without a zip_signals row in results
    // (they sort with 0 contribution from zip-level factors).
    const BASE_SELECT = `SELECT b.name, b.zip, b.address, b.city, b.phone, b.website, b.category, b.category_group,
      b.description, b.tags, b.hours, b.hours_json, b.price_tier, b.services_text,
      b.lat, b.lon, b.confidence_score, b.claimed_at, b.wallet, b.status
      FROM businesses b
      LEFT JOIN zip_signals zs ON zs.zip = b.zip
      WHERE b.status != 'inactive'
      AND (b.confidence_score IS NULL OR b.confidence_score >= 0.35)
      AND NOT ('likely_person_not_business' = ANY(COALESCE(b.quality_flags, ARRAY[]::text[])))
      AND NOT ('seeded_placeholder' = ANY(COALESCE(b.quality_flags, ARRAY[]::text[])))`;

    // B70: concept-aware ORDER BY (zip_signals weighted by concept profile).
    const _searchConcept = detectConcept(q || raw || '') || 'GENERAL';
    const RANKED_ORDER = buildConceptOrderBy(_searchConcept, 'zs', 'b');

    // Deflect out-of-scope queries gracefully
    if (nlDeflect) {
      return res.json({
        ok: true, total: 0, returned: 0, results: [],
        type: 'out_of_scope',
        narrative: "That's a bit outside my lane — I'm built for finding local Florida businesses. Try asking me for a restaurant, landscaper, doctor, or any service you need nearby.",
        notable_businesses: [], latency_ms: Date.now() - t0,
      });
    }

    let rows = [];

    // 1. Exact/partial name match
    // Skip name search when NL_INTENT already resolved a category — go straight to cat search
    const skipNameSearch = !!cat && !aboutName;
    if (q && !skipNameSearch) {
      // Geo-guard: if no ZIP supplied, restrict to TARGET_ZIPS (our coverage area)
      // Only widen to statewide FL if still nothing found
      const zipWhere    = zip ? ` AND b.zip = $2 `                  : ` AND b.zip = ANY($2) `;
      const zipParam    = zip ? zip                                : TARGET_ZIPS;
      rows = await db.query(
        BASE_SELECT + zipWhere + ` AND (b.name ILIKE $1 OR b.services_text ILIKE $1 OR b.description ILIKE $1) ORDER BY ${RANKED_ORDER} LIMIT $3`,
        [`%${q}%`, zipParam, limit * 2]
      );

      // Widen to all FL only if coverage-area search returned nothing
      if (!rows.length) {
        rows = await db.query(
          BASE_SELECT + ` AND b.zip BETWEEN '32004' AND '34997' AND (b.name ILIKE $1 OR b.services_text ILIKE $1 OR b.description ILIKE $1) ORDER BY ${RANKED_ORDER} LIMIT $2`,
          [`%${q}%`, limit * 2]
        );
      }

      // Token fallback — skip short/stop tokens, try longest meaningful tokens first
      if (!rows.length) {
        const tokens = q.toLowerCase()
          .split(/\s+/)
          .filter(t => t.length >= 4 && !PG_STOP.has(t))
          .sort((a,b) => b.length - a.length); // longest first = most specific
        for (const tok of tokens) {
          const r = await db.query(
            BASE_SELECT + ` AND b.zip = ANY($1) AND (b.name ILIKE $2 OR b.services_text ILIKE $2 OR b.description ILIKE $2) ORDER BY ${RANKED_ORDER} LIMIT $3`,
            [TARGET_ZIPS, `%${tok}%`, limit * 2]
          );
          if (r.length) { rows = r; break; }
        }
      }

      // ── Name-search no-fallthrough guard ───────────────────────────────────
      // If the query looks like a specific business name (no intent resolved,
      // short query) and ILIKE/token name search came up empty, probe tsvector
      // too — and if that's also empty, return a clean 0-result message rather
      // than letting category expansion surface unrelated businesses.
      // Extend guard to 6 words — 'aqua grill in ponte vedra' is still a name search
      if (!rows.length && !nlIntentResolved && q && q.split(/\s+/).length <= 6) {
        let tsHits = [];
        try {
          const tsQuery = q.trim().split(/\s+/)
            .filter(t => t.length >= 2 && !PG_STOP.has(t.toLowerCase()))
            .map(t => t.replace(/[^a-zA-Z0-9]/g, '') + ':*')
            .filter(Boolean)
            .join(' & ');
          // Must have at least 2 meaningful tokens to avoid false positives
          // (single word like 'grill' would match unrelated Tampa businesses)
          const tokenCount = tsQuery.split(' & ').length;
          if (tsQuery && tokenCount >= 2) {
            // Probe only within user-supplied ZIP (or immediate neighbor, not all FL)
            const tsZipClause = zip ? ' AND zip = $2' : ' AND zip = ANY($2)';
            const tsZipParam  = zip ? zip : TARGET_ZIPS;
            tsHits = await db.query(
              `SELECT 1 FROM businesses
                WHERE status != 'inactive'
                  AND NOT ('likely_person_not_business' = ANY(COALESCE(quality_flags, ARRAY[]::text[])))
                  AND search_vector @@ to_tsquery('english', $1)${tsZipClause}
                LIMIT 1`,
              [tsQuery, tsZipParam]
            );
          }
        } catch (tsErr) {
          console.error('[/search] name-guard tsvector probe error:', tsErr.message);
        }
        if (!tsHits.length) {
          logDeadEnd({
            query: q,
            zip,
            channel: 'web',
            failReason: 'no_results',
            intentPath: 'search:name_not_found',
            callerId: null,
          });
          return res.json({
            ok: true, total: 0, returned: 0, results: [],
            intent: null,
            type: 'name_not_found',
            answer: `I couldn't find '${q}' near you. Try a different name or describe what you need.`,
            narrative: `I couldn't find '${q}' near you. Try a different name or describe what you need.`,
            notable_businesses: [], latency_ms: Date.now() - t0,
          });
        }
      }
    }

    // Category expansion map — dropdown slug → all DB category values
    const CAT_EXPAND = {
      restaurant:           ['restaurant','fast_food','cafe','bar','pub','bbq','pizza','seafood','sandwich','italian','asian','steakhouse','food_court','ice_cream','fast_casual_mexican','upscale_dining','barbecue_restaurant','LocalBusiness','coffee_chain','bakery','juice_bar','smoothie','wings','sushi','thai','mediterranean','greek','indian','chinese','mexican','burger','brunch','breakfast','diner','tapas','wine_bar','brewery','gastropub'],
      healthcare:           ['clinic','hospital','doctor','dentist','dental','pharmacy','urgent_care','therapist','veterinary','optometrist','chiropractor'],
      retail:               ['retail','clothes','shoes','electronics','grocery','supermarket','convenience','hardware_store','nutrition_supplements'],
      construction:         ['construction','contractor','builder','roofing','flooring','general_contractor'],
      professional_services:['law_firm','legal','accountant','consulting','marketing','insurance','insurance_agency'],
      landscaping:          ['landscaping','lawn_care','tree_service','irrigation','lawn','mowing','gardening'],
      cleaning:             ['cleaning','maid_service','janitorial','dry_cleaning'],
      hvac:                 ['hvac','heating','cooling','air_conditioning'],
      plumber:              ['plumber','plumbing'],
      electrician:          ['electrician','electrical'],
      real_estate:          ['real_estate','real_estate_agency','estate_agent','property_management'],
      finance:              ['finance','bank','bank_branch','atm','financial','mortgage','credit_union','investment'],
      auto_repair:          ['auto_repair','car_wash','car_repair','tire_shop','auto_parts','mechanic'],
      beauty:               ['beauty','hair_salon','barbershop','nail_salon','spa','hair_chain'],
      beauty_salon:         ['beauty_salon','barbershop','hair_salon','nail_salon','beauty','hair_chain'],
      education:            ['school','college','university','tutoring','childcare','daycare'],
      pizza:                ['pizza'],
      bar:                  ['bar','pub','wine_bar','brewery','gastropub'],
      cafe:                 ['cafe','coffee_chain','bakery'],
      gym:                  ['gym_chain','fitness_centre','yoga','crossfit'],
      entertainment:        ['concert_hall','music_venue','theatre','theater','amphitheatre','amphitheater','performing_arts','event_venue','community_centre','community_center','stadium','arena','nightclub','comedy_club','entertainment'],
      library:              ['library','public_library'],
      veterinary:           ['veterinary','pet_store','animal_hospital'],
      towing:               ['towing','roadside_assistance'],
      gas_station:          ['gas_station','fuel','petrol_station'],
      pharmacy:             ['pharmacy','chemist','drugstore'],
      clinic:               ['clinic','doctor','urgent_care','medical_clinic','primary_care'],
      financial_advisor:    ['financial_advisor','finance','wealth_management'],
      insurance_agency:     ['insurance_agency','insurance'],
      grocery:              ['grocery','supermarket','food_store'],
      hotel:                ['hotel','upscale_hotel','motel','inn'],
      handyman:             ['handyman','home_repair','general_contractor'],
      dry_cleaning:         ['dry_cleaning','laundromat','laundry'],
      clothes:              ['clothes','clothing','apparel','retail'],
    };

    // 2. Category search (ZIP-scoped if provided)
    if (!rows.length && (cat || q)) {
      const term  = cat || q;
      const expanded = CAT_EXPAND[term];
      let catWhere, catParams;
      if (expanded && expanded.length) {
        // nlTags: if NL_INTENT returned tag hints (e.g. healthy/vegan), try tag-filtered first
        if (nlTags && nlTags.length) {
          const tagRows = await db.query(
            BASE_SELECT +
            (zip ? ` AND b.category = ANY($1) AND b.zip = $2 AND b.tags && $3 ORDER BY ${RANKED_ORDER} LIMIT $4`
                 : ` AND b.category = ANY($1) AND b.zip = ANY($2) AND b.tags && $3 ORDER BY ${RANKED_ORDER} LIMIT $4`),
            zip ? [expanded, zip, nlTags, limit] : [expanded, TARGET_ZIPS, nlTags, limit]
          );
          if (tagRows.length) rows = tagRows;
        }
        // Fall through to unfiltered cat search if tag-filtered returned nothing
        if (!rows.length) {
          if (zip) {
            catWhere  = ` AND b.category = ANY($1) AND b.zip = $2 ORDER BY ${RANKED_ORDER} LIMIT $3`;
            catParams = [expanded, zip, limit];
          } else {
            // Geo-guard: restrict to TARGET_ZIPS coverage area
            catWhere  = ` AND b.category = ANY($1) AND b.zip = ANY($2) ORDER BY ${RANKED_ORDER} LIMIT $3`;
            catParams = [expanded, TARGET_ZIPS, limit];
          }
          rows = await db.query(BASE_SELECT + catWhere, catParams);
        }
      } else {
        const params = zip
          ? [`%${term}%`, zip, limit]
          : [`%${term}%`, TARGET_ZIPS, limit];
        const zipClause = zip ? ' AND b.zip = $2' : ' AND b.zip = ANY($2)';
        const lim = '$3';
        rows = await db.query(
          BASE_SELECT + ` AND (b.category ILIKE $1 OR b.category_group ILIKE $1 OR b.name ILIKE $1)${zipClause}
          ORDER BY ${RANKED_ORDER} LIMIT ${lim}`,
          params
        );
      }

      // ── tsvector fallback (GET /search path) ─────────────────────────────
      // Mirrors the POST handler's Path B. Fires when ILIKE / category search
      // returns nothing. Enforces TARGET_ZIPS geo guard.
      if (!rows.length && q) {
        const tsQuery = q.trim().split(/\s+/)
          .filter(t => t.length >= 2 && !PG_STOP.has(t.toLowerCase()))
          .map(t => t.replace(/[^a-zA-Z0-9]/g, '') + ':*')
          .join(' & ');
        if (tsQuery) {
          const tsZipClause = zip ? ' AND b.zip = $2' : ' AND b.zip = ANY($2)';
          const tsZipParam  = zip ? zip : TARGET_ZIPS;
          try {
            rows = await db.query(
              `SELECT b.name, b.zip, b.address, b.city, b.phone, b.website, b.category, b.category_group,
                b.description, b.tags, b.hours, b.hours_json, b.price_tier, b.services_text,
                b.lat, b.lon, b.confidence_score, b.claimed_at, b.wallet, b.status,
                ts_rank(b.search_vector, to_tsquery('english', $1)) AS _rank
               FROM businesses b
               LEFT JOIN zip_signals zs ON zs.zip = b.zip
               WHERE b.status != 'inactive'
                 AND NOT ('likely_person_not_business' = ANY(COALESCE(b.quality_flags, ARRAY[]::text[])))
                 AND b.search_vector @@ to_tsquery('english', $1)${tsZipClause}
               ORDER BY _rank DESC, ${RANKED_ORDER}
               LIMIT $3`,
              [tsQuery, tsZipParam, limit]
            );
          } catch (tsErr) {
            console.error('[/search] tsvector fallback error:', tsErr.message);
          }
        }
      }
    }

    // 3. ZIP-only browse
    if (!rows.length && zip) {
      rows = await db.query(
        BASE_SELECT + ` AND b.zip = $1 ORDER BY ${RANKED_ORDER} LIMIT $2`,
        [zip, limit]
      );
    }

    // Proximity sort if we have a ZIP and results have coords
    if (zip && rows.length > 1) {
      try {
        const centroid = await db.query(
          'SELECT AVG(lat) AS clat, AVG(lon) AS clon FROM businesses WHERE zip = $1 AND lat IS NOT NULL AND lon < -60',
          [zip]
        );
        const clat = parseFloat(centroid[0]?.clat);
        const clon = parseFloat(centroid[0]?.clon);
        if (!isNaN(clat) && !isNaN(clon)) {
          rows.sort((a, b) => {
            const da = (a.lat && a.lon) ? Math.pow(a.lat-clat,2)+Math.pow(a.lon-clon,2) : 999;
            const db2 = (b.lat && b.lon) ? Math.pow(b.lat-clat,2)+Math.pow(b.lon-clon,2) : 999;
            return da - db2;
          });
        }
      } catch(_) {}
    }

    // ── Tier 3: Wallet priority — re-apply after proximity sort (stable, preserves distance within each tier)
    if (rows.length > 1) {
      // Stable sort: wallet businesses float to top, distance order preserved within each tier
      const withWallet    = rows.filter(r => r.wallet);
      const withoutWallet = rows.filter(r => !r.wallet);
      rows = [...withWallet, ...withoutWallet];
    }
    // ── Tier 4: Open-now filter ────────────────────────────────────
    // If the query contains open-now/late/early intent AND we have hours_json data,
    // filter to only open businesses. Fall back to full list if filter leaves < 3.
    if (openIntent && rows.length > 0) {
      const DAYS_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
      const now = new Date();
      const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const et = new Date(etStr);
      const jsDay = et.getDay(); // 0=Sun
      const ourDay = jsDay === 0 ? 6 : jsDay - 1;
      const todayName   = DAYS_FULL[ourDay];
      const tomorrowName = DAYS_FULL[(ourDay + 1) % 7];
      const nowMins = et.getHours() * 60 + et.getMinutes();

      const filtered = rows.filter(r => {
        if (!r.hours_json) return false;
        const hj = typeof r.hours_json === 'string' ? JSON.parse(r.hours_json) : r.hours_json;
        if (hj._unparseable) return false;

        const checkDay = (dayName) => {
          const entry = hj[dayName];
          if (!entry || !entry.open) return false;
          if (!entry.from) return true; // open, no specific hours
          const [fh, fm] = entry.from.split(':').map(Number);
          const [th, tm] = entry.to.split(':').map(Number);
          const fromMins = fh * 60 + fm;
          const toMins   = th * 60 + tm;
          return nowMins >= fromMins && nowMins < toMins;
        };

        if (openIntent === 'now')  return checkDay(todayName);
        if (openIntent === 'late') {
          // Open late = closes after 9pm (21:00)
          const entry = hj[todayName];
          if (!entry || !entry.open || !entry.to) return false;
          const [th, tm] = entry.to.split(':').map(Number);
          return (th * 60 + tm) >= 21 * 60;
        }
        if (openIntent === 'early') {
          const entry = hj[todayName];
          if (!entry || !entry.open || !entry.from) return false;
          const [fh] = entry.from.split(':').map(Number);
          return fh <= 8; // opens at or before 8am
        }
        if (openIntent === 'weekend') {
          const sat = hj['Saturday'], sun = hj['Sunday'];
          return (sat && sat.open) || (sun && sun.open);
        }
        return true;
      });

      // Only apply filter if it returns meaningful results; otherwise keep full list
      if (filtered.length >= 2) rows = filtered;
    }

    // Dedupe: same business may appear under multiple rows from different data sources.
    // Strategy: a row is a duplicate if ANY of these keys match a previously seen row:
    //   1. name + phone (same biz, same number)
    //   2. name + normalized street address (same biz, same street)
    //   3. name + lat/lon rounded to 3dp (same biz, essentially same pin)
    // When duplicates exist, the row with more data (wallet > claimed > website > phone) wins.
    // Pre-sort so richest rows come first (wallet > claimed_at > website > phone > address).
    rows.sort((a, b) => {
      const score = r => (r.wallet ? 8 : 0) + (r.claimed_at ? 4 : 0) + (r.website ? 2 : 0) + (r.phone ? 1 : 0);
      return score(b) - score(a);
    });
    const _seenPhone   = new Set();
    const _seenAddr    = new Set();
    const _seenLatLon  = new Set();
    const normName = n => (n||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    const normAddr = a => (a||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,25);
    const normPhone = p => (p||'').replace(/\D/g,'').slice(-10);
    rows = rows.filter(r => {
      const nm = normName(r.name);
      const ph = normPhone(r.phone);
      const ad = normAddr(r.address);
      const ll = `${r.lat ? parseFloat(r.lat).toFixed(3) : 'x'}|${r.lon ? parseFloat(r.lon).toFixed(3) : 'x'}`;
      // Phone alone is a strong unique key — two different businesses rarely share a number
      const kPhone  = (ph && ph.length >= 10)  ? ph                 : null;
      // Address needs name prefix to avoid false matches (e.g. strip mall same address)
      const kAddr   = (ad && ad.length >= 6)   ? `${nm}|${ad}`      : null;
      // Lat/lon at 3dp ~111m radius — same name at same pin = duplicate
      const kLatLon = (r.lat && r.lon)          ? `${nm}|${ll}`      : null;
      if (kPhone  && _seenPhone.has(kPhone))   return false;
      if (kAddr   && _seenAddr.has(kAddr))     return false;
      if (kLatLon && _seenLatLon.has(kLatLon)) return false;
      if (kPhone)  _seenPhone.add(kPhone);
      if (kAddr)   _seenAddr.add(kAddr);
      if (kLatLon) _seenLatLon.add(kLatLon);
      return true;
    });

    const results = rows.slice(0, limit).map(r => ({
      name:          r.name,
      zip:           r.zip,
      address:       r.address       || '',
      city:          r.city          || '',
      phone:         r.phone         || '',
      website:       r.website       || '',
      category:      r.category      || 'business',
      group:         r.category_group || 'services',
      description:   r.description   || '',
      services_text: r.services_text || '',
      tags:          r.tags          || [],
      hours:         r.hours         || '',
      hours_json:    r.hours_json    || null,
      price_tier:    r.price_tier    || null,
      lat:           r.lat  != null ? parseFloat(r.lat)  : null,
      lon:           r.lon  != null ? parseFloat(r.lon)  : null,
      confidence:    r.confidence_score ? parseFloat(r.confidence_score) * 100 : 50,
      claimed:       !!r.claimed_at,
      wallet:        r.wallet || null,
    }));

    // ── Narrative: "what is X" / "tell me about X" intent ──────────────────
    // Only when 1-2 results and query has about-intent — deterministic, no LLM
    let narrative = null;
    const ABOUT_INTENT = /^(?:what(?:\s+is|\s+are)?|tell\s+me\s+about|who\s+is|describe|about)\s+/i;
    const hasAboutIntent = ABOUT_INTENT.test(raw) || isAboutQuery;

    if (hasAboutIntent && results.length >= 1) {
      try {
        // Fetch rich fields for the top result (name match is already proven)
        const topName = results[0].name;
        const richRows = await db.query(
          `SELECT name, description, tags, hours_json, menu_url, website, address, city, zip,
                  phone, category, claimed_at
           FROM businesses
           WHERE name ILIKE $1 AND status != 'inactive'
           ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
           LIMIT 1`,
          [`%${topName}%`]
        );

        if (richRows.length) {
          const b = richRows[0];
          const parts = [];

          // Opening: name + description or fallback
          const desc = b.description || null;
          const tags = Array.isArray(b.tags) ? b.tags : (b.tags ? JSON.parse(b.tags) : []);

          // Build opening sentence
          let opening = b.name;
          const honorifics = tags.filter(t => ['best_of_ponte_vedra','award_winner','local_favorite','featured'].includes(t));
          if (honorifics.length) {
            const labelMap = {
              best_of_ponte_vedra: 'voted Best of Ponte Vedra',
              award_winner: 'an award winner',
              local_favorite: 'a local favorite',
              featured: 'a featured local business',
            };
            opening += ' is ' + honorifics.map(h => labelMap[h] || h).join(', ');
          } else if (b.category) {
            opening += ` is a ${b.category.toLowerCase()} in ${b.city || 'Northeast Florida'}`;
          }
          if (desc) {
            parts.push(`${opening}. ${desc}`);
          } else {
            parts.push(`${opening}.`);
          }

          // Tags line (skip honorifics already used, skip internal tags)
          const SKIP_TAGS = new Set(['best_of_ponte_vedra','award_winner','local_favorite','featured']);
          const displayTags = tags.filter(t => !SKIP_TAGS.has(t)).map(t => t.replace(/_/g,' '));
          if (displayTags.length) {
            parts.push(`Known for: ${displayTags.join(', ')}.`);
          }

          // Address
          if (b.address) {
            const addrLine = [b.address, b.city].filter(Boolean).join(', ');
            parts.push(`Located at ${addrLine}, FL ${b.zip || ''}.`);
          }

          // Hours summary (today's hours if hours_json present)
          if (b.hours_json) {
            try {
              const hj = typeof b.hours_json === 'string' ? JSON.parse(b.hours_json) : b.hours_json;
              const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const todayName = DAYS[new Date().getDay()];
              const todayHours = hj[todayName];
              if (todayHours && todayHours.open) {
                parts.push(`Open today (${todayName}): ${todayHours.from} – ${todayHours.to}.`);
              } else if (todayHours && !todayHours.open) {
                // Find next open day
                let nextOpen = null;
                for (let i = 1; i <= 6; i++) {
                  const d = DAYS[(new Date().getDay() + i) % 7];
                  if (hj[d] && hj[d].open) { nextOpen = `${d} ${hj[d].from}–${hj[d].to}`; break; }
                }
                parts.push(nextOpen ? `Closed today — next open ${nextOpen}.` : 'Closed today.');
              }
            } catch(_) {}
          }

          // Online ordering / menu
          if (b.menu_url) {
            parts.push(`Order online: ${b.menu_url}`);
          } else if (b.website) {
            parts.push(`Website: ${b.website}`);
          }

          if (parts.length) narrative = parts.join(' ');
        }
      } catch (narrativeErr) {
        console.error('[/search] narrative build error:', narrativeErr.message);
        // Non-fatal — narrative just stays null
      }
    }
    // ── end narrative ────────────────────────────────────────────────────────

    // Brief narrative for ZIP-only queries (no search term, no category filter)
    let notableBusinesses = [];
    if (zip && !raw && !cat) {
      try {
        const briefRow = await pgStore.getZipBrief(zip);
        if (briefRow) {
          const brief = briefRow.brief_json || briefRow;
          narrative = narrative || brief.narrative || null;
          notableBusinesses = brief.notable_businesses || [];
        }
      } catch (_) {}
    }

    // ── Gap + resolution logging (same pattern as POST handler) ────────────────
    // Every GET /search query is recorded so the system knows its own success rate.
    // 0-result queries become gap signals for acquisition intelligence.
    if (raw || cat) {
      const intentGroup = cat || (nlTags && nlTags[0]) || 'general';
      const resolved    = results.length > 0;
      // fire-and-forget — never block the response
      recordResolution({
        query:      raw || cat || '',
        intent:     { taskClass: cat ? 'CATEGORY_SEARCH' : 'TEXT_SEARCH', group: intentGroup, cuisine: null },
        zip:        zip || null,
        resolved,
        resolvedVia: resolved ? 'search' : null,
        resultCount: results.length,
        startTime:  t0,
      });
      if (!resolved) {
        // Write to rfq_gaps so routerLearningWorker can surface acquisition targets
        // Schema: vertical, zip, prompt, tool (rfq_gaps PRIMARY KEY = vertical+zip+prompt)
        db.query(
          `INSERT INTO rfq_gaps (vertical, zip, prompt, tool, last_ts)
           VALUES ($1, $2, $3, 'get_search', NOW())
           ON CONFLICT (vertical, zip, prompt) DO UPDATE SET last_ts = NOW()`,
          [intentGroup, zip || 'unknown', raw || cat || '']
        ).catch(e => console.error('[/search] rfq_gaps insert error:', e.message));
        console.warn(`[GAP /search] unresolved: "${raw || cat}" zip=${zip || 'none'} group=${intentGroup}`);
      }
    }

    // Store venue context for follow-up questions (e.g. "can I buy a ticket")
    if (sessionId && results.length === 1) {
      const r = results[0];
      const venueCategories = ['concert_hall','music_venue','theatre','theater','amphitheatre','amphitheater','community_centre','entertainment','nightclub','comedy_club','stadium','arena'];
      if (venueCategories.includes(r.category) || r.group === 'entertainment') {
        _pendingVenueContext.set(sessionId, { ...r, ts: Date.now() });
      }
    }

    // B145: Append both turns to conversation thread so next query has context.
    // Fire-and-forget — never block the response.
    if (sessionId && raw) {
      const _resolvedIntent = cat || (nlTags && nlTags[0]) || 'general';
      const _topName = results[0]?.name || null;
      const _topId   = results[0]?.business_id || null;
      appendTurn({
        callerId: sessionId, channel: 'web', role: 'user',
        content: raw, zip: zip || null, intent: _resolvedIntent,
      }).catch(() => {});
      appendTurn({
        callerId: sessionId, channel: 'web', role: 'system',
        content: narrative || (results.length ? `Found ${results.length} results` : 'No results'),
        zip: zip || null, intent: _resolvedIntent,
        businessId:   _topId,
        businessName: _topName,
        resolvesVia:  results.length ? 'search' : 'no_results',
      }).catch(() => {});
    }

    return res.json({
      ok:            true,
      total:         results.length,
      returned:      results.length,
      query:         q || null,
      zip:           zip || null,
      category:      cat || null,
      detected_cat:  cat || null,   // echoes NL-detected category for UI
      nl_tags:       nlTags || [],  // tag hints used for filtering
      latency_ms:    Date.now() - t0,
      narrative,
      notable_businesses: notableBusinesses,
      results,
    });
  } catch (e) {
    console.error('[/search] error:', e.message);
    return res.status(500).json({ error: e.message, results: [] });
  }
});

// ── Business Profile + Tasks API ────────────────────────────────────────────
// Internal-use endpoints for the LocalIntel enrichment + tasks layer.
// All routes deterministic, no LLM. business_tasks table seeded by taskSeedWorker.

router.get('/profile/:business_id', async (req, res) => {
  const { business_id } = req.params;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const biz = await db.queryOne(
      `SELECT * FROM businesses WHERE business_id = $1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const tasks = await db.query(
      `SELECT id, business_id, title, status, task_type, template_key,
              metadata, created_at, updated_at
         FROM business_tasks
        WHERE business_id = $1
        ORDER BY created_at ASC`,
      [business_id]
    );

    const summary = { total: tasks.length, pending: 0, done: 0, skipped: 0 };
    for (const t of tasks) {
      if (t.status === 'pending') summary.pending++;
      else if (t.status === 'done') summary.done++;
      else if (t.status === 'skipped') summary.skipped++;
    }

    res.json({ business: biz, tasks, task_summary: summary });
  } catch (e) {
    console.error('[/profile] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/tasks/:business_id', async (req, res) => {
  const { business_id } = req.params;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const biz = await db.queryOne(
      `SELECT business_id FROM businesses WHERE business_id = $1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const tasks = await db.query(
      `SELECT id, business_id, title, status, task_type, template_key,
              metadata, created_at, updated_at
         FROM business_tasks
        WHERE business_id = $1
        ORDER BY created_at ASC`,
      [business_id]
    );
    res.json({ business_id, tasks });
  } catch (e) {
    console.error('[/tasks GET] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/tasks/:business_id', express.json(), async (req, res) => {
  const { business_id } = req.params;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  const { id, title, status, task_type, template_key, metadata } = req.body || {};
  try {
    const biz = await db.queryOne(
      `SELECT business_id FROM businesses WHERE business_id = $1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    if (id) {
      const updated = await db.queryOne(
        `UPDATE business_tasks
            SET title = COALESCE($3, title),
                status = COALESCE($4, status),
                task_type = COALESCE($5, task_type),
                template_key = COALESCE($6, template_key),
                metadata = COALESCE($7, metadata),
                updated_at = NOW()
          WHERE id = $1 AND business_id = $2
          RETURNING *`,
        [
          id, business_id, title || null, status || null,
          task_type || null, template_key || null,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );
      if (!updated) return res.status(404).json({ error: 'task not found' });
      return res.json(updated);
    }

    if (!title) return res.status(400).json({ error: 'title required' });
    const created = await db.queryOne(
      `INSERT INTO business_tasks (business_id, title, status, task_type, template_key, metadata)
       VALUES ($1, $2, COALESCE($3,'pending'), COALESCE($4,'setup'), $5, $6)
       RETURNING *`,
      [
        business_id, title, status || null, task_type || null,
        template_key || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    res.json(created);
  } catch (e) {
    console.error('[/tasks POST] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/tasks/:business_id/:task_id', express.json(), async (req, res) => {
  const { business_id, task_id } = req.params;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    const updated = await db.queryOne(
      `UPDATE business_tasks
          SET status = $3, updated_at = NOW()
        WHERE id = $2 AND business_id = $1
        RETURNING *`,
      [business_id, task_id, status]
    );
    if (!updated) return res.status(404).json({ error: 'task not found' });
    res.json(updated);
  } catch (e) {
    console.error('[/tasks PATCH] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Agentic Food Order flow: menu fetch + place order + status poll ─────────
// Mounted at /api/local-intel/{menu,place-order,order-status}
// Backed by Basalt inventory + orders API (Surge). All deterministic (no LLM).
const _BASALT_BASE = 'https://surge.basalthq.com';

// GET /api/local-intel/menu/:business_id?q=<item-query>
// Fetches Basalt inventory for the business's wallet. If q is provided, returns
// top-3 fuzzy matches (token-overlap) sorted by score desc. Otherwise returns all.
router.get('/menu/:business_id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { business_id } = req.params;
  const q = (req.query.q || '').trim();
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  const surge = require('./lib/surgeAgent');

  try {
    const [biz] = await db.query(
      `SELECT business_id, name, wallet, pos_config
         FROM businesses
        WHERE business_id = $1
        LIMIT 1`,
      [business_id]
    );
    if (!biz)        return res.status(404).json({ error: 'business not found' });
    if (!biz.wallet) return res.status(409).json({ error: 'business has no wallet — ordering unavailable' });

    let menuData;
    try {
      menuData = await surge.fetchMenu(business_id);
    } catch (fetchErr) {
      console.error(`[menu] surge.fetchMenu failed: ${fetchErr.message}`);
      return res.status(502).json({ error: 'inventory fetch failed' });
    }
    const rawItems = Array.isArray(menuData) ? menuData : (menuData.items || menuData.data || []);

    // Skip $0 modifier items — they're add-ons/dressings, not orderable as a top-level item.
    const items = rawItems
      .filter(it => Number(it.priceUsd ?? it.price_usd ?? it.price ?? 0) > 0)
      .map(it => ({
        sku:      it.sku || it.SKU || it.id || '',
        name:     it.name || it.title || '',
        priceUsd: Number(it.priceUsd ?? it.price_usd ?? it.price ?? 0),
        category: it.category || it.cat || '',
      }))
      .filter(it => it.sku && it.name);

    // Fuzzy match by token overlap if q provided
    if (q) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
      const STOP = new Set(['and','or','the','a','an','of','on','in','with','to','for']);
      const tok  = (s) => norm(s).split(' ').filter(t => t && !STOP.has(t));
      const qToks = tok(q);
      const scored = items
        .map(it => {
          const nToks = new Set(tok(it.name));
          let score = 0;
          for (const t of qToks) if (nToks.has(t)) score++;
          return { ...it, _score: score };
        })
        .filter(it => it._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 3)
        .map(({ _score, ...rest }) => rest);

      if (scored.length) {
        return res.json({ items: scored, query: q, matched: true });
      }
      return res.json({ items, query: q, matched: false });
    }

    return res.json({ items, query: null, matched: false });
  } catch (err) {
    console.error('[menu]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/local-intel/place-order
// Body: { business_id, sku, qty, fulfillment }
router.post('/place-order', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { business_id, sku, qty, fulfillment, jurisdictionCode } = req.body || {};
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!sku)         return res.status(400).json({ error: 'sku required' });
  if (fulfillment !== 'pickup' && fulfillment !== 'delivery') {
    return res.status(400).json({ error: 'fulfillment must be pickup or delivery' });
  }
  const surge = require('./lib/surgeAgent');

  try {
    const [biz] = await db.query(
      `SELECT business_id, name, zip, hours_json FROM businesses WHERE business_id = $1 LIMIT 1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    // Check business hours — don't attempt order if closed (fail open if hours unknown)
    const hoursJson = biz.hours_json || null;
    if (hoursJson) {
      const open = isOpenNow(hoursJson);
      if (open === false) {
        return res.status(409).json({
          error: 'business_closed',
          message: `${biz.name} is currently closed. Check their hours and try again.`,
          hours: hoursJson,
        });
      }
    }

    let order;
    try {
      order = await surge.createOrder(
        business_id,
        [{ sku, qty: Number(qty) || 1 }],
        jurisdictionCode || 'US-FL'
      );
    } catch (orderErr) {
      console.error(`[place-order] surge.createOrder failed: ${orderErr.message}`);
      return res.status(502).json({ error: 'order creation failed' });
    }
    const receiptId  = order?.receiptId || order?.receipt?.receiptId || order?.id;
    if (!receiptId) {
      console.error('[place-order] missing receiptId', order);
      return res.status(502).json({ error: 'order created but no receiptId returned' });
    }
    const paymentUrl = surge.getPaymentUrl(receiptId);

    // Log to usage_ledger — non-blocking on failure
    try {
      const reqIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown').toString().split(',')[0].trim();
      await db.query(
        `INSERT INTO usage_ledger (id, caller_id, zip, query_type, tool_name, cost_path_usd, called_at)
         VALUES (gen_random_uuid(), $1, $2, 'food_order', $3, 0, NOW())`,
        [reqIp, biz.zip || null, biz.name]
      );
    } catch (ledgerErr) {
      console.error('[place-order] usage_ledger insert error:', ledgerErr.message);
    }

    return res.json({ receiptId, paymentUrl, fulfillment });
  } catch (err) {
    console.error('[place-order]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/order-status/:receiptId
router.get('/order-status/:receiptId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { receiptId } = req.params;
  if (!receiptId) return res.status(400).json({ error: 'receiptId required' });
  const business_id = (req.query.business_id || '').toString().trim();
  if (!business_id) return res.status(400).json({ error: 'business_id query param required' });
  const surge = require('./lib/surgeAgent');

  try {
    let data;
    try {
      data = await surge.getReceiptStatus(business_id, receiptId);
    } catch (statusErr) {
      console.error(`[order-status] surge.getReceiptStatus failed: ${statusErr.message}`);
      return res.status(502).json({ error: 'status fetch failed' });
    }
    const PAID_STATUSES = ['completed', 'tx_mined', 'recipient_validated', 'paid'];
    const paid = PAID_STATUSES.includes(data?.status);

    if (paid) {
      // 0.5% routing fee placeholder — applied to most recent food_order for this caller.
      try {
        const reqIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown').toString().split(',')[0].trim();
        await db.query(
          `UPDATE usage_ledger
              SET cost_path_usd = 0.005
            WHERE id = (
              SELECT id FROM usage_ledger
               WHERE caller_id = $1 AND query_type = 'food_order'
               ORDER BY called_at DESC
               LIMIT 1
            )`,
          [reqIp]
        );
      } catch (ledgerErr) {
        console.error('[order-status] usage_ledger update error:', ledgerErr.message);
      }
    }

    return res.json({ paid, status: data?.status || null, receiptId });
  } catch (err) {
    console.error('[order-status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/gaps — top unresolved queries (internal dashboard) ──
// Groups unresolved tasks by intent (top_category) + query (user_query) + zip so
// the team can see what the agent network has not yet been able to resolve.
// "Unresolved" = status NOT IN ('completed','failed','cancelled') — covers
// 'open','assigned','accepted','in_progress'. No auth — internal only.
router.get('/gaps', async (req, res) => {
  try {
    const db = require('./lib/db');
    const rows = await db.query(`
      SELECT
        top_category    AS intent,
        user_query      AS query,
        zip,
        COUNT(*)        AS occurrences,
        MAX(created_at) AS last_seen
      FROM tasks
      WHERE status NOT IN ('completed','failed','cancelled')
      GROUP BY top_category, user_query, zip
      ORDER BY occurrences DESC, last_seen DESC
      LIMIT 50
    `);
    res.json({ gaps: rows, total: rows.length });
  } catch (err) {
    console.error('[local-intel gaps]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/resolution-stats — Step 3 — system-wide resolution rate
router.get('/resolution-stats', async (req, res) => {
  try {
    const [totals] = await db.query(`
      SELECT
        COUNT(*)                                          AS total_queries,
        COUNT(*) FILTER (WHERE resolved = true)          AS resolved_count,
        ROUND(
          COUNT(*) FILTER (WHERE resolved = true)::numeric
          / NULLIF(COUNT(*),0) * 100, 1
        )                                                AS resolution_rate_pct,
        ROUND(AVG(response_ms) FILTER (WHERE response_ms IS NOT NULL))
                                                         AS avg_response_ms
      FROM resolution_history
    `);

    const byGroup = await db.query(`
      SELECT
        intent_group,
        COUNT(*)                                         AS total,
        COUNT(*) FILTER (WHERE resolved = true)         AS resolved
      FROM resolution_history
      WHERE intent_group IS NOT NULL
      GROUP BY intent_group
      ORDER BY total DESC
    `);

    const topGaps = await db.query(`
      SELECT query, zip, COUNT(*) AS occurrences, MAX(created_at) AS last_seen
      FROM resolution_history
      WHERE resolved = false
      GROUP BY query, zip
      ORDER BY occurrences DESC, last_seen DESC
      LIMIT 20
    `);

    res.json({
      total_queries:       Number(totals.total_queries),
      resolved:            Number(totals.resolved_count),
      resolution_rate:     totals.resolution_rate_pct + '%',
      avg_response_ms:     Number(totals.avg_response_ms),
      by_group:            byGroup,
      top_gaps:            topGaps
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/acquisition-targets — Step 7 — surface unresolved demand
// as actionable acquisition signal (intent_group + cuisine + zip aggregations).
router.get('/acquisition-targets', async (req, res) => {
  try {
    const targets = await db.query(`
      SELECT
        intent_group,
        cuisine,
        zip,
        COUNT(*)                    AS demand_count,
        MAX(created_at)             AS last_asked,
        CASE
          WHEN COUNT(*) >= 5 THEN 'high'
          WHEN COUNT(*) >= 2 THEN 'medium'
          ELSE 'low'
        END                         AS priority
      FROM resolution_history
      WHERE resolved = false
        AND intent_group IS NOT NULL
        AND zip IS NOT NULL
      GROUP BY intent_group, cuisine, zip
      ORDER BY demand_count DESC, last_asked DESC
      LIMIT 50
    `);

    const recentGaps = await db.query(`
      SELECT query, intent_group, cuisine, zip, created_at
      FROM resolution_history
      WHERE resolved = false
      ORDER BY created_at DESC
      LIMIT 20
    `);

    res.json({
      acquisition_targets: targets,
      total_targets: targets.length,
      high_priority: targets.filter(t => t.priority === 'high').length,
      recent_gaps: recentGaps
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Fee Events API (internal dashboard only) ──────────────────────────
// GET /api/local-intel/fee-events?hours=24&limit=100
router.get('/fee-events', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const feeService = require('./lib/feeService');
    const hours = parseInt(req.query.hours, 10) || 24;
    const limit = parseInt(req.query.limit, 10) || 100;
    const [events, summary] = await Promise.all([
      feeService.getRecentEvents({ hours, limit }),
      feeService.getSummary({ hours }),
    ]);
    return res.json({ ok: true, events, summary });
  } catch (e) {
    console.error('[fee-events]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/fee-rates  — current rates from env vars
router.get('/fee-rates', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const feeService = require('./lib/feeService');
    return res.json({ ok: true, rates: feeService.getRates() });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/local-intel/fee-control  — update rates at runtime (internal only)
// Body: { rfq_match_fee: number, order_fee_pct: number, routing_enabled: boolean }
// NOTE: env vars are the source of truth on Railway. This sets process.env at runtime
// (survives for the lifetime of this process; Railway redeploy resets to persisted env vars).
router.post('/fee-control', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const { rfq_match_fee, order_fee_pct, routing_enabled } = req.body || {};
    const changes = {};

    if (rfq_match_fee !== undefined) {
      const v = parseFloat(rfq_match_fee);
      if (!isNaN(v) && v >= 0) {
        process.env.RFQ_FLAT_FEE  = String(v.toFixed(4)); // new canonical name
        process.env.RFQ_MATCH_FEE = String(v.toFixed(4)); // legacy compat
        changes.RFQ_FLAT_FEE  = process.env.RFQ_FLAT_FEE;
        changes.RFQ_MATCH_FEE = process.env.RFQ_MATCH_FEE;
      }
    }
    if (order_fee_pct !== undefined) {
      const v = parseFloat(order_fee_pct);
      if (!isNaN(v) && v >= 0 && v <= 100) {
        process.env.ORDER_FEE_PCT = String(v.toFixed(4));
        changes.ORDER_FEE_PCT = process.env.ORDER_FEE_PCT;
      }
    }
    if (routing_enabled !== undefined) {
      process.env.ROUTING_ENABLED = routing_enabled ? 'true' : 'false';
      changes.ROUTING_ENABLED = process.env.ROUTING_ENABLED;
    }

    const feeService = require('./lib/feeService');
    const rates = feeService.getRates();
    console.log('[fee-control] rates updated:', changes);
    return res.json({ ok: true, rates, changes });
  } catch (e) {
    console.error('[fee-control]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/agent-bids/:rfq_id  — agent bid history for a job
router.get('/agent-bids/:rfq_id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const agentBid = require('./lib/agentBid');
    const bids = await agentBid.getAgentBidsForJob(req.params.rfq_id);
    return res.json({ ok: true, bids });
  } catch (e) {
    console.error('[agent-bids]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// ADMIN API — all routes require Authorization: Bearer <token>
// ADMIN_TOKEN env var = super admin (full read/write)
// SALES_TOKEN env var = read + patch description/hours/tags only
// ─────────────────────────────────────────────────────────────────────────

function adminAuth(req, res) {
  const auth  = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = process.env.ADMIN_TOKEN || '';
  const sales = process.env.SALES_TOKEN || '';
  if (!auth || (!admin && !sales)) return null; // no tokens configured — block all
  if (admin && auth === admin) return 'admin';
  if (sales && auth === sales) return 'sales';
  return null;
}

// GET /api/local-intel/admin/businesses
// Query params: zip, category, claimed (true/false), wallet (true/false), q (name search), page, limit
router.get('/admin/businesses', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const role = adminAuth(req, res);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  try {
    const page   = Math.max(1, parseInt(req.query.page,  10) || 1);
    const limit  = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const offset = (page - 1) * limit;
    const { zip, category, claimed, wallet, q } = req.query;

    const conditions = ['status != \'inactive\''];
    const params     = [];
    let   p          = 1;

    if (zip)      { conditions.push(`zip = $${p++}`);                                    params.push(zip); }
    if (category) { conditions.push(`(category = $${p++} OR tags && ARRAY[$${p-1}])`);  params.push(category); }
    if (q)        { conditions.push(`name ILIKE $${p++}`);                               params.push(`%${q}%`); }
    if (claimed === 'true')  conditions.push('claimed_at IS NOT NULL');
    if (claimed === 'false') conditions.push('claimed_at IS NULL');
    if (wallet  === 'true')  conditions.push('wallet IS NOT NULL');
    if (wallet  === 'false') conditions.push('wallet IS NULL');

    const where = conditions.join(' AND ');

    const [{ total }] = await db.query(
      `SELECT COUNT(*) AS total FROM businesses WHERE ${where}`,
      params
    );

    const rows = await db.query(
      `SELECT business_id, name, address, city, zip, phone, website, category, tags,
              description, hours, lat, lon,
              claimed_at IS NOT NULL AS claimed,
              wallet IS NOT NULL      AS has_wallet,
              wallet,
              dispatch_token IS NOT NULL AS has_merchant_token,
              services_json IS NOT NULL  AS has_skills,
              menu_fetched_at IS NOT NULL AS has_menu,
              confidence_score
         FROM businesses
        WHERE ${where}
        ORDER BY (claimed_at IS NOT NULL) DESC, (wallet IS NOT NULL) DESC,
                 confidence_score DESC, name ASC
        LIMIT $${p++} OFFSET $${p++}`,
      [...params, limit, offset]
    );

    return res.json({
      ok: true, role, total: parseInt(total, 10),
      page, limit, pages: Math.ceil(total / limit),
      businesses: rows,
    });
  } catch (e) {
    console.error('[admin/businesses]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/admin/business/:id — full profile
router.get('/admin/business/:id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const role = adminAuth(req, res);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { id } = req.params;
    const [biz] = await db.query(
      `SELECT b.*,
              claimed_at IS NOT NULL AS claimed,
              wallet IS NOT NULL      AS has_wallet,
              dispatch_token IS NOT NULL AS has_merchant_token
         FROM businesses b
        WHERE business_id = $1`,
      [id]
    );
    if (!biz) return res.status(404).json({ error: 'not found' });

    // Completeness score
    const fields = [
      ['name',         !!biz.name],
      ['phone',        !!biz.phone],
      ['address',      !!biz.address],
      ['hours',        !!biz.hours],
      ['description',  !!biz.description],
      ['category',     !!biz.category],
      ['tags',         Array.isArray(biz.tags) && biz.tags.length > 0],
      ['wallet',       !!biz.wallet],
      ['skills',       !!biz.services_json],
      ['menu',         !!biz.menu_fetched_at],
      ['location_pin', !!(biz.lat && biz.lon)],
      ['claimed',      !!biz.claimed_at],
    ];
    const score = Math.round((fields.filter(f => f[1]).length / fields.length) * 100);
    const missing = fields.filter(f => !f[1]).map(f => f[0]);

    // Recent fee events
    let feeEvents = [];
    try {
      feeEvents = await db.query(
        `SELECT event_type, status, amount_usd, meta, created_at
           FROM fee_events WHERE business_id = $1
          ORDER BY created_at DESC LIMIT 10`,
        [id]
      );
    } catch (_) {}

    // Recent RFQs
    let rfqs = [];
    try {
      rfqs = await db.query(
        `SELECT r.id, r.status, r.intent_summary, r.created_at,
                resp.quote_usd, resp.status AS response_status
           FROM rfq_requests_v2 r
           LEFT JOIN rfq_responses_v2 resp ON resp.rfq_id = r.id AND resp.business_id = $1
          WHERE r.zip = $2 OR resp.business_id = $1
          ORDER BY r.created_at DESC LIMIT 10`,
        [id, biz.zip]
      );
    } catch (_) {}

    // What searches does this business appear in?
    const searchCoverage = [];
    if (biz.category) searchCoverage.push(biz.category);
    if (Array.isArray(biz.tags)) biz.tags.forEach(t => { if (!searchCoverage.includes(t)) searchCoverage.push(t); });

    // Merchant dashboard URL
    const merchantUrl = biz.dispatch_token
      ? `https://www.thelocalintel.com/inbox.html?token=${biz.dispatch_token}`
      : null;

    return res.json({
      ok: true, role,
      business: biz,
      completeness: { score, missing, fields: Object.fromEntries(fields) },
      fee_events:    feeEvents,
      rfqs,
      search_coverage: searchCoverage,
      merchant_url:    merchantUrl,
      zip_page_url:    biz.zip ? `https://www.thelocalintel.com/zip/${biz.zip}.html` : null,
    });
  } catch (e) {
    console.error('[admin/business/:id]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// PATCH /api/local-intel/admin/business/:id — update fields
// Admin: any field. Sales: name, phone, description, hours, tags, category only.
router.patch('/admin/business/:id', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const role = adminAuth(req, res);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { id }  = req.params;
    const allowed = role === 'admin'
      ? ['name','phone','address','city','zip','website','description','hours','category','tags','lat','lon','wallet','services_json']
      : ['name','phone','description','hours','tags','category'];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'no valid fields' });

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`);
    await db.query(
      `UPDATE businesses SET ${setClauses.join(', ')}, updated_at = NOW() WHERE business_id = $1`,
      [id, ...Object.values(updates)]
    );
    return res.json({ ok: true, updated: Object.keys(updates) });
  } catch (e) {
    console.error('[admin/patch]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// POST /api/local-intel/admin/business/:id/claim — generate merchant token (admin only)
router.post('/admin/business/:id/claim', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const role = adminAuth(req, res);
  if (role !== 'admin') return res.status(401).json({ error: 'admin only' });
  try {
    const { id } = req.params;
    const [biz]  = await db.query(
      `SELECT business_id, name, dispatch_token, claimed_at FROM businesses WHERE business_id = $1`,
      [id]
    );
    if (!biz) return res.status(404).json({ error: 'not found' });

    // If already claimed, return existing token
    if (biz.claimed_at && biz.dispatch_token) {
      return res.json({
        ok: true, already_claimed: true,
        dispatch_token: biz.dispatch_token,
        merchant_url: `https://www.thelocalintel.com/inbox.html?token=${biz.dispatch_token}`,
      });
    }

    // Generate new dispatch token and mark claimed
    const { randomUUID } = require('crypto');
    const dispatchToken  = randomUUID().replace(/-/g, '');
    await db.query(
      `UPDATE businesses
          SET claimed_at = NOW(), dispatch_token = $2,
              claim_token = NULL, claim_token_exp = NULL
        WHERE business_id = $1`,
      [id, dispatchToken]
    );
    console.log(`[admin/claim] ${biz.name} claimed via admin — token generated`);
    return res.json({
      ok: true, claimed: true,
      dispatch_token: dispatchToken,
      merchant_url: `https://www.thelocalintel.com/inbox.html?token=${dispatchToken}`,
    });
  } catch (e) {
    console.error('[admin/claim]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/admin/stats — platform-wide summary
router.get('/admin/stats', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const role = adminAuth(req, res);
  if (!role) return res.status(401).json({ error: 'unauthorized' });
  try {
    const [counts] = await db.query(`
      SELECT
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)   AS claimed,
        COUNT(*) FILTER (WHERE wallet IS NOT NULL)        AS has_wallet,
        COUNT(*) FILTER (WHERE dispatch_token IS NOT NULL AND claimed_at IS NULL) AS token_not_claimed,
        COUNT(*) FILTER (WHERE services_json IS NOT NULL) AS has_skills,
        COUNT(*) FILTER (WHERE menu_fetched_at IS NOT NULL) AS has_menu
      FROM businesses WHERE status != 'inactive'
    `);
    const zipBreakdown = await db.query(`
      SELECT zip,
        COUNT(*)                                          AS total,
        COUNT(*) FILTER (WHERE claimed_at IS NOT NULL)   AS claimed,
        COUNT(*) FILTER (WHERE wallet IS NOT NULL)        AS has_wallet
      FROM businesses WHERE status != 'inactive'
      GROUP BY zip ORDER BY total DESC LIMIT 20
    `);
    let feeStats = {};
    try {
      const feeService = require('./lib/feeService');
      feeStats = await feeService.getSummary({ hours: 168 }); // last 7 days
    } catch (_) {}
    return res.json({ ok: true, role, counts, zip_breakdown: zipBreakdown, fee_stats: feeStats });
  } catch (e) {
    console.error('[admin/stats]', e.message);
    return res.status(500).json({ error: e.message });
  }
});



// ── POST /api/local-intel/admin/fcc-deep-dive ────────────────────────────────
// TIER 2 — BDC location-level deep dive (annual / paid consultation).
// Downloads full FCC BDC availability CSVs for FL by technology type, aggregates
// to ZIP-level provider/coverage breakdown. NOT a routine worker — run on-demand
// for paying consultation customers or once per year for baseline refresh.
//
// What Tier 2 provides (vs weekly Tier 1 county pulse):
//   - Per-ZIP (not county) coverage: uses census block → ZIP crosswalk
//   - Per-provider breakdown: which ISPs serve each ZIP and at what speeds
//   - Fiber-by-provider counts: Comcast vs AT&T fiber vs Brightspeed etc.
//   - BEAD challenge eligibility per location
//   - Fixed wireless tower coverage gap analysis
//   - Estimated ~500MB download + ~10 min processing for full FL dataset
//
// STATUS: stub — implementation queued for first paid consultation request.
// Trigger from dashboard FCC Deep Dive card (admin token required).
router.post('/admin/fcc-deep-dive', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const role = adminAuth(req, res);
  if (role !== 'admin') return res.status(401).json({ error: 'admin only' });

  const { zip, county_fips, dry_run } = req.body || {};
  console.log(`[fcc-deep-dive] Request from admin — zip=${zip||'all'} county=${county_fips||'all'} dry_run=${dry_run}`);

  // Log the request for pipeline awareness
  try {
    await db.query(
      `INSERT INTO zip_causal_events (zip, event_type, event_date, source, notes, created_at)
       VALUES ($1, 'fcc_deep_dive_requested', NOW(), 'admin', $2, NOW())
       ON CONFLICT DO NOTHING`,
      [zip || 'ALL', JSON.stringify({ county_fips, dry_run, requested_at: new Date().toISOString() })]
    ).catch(() => {}); // non-fatal if table not ready
  } catch (_) {}

  return res.json({
    status:      'not_implemented',
    tier:        2,
    description: 'FCC BDC location-level deep dive — downloads full provider/location CSV for FL, aggregates to ZIP',
    provides:    [
      'Per-ZIP (not county) coverage percentages',
      'Per-provider breakdown by technology (fiber / cable / fixed wireless)',
      'BEAD challenge eligibility per location',
      'Estimated provider count per ZIP',
      'Annual refresh baseline for world model calibration',
    ],
    estimated_runtime: '~10 minutes for full FL dataset (~500MB download)',
    cost_context:      'Recommended for paid consultation customers ($750+ tier)',
    run_cadence:       'Annual baseline or on-demand per consultation',
    implementation:    'queued — contact admin to schedule',
    requested: {
      zip:          zip          || null,
      county_fips:  county_fips  || null,
      dry_run:      dry_run      || false,
      ts:           new Date().toISOString(),
    },
  });
});

// ── GET /api/local-intel/platform-stats ─────────────────────────────────────
// Lightweight live counts for index.html hero section.
// Cached in-memory for 5 minutes — fast, no byZip breakdown.
let _platformStatsCache = null;
let _platformStatsCachedAt = 0;
router.get('/platform-stats', async (req, res) => {
  try {
    const now = Date.now();
    if (_platformStatsCache && (now - _platformStatsCachedAt) < 5 * 60 * 1000) {
      return res.json(_platformStatsCache);
    }
    const [row] = await db.query(`
      SELECT
        COUNT(*)                                       AS total,
        COUNT(*) FILTER (WHERE status != 'inactive')   AS active,
        COUNT(*) FILTER (WHERE claimed_at IS NOT NULL
          AND NOT (confidence_score = 0 AND business_id::text LIKE 'aaaaaaaa%')) AS claimed,
        COUNT(DISTINCT zip) FILTER (WHERE status != 'inactive') AS zip_count
      FROM businesses
    `);
    _platformStatsCache = {
      ok:        true,
      businesses: parseInt(row.active,  10),
      zips:       parseInt(row.zip_count, 10),
      claimed:    parseInt(row.claimed,  10),
      cached_at:  new Date().toISOString(),
    };
    _platformStatsCachedAt = now;
    return res.json(_platformStatsCache);
  } catch (err) {
    console.error('[platform-stats]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/businesses-claimed ───────────────────────────────────
// Returns all claimed, active businesses with agent profile data.
// Used by generate-biz-pages.js to build static /biz/{slug}.html pages.
// Public endpoint — no token required (data is already public NAP info).
router.get('/businesses-claimed', async (req, res) => {
  try {
    const db   = require('./lib/db');
    const rows = await db.query(`
      SELECT
        b.business_id, b.name, b.address, b.zip, b.phone,
        b.category, b.category_group, b.website,
        b.claimed_at, b.confidence_score,
        p.profile_summary, p.services_json, p.surge_wallet,
        p.settlement_tier, p.industry_type,
        p.specialties, p.service_area
      FROM businesses b
      LEFT JOIN business_agent_profiles p ON p.business_id = b.business_id
      WHERE b.claimed_at IS NOT NULL
        AND b.status != 'inactive'
        AND NOT (b.confidence_score = 0 AND b.business_id::text LIKE 'aaaaaaaa%')
      ORDER BY b.confidence_score DESC, b.claimed_at ASC
    `);
    return res.json({ businesses: rows });
  } catch (err) {
    console.error('[businesses-claimed]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── OSM Completeness Check ───────────────────────────────────────────────────
// GET /api/local-intel/osm-check?token=<dispatch_token>
//
// Returns a completeness report for the business's OSM node:
//   { score, total, present[], missing[], editUrl, osm_type, osm_id,
//     cached, checked_at }
//
// Uses cached result (osm_last_checked) if < 24h old — avoids Nominatim/
// Overpass hits on every page load. Force fresh: ?refresh=1
//
// This is intentionally async/slow on first call (Nominatim + Overpass).
// The inbox card shows a spinner; subsequent calls return instantly from cache.
router.get('/osm-check', async (req, res) => {
  const { token, refresh } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });

  try {
    const [biz] = await db.query(
      `SELECT business_id, name, lat, lon, phone, website, hours,
              osm_node_id, osm_node_type, osm_last_checked, osm_missing_fields
         FROM businesses
        WHERE dispatch_token = $1 AND status != 'inactive'
        LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    // Serve cached result if < 24h old and not forced refresh
    const cacheAge = biz.osm_last_checked
      ? Date.now() - new Date(biz.osm_last_checked).getTime()
      : Infinity;
    const CACHE_TTL = 24 * 60 * 60 * 1000;

    if (refresh !== '1' && cacheAge < CACHE_TTL && biz.osm_last_checked) {
      // Build a lightweight report from cached columns — no external calls
      const missingFields = biz.osm_missing_fields || [];
      const present = ['phone','website','opening_hours','email']
        .filter(f => !missingFields.includes(f))
        .map(f => ({ field: f }));
      const missing = missingFields.map(f => ({
        field: f,
        label: { phone:'Phone number', website:'Website URL',
                 opening_hours:'Opening hours', email:'Email address' }[f] || f,
        hint: null,
      }));
      const editUrl = biz.osm_node_id && biz.osm_node_type
        ? `https://www.openstreetmap.org/edit?${biz.osm_node_type}=${biz.osm_node_id}`
        : 'https://www.openstreetmap.org/edit';
      return res.json({
        score: present.length, total: 4,
        present, missing, editUrl,
        osm_type: biz.osm_node_type || null,
        osm_id  : biz.osm_node_id || null,
        cached    : true,
        checked_at: biz.osm_last_checked,
      });
    }

    // Fresh check — hits Nominatim + Overpass
    const osmChecker = require('./lib/osmChecker');
    const report = await osmChecker.checkBusiness({
      business_id : biz.business_id,
      name        : biz.name,
      lat         : biz.lat,
      lon         : biz.lon,
      phone       : biz.phone,
      website     : biz.website,
      hours       : biz.hours,
      osm_node_id : biz.osm_node_id,
      osm_node_type: biz.osm_node_type,
    });

    return res.json({ ...report, cached: false, checked_at: new Date().toISOString() });
  } catch (err) {
    console.error('[osm-check]', err.message);
    return res.status(500).json({ error: err.message });
  }
});


// ── Market Consultation Intake ────────────────────────────────────────────────
// POST /api/local-intel/consult
// Public endpoint — no token required. Stores lead in Postgres and emails Erik.
// Fields: name, email, zip, intent, description, ref
router.post('/consult', express.json(), async (req, res) => {
  const { name, email, zip, intent, description, ref } = req.body || {};

  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }

  // Basic email sanity check
  if (!email.includes('@') || email.length > 320) {
    return res.status(400).json({ error: 'invalid email' });
  }

  try {
    // Store lead in Postgres
    await db.query(
      `INSERT INTO consultation_leads (name, email, zip, intent, description, ref)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        name.slice(0, 120),
        email.slice(0, 320).toLowerCase().trim(),
        zip   || null,
        intent || null,
        description ? description.slice(0, 1000) : null,
        ref   || null,
      ]
    );
  } catch (dbErr) {
    // Table may not exist yet — do not block the user, still send the email
    console.error('[consult] DB insert failed:', dbErr.message);
  }

  // Notify Erik via Resend
  try {
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);

    const intentLabel = {
      opening_business : 'Opening a business',
      investment       : 'Investment decision',
      real_estate      : 'Real estate deal',
      expansion        : 'Business expansion',
      other            : 'Other',
    }[intent] || intent || 'Not specified';

    await resend.emails.send({
      from: 'LocalIntel <intel@thelocalintel.com>',
      to:   'erik@mcflamingo.com',
      subject: `New consultation inquiry — ${zip || 'no ZIP'} — ${name}`,
      html: `
<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;border:1px solid #e5e7eb;border-radius:10px;">
  <p style="font-size:18px;font-weight:800;color:#111827;margin:0 0 4px">New Market Consultation Lead</p>
  <p style="color:#6b7280;font-size:13px;margin:0 0 28px">LocalIntel · thelocalintel.com</p>

  <table style="width:100%;border-collapse:collapse;font-size:14px;">
    <tr><td style="padding:8px 0;color:#6b7280;width:140px">Name</td><td style="padding:8px 0;font-weight:600;color:#111827">${name}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Email</td><td style="padding:8px 0;font-weight:600;color:#111827"><a href="mailto:${email}" style="color:#16a34a">${email}</a></td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">ZIP</td><td style="padding:8px 0;font-weight:600;color:#111827">${zip || '—'}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Intent</td><td style="padding:8px 0;font-weight:600;color:#111827">${intentLabel}</td></tr>
    <tr><td style="padding:8px 0;color:#6b7280">Source</td><td style="padding:8px 0;color:#111827">${ref || 'direct'}</td></tr>
  </table>

  ${description ? `
  <div style="margin-top:20px;padding:16px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb">
    <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin:0 0 8px">What they're trying to figure out</p>
    <p style="font-size:14px;color:#111827;line-height:1.6;margin:0">${description}</p>
  </div>` : ''}

  <p style="margin-top:28px">
    <a href="https://www.thelocalintel.com/zip/${zip || ''}" style="background:#111827;color:#fff;padding:11px 22px;border-radius:8px;text-decoration:none;font-weight:600;font-size:14px;">View ZIP ${zip || ''} page &rarr;</a>
  </p>
  <p style="font-size:12px;color:#9ca3af;margin-top:24px">Typical response value: $500–$5,000 · Respond within 24h for best conversion.</p>
</div>`,
    });
  } catch (emailErr) {
    // Email failure is non-fatal — lead is already in DB
    console.error('[consult] email failed:', emailErr.message);
  }

  return res.json({ ok: true });
});

// ── POST /api/local-intel/generate-report ───────────────────────────
// Generate a world model consultation report for a ZIP code.
// Body: { zip, lead_id?, report_type? ('full'|'teaser'), admin_token }
// Returns: { report_id, access_token, report_json, html }
// Admin-only (requires admin_token header or body field matching ADMIN_TOKEN env var).
router.post('/generate-report', express.json(), async (req, res) => {
  const { zip, lead_id, report_type = 'full', admin_token } = req.body || {};
  const token = admin_token || req.headers['x-admin-token'];
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  if (!zip) return res.status(400).json({ error: 'zip required' });
  try {
    const { generateReport } = require('./lib/reportGenerator');
    const result = await generateReport({ zip, leadId: lead_id || null, reportType: report_type });
    return res.json({
      ok: true,
      report_id:    result.report_id,
      access_token: result.access_token,
      zip:          result.zip,
      data_completeness: result.data_completeness,
      scores: {
        growth:      result.report?.scores?.growth_score,
        opportunity: result.report?.scores?.opportunity_score,
        maturity:    result.report?.scores?.market_maturity,
      },
      summary_12mo: result.report?.projections?.['12_month']?.summary,
    });
  } catch (e) {
    console.error('[generate-report]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/report/:token ──────────────────────────────
// Serve a generated report by access token.
// Used for client-facing shareable report links.
// Returns HTML if Accept: text/html, JSON otherwise.
router.get('/report/:token', async (req, res) => {
  const { token } = req.params;
  if (!token) return res.status(400).json({ error: 'token required' });
  try {
    const row = await db.queryOne(
      `SELECT zip, report_json, report_html, generated_at, status, model_version
       FROM zip_reports WHERE access_token = $1`,
      [token]
    );
    if (!row) return res.status(404).json({ error: 'report not found' });
    if (row.status === 'archived') return res.status(410).json({ error: 'report archived' });

    const acceptsHtml = (req.headers.accept || '').includes('text/html');
    if (acceptsHtml && row.report_html) {
      return res.type('text/html').send(row.report_html);
    }
    return res.json({
      zip:          row.zip,
      generated_at: row.generated_at,
      model_version: row.model_version,
      report:       row.report_json,
    });
  } catch (e) {
    console.error('[report/:token]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/zip-signals/:zip ──────────────────────────
// Returns raw zip_signals row for a ZIP (admin/internal use).
router.get('/zip-signals/:zip', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const row = await db.queryOne(`SELECT * FROM zip_signals WHERE zip = $1`, [req.params.zip]);
    if (!row) return res.status(404).json({ error: 'no signals for this ZIP yet' });
    // Augment with contact_email counts from businesses table
    // (websiteEnricherWorker writes to businesses, not zip_signals)
    const emailStats = await db.queryOne(
      `SELECT
         COUNT(*) FILTER (WHERE contact_email IS NOT NULL)::int AS contact_email,
         COUNT(*) FILTER (WHERE contact_email_source IS NOT NULL)::int AS contact_email_source
       FROM businesses WHERE zip = $1`,
      [req.params.zip]
    );
    return res.json({ ...row, ...emailStats });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/zip-forecast/:zip ─────────────────────────
// Returns the latest zip_forecast row for a ZIP.
router.get('/zip-forecast/:zip', async (req, res) => {
  try {
    const row = await db.queryOne(
      `SELECT * FROM zip_forecast WHERE zip = $1 ORDER BY generated_at DESC LIMIT 1`,
      [req.params.zip]
    );
    if (!row) return res.status(404).json({ error: 'no forecast for this ZIP yet — worldModelWorker must run first' });
    return res.json(row);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/anomalies ────────────────────────────────
// Returns open anomalies (admin/internal). Optional ?zip= to filter.
router.get('/anomalies', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    const { zip, severity } = req.query;
    let q = `SELECT zip, signal_name, actual_value, expected_value, z_score, direction, severity, question, detected_at, status
             FROM zip_anomalies WHERE status='open'`;
    const params = [];
    if (zip)      { params.push(zip);      q += ` AND zip=$${params.length}`; }
    if (severity) { params.push(severity); q += ` AND severity=$${params.length}`; }
    q += ` ORDER BY ABS(z_score) DESC LIMIT 100`;
    const rows = await db.query(q, params);
    return res.json({ count: rows.length, anomalies: rows });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/dead-ends ──────────────────────────────────────────
// B10: surfaces unmatched/failed user queries from intent_dead_ends.
// Admin-only — same token pattern as /migrate routes. Query params:
//   ?limit=100  (max 500)
//   ?reason=<fail_reason>  (optional)
//   ?since=<ISO date>  (optional)
router.get('/dead-ends', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const conditions = ['1=1'];
    const params = [];
    if (req.query.reason) {
      params.push(req.query.reason);
      conditions.push(`fail_reason = $${params.length}`);
    }
    if (req.query.since) {
      params.push(req.query.since);
      conditions.push(`created_at >= $${params.length}`);
    }
    params.push(limit);
    const rows = await db.query(
      `SELECT id, query, zip, channel, fail_reason, intent_path, caller_id, created_at
       FROM intent_dead_ends
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params
    );
    return res.json({ count: rows.length, dead_ends: rows });
  } catch (e) {
    console.error('[dead-ends]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── B11: Twilio recording + transcription webhooks ──────────────────────────
// Twilio posts urlencoded form bodies — apply urlencoded parser inline since the
// router doesn't have a global one. Both webhooks respond 200 immediately so
// Twilio doesn't retry while our Postgres update runs.

// POST /api/local-intel/voice/recording-complete
router.post('/voice/recording-complete', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200);
  const { CallSid, RecordingUrl, RecordingDuration } = req.body || {};
  if (!CallSid) return;
  try {
    await db.query(
      `UPDATE call_transcripts
         SET recording_url = $1,
             duration_sec  = $2,
             updated_at    = NOW()
       WHERE call_sid = $3`,
      [
        RecordingUrl ? (RecordingUrl.startsWith('http') ? RecordingUrl : `https://api.twilio.com${RecordingUrl}`) + '.mp3' : null,
        parseInt(RecordingDuration, 10) || null,
        CallSid,
      ]
    );
  } catch (err) {
    console.error('[B11] recording-complete update failed:', err.message);
  }
});

// POST /api/local-intel/voice/transcription-complete
router.post('/voice/transcription-complete', express.urlencoded({ extended: false }), async (req, res) => {
  res.sendStatus(200);
  const { CallSid, TranscriptionText, TranscriptionStatus } = req.body || {};
  if (!CallSid) return;
  try {
    await db.query(
      `UPDATE call_transcripts
         SET transcription_text = $1,
             status             = $2,
             updated_at         = NOW()
       WHERE call_sid = $3`,
      [
        TranscriptionText || null,
        TranscriptionStatus === 'completed' ? 'transcribed' : 'failed',
        CallSid,
      ]
    );
  } catch (err) {
    console.error('[B11] transcription-complete update failed:', err.message);
  }
});

// GET /api/local-intel/call-transcripts — admin read
router.get('/call-transcripts', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const rows = await db.query(
      `SELECT call_sid, caller_id, transcription_text, duration_sec, zip, status, created_at
         FROM call_transcripts
         ORDER BY created_at DESC
         LIMIT $1`,
      [limit]
    );
    return res.json({ count: rows.length, transcripts: rows });
  } catch (e) {
    console.error('[call-transcripts]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/labor-market/:zip —————————————————─
// MCP tool: labor_market_intel
// Returns CES sector employment, AI displacement risk, investment score for a ZIP.
// Priced at $0.10 via Tempo pathUSD if agent_id provided; free for admin tokens.
router.get('/labor-market/:zip', async (req, res) => {
  const { zip } = req.params;
  const { sector, agent_id } = req.query;
  const adminToken = req.headers['x-admin-token'] || req.query.admin_token;
  const isAdmin = adminToken === process.env.LOCAL_INTEL_ADMIN_TOKEN || adminToken === 'localintel-migrate-2026';

  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'zip must be a 5-digit string' });
  }

  try {
    const row = await db.queryOne(
      `SELECT zip, ces_msa_code, ces_msa_name, ces_total_nonfarm, ces_total_yoy_pct,
              ces_healthcare_emp, ces_healthcare_yoy_pct,
              ces_professional_emp, ces_professional_yoy_pct,
              ces_leisure_emp, ces_leisure_yoy_pct,
              ces_construction_emp, ces_construction_yoy_pct,
              ces_retail_emp, ces_retail_yoy_pct,
              ces_financial_emp, ces_financial_yoy_pct,
              ces_government_emp, ces_government_yoy_pct,
              ces_dominant_sector, ces_vintage,
              ai_displacement_risk, investment_opportunity_score,
              investment_tier, labor_market_momentum, dominant_growth_sector,
              qcew_employment, qcew_avg_weekly_wages, qcew_emp_yoy_pct, qcew_wage_yoy_pct, qcew_vintage,
              fred_unemployment_rate, fred_unemployment_yoy, fred_vintage
       FROM zip_signals WHERE zip = $1`,
      [zip]
    );

    if (!row || !row.ces_msa_code) {
      return res.status(404).json({
        error: 'No CES labor market data for this ZIP yet',
        hint: 'Run cesWorker to populate CES signals, or this ZIP is outside a FL MSA'
      });
    }

    // Build sector-filtered response if requested
    const sectorMap = {
      healthcare: { emp: row.ces_healthcare_emp, yoy: row.ces_healthcare_yoy_pct, ai_exposure: 0.28 },
      professional: { emp: row.ces_professional_emp, yoy: row.ces_professional_yoy_pct, ai_exposure: 0.58 },
      leisure: { emp: row.ces_leisure_emp, yoy: row.ces_leisure_yoy_pct, ai_exposure: 0.35 },
      construction: { emp: row.ces_construction_emp, yoy: row.ces_construction_yoy_pct, ai_exposure: 0.22 },
      retail: { emp: row.ces_retail_emp, yoy: row.ces_retail_yoy_pct, ai_exposure: 0.65 },
      financial: { emp: row.ces_financial_emp, yoy: row.ces_financial_yoy_pct, ai_exposure: 0.72 },
      government: { emp: row.ces_government_emp, yoy: row.ces_government_yoy_pct, ai_exposure: 0.30 },
    };

    const response = {
      zip,
      msa: {
        code: row.ces_msa_code,
        name: row.ces_msa_name,
        vintage: row.ces_vintage,
      },
      labor_market: {
        total_nonfarm_k:  row.ces_total_nonfarm,
        total_yoy_pct:    row.ces_total_yoy_pct,
        momentum:         row.labor_market_momentum,
        dominant_growth:  row.dominant_growth_sector,
        sectors: sector ? { [sector]: sectorMap[sector] || null } : sectorMap,
      },
      qcew: row.qcew_employment ? {
        employment:       row.qcew_employment,
        avg_weekly_wages: row.qcew_avg_weekly_wages,
        emp_yoy_pct:      row.qcew_emp_yoy_pct,
        wage_yoy_pct:     row.qcew_wage_yoy_pct,
        vintage:          row.qcew_vintage,
      } : null,
      unemployment: row.fred_unemployment_rate ? {
        rate_pct:  row.fred_unemployment_rate,
        yoy_delta: row.fred_unemployment_yoy,
        vintage:   row.fred_vintage,
      } : null,
      ai_investment: {
        displacement_risk:    row.ai_displacement_risk,
        displacement_label:   row.ai_displacement_risk == null ? null
          : row.ai_displacement_risk >= 55 ? 'HIGH — significant AI automation exposure'
          : row.ai_displacement_risk >= 40 ? 'MEDIUM — mixed exposure, monitor tech adoption'
          : 'LOW — workforce concentrated in hard-to-automate roles',
        opportunity_score:    row.investment_opportunity_score,
        investment_tier:      row.investment_tier,
        tier_label:           { A: 'Strong growth market', B: 'Solid opportunity', C: 'Neutral/emerging', D: 'Challenged market' }[row.investment_tier] || null,
      },
      data_sources: ['BLS CES SMU series (monthly)', 'BLS QCEW (quarterly)', 'BLS LAUS/FRED (monthly)'],
      pricing: isAdmin ? 'admin_free' : { model: 'per_query', asset: 'pathUSD', amount_usd: 0.10 },
    };

    return res.json(response);
  } catch (e) {
    console.error('[labor-market]', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/labor-market-compare — compare multiple ZIPs side-by-side
router.get('/labor-market-compare', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(403).json({ error: 'forbidden' });
  }
  const zipsParam = req.query.zips || '';
  const zips = zipsParam.split(',').map(z => z.trim()).filter(z => /^\d{5}$/.test(z)).slice(0, 10);
  if (!zips.length) return res.status(400).json({ error: 'zips query param required (comma-separated, max 10)' });

  try {
    const rows = await db.query(
      `SELECT zip, ces_msa_name, ces_total_nonfarm, ces_total_yoy_pct,
              ces_healthcare_yoy_pct, ces_construction_yoy_pct,
              ai_displacement_risk, investment_opportunity_score, investment_tier,
              qcew_avg_weekly_wages, qcew_wage_yoy_pct, fred_unemployment_rate
       FROM zip_signals WHERE zip = ANY($1) ORDER BY investment_opportunity_score DESC NULLS LAST`,
      [zips]
    );
    return res.json({ zips: rows, count: rows.length });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/admin/tm-probe ───────────────────────────────────────
// Admin-only probe to inspect raw Ticketmaster Discovery API responses for
// venue/event lookups around Ponte Vedra (32082). Used to verify TM key + payload
// shape before wiring TM data into the venue follow-up flow.
router.get('/admin/tm-probe', async (req, res) => {
  if (req.headers['x-admin-token'] !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const key = process.env.Ticketmaster_Consumer_Key;
  if (!key) return res.json({ error: 'no TM key configured' });
  try {
    const venueUrl = `https://app.ticketmaster.com/discovery/v2/venues.json?keyword=ponte+vedra+concert+hall&countryCode=US&stateCode=FL&apikey=${key}`;
    const eventUrl = `https://app.ticketmaster.com/discovery/v2/events.json?postalCode=32082&classificationName=music&size=5&apikey=${key}`;
    const [venueResp, eventResp] = await Promise.all([fetch(venueUrl), fetch(eventUrl)]);
    const [venueSearch, eventSearch] = await Promise.all([venueResp.json(), eventResp.json()]);
    return res.json({ venueSearch, eventSearch });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── POST /api/local-intel/backfill-sjc-cama ─────────────────────────────────
// B13: One-shot backfill of St. Johns beds/baths/sqft/year_built from CAMA
// files if present on the Railway volume. Safe to call when files are absent —
// returns { status: 'no_cama_data' } rather than erroring. The next quarterly
// reseed_cron run pulls the bundles fresh, so this endpoint exists only to
// enrich the already-seeded 171k records immediately if the volume has them.
//
// Looks for CAMADataSup.mdb (StructElemViewUnit + BldView) in:
//   /data/sjcpa/CAMADataSup.mdb
//   /app/data/sjcpa/CAMADataSup.mdb
//   /tmp/sjcpa/CAMADataSup.mdb
//   $SJCPA_DATA_DIR/CAMADataSup.mdb (env override)
//
// Token gate: x-admin-token: localintel-migrate-2026 OR LOCAL_INTEL_ADMIN_TOKEN.
router.post('/backfill-sjc-cama', express.json(), async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { execFile } = require('child_process');
  const { promisify } = require('util');
  const execFileP = promisify(execFile);
  const fs = require('fs');
  const path = require('path');

  const candidates = [
    process.env.SJCPA_DATA_DIR ? path.join(process.env.SJCPA_DATA_DIR, 'CAMADataSup.mdb') : null,
    '/data/sjcpa/CAMADataSup.mdb',
    '/app/data/sjcpa/CAMADataSup.mdb',
    '/tmp/sjcpa/CAMADataSup.mdb',
  ].filter(Boolean);

  const mdbPath = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } });
  if (!mdbPath) {
    return res.json({
      status: 'no_cama_data',
      message: 'CAMA files not on volume — will enrich on next quarterly reseed',
      checked_paths: candidates,
    });
  }

  function parseCsv(text) {
    const rows = [];
    let cur = [], field = '', inQ = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQ) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else { inQ = false; }
        } else { field += c; }
      } else {
        if (c === '"') inQ = true;
        else if (c === ',') { cur.push(field); field = ''; }
        else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
        else if (c === '\r') { /* skip */ }
        else field += c;
      }
    }
    if (field.length || cur.length) { cur.push(field); rows.push(cur); }
    return rows;
  }
  async function mdbExportRows(tableName) {
    const { stdout } = await execFileP('mdb-export', [mdbPath, tableName], { maxBuffer: 1024 * 1024 * 1024 });
    const rows = parseCsv(stdout);
    if (!rows.length) return [];
    const header = rows[0].map((h) => h.toLowerCase().trim());
    const out = [];
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i];
      if (r.length === 1 && r[0] === '') continue;
      const obj = {};
      for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? '';
      out.push(obj);
    }
    return out;
  }

  try {
    const sevRows = await mdbExportRows('StructElemViewUnit');
    const bedsByStrap  = new Map();
    const bathsByStrap = new Map();
    for (const r of sevRows) {
      const strap = (r.strap || '').trim();
      if (!strap) continue;
      const cd = (r.cd || '').trim();
      const unitsRaw = (r.units || '').trim();
      if (!unitsRaw) continue;
      const n = parseFloat(unitsRaw);
      if (!Number.isFinite(n) || n === 0) continue;
      if (cd === '1') bedsByStrap.set(strap,  (bedsByStrap.get(strap)  || 0) + n);
      else if (cd === '2') bathsByStrap.set(strap, (bathsByStrap.get(strap) || 0) + n);
    }

    const bldRows = await mdbExportRows('BldView');
    const bldByStrap = new Map();
    for (const r of bldRows) {
      const strap = (r.strap || '').trim();
      if (!strap || bldByStrap.has(strap)) continue;
      bldByStrap.set(strap, {
        heat_ar: r.heated_ar || r.heat_ar || '',
        act:     r.act       || '',
        eff:     r.eff       || '',
      });
    }

    const straps = new Set([...bedsByStrap.keys(), ...bathsByStrap.keys(), ...bldByStrap.keys()]);
    let updated = 0;
    let scanned = 0;
    const BATCH = 500;
    let batch = [];

    async function flush() {
      if (!batch.length) return;
      const placeholders = batch.map((_, i) => `($${i * 5 + 1}, $${i * 5 + 2}::numeric, $${i * 5 + 3}::numeric, $${i * 5 + 4}::numeric, $${i * 5 + 5}::int)`).join(',');
      const params = [];
      for (const row of batch) {
        params.push(row.strap, row.beds, row.baths, row.sqft, row.yr);
      }
      const sql = `
        WITH src(strap, beds, baths, sqft, yr) AS (VALUES ${placeholders})
        UPDATE property_parcels p
        SET beds       = COALESCE(src.beds,  p.beds),
            baths      = COALESCE(src.baths, p.baths),
            tot_lvg_ar = COALESCE(src.sqft,  p.tot_lvg_ar),
            act_yr_blt = COALESCE(src.yr,    p.act_yr_blt),
            fetched_at = NOW()
        FROM src
        WHERE p.parcel_id = src.strap AND p.co_no = 65
      `;
      const r = await db.query(sql, params);
      updated += Array.isArray(r) ? r.length : 0;
      batch = [];
    }

    for (const strap of straps) {
      scanned++;
      const beds  = bedsByStrap.has(strap)  ? bedsByStrap.get(strap)  : null;
      const baths = bathsByStrap.has(strap) ? bathsByStrap.get(strap) : null;
      const bld   = bldByStrap.get(strap) || {};
      const sqft  = bld.heat_ar && Number.isFinite(parseFloat(bld.heat_ar)) ? parseFloat(bld.heat_ar) : null;
      const yr    = bld.act && Number.isFinite(parseInt(bld.act, 10)) ? parseInt(bld.act, 10) : null;
      if (beds === null && baths === null && sqft === null && yr === null) continue;
      batch.push({ strap, beds, baths, sqft, yr });
      if (batch.length >= BATCH) await flush();
    }
    await flush();

    const verify = await db.query(`
      SELECT COUNT(*)::int AS total,
             COUNT(beds)::int AS with_beds,
             COUNT(baths)::int AS with_baths,
             COUNT(tot_lvg_ar)::int AS with_sqft,
             COUNT(act_yr_blt)::int AS with_year
      FROM property_parcels WHERE co_no = 65
    `);

    return res.json({
      status: 'ok',
      source_mdb: mdbPath,
      struct_elem_rows: sevRows.length,
      bld_rows: bldRows.length,
      beds_parcels: bedsByStrap.size,
      baths_parcels: bathsByStrap.size,
      bld_parcels: bldByStrap.size,
      strap_union: scanned,
      affected: updated,
      stjohns_after: verify[0] || null,
    });
  } catch (e) {
    console.error('[backfill-sjc-cama]', e && e.message ? e.message : e);
    return res.status(500).json({ error: e && e.message ? e.message : String(e) });
  }
});

// ── POST /api/local-intel/admin/ping-heartbeat ─────────────────────────
// Force-stamp worker heartbeats so they skip on next deploy.
// Body: { workers: ['acsWorker', 'censusLayerWorker', ...] }
router.post('/admin/ping-heartbeat', express.json(), async (req, res) => {
  if (req.headers['x-admin-token'] !== 'localintel-migrate-2026')
    return res.status(401).json({ error: 'unauthorized' });
  const workers = Array.isArray(req.body?.workers) ? req.body.workers : [];
  if (!workers.length) return res.status(400).json({ error: 'workers array required' });
  try {
    for (const w of workers) {
      await db.query(
        `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ($1, NOW())
         ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`,
        [w]
      );
    }
    return res.json({ ok: true, stamped: workers });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/admin/reset-heartbeat ─────────────────────────
// Clear worker heartbeats so they re-run on next boot/cycle.
// Body: { workers: ['tradeSignalWorker', ...] }
router.post('/admin/reset-heartbeat', express.json(), async (req, res) => {
  if (req.headers['x-admin-token'] !== 'localintel-migrate-2026')
    return res.status(401).json({ error: 'unauthorized' });
  const workers = Array.isArray(req.body?.workers) ? req.body.workers : [];
  if (!workers.length) return res.status(400).json({ error: 'workers array required' });
  try {
    for (const w of workers) {
      await db.query(
        `UPDATE worker_heartbeat SET last_run = '2000-01-01' WHERE worker_name = $1`,
        [w]
      );
    }
    return res.json({ ok: true, reset: workers });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/admin/run-trade-signals ──────────────────────────
// Execute trade signal scoring inline and return results (for debugging / force-run).
router.post('/admin/run-trade-signals', async (req, res) => {
  if (req.headers['x-admin-token'] !== 'localintel-migrate-2026')
    return res.status(401).json({ error: 'unauthorized' });
  try {
    const TICKERS = ['DHI','SBCF','HCA','NXRT','LOW','FRPH','FOUR','SBGI'];
    const COMPANIES = { DHI:'D.R. Horton', SBCF:'Seacoast Banking FL', HCA:'HCA Healthcare',
      NXRT:'NexPoint Residential', LOW:"Lowe's", FRPH:'FRP Holdings',
      FOUR:'Shift4 Payments', SBGI:'Sinclair Broadcast' };

    // Get FL aggregates — monthly permit proxy: COALESCE(monthly, annual/12) when monthly not yet loaded
    const [agg] = await db.query(`
      SELECT AVG(COALESCE(bps_total_units_mo, bps_total_units_annual/12.0)) AS avg_permits_mo,
             AVG(macro_bfs_apps_latest) AS avg_bfs_apps,
             AVG(sunbiz_new_12mo) AS avg_sunbiz_new, AVG(sunbiz_dissolved_12mo) AS avg_sunbiz_diss,
             AVG(acs_vacancy_pct) AS avg_vacancy, AVG(acs_median_hhi) AS avg_hhi,
             SUM(COALESCE(bps_total_units_mo, bps_total_units_annual/12.0)) AS total_permits_mo,
             SUM(macro_bfs_apps_latest) AS total_bfs_apps,
             SUM(sunbiz_new_12mo) AS total_sunbiz_new, COUNT(*) AS zip_count
      FROM zip_signals WHERE state = 'FL'
    `);

    const bfsTrend = await db.query(`
      SELECT period, SUM((metrics->>'estabs_entry')::int) AS total_apps
      FROM macro_indicators WHERE source = 'bds' AND geo_id LIKE '12%'
      GROUP BY period ORDER BY period DESC LIMIT 4
    `);

    const [nes] = await db.query(`
      SELECT SUM(nes_total_firms) AS total_nes_firms, SUM(nes_construction_firms) AS total_nes_construction,
             AVG(nes_receipts_per_firm) AS avg_receipts_per_firm FROM zip_macro_signals
    `);

    const [mig] = await db.query(`
      SELECT SUM(irs_mig_net_returns) AS net_migration FROM zip_signals
      WHERE irs_mig_net_returns IS NOT NULL
    `);

    let bfsMomentum = 0;
    if (bfsTrend.length >= 2) {
      // BDS is annual: latest year vs prior year
      const recent = parseInt(bfsTrend[0]?.total_apps) || 0;
      const prior  = parseInt(bfsTrend[1]?.total_apps) || 0;
      bfsMomentum  = prior > 0 ? Math.round(((recent-prior)/prior)*100) : 0;
    }

    const fl = {
      avgPermitsMo: parseFloat(agg?.avg_permits_mo)||0, avgBfsApps: parseFloat(agg?.avg_bfs_apps)||0,
      avgSunbizNew: parseFloat(agg?.avg_sunbiz_new)||0, avgSunbizDiss: parseFloat(agg?.avg_sunbiz_diss)||0,
      avgVacancy: parseFloat(agg?.avg_vacancy)||0, avgHhi: parseFloat(agg?.avg_hhi)||0,
      totalPermitsMo: parseInt(agg?.total_permits_mo)||0, totalBfsApps: parseInt(agg?.total_bfs_apps)||0,
      totalSunbizNew: parseInt(agg?.total_sunbiz_new)||0, zipCount: parseInt(agg?.zip_count)||1,
      bfsMomentum, totalNesFirms: parseInt(nes?.total_nes_firms)||0,
      nesConstruction: parseInt(nes?.total_nes_construction)||0,
      netMigration: parseInt(mig?.net_migration)||0,
      latestBfsPeriod: bfsTrend[0]?.period || null,
    };

    // Real scoring logic (mirrors tradeSignalWorker.js scoreSignals)
    function scoreToDirection(score) {
      if (score >= 62) return 'LONG';
      if (score >= 42) return 'WATCH';
      return 'SHORT';
    }
    // Zero/null inputs are treated as neutral (55) so missing data doesn't drag all scores to 50
    const bfsAvail  = fl.totalBfsApps > 0;   // censusMacroWorker has run BFS
    const permAvail = fl.totalPermitsMo > 0; // BPS monthly loaded

    function scoreSignals(ticker) {
      switch (ticker) {
        case 'DHI': {
          // Lead: migration + HHI (always populated); permit/BFS as bonus when available
          const migScore    = fl.netMigration > 10000 ? 78 : fl.netMigration > 0 ? 65 : 42;
          const hhiScore    = fl.avgHhi > 70000 ? 70 : fl.avgHhi > 55000 ? 60 : 48;
          const permitScore = permAvail ? (fl.totalPermitsMo > 8000 ? 75 : fl.totalPermitsMo > 5000 ? 58 : 40) : 55;
          const bfsScore    = bfsAvail  ? (fl.bfsMomentum > 5 ? 72 : fl.bfsMomentum > 0 ? 55 : 38) : 55;
          const score       = Math.round((migScore*0.4)+(hhiScore*0.3)+(permitScore*0.15)+(bfsScore*0.15));
          return { score, direction: scoreToDirection(score),
            thesis: `FL net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} and avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} signal ${score>=62?'strong':'moderate'} single-family demand. DHI has heaviest FL exposure among national builders.`,
            signal_source: 'irs_mig_net_returns + acs_median_hhi + bps_total_units_mo + macro_bfs_apps_latest',
            signal_value: `Net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · permits ${permAvail?fl.totalPermitsMo.toLocaleString():'pending'}/mo`,
            options_note: score>=65?'3-month call options 10-15% OTM on next earnings catalyst':null,
            risk_note: 'Interest rate sensitivity — thesis breaks if 30yr mortgage > 7.5%' };
        }
        case 'SBCF': {
          const netFormation   = fl.avgSunbizNew - fl.avgSunbizDiss;
          const formationScore = fl.avgSunbizNew > 50 ? 72 : fl.avgSunbizNew > 25 ? 58 : 40;
          const netScore       = netFormation > 10 ? 72 : netFormation > 0 ? 58 : 38;
          const migScore       = fl.netMigration > 5000 ? 68 : fl.netMigration > 0 ? 55 : 40;
          const bfsScore       = bfsAvail ? (fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 52 : 38) : 55;
          const score          = Math.round((formationScore*0.35)+(netScore*0.35)+(migScore*0.2)+(bfsScore*0.1));
          return { score, direction: scoreToDirection(score),
            thesis: `FL SMB net formation ${netFormation>5?'expanding':netFormation>0?'stable':'contracting'} (avg ${fl.avgSunbizNew.toFixed(0)} new / ${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP) — SBCF loan book quality tied directly to FL business formation.`,
            signal_source: 'sunbiz_new_12mo + sunbiz_dissolved_12mo + irs_mig_net_returns',
            signal_value: `Sunbiz avg +${fl.avgSunbizNew.toFixed(0)} new / -${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP · net ${netFormation.toFixed(1)} · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
            options_note: score>=65?'Sell puts on weakness for entry — low option premium name':null,
            risk_note: 'Concentrated FL credit risk — any FL-specific recession hits disproportionately' };
        }
        case 'HCA': {
          const migScore  = fl.netMigration > 10000 ? 75 : fl.netMigration > 0 ? 62 : 42;
          const hhiScore  = fl.avgHhi > 70000 ? 68 : fl.avgHhi > 55000 ? 58 : 46;
          const nesScore  = fl.totalNesFirms > 100000 ? 68 : fl.totalNesFirms > 50000 ? 58 : 50;
          const score     = Math.round((migScore*0.45)+(hhiScore*0.35)+(nesScore*0.2));
          return { score, direction: scoreToDirection(score),
            thesis: `FL net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} + avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} drive structural healthcare demand. HCA holds ~25% of FL hospital beds.`,
            signal_source: 'irs_mig_net_returns + acs_median_hhi + nes_total_firms',
            signal_value: `Net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · NES firms ${fl.totalNesFirms.toLocaleString()}`,
            options_note: null,
            risk_note: 'Medicaid reimbursement cuts — FL Medicaid policy changes directly hit HCA margins' };
        }
        case 'NXRT': {
          const vacancyScore = fl.avgVacancy > 0 ? (fl.avgVacancy < 5 ? 75 : fl.avgVacancy < 8 ? 60 : 40) : 55;
          const migScore     = fl.netMigration > 5000 ? 72 : fl.netMigration > 0 ? 60 : 40;
          const hhiScore     = fl.avgHhi > 65000 ? 65 : fl.avgHhi > 50000 ? 55 : 44;
          const permitScore  = permAvail ? (fl.totalPermitsMo > 8000 ? 42 : fl.totalPermitsMo > 5000 ? 50 : 62) : 55;
          const score        = Math.round((vacancyScore*0.35)+(migScore*0.35)+(hhiScore*0.2)+(permitScore*0.1));
          return { score, direction: scoreToDirection(score),
            thesis: `FL rental vacancy ${fl.avgVacancy>0?fl.avgVacancy.toFixed(1)+'%':'pending'} with net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} and avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})}. NXRT sunbelt portfolio 40%+ FL.`,
            signal_source: 'acs_vacancy_pct + irs_mig_net_returns + acs_median_hhi',
            signal_value: `Avg FL vacancy ${fl.avgVacancy>0?fl.avgVacancy.toFixed(1)+'%':'pending'} · net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})}`,
            options_note: null,
            risk_note: 'New supply risk — FL permitted units lag completions 18-24 months' };
        }
        case 'LOW': {
          const nesConScore = fl.nesConstruction > 5000 ? 72 : fl.nesConstruction > 2000 ? 60 : 48;
          const hhiScore    = fl.avgHhi > 65000 ? 68 : fl.avgHhi > 50000 ? 57 : 44;
          const migScore    = fl.netMigration > 5000 ? 68 : fl.netMigration > 0 ? 58 : 42;
          const permitScore = permAvail ? (fl.totalPermitsMo > 8000 ? 72 : fl.totalPermitsMo > 5000 ? 58 : 42) : 55;
          const score       = Math.round((nesConScore*0.35)+(hhiScore*0.3)+(migScore*0.2)+(permitScore*0.15));
          return { score, direction: scoreToDirection(score),
            thesis: `${fl.nesConstruction.toLocaleString()} FL NES construction firms + avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} track Lowe's Pro segment — the highest-margin part of their business.`,
            signal_source: 'nes_construction_firms + acs_median_hhi + irs_mig_net_returns',
            signal_value: `NES construction firms ${fl.nesConstruction.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
            options_note: score>=65?'Buy calls before quarterly earnings when FL permit data confirms acceleration':null,
            risk_note: 'Housing market slowdown or lumber price spike compresses project economics' };
        }
        case 'FRPH': {
          const netForm   = fl.avgSunbizNew - fl.avgSunbizDiss;
          const formScore = fl.avgSunbizNew > 40 ? 70 : fl.avgSunbizNew > 20 ? 57 : 40;
          const netScore  = netForm > 10 ? 68 : netForm > 0 ? 55 : 38;
          const migScore  = fl.netMigration > 5000 ? 65 : fl.netMigration > 0 ? 55 : 40;
          const bfsScore  = bfsAvail ? (fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 55 : 40) : 55;
          const score     = Math.round((formScore*0.35)+(netScore*0.3)+(migScore*0.2)+(bfsScore*0.15));
          return { score, direction: scoreToDirection(score),
            thesis: `FL business formation avg ${fl.avgSunbizNew.toFixed(0)} new entities/ZIP/yr, net ${netForm.toFixed(1)} — FRPH industrial/flex space demand lags formation by 12-18 months. Small float.`,
            signal_source: 'sunbiz_new_12mo + sunbiz_dissolved_12mo + irs_mig_net_returns',
            signal_value: `Sunbiz avg ${fl.avgSunbizNew.toFixed(0)} new / ${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP · net ${netForm.toFixed(1)} · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
            options_note: null,
            risk_note: 'Illiquid small-cap — wide spreads, options not practical. Equity only.' };
        }
        case 'FOUR': {
          const nesScore  = fl.totalNesFirms > 80000 ? 72 : fl.totalNesFirms > 50000 ? 60 : 44;
          const formScore = fl.avgSunbizNew > 40 ? 70 : fl.avgSunbizNew > 20 ? 57 : 40;
          const migScore  = fl.netMigration > 5000 ? 65 : fl.netMigration > 0 ? 55 : 40;
          const bfsScore  = bfsAvail ? (fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 55 : 38) : 55;
          const score     = Math.round((nesScore*0.4)+(formScore*0.35)+(migScore*0.15)+(bfsScore*0.1));
          return { score, direction: scoreToDirection(score),
            thesis: `${fl.totalNesFirms.toLocaleString()} FL NES solo/SMB operators + avg ${fl.avgSunbizNew.toFixed(0)} new entities/ZIP/yr signals payment volume expansion for Shift4's core FL market.`,
            signal_source: 'nes_total_firms + sunbiz_new_12mo + irs_mig_net_returns',
            signal_value: `NES total firms ${fl.totalNesFirms.toLocaleString()} · sunbiz new avg ${fl.avgSunbizNew.toFixed(0)}/ZIP · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
            options_note: score>=65?'30-45 day call spreads on breakout above 52-week high':null,
            risk_note: 'Competition from Stripe/Square compressing SMB take rates nationwide' };
        }
        case 'SBGI': {
          const hhiScore  = fl.avgHhi > 65000 ? 64 : fl.avgHhi > 50000 ? 53 : 40;
          const formScore = fl.avgSunbizNew > 40 ? 62 : fl.avgSunbizNew > 20 ? 52 : 38;
          const migScore  = fl.netMigration > 0 ? 58 : 40;
          const score     = Math.round((hhiScore*0.4)+(formScore*0.35)+(migScore*0.25));
          return { score, direction: scoreToDirection(score),
            thesis: `FL avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} + SMB formation (avg ${fl.avgSunbizNew.toFixed(0)} new/ZIP/yr) proxy local ad spend. SBGI holds FL broadcast licenses in major DMAs. Speculative/deep value.`,
            signal_source: 'acs_median_hhi + sunbiz_new_12mo + irs_mig_net_returns',
            signal_value: `Avg FL HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · sunbiz new avg ${fl.avgSunbizNew.toFixed(0)}/ZIP · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
            options_note: null,
            risk_note: 'Heavy debt load — any revenue miss triggers balance sheet concern. High risk.' };
        }
        default: return null;
      }
    }

    const results = [];
    for (const ticker of TICKERS) {
      try {
        const scored = scoreSignals(ticker);
        if (!scored) { results.push({ ticker, error: 'unknown ticker' }); continue; }
        const { score, direction, thesis, signal_source, signal_value, options_note, risk_note } = scored;
        const expiresAt = new Date(Date.now() + 90*86400*1000);
        // Per-ticker delete then insert — safe if loop fails mid-way
        await db.query(`DELETE FROM trade_signals WHERE ticker = $1 AND scored_at::date = CURRENT_DATE`, [ticker]);
        await db.query(
          `INSERT INTO trade_signals
             (ticker, company, direction, confidence, thesis, signal_source, signal_value,
              data_vintage, options_note, risk_note, status, scored_at, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',NOW(),$11)`,
          [ticker, COMPANIES[ticker], direction, score, thesis, signal_source, signal_value,
           fl.latestBfsPeriod ? `BFS ${fl.latestBfsPeriod}` : 'LocalIntel',
           options_note, risk_note, expiresAt]
        );
        results.push({ ticker, direction, score, ok: true });
      } catch (e) {
        results.push({ ticker, error: e.message });
      }
    }
    return res.json({ fl, results });
  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack?.split('\n').slice(0,5) });
  }
});

// ── POST /api/local-intel/admin/seed-business ──────────────────────────────
// Insert or update a single business record and set its mcp_endpoint.
// Returns dispatch_token so you can immediately use the inbox.
// Token gate: x-admin-token: localintel-migrate-2026
router.post('/admin/seed-business', express.json(), async (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.admin_token;
  if (token !== 'localintel-migrate-2026') return res.status(401).json({ error: 'unauthorized' });
  try {
    const {
      name, zip, address, city, phone, website, category = 'legal',
      category_group = 'professional_services', description,
      mcp_endpoint, tags = [],
    } = req.body;
    if (!name || !zip) return res.status(400).json({ error: 'name and zip required' });

    // Check existing
    const [existing] = await db.query(
      `SELECT business_id, dispatch_token FROM businesses WHERE name = $1 AND zip = $2 LIMIT 1`,
      [name, zip]
    );

    let business_id, dispatch_token;

    if (existing) {
      business_id    = existing.business_id;
      dispatch_token = existing.dispatch_token;
      await db.query(
        `UPDATE businesses SET
           address      = COALESCE($2, address),
           city         = COALESCE($3, city),
           phone        = COALESCE($4, phone),
           website      = COALESCE($5, website),
           category     = $6,
           category_group = $7,
           description  = COALESCE($8, description),
           tags         = $9,
           status       = 'active',
           updated_at   = NOW()
         WHERE business_id = $1`,
        [business_id, address||null, city||null, phone||null, website||null,
         category, category_group, description||null, tags]
      );
    } else {
      dispatch_token = require('crypto').randomBytes(32).toString('hex');
      const [ins] = await db.query(
        `INSERT INTO businesses
           (name, zip, address, city, phone, website, category, category_group,
            description, tags, status, claimed, confidence_score, dispatch_token, primary_source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',true,90,$11,'manual')
         RETURNING business_id`,
        [name, zip, address||null, city||null, phone||null, website||null,
         category, category_group, description||null, tags, dispatch_token]
      );
      business_id = ins.business_id;
    }

    // Set mcp_endpoint on agent profile if provided
    if (mcp_endpoint) {
      const agentProfiles = require('./lib/agentProfiles');
      await agentProfiles.upsertProfile(business_id, { mcp_endpoint });
    }

    return res.json({ ok: true, business_id, dispatch_token, created: !existing });
  } catch (err) {
    console.error('[admin/seed-business]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/admin/dispatch-token/:business_id ──────────────────
// Returns dispatch_token for any business — admin testing bypass, no email needed.
router.get('/admin/dispatch-token/:business_id', async (req, res) => {
  if (req.headers['x-admin-token'] !== 'localintel-migrate-2026')
    return res.status(401).json({ error: 'unauthorized' });
  try {
    const row = await db.queryOne(
      `SELECT business_id, name, zip, dispatch_token FROM businesses WHERE business_id = $1 LIMIT 1`,
      [req.params.business_id]
    );
    if (!row) return res.status(404).json({ error: 'business not found' });
    return res.json({ ok: true, business_id: row.business_id, name: row.name, zip: row.zip, dispatch_token: row.dispatch_token });
  } catch (err) {
    console.error('[admin/dispatch-token]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Tier 3 per-business MCP proxy ──────────────────────────────────────────
// GET  /.well-known/mcp/:business_id  → discovery manifest (no auth)
// POST /mcp/:business_id              → JSON-RPC (proxy or hosted mode, no auth)
// POST /mcp-probe                     → test an arbitrary mcp_endpoint
// Implementation in lib/businessMcp.js.

router.get('/.well-known/mcp/:business_id', async (req, res) => {
  try {
    const baseUrl = req.protocol + '://' + req.get('host');
    const manifest = await getDiscoveryManifest(req.params.business_id, baseUrl);
    return res.json(manifest);
  } catch (err) {
    console.error('[well-known/mcp/:business_id]', err.message);
    return res.status(404).json({ error: err.message });
  }
});

router.post('/mcp/:business_id', express.json(), async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'] || null;
    await handleMcpRequest(req.params.business_id, req.body, res, { sessionId });
  } catch (err) {
    console.error('[mcp/:business_id]', err.message);
    if (!res.headersSent) return res.status(500).json({ error: err.message });
  }
});

router.post('/mcp-probe', express.json(), async (req, res) => {
  const adminToken = req.headers['x-admin-token'];
  const dispatchToken = req.headers['x-dispatch-token'];
  let authed = adminToken === 'localintel-migrate-2026';
  if (!authed && dispatchToken) {
    const row = await db.queryOne(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 LIMIT 1`,
      [dispatchToken]
    );
    authed = Boolean(row);
  }
  if (!authed) return res.status(401).json({ error: 'unauthorized' });

  const { mcp_endpoint } = req.body || {};
  if (!mcp_endpoint) return res.status(400).json({ error: 'mcp_endpoint required' });

  try {
    const result = await probeEndpoint(mcp_endpoint);
    return res.json(result);
  } catch (err) {
    return res.json({ error: 'Could not reach endpoint', detail: err.message });
  }
});

// ── POST /api/local-intel/admin/reseed-stjohns ─────────────────────────────
// On-demand trigger for the St. Johns quarterly property reseed.
// Downloads CAMAData.zip + CAMADataSup.zip from sftp.sjcpa.us, runs mdb-export,
// and upserts beds/baths/sqft/year_built for all 171k St. Johns parcels.
// Fire-and-forget — responds immediately with jobId; reseed runs in background.
// Token gate: x-admin-token: localintel-migrate-2026 OR LOCAL_INTEL_ADMIN_TOKEN.
router.post('/admin/reseed-stjohns', express.json(), async (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['x-operator-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { spawn } = require('child_process');
  const path = require('path');

  const jobId = `reseed-stjohns-${Date.now()}`;
  const scriptPath = path.join(__dirname, 'data-seed', 'reseed_cron.js');

  // Write start heartbeat to Postgres so status endpoint can track progress
  try {
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ($1, NOW())
       ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`,
      [`reseedStJohns_started_${jobId}`]
    );
  } catch (_) { /* non-fatal */ }

  // Spawn detached so it outlives the HTTP response
  const child = spawn(process.execPath, [scriptPath, '--only=stjohns'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, RESEED_ONLY: 'stjohns', RESEED_JOB_ID: jobId },
  });
  child.unref();

  console.log(`[reseed-stjohns] triggered jobId=${jobId} pid=${child.pid}`);

  return res.json({
    status: 'started',
    jobId,
    pid: child.pid,
    message: 'St. Johns CAMA reseed started — downloads CAMAData.zip + CAMADataSup.zip from sftp.sjcpa.us and upserts beds/baths/sqft/year_built for 171k parcels. Runtime ~5–10 min.',
  });
});

// ── GET /api/local-intel/admin/cama-status ────────────────────────────────────
// Returns St. Johns CAMA data coverage from property_parcels (co_no=65).
// Also returns reseed job status from worker_heartbeat.
router.get('/admin/cama-status', async (req, res) => {
  const token = req.headers['x-admin-token'] || req.headers['x-operator-token'] || req.query.admin_token;
  if (token !== process.env.LOCAL_INTEL_ADMIN_TOKEN && token !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }

  try {
    // Coverage stats from property_parcels
    const coverage = await db.query(`
      SELECT
        COUNT(*)::int                          AS total_parcels,
        COUNT(beds)::int                       AS with_beds,
        COUNT(baths)::int                      AS with_baths,
        COUNT(tot_lvg_ar)::int                 AS with_sqft,
        COUNT(act_yr_blt)::int                 AS with_year,
        ROUND(AVG(beds)::numeric, 1)           AS avg_beds,
        ROUND(AVG(baths)::numeric, 1)          AS avg_baths,
        ROUND(AVG(tot_lvg_ar)::numeric, 0)     AS avg_sqft
      FROM property_parcels
      WHERE co_no = 65
    `);

    // Last reseed job from worker_heartbeat
    const heartbeat = await db.query(`
      SELECT worker_name, last_run
      FROM worker_heartbeat
      WHERE worker_name LIKE 'reseedStJohns%'
      ORDER BY last_run DESC
      LIMIT 5
    `);

    const stats = coverage[0] || {};
    const live = (stats.with_beds || 0) > 0;

    return res.json({
      live,
      total_parcels: stats.total_parcels || 0,
      with_beds:     stats.with_beds     || 0,
      with_baths:    stats.with_baths    || 0,
      with_sqft:     stats.with_sqft     || 0,
      with_year:     stats.with_year     || 0,
      avg_beds:      stats.avg_beds      || null,
      avg_baths:     stats.avg_baths     || null,
      avg_sqft:      stats.avg_sqft      || null,
      recent_jobs:   heartbeat,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── On-Demand Worker Trigger ─────────────────────────────────────────────────
// POST /api/local-intel/admin/worker/run
//   body: { worker: "btrWorker" }      → spawn one worker
//   body: { group: "real_estate" }     → spawn every worker in the group
// GET  /api/local-intel/admin/worker/status → catalogue of groups + statuses
//
// Background daemons (LOCAL_INTEL_WORKERS in dashboard-server.js) start at
// boot and are not re-spawned by this endpoint. The 6 disabled workers and
// the on-demand scrapers in workers/ can be triggered here without code
// changes. Admin token gated.
const workerRunner = require('./lib/workerRunner');

function workerAdminGate(req, res) {
  const token = req.headers['x-admin-token'];
  if (token === process.env.ADMIN_TOKEN || token === 'localintel-migrate-2026') return true;
  res.status(401).json({ error: 'unauthorized' });
  return false;
}

router.post('/admin/worker/run', express.json(), async (req, res) => {
  if (!workerAdminGate(req, res)) return;
  const { worker, group } = req.body || {};
  if (!worker && !group) {
    return res.status(400).json({ error: 'must provide either "worker" or "group" in body' });
  }
  try {
    const results = worker
      ? [await workerRunner.runWorker(worker)]
      : await workerRunner.runGroup(group);
    const triggered = results.filter(r => r.status === 'started' || r.status === 'already_running');
    const errors = results.filter(r => r.status === 'error');
    return res.json({ triggered, errors });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

router.get('/admin/worker/status', async (req, res) => {
  if (!workerAdminGate(req, res)) return;
  try {
    return res.json(workerRunner.getCatalogue());
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ── B16 — GET /api/local-intel/sms-log (admin) ────────────────────────────────
// Returns the most recent SMS queries logged via lib/smsQueryLog. Auth via the
// shared x-admin-token header used by other migrate/admin endpoints.
router.get('/sms-log', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== 'localintel-migrate-2026') {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const rows = await db.query(
      `SELECT id, message_sid, caller_id, query, zip, intent, resolved_via,
              response_preview, created_at
         FROM sms_query_log
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    return res.json({ count: rows.length, queries: rows });
  } catch (err) {
    console.error('[sms-log] query failed:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── B25: CEO Assessment Endpoint ──────────────────────────────────────────────
// GET /api/local-intel/ceo-assess?zip=32081&q=restaurant
// Full multi-node assessment: reads ALL populated zip_signals columns + property_parcels
// + business density + demand signals. Structures into sections matching the node map.
// ZERO LLM calls — every data point sourced directly from Postgres.
router.get('/ceo-assess', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const zip = String(req.query.zip || '').trim();
  const q   = String(req.query.q   || '').trim();

  if (!zip) return res.status(400).json({ error: 'zip required' });
  if (!TARGET_ZIPS.includes(zip)) {
    return res.status(400).json({ error: 'ZIP not in coverage area' });
  }

  const safe = (p) => p.catch(() => null);

  const [
    densityRows,
    propertyRows,
    sigRows,
    totalBizRows,
    deadEndRows,
    smsRows,
  ] = await Promise.all([
    safe(db.query(
      `SELECT category, COUNT(*)::int AS count
         FROM businesses WHERE zip = $1
        GROUP BY category ORDER BY count DESC LIMIT 10`,
      [zip]
    )),
    safe(db.query(
      `SELECT
         COUNT(*)::int                      AS parcel_count,
         ROUND(AVG(beds)::numeric, 1)       AS avg_beds,
         ROUND(AVG(baths)::numeric, 1)      AS avg_baths,
         ROUND(AVG(tot_lvg_ar)::numeric, 0) AS avg_sqft,
         ROUND(AVG(assessed_value)::numeric, 0) AS avg_assessed,
         MIN(assessed_value)                AS min_assessed,
         MAX(assessed_value)                AS max_assessed,
         ROUND(AVG(act_yr_blt)::numeric, 0) AS avg_year_built
       FROM property_parcels
      WHERE zip = $1`,
      [zip]
    )),
    safe(db.query(`SELECT * FROM zip_signals WHERE zip = $1 LIMIT 1`, [zip])),
    safe(db.query(`SELECT COUNT(*)::int AS total FROM businesses WHERE zip = $1`, [zip])),
    safe(db.query(
      `SELECT detected_intent, COUNT(*)::int AS count
         FROM intent_dead_ends WHERE zip = $1
        GROUP BY detected_intent ORDER BY count DESC LIMIT 5`,
      [zip]
    )),
    safe(db.query(
      `SELECT detected_intent, COUNT(*)::int AS count
         FROM sms_query_log WHERE zip = $1
        GROUP BY detected_intent ORDER BY count DESC LIMIT 5`,
      [zip]
    )),
  ]);

  // ── Raw data ───────────────────────────────────────────────────────────────
  const business_density  = Array.isArray(densityRows)  ? densityRows  : [];
  const total_businesses  = Array.isArray(totalBizRows) && totalBizRows[0] ? Number(totalBizRows[0].total || 0) : 0;
  const top_sms_intents   = Array.isArray(smsRows)      ? smsRows      : [];
  const unmet_demand      = Array.isArray(deadEndRows)   ? deadEndRows   : [];
  const sig               = Array.isArray(sigRows) && sigRows[0] ? sigRows[0] : {};
  const pr                = Array.isArray(propertyRows)  && propertyRows[0] ? propertyRows[0] : {};

  // ── Helper ─────────────────────────────────────────────────────────────────
  const fmt  = (v, decimals = 0) => v != null ? Number(v).toLocaleString('en-US', { maximumFractionDigits: decimals }) : null;
  const pct  = (v) => v != null ? `${Number(v).toFixed(1)}%` : null;
  const usd  = (v) => v != null ? `$${Math.round(Number(v)).toLocaleString()}` : null;
  const yoy  = (v) => v != null ? `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(1)}%` : null;
  const has  = (v) => v != null && v !== '';

  // ── Section builders — only include keys that have data ───────────────────

  // 1. Demographics (ACS)
  const demographics = {};
  if (has(sig.acs_population))       demographics.population       = fmt(sig.acs_population);
  if (has(sig.acs_households))       demographics.households       = fmt(sig.acs_households);
  if (has(sig.acs_median_hhi))       demographics.median_hhi       = usd(sig.acs_median_hhi);
  if (has(sig.acs_median_age))       demographics.median_age       = Number(sig.acs_median_age);
  if (has(sig.acs_owner_occ_pct))    demographics.owner_occupied   = pct(sig.acs_owner_occ_pct);
  if (has(sig.acs_college_pct))      demographics.college_pct      = pct(sig.acs_college_pct);
  if (has(sig.acs_poverty_pct))      demographics.poverty_pct      = pct(sig.acs_poverty_pct);
  if (has(sig.acs_vacancy_pct))      demographics.vacancy_pct      = pct(sig.acs_vacancy_pct);
  if (has(sig.acs_commute_time_min)) demographics.avg_commute_min  = Number(sig.acs_commute_time_min);
  if (has(sig.acs_vintage))          demographics.vintage          = sig.acs_vintage;

  // 2. Income (IRS SOI)
  const income = {};
  if (has(sig.irs_agi_median))  income.median_agi     = usd(sig.irs_agi_median);
  if (has(sig.irs_returns))     income.returns_filed  = fmt(sig.irs_returns);
  if (has(sig.irs_wage_share))  income.wage_share     = pct(sig.irs_wage_share);
  // BEA
  if (has(sig.bea_per_capita_income)) income.per_capita_income   = usd(sig.bea_per_capita_income);
  if (has(sig.bea_income_growth_1yr)) income.income_growth_1yr   = yoy(sig.bea_income_growth_1yr);
  if (has(sig.bea_income_vs_fl_avg))  income.vs_fl_avg           = `${Number(sig.bea_income_vs_fl_avg).toFixed(2)}x`;
  if (has(sig.bea_vintage))           income.bea_vintage         = sig.bea_vintage;

  // 3. Migration (IRS Migration)
  const migration = {};
  if (has(sig.irs_mig_net_returns)) migration.net_returns    = fmt(sig.irs_mig_net_returns);
  if (has(sig.irs_mig_net_agi))     migration.net_agi_k      = fmt(sig.irs_mig_net_agi);
  if (has(sig.irs_mig_in_returns))  migration.in_returns     = fmt(sig.irs_mig_in_returns);
  if (has(sig.irs_mig_out_returns)) migration.out_returns    = fmt(sig.irs_mig_out_returns);
  if (has(sig.irs_mig_top_origin))  migration.top_origin     = sig.irs_mig_top_origin;
  if (has(sig.irs_mig_top_dest))    migration.top_dest       = sig.irs_mig_top_dest;
  if (has(sig.irs_mig_vintage))     migration.vintage        = sig.irs_mig_vintage;

  // 4. Labor Market
  const labor = {};
  // FRED / BLS LAUS
  if (has(sig.fred_unemployment_rate)) labor.unemployment_rate  = pct(sig.fred_unemployment_rate);
  if (has(sig.fred_labor_force))       labor.labor_force         = fmt(sig.fred_labor_force);
  if (has(sig.fred_employed))          labor.employed            = fmt(sig.fred_employed);
  if (has(sig.fred_unemployment_yoy))  labor.unemployment_yoy    = yoy(sig.fred_unemployment_yoy);
  if (has(sig.fred_vintage))           labor.fred_vintage        = sig.fred_vintage;
  // QWI
  if (has(sig.qwi_employment))       labor.qwi_employment      = fmt(sig.qwi_employment);
  if (has(sig.qwi_avg_monthly_earn)) labor.avg_monthly_earn    = usd(sig.qwi_avg_monthly_earn);
  if (has(sig.qwi_turnover_rate))    labor.turnover_rate       = pct(sig.qwi_turnover_rate);
  if (has(sig.qwi_vintage))          labor.qwi_vintage         = sig.qwi_vintage;
  // QCEW
  if (has(sig.qcew_employment))       labor.qcew_employment     = fmt(sig.qcew_employment);
  if (has(sig.qcew_avg_weekly_wages)) labor.avg_weekly_wages    = usd(sig.qcew_avg_weekly_wages);
  if (has(sig.qcew_establishments))   labor.establishments      = fmt(sig.qcew_establishments);
  if (has(sig.qcew_emp_yoy_pct))      labor.emp_yoy             = yoy(sig.qcew_emp_yoy_pct);
  if (has(sig.qcew_wage_yoy_pct))     labor.wage_yoy            = yoy(sig.qcew_wage_yoy_pct);
  if (has(sig.qcew_vintage))          labor.qcew_vintage        = sig.qcew_vintage;

  // 5. Sector Employment (CES)
  const sectors = {};
  if (has(sig.ces_msa_name))              sectors.msa                   = sig.ces_msa_name;
  if (has(sig.ces_total_nonfarm))         sectors.total_nonfarm_k       = fmt(sig.ces_total_nonfarm);
  if (has(sig.ces_total_yoy_pct))         sectors.total_yoy             = yoy(sig.ces_total_yoy_pct);
  if (has(sig.ces_healthcare_emp))        sectors.healthcare_k          = fmt(sig.ces_healthcare_emp);
  if (has(sig.ces_healthcare_yoy_pct))    sectors.healthcare_yoy        = yoy(sig.ces_healthcare_yoy_pct);
  if (has(sig.ces_professional_emp))      sectors.professional_k        = fmt(sig.ces_professional_emp);
  if (has(sig.ces_professional_yoy_pct))  sectors.professional_yoy      = yoy(sig.ces_professional_yoy_pct);
  if (has(sig.ces_leisure_emp))           sectors.leisure_k             = fmt(sig.ces_leisure_emp);
  if (has(sig.ces_leisure_yoy_pct))       sectors.leisure_yoy           = yoy(sig.ces_leisure_yoy_pct);
  if (has(sig.ces_construction_emp))      sectors.construction_k        = fmt(sig.ces_construction_emp);
  if (has(sig.ces_construction_yoy_pct))  sectors.construction_yoy      = yoy(sig.ces_construction_yoy_pct);
  if (has(sig.ces_retail_emp))            sectors.retail_k              = fmt(sig.ces_retail_emp);
  if (has(sig.ces_retail_yoy_pct))        sectors.retail_yoy            = yoy(sig.ces_retail_yoy_pct);
  if (has(sig.ces_dominant_sector))       sectors.dominant_sector       = sig.ces_dominant_sector;
  if (has(sig.ces_vintage))               sectors.vintage               = sig.ces_vintage;
  if (has(sig.ai_displacement_risk))      sectors.ai_displacement_risk  = Number(sig.ai_displacement_risk);
  if (has(sig.investment_opportunity_score)) sectors.investment_score   = Number(sig.investment_opportunity_score);
  if (has(sig.investment_tier))           sectors.investment_tier       = sig.investment_tier;
  if (has(sig.dominant_growth_sector))    sectors.growth_leader         = sig.dominant_growth_sector;

  // 6. Jobs (LODES)
  const jobs = {};
  if (has(sig.lodes_jobs_here))           jobs.jobs_located_here   = fmt(sig.lodes_jobs_here);
  if (has(sig.lodes_workers_live_here))   jobs.workers_living_here = fmt(sig.lodes_workers_live_here);
  if (has(sig.lodes_net_flow))            jobs.net_flow            = fmt(sig.lodes_net_flow);
  if (has(sig.lodes_retail_jobs))         jobs.retail_jobs         = fmt(sig.lodes_retail_jobs);
  if (has(sig.lodes_food_jobs))           jobs.food_jobs           = fmt(sig.lodes_food_jobs);
  if (has(sig.lodes_healthcare_jobs))     jobs.healthcare_jobs     = fmt(sig.lodes_healthcare_jobs);
  if (has(sig.lodes_high_earn_pct))       jobs.high_earn_pct       = pct(sig.lodes_high_earn_pct);
  if (has(sig.lodes_low_earn_pct))        jobs.low_earn_pct        = pct(sig.lodes_low_earn_pct);

  // 7. Business Activity
  const business_activity = {
    total_businesses,
    top_categories: business_density.slice(0, 5),
  };
  if (has(sig.zbp_total_establishments)) business_activity.zbp_establishments = fmt(sig.zbp_total_establishments);
  if (has(sig.cbp_dominant_sector))      business_activity.cbp_dominant_sector = sig.cbp_dominant_sector;
  if (has(sig.sunbiz_active_entities))   business_activity.sunbiz_active       = fmt(sig.sunbiz_active_entities);
  if (has(sig.sunbiz_new_12mo))          business_activity.sunbiz_new_12mo     = fmt(sig.sunbiz_new_12mo);
  if (has(sig.sunbiz_net_12mo))          business_activity.sunbiz_net_12mo     = fmt(sig.sunbiz_net_12mo);
  if (has(sig.osm_biz_count))            business_activity.osm_mapped          = fmt(sig.osm_biz_count);
  if (has(sig.osm_food_count))           business_activity.osm_food            = fmt(sig.osm_food_count);
  if (has(sig.osm_with_phone_pct))       business_activity.osm_with_phone      = pct(sig.osm_with_phone_pct);

  // 8. Construction
  const construction = {};
  if (has(sig.bps_total_units_annual))   construction.units_annual         = fmt(sig.bps_total_units_annual);
  if (has(sig.bps_res_1unit_annual))     construction.single_family_annual = fmt(sig.bps_res_1unit_annual);
  if (has(sig.bps_res_multifam_annual))  construction.multifam_annual      = fmt(sig.bps_res_multifam_annual);
  if (has(sig.bps_total_units_mo))       construction.units_latest_month   = fmt(sig.bps_total_units_mo);
  if (has(sig.bps_period_mo))            construction.period               = sig.bps_period_mo;

  // 9. Broadband
  const broadband = {};
  if (sig.fcc_has_25_3  != null) broadband.has_25_3_mbps  = sig.fcc_has_25_3;
  if (sig.fcc_has_100_20 != null) broadband.has_100_20_mbps = sig.fcc_has_100_20;
  if (sig.fcc_has_gigabit != null) broadband.has_gigabit   = sig.fcc_has_gigabit;
  if (sig.fcc_fiber_available != null) broadband.fiber_available = sig.fcc_fiber_available;
  if (has(sig.fcc_providers_cnt)) broadband.provider_count = Number(sig.fcc_providers_cnt);
  // Normalised aliases from fccBroadbandWorker newer columns
  if (has(sig.fcc_pct_25_3))          broadband.pct_25_3          = pct(sig.fcc_pct_25_3);
  if (has(sig.fcc_pct_100_20))        broadband.pct_100_20        = pct(sig.fcc_pct_100_20);
  if (has(sig.fcc_provider_count))    broadband.provider_count    = Number(sig.fcc_provider_count);
  if (has(sig.fcc_bead_unserved_pct)) broadband.bead_unserved_pct = pct(sig.fcc_bead_unserved_pct);

  // 10. Property (property_parcels)
  const property = {};
  if (has(pr.parcel_count))  property.parcel_count  = Number(pr.parcel_count);
  if (has(pr.avg_beds))      property.avg_beds       = Number(pr.avg_beds);
  if (has(pr.avg_baths))     property.avg_baths      = Number(pr.avg_baths);
  if (has(pr.avg_sqft))      property.avg_sqft       = fmt(pr.avg_sqft);
  if (has(pr.avg_assessed))  property.avg_assessed   = usd(pr.avg_assessed);
  if (has(pr.min_assessed))  property.min_assessed   = usd(pr.min_assessed);
  if (has(pr.max_assessed))  property.max_assessed   = usd(pr.max_assessed);
  if (has(pr.avg_year_built))property.avg_year_built = fmt(pr.avg_year_built);

  // 11. World Model / Opportunity Scores
  const world_model = {};
  if (has(sig.sig_growth_score))      world_model.growth_score      = Number(sig.sig_growth_score);
  if (has(sig.sig_opportunity_score)) world_model.opportunity_score = Number(sig.sig_opportunity_score);
  if (has(sig.sig_risk_score))        world_model.risk_score        = Number(sig.sig_risk_score);
  if (has(sig.sig_market_maturity))   world_model.market_maturity   = sig.sig_market_maturity;
  if (has(sig.sig_income_tier))       world_model.income_tier       = sig.sig_income_tier;
  if (has(sig.sig_peer_cohort))       world_model.peer_cohort       = sig.sig_peer_cohort;
  if (has(sig.sig_biz_density_per_1k)) world_model.biz_density_per_1k = Number(sig.sig_biz_density_per_1k);
  if (has(sig.sig_job_capture_ratio))  world_model.job_capture_ratio  = Number(sig.sig_job_capture_ratio);

  // 12. Demand
  const demand = { top_sms_intents, unmet_demand };

  // ── Count populated sections ───────────────────────────────────────────────
  const sectionData = { demographics, income, migration, labor, sectors, jobs, business_activity, construction, broadband, property, world_model };
  const populatedSections = Object.entries(sectionData)
    .filter(([, v]) => Object.keys(v).length > 0) // at least 1 key present
    .map(([k]) => k);

  // ── CEO Summary — multi-section, plain English ─────────────────────────────
  const lines = [`ZIP ${zip}${q ? ` · Query: "${q}"` : ''}`];

  // Demographics
  if (has(sig.acs_population)) {
    const incStr = has(sig.acs_median_hhi) ? `, median HHI ${usd(sig.acs_median_hhi)}` : '';
    const ownStr = has(sig.acs_owner_occ_pct) ? `, ${pct(sig.acs_owner_occ_pct)} owner-occupied` : '';
    lines.push(`DEMOGRAPHICS: Population ${fmt(sig.acs_population)}${incStr}${ownStr}.`);
  }

  // Income
  if (has(sig.bea_per_capita_income) || has(sig.irs_agi_median)) {
    const parts = [];
    if (has(sig.bea_per_capita_income)) parts.push(`per capita income ${usd(sig.bea_per_capita_income)}`);
    if (has(sig.bea_income_vs_fl_avg))  parts.push(`${Number(sig.bea_income_vs_fl_avg).toFixed(2)}x FL avg`);
    if (has(sig.irs_agi_median))        parts.push(`median AGI ${usd(sig.irs_agi_median)}`);
    if (parts.length) lines.push(`INCOME: ${parts.join(', ')}.`);
  }

  // Migration
  if (has(sig.irs_mig_net_returns)) {
    const dir = Number(sig.irs_mig_net_returns) >= 0 ? 'gaining' : 'losing';
    const netAgi = has(sig.irs_mig_net_agi) ? ` net AGI ${usd(Number(sig.irs_mig_net_agi) * 1000)}` : '';
    lines.push(`MIGRATION: ZIP is ${dir} ${Math.abs(Number(sig.irs_mig_net_returns)).toLocaleString()} net returns (${sig.irs_mig_vintage || ''})${netAgi}.`);
  }

  // Labor
  if (has(sig.fred_unemployment_rate) || has(sig.qcew_employment)) {
    const parts = [];
    if (has(sig.fred_unemployment_rate)) parts.push(`unemployment ${pct(sig.fred_unemployment_rate)}`);
    if (has(sig.qcew_employment))        parts.push(`${fmt(sig.qcew_employment)} employed`);
    if (has(sig.qcew_avg_weekly_wages))  parts.push(`avg wages ${usd(sig.qcew_avg_weekly_wages)}/wk`);
    if (has(sig.qcew_emp_yoy_pct))       parts.push(`employment ${yoy(sig.qcew_emp_yoy_pct)} YoY`);
    if (parts.length) lines.push(`LABOR: ${parts.join(', ')}.`);
  }

  // Sectors
  if (has(sig.ces_total_nonfarm)) {
    const parts = [`${fmt(sig.ces_total_nonfarm)}k nonfarm jobs (${sig.ces_msa_name || 'MSA'})`, `${yoy(sig.ces_total_yoy_pct)} YoY`];
    if (has(sig.ces_dominant_sector)) parts.push(`dominant: ${sig.ces_dominant_sector}`);
    if (has(sig.investment_opportunity_score)) parts.push(`investment score ${Number(sig.investment_opportunity_score)}/100 (${sig.investment_tier || '?'})`);
    if (has(sig.ai_displacement_risk)) parts.push(`AI risk ${Number(sig.ai_displacement_risk)}/100`);
    lines.push(`SECTORS: ${parts.join(', ')}.`);
  }

  // Jobs flow
  if (has(sig.lodes_jobs_here)) {
    const flow = Number(sig.lodes_net_flow || 0);
    lines.push(`JOBS FLOW: ${fmt(sig.lodes_jobs_here)} jobs located here, ${fmt(sig.lodes_workers_live_here)} workers live here — net ${flow >= 0 ? '+' : ''}${fmt(flow)} (${flow >= 0 ? 'job importer' : 'bedroom community'}).`);
  }

  // Business Activity
  const topCats = business_density.slice(0, 3).map((r) => `${r.category} (${r.count})`).join(', ');
  lines.push(`BUSINESS: ${total_businesses} businesses mapped${topCats ? ` — top: ${topCats}` : ''}.`);
  if (has(sig.sunbiz_new_12mo)) lines.push(`FORMATION: ${fmt(sig.sunbiz_new_12mo)} new entities registered last 12 months, net ${fmt(sig.sunbiz_net_12mo || 0)}.`);

  // Construction
  if (has(sig.bps_total_units_annual)) {
    lines.push(`CONSTRUCTION: ${fmt(sig.bps_total_units_annual)} residential units permitted (annual), ${fmt(sig.bps_res_1unit_annual || 0)} single-family.`);
  }

  // Property
  if (Number(pr.parcel_count || 0) > 0) {
    const parts = [`${fmt(pr.parcel_count)} parcels`];
    if (has(pr.avg_assessed))  parts.push(`avg assessed ${usd(pr.avg_assessed)}`);
    if (has(pr.min_assessed))  parts.push(`min ${usd(pr.min_assessed)}`);
    if (has(pr.avg_beds))      parts.push(`avg ${Number(pr.avg_beds).toFixed(1)} beds/${Number(pr.avg_baths || 0).toFixed(1)} baths`);
    if (has(pr.avg_sqft))      parts.push(`avg ${fmt(pr.avg_sqft)} sqft`);
    lines.push(`PROPERTY: ${parts.join(', ')}.`);
  }

  // World model
  if (has(sig.sig_growth_score)) {
    lines.push(`WORLD MODEL: growth score ${sig.sig_growth_score}/100, opportunity ${sig.sig_opportunity_score}/100, maturity: ${sig.sig_market_maturity || 'n/a'}.`);
  }

  // Demand
  const topSmsStr = top_sms_intents.map((r) => r.detected_intent).filter(Boolean).join(', ') || null;
  const unmetStr  = unmet_demand.map((r) => r.detected_intent).filter(Boolean).join(', ') || null;
  if (topSmsStr)  lines.push(`DEMAND: Top queries — ${topSmsStr}.`);
  if (unmetStr)   lines.push(`UNMET DEMAND: ${unmetStr}.`);

  const ceo_summary = lines.join(' ');

  // ── Response ───────────────────────────────────────────────────────────────
  return res.json({
    zip,
    query_context:      q || null,
    assessed_at:        new Date().toISOString(),
    populated_sections: populatedSections,
    // Structured sections — each only present if it has data
    demographics:       Object.keys(demographics).length   ? demographics   : undefined,
    income:             Object.keys(income).length         ? income         : undefined,
    migration:          Object.keys(migration).length      ? migration      : undefined,
    labor:              Object.keys(labor).length          ? labor          : undefined,
    sectors:            Object.keys(sectors).length        ? sectors        : undefined,
    jobs:               Object.keys(jobs).length           ? jobs           : undefined,
    business_activity,
    construction:       Object.keys(construction).length   ? construction   : undefined,
    broadband:          Object.keys(broadband).length      ? broadband      : undefined,
    property:           Object.keys(property).length       ? property       : undefined,
    world_model:        Object.keys(world_model).length    ? world_model    : undefined,
    demand,
    ceo_summary,
  });
});

// POST /api/local-intel/ceo-query
// Body: { zip, question }
// Re-loads zip_signals + business data, runs deterministic keyword-category
// matching to answer Erik's question. Zero LLM calls — pure Postgres + math.
router.post('/ceo-query', express.json(), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const zip = String(req.body?.zip || '').trim();
  const question = String(req.body?.question || '').trim();

  if (!zip) return res.status(400).json({ error: 'zip required' });
  if (!question) return res.status(400).json({ error: 'question required' });
  if (!TARGET_ZIPS.includes(zip)) {
    return res.status(400).json({ error: 'ZIP not in coverage area' });
  }

  const safe = (p) => p.catch(() => null);

  const [
    densityRows,
    propertyRows,
    sigRows,
    totalBizRows,
    deadEndRows,
    smsRows,
    foodBizRows,
  ] = await Promise.all([
    safe(db.query(
      `SELECT category, COUNT(*)::int AS count
         FROM businesses WHERE zip = $1
        GROUP BY category ORDER BY count DESC LIMIT 10`,
      [zip]
    )),
    safe(db.query(
      `SELECT
         COUNT(*)::int                      AS parcel_count,
         ROUND(AVG(beds)::numeric, 1)       AS avg_beds,
         ROUND(AVG(baths)::numeric, 1)      AS avg_baths,
         ROUND(AVG(tot_lvg_ar)::numeric, 0) AS avg_sqft,
         ROUND(AVG(assessed_value)::numeric, 0) AS avg_assessed,
         MIN(assessed_value)                AS min_assessed,
         MAX(assessed_value)                AS max_assessed,
         ROUND(AVG(act_yr_blt)::numeric, 0) AS avg_year_built
       FROM property_parcels
      WHERE zip = $1`,
      [zip]
    )),
    safe(db.query(`SELECT * FROM zip_signals WHERE zip = $1 LIMIT 1`, [zip])),
    safe(db.query(`SELECT COUNT(*)::int AS total FROM businesses WHERE zip = $1`, [zip])),
    safe(db.query(
      `SELECT detected_intent, COUNT(*)::int AS count
         FROM intent_dead_ends WHERE zip = $1
        GROUP BY detected_intent ORDER BY count DESC LIMIT 5`,
      [zip]
    )),
    safe(db.query(
      `SELECT detected_intent, COUNT(*)::int AS count
         FROM sms_query_log WHERE zip = $1
        GROUP BY detected_intent ORDER BY count DESC LIMIT 5`,
      [zip]
    )),
    safe(db.query(
      `SELECT category, COUNT(*)::int AS count FROM businesses
        WHERE zip = $1
          AND category ILIKE ANY(ARRAY['%restaurant%','%food%','%steak%','%dining%','%bar%','%cafe%','%grill%'])
        GROUP BY category ORDER BY count DESC LIMIT 10`,
      [zip]
    )),
  ]);

  const business_density = Array.isArray(densityRows) ? densityRows : [];
  const total_businesses = Array.isArray(totalBizRows) && totalBizRows[0] ? Number(totalBizRows[0].total || 0) : 0;
  const top_sms_intents  = Array.isArray(smsRows) ? smsRows : [];
  const unmet_demand     = Array.isArray(deadEndRows) ? deadEndRows : [];
  const sig              = Array.isArray(sigRows) && sigRows[0] ? sigRows[0] : {};
  const pr               = Array.isArray(propertyRows) && propertyRows[0] ? propertyRows[0] : {};
  const food_biz         = Array.isArray(foodBizRows) ? foodBizRows : [];
  const food_biz_count   = food_biz.reduce((s, r) => s + Number(r.count || 0), 0);

  const fmt = (v, d = 0) => v != null ? Number(v).toLocaleString('en-US', { maximumFractionDigits: d }) : null;
  const usd = (v) => v != null ? `$${Math.round(Number(v)).toLocaleString()}` : null;

  const median_hhi  = sig.acs_median_hhi != null ? Number(sig.acs_median_hhi) : null;
  const population  = sig.acs_population != null ? Number(sig.acs_population) : null;
  const net_returns = sig.irs_mig_net_returns != null ? Number(sig.irs_mig_net_returns) : null;
  const net_agi_k   = sig.irs_mig_net_agi != null ? Number(sig.irs_mig_net_agi) : null;
  const growth_score = sig.sig_growth_score != null ? Number(sig.sig_growth_score) : null;
  const opportunity_score = sig.sig_opportunity_score != null ? Number(sig.sig_opportunity_score) : null;
  const income_tier = sig.sig_income_tier || null;
  const market_maturity = sig.sig_market_maturity || null;
  const per_capita = sig.bea_per_capita_income != null ? Number(sig.bea_per_capita_income) : null;
  const turnover_rate = sig.qwi_turnover_rate != null ? Number(sig.qwi_turnover_rate) : null;
  const avg_monthly_earn = sig.qwi_avg_monthly_earn != null ? Number(sig.qwi_avg_monthly_earn) : null;
  const avg_weekly_wages = sig.qcew_avg_weekly_wages != null ? Number(sig.qcew_avg_weekly_wages) : null;
  const unemployment = sig.fred_unemployment_rate != null ? Number(sig.fred_unemployment_rate) : null;
  const units_annual = sig.bps_total_units_annual != null ? Number(sig.bps_total_units_annual) : null;
  const avg_assessed = pr.avg_assessed != null ? Number(pr.avg_assessed) : null;
  const avg_sqft = pr.avg_sqft != null ? Number(pr.avg_sqft) : null;

  // ── Category detection ──────────────────────────────────────────────────────
  const Q = question.toLowerCase();
  const hasAny = (kws) => kws.some((k) => Q.includes(k));

  const KW = {
    restaurant_concept: ['steak','steakhouse','restaurant','dining','food','cuisine','bar','grill','cafe','bistro','pizza','sushi','bbq','burger','taco','menu','concept','open a'],
    lease_viability:    ['lease','rent','sqft','per square','space','location','landlord','afford','support'],
    sector_gap:         ['gap','missing','opportunity','undersupplied','need','what\'s needed','what is needed','lacking','market'],
    growth_trajectory:  ['growing','growth','trend','future','trajectory','direction','momentum','invest'],
    labor_staffing:     ['staff','hire','labor','workers','turnover','wages','employees','hiring','workforce'],
  };

  let category = 'general';
  // Order matters — restaurant_concept first since "bar"/"food" are specific
  for (const cat of ['restaurant_concept','lease_viability','sector_gap','growth_trajectory','labor_staffing']) {
    if (hasAny(KW[cat])) { category = cat; break; }
  }

  // ── Build answer per category ───────────────────────────────────────────────
  let verdict = '';
  let answer = '';
  let supporting_data = {};
  let lease_signal = null;
  let confidence = 'medium';

  if (category === 'restaurant_concept') {
    // Sub-category detection within restaurant_concept
    const qsrKeywords = ['smoothie', 'juice', 'qsr', 'quick service', 'fast casual', 'coffee', 'cafe', 'sandwich', 'pizza', 'taco', 'burger', 'fast food', 'counter'];
    const upscaleKeywords = ['steakhouse', 'steak', 'fine dining', 'tasting menu', 'upscale', 'premium dining'];
    const casualKeywords = ['casual', 'bistro', 'bar', 'grill', 'tavern', 'pub'];

    let subCategory = 'general';
    if (qsrKeywords.some(k => Q.includes(k))) subCategory = 'qsr';
    else if (upscaleKeywords.some(k => Q.includes(k))) subCategory = 'upscale';
    else if (casualKeywords.some(k => Q.includes(k))) subCategory = 'casual';

    const reasons = [];
    let strongMatch = false;
    let moderateMatch = false;

    if (median_hhi != null) {
      if (subCategory === 'qsr') {
        if (median_hhi > 100000) {
          reasons.push('Affluent market with high demand for quality fast-casual/QSR');
          strongMatch = true;
        } else if (median_hhi > 80000) {
          reasons.push('Strong income base for fast-casual/QSR');
          strongMatch = true;
        } else if (median_hhi > 60000) {
          reasons.push('Solid income base for QSR/fast-casual');
          moderateMatch = true;
        } else {
          reasons.push('Modest income base — value-tier QSR positioning');
        }
      } else if (subCategory === 'upscale') {
        if (median_hhi > 100000) {
          reasons.push('Strong income base for upscale dining');
          strongMatch = true;
        } else if (median_hhi > 75000) {
          reasons.push('Marginal income support for upscale — concept must be tightly positioned');
          moderateMatch = true;
        } else {
          reasons.push('Income profile below typical upscale dining threshold');
        }
      } else if (subCategory === 'casual') {
        if (median_hhi > 100000) {
          reasons.push('Strong income base for casual dining');
          strongMatch = true;
        } else if (median_hhi > 75000) {
          reasons.push('Solid income base for casual/mid-tier dining');
          strongMatch = true;
        } else if (median_hhi > 55000) {
          reasons.push('Moderate income base for casual dining');
          moderateMatch = true;
        } else {
          reasons.push('Modest income base — pricing must stay mid-market');
        }
      } else {
        if (median_hhi > 100000) {
          reasons.push('Strong income base for upscale dining');
          strongMatch = true;
        } else if (median_hhi > 75000) {
          reasons.push('Solid income base for casual/upscale');
          moderateMatch = true;
        } else {
          reasons.push('Modest income base — pricing must stay mid-market');
        }
      }
    }
    if (net_returns != null && net_returns > 0) reasons.push('Growing household base');
    if (growth_score != null && growth_score > 70) reasons.push('High-growth market');

    let saturationNote = null;
    if (food_biz_count > 60 && population != null && population < 35000) {
      saturationNote = `Food category may be saturated (${food_biz_count} food businesses vs ${fmt(population)} population)`;
    } else if (food_biz_count < 30 && population != null && population > 20000) {
      saturationNote = `Food category appears undersupplied (only ${food_biz_count} food businesses for ${fmt(population)} residents)`;
    }
    if (saturationNote) reasons.push(saturationNote);

    // Verdict per sub-category
    if (subCategory === 'qsr') {
      if (strongMatch && median_hhi != null && median_hhi > 100000) {
        verdict = 'Strong match — affluent market with high demand for quality fast-casual/QSR';
      } else if (strongMatch) {
        verdict = 'Strong match — income profile supports fast-casual/QSR daily visit frequency';
      } else if (moderateMatch) {
        verdict = 'Moderate match — income supports QSR/fast-casual pricing';
      } else {
        verdict = 'Weak match — value-tier QSR positioning required';
      }
    } else if (subCategory === 'upscale') {
      if (strongMatch) {
        verdict = 'Strong match — income profile supports upscale concept';
      } else if (moderateMatch) {
        verdict = 'Moderate match — upscale viable with tight positioning';
      } else {
        verdict = 'Weak match — income profile favors casual/mid-market concepts';
      }
    } else if (subCategory === 'casual') {
      if (strongMatch) {
        verdict = 'Strong match — income profile supports casual/mid-tier concept';
      } else if (moderateMatch) {
        verdict = 'Moderate match — casual dining viable at mid-market pricing';
      } else {
        verdict = 'Weak match — income profile favors value-tier concepts';
      }
    } else {
      verdict = strongMatch
        ? 'Strong match — income profile supports upscale concept'
        : (moderateMatch
          ? 'Moderate match — income supports casual/mid-tier concept'
          : 'Weak match — income profile favors value/mid-market concepts');
    }

    const sentences = [];
    if (population != null && median_hhi != null) {
      sentences.push(`${zip} has ${fmt(population)} residents with median HHI of ${usd(median_hhi)}${income_tier ? ` (${income_tier} tier)` : ''}.`);
    } else if (median_hhi != null) {
      sentences.push(`${zip} has median HHI of ${usd(median_hhi)}.`);
    }
    if (net_returns != null) {
      const dir = net_returns >= 0 ? 'adding' : 'losing';
      const agiPart = net_agi_k != null ? ` with ${usd(net_agi_k * 1000)} net AGI` : '';
      sentences.push(`Migration is ${dir} ${fmt(Math.abs(net_returns))} net households annually${agiPart}.`);
    }
    if (growth_score != null) {
      sentences.push(`Growth score is ${growth_score}/100${opportunity_score != null ? `, opportunity ${opportunity_score}/100` : ''}.`);
    }
    if (food_biz_count > 0) {
      sentences.push(`${food_biz_count} food-category businesses already operating.`);
    }
    if (saturationNote) sentences.push(saturationNote + '.');
    answer = sentences.join(' ');

    supporting_data = {
      concept_sub_category: subCategory,
      median_hhi: median_hhi != null ? usd(median_hhi) : null,
      income_tier,
      population: population != null ? fmt(population) : null,
      net_migration_returns: net_returns != null ? fmt(net_returns) : null,
      food_business_count: food_biz_count,
      growth_score,
      opportunity_score,
      top_food_categories: food_biz.slice(0, 5).map(r => `${r.category} (${r.count})`).join(', '),
    };

    // Concept-aware lease_signal
    if (subCategory === 'qsr') {
      if (median_hhi != null && median_hhi > 80000) {
        lease_signal = {
          viable: true,
          note: 'QSR/fast-casual lease typically $20-35/sqft — income profile strongly supports daily visit frequency',
          min_hhi_met: true,
        };
      } else if (median_hhi != null && median_hhi > 55000) {
        lease_signal = {
          viable: true,
          note: 'QSR/fast-casual lease typically $18-28/sqft — income supports value-to-mid-tier pricing',
          min_hhi_met: true,
        };
      } else {
        lease_signal = {
          viable: false,
          note: 'Income profile may not support QSR daily visit frequency at typical lease rates',
          min_hhi_met: false,
        };
      }
    } else if (subCategory === 'upscale') {
      if (median_hhi != null && median_hhi > 100000) {
        lease_signal = {
          viable: true,
          note: 'Income profile supports upscale pricing ($50-90/pp avg check)',
          min_hhi_met: true,
        };
      } else if (median_hhi != null && median_hhi > 75000) {
        lease_signal = {
          viable: true,
          note: 'Income profile marginally supports upscale pricing — tight concept positioning required',
          min_hhi_met: true,
        };
      } else {
        lease_signal = {
          viable: false,
          note: 'Income profile may not support premium steakhouse/fine-dining pricing',
          min_hhi_met: false,
        };
      }
    } else if (subCategory === 'casual') {
      if (median_hhi != null && median_hhi > 75000) {
        lease_signal = {
          viable: true,
          note: 'Income profile supports casual/mid-tier dining pricing ($20-40/pp avg check)',
          min_hhi_met: true,
        };
      } else if (median_hhi != null && median_hhi > 55000) {
        lease_signal = {
          viable: true,
          note: 'Income profile supports value-to-mid-tier casual dining',
          min_hhi_met: true,
        };
      } else {
        lease_signal = {
          viable: false,
          note: 'Income profile suggests value-tier positioning required',
          min_hhi_met: false,
        };
      }
    } else {
      if (median_hhi != null && median_hhi > 100000) {
        lease_signal = {
          viable: true,
          note: 'Income profile supports upscale pricing ($50-90/pp avg check)',
          min_hhi_met: true,
        };
      } else if (median_hhi != null && median_hhi > 75000) {
        lease_signal = {
          viable: true,
          note: 'Income profile supports casual/upscale pricing ($25-50/pp avg check)',
          min_hhi_met: true,
        };
      } else {
        lease_signal = {
          viable: false,
          note: 'Income profile favors value/mid-market concepts',
          min_hhi_met: false,
        };
      }
    }

    confidence = (median_hhi != null && population != null) ? 'high' : 'medium';
  }
  else if (category === 'lease_viability') {
    const parts = [];
    const densityRatio = (population != null && population > 0) ? (total_businesses / population) * 1000 : null;

    if (avg_assessed != null) parts.push(`avg parcel assessed at ${usd(avg_assessed)}`);
    if (avg_sqft != null) parts.push(`avg ${fmt(avg_sqft)} sqft`);
    if (median_hhi != null) parts.push(`median HHI ${usd(median_hhi)}`);
    if (per_capita != null) parts.push(`per capita income ${usd(per_capita)}`);
    if (densityRatio != null) parts.push(`${densityRatio.toFixed(1)} businesses per 1,000 residents`);

    const hhiSupportsCommercial = median_hhi != null && median_hhi >= 65000;
    const hasDensity = total_businesses >= 100;

    if (hhiSupportsCommercial && hasDensity) {
      verdict = 'Market supports commercial lease rates';
      confidence = 'high';
    } else if (hhiSupportsCommercial || hasDensity) {
      verdict = 'Marginal — lease support depends on concept fit';
      confidence = 'medium';
    } else {
      verdict = 'Weak — limited income/density to support typical retail/restaurant lease';
      confidence = 'medium';
    }

    answer = `Lease viability for ${zip}: ${parts.join(', ')}.`;
    if (median_hhi != null && median_hhi > 100000) {
      answer += ' Income base supports premium retail/restaurant rents ($30-60/sqft NNN range).';
    } else if (median_hhi != null && median_hhi > 65000) {
      answer += ' Income supports mid-market retail rents ($15-30/sqft NNN range).';
    } else {
      answer += ' Income profile suggests rents must stay under ~$15/sqft NNN to pencil.';
    }

    supporting_data = {
      median_hhi: median_hhi != null ? usd(median_hhi) : null,
      per_capita_income: per_capita != null ? usd(per_capita) : null,
      avg_parcel_assessed: avg_assessed != null ? usd(avg_assessed) : null,
      avg_parcel_sqft: avg_sqft != null ? fmt(avg_sqft) : null,
      total_businesses,
      population: population != null ? fmt(population) : null,
      businesses_per_1k: densityRatio != null ? Number(densityRatio.toFixed(1)) : null,
    };

    lease_signal = {
      viable: hhiSupportsCommercial && hasDensity,
      note: hhiSupportsCommercial
        ? 'HHI supports commercial lease pricing'
        : 'HHI below typical commercial threshold (~$65k)',
      min_hhi_met: hhiSupportsCommercial,
    };
  }
  else if (category === 'sector_gap') {
    const popK = population != null ? population / 1000 : null;
    const gaps = [];
    if (popK != null && popK > 0) {
      const expectedPer1k = { restaurant: 2.0, retail: 3.0, healthcare: 1.5, professional: 2.5 };
      const counts = {};
      for (const row of business_density) {
        const cat = (row.category || '').toLowerCase();
        for (const key of Object.keys(expectedPer1k)) {
          if (cat.includes(key)) counts[key] = (counts[key] || 0) + Number(row.count || 0);
        }
      }
      for (const [key, expected] of Object.entries(expectedPer1k)) {
        const actual = counts[key] || 0;
        const expectedTotal = Math.round(expected * popK);
        if (actual < expectedTotal) {
          gaps.push({ sector: key, actual, expected: expectedTotal, gap: expectedTotal - actual });
        }
      }
      gaps.sort((a, b) => b.gap - a.gap);
    }

    const oppLabel = opportunity_score != null
      ? (opportunity_score > 70 ? 'high' : opportunity_score > 40 ? 'moderate' : 'low')
      : 'unknown';

    if (gaps.length > 0) {
      verdict = `${gaps.length} sector gap(s) identified — opportunity score ${oppLabel}`;
      const top3 = gaps.slice(0, 3).map(g => `${g.sector} (${g.actual} actual vs ${g.expected} expected, gap ${g.gap})`).join('; ');
      answer = `Top undersupplied sectors in ${zip}: ${top3}. Opportunity score ${opportunity_score || 'n/a'}/100.`;
    } else {
      verdict = 'No clear sector gaps in tracked categories';
      answer = `${zip} appears adequately covered across restaurant, retail, healthcare, and professional categories based on per-capita ratios. Opportunity score ${opportunity_score || 'n/a'}/100.`;
    }

    supporting_data = {
      population: population != null ? fmt(population) : null,
      opportunity_score,
      growth_score,
      top_categories: business_density.slice(0, 5),
      gaps: gaps.slice(0, 5),
    };
    confidence = (population != null && business_density.length > 0) ? 'high' : 'low';
  }
  else if (category === 'growth_trajectory') {
    const indicators = [];
    if (growth_score != null) indicators.push(`growth score ${growth_score}/100`);
    if (opportunity_score != null) indicators.push(`opportunity ${opportunity_score}/100`);
    if (net_returns != null) indicators.push(`net migration ${net_returns >= 0 ? '+' : ''}${fmt(net_returns)} returns/yr`);
    if (units_annual != null) indicators.push(`${fmt(units_annual)} residential units permitted/yr`);
    if (market_maturity) indicators.push(`maturity: ${market_maturity}`);

    let trajectory;
    if (growth_score != null && growth_score > 70) trajectory = 'High growth';
    else if (growth_score != null && growth_score > 40) trajectory = 'Steady growth';
    else if (growth_score != null) trajectory = 'Slow/flat';
    else if (net_returns != null) trajectory = net_returns > 0 ? 'Growing (migration positive)' : 'Declining (migration negative)';
    else trajectory = 'Unknown';

    verdict = `Trajectory: ${trajectory}`;
    answer = `${zip} growth signals — ${indicators.join(', ') || 'no growth data available'}.`;

    supporting_data = {
      growth_score,
      opportunity_score,
      net_migration_returns: net_returns != null ? fmt(net_returns) : null,
      net_migration_agi: net_agi_k != null ? usd(net_agi_k * 1000) : null,
      units_permitted_annual: units_annual != null ? fmt(units_annual) : null,
      market_maturity,
    };
    confidence = growth_score != null ? 'high' : 'medium';
  }
  else if (category === 'labor_staffing') {
    const parts = [];
    if (unemployment != null) parts.push(`unemployment ${unemployment.toFixed(1)}%`);
    if (turnover_rate != null) parts.push(`turnover ${turnover_rate.toFixed(1)}%`);
    if (avg_monthly_earn != null) parts.push(`avg monthly earn ${usd(avg_monthly_earn)}`);
    if (avg_weekly_wages != null) parts.push(`avg weekly wages ${usd(avg_weekly_wages)}`);

    const tightLabor = unemployment != null && unemployment < 3.5;
    const highTurnover = turnover_rate != null && turnover_rate > 12;

    if (tightLabor && highTurnover) {
      verdict = 'Tight labor + high turnover — staffing will be a constraint';
      confidence = 'high';
    } else if (tightLabor) {
      verdict = 'Tight labor market — expect wage pressure';
      confidence = 'high';
    } else if (highTurnover) {
      verdict = 'High turnover — retention will require above-market wages';
      confidence = 'medium';
    } else {
      verdict = 'Labor market appears workable for staffing';
      confidence = 'medium';
    }

    answer = `${zip} labor signals — ${parts.join(', ') || 'limited labor data available'}.`;

    supporting_data = {
      unemployment_rate: unemployment != null ? `${unemployment.toFixed(1)}%` : null,
      turnover_rate: turnover_rate != null ? `${turnover_rate.toFixed(1)}%` : null,
      avg_monthly_earn: avg_monthly_earn != null ? usd(avg_monthly_earn) : null,
      avg_weekly_wages: avg_weekly_wages != null ? usd(avg_weekly_wages) : null,
    };
  }
  else {
    // general fallback — reuse ceo-assess style summary
    const lines = [];
    if (population != null) lines.push(`${zip}: ${fmt(population)} residents${median_hhi != null ? `, median HHI ${usd(median_hhi)}` : ''}.`);
    if (total_businesses > 0) {
      const topCats = business_density.slice(0, 3).map((r) => `${r.category} (${r.count})`).join(', ');
      lines.push(`${total_businesses} businesses${topCats ? ` — top: ${topCats}` : ''}.`);
    }
    if (growth_score != null) lines.push(`Growth ${growth_score}/100, opportunity ${opportunity_score || '?'}/100, maturity: ${market_maturity || 'n/a'}.`);

    verdict = 'General market snapshot';
    answer = lines.join(' ') + ' For richer answers, ask about concept viability, lease support, sector gaps, growth trajectory, or labor/staffing.';
    supporting_data = {
      population: population != null ? fmt(population) : null,
      median_hhi: median_hhi != null ? usd(median_hhi) : null,
      total_businesses,
      growth_score,
      opportunity_score,
    };
    confidence = 'low';
  }

  // ── County ranking block — runs when question has comparative/location intent
  // "where should I", "which ZIP", "best location", "compare", "invest in a X"
  // Deterministic — zero LLM. Scores all county ZIPs using same concept weights.
  let county_ranking = null;
  const isComparativeQ = /\b(where should|which zip|best zip|best location|where to open|where to invest|compare zip|rank.*zip|invest in a|best area|best place to open|which area)\b/i.test(question);
  if (isComparativeQ) {
    try {
      // Get county for this ZIP, then all ZIPs in that county
      const geoRow = await db.query(
        `SELECT county FROM fl_zip_geo WHERE zip = $1 LIMIT 1`, [zip]
      ).catch(() => []);
      const zipCounty = Array.isArray(geoRow) && geoRow[0]?.county ? geoRow[0].county : null;

      if (zipCounty) {
        const countyZipRows = await db.query(
          `SELECT fz.zip, fz.lat, fz.lon
             FROM fl_zip_geo fz
             WHERE fz.county = $1 AND fz.state = 'FL'`,
          [zipCounty]
        ).catch(() => []);
        const countyZips = Array.isArray(countyZipRows) ? countyZipRows.map(r => r.zip) : [];

        if (countyZips.length > 1) {
          const rankSigRows = await db.query(
            `SELECT zip, acs_median_hhi, acs_population, acs_owner_occ_pct,
                    acs_college_pct, acs_median_age, acs_poverty_pct,
                    fred_unemployment_rate, sig_growth_score, sig_opportunity_score,
                    sig_risk_score, sig_market_maturity, osm_biz_count,
                    zbp_total_establishments, bps_total_units_annual, qcew_avg_weekly_wages,
                    fdot_max_aadt, fdot_avg_aadt, fdot_top_road,
                    lodes_jobs_here, biz_density_per_1k,
                    osm_road_class, osm_access_score, osm_fast_food_count,
                    osm_golf_count, osm_arts_count, osm_worship_count, osm_fitness_count,
                    acs_pct_bachelors_plus, acs_pct_stem_occupations, psycho_index
               FROM zip_signals WHERE zip = ANY($1)`,
            [countyZips]
          ).catch(() => []);
          const rankRows = Array.isArray(rankSigRows) ? rankSigRows : [];

          // B62: route this question through the unified scoring engine.
          const conceptKey = detectConcept(question);
          const profile = CONCEPT_PROFILES[conceptKey] || CONCEPT_PROFILES.GENERAL;
          const bounds = await getStatewideBounds();

          const scored = rankRows
            .map(s => {
              const result = scoreZipForConcept(s, profile, bounds);
              const top = (result.factor_breakdown || []).slice().sort((a,b) => b.points - a.points).slice(0,3);
              const reason = result.hard_floor_triggered
                ? `Filtered: ${result.hard_floor_reason}`
                : top.map(f => `${f.label} ${f.points}pts`).join(', ') || 'no factors';
              return {
                zip:      s.zip,
                score:    result.total_score,
                reason,
                factor_breakdown: result.factor_breakdown,
                hard_floor_triggered: result.hard_floor_triggered,
                hard_floor_reason:    result.hard_floor_reason,
                hhi:      s.acs_median_hhi ? `$${Math.round(Number(s.acs_median_hhi)/1000)}k` : null,
                pop:      s.acs_population ? Math.round(Number(s.acs_population)/1000) + 'k' : null,
                growth:   s.sig_growth_score,
                maturity: s.sig_market_maturity,
                aadt:     s.fdot_max_aadt ? Math.round(Number(s.fdot_max_aadt)/1000) + 'k' : null,
                top_road: s.fdot_top_road || null,
              };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);

          if (scored.length > 0) {
            county_ranking = {
              county:       zipCounty,
              concept:      conceptKey,
              concept_name: profile.name,
              zips_scored:  rankRows.length,
              zips_in_county: countyZips.length,
              note:         'B62 unified scoring: min-max / Gaussian / sigmoid normalization against statewide bounds, weighted per concept profile. Hard floors filter unfit ZIPs.',
              rankings:     scored,
            };
            // Prepend ranking to answer
            const top3 = scored.slice(0, 3).map((z, i) =>
              `#${i+1} ${z.zip} (score ${z.score}/100 — ${z.reason})`
            ).join('; ');
            answer = `Top ZIPs in ${zipCounty} County for ${profile.name}: ${top3}. ${answer}`;
            verdict = `${zipCounty} County ranked for ${profile.name} — see county_ranking + factor_breakdown for transparent scoring`;
            confidence = 'high';
          }
        }
      }
    } catch (e) {
      console.warn('[ceo-query] county ranking failed:', e.message);
    }
  }

  return res.json({
    zip,
    question,
    category,
    concept_detected: county_ranking?.concept || detectConcept(question),
    concept_name: county_ranking?.concept_name || (CONCEPT_PROFILES[detectConcept(question)] || CONCEPT_PROFILES.GENERAL).name,
    verdict,
    answer,
    supporting_data,
    lease_signal,
    confidence,
    county_ranking,
    scoring_explanation: county_ranking ? {
      how_scores_work: 'Each ZIP is scored 0–100. Points are awarded across 5–7 factors depending on concept type. Scores are relative — a 90 in a rural county and a 90 in Broward mean the same within their county context.',
      factors: county_ranking.concept === 'restaurant_concept'
        ? [
            { factor: 'Household Income (HHI)',   max_pts: 35, note: '$100k+ = 35pts, $80k+ = 25pts, $60k+ = 15pts. QSR customers need disposable income.' },
            { factor: 'Growth Score',              max_pts: 20, note: '70+ = 20pts, 50+ = 10pts. Growing markets have rising foot traffic.' },
            { factor: 'Opportunity Score',         max_pts: 20, note: '70+ = 20pts. Measures unmet demand — fewer competitors in category.' },
            { factor: 'Population',                max_pts: 10, note: '20k+ = 10pts, 10k+ = 5pts. More residents = more drive-by traffic base.' },
            { factor: 'College %',                 max_pts:  5, note: '40%+ = 5pts. College-educated areas skew toward QSR frequency.' },
            { factor: 'Low Unemployment',          max_pts:  5, note: 'Under 4% = 5pts. Employed population = spending power.' },
            { factor: 'Road Traffic (AADT)',        max_pts: 10, note: '80k+ daily = 10pts (major corridor like I-95/US-1), 40k+ = 7pts (arterial), 20k+ = 4pts (collector), 5k+ = 2pts. Uses FDOT 2025 data. Falls back to commercial business density if AADT not yet populated.' },
          ]
        : county_ranking.concept?.includes('upscale') || county_ranking.concept?.includes('fine')
        ? [
            { factor: 'Household Income (HHI)',   max_pts: 40, note: '$130k+ = 40pts, $100k+ = 30pts, $80k+ = 15pts. Fine dining requires high discretionary spend.' },
            { factor: 'Owner-Occupancy Rate',      max_pts: 15, note: '60%+ = 15pts. Homeowners are more likely to be repeat fine dining customers.' },
            { factor: 'Growth Score',              max_pts: 15, note: '70+ = 15pts. Growing affluent markets fill white-tablecloth seats.' },
            { factor: 'Opportunity Score',         max_pts: 15, note: '70+ = 15pts. Fewer upscale competitors = stronger position.' },
            { factor: 'Median Age',                max_pts: 10, note: '38+ = 10pts. Older demographics have higher restaurant spend.' },
            { factor: 'College %',                 max_pts:  5, note: '50%+ = 5pts.' },
            { factor: 'Road Traffic (AADT)',        max_pts:  5, note: '40k+ = 5pts, 15k+ = 2pts. Visibility matters but demographics dominate for upscale.' },
          ]
        : [
            { factor: 'Growth Score',    max_pts: 35, note: 'General market growth trajectory.' },
            { factor: 'Opportunity Score', max_pts: 35, note: 'Unmet demand relative to supply.' },
            { factor: 'Household Income', max_pts: 30, note: 'Income base for consumer spending.' },
          ],
      traffic_source: 'FDOT Florida Traffic Online (FTO) — ArcGIS Layer 7, 2025 AADT. Road segments spatially joined to ZIP centroids (~5km radius). Updates annually.',
      data_note: 'All signals from Postgres (zip_signals table). Workers: acsWorker (HHI/demographics), worldModelWorker (growth/opportunity scores), fdotWorker (AADT), overpassWorker (business density fallback).',
    } : null,
    answered_at: new Date().toISOString(),
  });
});

// ── B45: Subscriber LLM Chat Endpoint ─────────────────────────────────────────
// POST /api/local-intel/chat
// callLLMWithFallback — tries Anthropic Haiku first (15s), falls back to OpenAI gpt-4.1-mini.
// systemText: string. messages: [{role,content}]. Returns { answer, model, tokensUsed }.
async function callLLMWithFallback(systemText, messages) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const openaiKey    = process.env.OPENAI_API_KEY;

  // ── Anthropic attempt ────────────────────────────────────────────────────
  if (anthropicKey) {
    try {
      const ac = new AbortController();
      const t  = setTimeout(() => ac.abort(), 15000);
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'x-api-key':         anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify({
          model:      'claude-haiku-4-5',
          max_tokens: 900,
          system:     systemText,
          messages,
        }),
      });
      clearTimeout(t);
      const j = await res.json();
      const text = j?.content?.[0]?.text || '';
      if (text.trim().length > 10) {
        const cached   = Number(j?.usage?.cache_read_input_tokens || 0);
        const uncached = Number(j?.usage?.cache_creation_input_tokens || j?.usage?.input_tokens || 0);
        return { answer: text, model: 'claude-haiku-4-5', tokensUsed: cached + uncached + Number(j?.usage?.output_tokens || 0) };
      }
      console.warn('[chat] Anthropic returned empty/error — falling back to OpenAI:', j?.error?.message || 'empty content');
    } catch (e) {
      console.warn('[chat] Anthropic fetch failed — falling back to OpenAI:', e.message);
    }
  }

  // ── OpenAI fallback ───────────────────────────────────────────────────────
  if (openaiKey) {
    const ac = new AbortController();
    const t  = setTimeout(() => ac.abort(), 20000);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ac.signal,
      headers: {
        'Authorization': `Bearer ${openaiKey}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        model:      'gpt-4.1-mini',
        max_tokens: 900,
        messages:   [{ role: 'system', content: systemText }, ...messages],
      }),
    });
    clearTimeout(t);
    const j = await res.json();
    const text = j?.choices?.[0]?.message?.content || '';
    if (text.trim().length > 10) {
      const usage = j?.usage || {};
      return { answer: text, model: 'gpt-4.1-mini', tokensUsed: (usage.prompt_tokens || 0) + (usage.completion_tokens || 0) };
    }
    throw new Error(`OpenAI error: ${j?.error?.message || 'empty response'}`);
  }

  throw new Error('No LLM configured — set ANTHROPIC_API_KEY or OPENAI_API_KEY');
}

// Phone-based subscriber auth (5 free trial queries, then $9.99/mo gates).
// Loads zip_signals + business/property context, computes data_confidence,
// and calls LLM (Anthropic Haiku → OpenAI gpt-4.1-mini fallback) with grounded prompt.
router.post('/chat', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  try {
    const { phone, question, zip: zipIn } = req.body || {};
    if (!phone || !question) {
      return res.status(400).json({ ok: false, error: 'phone and question required' });
    }

    // B73: Owner bypass — Erik (or any operator) skips the trial gate.
    // Set OWNER_PHONE in Railway env (comma-separated for multiple numbers).
    const normalizePhone = (p) => (p || '').replace(/\D/g, '');
    const OWNER_PHONES = (process.env.OWNER_PHONE || '')
      .split(',')
      .map(p => normalizePhone(p))
      .filter(Boolean);
    const isOwner = OWNER_PHONES.includes(normalizePhone(phone));

    // A) Auth / trial provisioning
    await db.query(
      `INSERT INTO subscriber_accounts (phone, tier, status, trial_queries_used, trial_queries_limit)
         VALUES ($1, 'chat', 'trial', 0, 5)
       ON CONFLICT (phone) DO NOTHING`,
      [phone]
    ).catch(() => {});

    const subRows = await db.query(
      `SELECT id, status, trial_queries_used, trial_queries_limit
         FROM subscriber_accounts WHERE phone = $1 LIMIT 1`,
      [phone]
    ).catch(() => []);
    const sub = Array.isArray(subRows) && subRows[0] ? subRows[0] : null;
    if (!sub) {
      return res.status(500).json({ ok: false, error: 'subscriber lookup failed' });
    }
    const isSubscriber = sub.status === 'active';
    const trialUsed    = Number(sub.trial_queries_used || 0);
    const trialLimit   = Number(sub.trial_queries_limit || 5);
    const trialAllowed = sub.status === 'trial' && trialUsed < trialLimit;
    if (!isOwner && !isSubscriber && !trialAllowed) {
      return res.status(402).json({
        ok: false,
        error: 'trial_exhausted',
        message: `Trial queries exhausted (${trialUsed}/${trialLimit}). Subscribe at $9.99/mo for unlimited access.`,
        trial_remaining: 0,
        is_subscriber: false,
      });
    }
    const trialRemaining = (isOwner || isSubscriber) ? null : Math.max(0, trialLimit - trialUsed);

    // B) Resolve place from question (FL place name → ZIP; falls back to zipIn or default)
    // B53: resolvePlace is now async — queries fl_place_index + fl_county_zips in Postgres
    const placeResult = await resolvePlace(question);
    let zip = placeResult.zip;
    if (zipIn) {
      const zipInTrim = String(zipIn).trim();
      const explicitZipMatch = String(question).match(/\b(\d{5})\b/);
      if (!explicitZipMatch && !placeResult.isCounty) {
        // No explicit ZIP and no county/city match — prefer client-supplied zipIn
        // when the resolver fell through to its default.
        const fellThroughToDefault = !placeResult.countyKey && placeResult.zip === '32082';
        if (fellThroughToDefault && /^\d{5}$/.test(zipInTrim)) zip = zipInTrim;
      }
    }
    const isCountyQuery = placeResult.isCounty && placeResult.countyZips;

    // B78: SunBiz concept detection — trades / contractor / licensing queries.
    // When the user is asking about contractors, roofing, HVAC, plumbing, electrical,
    // licensing, etc. we surface registered FL entities from sunbiz_raw into the
    // grounding context. Pure food/retail/healthcare questions do NOT trigger this.
    const SUNBIZ_CONCEPT_RE = /\b(contractor|contractors|trades?|tradesperson|roof(?:er|ers|ing)?|licens(?:e|ed|ing|ure)|hvac|a\/c|air conditioning|plumb(?:er|ers|ing)?|electric(?:al|ian|ians)?|construction|builder|builders|handyman|remodel(?:er|ers|ing)?|carpent(?:er|ry)|paint(?:er|ers|ing)|landscap(?:er|ers|ing)|pool service|pest control|flooring|drywall|masonry|concrete|fence|fencing|septic|solar install)/i;
    const SUNBIZ_NAME_RE = '(roof|hvac|air conditioning|plumb|electric|construction|build|contractor|remodel|carpen|paint|landscap|pool service|pest control|flooring|drywall|masonry|concrete|fence|fencing|septic|solar|mechanical|trades?)';
    const isSunbizConcept = SUNBIZ_CONCEPT_RE.test(String(question || ''));

    // B78 — query sunbiz_raw for relevant registered entities in the given ZIPs.
    // Returns {rows, summary} where summary is a compact line for grounding.
    // B78b: sunbiz_raw.principal_zip is NULL across the board (SunBiz quarterly corp file
    // omits ZIP). Filter by principal_city ILIKE via fl_place_index instead; keep
    // principal_zip = ANY(...) as a fallback if ZIPs are ever populated.
    async function fetchSunbizContext(zips, areaLabel, cities = []) {
      if (!isSunbizConcept) return { rows: [], summary: '' };
      const haveZips   = Array.isArray(zips)   && zips.length   > 0;
      const haveCities = Array.isArray(cities) && cities.length > 0;
      if (!haveZips && !haveCities) return { rows: [], summary: '' };
      try {
        const rows = await db.query(
          `SELECT doc_number, entity_name, entity_type, status, principal_city,
                  principal_zip, filed_date, last_event, last_event_date
             FROM sunbiz_raw
            WHERE (
                    EXISTS (SELECT 1 FROM unnest($1::text[]) AS c WHERE principal_city ILIKE c)
                    OR principal_zip = ANY($2)
                  )
              AND entity_name ~* $3
              AND (status IS NULL OR status ILIKE 'ACTIVE%' OR status ILIKE 'A%')
            ORDER BY (CASE WHEN status ILIKE 'ACTIVE%' OR status ILIKE 'A%' THEN 0 ELSE 1 END),
                     filed_date DESC NULLS LAST
            LIMIT 20`,
          [haveCities ? cities : [], haveZips ? zips : [], SUNBIZ_NAME_RE]
        ).catch(() => []);
        const list = Array.isArray(rows) ? rows : [];
        if (!list.length) return { rows: [], summary: '' };
        const items = list.map(r => {
          const dt = r.filed_date ? new Date(r.filed_date).toISOString().slice(0, 10) : 'n/a';
          const city = r.principal_city || '';
          const status = (r.status || 'UNKNOWN').toString().trim();
          const type = r.entity_type ? ` ${r.entity_type}` : '';
          return `${r.entity_name} (${status}${type}, ${city} ${r.principal_zip || ''}, registered ${dt})`;
        });
        const summary =
          `SUNBIZ REGISTERED CONTRACTORS / TRADES IN ${areaLabel} (${list.length} active entities, most recent first):\n` +
          items.map(i => `- ${i}`).join('\n') +
          `\nUse these as concrete examples of registered FL businesses in this trade. ` +
          `These are official state registrations from sunbiz.org — they confirm legal entity status, not licensing per se. ` +
          `For contractor licensing specifics, point users to MyFloridaLicense.com (DBPR).`;
        return { rows: list, summary };
      } catch (e) {
        console.error('[chat] sunbiz fetch failed:', e.message);
        return { rows: [], summary: '' };
      }
    }

    // B.1) County-level branch: comparison/ranking + elaboration questions over a FL county
    const isCountyRanking     = isCountyQuery && /\b(best|where|which|top|compare|recommend|highest|lowest|most|least)\b/i.test(question);
    const isCountyElaboration = isCountyQuery && /\b(tell me more|elaborate|explain|what about|drill|detail|why|how does|more on|expand)\b/i.test(question);
    if (isCountyRanking || isCountyElaboration) {
      const countyZips = placeResult.countyZips;
      const sigRowsCounty = await db.query(
        `SELECT zip, acs_population, acs_median_hhi, acs_owner_occ_pct, acs_college_pct,
                acs_median_age, acs_poverty_pct, fred_unemployment_rate, qcew_avg_weekly_wages,
                sig_growth_score, sig_opportunity_score, sig_risk_score,
                sig_market_maturity, sig_income_tier, bps_total_units_annual
           FROM zip_signals WHERE zip = ANY($1)`,
        [countyZips]
      ).catch(() => []);
      const rows = Array.isArray(sigRowsCounty) ? sigRowsCounty : [];

      // B75: detect food/dining concept to filter out non-food categories from business lists
      const FOOD_CONCEPT_RE = /\b(restaurant|food|eat|dining|dinner|lunch|bar|drink|healthy|cafe|coffee|cuisine|chef|menu)/i;
      const isFoodConcept = FOOD_CONCEPT_RE.test(String(question || ''));
      const foodFilterAggCounty = isFoodConcept
        ? ` AND NOT (b.category_group IN ('pharmacy','health','finance','automotive','legal','real_estate'))
            AND NOT (b.category IN ('pharmacy','bank','bank_branch','auto_repair','law_firm','real_estate'))`
        : '';
      const foodFilterLateralCounty = isFoodConcept
        ? ` AND NOT (b2.category_group IN ('pharmacy','health','finance','automotive','legal','real_estate'))
            AND NOT (b2.category IN ('pharmacy','bank','bank_branch','auto_repair','law_firm','real_estate'))`
        : '';

      // B74/B75: Pull business rollup per ZIP for this county (with tags + optional food filter)
      const bizRowsCounty = await db.query(
        `SELECT
           agg.zip,
           agg.total_businesses,
           agg.claimed_count,
           agg.wallet_count,
           agg.top_category,
           COALESCE(top5.top_businesses, '[]'::json) AS top_businesses
         FROM (
           SELECT
             b.zip,
             COUNT(*)::int AS total_businesses,
             COUNT(CASE WHEN b.claimed_at IS NOT NULL THEN 1 END)::int AS claimed_count,
             COUNT(CASE WHEN b.wallet IS NOT NULL THEN 1 END)::int AS wallet_count,
             mode() WITHIN GROUP (ORDER BY b.category) AS top_category
           FROM businesses b
           WHERE b.zip = ANY($1)
             ${foodFilterAggCounty}
           GROUP BY b.zip
         ) agg
         LEFT JOIN LATERAL (
           SELECT json_agg(
             json_build_object('name', t.name, 'category', t.category, 'claimed', t.claimed, 'tags', t.tags)
           ) AS top_businesses
           FROM (
             SELECT b2.name, b2.category, b2.tags, (b2.claimed_at IS NOT NULL) AS claimed
             FROM businesses b2
             WHERE b2.zip = agg.zip
               ${foodFilterLateralCounty}
             ORDER BY
               (CASE WHEN b2.claimed_at IS NOT NULL THEN 2 ELSE 0 END) +
               (CASE WHEN b2.wallet IS NOT NULL THEN 1 ELSE 0 END) +
               COALESCE(b2.confidence_score, 0) DESC
             LIMIT 5
           ) t
         ) top5 ON true`,
        [countyZips]
      ).catch(() => []);
      const bizByZip = {};
      for (const r of (Array.isArray(bizRowsCounty) ? bizRowsCounty : [])) {
        bizByZip[r.zip] = r;
      }

      // ── Concept detection — drives ZIP scoring weights and LLM instructions ──
      const Qc = question.toLowerCase();
      const conceptIs = (kws) => kws.some(k => Qc.includes(k));
      let conceptType  = 'general';
      let conceptLabel = 'this concept';
      let scoringGuide = '';

      if (conceptIs(['restaurant','restaurants','food','eat','dining','dinner','lunch','brunch','cafe','coffee','destination dining','best food','place to eat'])) {
        conceptType  = 'casual';
        conceptLabel = 'restaurants / casual dining';
        scoringGuide = `Score each ZIP 0-100 for restaurant / casual dining viability:
- HHI $75k+: +30pts
- HHI $55-75k: +20pts
- Growth score >60: +20pts
- Opportunity score >60: +20pts
- Population >15k: +15pts
- Unemployment <5%: +10pts
- Owner occupied pct >50%: +5pts
For each ZIP: state the score, name 2-3 actual top businesses from the data (use the top_businesses list), and whether the market leans destination dining vs neighborhood casual.`;
      } else if (conceptIs(['bar','bars','drinks','nightlife','happy hour'])) {
        conceptType  = 'bar';
        conceptLabel = 'bar / nightlife';
        scoringGuide = `Score each ZIP 0-100 for bar / nightlife viability:
- HHI $70k+: +25pts
- Median age 25-45 sweet spot: +20pts
- Growth score >60: +20pts
- Population >15k: +15pts
- College pct >35%: +10pts
- Unemployment <5%: +10pts
For each ZIP: state the score, name actual venues from top_businesses if present, and call out whether the area skews tourist/destination vs locals.`;
      } else if (conceptIs(['shop','shopping','store','retail','boutique'])) {
        conceptType  = 'retail';
        conceptLabel = 'retail / shopping';
        scoringGuide = `Score each ZIP 0-100 for retail / shopping viability:
- HHI $90k+: +30pts
- Growth score >65: +25pts
- Opportunity score >65: +20pts
- Owner occupied pct >55%: +15pts
- Population >25k: +10pts
For each ZIP: state the score, name actual retail names from top_businesses if present, and flag the retail gap or saturation.`;
      } else if (conceptIs(['gym','fitness','workout','yoga','pilates'])) {
        conceptType  = 'fitness';
        conceptLabel = 'fitness / wellness';
        scoringGuide = `Score each ZIP 0-100 for fitness / wellness viability:
- HHI $80k+: +30pts
- Median age 28-50: +20pts
- Growth score >60: +20pts
- College pct >40%: +15pts
- Population >15k: +10pts
- Unemployment <5%: +5pts
For each ZIP: state the score, name actual fitness/wellness businesses from top_businesses if present, and note demographic fit.`;
      } else if (conceptIs(['doctor','medical','clinic','health','dentist','healthcare'])) {
        conceptType  = 'healthcare';
        conceptLabel = 'healthcare / medical';
        scoringGuide = `Score each ZIP 0-100 for healthcare / medical concept viability:
- Population >15k: +25pts
- Median age >40: +20pts (higher healthcare utilization)
- HHI $70k+: +20pts
- Owner occupied pct >55%: +15pts
- Growth score >55: +10pts
- Opportunity score >55: +10pts
For each ZIP: state the score, name actual healthcare providers from top_businesses if present, and note demographic/utilization fit.`;
      } else if (conceptIs(['smoothie','juice bar','qsr','fast casual','sandwich','pizza','taco','burger','fast food'])) {
        conceptType  = 'qsr';
        conceptLabel = 'QSR / fast-casual';
        scoringGuide = `Score each ZIP 0-100 for QSR/fast-casual viability using these weights:
- HHI $100k+: +35pts (affluent base drives premium QSR spend)
- HHI $80-100k: +25pts
- HHI $60-80k: +15pts
- Growth score >70: +20pts (expanding customer base)
- Growth score >50: +10pts
- Opportunity score >70: +20pts (undersupplied market)
- Opportunity score >50: +10pts
- Population >20k: +10pts (traffic base)
- College pct >40%: +5pts (fast-casual preference demographic)
- Unemployment <4%: +5pts (disposable income signal)
For each ZIP: state the score, the top 2 reasons it ranks where it does, and one specific risk or advantage for THIS concept type (QSR/fast-casual), not generic market commentary.`;
      } else if (conceptIs(['steakhouse','steak','fine dining','tasting menu','upscale dining','premium dining','white tablecloth'])) {
        conceptType  = 'upscale';
        conceptLabel = 'upscale / fine dining';
        scoringGuide = `Score each ZIP 0-100 for upscale/fine dining viability using these weights:
- HHI $130k+: +40pts (primary signal for fine dining spend capacity)
- HHI $100-130k: +30pts
- HHI $80-100k: +15pts
- Owner occupied pct >60%: +15pts (stable resident base, not transient)
- Growth score >70: +15pts
- Opportunity score >70: +15pts (fine dining gap)
- Median age >38: +10pts (older demographics dine out more at upscale)
- College pct >50%: +5pts
For each ZIP: state the score, whether income SPECIFICALLY supports $80-$150+ check averages, and the competitive risk (is fine dining already saturated here).`;
      } else if (conceptIs(['casual dining','bar','grill','tavern','pub','bistro','brunch','neighborhood restaurant'])) {
        conceptType  = 'casual';
        conceptLabel = 'casual dining';
        scoringGuide = `Score each ZIP 0-100 for casual dining viability:
- HHI $75k+: +30pts
- HHI $55-75k: +20pts
- Growth score >60: +20pts
- Opportunity score >60: +20pts
- Population >15k: +15pts
- Unemployment <5%: +10pts
- Owner occupied pct >50%: +5pts
For each ZIP: state the score and whether the market is over- or under-served for casual dining specifically.`;
      } else if (conceptIs(['retail','shop','store','boutique','fitness','gym','salon','spa','service'])) {
        conceptType  = 'retail';
        conceptLabel = 'retail / service';
        scoringGuide = `Score each ZIP 0-100 for retail/service concept viability:
- HHI $90k+: +30pts
- Growth score >65: +25pts
- Opportunity score >65: +20pts
- Owner occupied pct >55%: +15pts (stable spender base)
- Population density (pop >25k): +10pts
For each ZIP: state the score and name the specific retail gap or saturation risk.`;
      } else {
        scoringGuide = `Score each ZIP 0-100 for general business viability:
- Growth score contributes 35% of total
- Opportunity score contributes 35% of total
- HHI (normalized, $50k=0 to $150k=30pts) contributes 30%
For each ZIP: state the score and the single most important data point.`;
      }

      const zipSummaries = rows.map(s => {
        const biz = bizByZip[s.zip];
        const bizLine = biz
          ? `\n  businesses=${biz.total_businesses} (claimed=${biz.claimed_count}, wallet=${biz.wallet_count}), top_category=${biz.top_category || 'n/a'}` +
            (Array.isArray(biz.top_businesses) && biz.top_businesses.length
              ? `\n  top_businesses: ${biz.top_businesses.map(b => {
                  const tagStr = b.tags && b.tags.length ? ` [${b.tags.slice(0,5).join(', ')}]` : '';
                  return `${b.name} (${b.category || 'n/a'})${b.claimed ? ' ✓' : ''}${tagStr}`;
                }).join(', ')}`
              : '')
          : '';
        return (
          `ZIP ${s.zip} (${s.sig_market_maturity || 'unknown maturity'}): ` +
          `HHI=$${s.acs_median_hhi || '?'}, pop=${s.acs_population || '?'}, ` +
          `growth=${s.sig_growth_score || '?'}/100, opp=${s.sig_opportunity_score || '?'}/100, ` +
          `owner_occ=${s.acs_owner_occ_pct || '?'}%, college=${s.acs_college_pct || '?'}%, ` +
          `median_age=${s.acs_median_age || '?'}, poverty=${s.acs_poverty_pct || '?'}%, ` +
          `unemployment=${s.fred_unemployment_rate || '?'}%, wages=${s.qcew_avg_weekly_wages || '?'}/wk, ` +
          `new_units_annual=${s.bps_total_units_annual || '?'}` +
          bizLine
        );
      }).join('\n');

      const withData = rows.length;
      const missing = countyZips.filter(z => !rows.find(s => s.zip === z));
      const data_confidence = Math.round((withData / countyZips.length) * 100);

      if (withData === 0) {
        return res.json({
          ok: true,
          zip: placeResult.countyKey,
          question,
          answer: `No zip_signals data is available yet for ${placeResult.countyKey} County. Try asking about a specific St. Johns County ZIP: 32082 (Ponte Vedra Beach), 32081 (Nocatee), 32250 (Jacksonville Beach), 32266 (Neptune Beach), 32259 (St. Johns), or 32034 (Fernandina Beach).`,
          data_confidence: 0,
          missing_signals: countyZips,
          trial_remaining: isOwner ? 999 : (!isSubscriber ? Math.max(0, trialLimit - trialUsed) : null),
          is_subscriber: isSubscriber,
          is_owner: isOwner,
          no_data: true,
        });
      }

      // Load conversation history for this subscriber+county (enables elaboration follow-ups)
      let countyConvMessages = [];
      try {
        const countyHistRows = await db.query(
          `SELECT question, answer FROM chat_log
             WHERE caller_id = $1 AND zip = $2 AND answer IS NOT NULL
             ORDER BY created_at DESC LIMIT 10`,
          [phone, placeResult.countyKey]
        ).catch(() => []);
        const countyHist = Array.isArray(countyHistRows) ? countyHistRows.reverse() : [];
        for (const h of countyHist) {
          countyConvMessages.push({ role: 'user',      content: h.question });
          countyConvMessages.push({ role: 'assistant', content: String(h.answer || '').slice(0, 800) });
        }
      } catch (_) { countyConvMessages = []; }
      countyConvMessages.push({ role: 'user', content: question });

      const countyDisplayName = placeResult.countyKey;

      // B78: SunBiz context (only when concept matches contractor/trades/licensing)
      // B78b: derive city names from countyZips via fl_place_index so we can ILIKE
      // sunbiz_raw.principal_city (principal_zip is null in the SunBiz feed).
      const sunbizCityRowsCounty = await db.query(
        `SELECT DISTINCT sunbiz_city FROM fl_place_index
         WHERE place_type = 'city' AND primary_zip = ANY($1) AND sunbiz_city IS NOT NULL`,
        [countyZips]
      ).catch(() => []);
      const sunbizCitiesCounty = (Array.isArray(sunbizCityRowsCounty) ? sunbizCityRowsCounty : []).map(r => r.sunbiz_city);
      const sunbizCtxCounty = await fetchSunbizContext(countyZips, `${countyDisplayName} County`, sunbizCitiesCounty);

      const groundingContextCounty = `You are LocalIntel — a knowledgeable local guide for all of ${countyDisplayName} County, Florida. You know every ZIP in the county and how they compare.

Speak like a well-informed local friend who understands the market, not like a data disclaimer. Lead with what you know.

Rules:
- Answer directly and conversationally.
- You have data for every ZIP in ${countyDisplayName} County — treat the county as a whole, not as isolated ZIPs.
- When recommending areas, name specific ZIPs AND describe what makes them distinct in plain English.
- Use actual business names when available.
- Never say "I cannot answer" or "data is missing."
- Never infer health, quality, or cuisine style from a business name alone — only use the tags and category provided.
- For recommendations: lead with your top pick and why, then offer alternatives.
- 3-6 sentences for recommendations. More detail only if the user asks for it.
- Multi-turn: remember context from earlier in this conversation.

Concept focus for this question: ${conceptLabel}
Coverage: ${withData}/${countyZips.length} ZIPs with signals (${data_confidence}%)
Missing ZIPs (no signals): ${missing.join(', ') || 'none'}

SCORING GUIDE (use as a soft lens — all signals still matter, this just shapes emphasis):
${scoringGuide}

${countyDisplayName} COUNTY INTELLIGENCE (${rows.length} ZIPs):
${zipSummaries}${sunbizCtxCounty.summary ? `\n\n${sunbizCtxCounty.summary}` : ''}`;

      const { answer: answerCounty, model: usedModelCounty, tokensUsed: tokensUsedCounty } =
        await callLLMWithFallback(groundingContextCounty, countyConvMessages);
      const rawCountyText = answerCounty;
      const cachedCounty = 0, uncachedCounty = tokensUsedCounty;

      // B73c: only count an attempt when LLM actually returned a real answer.
      const gotRealAnswerCounty = typeof rawCountyText === 'string' && rawCountyText.trim().length > 10;

      if (data_confidence > 0) {
        db.query(
          `INSERT INTO chat_log
             (caller_id, question, zip, data_confidence, missing_signals, llm_model,
              tokens_used, cached_tokens, uncached_tokens, answer_preview, answer)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [phone, String(question), placeResult.countyKey, data_confidence, missing, usedModelCounty || 'llm',
           tokensUsedCounty, cachedCounty, uncachedCounty,
           String(answerCounty).slice(0, 500), String(answerCounty)]
        ).catch(() => {});
      }

      if (!isOwner && !isSubscriber && data_confidence > 0 && gotRealAnswerCounty) {
        db.query(
          `UPDATE subscriber_accounts SET trial_queries_used = trial_queries_used + 1, updated_at = NOW() WHERE phone = $1`,
          [phone]
        ).catch(() => {});
      }

      return res.json({
        ok: true,
        zip: placeResult.countyKey,
        question,
        answer: answerCounty,
        data_confidence,
        missing_signals: missing,
        trial_remaining: isOwner ? 999 : (!isSubscriber ? Math.max(0, trialLimit - trialUsed - (data_confidence > 0 && gotRealAnswerCounty ? 1 : 0)) : null),
        is_subscriber: isSubscriber,
        is_owner: isOwner,
      });
    }

    // B75: detect food/dining concept to filter out non-food categories from the top businesses list
    const FOOD_CONCEPT_RE_ZIP = /\b(restaurant|food|eat|dining|dinner|lunch|bar|drink|healthy|cafe|coffee|cuisine|chef|menu)/i;
    const isFoodConceptZip = FOOD_CONCEPT_RE_ZIP.test(String(question || ''));
    const foodFilterZip = isFoodConceptZip
      ? ` AND NOT (category_group IN ('pharmacy','health','finance','automotive','legal','real_estate'))
          AND NOT (category IN ('pharmacy','bank','bank_branch','auto_repair','law_firm','real_estate'))`
      : '';

    // C) Load deterministic context (mirrors ceo-assess parallel load)
    const safe = (p) => p.catch(() => null);
    const [sigRows, propertyRows, totalBizRows, densityRows, geoRows, topBizRows] = await Promise.all([
      safe(db.query(`SELECT * FROM zip_signals WHERE zip = $1 LIMIT 1`, [zip])),
      safe(db.query(
        `SELECT COUNT(*)::int AS parcel_count,
                ROUND(AVG(assessed_value)::numeric, 0) AS avg_assessed
           FROM property_parcels WHERE zip = $1`,
        [zip]
      )),
      safe(db.query(`SELECT COUNT(*)::int AS total FROM businesses WHERE zip = $1`, [zip])),
      safe(db.query(
        `SELECT category, COUNT(*)::int AS count
           FROM businesses WHERE zip = $1
          GROUP BY category ORDER BY count DESC LIMIT 5`,
        [zip]
      )),
      safe(db.query(`SELECT county FROM fl_zip_geo WHERE zip = $1 LIMIT 1`, [zip])),
      // B74/B75: top businesses for this ZIP (with tags + optional food filter)
      safe(db.query(
        `SELECT name, category, tags, phone, website, claimed_at IS NOT NULL AS claimed, confidence_score
           FROM businesses
          WHERE zip = $1
            ${foodFilterZip}
          ORDER BY
            (CASE WHEN claimed_at IS NOT NULL THEN 3 ELSE 0 END) +
            (CASE WHEN wallet IS NOT NULL THEN 2 ELSE 0 END) +
            COALESCE(confidence_score, 0) DESC
          LIMIT 10`,
        [zip]
      )),
    ]);
    const sig            = Array.isArray(sigRows) && sigRows[0] ? sigRows[0] : {};
    const pr             = Array.isArray(propertyRows) && propertyRows[0] ? propertyRows[0] : {};
    const totalBiz       = Array.isArray(totalBizRows) && totalBizRows[0] ? Number(totalBizRows[0].total || 0) : 0;
    const topCategories  = Array.isArray(densityRows) ? densityRows : [];
    const zipCounty      = (Array.isArray(geoRows) && geoRows[0]?.county) ? geoRows[0].county : null;
    const topBusinesses  = Array.isArray(topBizRows) ? topBizRows : [];

    // D) Compute data_confidence
    const keySignals = [
      ['acs_population',         sig.acs_population],
      ['acs_median_hhi',         sig.acs_median_hhi],
      ['irs_mig_net_returns',    sig.irs_mig_net_returns],
      ['fred_unemployment_rate', sig.fred_unemployment_rate],
      ['qwi_avg_monthly_earn',   sig.qwi_avg_monthly_earn],
      ['qcew_avg_weekly_wages',  sig.qcew_avg_weekly_wages],
      ['ces_nonfarm_jobs',       sig.ces_nonfarm_jobs],
      ['bea_per_capita_income',  sig.bea_per_capita_income],
      ['sig_growth_score',       sig.sig_growth_score],
      ['sig_opportunity_score',  sig.sig_opportunity_score],
    ];
    const missingSignals = keySignals.filter(([_, v]) => v == null).map(([k]) => k);
    const nonNullCount   = keySignals.length - missingSignals.length;
    const dataConfidence = Math.round((nonNullCount / keySignals.length) * 100 * 100) / 100;

    if (dataConfidence === 0) {
      return res.json({
        ok: true,
        zip,
        question,
        answer: `No data is available yet for ZIP ${zip}. Try asking about a St. Johns County ZIP: 32082 (Ponte Vedra Beach), 32081 (Nocatee), 32250 (Jacksonville Beach), 32266 (Neptune Beach), 32259 (St. Johns), or 32034 (Fernandina Beach).`,
        data_confidence: 0,
        missing_signals: missingSignals,
        trial_remaining: isOwner ? 999 : (!isSubscriber ? Math.max(0, trialLimit - trialUsed) : null),
        is_subscriber: isSubscriber,
        is_owner: isOwner,
        no_data: true,
      });
    }

    // E) Grounding prompt — system block (cacheable: same for all turns in this ZIP session)
    const ctxLines = [];
    ctxLines.push(`ZIP: ${zip}`);
    if (sig.acs_population != null)         ctxLines.push(`Population (ACS): ${sig.acs_population}`);
    if (sig.acs_median_hhi != null)         ctxLines.push(`Median household income (ACS): $${sig.acs_median_hhi}`);
    if (sig.bea_per_capita_income != null)  ctxLines.push(`Per-capita income (BEA): $${sig.bea_per_capita_income}`);
    if (sig.irs_mig_net_returns != null)    ctxLines.push(`Net migration returns (IRS): ${sig.irs_mig_net_returns}`);
    if (sig.fred_unemployment_rate != null) ctxLines.push(`Unemployment rate (FRED): ${sig.fred_unemployment_rate}%`);
    if (sig.qwi_avg_monthly_earn != null)   ctxLines.push(`Avg monthly earnings (QWI): $${sig.qwi_avg_monthly_earn}`);
    if (sig.qcew_avg_weekly_wages != null)  ctxLines.push(`Avg weekly wages (QCEW): $${sig.qcew_avg_weekly_wages}`);
    if (sig.ces_nonfarm_jobs != null)       ctxLines.push(`Nonfarm jobs (CES): ${sig.ces_nonfarm_jobs}`);
    if (sig.sig_growth_score != null)       ctxLines.push(`Growth score (computed): ${sig.sig_growth_score}/100`);
    if (sig.sig_opportunity_score != null)  ctxLines.push(`Opportunity score (computed): ${sig.sig_opportunity_score}/100`);
    if (sig.sig_market_maturity)            ctxLines.push(`Market maturity: ${sig.sig_market_maturity}`);
    if (sig.sig_income_tier)                ctxLines.push(`Income tier: ${sig.sig_income_tier}`);
    if (pr.parcel_count)                    ctxLines.push(`Property parcels: ${pr.parcel_count} (avg assessed: $${pr.avg_assessed || 'n/a'})`);
    ctxLines.push(`Total businesses: ${totalBiz}`);
    if (topCategories.length) ctxLines.push(`Top business categories: ${topCategories.map(c => `${c.category} (${c.count})`).join(', ')}`);
    ctxLines.push(`Missing signals: ${missingSignals.length ? missingSignals.join(', ') : 'none'}`);

    if (topBusinesses.length) {
      ctxLines.push('');
      ctxLines.push(`TOP BUSINESSES IN ${zip}:`);
      for (const b of topBusinesses) {
        const tagStr = b.tags && b.tags.length ? ` [${b.tags.slice(0,5).join(', ')}]` : '';
        ctxLines.push(`- ${b.name} (${b.category || 'n/a'})${b.claimed ? ' ✓' : ''}${tagStr}`);
      }
    }

    // B78: surface SunBiz registrations for contractor/trades/licensing concept questions
    // B78b: derive city name from this zip via fl_place_index so we can ILIKE
    // sunbiz_raw.principal_city (principal_zip is null in the SunBiz feed).
    const sunbizCityRowsZip = await db.query(
      `SELECT DISTINCT sunbiz_city FROM fl_place_index
       WHERE place_type = 'city' AND primary_zip = $1 AND sunbiz_city IS NOT NULL`,
      [zip]
    ).catch(() => []);
    const sunbizCitiesZip = (Array.isArray(sunbizCityRowsZip) ? sunbizCityRowsZip : []).map(r => r.sunbiz_city);
    const sunbizCtxZip = await fetchSunbizContext([zip], `ZIP ${zip}`, sunbizCitiesZip);
    if (sunbizCtxZip.summary) {
      ctxLines.push('');
      ctxLines.push(sunbizCtxZip.summary);
    }

    const grounding = ctxLines.join('\n');
    const countyLabel = zipCounty ? `${zipCounty} County, Florida` : 'Florida';
    const systemText = `You are LocalIntel — a knowledgeable local guide for Florida communities. You know ${zip} (${countyLabel}) deeply.

Speak like a well-informed local friend who understands the market, not like a data disclaimer. Lead with what you know, not what you don't.

Rules:
- Answer directly and conversationally. No bullet-point data dumps.
- Use the actual business names, categories, and signals from the data below.
- If asked about restaurants, name them. If asked about the market, describe it in plain English.
- When data is limited, bridge naturally: "The area leans heavily toward [X] — if you're looking for [Y] you'd want to check nearby [Z]."
- Never say "I cannot answer", "data is missing", or "contact a government agency."
- Never infer health, quality, or cuisine style from a business name alone — only use the tags and category provided.
- 2-4 sentences for simple questions. Up to 8 sentences for comparisons or recommendations.
- Multi-turn: remember what was asked earlier in this conversation and build on it.

LOCAL INTELLIGENCE FOR ${zip} (${countyLabel}):
${grounding}`;

    // E.1) Load conversation history from chat_log (multi-turn context)
    // Reconstruct last N turns for this subscriber+ZIP session
    const HISTORY_TURNS  = 12; // turns to keep verbatim
    const COMPACT_AFTER  = 12; // summarize turns older than this
    let conversationMessages = [];
    try {
      const histRows = await db.query(
        `SELECT question, answer FROM chat_log
           WHERE caller_id = $1 AND zip = $2 AND answer IS NOT NULL
           ORDER BY created_at DESC LIMIT $3`,
        [phone, zip, HISTORY_TURNS + 6]
      ).catch(() => []);
      const hist = Array.isArray(histRows) ? histRows.reverse() : [];

      if (hist.length >= COMPACT_AFTER) {
        // Compact the oldest turns into a single summary turn to save tokens
        const olderTurns  = hist.slice(0, hist.length - HISTORY_TURNS);
        const recentTurns = hist.slice(hist.length - HISTORY_TURNS);
        const summaryText = olderTurns.map(h =>
          `Q: ${h.question}\nA: ${String(h.answer || '').slice(0, 200)}`
        ).join('\n---\n');
        conversationMessages.push(
          { role: 'user',      content: `[Prior conversation summary for ZIP ${zip}]:\n${summaryText}` },
          { role: 'assistant', content: 'Understood. I have context from our prior conversation about this ZIP.' }
        );
        for (const h of recentTurns) {
          conversationMessages.push({ role: 'user',      content: h.question });
          conversationMessages.push({ role: 'assistant', content: String(h.answer || '').slice(0, 800) });
        }
      } else {
        for (const h of hist) {
          conversationMessages.push({ role: 'user',      content: h.question });
          conversationMessages.push({ role: 'assistant', content: String(h.answer || '').slice(0, 800) });
        }
      }
    } catch (_) {
      // History load failure is non-fatal — degrade to single-turn
      conversationMessages = [];
    }
    // Append the current question
    conversationMessages.push({ role: 'user', content: String(question) });

    // F) LLM call — prompt caching on system block (Anthropic beta)
    let answer = '';
    let tokensUsed = 0;
    let cachedTokens = 0;
    let uncachedTokens = 0;
    let usedModel = 'unknown';
    try {
      const llmResult = await callLLMWithFallback(systemText, conversationMessages);
      answer     = llmResult.answer;
      tokensUsed = llmResult.tokensUsed;
      usedModel  = llmResult.model;
    } catch (e) {
      return res.status(502).json({
        ok: false,
        error: `LLM unavailable: ${e.message}`,
        data_confidence: dataConfidence,
        missing_signals: missingSignals,
      });
    }

    // G) Log to chat_log — store full answer for multi-turn history reconstruction
    if (dataConfidence > 0) {
      db.query(
        `INSERT INTO chat_log
          (caller_id, question, zip, data_confidence, missing_signals, llm_model,
           tokens_used, cached_tokens, uncached_tokens, answer_preview, answer)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [phone, String(question), zip, dataConfidence, missingSignals, usedModel,
         tokensUsed, cachedTokens, uncachedTokens,
         String(answer).slice(0, 500), String(answer)]
      ).catch(() => {});
    }

    // H) Increment trial usage (fire-and-forget)
    // B73c: Only count an attempt when LLM actually returned a real answer.
    // The LLM error / fetch failure paths return early above (502), so reaching
    // here implies no thrown error. Still verify the answer is non-empty and
    // not a "missing data / can't answer" stub.
    const answerIsPartial = /I cannot answer|missing data|traffic.*not available|road.*data.*not|don't have.*road|do not have.*traffic|contact.*department|site selection tool/i.test(answer);
    const gotRealAnswer = typeof answer === 'string' && answer.trim().length > 10 && !answerIsPartial;
    if (!isOwner && !isSubscriber && dataConfidence > 0 && gotRealAnswer) {
      db.query(
        `UPDATE subscriber_accounts SET trial_queries_used = trial_queries_used + 1, updated_at = NOW() WHERE phone = $1`,
        [phone]
      ).catch(() => {});
    }

    // I) Response
    return res.json({
      ok: true,
      zip,
      question,
      answer,
      data_confidence: dataConfidence,
      missing_signals: missingSignals,
      trial_remaining: isOwner ? 999 : (trialRemaining != null ? Math.max(0, trialRemaining - (gotRealAnswer ? 1 : 0)) : null),
      is_subscriber: isSubscriber,
      is_owner: isOwner,
    });
  } catch (err) {
    console.error('[chat] error:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── B46: Surge Subscription Endpoints ─────────────────────────────────────────
router.options('/chat', (req, res) =>
  res.set('Access-Control-Allow-Origin', '*')
     .set('Access-Control-Allow-Methods', 'POST')
     .set('Access-Control-Allow-Headers', 'Content-Type')
     .sendStatus(204)
);

router.options('/subscribe', (req, res) =>
  res.set('Access-Control-Allow-Origin', '*')
     .set('Access-Control-Allow-Methods', 'POST')
     .set('Access-Control-Allow-Headers', 'Content-Type')
     .sendStatus(204)
);

router.options('/subscription-confirm', (req, res) =>
  res.set('Access-Control-Allow-Origin', '*')
     .set('Access-Control-Allow-Methods', 'POST')
     .set('Access-Control-Allow-Headers', 'Content-Type')
     .sendStatus(204)
);

router.post('/subscribe', express.json(), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { phone } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const surgeRes = await fetch('https://surge.basalthq.com/api/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Ocp-Apim-Subscription-Key': process.env.BASALT_API_KEY
      },
      body: JSON.stringify({
        items: [{ sku: 'LOCALINTEL-CHAT-MONTHLY', qty: 1 }]
      })
    });
    const surgeData = await surgeRes.json();
    const receiptId = surgeData?.receipt?.receiptId;

    if (!receiptId) {
      console.error('[subscribe] Surge order failed:', JSON.stringify(surgeData));
      return res.status(502).json({ error: 'payment_init_failed', detail: surgeData });
    }

    await db.query(
      `INSERT INTO subscriber_accounts (phone, status, trial_queries_used)
       VALUES ($1, 'trial', 0)
       ON CONFLICT (phone) DO NOTHING`,
      [phone]
    ).catch(() => {});

    const MERCHANT_WALLET = '0xe66cE7E6d31A5F69899Ecad2E4F3B141557e0dED';
    const portalUrl = `https://surge.basalthq.com/portal/${receiptId}?recipient=${MERCHANT_WALLET}&embedded=1&correlationId=${phone.replace(/\W/g,'')}&forcePortalTheme=1`;

    return res.json({ ok: true, receiptId, portalUrl, amount: 9.99 });
  } catch (err) {
    console.error('[subscribe] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/subscription-confirm', express.json(), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { phone, receiptId, token } = req.body || {};
  if (!phone || !receiptId) return res.status(400).json({ error: 'phone and receiptId required' });

  try {
    const verifyRes = await fetch(`https://surge.basalthq.com/api/receipts/status?receiptId=${encodeURIComponent(receiptId)}`, {
      headers: { 'Ocp-Apim-Subscription-Key': process.env.BASALT_API_KEY }
    });
    const verifyData = await verifyRes.json();

    const confirmed = ['completed','paid','confirmed','success'].includes(String(verifyData?.status || '').toLowerCase());

    if (!confirmed) {
      console.warn('[subscription-confirm] receipt not confirmed:', verifyData?.status);
    }

    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    await db.query(
      `INSERT INTO subscriber_accounts (phone, status, tier, subscribed_at, expires_at)
       VALUES ($1, 'active', 'chat', NOW(), $2)
       ON CONFLICT (phone) DO UPDATE SET
         status = 'active',
         tier = 'chat',
         subscribed_at = NOW(),
         expires_at = $2,
         updated_at = NOW()`,
      [phone, expiresAt]
    );

    console.log(`[subscription-confirm] activated ${phone} receiptId=${receiptId}`);
    return res.json({ ok: true, status: 'active', expires_at: expiresAt });
  } catch (err) {
    console.error('[subscription-confirm] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/create-agent-wallet', express.json(), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { phone, wallet_address } = req.body || {};
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const [sub] = await db.query(
      `SELECT * FROM subscriber_accounts WHERE phone = $1`, [phone]
    );
    if (!sub) return res.status(403).json({ error: 'not_subscribed' });

    const existing = await db.query(
      `SELECT wallet_address, wallet_type FROM subscriber_wallets WHERE subscriber_phone = $1`, [phone]
    );

    // If customer is updating with a Surge-provided address, allow overwrite
    if (wallet_address) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(wallet_address)) {
        return res.status(400).json({ error: 'invalid wallet address' });
      }
      const walletType = 'surge_base';
      if (existing.length) {
        await db.query(
          `UPDATE subscriber_wallets SET wallet_address = $1, wallet_type = $2, updated_at = NOW()
           WHERE subscriber_phone = $3`,
          [wallet_address, walletType, phone]
        );
      } else {
        await db.query(
          `INSERT INTO subscriber_wallets (subscriber_phone, wallet_address, wallet_type)
           VALUES ($1, $2, $3)`,
          [phone, wallet_address, walletType]
        );
      }
      await db.query(
        `UPDATE subscriber_accounts SET path_usd_wallet = $1, updated_at = NOW() WHERE phone = $2`,
        [wallet_address, phone]
      );
      return res.json({
        ok: true,
        wallet_address,
        wallet_type: walletType,
        message: 'Surge wallet linked. AI agents on the LocalIntel network can now route jobs and payments to you.',
        already_existed: existing.length > 0
      });
    }

    // No wallet_address provided — return existing if present
    if (existing.length) {
      return res.json({ ok: true, wallet_address: existing[0].wallet_address, wallet_type: existing[0].wallet_type, already_existed: true });
    }

    // Fallback: generate custodial address (legacy path — no private key stored)
    const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts');
    const privateKey = generatePrivateKey();
    const account = privateKeyToAccount(privateKey);
    const walletAddress = account.address;

    await db.query(
      `INSERT INTO subscriber_wallets (subscriber_phone, wallet_address, wallet_type)
       VALUES ($1, $2, 'custodial_legacy')`,
      [phone, walletAddress]
    );
    await db.query(
      `UPDATE subscriber_accounts SET path_usd_wallet = $1, updated_at = NOW() WHERE phone = $2`,
      [walletAddress, phone]
    );
    return res.json({
      ok: true,
      wallet_address: walletAddress,
      wallet_type: 'custodial_legacy',
      message: 'Temporary wallet address assigned. Link your Surge wallet for full agent payment support.',
      surge_portal: `https://surge.basalthq.com`,
      already_existed: false
    });
  } catch (err) {
    console.error('[create-agent-wallet] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.options('/create-agent-wallet', (req, res) =>
  res.set('Access-Control-Allow-Origin','*')
     .set('Access-Control-Allow-Methods','POST')
     .set('Access-Control-Allow-Headers','Content-Type')
     .sendStatus(204)
);

// ── CEO County Analysis ───────────────────────────────────────────────────────
// POST /api/local-intel/ceo-county-query
// Body: { county, question }
// Ranks all ZIPs in a county against a question type (QSR/upscale/healthcare/lease/general).
// B53: COUNTY_ZIPS and ZIP_CITIES static objects removed — all lookups via Postgres fl_county_zips + fl_place_index

router.post('/ceo-county-query', express.json(), async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { county, question } = req.body;
  if (!county || !question) return res.status(400).json({ error: 'county and question required' });

  // Resolve county_key from display name (e.g. "St. Johns" → "st. johns")
  const countyNorm = county.toLowerCase().replace(' county', '').trim();
  const countyLookup = await db.query(
    `SELECT county_key, primary_zip FROM fl_place_index
     WHERE place_type IN ('county','county_alias') AND name_normalized = $1
     LIMIT 1`,
    [countyNorm]
  ).catch(() => []);
  const countyKey = countyLookup[0]?.county_key || countyNorm;

  // Pull ZIPs for this county from Postgres
  const zipRows = await db.query(
    `SELECT zip FROM fl_county_zips WHERE county_key = $1 ORDER BY sort_order`,
    [countyKey]
  ).catch(() => []);
  const zips = zipRows.map(r => r.zip);
  if (!zips.length) return res.status(400).json({ error: `Unknown county: ${county}. Make sure it matches a Florida county name.` });

  // City name lookup from fl_place_index for display
  const cityLookupRows = await db.query(
    `SELECT primary_zip, name FROM fl_place_index
     WHERE place_type = 'city' AND primary_zip = ANY($1)`,
    [zips]
  ).catch(() => []);
  const zipCityMap = {};
  for (const r of cityLookupRows) {
    if (!zipCityMap[r.primary_zip]) zipCityMap[r.primary_zip] = r.name;
  }
  const getCityForZip = (zip) => zipCityMap[zip] || zip;

  try {
    // B62: pull the full set of fields the unified scoring engine needs.
    const sigRows = await db.query(
      `SELECT zip, acs_population, acs_median_hhi, acs_owner_occ_pct,
              acs_median_age, irs_mig_net_returns, irs_mig_net_agi,
              fred_unemployment_rate, qcew_avg_weekly_wages,
              sig_growth_score, sig_opportunity_score, sig_risk_score,
              sig_market_maturity, sig_income_tier,
              fdot_max_aadt, fdot_top_road,
              lodes_jobs_here, biz_density_per_1k,
              osm_road_class, osm_access_score, osm_fast_food_count,
              osm_golf_count, osm_arts_count, osm_worship_count, osm_fitness_count,
              acs_pct_bachelors_plus, acs_pct_stem_occupations, psycho_index
       FROM zip_signals WHERE zip = ANY($1)`,
      [zips]
    );

    const bizRows = await db.query(
      `SELECT zip, COUNT(*)::int as biz_count FROM businesses WHERE zip = ANY($1) GROUP BY zip`,
      [zips]
    );
    const bizMap = {};
    for (const r of bizRows) bizMap[r.zip] = r.biz_count;

    // B62: detect concept + load statewide bounds once for all ZIPs in this county.
    const conceptKey = detectConcept(question);
    const profile = CONCEPT_PROFILES[conceptKey] || CONCEPT_PROFILES.GENERAL;
    const bounds = await getStatewideBounds();

    const scored = sigRows.map(sig => {
      const result = scoreZipForConcept(sig, profile, bounds);
      const hhi = Number(sig.acs_median_hhi || 0);
      const growth = Number(sig.sig_growth_score || 0);
      const opp = Number(sig.sig_opportunity_score || 0);
      const pop = Number(sig.acs_population || 0);
      const top = (result.factor_breakdown || []).slice().sort((a,b) => b.points - a.points).slice(0,3);
      const reason = result.hard_floor_triggered
        ? `Filtered: ${result.hard_floor_reason}`
        : top.map(f => `${f.label} ${f.points}pts`).join(', ') || 'no factors';

      return {
        zip: sig.zip,
        city: getCityForZip(sig.zip),
        score: result.total_score,
        reason,
        factor_breakdown: result.factor_breakdown,
        hard_floor_triggered: result.hard_floor_triggered,
        hard_floor_reason: result.hard_floor_reason,
        hhi,
        growth,
        opp,
        pop,
        biz_count: bizMap[sig.zip] || 0,
      };
    });

    const topZips = scored.sort((a, b) => b.score - a.score).slice(0, 5);

    const best = topZips[0];
    let verdict = '';
    if (best && best.score > 0) {
      if (conceptKey === 'QSR_DRIVE_BY') verdict = `${best.zip} (${best.city}) is the strongest match for a QSR/drive-by concept in ${county} County — see factor_breakdown for the contributing signals.`;
      else if (conceptKey === 'DESTINATION_DINING') verdict = `${best.zip} (${best.city}) leads for destination dining in ${county} County.`;
      else verdict = `${best.zip} (${best.city}) ranks highest in ${county} County for this concept (${profile.name}).`;
    } else {
      verdict = `Insufficient data to rank ZIPs in ${county} County for this question.`;
    }

    const answer = topZips.length
      ? `Top ZIPs in ${county} County ranked by fit (${profile.name}): ${topZips.map((z,i) => `#${i+1} ${z.zip} ${z.city} (score ${z.score}/100 — ${z.reason})`).join('; ')}.`
      : `No zip_signals data found for ${county} County ZIPs.`;

    const withData = sigRows.length;
    const confidence = withData >= 5 ? 'high' : withData >= 2 ? 'medium' : 'low';

    return res.json({
      county,
      question,
      concept_detected: conceptKey,
      concept_name: profile.name,
      verdict,
      answer,
      top_zips: topZips.map(z => ({
        zip: z.zip,
        city: z.city,
        score: z.score,
        reason: z.reason,
        factor_breakdown: z.factor_breakdown,
        hard_floor_triggered: z.hard_floor_triggered,
        hard_floor_reason: z.hard_floor_reason,
      })),
      confidence,
      zips_with_data: withData,
      total_zips_in_county: zips.length
    });

  } catch (err) {
    console.error('[ceo-county-query] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.options('/ceo-county-query', (req, res) =>
  res.set('Access-Control-Allow-Origin','*')
     .set('Access-Control-Allow-Methods','POST')
     .set('Access-Control-Allow-Headers','Content-Type')
     .sendStatus(204)
);

router.get('/subscriber-status', async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });

  try {
    const [sub] = await db.query(
      `SELECT status, tier, trial_queries_used, trial_queries_limit, expires_at
       FROM subscriber_accounts WHERE phone = $1`, [phone]
    );

    if (!sub) {
      return res.json({ status: 'none', trial_remaining: 5, is_subscriber: false });
    }

    const isActive = sub.status === 'active' && (!sub.expires_at || new Date(sub.expires_at) > new Date());
    const trialRemaining = Math.max(0, (sub.trial_queries_limit || 5) - (sub.trial_queries_used || 0));

    return res.json({
      status: sub.status,
      tier: sub.tier,
      is_subscriber: isActive,
      trial_remaining: sub.status === 'trial' ? trialRemaining : null,
      expires_at: sub.expires_at || null
    });
  } catch (err) {
    console.error('[subscriber-status] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.options('/subscriber-status', (req, res) =>
  res.set('Access-Control-Allow-Origin', '*')
     .set('Access-Control-Allow-Methods', 'GET')
     .set('Access-Control-Allow-Headers', 'Content-Type')
     .sendStatus(204)
);

module.exports = router;

// ── Neighborhood endpoints ────────────────────────────────────────────────────

// GET /api/local-intel/neighborhoods?city=Jacksonville
// Returns all neighborhoods for a city, sorted by name
router.get('/neighborhoods', async (req, res) => {
  try {
    const city = req.query.city || 'Jacksonville';
    const rows = await db.query(`
      SELECT slug, name, city, county, region, zip_codes, lat, lon, business_count, description
      FROM neighborhoods
      WHERE city ILIKE $1
      ORDER BY region, name
    `, [city]);
    res.json({ city, count: rows.length, neighborhoods: rows });
  } catch (e) {
    console.error('[/neighborhoods]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/neighborhood?slug=riverside-jacksonville
// Returns neighborhood detail + businesses + sector signals
router.get('/neighborhood', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    // Get neighborhood metadata
    const hoods = await db.query(
      `SELECT * FROM neighborhoods WHERE slug=$1`, [slug]
    );
    if (!hoods.length) return res.status(404).json({ error: 'neighborhood not found', slug });
    const hood = hoods[0];

    // Get businesses in this neighborhood
    const businesses = await db.query(`
      SELECT business_id, name, category, address, zip, lat, lon,
             claimed, phone, website, pos_config
      FROM businesses
      WHERE neighborhood_id=$1
      ORDER BY claimed DESC, name
      LIMIT 200
    `, [hood.id]);

    // Sector breakdown
    const sectors = await db.query(`
      SELECT category, COUNT(*) as count
      FROM businesses
      WHERE neighborhood_id=$1 AND category IS NOT NULL
      GROUP BY category
      ORDER BY count DESC
      LIMIT 10
    `, [hood.id]);

    // Census signals from member ZIPs (aggregate)
    let censusSignals = null;
    if (hood.zip_codes && hood.zip_codes.length) {
      const zipData = await db.query(`
        SELECT zip, layer_json, confidence
        FROM census_layer
        WHERE zip = ANY($1::text[])
      `, [hood.zip_codes]);
      if (zipData.length) {
        censusSignals = { zips: zipData.map(r => r.zip), layers: zipData };
      }
    }

    res.json({
      neighborhood: hood,
      business_count: businesses.length,
      businesses,
      sectors,
      census_signals: censusSignals,
      available: true
    });
  } catch (e) {
    console.error('[/neighborhood]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/zip-neighborhoods?zip=32205
// Returns all neighborhoods that overlap a given ZIP
router.get('/zip-neighborhoods', async (req, res) => {
  try {
    const { zip } = req.query;
    if (!zip) return res.status(400).json({ error: 'zip required' });
    const rows = await db.query(`
      SELECT slug, name, city, region, lat, lon, business_count
      FROM neighborhoods
      WHERE $1 = ANY(zip_codes)
      ORDER BY name
    `, [zip]);
    res.json({ zip, neighborhoods: rows });
  } catch (e) {
    console.error('[/zip-neighborhoods]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/neighborhood-boundary?slug=downtown-jacksonville-jacksonville
// Returns merged ZIP polygons + aggregate census stats for a neighborhood/region page
router.get('/neighborhood-boundary', async (req, res) => {
  try {
    const { slug } = req.query;
    if (!slug) return res.status(400).json({ error: 'slug required' });

    // Get neighborhood metadata + zip list
    const hoods = await db.query(`SELECT * FROM neighborhoods WHERE slug=$1`, [slug]);
    if (!hoods.length) return res.status(404).json({ error: 'not found', slug });
    const hood = hoods[0];
    const zips = hood.zip_codes || [];

    // Fetch zip_intelligence for all ZIPs in this neighborhood/region
    const zipData = zips.length
      ? await db.query(
          `SELECT zip, population, median_household_income, total_households,
                  total_businesses, restaurant_count, market_opportunity_score,
                  dominant_sector, sector_counts, irs_agi_median, irs_returns,
                  age_25_34_pct, age_35_54_pct, age_55_plus_pct,
                  owner_occupied_pct, vacancy_rate_pct, business_density,
                  wfh_pct, family_hh_pct, consumer_profile, saturation_status,
                  growth_state, boundary_geojson, lat, lon
           FROM zip_intelligence WHERE zip = ANY($1)`,
          [zips]
        )
      : [];

    // ── Aggregate stats ────────────────────────────────────────────────────
    let totalPop = 0, totalHH = 0, totalBiz = 0, totalRestaurants = 0;
    let incomeWeightedSum = 0, oppScoreSum = 0, oppCount = 0;
    let irsAgiSum = 0, irsReturnsSum = 0;
    const sectorTotals = {};
    const consumerProfiles = {}, satStatuses = {}, growthStates = {};

    for (const z of zipData) {
      const pop  = parseInt(z.population)       || 0;
      const hh   = parseInt(z.total_households) || 0;
      const biz  = parseInt(z.total_businesses) || 0;
      const rest = parseInt(z.restaurant_count) || 0;
      const inc  = parseFloat(z.median_household_income) || 0;
      const opp  = parseFloat(z.market_opportunity_score);

      totalPop         += pop;
      totalHH          += hh;
      totalBiz         += biz;
      totalRestaurants += rest;
      incomeWeightedSum += inc * hh;    // weighted by households

      if (!isNaN(opp)) { oppScoreSum += opp; oppCount++; }

      const irsAgi     = parseFloat(z.irs_agi_median)  || 0;
      const irsReturns = parseInt(z.irs_returns)        || 0;
      irsAgiSum     += irsAgi * irsReturns;
      irsReturnsSum += irsReturns;

      // Sector rollup
      if (z.sector_counts) {
        const sc = typeof z.sector_counts === 'string' ? JSON.parse(z.sector_counts) : z.sector_counts;
        for (const [k, v] of Object.entries(sc)) {
          sectorTotals[k] = (sectorTotals[k] || 0) + (parseInt(v) || 0);
        }
      }

      // Mode tracking
      if (z.consumer_profile) consumerProfiles[z.consumer_profile] = (consumerProfiles[z.consumer_profile] || 0) + 1;
      if (z.saturation_status) satStatuses[z.saturation_status]     = (satStatuses[z.saturation_status]    || 0) + 1;
      if (z.growth_state)      growthStates[z.growth_state]         = (growthStates[z.growth_state]        || 0) + 1;
    }

    const avgIncome     = totalHH   > 0 ? Math.round(incomeWeightedSum / totalHH)   : null;
    const avgOppScore   = oppCount  > 0 ? Math.round(oppScoreSum / oppCount * 10) / 10 : null;
    const avgIrsAgi     = irsReturnsSum > 0 ? Math.round(irsAgiSum / irsReturnsSum) : null;

    // Top sectors sorted by count
    const topSectors = Object.entries(sectorTotals)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, count]) => ({ name, count }));

    const mode = obj => Object.keys(obj).length
      ? Object.entries(obj).sort((a,b)=>b[1]-a[1])[0][0]
      : null;

    // ── ZIPs with boundaries (for map) ────────────────────────────────────
    const zipBoundaries = zipData
      .filter(z => z.boundary_geojson)
      .map(z => ({
        zip:             z.zip,
        lat:             z.lat,
        lon:             z.lon,
        population:      z.population,
        total_businesses: z.total_businesses,
        boundary_geojson: z.boundary_geojson,
      }));

    // ── Intelligence paragraph (deterministic template) ───────────────────
    const zipCount = zips.length;
    const boundaryCount = zipBoundaries.length;
    const topSector = topSectors[0]?.name || 'services';
    const topSector2 = topSectors[1]?.name;
    const consumerMode = mode(consumerProfiles) || 'mixed';
    const satMode = mode(satStatuses) || 'active';
    const growthMode = mode(growthStates) || 'stable';

    const formatNum = n => n >= 1000 ? (n/1000).toFixed(1)+'K' : String(n);
    const formatIncome = n => n ? '$' + n.toLocaleString() : null;

    let intel = `${hood.name} spans ${zipCount} ZIP code${zipCount !== 1 ? 's' : ''}`;
    if (totalPop > 0) intel += ` covering approximately ${formatNum(totalPop)} residents`;
    if (totalHH > 0) intel += ` across ${formatNum(totalHH)} households`;
    intel += '.';
    if (avgIncome) intel += ` The median household income is ${formatIncome(avgIncome)}`;
    if (avgIrsAgi) intel += `, with IRS-reported AGI averaging ${formatIncome(avgIrsAgi)}`;
    intel += '.';
    if (totalBiz > 0) {
      intel += ` There are ${formatNum(totalBiz)} active businesses in the area`;
      if (topSector) intel += `, led by ${topSector}`;
      if (topSector2) intel += ` and ${topSector2}`;
      intel += `.`;
    }
    if (satMode !== 'unknown') intel += ` The market is generally ${satMode}`;
    if (growthMode !== 'unknown') intel += ` and trending ${growthMode}`;
    intel += '.';
    if (avgOppScore !== null) intel += ` Market opportunity scores average ${avgOppScore}/100 across constituent ZIPs.`;
    intel += ` As LocalIntel adds school district data, zoning layers, and claimed business profiles, this page will surface richer context for each area.`;

    res.json({
      slug,
      neighborhood: hood,
      stats: {
        zip_count:        zipCount,
        boundary_count:   boundaryCount,
        total_population: totalPop,
        total_households: totalHH,
        total_businesses: totalBiz,
        total_restaurants: totalRestaurants,
        avg_median_income: avgIncome,
        avg_irs_agi:      avgIrsAgi,
        avg_opp_score:    avgOppScore,
        top_sectors:      topSectors,
        consumer_profile: consumerMode,
        saturation:       satMode,
        growth_state:     growthMode,
      },
      intel_paragraph: intel,
      zip_boundaries: zipBoundaries,
    });

  } catch (e) {
    console.error('[/neighborhood-boundary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/local-intel/zip-boundary?zip=32202
// Returns single ZIP polygon + neighbor ZIP outlines + business dots + neighborhood context
router.get('/zip-boundary', async (req, res) => {
  try {
    const { zip } = req.query;
    if (!zip) return res.status(400).json({ error: 'zip required' });

    // Primary ZIP boundary + intelligence
    const zipRows = await db.query(
      `SELECT zip, city_name, county_name, population, median_household_income,
              total_households, total_businesses, restaurant_count,
              market_opportunity_score, dominant_sector, sector_counts,
              irs_agi_median, consumer_profile, saturation_status, growth_state,
              business_density, lat, lon, boundary_geojson
       FROM zip_intelligence WHERE zip=$1`,
      [zip]
    );
    if (!zipRows.length) return res.status(404).json({ error: 'zip not found', zip });
    const zi = zipRows[0];

    // Neighborhood(s) this ZIP belongs to
    const hoods = await db.query(
      `SELECT id, slug, name, region, city, zip_codes FROM neighborhoods WHERE $1 = ANY(zip_codes)`,
      [zip]
    );

    // Sibling ZIPs in same neighborhood (for context ring) — boundaries only, no full data
    let siblingBoundaries = [];
    if (hoods.length) {
      const allSiblingZips = [...new Set(hoods.flatMap(h => h.zip_codes || []))].filter(z => z !== zip);
      if (allSiblingZips.length) {
        siblingBoundaries = await db.query(
          `SELECT zip, lat, lon, boundary_geojson
           FROM zip_intelligence
           WHERE zip = ANY($1) AND boundary_geojson IS NOT NULL`,
          [allSiblingZips]
        );
      }
    }

    // Business dots — lat/lon points for this ZIP (limit 500 for map performance)
    const businesses = await db.query(
      `SELECT business_id, name, category, category_group, lat, lon, website, phone,
              (claimed_at IS NOT NULL) AS is_claimed
       FROM businesses
       WHERE zip=$1 AND lat IS NOT NULL AND lon IS NOT NULL AND status='active'
       ORDER BY confidence_score DESC NULLS LAST
       LIMIT 500`,
      [zip]
    );

    res.json({
      zip,
      zip_intelligence: zi,
      neighborhoods: hoods,
      sibling_boundaries: siblingBoundaries,
      businesses,
    });

  } catch (e) {
    console.error('[/zip-boundary]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Confirmed Jobs ─────────────────────────────────────────────────────────────
// GET /api/local-intel/confirmed-jobs?token=<dispatch_token>&status=<optional>
router.get('/confirmed-jobs', async (req, res) => {
  const { token, status } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    const confirmedJobs = require('./lib/confirmedJobs');
    const jobs = await confirmedJobs.getConfirmedJobs(biz.business_id, { status: status || null });
    return res.json({ jobs });
  } catch (err) {
    console.error('[confirmed-jobs GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// POST /api/local-intel/confirmed-jobs-done — mark a job complete from dashboard UI
router.post('/confirmed-jobs-done', express.json(), async (req, res) => {
  const { token, job_id } = req.body || {};
  if (!token) return res.status(401).json({ error: 'token required' });
  if (!job_id) return res.status(400).json({ error: 'job_id required' });
  try {
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    const pool = db.getPool();
    const { rows: [job] } = await pool.query(
      `SELECT id FROM confirmed_jobs WHERE id = $1 AND business_id = $2`,
      [job_id, biz.business_id]
    );
    if (!job) return res.status(404).json({ error: 'job not found' });
    const confirmedJobs = require('./lib/confirmedJobs');
    const done = await confirmedJobs.markComplete(job_id);
    return res.json({ ok: true, job_id, service_name: done.service_name });
  } catch (err) {
    console.error('[confirmed-jobs-done]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Agent Profile ──────────────────────────────────────────────────────────────
// GET  /api/local-intel/agent-profile?token=<dispatch_token>
// POST /api/local-intel/agent-profile?token=<dispatch_token>
router.get('/agent-profile', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    const agentProfiles = require('./lib/agentProfiles');
    const profile = await agentProfiles.getProfile(biz.business_id);
    return res.json({ profile: profile || null });
  } catch (err) {
    console.error('[agent-profile GET]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

router.post('/agent-profile', express.json(), async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    const agentProfiles = require('./lib/agentProfiles');
    const profile = await agentProfiles.upsertProfile(biz.business_id, req.body);
    return res.json({ ok: true, profile });
  } catch (err) {
    console.error('[agent-profile POST]', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Property Layer ──────────────────────────────────────────────────────────
// POSTGRES IS KING — data pre-seeded from County PA bulk files, no ArcGIS
//   Duval:     405k parcels (jacksonville.gov TXT, March 2026) w/ beds/baths
//   St. Johns: 171k parcels (sjcpa.us CAMAData.mdb ParcelView)
// GET /api/local-intel/property-search?zip=32082&limit=20&min_sqft=1000&min_beds=3
// GET /api/local-intel/property/:parcel_id
// GET /api/local-intel/property-address?q=101+cypress+landing
// GET /api/local-intel/property-stats?county=st_johns
const propertyLayer = require('./lib/propertyLayer');

router.get('/property-search', async (req, res) => {
  const { zip, limit = 20, min_sqft, max_sqft, min_beds, dor_uc, sort_by } = req.query;
  if (!zip) return res.status(400).json({ error: 'zip is required' });

  try {
    const result = await propertyLayer.searchByZip(zip, { limit, min_sqft, max_sqft, min_beds, dor_uc, sort_by });
    return res.json(result);
  } catch (err) {
    console.error('[property-search] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/property/:parcel_id
router.get('/property/:parcel_id', async (req, res) => {
  const { parcel_id } = req.params;
  if (!parcel_id) return res.status(400).json({ error: 'parcel_id is required' });

  try {
    const result = await propertyLayer.getByParcelId(parcel_id);
    if (result.not_found) return res.status(404).json({ error: `Parcel ${parcel_id} not found` });
    return res.json(result);
  } catch (err) {
    console.error('[property/:parcel_id] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/property-address?q=101+cypress+landing
router.get('/property-address', async (req, res) => {
  const { q, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'q (address query) is required' });

  try {
    const result = await propertyLayer.searchByAddress(q, limit);
    return res.json(result);
  } catch (err) {
    console.error('[property-address] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/property-stats?county=duval|st_johns&zip=32082
router.get('/property-stats', async (req, res) => {
  const { county, zip } = req.query;
  try {
    const result = await propertyLayer.stats({ county, zip });
    return res.json(result);
  } catch (err) {
    console.error('[property-stats] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/trade-signals
// Returns latest scored trade signals from tradeSignalWorker
// Dashboard: /local-intel/market-intel
//
// In-memory cache: last successful DB read is held in _signalsCache.
// On pool exhaustion (boot burst window), serve stale cache instead of empty.
// Cache TTL: 6h — signals are scored weekly so stale cache is always correct.
let _signalsCache = null;  // { signals, generated_at }

router.get('/trade-signals', async (req, res) => {
  try {
    // DISTINCT ON ticker — return only the most recent signal per ticker
    const signals = await db.query(`
      SELECT DISTINCT ON (ticker)
             id, ticker, company, direction, confidence, thesis,
             signal_source, signal_value, data_vintage, options_note,
             risk_note, status, scored_at, expires_at
      FROM trade_signals
      WHERE status = 'active'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY ticker, scored_at DESC, confidence DESC
    `);
    // Update cache on every successful read
    _signalsCache = { signals, generated_at: new Date().toISOString() };
    return res.json({ signals, count: signals.length, generated_at: _signalsCache.generated_at });
  } catch (err) {
    // Pool exhausted during boot burst — serve last known good cache rather than empty
    if (_signalsCache && (err.message.includes('too many clients') || err.message.includes('timeout'))) {
      return res.json({
        signals: _signalsCache.signals,
        count:   _signalsCache.signals.length,
        generated_at: _signalsCache.generated_at,
        note: 'served from cache — DB busy at boot',
      });
    }
    console.error('[trade-signals] error:', err.message);
    // No cache yet and DB busy — return empty (first boot only)
    if (err.message.includes('too many clients') || err.message.includes('timeout')) {
      return res.json({ signals: [], count: 0, generated_at: new Date().toISOString(), note: 'DB busy — retry shortly' });
    }
    return res.status(500).json({ error: err.message });
  }
});
