'use strict';
/**
 * lib/aliasResolver.js
 * Unified alias resolution: Tier 2 (hardcoded brandAliases) → Tier 1 (Postgres business_aliases) → Tier 3 (community slang).
 * Use resolveBusinessAlias(raw) to get the canonical business name and/or business_id.
 *
 * Resolution order:
 *   Tier 2 (exact/substring) → Tier 1 exact → Tier 3 exact → Tier 1 partial → Tier 3 partial → no match
 * Tier 3 only resolves verified (votes >= 3), non-negative community slang.
 */

const { BRAND_ALIAS_MAP } = require('./brandAliases');
const db = require('./db');

/**
 * Given a raw business name string, return the best canonical name to search.
 * Returns { canonical: string, business_id: string|null, tier: 1|2|3|null }
 */
async function resolveBusinessAlias(raw) {
  if (!raw || typeof raw !== 'string') {
    return { canonical: raw, business_id: null, tier: null };
  }
  const key = raw.trim().toLowerCase();

  // Tier 2 — hardcoded map (exact then substring)
  let canonical = BRAND_ALIAS_MAP[key] || null;
  if (!canonical) {
    for (const [alias, name] of Object.entries(BRAND_ALIAS_MAP)) {
      if (key.includes(alias)) { canonical = name; break; }
    }
  }
  if (canonical) return { canonical, business_id: null, tier: 2 };

  // Tier 1 — Postgres business_aliases exact
  try {
    const rows = await db.query(
      `SELECT ba.business_id, b.name AS canonical
         FROM business_aliases ba
         JOIN businesses b ON b.business_id = ba.business_id
        WHERE ba.alias_lower = $1
        LIMIT 1`,
      [key]
    );
    if (rows.length) {
      return { canonical: rows[0].canonical, business_id: rows[0].business_id, tier: 1 };
    }
  } catch (err) {
    console.error('[aliasResolver] Tier 1 exact lookup error:', err.message);
  }

  // Tier 3 — community slang exact (verified, non-negative, votes >= 3)
  try {
    const slangRows = await db.query(
      `SELECT bs.business_id, b.name AS canonical
         FROM business_slang bs
         JOIN businesses b ON b.business_id = bs.business_id
        WHERE bs.term_lower = $1
          AND bs.is_negative = FALSE
          AND bs.verified = TRUE
          AND bs.votes >= 3
        LIMIT 1`,
      [key]
    );
    if (slangRows.length) {
      return { canonical: slangRows[0].canonical, business_id: slangRows[0].business_id, tier: 3 };
    }
  } catch (err) {
    console.error('[aliasResolver] Tier 3 exact lookup error:', err.message);
  }

  // Tier 1 partial — alias_lower LIKE
  try {
    const partialRows = await db.query(
      `SELECT ba.business_id, b.name AS canonical
         FROM business_aliases ba
         JOIN businesses b ON b.business_id = ba.business_id
        WHERE $1 LIKE '%' || ba.alias_lower || '%'
           OR ba.alias_lower LIKE '%' || $1 || '%'
        ORDER BY length(ba.alias_lower) DESC
        LIMIT 1`,
      [key]
    );
    if (partialRows.length) {
      return { canonical: partialRows[0].canonical, business_id: partialRows[0].business_id, tier: 1 };
    }
  } catch (err) {
    console.error('[aliasResolver] Tier 1 partial lookup error:', err.message);
  }

  // Tier 3 partial — community slang substring (verified only)
  try {
    const slangPartial = await db.query(
      `SELECT bs.business_id, b.name AS canonical
         FROM business_slang bs
         JOIN businesses b ON b.business_id = bs.business_id
        WHERE bs.is_negative = FALSE
          AND bs.verified = TRUE
          AND bs.votes >= 3
          AND ($1 LIKE '%' || bs.term_lower || '%'
               OR bs.term_lower LIKE '%' || $1 || '%')
        ORDER BY length(bs.term_lower) DESC, bs.votes DESC
        LIMIT 1`,
      [key]
    );
    if (slangPartial.length) {
      return { canonical: slangPartial[0].canonical, business_id: slangPartial[0].business_id, tier: 3 };
    }
  } catch (err) {
    console.error('[aliasResolver] Tier 3 partial lookup error:', err.message);
  }

  return { canonical: raw, business_id: null, tier: null };
}

module.exports = { resolveBusinessAlias };
