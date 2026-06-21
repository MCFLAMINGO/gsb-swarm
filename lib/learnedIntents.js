'use strict';
/**
 * lib/learnedIntents.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-healing intent layer. Every time the LLM fallback resolves a dead-end
 * query to a category, we record it here. On startup (and periodically) we
 * load the full table into memory so future identical/similar queries hit the
 * keyword map directly — no repeat LLM calls, no redeploys.
 *
 * Table: learned_intent_map
 *   query_normal  TEXT PRIMARY KEY  -- lowercased, trimmed, deduped
 *   category      TEXT NOT NULL     -- CAT_EXPAND key
 *   hit_count     INT  DEFAULT 1    -- how many times this mapping was confirmed
 *   last_seen     TIMESTAMPTZ
 *   source        TEXT              -- 'llm_fallback' | 'manual'
 */

const db = require('./db');

let _cache = new Map(); // query_normal → category
let _migrated = false;

async function migrate() {
  if (_migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS learned_intent_map (
      query_normal  TEXT PRIMARY KEY,
      category      TEXT NOT NULL,
      hit_count     INT  NOT NULL DEFAULT 1,
      last_seen     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      source        TEXT NOT NULL DEFAULT 'llm_fallback'
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS learned_intent_map_cat_idx ON learned_intent_map(category)`);
  _migrated = true;
}

// Normalize a query to a stable lookup key
function normalize(q) {
  return (q || '').toLowerCase().trim().replace(/\s+/g, ' ').slice(0, 120);
}

// Load all learned mappings into memory — called at startup and periodically
async function load() {
  try {
    await migrate();
    const rows = await db.query(`SELECT query_normal, category FROM learned_intent_map`);
    _cache = new Map(rows.map(r => [r.query_normal, r.category]));
    console.log(`[learnedIntents] loaded ${_cache.size} mappings`);
  } catch (e) {
    console.warn('[learnedIntents] load failed (non-fatal):', e.message);
  }
}

// Look up a query in the learned cache — returns category string or null
function lookup(query) {
  return _cache.get(normalize(query)) || null;
}

// Record a new mapping (LLM resolved it) — upsert + update cache immediately
// Valid top-level CAT_EXPAND keys — compound 'cat:subcat' strings from the
// service_request thread-context format must never be written to this table.
const VALID_CATS = new Set([
  'restaurant','pizza','cafe','bar','alcohol','grocery','retail','pharmacy','convenience',
  'hardware','furniture','clothes','jewelry','electronics','pet','florist','tattoo',
  'bakery','gas_station','hotel','bank','finance','real_estate','law_firm','accounting',
  'insurance','tax_advisor','financial_advisor','gym','healthcare','dental','dentist',
  'optician','veterinary','childcare','entertainment','museum','storage','moving',
  'auto_repair','auto_dealer','car_wash','car_rental','towing',
  'plumber','electrician','hvac','handyman','roofing','landscaping','painting','cleaning',
  'pest_control','locksmith','flooring','pool_service','general_contractor',
  'beauty_salon','spa','massage','barbershop','beauty',
]);

async function record(query, category, source = 'llm_fallback') {
  const key = normalize(query);
  if (!key || !category) return;
  // Reject compound 'cat:subcat' format and any value not in the valid CAT_EXPAND list
  if (category.includes(':') || !VALID_CATS.has(category)) {
    console.warn(`[learnedIntents] rejected invalid category "${category}" for query "${key}"`);
    return;
  }
  try {
    await migrate();
    await db.query(`
      INSERT INTO learned_intent_map (query_normal, category, hit_count, last_seen, source)
      VALUES ($1, $2, 1, NOW(), $3)
      ON CONFLICT (query_normal) DO UPDATE
        SET hit_count = learned_intent_map.hit_count + 1,
            last_seen = NOW(),
            category  = EXCLUDED.category
    `, [key, category, source]);
    _cache.set(key, category);
    console.log(`[learnedIntents] healed: "${key}" → ${category} (${source})`);
  } catch (e) {
    console.warn('[learnedIntents] record failed (non-fatal):', e.message);
  }
}

// Refresh cache every 10 minutes while server is running
function startAutoRefresh(intervalMs = 60 * 60 * 1000) { // 60min — was 10min, low-churn data
  setInterval(() => load().catch(() => {}), intervalMs);
}

module.exports = { load, lookup, record, startAutoRefresh, normalize };
