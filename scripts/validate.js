/**
 * validate.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LocalIntel Pipeline Stage 3: Validation & Self-Improvement
 *
 * Runs after classify + enrich. Backchecks assumptions, scores confidence,
 * flags problems, and merges duplicates. Updates every business record with
 * a data_confidence score (0–100) and quality_flags array.
 *
 * Outputs a health snapshot written to pipeline_health table.
 * Pipeline runner uses health_score trend to detect stalls and alert.
 *
 * Zero LLM calls. Pure deterministic logic.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.LOCAL_INTEL_DB_URL
    // DB URL must be set via LOCAL_INTEL_DB_URL environment variable
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// ─── CONFIDENCE SCORING ───────────────────────────────────────────────────────
// Score each business 0–100. >= 60 = "confident". >= 80 = "high confidence".
function computeConfidence(biz) {
  let score = 0;
  const flags = [];

  // Category quality
  if (biz.category === 'LocalBusiness') {
    score -= 50; flags.push('unclassified');
  } else if (biz.category === 'uncategorized') {
    score -= 30; flags.push('uncategorized');
  } else {
    score += 20; // has a real category
  }

  // Identity signals
  if (biz.sunbiz_doc_number)  score += 25; // legal ground truth
  if (biz.phone)              score += 10;
  if (biz.address)            score += 10;

  // Web presence — YP URL stored as website is NOT a real web presence
  if (biz.website && !biz.website.includes('yellowpages.com')) {
    score += 15;
  } else if (biz.website && biz.website.includes('yellowpages.com')) {
    score += 5;  // partial credit — at least we have a YP listing
    flags.push('yp_url_only');
  }

  // Multi-source confirmation
  const srcCount = (biz.sources || []).length;
  if (srcCount >= 3)      score += 15;
  else if (srcCount >= 2) score += 10;
  else if (srcCount >= 1) score += 5;

  // Freshness
  if (biz.last_confirmed) {
    const daysSince = (Date.now() - new Date(biz.last_confirmed).getTime()) / 86400000;
    if (daysSince > 365)      { score -= 10; flags.push('stale_1yr'); }
    else if (daysSince > 180) { score -=  5; flags.push('stale_6mo'); }
  }

  // Shell candidate signals: registered in Sunbiz but zero contact info
  const hasContact = biz.phone || biz.address || biz.website;
  if (biz.sunbiz_doc_number && !hasContact) {
    flags.push('shell_candidate');
  }

  // Sunbiz dissolved but still active in our DB
  if (biz.sunbiz_status && biz.sunbiz_status.toLowerCase().includes('inactive')) {
    score -= 20; flags.push('sunbiz_inactive');
  }

  // Clamp 0–100
  score = Math.max(0, Math.min(100, score));
  return { score, flags };
}

// ─── DUPLICATE DETECTION ──────────────────────────────────────────────────────
// Find exact name+zip duplicates and near-duplicates (same phone, different record)
async function detectDuplicates() {
  console.log('[validate] detecting duplicates...');

  // Exact name+zip duplicates
  const { rows: exactDupes } = await pool.query(`
    SELECT
      MIN(business_id::text) as keep_id,
      array_agg(business_id::text ORDER BY business_id) as all_ids,
      name, zip, COUNT(*) as cnt
    FROM businesses
    WHERE status = 'active'
    GROUP BY name, zip
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);
  console.log(`[validate] exact name+zip duplicates: ${exactDupes.length} groups`);

  // Phone duplicates (same phone, same ZIP, different name variations)
  const { rows: phoneDupes } = await pool.query(`
    SELECT
      MIN(business_id::text) as keep_id,
      array_agg(business_id::text ORDER BY business_id) as all_ids,
      phone, zip, COUNT(*) as cnt
    FROM businesses
    WHERE status = 'active' AND phone IS NOT NULL AND phone != ''
    GROUP BY phone, zip
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 500
  `);
  console.log(`[validate] phone+zip duplicates: ${phoneDupes.length} groups`);

  // Mark duplicates — keep the one with highest confidence_score, mark others
  let merged = 0;
  const allDupeGroups = [...exactDupes, ...phoneDupes];
  for (const group of allDupeGroups) {
    const ids = group.all_ids;
    if (ids.length < 2) continue;
    // Keep first (lowest UUID = oldest insert), mark rest as duplicate
    const keepId  = ids[0];
    const dupeIds = ids.slice(1);
    await pool.query(
      `UPDATE businesses
         SET duplicate_of = $1::uuid,
             needs_review  = TRUE,
             quality_flags = array_append(quality_flags, 'duplicate')
       WHERE business_id = ANY($2::uuid[])
         AND status = 'active'
         AND duplicate_of IS NULL`,
      [keepId, dupeIds]
    );
    merged += dupeIds.length;
  }
  console.log(`[validate] marked ${merged} records as duplicates`);
  return merged;
}

// ─── SCORE ALL RECORDS ────────────────────────────────────────────────────────
async function scoreAllRecords() {
  console.log('[validate] scoring all active records...');

  const { rows: businesses } = await pool.query(`
    SELECT business_id, category, category_group,
           sunbiz_doc_number, sunbiz_status,
           phone, address, website,
           sources, last_confirmed
    FROM businesses
    WHERE status = 'active'
  `);
  console.log(`[validate] scoring ${businesses.length} records`);

  const CHUNK = 500;
  let processed = 0;
  let shellCount = 0;

  for (let i = 0; i < businesses.length; i += CHUNK) {
    const chunk = businesses.slice(i, i + CHUNK);
    const ids        = [];
    const scores     = [];
    const flagArrays = [];
    const shells     = [];
    const reviews    = [];

    for (const biz of chunk) {
      const { score, flags } = computeConfidence(biz);
      ids.push(biz.business_id);
      scores.push(score);
      flagArrays.push(flags);
      shells.push(flags.includes('shell_candidate'));
      reviews.push(flags.includes('sunbiz_inactive') || score < 20);
      if (flags.includes('shell_candidate')) shellCount++;
    }

    await pool.query(
      `UPDATE businesses
         SET data_confidence   = vals.score,
             quality_flags     = vals.flags,
             shell_candidate   = vals.shell,
             needs_review      = vals.review
         FROM (
           SELECT
             unnest($1::uuid[])     as business_id,
             unnest($2::smallint[]) as score,
             unnest($3::text[][])   as flags,
             unnest($4::boolean[])  as shell,
             unnest($5::boolean[])  as review
         ) vals
        WHERE businesses.business_id = vals.business_id`,
      [ids, scores, flagArrays, shells, reviews]
    );

    processed += chunk.length;
    process.stdout.write(`\r[validate] scored ${processed}/${businesses.length}`);
  }
  console.log('');
  console.log(`[validate] shell candidates: ${shellCount}`);
  return { total: businesses.length, shellCount };
}

// ─── HEALTH SNAPSHOT ──────────────────────────────────────────────────────────
async function computeHealthSnapshot(duplicateCnt, notes = '') {
  console.log('[validate] computing health snapshot...');

  const { rows: [snap] } = await pool.query(`
    SELECT
      COUNT(*)                                                  AS total_active,
      COUNT(*) FILTER (WHERE category NOT IN ('LocalBusiness','uncategorized'))
                                                                AS classified_cnt,
      COUNT(*) FILTER (WHERE data_confidence >= 60)             AS confident_cnt,
      ROUND(AVG(data_confidence)::numeric, 2)                   AS avg_confidence,
      COUNT(*) FILTER (WHERE category = 'LocalBusiness')        AS local_business_cnt,
      COUNT(*) FILTER (WHERE category = 'uncategorized')        AS uncategorized_cnt,
      COUNT(*) FILTER (WHERE shell_candidate = TRUE)            AS shell_cnt,
      COUNT(*) FILTER (WHERE needs_review = TRUE)               AS needs_review_cnt
    FROM businesses
    WHERE status = 'active'
  `);

  const total        = parseInt(snap.total_active);
  const classified   = parseInt(snap.classified_cnt);
  const confident    = parseInt(snap.confident_cnt);
  const pctClassified = total > 0 ? (classified / total * 100) : 0;
  const pctConfident  = total > 0 ? (confident  / total * 100) : 0;
  const avgConf       = parseFloat(snap.avg_confidence) || 0;

  // Composite health score (0–100):
  //   40% weight: classification rate (target 95%)
  //   40% weight: confidence rate (target 85%)
  //   20% weight: avg confidence (target 70)
  const classScore = Math.min(pctClassified / 95  * 40, 40);
  const confScore  = Math.min(pctConfident  / 85  * 40, 40);
  const avgScore   = Math.min(avgConf       / 70  * 20, 20);
  const healthScore = Math.round(classScore + confScore + avgScore);

  const { rows: [inserted] } = await pool.query(
    `INSERT INTO pipeline_health
       (total_active, pct_classified, pct_confident, avg_confidence,
        local_business_cnt, uncategorized_cnt, duplicate_cnt,
        shell_candidate_cnt, needs_review_cnt, health_score, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING health_id, health_score`,
    [
      total,
      pctClassified.toFixed(2),
      pctConfident.toFixed(2),
      avgConf,
      parseInt(snap.local_business_cnt),
      parseInt(snap.uncategorized_cnt),
      duplicateCnt,
      parseInt(snap.shell_cnt),
      parseInt(snap.needs_review_cnt),
      healthScore,
      notes,
    ]
  );

  const result = {
    health_id:         inserted.health_id,
    health_score:      healthScore,
    pct_classified:    pctClassified.toFixed(1),
    pct_confident:     pctConfident.toFixed(1),
    avg_confidence:    avgConf,
    local_business:    snap.local_business_cnt,
    uncategorized:     snap.uncategorized_cnt,
    duplicates_marked: duplicateCnt,
    shells:            snap.shell_cnt,
    needs_review:      snap.needs_review_cnt,
  };

  console.log('[validate] health snapshot:', result);
  return result;
}

// ─── STALL DETECTION ─────────────────────────────────────────────────────────
// Returns true if health_score has not improved in the last 3 runs
async function isStalling() {
  const { rows } = await pool.query(`
    SELECT health_score FROM pipeline_health
    ORDER BY run_at DESC LIMIT 4
  `);
  if (rows.length < 4) return false;
  const scores = rows.map(r => parseFloat(r.health_score));
  // Stalling if latest 3 scores are all within 0.5 of each other (no improvement)
  const [a, b, c] = scores;
  return Math.abs(a - b) < 0.5 && Math.abs(b - c) < 0.5;
}

// ─── MAIN ────────────────────────────────────────────────────────────────────
async function runValidation() {
  const startedAt = new Date();
  console.log(`[validate] start: ${startedAt.toISOString()}`);

  const duplicateCnt  = await detectDuplicates();
  const { shellCount } = await scoreAllRecords();
  const health         = await computeHealthSnapshot(duplicateCnt, `shells: ${shellCount}`);
  const stalling       = await isStalling();

  if (stalling) {
    // Mark latest health row
    await pool.query(
      `UPDATE pipeline_health SET stall_flag = TRUE WHERE health_id = $1`,
      [health.health_id]
    );
    console.log('[validate] ⚠️  STALL DETECTED — 3 consecutive runs with no improvement');
    health.stall_detected = true;
  }

  const runtime = Math.round((new Date() - startedAt) / 1000);
  console.log(`[validate] done in ${runtime}s`);
  return health;
}

if (require.main === module) {
  runValidation()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runValidation, computeHealthSnapshot, isStalling };
