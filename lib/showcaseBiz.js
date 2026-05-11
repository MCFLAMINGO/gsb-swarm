'use strict';
/**
 * lib/showcaseBiz.js
 * Fetches all is_showcase businesses once (cached in-process, refreshed every 10 min).
 * Used to inject showcase businesses into every ZIP search result.
 */
const db = require('./db');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getShowcaseBusinesses() {
  const now = Date.now();
  if (_cache && (now - _cacheTs) < CACHE_TTL_MS) return _cache;
  try {
    _cache = await db.query(
      `SELECT business_id, name, address, city, zip, phone, website,
              hours, category, category_group, tags, description, cuisine,
              confidence_score, lat, lon, claimed_at IS NOT NULL AS claimed,
              wallet, pos_config->>'pos_type' AS pos_type,
              1 AS has_wallet, TRUE AS is_showcase
         FROM businesses
        WHERE is_showcase = TRUE AND status != 'inactive'
        ORDER BY confidence_score DESC`
    );
    _cacheTs = now;
  } catch (err) {
    console.error('[showcaseBiz] fetch error:', err.message);
    _cache = _cache || []; // keep stale cache on error
  }
  return _cache;
}

/**
 * Inject showcase businesses into a results array.
 * Rules:
 * - Only inject if query has no cuisine filter OR showcase biz matches that cuisine
 * - Showcase biz always goes to position 0 (first result)
 * - Never duplicate if already in results
 */
async function injectShowcase(results, cuisineFilter) {
  const showcase = await getShowcaseBusinesses();
  if (!showcase.length) return results;

  const toInject = showcase.filter(s => {
    if (results.some(r => r.business_id === s.business_id)) return false;
    if (cuisineFilter) {
      const cf = cuisineFilter.toLowerCase();
      const matches =
        (s.cuisine && s.cuisine.toLowerCase().includes(cf)) ||
        (s.category && s.category.toLowerCase().includes(cf)) ||
        (s.description && s.description.toLowerCase().includes(cf)) ||
        (s.tags && s.tags.some && s.tags.some(t => t.toLowerCase().includes(cf)));
      if (!matches) return false;
    }
    return true;
  });

  if (!toInject.length) return results;
  return [...toInject, ...results];
}

module.exports = { getShowcaseBusinesses, injectShowcase };
