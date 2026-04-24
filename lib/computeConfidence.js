'use strict';
/**
 * computeConfidence.js
 *
 * Deterministic, field-completeness-based confidence scorer for business records.
 * No LLM calls. No external requests.
 *
 * Scoring rubric (max 100):
 *   Base              40  — record exists
 *   + phone           15  — has a real phone number
 *   + specific cat     8  — category is not generic (LocalBusiness / business / unknown)
 *   + hours           10  — has hours string
 *   + full address     5  — address has street number (not just city/state)
 *   + lat/lon          7  — geocoded
 *   + website          5  — has a real website (not a YP listing URL)
 *   + multi-source     5  — two or more sources
 *   + owner-verified  +5  — claimed / owner_verified flag
 *                    ---
 *   Max             100
 */

const GENERIC_CATS = new Set([
  'localbusiness','business','unknown','','services','general'
]);

function computeConfidence(b) {
  let score = 40; // base

  // Phone: non-empty, not just dashes/zeros
  const phone = (b.phone || '').replace(/[\s\-().+]/g, '');
  if (phone.length >= 7 && !/^0+$/.test(phone)) score += 15;

  // Specific category
  const cat = (b.category || '').toLowerCase().trim();
  if (cat && !GENERIC_CATS.has(cat)) score += 8;

  // Hours
  if (b.hours && b.hours.trim().length > 3) score += 10;

  // Full address (has a street number)
  const addr = (b.address || '').trim();
  if (addr && /^\d/.test(addr)) score += 5;

  // Lat/lon
  if (b.lat && b.lon) score += 7;

  // Website (real domain, not yellowpages.com)
  const site = (b.website || '').toLowerCase();
  if (site && !site.includes('yellowpages.com') && !site.includes('yp.com')) score += 5;

  // Multi-source: sources array length >= 2, or two different source indicators
  const sources = Array.isArray(b.sources) ? b.sources : (b.source ? [b.source] : []);
  if (b.chamber_member) sources.push('chamber');
  if (b.yp_source) sources.push('yellowpages');
  const uniqueSources = new Set(sources.map(s => (s || '').toLowerCase()));
  if (uniqueSources.size >= 2) score += 5;

  // Owner-verified / claimed
  if (b.claimed || b.owner_verified) score += 5;

  return Math.min(100, score);
}

module.exports = { computeConfidence };
