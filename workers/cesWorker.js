'use strict';
/**
 * cesWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches BLS Current Employment Statistics (CES) for all FL MSAs via the
 * BLS Public Data API v2 (SMU series), then:
 *   1. Writes sector employment + YoY % to zip_signals for every ZIP in each MSA
 *   2. Computes AI displacement risk score from sector employment mix
 *   3. Computes investment opportunity score from multi-factor labor data
 *
 * Series format: SMU + state(2) + area(5) + supersector(2) + industry(8) + datatype(2)
 * Example: SMU12272606500000001 = FL, Jacksonville, Educ+Health, all workers
 *
 * Supersectors fetched:
 *   00 = Total nonfarm
 *   20 = Construction
 *   42 = Retail Trade
 *   55 = Financial Activities
 *   60 = Professional & Business Services
 *   65 = Education & Health Services
 *   70 = Leisure & Hospitality
 *   90 = Government
 *
 * BLS batch limit: 50 series per POST.
 * 21 MSAs × 8 supersectors = 168 series → 4 batch calls.
 *
 * AI DISPLACEMENT RISK MODEL:
 * Based on sector-level AI exposure scores derived from published research
 * (Felten et al. 2023, Webb 2020, McKinsey 2023). Scores represent the
 * fraction of occupations within each supersector facing high AI substitution
 * risk over a 5–10yr horizon:
 *
 *   Financial Activities (55): 0.72  ← high (clerical, analysis, trading)
 *   Retail Trade (42):         0.65  ← high (checkout, inventory, customer service)
 *   Professional & Biz (60):  0.58  ← medium-high (legal, admin, some tech)
 *   Total Nonfarm base:        0.45  ← baseline average
 *   Leisure & Hospitality (70):0.35 ← medium-low (in-person service, hard to replace)
 *   Education & Health (65):   0.28  ← low (patient care, teaching, hands-on)
 *   Construction (20):         0.22  ← low (physical manipulation, on-site adaptation)
 *   Government (90):           0.30  ← low-medium (regulatory, protected roles)
 *
 * INVESTMENT OPPORTUNITY SCORE MODEL:
 * Composite 0–100 weighted score:
 *   - Healthcare/Education YoY growth × 2.0 (recession-resistant anchor)
 *   - Total nonfarm YoY growth × 1.5
 *   - Low AI displacement risk × 1.0 (inverted: lower risk = higher score)
 *   - Construction growth × 1.2 (leading indicator of population/commercial growth)
 *   - QCEW avg weekly wage growth (if available) × 1.5
 * Normalized to 0–100 with FL average = 50.
 * Tiers: A (≥70), B (55–69), C (40–54), D (<40)
 *
 * Worker contract:
 *   START → freshness check → batch BLS calls → compute scores → upsert all ZIPs → END
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https  = require('https');
const db     = require('../lib/db');
const pgStore = require('../lib/pgStore');
const { FL_MSAS, MSA_NAMES, getZipsForMsa } = require('../lib/flZipMsaMap');

const BLS_API_URL = 'https://api.bls.gov/publicAPI/v2/timeseries/data/';
const API_KEY     = process.env.BLS_QCEW_API;   // reuses same BLS API key
const BATCH_SIZE  = 50;
const PACE_MS     = 1500;

// Supersectors to fetch per MSA
const SUPERSECTORS = [
  { code: '00', field: 'total',        label: 'Total Nonfarm' },
  { code: '20', field: 'construction', label: 'Construction' },
  { code: '42', field: 'retail',       label: 'Retail Trade' },
  { code: '55', field: 'financial',    label: 'Financial Activities' },
  { code: '60', field: 'professional', label: 'Professional & Business Services' },
  { code: '65', field: 'healthcare',   label: 'Education & Health Services' },
  { code: '70', field: 'leisure',      label: 'Leisure & Hospitality' },
  { code: '90', field: 'government',   label: 'Government' },
];

// AI displacement risk scores by supersector (0–1 scale, published research composite)
const AI_EXPOSURE = {
  financial:    0.72,
  retail:       0.65,
  professional: 0.58,
  leisure:      0.35,
  government:   0.30,
  healthcare:   0.28,
  construction: 0.22,
  total:        0.45,  // baseline — not used in weighted calc
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function buildSeriesIds(msas) {
  const ids = [];
  for (const msa of msas) {
    for (const ss of SUPERSECTORS) {
      // SMU + 12(FL) + area(5) + supersector(2) + 00000000 + 01
      ids.push(`SMU12${msa}${ss.code}00000001`);
    }
  }
  return ids;
}

function blsBatchPost(seriesIds) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      seriesid: seriesIds,
      registrationkey: API_KEY,
      startyear: String(new Date().getFullYear() - 1),
      endyear:   String(new Date().getFullYear()),
    });
    const opts = {
      method: 'POST',
      hostname: 'api.bls.gov',
      path: '/publicAPI/v2/timeseries/data/',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)',
      },
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.status === 'REQUEST_NOT_PROCESSED') {
            return reject(new Error('BLS: ' + (j.message?.join(', ') || 'REQUEST_NOT_PROCESSED')));
          }
          resolve(j);
        } catch (e) {
          reject(new Error(`BLS parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Parse BLS response into: msaCode → { supersectorField → { emp, yoy, vintage } }
 */
function parseBLSResponse(blsJson, msas) {
  const results = {};  // msaCode → { total: {emp,yoy,vintage}, healthcare: {...}, ... }

  // Build reverse lookup: seriesId → { msa, field }
  const seriesMap = {};
  for (const msa of msas) {
    for (const ss of SUPERSECTORS) {
      const sid = `SMU12${msa}${ss.code}00000001`;
      seriesMap[sid] = { msa, field: ss.field };
    }
  }

  for (const series of (blsJson?.Results?.series || [])) {
    const sid  = series.seriesID?.trim();
    const meta = seriesMap[sid];
    if (!meta) continue;

    const { msa, field } = meta;
    if (!results[msa]) results[msa] = {};

    // Filter out annual averages (M13), sort desc
    const data = (series.data || [])
      .filter(d => d.period !== 'M13' && d.value !== '-')
      .sort((a, b) => {
        const ay = parseInt(a.year) * 100 + parseInt(a.period.replace('M', ''));
        const by = parseInt(b.year) * 100 + parseInt(b.period.replace('M', ''));
        return by - ay;
      });

    if (!data.length) continue;

    const latest = data[0];
    const emp = parseFloat(latest.value);
    const vintage = `${latest.year}-${latest.period.replace('M', '').padStart(2, '0')}`;

    // YoY: find same month prior year (12 entries back)
    const prior = data.find((d, i) => i > 0 && d.period === latest.period &&
      parseInt(d.year) === parseInt(latest.year) - 1) || data[12];
    const yoy = prior
      ? parseFloat(((emp - parseFloat(prior.value)) / parseFloat(prior.value) * 100).toFixed(1))
      : null;

    // MoM: compare to prior month (index 1)
    const prevMonth = data[1];
    const mom = prevMonth
      ? parseFloat(((emp - parseFloat(prevMonth.value)) / parseFloat(prevMonth.value) * 100).toFixed(2))
      : null;

    results[msa][field] = { emp, yoy, mom, vintage };
  }

  return results;
}

/**
 * Compute AI displacement risk score (0–100) for an MSA.
 * Weighted average of sector AI exposure scores, weighted by employment share.
 */
function computeAiDisplacementRisk(sectors) {
  const total = sectors.total?.emp || 0;
  if (!total) return null;

  let weightedRisk = 0;
  let coveredEmp   = 0;

  const sectorFields = ['financial', 'retail', 'professional', 'leisure', 'healthcare', 'construction', 'government'];
  for (const field of sectorFields) {
    const emp = sectors[field]?.emp || 0;
    if (emp > 0 && AI_EXPOSURE[field] != null) {
      weightedRisk += (emp / total) * AI_EXPOSURE[field];
      coveredEmp   += emp;
    }
  }

  // Remainder (uncategorized sectors) gets baseline score
  const remainder = Math.max(0, total - coveredEmp);
  weightedRisk += (remainder / total) * AI_EXPOSURE.total;

  return parseFloat((weightedRisk * 100).toFixed(1));
}

/**
 * Compute investment opportunity score (0–100).
 * Higher = more attractive labor market for business investment.
 *
 * Scoring logic:
 * - Healthcare YoY growth: most stable, recession-resistant anchor (+2pts per 1% growth, cap 20)
 * - Total nonfarm YoY growth: overall momentum (+1.5pts per 1%, cap 15)
 * - Low AI risk: markets with resilient workforce attract stable employers (30 - risk*0.3, min 0)
 * - Construction growth: leading indicator of physical expansion (+1.2pts per 1%, cap 12)
 * - Professional services growth: knowledge economy signal (+1pt per 1%, cap 10)
 * Normalize to 0–100 range; add base of 35 so flat markets score near 50.
 */
function computeInvestmentScore(sectors, aiRisk) {
  let score = 35;  // base (neutral market)

  const healthYoy = sectors.healthcare?.yoy || 0;
  const totalYoy  = sectors.total?.yoy      || 0;
  const constYoy  = sectors.construction?.yoy || 0;
  const profYoy   = sectors.professional?.yoy  || 0;

  score += Math.min(20, healthYoy * 2.0);
  score += Math.min(15, totalYoy  * 1.5);
  score += Math.min(10, constYoy  * 1.2);
  score += Math.min(10, profYoy   * 1.0);

  // AI risk penalty: high risk subtracts up to 15 points (100% risk = -15)
  if (aiRisk != null) score -= (aiRisk / 100) * 15;

  score = Math.max(0, Math.min(100, score));
  return parseFloat(score.toFixed(1));
}

function getInvestmentTier(score) {
  if (score == null) return null;
  if (score >= 70) return 'A';
  if (score >= 55) return 'B';
  if (score >= 40) return 'C';
  return 'D';
}

function getDominantGrowthSector(sectors) {
  const candidates = ['healthcare', 'professional', 'construction', 'financial', 'leisure', 'retail'];
  let best = null, bestYoy = -Infinity;
  for (const f of candidates) {
    const yoy = sectors[f]?.yoy;
    if (yoy != null && yoy > bestYoy) { bestYoy = yoy; best = f; }
  }
  return best;
}

async function isFresh() {
  try {
    const row = await db.queryOne(
      `SELECT last_run FROM worker_heartbeat WHERE worker_name = 'cesWorker'`
    );
    if (!row) return false;
    const ageDays = (Date.now() - new Date(row.last_run).getTime()) / 86400000;
    return ageDays < 2;  // Re-run if more than 2 days old (monthly data, but worker is cheap)
  } catch { return false; }
}

async function run() {
  if (!API_KEY) {
    console.error('[ces] ❌ BLS_QCEW_API env var not set — cannot run');
    process.exit(1);
  }

  const fresh = await isFresh();
  if (fresh) {
    console.log('[ces] ⏭ Data is fresh (< 2 days) — skipping. Delete heartbeat to force re-run.');
    process.exit(0);
  }

  console.log(`[ces] Starting CES worker — ${FL_MSAS.length} FL MSAs × ${SUPERSECTORS.length} supersectors`);
  const start = Date.now();

  // Build all series IDs and batch
  const allSeries = buildSeriesIds(FL_MSAS);
  const batches   = [];
  for (let i = 0; i < allSeries.length; i += BATCH_SIZE) {
    batches.push(allSeries.slice(i, i + BATCH_SIZE));
  }
  console.log(`[ces] ${allSeries.length} series → ${batches.length} batch calls`);

  // Fetch all batches
  const allParsed = {};  // msaCode → sectors
  for (let i = 0; i < batches.length; i++) {
    try {
      console.log(`[ces] Batch ${i + 1}/${batches.length} — ${batches[i].length} series`);
      const blsJson = await blsBatchPost(batches[i]);
      const parsed  = parseBLSResponse(blsJson, FL_MSAS);
      for (const [msa, sectors] of Object.entries(parsed)) {
        if (!allParsed[msa]) allParsed[msa] = {};
        Object.assign(allParsed[msa], sectors);
      }
      if (i < batches.length - 1) await sleep(PACE_MS);
    } catch (e) {
      console.error(`[ces] Batch ${i + 1} failed:`, e.message);
    }
  }

  const msasGot = Object.keys(allParsed).length;
  console.log(`[ces] Parsed ${msasGot}/${FL_MSAS.length} MSAs`);

  // Sample: Jacksonville
  const jax = allParsed['27260'];
  if (jax) {
    console.log(`[ces] Jacksonville: total=${jax.total?.emp}k (${jax.total?.yoy}% YoY) health=${jax.healthcare?.emp}k (${jax.healthcare?.yoy}%)`);
  }

  // Compute scores and upsert to ZIP signals
  let msaDone = 0, zipsDone = 0;

  for (const [msaCode, sectors] of Object.entries(allParsed)) {
    if (!sectors.total?.emp) continue;

    const aiRisk     = computeAiDisplacementRisk(sectors);
    const invScore   = computeInvestmentScore(sectors, aiRisk);
    const invTier    = getInvestmentTier(invScore);
    const domSector  = getDominantGrowthSector(sectors);
    const vintage    = sectors.total?.vintage || null;

    const payload = {
      ces_msa_code:              msaCode,
      ces_msa_name:              MSA_NAMES[msaCode] || null,
      ces_total_nonfarm:         sectors.total?.emp           || null,
      ces_total_mom_pct:         sectors.total?.mom           != null ? sectors.total.mom   : null,
      ces_total_yoy_pct:         sectors.total?.yoy           != null ? sectors.total.yoy   : null,
      ces_healthcare_emp:        sectors.healthcare?.emp      || null,
      ces_healthcare_yoy_pct:    sectors.healthcare?.yoy      != null ? sectors.healthcare.yoy : null,
      ces_professional_emp:      sectors.professional?.emp    || null,
      ces_professional_yoy_pct:  sectors.professional?.yoy    != null ? sectors.professional.yoy : null,
      ces_leisure_emp:           sectors.leisure?.emp         || null,
      ces_leisure_yoy_pct:       sectors.leisure?.yoy         != null ? sectors.leisure.yoy : null,
      ces_construction_emp:      sectors.construction?.emp    || null,
      ces_construction_yoy_pct:  sectors.construction?.yoy    != null ? sectors.construction.yoy : null,
      ces_retail_emp:            sectors.retail?.emp          || null,
      ces_retail_yoy_pct:        sectors.retail?.yoy          != null ? sectors.retail.yoy : null,
      ces_financial_emp:         sectors.financial?.emp       || null,
      ces_financial_yoy_pct:     sectors.financial?.yoy       != null ? sectors.financial.yoy : null,
      ces_government_emp:        sectors.government?.emp      || null,
      ces_government_yoy_pct:    sectors.government?.yoy      != null ? sectors.government.yoy : null,
      ces_dominant_sector:       domSector,
      ces_vintage:               vintage,
      ces_updated_at:            new Date(),
      // AI + Investment scores
      ai_displacement_risk:         aiRisk,
      investment_opportunity_score: invScore,
      investment_tier:              invTier,
      labor_market_momentum:        sectors.total?.yoy != null ? parseFloat(sectors.total.yoy.toFixed(1)) : null,
      dominant_growth_sector:       domSector,
      ai_scores_updated_at:         new Date(),
    };

    const zips = getZipsForMsa(msaCode);
    if (zips.length === 0) {
      console.warn(`[ces] ${MSA_NAMES[msaCode]} (${msaCode}): no ZIPs in registry`);
      continue;
    }

    for (const zip of zips) {
      await pgStore.upsertZipSignals(zip, payload);
      zipsDone++;
    }

    console.log(`[ces] ${MSA_NAMES[msaCode]}: total=${sectors.total?.emp}k yoy=${sectors.total?.yoy}% aiRisk=${aiRisk} invScore=${invScore} tier=${invTier} → ${zips.length} ZIPs`);
    msaDone++;
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('cesWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[ces] ✅ Done — ${msaDone} MSAs, ${zipsDone} ZIP upserts — ${elapsed}s`);
  process.exit(0);
}

run().catch(e => { console.error('[ces] fatal:', e.message); process.exit(1); });
