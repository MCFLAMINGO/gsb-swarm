'use strict';
/**
 * lib/aliasResolver.js
 * Unified alias resolution: Tier 2 (hardcoded brandAliases) → Tier 1 (Postgres business_aliases).
 * Use resolveBusinessAlias(raw) to get the canonical business name and/or business_id.
 */

const { BRAND_ALIAS_MAP } = require('./brandAliases');
const db = require('./db');

/**
 * Given a raw business name string, return the best canonical name to search.
 * 1. Check Tier 2 (hardcoded) — instant, no DB
 * 2. Check Tier 1 (Postgres business_aliases) — one DB query
 * Returns { canonical: string, business_id: string|null, tier: 1|2|null }
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

  // Tier 1 — Postgres business_aliases
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
    // Tier 1 partial — alias_lower LIKE
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
    console.error('[aliasResolver] Tier 1 lookup error:', err.message);
  }

  return { canonical: raw, business_id: null, tier: null };
}

module.exports = { resolveBusinessAlias };
