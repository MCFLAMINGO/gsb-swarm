/**
 * pipeline_runner.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LocalIntel self-healing data pipeline orchestrator.
 *
 * Runs 4 stages in order every night (or on-demand):
 *
 *   Stage 1 — CLASSIFY    reclassify_categories.js
 *             Name-pattern rules against all active records.
 *             Target: LocalBusiness < 2% of total.
 *
 *   Stage 2 — ENRICH      enrich_yp_categories.js
 *             Fetch YP categoryText for anything still LocalBusiness.
 *             Only runs if LocalBusiness > 1% of total (skip if already clean).
 *
 *   Stage 3 — VALIDATE    validate.js
 *             Score every record (0–100 confidence), detect duplicates,
 *             flag shells, detect Sunbiz conflicts, compute health_score.
 *
 *   Stage 4 — CONSOLIDATE sector_counts backfill + duplicate cleanup.
 *
 * Self-improvement logic:
 *   - After each run, compare health_score to prior runs.
 *   - If stalling (no improvement in 3 consecutive runs), log stall_flag
 *     and notify via pipeline_health so the operator knows to add rules.
 *   - Keeps running nightly regardless — each run at minimum re-scores
 *     records as businesses open/close and Sunbiz data changes.
 *
 * Thresholds for "good enough":
 *   - pct_classified >= 95%   (LocalBusiness + uncategorized < 5%)
 *   - pct_confident  >= 85%   (data_confidence >= 60 on 85% of records)
 *   - health_score   >= 80    (composite)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.LOCAL_INTEL_DB_URL
    || 'postgresql://postgres:myufFnkSigImGnSylwyIjYmLCvkthQUr@turntable.proxy.rlwy.net:25739/railway',
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// ─── THRESHOLDS ───────────────────────────────────────────────────────────────
const TARGET_PCT_CLASSIFIED = 95;   // % of records NOT LocalBusiness/uncategorized
const TARGET_HEALTH_SCORE   = 80;   // composite health target
const ENRICH_THRESHOLD_PCT  = 1;    // skip YP enrichment if LocalBusiness < this %

// ─── STAGE 4: CONSOLIDATE ────────────────────────────────────────────────────
async function runConsolidate() {
  console.log('[pipeline] stage 4: consolidate');

  // 4a. Backfill sector_counts for all ZIPs
  await pool.query(`
    INSERT INTO zip_intelligence (zip, sector_counts, updated_at)
    SELECT
      b.zip,
      jsonb_build_object(
        'food',         COUNT(*) FILTER (WHERE b.category_group='food'),
        'construction', COUNT(*) FILTER (WHERE b.category_group='construction'),
        'health',       COUNT(*) FILTER (WHERE b.category_group='health'),
        'banking',      COUNT(*) FILTER (WHERE b.category_group='banking'),
        'retail',       COUNT(*) FILTER (WHERE b.category_group='retail'),
        'hospitality',  COUNT(*) FILTER (WHERE b.category_group='hospitality'),
        'beauty',       COUNT(*) FILTER (WHERE b.category_group='beauty'),
        'grocery',      COUNT(*) FILTER (WHERE b.category_group='grocery'),
        'auto',         COUNT(*) FILTER (WHERE b.category_group='auto'),
        'real_estate',  COUNT(*) FILTER (WHERE b.category_group='real_estate'),
        'legal',        COUNT(*) FILTER (WHERE b.category_group='legal'),
        'fuel',         COUNT(*) FILTER (WHERE b.category_group='fuel'),
        'fitness',      COUNT(*) FILTER (WHERE b.category_group='fitness'),
        'pets',         COUNT(*) FILTER (WHERE b.category_group='pets'),
        'professional', COUNT(*) FILTER (WHERE b.category_group='professional'),
        'civic',        COUNT(*) FILTER (WHERE b.category_group='civic'),
        'services',     COUNT(*) FILTER (WHERE b.category_group='services')
      ),
      NOW()
    FROM businesses b
    WHERE b.status='active' AND b.duplicate_of IS NULL
    GROUP BY b.zip
    ON CONFLICT (zip) DO UPDATE
      SET sector_counts = EXCLUDED.sector_counts,
          updated_at    = NOW()
  `);
  console.log('[pipeline] sector_counts backfilled');

  // 4b. Downgrade stale LocalBusiness records (attempted > 48h ago, still stuck)
  const { rows: downgraded } = await pool.query(`
    UPDATE businesses
       SET category = 'uncategorized', category_group = 'services'
     WHERE status = 'active'
       AND category = 'LocalBusiness'
       AND classification_attempted_at < NOW() - INTERVAL '48 hours'
     RETURNING business_id
  `);
  console.log(`[pipeline] downgraded ${downgraded.length} stale LocalBusiness → uncategorized`);

  // 4c. Auto-close businesses whose Sunbiz status is inactive
  //     (only if sunbiz_doc_number exists — don't close things we can't confirm)
  const { rows: closed } = await pool.query(`
    UPDATE businesses
       SET status = 'closed'
     WHERE status = 'active'
       AND sunbiz_doc_number IS NOT NULL
       AND sunbiz_status ILIKE ANY(ARRAY['%inactive%','%dissolved%','%revoked%','%cancelled%'])
     RETURNING business_id, name, zip
  `);
  if (closed.length > 0) {
    console.log(`[pipeline] auto-closed ${closed.length} Sunbiz-inactive businesses`);
  }

  return { downgraded: downgraded.length, closed: closed.length };
}

// ─── CURRENT STATUS ───────────────────────────────────────────────────────────
async function getCurrentStatus() {
  const { rows: [s] } = await pool.query(`
    SELECT
      COUNT(*)                                               AS total,
      COUNT(*) FILTER (WHERE category='LocalBusiness')      AS lb_cnt,
      COUNT(*) FILTER (WHERE category='uncategorized')      AS unc_cnt,
      COUNT(*) FILTER (WHERE data_confidence >= 60)         AS confident_cnt
    FROM businesses WHERE status='active' AND duplicate_of IS NULL
  `);
  const total        = parseInt(s.total);
  const lbCnt        = parseInt(s.lb_cnt);
  const uncCnt       = parseInt(s.unc_cnt);
  const confidentCnt = parseInt(s.confident_cnt);
  const pctClassified = total > 0 ? ((total - lbCnt - uncCnt) / total * 100) : 0;
  const pctConfident  = total > 0 ? (confidentCnt / total * 100) : 0;
  const lbPct         = total > 0 ? (lbCnt / total * 100) : 0;
  return { total, lbCnt, lbPct, pctClassified, pctConfident };
}

// ─── MAIN PIPELINE ────────────────────────────────────────────────────────────
async function runPipeline() {
  const startedAt = new Date();
  const runId = `pipeline-${startedAt.toISOString().slice(0,19).replace(/:/g,'-')}`;
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[pipeline] START ${runId}`);
  console.log(`${'═'.repeat(60)}`);

  let stageResults = {};

  try {
    // ── PRE-RUN STATUS ──────────────────────────────────────────────────────
    const preStatus = await getCurrentStatus();
    console.log(`[pipeline] pre-run: ${preStatus.total} active | ${preStatus.lbPct.toFixed(1)}% LocalBusiness | ${preStatus.pctClassified.toFixed(1)}% classified`);

    // ── STAGE 1: CLASSIFY ───────────────────────────────────────────────────
    console.log('\n[pipeline] ── STAGE 1: CLASSIFY ──');
    const { runClassificationPipeline } = require('./reclassify_categories');
    stageResults.classify = await runClassificationPipeline();

    // ── STAGE 2: ENRICH (conditional) ──────────────────────────────────────
    const postClassStatus = await getCurrentStatus();
    console.log(`\n[pipeline] after classify: ${postClassStatus.lbPct.toFixed(1)}% still LocalBusiness`);

    if (postClassStatus.lbPct > ENRICH_THRESHOLD_PCT) {
      console.log('[pipeline] ── STAGE 2: ENRICH (YP fetch) ──');
      const { runYpEnrichment } = require('./enrich_yp_categories');
      stageResults.enrich = await runYpEnrichment();
    } else {
      console.log(`[pipeline] ── STAGE 2: ENRICH skipped (LocalBusiness ${postClassStatus.lbPct.toFixed(2)}% < ${ENRICH_THRESHOLD_PCT}% threshold) ──`);
      stageResults.enrich = { skipped: true };
    }

    // Run classify again after enrichment to catch newly categorized YP records
    if (!stageResults.enrich.skipped && stageResults.enrich.matched > 0) {
      console.log('\n[pipeline] ── STAGE 1b: RE-CLASSIFY (post-enrich) ──');
      stageResults.reclassify2 = await runClassificationPipeline();
    }

    // ── STAGE 3: VALIDATE ───────────────────────────────────────────────────
    console.log('\n[pipeline] ── STAGE 3: VALIDATE ──');
    const { runValidation } = require('./validate');
    stageResults.validate = await runValidation();

    // ── STAGE 4: CONSOLIDATE ────────────────────────────────────────────────
    console.log('\n[pipeline] ── STAGE 4: CONSOLIDATE ──');
    stageResults.consolidate = await runConsolidate();

    // ── POST-RUN SUMMARY ────────────────────────────────────────────────────
    const postStatus = await getCurrentStatus();
    const runtime    = Math.round((new Date() - startedAt) / 1000);
    const health     = stageResults.validate;

    console.log(`\n${'═'.repeat(60)}`);
    console.log(`[pipeline] COMPLETE in ${runtime}s`);
    console.log(`[pipeline] health_score:    ${health.health_score}/100`);
    console.log(`[pipeline] pct_classified:  ${health.pct_classified}%  (target: ${TARGET_PCT_CLASSIFIED}%)`);
    console.log(`[pipeline] pct_confident:   ${health.pct_confident}%  (target: 85%)`);
    console.log(`[pipeline] avg_confidence:  ${health.avg_confidence}`);
    console.log(`[pipeline] LocalBusiness:   ${postStatus.lbCnt} (${postStatus.lbPct.toFixed(1)}%)`);
    console.log(`[pipeline] duplicates:      ${health.duplicates_marked}`);
    console.log(`[pipeline] shell candidates:${health.shells}`);
    console.log(`[pipeline] needs review:    ${health.needs_review}`);
    if (health.stall_detected) {
      console.log(`[pipeline] ⚠️  STALL: health_score unchanged for 3+ runs — add rules or new data source`);
    }
    if (health.health_score >= TARGET_HEALTH_SCORE) {
      console.log(`[pipeline] ✓ TARGET REACHED: health_score ${health.health_score} >= ${TARGET_HEALTH_SCORE}`);
    }
    console.log(`${'═'.repeat(60)}\n`);

    return {
      run_id:       runId,
      runtime_s:    runtime,
      health:       stageResults.validate,
      stages:       stageResults,
      stall:        health.stall_detected || false,
      target_met:   health.health_score >= TARGET_HEALTH_SCORE,
    };

  } catch (err) {
    console.error('[pipeline] FATAL ERROR:', err.message);
    // Log the failure
    await pool.query(
      `INSERT INTO pipeline_runs (pipeline, started_at, finished_at, total_scanned, matched, unmatched, notes)
       VALUES ('pipeline_runner', $1, NOW(), 0, 0, 0, $2)`,
      [startedAt, `FATAL: ${err.message}`]
    ).catch(() => {});
    throw err;
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  runPipeline()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runPipeline };
