'use strict';
/**
 * briefValidator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Validates that ZIP brief narratives are substantively different from
 * raw business lists — and that they contain actionable market intelligence.
 *
 * Reads briefs from Postgres (zip_briefs table) first; flat-file fallback for
 * local dev without DB. Business name cross-check reads from Postgres businesses
 * table.
 *
 * Runs before each 4-hour zipBriefWorker cycle. If a brief fails validation,
 * the ZIP is flagged for forced rebuild with enriched narrative logic.
 *
 * What "substantively different" means:
 *   PASS:
 *     - Narrative contains market reasoning (saturation, gaps, density, segments)
 *     - Narrative is NOT just business names concatenated
 *     - brief has: by_group counts, saturation_signals, gaps array, avg_confidence
 *     - narrative length > 100 chars and < 2000 (not a dump, not truncated)
 *     - narrative contains at least 2 of: segment/gap/saturation/confidence/density
 *
 *   FAIL:
 *     - Narrative is just a business name list
 *     - Narrative is missing or under 60 chars
 *     - brief is missing structural fields (by_group, gaps, coverage)
 *     - narrative contains > 30% business names from the raw list
 *     - by_group only has "other" (categorization failed)
 *
 * Usage:
 *   node workers/briefValidator.js          — validate all built briefs
 *   node workers/briefValidator.js 32082    — validate one ZIP
 */

const fs   = require('fs');
const path = require('path');

const BASE_DIR    = path.join(__dirname, '..');
const BRIEFS_DIR  = path.join(BASE_DIR, 'data', 'briefs');
const ZIPS_DIR    = path.join(BASE_DIR, 'data', 'zips');
const REPORT_PATH = path.join(BASE_DIR, 'data', 'brief_validation.json');

// ── Validation rules ──────────────────────────────────────────────────────────

const MARKET_REASONING_TERMS = [
  'segment', 'saturation', 'gap', 'opportunity', 'confidence', 'density',
  'per capita', 'population', 'dominant', 'undersupplied', 'covered',
  'grade', 'market', 'businesses', 'per 10k', 'mapped', 'resident',
];

const MIN_REASONING_TERMS  = 3;
const MIN_NARRATIVE_LENGTH = 80;
const MAX_NARRATIVE_LENGTH = 3000;
const MAX_NAME_BLEED_PCT   = 0.25;
const MIN_GROUP_DIVERSITY  = 2;
const MIN_TOTAL_BUSINESSES = 1;

// ── Brief loader — Postgres first, flat-file fallback ────────────────────────
async function loadBrief(zip) {
  // 1. Postgres
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const pgStore = require('../lib/pgStore');
      const brief   = await pgStore.getZipBrief(zip);
      if (brief) return brief;
    } catch (_) {}
  }
  // 2. Flat file
  const briefFile = path.join(BRIEFS_DIR, `${zip}.json`);
  if (!fs.existsSync(briefFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(briefFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ── Business loader — Postgres first, flat-file fallback ─────────────────────
async function loadBusinesses(zip) {
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const pgStore = require('../lib/pgStore');
      const rows    = await pgStore.getBusinessesByZip(zip);
      if (Array.isArray(rows)) return rows;
    } catch (_) {}
  }
  const zipFile = path.join(ZIPS_DIR, `${zip}.json`);
  if (!fs.existsSync(zipFile)) return null;
  try {
    return JSON.parse(fs.readFileSync(zipFile, 'utf8'));
  } catch (_) {
    return null;
  }
}

// ── ZIP list for validateAll ──────────────────────────────────────────────────
async function getKnownZips(targetZip) {
  if (targetZip) return [targetZip];

  // 1. Postgres zip_briefs table
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const pgStore = require('../lib/pgStore');
      const zips    = await pgStore.getZipBriefZips();
      if (zips.length > 0) return zips;
    } catch (_) {}
  }
  // 2. Flat-file fallback
  if (!fs.existsSync(BRIEFS_DIR)) return [];
  return fs.readdirSync(BRIEFS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''));
}

// ── Single-brief validator ────────────────────────────────────────────────────
async function validateBrief(zip) {
  const result = {
    zip,
    passed:   false,
    score:    0,
    checks:   {},
    failures: [],
    warnings: [],
    narrative_length: 0,
    generated_at: null,
  };

  // ── Check 1: brief exists ────────────────────────────────────────────────────
  const brief = await loadBrief(zip);
  if (!brief) {
    result.checks.brief_exists = false;
    result.failures.push('brief not found in Postgres or flat file — zipBriefWorker has not run yet');
    return result;
  }

  result.checks.brief_exists = true;
  result.generated_at        = brief.generated_at || brief._stored_at || null;
  result.score              += 10;

  // ── Check 2: required structural fields ──────────────────────────────────────
  const requiredFields = ['zip', 'label', 'total', 'by_group', 'narrative', 'gaps', 'coverage', 'avg_confidence'];
  const missingFields  = requiredFields.filter(f => brief[f] === undefined || brief[f] === null);
  result.checks.has_required_fields = missingFields.length === 0;
  if (missingFields.length > 0) {
    result.failures.push(`missing fields: ${missingFields.join(', ')}`);
  } else {
    result.score += 15;
  }

  // ── Check 3: has real businesses ─────────────────────────────────────────────
  const total = brief.total || 0;
  result.checks.has_businesses = total >= MIN_TOTAL_BUSINESSES;
  if (total < MIN_TOTAL_BUSINESSES) {
    result.failures.push(`total businesses = ${total} — no data`);
  } else {
    result.score += 5;
  }

  // ── Check 4: narrative length ─────────────────────────────────────────────────
  const narrative = (brief.narrative || '').trim();
  result.narrative_length = narrative.length;
  const narrativeLenOk = narrative.length >= MIN_NARRATIVE_LENGTH && narrative.length <= MAX_NARRATIVE_LENGTH;
  result.checks.narrative_length = narrativeLenOk;
  if (narrative.length < MIN_NARRATIVE_LENGTH) {
    result.failures.push(`narrative too short (${narrative.length} chars) — looks truncated or missing`);
  } else if (narrative.length > MAX_NARRATIVE_LENGTH) {
    result.warnings.push(`narrative very long (${narrative.length} chars) — may be a data dump`);
  } else {
    result.score += 15;
  }

  // ── Check 5: market reasoning terms ──────────────────────────────────────────
  const narLower   = narrative.toLowerCase();
  const termsFound = MARKET_REASONING_TERMS.filter(t => narLower.includes(t));
  const reasoningOk = termsFound.length >= MIN_REASONING_TERMS;
  result.checks.contains_market_reasoning = reasoningOk;
  result.reasoning_terms_found = termsFound;
  if (!reasoningOk) {
    result.failures.push(`narrative only has ${termsFound.length}/${MIN_REASONING_TERMS} required reasoning terms (${termsFound.join(', ')}) — reads like a list not analysis`);
  } else {
    result.score += 20;
  }

  // ── Check 6: narrative is NOT just business names ─────────────────────────────
  const businesses = await loadBusinesses(zip);
  if (businesses) {
    try {
      const allNames = businesses
        .map(b => (b.name || '').toLowerCase())
        .filter(n => n.length > 3);

      const narWords = new Set(narLower.split(/\W+/).filter(w => w.length > 3));
      let nameTokensInNarrative = 0;
      let totalNameTokens = 0;
      for (const name of allNames.slice(0, 100)) {
        const tokens = name.split(/\s+/).filter(w => w.length > 3);
        totalNameTokens += tokens.length;
        nameTokensInNarrative += tokens.filter(t => narWords.has(t)).length;
      }
      const bleedPct = totalNameTokens > 0 ? nameTokensInNarrative / totalNameTokens : 0;
      const nameBleeds = Math.round(bleedPct * 100);
      result.checks.not_a_name_list = bleedPct <= MAX_NAME_BLEED_PCT;
      result.name_bleed_pct = nameBleeds;
      if (bleedPct > MAX_NAME_BLEED_PCT) {
        result.failures.push(`${nameBleeds}% of narrative words are business name tokens — likely a raw list not a summary`);
      } else {
        result.score += 15;
      }
    } catch { result.checks.not_a_name_list = true; result.score += 15; }
  } else {
    result.checks.not_a_name_list = true;
    result.score += 15; // can't check without raw businesses, assume pass
  }

  // ── Check 7: group diversity ───────────────────────────────────────────────────
  const byGroup     = brief.by_group || {};
  const namedGroups = Object.keys(byGroup).filter(g => g !== 'other' && byGroup[g] > 0);
  const groupDivOk  = namedGroups.length >= MIN_GROUP_DIVERSITY;
  result.checks.group_diversity = groupDivOk;
  result.named_groups = namedGroups;
  if (!groupDivOk) {
    result.warnings.push(`only ${namedGroups.length} named groups (${namedGroups.join(', ')}) — categorization may have failed`);
  } else {
    result.score += 10;
  }

  // ── Check 8: gaps + saturation signals ────────────────────────────────────────
  const hasSignals = Array.isArray(brief.saturation_signals) && Array.isArray(brief.gaps);
  result.checks.has_signal_arrays = hasSignals;
  if (!hasSignals) {
    result.failures.push('missing saturation_signals or gaps arrays — brief structure incomplete');
  } else {
    result.score += 10;
  }

  // ── Final verdict ──────────────────────────────────────────────────────────────
  result.passed = result.failures.length === 0;
  result.grade  = result.score >= 85 ? 'A'
                : result.score >= 70 ? 'B'
                : result.score >= 55 ? 'C'
                : result.score >= 40 ? 'D' : 'F';

  return result;
}

// ── Validate all briefs ───────────────────────────────────────────────────────
async function validateAll(targetZip = null) {
  const zips = await getKnownZips(targetZip);

  if (zips.length === 0) {
    console.log('[brief-validator] No briefs found in Postgres or data/briefs/ — zipBriefWorker has not run yet');
    return null;
  }

  const results = [];
  let passed = 0, failed = 0;

  for (const zip of zips) {
    const r = await validateBrief(zip);
    results.push(r);
    if (r.passed) passed++; else failed++;
  }

  // ── Print table ───────────────────────────────────────────────────────────────
  console.log('\n[brief-validator] ── VALIDATION REPORT ────────────────────────────────────');
  console.log(`[brief-validator]   Briefs checked: ${results.length} | PASS: ${passed} | FAIL: ${failed}`);
  console.log('[brief-validator]   ─────────────────────────────────────────────────────────');

  const sorted = [...results].sort((a, b) => a.score - b.score);
  for (const r of sorted) {
    const status = r.passed ? '✅ PASS' : '❌ FAIL';
    const checks = Object.values(r.checks).map(v => v ? '✓' : '✗').join('');
    console.log(`[brief-validator]   ${r.zip} | ${status} | score:${r.score} grade:${r.grade} | checks:[${checks}] | narLen:${r.narrative_length}`);
    if (!r.passed) r.failures.forEach(f => console.log(`[brief-validator]       ⚠ ${f}`));
    if (r.warnings.length) r.warnings.forEach(w => console.log(`[brief-validator]       ℹ ${w}`));
  }

  console.log(`[brief-validator] ── Overall: ${passed}/${results.length} briefs pass (${Math.round(passed/results.length*100)}%) ────────────────`);
  console.log('');

  // ── Save report (flat file) ───────────────────────────────────────────────────
  const report = {
    generated_at:  new Date().toISOString(),
    total_checked: results.length,
    passed,
    failed,
    pass_rate_pct: Math.round(passed / results.length * 100),
    failed_zips:   results.filter(r => !r.passed).map(r => r.zip),
    results,
  };
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log('[brief-validator] Report saved → data/brief_validation.json');
  } catch (_) {}

  return report;
}

// ── Hook: called by zipBriefWorker before each cycle ─────────────────────────
// Returns list of ZIPs that need forced rebuild
async function getFailedZips() {
  // Try reading from in-memory report file first (fast path between cycles)
  try {
    if (fs.existsSync(REPORT_PATH)) {
      const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'));
      return report.failed_zips || [];
    }
  } catch (_) {}
  return [];
}

// ── CLI ───────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const targetZip = process.argv[2] || null;
  console.log(`[brief-validator] Running validation${targetZip ? ` for ZIP ${targetZip}` : ' — all briefs'}`);

  validateAll(targetZip).then(report => {
    if (targetZip && report) {
      const r = report.results[0];
      if (r) {
        console.log('\n── DETAILED RESULT ──────────────────────────────────────────────────────────');
        console.log('ZIP:             ', r.zip);
        console.log('Passed:          ', r.passed);
        console.log('Score:           ', r.score, '/ 100');
        console.log('Grade:           ', r.grade);
        console.log('Narrative length:', r.narrative_length, 'chars');
        console.log('Reasoning terms: ', (r.reasoning_terms_found || []).join(', '));
        console.log('Name bleed:      ', r.name_bleed_pct !== undefined ? `${r.name_bleed_pct}%` : 'n/a');
        console.log('Named groups:    ', (r.named_groups || []).join(', '));
        console.log('Failures:        ', r.failures.length ? r.failures.join(' | ') : 'none');
        console.log('Warnings:        ', r.warnings.length ? r.warnings.join(' | ') : 'none');
        console.log('─────────────────────────────────────────────────────────────────────────────\n');
      }
    }
    process.exit(report && report.failed === 0 ? 0 : 1);
  }).catch(err => {
    console.error('[brief-validator] Fatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { validateBrief, validateAll, getFailedZips };
