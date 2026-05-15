'use strict';
/**
 * businessSignalWorker.js — B65
 * ─────────────────────────────────────────────────────────────────────────────
 * Derives business-layer signals from the `businesses` + `business_tasks`
 * tables and writes them to `zip_signals` for the scoring engine to consume.
 *
 * Pure SQL aggregation — ZERO LLM API calls. 24h freshness window (business
 * data changes daily).
 *
 * Signals written:
 *   sig_claimed_rate       — % of businesses in ZIP that are claimed
 *   sig_wallet_rate        — % of businesses with a wallet (paid tier)
 *   sig_task_density       — task templates per business, scaled to 0-100
 *   sig_closure_rate_food  — food/restaurant closure rate (0-100)
 *   sig_unmet_demand_score — placeholder (0) — populated later by taskSignalWorker
 *
 * Worker contract:
 *   START → freshness check (skip if <24h) → aggregate per-ZIP → upsert → END
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');

const FRESHNESS_MS = 24 * 60 * 60 * 1000; // 24h — business data changes daily
const FOOD_CATEGORY_PATTERN =
  "(b.category ILIKE '%food%' OR b.category ILIKE '%restaurant%' " +
  " OR b.category ILIKE '%cafe%' OR b.category ILIKE '%dining%')";

async function run() {
  const start = Date.now();
  console.log('[businessSignalWorker] START — deriving business-layer signals');

  // ── Freshness check ─────────────────────────────────────────────────────────
  try {
    const hb = await db.query(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = 'businessSignalWorker'`
    );
    if (Array.isArray(hb) && hb[0]?.last_run) {
      const ageMs = Date.now() - new Date(hb[0].last_run).getTime();
      if (ageMs < FRESHNESS_MS) {
        const ageHrs = (ageMs / 3600000).toFixed(1);
        console.log(`[businessSignalWorker] Data fresh (${ageHrs}h old) — skipping run`);
        process.exit(0);
      }
    }
  } catch (_) { /* no heartbeat yet — run */ }

  // ── Load all FL ZIPs from fl_zip_geo (Postgres is king) ────────────────────
  let allZips;
  try {
    const geoRows = await db.query(
      `SELECT zip FROM fl_zip_geo WHERE state = 'FL' ORDER BY zip`
    );
    allZips = Array.isArray(geoRows) ? geoRows.map(r => r.zip) : [];
  } catch (e) {
    console.error('[businessSignalWorker] fl_zip_geo unavailable:', e.message);
    process.exit(1);
  }
  if (allZips.length === 0) {
    console.warn('[businessSignalWorker] fl_zip_geo has 0 rows — run migration 029');
    process.exit(0);
  }
  console.log(`[businessSignalWorker] ${allZips.length} FL ZIPs loaded`);

  // ── Aggregate business stats per ZIP ───────────────────────────────────────
  let bizRows;
  try {
    bizRows = await db.query(`
      SELECT
        b.zip,
        COUNT(*)                                                          AS total_biz,
        COUNT(*) FILTER (WHERE b.claimed = true)                          AS claimed_count,
        COUNT(*) FILTER (WHERE b.wallet IS NOT NULL AND b.wallet <> '')   AS wallet_count,
        COUNT(*) FILTER (WHERE b.status = 'closed' AND ${FOOD_CATEGORY_PATTERN}) AS food_closures,
        COUNT(*) FILTER (WHERE b.status = 'active' AND ${FOOD_CATEGORY_PATTERN}) AS active_food
      FROM businesses b
      WHERE b.zip IS NOT NULL
      GROUP BY b.zip
    `);
  } catch (e) {
    console.error('[businessSignalWorker] business aggregation failed:', e.message);
    process.exit(1);
  }
  const bizMap = {};
  for (const r of (bizRows || [])) {
    bizMap[r.zip] = {
      total_biz:     Number(r.total_biz) || 0,
      claimed_count: Number(r.claimed_count) || 0,
      wallet_count:  Number(r.wallet_count) || 0,
      food_closures: Number(r.food_closures) || 0,
      active_food:   Number(r.active_food) || 0,
    };
  }
  console.log(`[businessSignalWorker] aggregated business stats for ${Object.keys(bizMap).length} ZIPs`);

  // ── Aggregate task counts per ZIP via join through businesses ──────────────
  let taskRows;
  try {
    taskRows = await db.query(`
      SELECT b.zip, COUNT(bt.id)::int AS task_count
      FROM businesses b
      JOIN business_tasks bt ON bt.business_id = b.business_id
      WHERE b.zip IS NOT NULL
      GROUP BY b.zip
    `);
  } catch (e) {
    // business_tasks may not exist yet on fresh DBs — log and continue with 0s
    console.warn('[businessSignalWorker] task aggregation failed (continuing with 0):', e.message);
    taskRows = [];
  }
  const taskMap = {};
  for (const r of (taskRows || [])) {
    taskMap[r.zip] = Number(r.task_count) || 0;
  }

  // ── Compute signals per ZIP and upsert ─────────────────────────────────────
  let written = 0, skippedEmpty = 0;
  for (const zip of allZips) {
    const b = bizMap[zip];
    // No businesses in this ZIP — skip rather than write zeros that pollute
    // statewide MIN/MAX bounds for the scoring engine.
    if (!b || b.total_biz === 0) {
      skippedEmpty++;
      continue;
    }

    const total = b.total_biz;
    const sig_claimed_rate = (b.claimed_count / total) * 100;
    const sig_wallet_rate  = (b.wallet_count  / total) * 100;

    const tasks_per_biz = (taskMap[zip] || 0) / total;
    // 5 tasks/biz = 100; cap at 100
    const sig_task_density = Math.min(100, tasks_per_biz * 20);

    const food_total = b.active_food + b.food_closures;
    const sig_closure_rate_food = food_total > 0
      ? (b.food_closures / food_total) * 100
      : 0;

    // Placeholder until taskSignalWorker is built — column exists so scoring
    // engine can reference it without errors.
    const sig_unmet_demand_score = 0;

    try {
      await pgStore.upsertZipSignals(zip, {
        sig_claimed_rate:       Math.round(sig_claimed_rate * 10) / 10,
        sig_wallet_rate:        Math.round(sig_wallet_rate * 10) / 10,
        sig_task_density:       Math.round(sig_task_density * 10) / 10,
        sig_closure_rate_food:  Math.round(sig_closure_rate_food * 10) / 10,
        sig_unmet_demand_score,
      });
      written++;
      if (written % 250 === 0) {
        console.log(`[businessSignalWorker] progress: ${written} ZIPs written`);
      }
    } catch (e) {
      console.warn(`[businessSignalWorker] upsert failed for ${zip}: ${e.message}`);
    }
  }

  // ── Heartbeat ──────────────────────────────────────────────────────────────
  try {
    await db.query(
      `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('businessSignalWorker', NOW())
       ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
    );
  } catch (_) { /* heartbeat table may be missing on a very fresh DB */ }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(
    `[businessSignalWorker] END — ${written} ZIPs written, ${skippedEmpty} skipped (no businesses) — ${elapsed}s`
  );
  process.exit(0);
}

run().catch(e => { console.error('[businessSignalWorker] fatal:', e.message); process.exit(1); });
