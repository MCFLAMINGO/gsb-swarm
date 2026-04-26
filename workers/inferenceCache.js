'use strict';
/**
 * inferenceCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Prompt → answer cache for the LocalIntel inference engine.
 *
 * Every time a vertical tool, oracle, or ask tool returns a result, the
 * answer is stored here keyed by a normalized prompt fingerprint. Next caller
 * with the same (or similar) intent gets an instant cache hit instead of
 * re-running the full tool chain.
 *
 * Cache structure per ZIP:
 *   data/inference/{zip}.json
 *   {
 *     "32082": {
 *       entries: [
 *         {
 *           fingerprint: "restaurant|gap|32082",
 *           query:       "what cuisine gaps exist in 32082",
 *           tool:        "local_intel_restaurant",
 *           zip:         "32082",
 *           vertical:    "restaurant",
 *           answer:      { ...full tool result },
 *           confidence:  82,
 *           hits:        4,
 *           created_at:  "2026-04-21T...",
 *           updated_at:  "2026-04-21T...",
 *           expires_at:  "2026-04-28T..."
 *         }
 *       ],
 *       meta: { total_entries: 1, avg_confidence: 82, last_sweep: "..." }
 *     }
 *   }
 *
 * TTL by confidence tier:
 *   HIGH  (≥70): 7 days  — solid data, stable
 *   MED   (40-69): 3 days — usable but watch for drift
 *   LOW   (<40):  6 hours — force refresh soon
 *
 * Similarity matching: fingerprint is built from vertical + top keywords,
 * so "where should I open a clinic" and "healthcare gaps in 32082" both
 * resolve to the same cache entry.
 */

const fs   = require('fs');
const path = require('path');

const DATA_DIR           = path.join(__dirname, '..', 'data');
const CACHE_DIR          = path.join(DATA_DIR, 'inference');
const ROUTER_LEARNING    = path.join(DATA_DIR, 'router_learning.json');
const LEARNED_RELOAD_MS  = 5 * 60 * 1000; // re-read every 5 min

// TTL in ms
const TTL = {
  HIGH: 7  * 24 * 60 * 60 * 1000,
  MED:  3  * 24 * 60 * 60 * 1000,
  LOW:  6  * 60 * 60 * 1000,
};

// ── Stop words for fingerprint normalization ──────────────────────────────────
const STOP = new Set([
  'a','an','the','in','on','at','for','of','to','is','are','do','does',
  'what','where','how','many','much','there','i','my','me','we','our',
  'should','would','could','will','can','want','looking','thinking','about',
  'open','start','launch','business','market','area','town','city','region',
  'northeast','florida','fl','county','zip','code',
]);

// ── Learned signal hot-reload ────────────────────────────────────────────────
// routerLearningWorker writes patches to data/router_learning.json.
// Because Node.js require() caches modules, file-level patches to this file
// are invisible to a running process. Instead we read the JSON at runtime
// and merge learned terms into _learnedSignals, which detectVertical() checks
// FIRST before falling back to the hardcoded VERTICAL_SIGNALS regexes below.

let _learnedSignals   = {};  // { vertical: Set<string> }
let _lastLearnedLoad  = 0;

async function loadLearnedSignalsFromPostgres() {
  try {
    const pgStore = require('../lib/pgStore');
    const patches = await pgStore.getRouterPatches();
    const next = {};
    for (const [vertical, terms] of Object.entries(patches)) {
      if (!Array.isArray(terms)) continue;
      next[vertical] = new Set(terms.map(t => t.toLowerCase()));
    }
    if (Object.keys(next).length) {
      _learnedSignals = next;
      console.log('[inferenceCache] Loaded', Object.values(next).reduce((s,v) => s + v.size, 0), 'learned terms from Postgres');
    }
  } catch (_) {}
}

function loadLearnedSignals() {
  const now = Date.now();
  if (now - _lastLearnedLoad < LEARNED_RELOAD_MS) return; // throttle
  _lastLearnedLoad = now;
  // Try local file first (fast path), then Postgres
  try {
    const raw = JSON.parse(fs.readFileSync(ROUTER_LEARNING, 'utf8'));
    const next = {};
    for (const patch of (raw.patches || [])) {
      if (!patch.vertical || !Array.isArray(patch.terms)) continue;
      if (!next[patch.vertical]) next[patch.vertical] = new Set();
      for (const t of patch.terms) next[patch.vertical].add(t.toLowerCase());
    }
    _learnedSignals = next;
  } catch (_) {
    // file doesn't exist — load from Postgres
    loadLearnedSignalsFromPostgres().catch(() => {});
  }
}

// Kick off first load immediately
loadLearnedSignals();
// Also load from Postgres on boot (Railway restart wipes local file)
loadLearnedSignalsFromPostgres().catch(() => {});
// Refresh on interval so the module stays current without a restart
setInterval(loadLearnedSignals, LEARNED_RELOAD_MS).unref();

// Vertical keyword signals — used to detect vertical from free-text query
const VERTICAL_SIGNALS = {
  restaurant:   /restaurant|dining|cafe|food|cuisine|eatery|bar|brewery|coffeehouse|diner|ramen|sushi|pizza|bbq|seafood|food.truck|ghost.kitchen|breakfast|lunch|dinner|daypart|franchise.food/i,
  healthcare:   /clinic|healthcare|health|medical|doctor|physician|dentist|dental|urgent.care|therapy|mental.health|optometry|pediatric|senior.care|nursing|pharmacy|patient|provider|hospital/i,
  retail:       /retail|store|shop|boutique|shopping|consumer|merchandise|ecommerce|fashion|apparel|grocery|convenience|hardware|sporting|pet.supply|home.goods/i,
  construction: /construction|contractor|builder|permit|develop|remodel|renovation|roofing|hvac|plumbing|electrical|deck|pool|foundation|flood.remediation|home.improvement/i,
  realtor:      /realtor|real.estate|property|home.value|listing|buyer|seller|invest|rental|vacancy|zoning|appreciation|neighborhood|condo|single.family|commercial.real/i,
};

// Geographic signals for ZIP resolution
const GEO_SIGNALS = [
  { pattern: /ponte.vedra/i,           zip: '32082' },
  { pattern: /nocatee/i,               zip: '32081' },
  { pattern: /world.golf|wgv/i,        zip: '32092' },
  { pattern: /st\..?augustine.beach/i, zip: '32080' },
  { pattern: /st\..?augustine.south/i, zip: '32086' },
  { pattern: /st\..?augustine/i,       zip: '32084' },
  { pattern: /palm.valley/i,           zip: '32095' },
  { pattern: /fruit.cove|saint.johns/i,zip: '32259' },
  { pattern: /jax.?beach|jacksonville.beach/i, zip: '32250' },
  { pattern: /neptune.beach/i,         zip: '32266' },
  { pattern: /bartram/i,               zip: '32258' },
  { pattern: /atlantic.beach/i,        zip: '32233' },
  { pattern: /fernandina/i,            zip: '32034' },
  { pattern: /yulee/i,                 zip: '32097' },
  { pattern: /orange.park/i,           zip: '32073' },
  { pattern: /fleming.island/i,        zip: '32003' },
  { pattern: /baymeadows|tinseltown/i, zip: '32256' },
  { pattern: /mandarin/i,              zip: '32257' },
  { pattern: /southside/i,             zip: '32216' },
  { pattern: /san.jose/i,              zip: '32217' },
  { pattern: /southbank/i,             zip: '32207' },
  { pattern: /arlington/i,             zip: '32225' },
  { pattern: /regency/i,               zip: '32246' },
  { pattern: /\b(\d{5})\b/,           zip: null }, // literal ZIP passthrough
];

// Default ZIP fallback if no geo signal found
const DEFAULT_ZIP = '32082';

// ── Utility ───────────────────────────────────────────────────────────────────

function ensureDir() {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
}

function cacheFile(zip) {
  return path.join(CACHE_DIR, `${zip}.json`);
}

function loadCache(zip) {
  try {
    return JSON.parse(fs.readFileSync(cacheFile(zip), 'utf8'));
  } catch (_) {
    return { entries: [], meta: { total_entries: 0, avg_confidence: 0, last_sweep: null } };
  }
}

function saveCache(zip, data) {
  ensureDir();
  const tmp = cacheFile(zip) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, cacheFile(zip));
}

function confidenceTier(score) {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MED';
  return 'LOW';
}

function ttlMs(score) {
  return TTL[confidenceTier(score)];
}

// ── Fingerprint builder ───────────────────────────────────────────────────────
// Produces a stable key from query + vertical + zip.
// "where should I open a ramen shop in 32082" → "restaurant|ramen|gap|32082"

function buildFingerprint(query, vertical, zip) {
  const tokens = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t))
    .slice(0, 6); // top 6 content words
  return [vertical, ...tokens, zip].join('|');
}

// Similarity: what fraction of fingerprint tokens overlap
function fingerprintSimilarity(fpA, fpB) {
  const tokA = new Set(fpA.split('|'));
  const tokB = new Set(fpB.split('|'));
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

// ── Vertical detection ────────────────────────────────────────────────────────

function detectVertical(query) {
  // 1. Check learned signals first — they reflect runtime improvements
  loadLearnedSignals(); // no-op if within throttle window
  const lower = query.toLowerCase();
  for (const [vertical, termSet] of Object.entries(_learnedSignals)) {
    for (const term of termSet) {
      if (lower.includes(term)) return vertical;
    }
  }
  // 2. Fall back to hardcoded regex patterns
  for (const [v, pattern] of Object.entries(VERTICAL_SIGNALS)) {
    if (pattern.test(query)) return v;
  }
  return null;
}

// ── ZIP detection ─────────────────────────────────────────────────────────────

function detectZip(query) {
  // Literal 5-digit ZIP takes priority
  const literalMatch = query.match(/\b(\d{5})\b/);
  if (literalMatch) return literalMatch[1];

  // Named place lookup
  for (const sig of GEO_SIGNALS) {
    if (sig.zip && sig.pattern.test(query)) return sig.zip;
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * get(query, vertical, zip) → cache entry or null
 * Returns a valid (non-expired) cache hit if similarity >= threshold.
 */
function get(query, vertical, zip) {
  if (!zip) return null;
  const cache  = loadCache(zip);
  const fp     = buildFingerprint(query, vertical, zip);
  const now    = Date.now();

  let best = null;
  let bestSim = 0;

  for (const entry of cache.entries) {
    // Expired?
    if (new Date(entry.expires_at).getTime() < now) continue;
    // Wrong vertical?
    if (entry.vertical !== vertical) continue;

    const sim = fingerprintSimilarity(fp, entry.fingerprint);
    if (sim > bestSim) {
      bestSim = sim;
      best    = entry;
    }
  }

  // Require ≥50% token overlap to count as a hit
  if (bestSim >= 0.5 && best) {
    best.hits = (best.hits || 0) + 1;
    best.last_hit = new Date().toISOString();
    saveCache(zip, cache); // persist hit count
    return { ...best, cache_hit: true, similarity: bestSim };
  }

  return null;
}

/**
 * set(query, vertical, zip, tool, answer, confidence)
 * Stores a prompt→answer pair. Upserts if fingerprint already exists.
 */
function set(query, vertical, zip, tool, answer, confidence) {
  if (!zip) return;
  ensureDir();

  const cache = loadCache(zip);
  const fp    = buildFingerprint(query, vertical, zip);
  const now   = new Date();
  const exp   = new Date(now.getTime() + ttlMs(confidence));

  // Upsert
  const idx = cache.entries.findIndex(e => e.fingerprint === fp);
  const entry = {
    fingerprint: fp,
    query,
    tool,
    zip,
    vertical,
    answer,
    confidence,
    hits:        idx >= 0 ? (cache.entries[idx].hits || 0) : 0,
    created_at:  idx >= 0 ? cache.entries[idx].created_at : now.toISOString(),
    updated_at:  now.toISOString(),
    expires_at:  exp.toISOString(),
    ttl_tier:    confidenceTier(confidence),
  };

  if (idx >= 0) {
    cache.entries[idx] = entry;
  } else {
    cache.entries.push(entry);
  }

  // Update meta
  const valid = cache.entries.filter(e => new Date(e.expires_at).getTime() > Date.now());
  cache.meta = {
    total_entries:  valid.length,
    avg_confidence: valid.length
      ? Math.round(valid.reduce((s, e) => s + (e.confidence || 0), 0) / valid.length)
      : 0,
    last_sweep: now.toISOString(),
  };

  // Evict expired
  cache.entries = valid;

  saveCache(zip, cache);
}

/**
 * invalidate(zip, vertical) — force-expire all entries for a ZIP+vertical.
 * Called by scout agent after enrichment fills a gap.
 */
function invalidate(zip, vertical) {
  if (!zip) return;
  const cache = loadCache(zip);
  const past  = new Date(0).toISOString();
  cache.entries = cache.entries.map(e => {
    if (!vertical || e.vertical === vertical) return { ...e, expires_at: past };
    return e;
  });
  saveCache(zip, cache);
}

/**
 * stats() — aggregate cache health across all ZIPs
 */
function stats() {
  ensureDir();
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.endsWith('.json'));
  let total = 0, hits = 0, expired = 0, highConf = 0;
  const now = Date.now();

  for (const f of files) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), 'utf8'));
      for (const e of (c.entries || [])) {
        total++;
        hits    += (e.hits || 0);
        if (new Date(e.expires_at).getTime() < now) expired++;
        if ((e.confidence || 0) >= 70) highConf++;
      }
    } catch (_) {}
  }

  return { total_entries: total, total_hits: hits, expired, high_confidence: highConf, zips_cached: files.length };
}

module.exports = { get, set, invalidate, stats, detectVertical, detectZip, buildFingerprint };
