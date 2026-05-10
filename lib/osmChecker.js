'use strict';
/**
 * osmChecker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Per-business OSM completeness audit.
 *
 * What it does:
 *   1. Given a business (name + lat/lon or existing osm_node_id), find its
 *      exact OSM node/way via Nominatim + Overpass.
 *   2. Inspect that node's tags for the 4 fields that matter most for
 *      SEO and agentic discoverability: phone, website, opening_hours, email.
 *   3. Return a completeness report with:
 *      - which fields are present / missing
 *      - a direct OSM edit URL pre-scoped to that node
 *      - a human-readable score (0-4)
 *   4. Persist osm_node_id + osm_missing_fields + osm_last_checked to
 *      businesses table so the inbox.html card is always fresh.
 *
 * Rate limits:
 *   - Nominatim: 1 req/s (OSM ToS)
 *   - Overpass:  1 req/2.2s (public endpoint policy)
 *
 * All HTTP calls are deterministic — no LLM, no paid API.
 */

const https = require('https');
const db    = require('./db');

// ── Constants ─────────────────────────────────────────────────────────────────
const NOMINATIM_UA  = 'LocalIntel/1.0 (thelocalintel.com; contact=erik@mcflamingo.com)';
const OVERPASS_URL  = 'https://overpass-api.de/api/interpreter';
const OSM_EDIT_BASE = 'https://www.openstreetmap.org/edit';

// Fields we care about for discoverability — ordered by importance
const TRACKED_FIELDS = ['phone', 'website', 'opening_hours', 'email'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': NOMINATIM_UA,
        'Accept':     'application/json',
        ...headers,
      },
    };
    const req = https.get(url, opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`JSON parse fail: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('timeout')); });
  });
}

function overpassPost(query) {
  return new Promise((resolve, reject) => {
    const body = `data=${encodeURIComponent(query)}`;
    const opts = {
      method : 'POST',
      headers: {
        'Content-Type'  : 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent'    : NOMINATIM_UA,
      },
    };
    const req = https.request(OVERPASS_URL, opts, res => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`Overpass ${res.statusCode}`));
        try { resolve(JSON.parse(raw)); }
        catch (e) { reject(new Error(`Overpass JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('Overpass timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Step 1: Nominatim — find the OSM element ID closest to known coordinates ──
/**
 * nominatimLookup(name, lat, lon)
 * Returns { osm_type, osm_id } or null.
 *
 * Strategy: structured search near coordinates, then fallback to free-text.
 * Nominatim's "viewbox" biases results toward the business's known location.
 */
async function nominatimLookup(name, lat, lon) {
  // Tight viewbox ~500m around the known coordinates
  const delta = 0.005; // ~550m
  const viewbox = `${lon - delta},${lat - delta},${lon + delta},${lat + delta}`;
  const q = encodeURIComponent(name);

  // Try structured query first (more precise)
  const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=3&bounded=1&viewbox=${viewbox}&addressdetails=0&extratags=1`;

  let results;
  try {
    results = await httpsGet(url);
  } catch (e) {
    console.warn('[osmChecker] Nominatim error:', e.message);
    return null;
  }

  if (!results?.length) {
    // Fallback: unbounded search near lat/lon — broader but catches more
    const fallbackUrl = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=3&lat=${lat}&lon=${lon}&addressdetails=0`;
    try {
      results = await httpsGet(fallbackUrl);
    } catch (e) {
      console.warn('[osmChecker] Nominatim fallback error:', e.message);
      return null;
    }
  }

  if (!results?.length) return null;

  // Pick the result whose reported lat/lon is closest to ours
  let best = null, bestDist = Infinity;
  for (const r of results) {
    const dlat = parseFloat(r.lat) - lat;
    const dlon = parseFloat(r.lon) - lon;
    const dist = Math.sqrt(dlat * dlat + dlon * dlon);
    if (dist < bestDist) { bestDist = dist; best = r; }
  }

  if (!best) return null;

  return {
    osm_type: best.osm_type, // 'node' | 'way' | 'relation'
    osm_id  : parseInt(best.osm_id, 10),
    display  : best.display_name,
    lat      : parseFloat(best.lat),
    lon      : parseFloat(best.lon),
  };
}

// ── Step 2: Overpass — fetch the actual OSM element tags ─────────────────────
/**
 * fetchOsmTags(osm_type, osm_id)
 * Returns the raw tag object for the element, or null.
 */
async function fetchOsmTags(osm_type, osm_id) {
  // Map Nominatim type → Overpass element type
  const elType = osm_type === 'relation' ? 'relation'
               : osm_type === 'way'      ? 'way'
               :                           'node';

  const query = `[out:json][timeout:15];\n${elType}(${osm_id});\nout tags;`;
  try {
    const result = await overpassPost(query);
    const el = result?.elements?.[0];
    return el?.tags || null;
  } catch (e) {
    console.warn(`[osmChecker] Overpass fetch failed for ${elType}/${osm_id}:`, e.message);
    return null;
  }
}

// ── Step 3: Build completeness report ────────────────────────────────────────
/**
 * buildReport(tags, osm_type, osm_id, bizTags)
 * bizTags = what LocalIntel already has (phone, website, hours)
 *
 * Returns the completeness report object for the API + inbox card.
 */
function buildReport(tags, osm_type, osm_id, bizTags = {}) {
  const present = [];
  const missing = [];

  // For each tracked field, check OSM tags (using common aliases)
  const fieldAliases = {
    phone        : ['phone', 'contact:phone', 'phone:1'],
    website      : ['website', 'contact:website', 'url'],
    opening_hours: ['opening_hours'],
    email        : ['email', 'contact:email'],
  };

  for (const field of TRACKED_FIELDS) {
    const aliases = fieldAliases[field] || [field];
    const inOsm   = tags && aliases.some(a => tags[a]);
    // Also count if LocalIntel has it (for display hint — but OSM still needs it)
    const inBiz   = field === 'phone'         ? !!bizTags.phone
                  : field === 'website'        ? !!bizTags.website
                  : field === 'opening_hours'  ? !!bizTags.hours
                  : false;

    if (inOsm) {
      present.push({ field, value: aliases.map(a => tags[a]).find(Boolean) });
    } else {
      missing.push({ field, label: fieldLabel(field), hint: fieldHint(field, inBiz, bizTags) });
    }
  }

  const score = present.length; // 0-4

  // Direct edit URL — scoped to the exact node/way
  let editUrl;
  if (osm_type && osm_id) {
    editUrl = `${OSM_EDIT_BASE}?${osm_type}=${osm_id}`;
  } else {
    // Fallback: open editor at business coordinates (caller should pass lat/lon)
    editUrl = OSM_EDIT_BASE;
  }

  return { score, total: TRACKED_FIELDS.length, present, missing, editUrl, osm_type, osm_id };
}

function fieldLabel(field) {
  return {
    phone        : 'Phone number',
    website      : 'Website URL',
    opening_hours: 'Opening hours',
    email        : 'Email address',
  }[field] || field;
}

function fieldHint(field, inBiz, bizTags) {
  if (field === 'phone' && bizTags.phone)
    return `We have ${bizTags.phone} — add it to OSM so Google and Siri find it.`;
  if (field === 'website' && bizTags.website)
    return `We have ${bizTags.website} — add it to OSM so agents can route orders.`;
  if (field === 'opening_hours' && bizTags.hours)
    return `We have your hours — add them to OSM so customers find you when you're open.`;
  return {
    phone        : 'A phone number makes you 3× more likely to appear in local search.',
    website      : 'Without a website link, AI agents cannot route customers directly to you.',
    opening_hours: 'Missing hours means Siri and Google assume you\'re closed.',
    email        : 'An email lets agents send booking confirmations and follow-ups.',
  }[field] || 'Missing — add it to OSM.';
}

// ── Step 4: Persist to Postgres ───────────────────────────────────────────────
async function persistResult(businessId, osmInfo, report) {
  try {
    await db.query(
      `UPDATE businesses
         SET osm_node_id       = $1,
             osm_node_type     = $2,
             osm_last_checked  = NOW(),
             osm_missing_fields = $3
       WHERE business_id = $4`,
      [
        osmInfo?.osm_id   || null,
        osmInfo?.osm_type || null,
        report.missing.map(m => m.field),
        businessId,
      ]
    );
  } catch (e) {
    console.warn('[osmChecker] persist failed:', e.message);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * checkBusiness({ business_id, name, lat, lon, phone, website, hours })
 *
 * Full pipeline: Nominatim → Overpass → completeness report → persist.
 * Returns the report. Safe to call from the API route.
 *
 * If the business already has an osm_node_id stored, skips Nominatim and
 * goes straight to Overpass (faster, avoids rate limits).
 */
async function checkBusiness(biz) {
  const { business_id, name, lat, lon, phone, website, hours } = biz;

  if (!name || lat == null || lon == null) {
    // Can't look up without coordinates — return null report
    return {
      score: null, total: TRACKED_FIELDS.length,
      missing: [], present: [],
      editUrl: OSM_EDIT_BASE,
      error: 'missing_coordinates',
    };
  }

  // Check if we already have the OSM node ID cached
  let osmInfo = null;
  if (biz.osm_node_id && biz.osm_node_type) {
    osmInfo = { osm_id: biz.osm_node_id, osm_type: biz.osm_node_type };
  } else {
    // Rate-limit: Nominatim asks for 1 req/s
    await sleep(1100);
    osmInfo = await nominatimLookup(name, lat, lon);
  }

  let tags = null;
  if (osmInfo?.osm_id) {
    await sleep(2200); // Overpass rate limit
    tags = await fetchOsmTags(osmInfo.osm_type, osmInfo.osm_id);
  }

  const report = buildReport(tags, osmInfo?.osm_type, osmInfo?.osm_id, { phone, website, hours });

  // Persist to Postgres (non-blocking for caller)
  if (business_id) {
    persistResult(business_id, osmInfo, report).catch(() => {});
  }

  return report;
}

/**
 * storeOsmNodeId(businessId, osm_type, osm_id)
 * Called by overpassWorker at promote time — stores the node ID we just used
 * so osmChecker can skip Nominatim on subsequent checks.
 */
async function storeOsmNodeId(businessId, osm_type, osm_id) {
  if (!businessId || !osm_id) return;
  try {
    await db.query(
      `UPDATE businesses
         SET osm_node_id  = $1,
             osm_node_type = $2
       WHERE business_id = $3
         AND osm_node_id IS NULL`,
      [osm_id, osm_type, businessId]
    );
  } catch (e) {
    console.warn('[osmChecker] storeOsmNodeId failed:', e.message);
  }
}

module.exports = { checkBusiness, storeOsmNodeId, buildReport, nominatimLookup, fetchOsmTags };
