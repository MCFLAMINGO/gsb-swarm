'use strict';
/**
 * taskSignalWorker.js — Last-mile micro → forecast loop
 * ─────────────────────────────────────────────────────────────────────────────
 * Fuses live action data into zip_signals + zip_forecast:
 *   - RFQs / bookings / completions
 *   - settlement_events (money to local merchants)
 *   - intent_dead_ends + rfq_gaps (unmet demand)
 *   - resolution_history (when present)
 *
 * Writes:
 *   zip_signals.sig_unmet_demand_score
 *   zip_signals.sig_task_velocity
 *   zip_signals.sig_settlement_volume_30d
 *   zip_signals.sig_category_momentum
 *   zip_signals_history daily snapshot (sig_* subset)
 *   zip_forecast model_version = 'v1-task-loop'
 *
 * Pure SQL + math. ZERO LLM. 6h freshness window.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');

const FRESHNESS_MS = 6 * 60 * 60 * 1000; // 6h
const MODEL_VERSION = 'v1-task-loop';

async function tableExists(name) {
  const rows = await db.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1 LIMIT 1`,
    [name]
  ).catch(() => []);
  return Array.isArray(rows) && rows.length > 0;
}

async function ensureSignalColumns() {
  await db.query(`ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_task_velocity NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_settlement_volume_30d NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_category_momentum NUMERIC`).catch(() => {});
  await db.query(`ALTER TABLE zip_signals ADD COLUMN IF NOT EXISTS sig_unmet_demand_score NUMERIC`).catch(() => {});
}

function clamp01(x) {
  if (x == null || Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(100, x));
}

function projectScore(base, velocity, unmet, horizonMonths) {
  // Deterministic trajectory: velocity lifts growth; unmet demand lifts opportunity;
  // risk rises slightly with unmet and falls with settlement velocity.
  const t = horizonMonths / 12;
  const growth = clamp01((base.growth ?? 50) + velocity * 0.25 * t - unmet * 0.05 * t);
  const opportunity = clamp01((base.opportunity ?? 50) + unmet * 0.3 * t + velocity * 0.1 * t);
  const bizDelta = Number((((velocity - 40) / 100) * 4 * t).toFixed(2)); // rough % biz change
  let maturity = base.maturity || 'Growing';
  if (growth >= 70 && opportunity >= 60) maturity = 'Growing';
  else if (growth < 35 && unmet < 20) maturity = 'Mature';
  else if (growth < 40) maturity = 'Established';
  else if (growth >= 55) maturity = 'Growing';
  else maturity = 'Emerging';
  const confidence = Number(Math.min(0.85, 0.35 + (velocity / 100) * 0.3 + (base.hasMacro ? 0.2 : 0)).toFixed(2));
  return { growth: Math.round(growth), opportunity: Math.round(opportunity), bizDelta, maturity, confidence };
}

async function run() {
  const start = Date.now();
  console.log('[taskSignalWorker] START — micro action → zip_signals / zip_forecast');

  if (!db.isReady()) {
    console.error('[taskSignalWorker] LOCAL_INTEL_DB_URL not set');
    process.exit(1);
  }

  // Freshness
  try {
    const hb = await db.query(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = 'taskSignalWorker'`
    );
    if (Array.isArray(hb) && hb[0]?.last_run) {
      const ageMs = Date.now() - new Date(hb[0].last_run).getTime();
      if (ageMs < FRESHNESS_MS && process.env.TASK_SIGNAL_FORCE !== 'true') {
        console.log(`[taskSignalWorker] Data fresh (${(ageMs / 3600000).toFixed(1)}h) — skipping`);
        process.exit(0);
      }
    }
  } catch (_) { /* no heartbeat yet */ }

  await ensureSignalColumns();
  try { await require('../lib/settlementService').migrate(); } catch (_) {}

  // ZIP universe: prefer fl_zip_geo, else distinct from businesses / zip_signals
  let allZips = [];
  try {
    const geo = await db.query(`SELECT zip FROM fl_zip_geo WHERE state = 'FL' ORDER BY zip`);
    allZips = (geo || []).map(r => r.zip);
  } catch (_) {}
  if (!allZips.length) {
    const fallback = await db.query(
      `SELECT DISTINCT zip FROM (
         SELECT zip FROM businesses WHERE zip IS NOT NULL
         UNION
         SELECT zip FROM zip_signals WHERE zip IS NOT NULL
       ) z ORDER BY zip`
    ).catch(() => []);
    allZips = (fallback || []).map(r => r.zip);
  }
  if (!allZips.length) {
    console.warn('[taskSignalWorker] no ZIPs to process');
    process.exit(0);
  }
  console.log(`[taskSignalWorker] ${allZips.length} ZIPs in universe`);

  // ── Aggregate micro tables (tolerate missing relations) ────────────────────
  const rfqByZip = {};
  if (await tableExists('rfq_requests')) {
    const rows = await db.query(`
      SELECT zip,
             COUNT(*)::int AS rfq_count,
             COUNT(*) FILTER (WHERE status IN ('booked','complete'))::int AS booked_count,
             COUNT(*) FILTER (WHERE status = 'complete')::int AS complete_count,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS rfq_30d
        FROM rfq_requests
       WHERE zip IS NOT NULL
       GROUP BY zip
    `).catch(() => []);
    for (const r of rows || []) {
      rfqByZip[r.zip] = {
        rfq_count: Number(r.rfq_count) || 0,
        booked_count: Number(r.booked_count) || 0,
        complete_count: Number(r.complete_count) || 0,
        rfq_30d: Number(r.rfq_30d) || 0,
      };
    }
  }

  const settleByZip = {};
  if (await tableExists('settlement_events')) {
    const rows = await db.query(`
      SELECT zip,
             COUNT(*) FILTER (
               WHERE status IN ('settled','settled_intent','held')
                 AND created_at >= NOW() - INTERVAL '30 days'
             )::int AS settle_events_30d,
             COALESCE(SUM(amount_usd) FILTER (
               WHERE status IN ('settled','settled_intent')
                 AND created_at >= NOW() - INTERVAL '30 days'
             ), 0)::float AS settle_usd_30d
        FROM settlement_events
       WHERE zip IS NOT NULL
       GROUP BY zip
    `).catch(() => []);
    for (const r of rows || []) {
      settleByZip[r.zip] = {
        settle_events_30d: Number(r.settle_events_30d) || 0,
        settle_usd_30d: Number(r.settle_usd_30d) || 0,
      };
    }
  }

  const deadByZip = {};
  if (await tableExists('intent_dead_ends')) {
    const rows = await db.query(`
      SELECT zip, COUNT(*)::int AS dead_30d
        FROM intent_dead_ends
       WHERE zip IS NOT NULL
         AND created_at >= NOW() - INTERVAL '30 days'
       GROUP BY zip
    `).catch(() => []);
    for (const r of rows || []) {
      deadByZip[r.zip] = Number(r.dead_30d) || 0;
    }
  }

  const gapByZip = {};
  if (await tableExists('rfq_gaps')) {
    const rows = await db.query(`
      SELECT zip, COUNT(*)::int AS gaps
        FROM rfq_gaps
       WHERE zip IS NOT NULL
       GROUP BY zip
    `).catch(() => []);
    for (const r of rows || []) {
      gapByZip[r.zip] = Number(r.gaps) || 0;
    }
  }

  const resByZip = {};
  if (await tableExists('resolution_history')) {
    const rows = await db.query(`
      SELECT zip,
             COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS res_30d
        FROM resolution_history
       WHERE zip IS NOT NULL
       GROUP BY zip
    `).catch(() => []);
    for (const r of rows || []) {
      resByZip[r.zip] = Number(r.res_30d) || 0;
    }
  }

  // Macro base scores for forecast projection
  const macroByZip = {};
  const macroRows = await db.query(
    `SELECT zip, sig_growth_score, sig_opportunity_score, sig_risk_score, sig_market_maturity, sig_peer_cohort
       FROM zip_signals WHERE zip = ANY($1)`,
    [allZips]
  ).catch(() => []);
  for (const r of macroRows || []) {
    macroByZip[r.zip] = r;
  }

  // Active ZIPs = those with any micro activity OR existing signals
  const active = new Set();
  for (const z of Object.keys(rfqByZip)) active.add(z);
  for (const z of Object.keys(settleByZip)) active.add(z);
  for (const z of Object.keys(deadByZip)) active.add(z);
  for (const z of Object.keys(gapByZip)) active.add(z);
  for (const z of Object.keys(resByZip)) active.add(z);
  // Always refresh ZIPs that already have signal rows so scores don't go stale-null
  for (const z of Object.keys(macroByZip)) {
    if (rfqByZip[z] || settleByZip[z] || deadByZip[z] || gapByZip[z] || resByZip[z]) active.add(z);
  }

  const targetZips = active.size ? [...active] : allZips.slice(0, 50);
  console.log(`[taskSignalWorker] writing signals for ${targetZips.length} active ZIPs`);

  let written = 0;
  let forecasts = 0;

  for (const zip of targetZips) {
    const rfq = rfqByZip[zip] || {};
    const set = settleByZip[zip] || {};
    const dead = deadByZip[zip] || 0;
    const gaps = gapByZip[zip] || 0;
    const res30 = resByZip[zip] || 0;

    const activity = (rfq.rfq_30d || 0) + (set.settle_events_30d || 0) + res30;
    // 10 events/30d ≈ 100 velocity
    const sig_task_velocity = clamp01(activity * 10);
    const unmetRaw = dead * 2 + gaps * 5 + Math.max(0, (rfq.rfq_30d || 0) - (rfq.complete_count || 0));
    const sig_unmet_demand_score = clamp01(unmetRaw * 5);
    const sig_settlement_volume_30d = Math.round((set.settle_usd_30d || 0) * 100) / 100;
    // Momentum: resolutions + settlements vs dead ends
    const pos = res30 + (set.settle_events_30d || 0) + (rfq.complete_count || 0);
    const neg = dead + gaps;
    const sig_category_momentum = clamp01(50 + (pos - neg) * 5);

    try {
      await pgStore.upsertZipSignals(zip, {
        sig_task_velocity:         Math.round(sig_task_velocity * 10) / 10,
        sig_unmet_demand_score:    Math.round(sig_unmet_demand_score * 10) / 10,
        sig_settlement_volume_30d,
        sig_category_momentum:     Math.round(sig_category_momentum * 10) / 10,
      });
      written++;
    } catch (e) {
      console.warn(`[taskSignalWorker] upsertZipSignals(${zip}) failed:`, e.message);
      continue;
    }

    // History snapshot (daily unique)
    try {
      const m = macroByZip[zip] || {};
      await db.query(
        `INSERT INTO zip_signals_history
           (zip, snapshot_date, snapshot_source,
            sig_growth_score, sig_opportunity_score, sig_risk_score, sig_market_maturity)
         VALUES ($1, CURRENT_DATE, 'taskSignalWorker', $2, $3, $4, $5)
         ON CONFLICT (zip, snapshot_date) DO UPDATE SET
           sig_growth_score = EXCLUDED.sig_growth_score,
           sig_opportunity_score = EXCLUDED.sig_opportunity_score,
           sig_risk_score = EXCLUDED.sig_risk_score,
           sig_market_maturity = EXCLUDED.sig_market_maturity,
           snapshot_source = EXCLUDED.snapshot_source`,
        [
          zip,
          m.sig_growth_score ?? null,
          m.sig_opportunity_score ?? null,
          m.sig_risk_score ?? null,
          m.sig_market_maturity ?? null,
        ]
      );
    } catch (e) {
      // table may be missing columns on sparse local DBs — non-fatal
      if (!String(e.message).includes('does not exist')) {
        console.warn(`[taskSignalWorker] history snapshot ${zip}:`, e.message);
      }
    }

    // Forecast write
    try {
      const m = macroByZip[zip] || {};
      const base = {
        growth: m.sig_growth_score != null ? Number(m.sig_growth_score) : 50,
        opportunity: m.sig_opportunity_score != null ? Number(m.sig_opportunity_score) : 50,
        maturity: m.sig_market_maturity || null,
        hasMacro: m.sig_growth_score != null,
      };
      const p12 = projectScore(base, sig_task_velocity, sig_unmet_demand_score, 12);
      const p24 = projectScore(base, sig_task_velocity, sig_unmet_demand_score, 24);
      const p36 = projectScore(base, sig_task_velocity, sig_unmet_demand_score, 36);

      const drivers = [
        { signal: 'sig_task_velocity', value: sig_task_velocity, weight: 0.35, direction: 'up' },
        { signal: 'sig_unmet_demand_score', value: sig_unmet_demand_score, weight: 0.3, direction: 'up' },
        { signal: 'sig_settlement_volume_30d', value: sig_settlement_volume_30d, weight: 0.2, direction: 'up' },
        { signal: 'sig_category_momentum', value: sig_category_momentum, weight: 0.15, direction: 'up' },
      ];

      const summary12 = `ZIP ${zip}: task velocity ${sig_task_velocity.toFixed(0)}/100, unmet demand ${sig_unmet_demand_score.toFixed(0)}/100, $${sig_settlement_volume_30d} settled locally in 30d. 12mo growth→${p12.growth}, opportunity→${p12.opportunity}.`;
      const summary36 = `ZIP ${zip} 36mo outlook: growth ${p36.growth}, opportunity ${p36.opportunity}, maturity ${p36.maturity}. Driven by live RFQ/settlement loop + macro scores.`;

      // Replace prior forecast for this model version (keep latest only)
      await db.query(`DELETE FROM zip_forecast WHERE zip = $1 AND model_version = $2`, [zip, MODEL_VERSION]).catch(() => {});
      await db.query(
        `INSERT INTO zip_forecast (
           zip, model_version, peer_cohort, peer_zip_count,
           proj_12mo_growth_score, proj_12mo_opportunity, proj_12mo_biz_delta_pct, proj_12mo_maturity, proj_12mo_confidence,
           proj_24mo_growth_score, proj_24mo_opportunity, proj_24mo_biz_delta_pct, proj_24mo_maturity, proj_24mo_confidence,
           proj_36mo_growth_score, proj_36mo_opportunity, proj_36mo_biz_delta_pct, proj_36mo_maturity, proj_36mo_confidence,
           driver_signals, opportunity_gaps, summary_12mo, summary_36mo
         ) VALUES (
           $1,$2,$3,$4,
           $5,$6,$7,$8,$9,
           $10,$11,$12,$13,$14,
           $15,$16,$17,$18,$19,
           $20::jsonb, $21::jsonb, $22, $23
         )`,
        [
          zip, MODEL_VERSION, m.sig_peer_cohort || null, null,
          p12.growth, p12.opportunity, p12.bizDelta, p12.maturity, p12.confidence,
          p24.growth, p24.opportunity, p24.bizDelta, p24.maturity, p24.confidence,
          p36.growth, p36.opportunity, p36.bizDelta, p36.maturity, p36.confidence,
          JSON.stringify(drivers),
          JSON.stringify(gaps || dead ? [{ sector: 'unmet_local_demand', gap_score: sig_unmet_demand_score, rationale: 'dead ends + RFQ gaps' }] : []),
          summary12,
          summary36,
        ]
      );
      forecasts++;
    } catch (e) {
      console.warn(`[taskSignalWorker] zip_forecast ${zip}:`, e.message);
    }
  }

  try {
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('taskSignalWorker', NOW())
       ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
    );
  } catch (_) {}

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[taskSignalWorker] END — signals=${written} forecasts=${forecasts} — ${elapsed}s`);
  return { written, forecasts, zips: targetZips.length };
}

if (require.main === module) {
  run()
    .then((r) => { console.log('[taskSignalWorker] done:', JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.error('[taskSignalWorker] fatal:', e.message); process.exit(1); });
}

module.exports = { run, projectScore, clamp01 };
