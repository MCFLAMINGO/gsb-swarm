/**
 * stalenessUtils.js
 *
 * Shared staleness tier logic for LocalIntel data freshness.
 * Pure functions — no side effects, no server startup.
 * Imported by: enrichmentAgent.js, localIntelMCP.js, localIntelTidalTools.js
 *
 * Tiers:
 *   FRESH  < 7 days    → confidence unmodified,  grade A
 *   WARM   7–30 days   → confidence * 0.95,       grade B
 *   STALE  30–90 days  → confidence * 0.80,       grade C, re-enrich queued
 *   COLD   90+ days    → confidence * 0.60,       grade D, high-priority re-enrich
 *   NEW    no timestamp → treated as STALE
 */

const STALENESS_TIERS = [
  { tier: 'FRESH',  maxDays: 7,         confidenceMultiplier: 1.00, grade: 'A', reEnrichPriority: 0  },
  { tier: 'WARM',   maxDays: 30,        confidenceMultiplier: 0.95, grade: 'B', reEnrichPriority: 1  },
  { tier: 'STALE',  maxDays: 90,        confidenceMultiplier: 0.80, grade: 'C', reEnrichPriority: 10 },
  { tier: 'COLD',   maxDays: Infinity,  confidenceMultiplier: 0.60, grade: 'D', reEnrichPriority: 20 },
];

/**
 * Returns the staleness tier for a business record.
 * Uses last_enriched → enriched_at → scraped_at (in order of preference).
 */
function getStaleness(biz) {
  const ts = biz.last_enriched || biz.enriched_at || biz.scraped_at || null;
  if (!ts) {
    return { tier: 'STALE', grade: 'C', confidenceMultiplier: 0.80, reEnrichPriority: 10, ageDays: null };
  }
  const ageDays = (Date.now() - new Date(ts).getTime()) / 86400000;
  const t = STALENESS_TIERS.find(t => ageDays <= t.maxDays) || STALENESS_TIERS[STALENESS_TIERS.length - 1];
  return { ...t, ageDays: Math.round(ageDays) };
}

/**
 * Returns a staleness block for a single business record.
 * Non-destructive — does not modify the record.
 */
function stalenessBlock(biz) {
  const s = getStaleness(biz);
  const effectiveConfidence = Math.round((biz.confidence || 50) * s.confidenceMultiplier);
  return {
    tier:                 s.tier,
    grade:                s.grade,
    age_days:             s.ageDays,
    last_enriched:        biz.last_enriched || biz.enriched_at || null,
    effective_confidence: effectiveConfidence,
    freshness_warning:    s.tier === 'COLD'  ? 'Data is 90+ days old — treat with caution' :
                          s.tier === 'STALE' ? 'Data is 30–90 days old — re-enrichment queued' : null,
    possibly_closed:      biz.possibly_closed || false,
  };
}

/**
 * Computes a freshness summary for an array of businesses (e.g. all in a ZIP).
 * Attached as data_freshness on every MCP response.
 */
function zipFreshnessBlock(businesses) {
  if (!businesses || !businesses.length) {
    return {
      grade: 'F', tier_distribution: {}, total: 0, possibly_closed_count: 0,
      freshness_warning: 'No businesses in dataset for this query',
    };
  }
  const tiers = { FRESH: 0, WARM: 0, STALE: 0, COLD: 0 };
  let possiblyClosed = 0;
  let oldestDays = 0;
  businesses.forEach(b => {
    const s = getStaleness(b);
    tiers[s.tier] = (tiers[s.tier] || 0) + 1;
    if (b.possibly_closed) possiblyClosed++;
    if (s.ageDays && s.ageDays > oldestDays) oldestDays = s.ageDays;
  });
  const total = businesses.length;
  // Overall grade = worst tier with meaningful share
  let grade = 'A';
  if ((tiers.COLD  / total) > 0.10) grade = 'D';
  else if ((tiers.STALE / total) > 0.20) grade = 'C';
  else if ((tiers.WARM  / total) > 0.30) grade = 'B';
  const warning = grade === 'D' ? 'Most data is 90+ days old — verify before acting' :
                  grade === 'C' ? 'Significant portion of data is 30–90 days old' :
                  grade === 'B' ? 'Some data is 7–30 days old' : null;
  return {
    grade,
    tier_distribution: tiers,
    total,
    possibly_closed_count: possiblyClosed,
    oldest_record_days: oldestDays || null,
    freshness_warning: warning,
    grade_key: 'A=FRESH<7d | B=WARM 7-30d | C=STALE 30-90d | D=COLD 90+d',
  };
}

module.exports = { getStaleness, stalenessBlock, zipFreshnessBlock, STALENESS_TIERS };
