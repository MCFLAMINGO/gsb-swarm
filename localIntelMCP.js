'use strict';
/**
 * LocalIntel MCP Server — GSB Swarm
 *
 * Implements the Model Context Protocol (MCP) JSON-RPC 2.0 spec.
 * Agents (Claude, GPT, Cursor, etc.) connect via HTTP POST to /mcp
 * and call tools to query the SJC business + zone dataset.
 *
 * Tools exposed:
 *   local_intel_context     — spatial context block for a zip or lat/lon
 *   local_intel_search      — search businesses by name/category/zip
 *   local_intel_nearby      — businesses within radius of a lat/lon point
 *   local_intel_zone        — spending zone + demographic data for a zip
 *   local_intel_corridor    — businesses along a named street corridor
 *   local_intel_changes     — recently added/claimed/updated listings
 *   local_intel_stats       — dataset coverage stats
 *
 * Billing: each tool call logs to usage_ledger.json for future ACP billing.
 * Port: 3004 (internal Railway port, proxied via /api/mcp on port 3001)
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_PATH    = path.join(__dirname, 'data', 'localIntel.json');
const ZIPS_DIR_MCP = path.join(__dirname, 'data', 'zips');
const ZONES_PATH   = path.join(__dirname, 'data', 'spendingZones.json');
const LEDGER_PATH  = path.join(__dirname, 'data', 'usageLedger.json');
const PORT         = parseInt(process.env.LOCAL_INTEL_MCP_PORT || '3004');

// ── Cost per tool call (pathUSD) ──────────────────────────────────────────────
// ── Tidal tools ──────────────────────────────────────────────────────────────
const { handleTide, handleSignal, handleBedrock, handleForAgent, handleAsk } = require('./localIntelTidalTools');
const { handleVerticalQuery } = require('./workers/verticalAgentWorker');

// ── Oracle handler ─────────────────────────────────────────────────────────────
function handleOracle(params) {
  const zip = (params.zip || '').replace(/\D/g, '').slice(0, 5);
  if (!zip) return { error: 'zip required' };
  const oracleDir = path.join(__dirname, 'data', 'oracle');
  const file = path.join(oracleDir, `${zip}.json`);
  if (!require('fs').existsSync(file)) {
    return { error: `Oracle not yet computed for ${zip}. The oracle worker runs every 6h — try again shortly.` };
  }
  return require('fs').readFileSync(file, 'utf8');
}
const { wrapMCPHandler } = require('./workers/mcpMiddleware');
const { getStaleness, stalenessBlock, zipFreshnessBlock } = require('./workers/stalenessUtils');

const TOOL_COSTS = {
  local_intel_context:   0.02,
  local_intel_search:    0.01,
  local_intel_nearby:    0.02,
  local_intel_zone:      0.01,
  local_intel_corridor:  0.02,
  local_intel_changes:   0.01,
  // Tidal layer tools
  local_intel_tide:      0.02,
  local_intel_signal:    0.03,
  local_intel_bedrock:   0.02,
  local_intel_for_agent: 0.05,
  local_intel_oracle:    0.03,
  local_intel_realtor:      0.02,
  local_intel_healthcare:   0.02,
  local_intel_retail:       0.02,
  local_intel_construction: 0.02,
  local_intel_restaurant:   0.02,
  local_intel_ask:          0.05,
  local_intel_stats:    0.005,
};

// ── Data loaders ──────────────────────────────────────────────────────────────
function loadBusinesses() {
  // Merge seed file + all accumulated zip files for the full dataset
  const seen  = new Map(); // key -> index in all[]
  const all   = [];
  const addBiz = (b) => {
    const name = (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const zip  = b.zip || '';
    // Primary key: normalized name + zip (catches same biz from OSM vs YP)
    // Secondary: if lat/lon present use them to further disambiguate chains
    const addrNorm = (b.address || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const key = `${name}|${zip}|${addrNorm}`;
    if (seen.has(key)) {
      // Keep higher-confidence record
      const existingIdx = seen.get(key);
      if ((b.confidence || 0) > (all[existingIdx].confidence || 0)) {
        all[existingIdx] = b;
      }
    } else {
      seen.set(key, all.length);
      all.push(b);
    }
  };
  try { JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).forEach(addBiz); } catch {}
  try {
    if (fs.existsSync(ZIPS_DIR_MCP)) {
      fs.readdirSync(ZIPS_DIR_MCP).filter(f => f.endsWith('.json')).forEach(f => {
        try { JSON.parse(fs.readFileSync(path.join(ZIPS_DIR_MCP, f), 'utf8')).forEach(addBiz); } catch {}
      });
    }
  } catch {}
  return all;
}
function loadZones() {
  try { return JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); } catch { return {}; }
}
function logUsage(tool, caller, meta) {
  try {
    const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch { return []; } })();
    const entry = {
      tool,
      caller:  caller || 'unknown',
      entry:   meta?.entry   || 'free',
      cost:    TOOL_COSTS[tool] || 0,
      paid:    false,
      ts:      new Date().toISOString(),
    };
    if (meta?.zip)     entry.zip     = meta.zip;
    if (meta?.intent)  entry.intent  = meta.intent;
    if (meta?.latency) entry.latency = meta.latency;
    ledger.push(entry);
    if (ledger.length > 10000) ledger.splice(0, ledger.length - 10000);
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch {}
}

// ── Haversine distance (miles) ────────────────────────────────────────────────
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Category grouper ──────────────────────────────────────────────────────────
const CAT_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','alcohol'],
  retail:   ['supermarket','convenience','clothes','hairdresser','beauty','chemist',
             'mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre',
             'sports_centre','swimming_pool'],
  finance:  ['bank','atm','estate_agent','insurance','accountant'],
  civic:    ['school','place_of_worship','church','library','post_office',
             'police','fire_station','community_centre','social_centre'],
  services: ['fuel','car_wash','car_repair','hotel','office','coworking'],
};
function getGroup(cat) {
  for (const [g, cats] of Object.entries(CAT_GROUPS)) {
    if (cats.includes(cat)) return g;
  }
  return 'other';
}

// ── ZIP centroids ─────────────────────────────────────────────────────────────
const ZIP_CENTERS = {
  '32082': { lat: 30.1893, lon: -81.3815, label: 'Ponte Vedra Beach' },
  '32081': { lat: 30.1100, lon: -81.4175, label: 'Nocatee' },
};

// ── Compass bearing label ─────────────────────────────────────────────────────
function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(brng / 45) % 8];
}

// ── Format a business as a compact agent-readable line ────────────────────────
function fmtBusiness(b, refLat, refLon) {
  const parts = [`${b.name} [${b.category}]`];
  if (b.address) parts.push(b.address);
  if (refLat && refLon && b.lat && b.lon) {
    const d = distanceMiles(refLat, refLon, b.lat, b.lon);
    const dir = bearing(refLat, refLon, b.lat, b.lon);
    parts.push(`${d.toFixed(2)}mi ${dir}`);
  }
  if (b.phone) parts.push(`ph:${b.phone}`);
  if (b.hours) parts.push(`hours:${b.hours}`);
  if (b.website) parts.push(`web:${b.website}`);
  const conf = b.confidence >= 90 ? '' : ` | conf:${b.confidence}`;
  const claimed = b.claimed ? ' | owner_verified' : '';
  return `  ${parts.join(' · ')}${conf}${claimed}`;
}

// ── TOOL IMPLEMENTATIONS ──────────────────────────────────────────────────────

/**
 * local_intel_context
 * Returns a full spatial context block for a zip code or lat/lon.
 * This is the primary tool — gives an agent everything it needs in one call.
 */
function toolContext({ zip, lat, lon, radius_miles = 1.0 }) {
  const businesses = loadBusinesses();
  const zones = loadZones();

  // Resolve center point
  let centerLat, centerLon, label;
  if (lat && lon) {
    centerLat = parseFloat(lat);
    centerLon = parseFloat(lon);
    // Find nearest zip
    const nearestZip = Object.entries(ZIP_CENTERS)
      .sort((a, b) => distanceMiles(centerLat, centerLon, a[1].lat, a[1].lon) -
                      distanceMiles(centerLat, centerLon, b[1].lat, b[1].lon))[0];
    zip = nearestZip[0];
    label = nearestZip[1].label;
  } else if (zip && ZIP_CENTERS[zip]) {
    centerLat = ZIP_CENTERS[zip].lat;
    centerLon = ZIP_CENTERS[zip].lon;
    label = ZIP_CENTERS[zip].label;
  } else {
    return { error: `ZIP ${zip} not in covered dataset. Covered: ${Object.keys(ZIP_CENTERS).join(', ')}` };
  }

  // Find anchor (highest confidence business near center)
  const zoneBusinesses = businesses.filter(b => b.zip === zip && b.lat && b.lon);
  const anchor = zoneBusinesses
    .filter(b => b.claimed || b.confidence >= 90)
    .sort((a, b) => b.confidence - a.confidence)[0] ||
    zoneBusinesses.sort((a, b) => b.confidence - a.confidence)[0];

  // Bucket by distance rings
  const rings = [0.25, 0.5, 1.0, radius_miles];
  const ringLabels = ['0.25mi', '0.5mi', '1.0mi', `${radius_miles}mi`];
  const bucketed = {};
  rings.forEach(r => bucketed[r] = []);

  for (const b of zoneBusinesses) {
    if (b === anchor) continue;
    const d = distanceMiles(centerLat, centerLon, b.lat, b.lon);
    if (d > radius_miles) continue;
    const ring = rings.find(r => d <= r);
    if (ring) bucketed[ring].push({ ...b, _dist: d });
  }

  // Zone data
  const zoneData = zones.zones?.[zip] || {};

  // Build context block
  const lines = [];
  lines.push(`LOCATION CONTEXT: ${zip} · ${label}, FL`);
  lines.push(`CENTER: ${centerLat}, ${centerLon}`);
  lines.push('');

  if (anchor) {
    lines.push(`ANCHOR: ${anchor.name} [${anchor.category}] ${anchor.address || ''}`);
    lines.push(`  → ${distanceMiles(centerLat, centerLon, anchor.lat, anchor.lon).toFixed(2)}mi from center | confidence:${anchor.confidence}${anchor.claimed ? ' | owner_verified' : ''}`);
    lines.push('');
  }

  let prevMax = 0;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    const bucket = bucketed[r];
    if (!bucket.length) continue;
    const sorted = bucket.sort((a, b) => a._dist - b._dist);
    const label2 = prevMax === 0 ? `WITHIN ${ringLabels[i]}` : `${ringLabels[prevMax > 0 ? i-1 : i]}–${ringLabels[i]}`;
    lines.push(`${label2} (${bucket.length} businesses):`);
    for (const b of sorted.slice(0, 8)) {
      lines.push(fmtBusiness(b, centerLat, centerLon));
    }
    if (sorted.length > 8) lines.push(`  ... +${sorted.length - 8} more`);
    lines.push('');
    prevMax = i;
  }

  // Zone intelligence
  if (Object.keys(zoneData).length) {
    lines.push('ZONE INTELLIGENCE:');
    if (zoneData.population)       lines.push(`  Pop: ${zoneData.population.toLocaleString()}`);
    if (zoneData.median_income)    lines.push(`  Med Income: $${zoneData.median_income.toLocaleString()}`);
    if (zoneData.median_home_value) lines.push(`  Home Value: $${zoneData.median_home_value.toLocaleString()}`);
    if (zoneData.ownership_rate)   lines.push(`  Ownership: ${zoneData.ownership_rate}%`);
    if (zoneData.zone_score)       lines.push(`  Zone Score: ${zoneData.zone_score} ${zoneData.zone_label || ''}`);
    if (zoneData.dominant_spend)   lines.push(`  Dominant spend: ${zoneData.dominant_spend}`);
    lines.push('');
  }

  // Category summary
  const catCounts = {};
  for (const b of zoneBusinesses) {
    const g = getGroup(b.category);
    catCounts[g] = (catCounts[g] || 0) + 1;
  }
  lines.push('CATEGORY BREAKDOWN:');
  for (const [g, count] of Object.entries(catCounts).sort((a,b) => b[1]-a[1])) {
    lines.push(`  ${g}: ${count}`);
  }
  lines.push('');
  lines.push(`DATASET: ${zoneBusinesses.length} businesses indexed | sources: OSM, owner_verified | last_sync: 2026-04-20`);

  return {
    zip,
    label,
    center: { lat: centerLat, lon: centerLon },
    total_businesses: zoneBusinesses.length,
    context_block: lines.join('\n'),
    data_freshness: zipFreshnessBlock(zoneBusinesses),
  };
}

/**
 * local_intel_search
 * Search businesses by name, category, or group within a zip.
 */
// ── Query normalizer — handles plurals, aliases, common shorthand ─────────────
const QUERY_ALIASES = {
  // Food
  'restaurants': 'restaurant', 'dining': 'restaurant', 'food': 'restaurant',
  'eats': 'restaurant', 'eateries': 'restaurant', 'eatery': 'restaurant',
  'cafes': 'cafe', 'coffee': 'cafe', 'coffee shop': 'cafe', 'coffee shops': 'cafe',
  'bars': 'bar', 'pubs': 'bar', 'pub': 'bar',
  'fast food': 'fast_food', 'fastfood': 'fast_food',
  'pizza': 'restaurant', 'sushi': 'restaurant', 'tacos': 'restaurant',
  // Health
  'dentists': 'dentist', 'doctors': 'clinic', 'doctor': 'clinic',
  'clinics': 'clinic', 'medical': 'clinic', 'vet': 'veterinary', 'vets': 'veterinary',
  'gym': 'fitness_centre', 'gyms': 'fitness_centre', 'fitness': 'fitness_centre',
  // Retail
  'grocery': 'supermarket', 'groceries': 'supermarket', 'supermarkets': 'supermarket',
  'convenience stores': 'convenience', 'gas': 'fuel', 'gas station': 'fuel', 'gas stations': 'fuel',
  'pharmacy': 'chemist', 'pharmacies': 'chemist', 'drug store': 'chemist',
  'salons': 'hairdresser', 'salon': 'hairdresser', 'hair': 'hairdresser',
  'beauty': 'hairdresser', 'nail': 'hairdresser',
  // Finance / Services
  'banks': 'bank', 'atms': 'atm',
  'realtors': 'estate_agent', 'realtor': 'estate_agent', 'real estate': 'estate_agent',
  'real estate agents': 'estate_agent', 'real estate agent': 'estate_agent',
  'mortgage': 'finance', 'mortgage lenders': 'finance', 'lenders': 'finance',
  'lawyers': 'legal', 'attorney': 'legal', 'attorneys': 'legal',
  'hotels': 'hotel', 'motels': 'hotel',
  // Home services
  'plumber': 'plumber', 'plumbers': 'plumber',
  'electrician': 'electrician', 'electricians': 'electrician',
  'landscaper': 'landscaping', 'landscapers': 'landscaping', 'lawn care': 'landscaping',
  'mover': 'moving', 'movers': 'moving', 'moving company': 'moving', 'moving companies': 'moving',
  'storage': 'storage', 'storage units': 'storage', 'self storage': 'storage',
  'home inspector': 'inspector', 'home inspectors': 'inspector', 'inspector': 'inspector',
  'pool': 'swimming_pool', 'pool company': 'swimming_pool', 'pool companies': 'swimming_pool',
  'roofer': 'roofing', 'roofers': 'roofing', 'roofing': 'roofing',
  // Health & wellness
  'chiropractor': 'chiropractor', 'chiropractors': 'chiropractor', 'chiro': 'chiropractor',
  'yoga': 'yoga', 'yoga studio': 'yoga', 'yoga studios': 'yoga',
  'massage': 'massage_therapist', 'massage therapy': 'massage_therapist', 'massage therapist': 'massage_therapist',
  'pediatrician': 'clinic', 'pediatricians': 'clinic', 'kids doctor': 'clinic', 'childrens doctor': 'clinic',
  'urgent care': 'clinic', 'walk in clinic': 'clinic', 'walk-in': 'clinic',
  // Family
  'daycare': 'childcare', 'daycares': 'childcare', 'day care': 'childcare',
  'preschool': 'childcare', 'preschools': 'childcare',
  'childcare': 'childcare',
  // Pets
  'dog grooming': 'pet_grooming', 'grooming': 'pet_grooming', 'pet groomer': 'pet_grooming',
  'dog groomer': 'pet_grooming',
  // Auto
  'car wash': 'car_wash', 'car washes': 'car_wash', 'auto wash': 'car_wash',
};

function normalizeQuery(raw) {
  const q = raw.toLowerCase().trim();
  // Direct alias match
  if (QUERY_ALIASES[q]) return QUERY_ALIASES[q];
  // Strip trailing 's' for simple plurals (restaurants→restaurant, dentists→dentist)
  if (q.endsWith('s') && q.length > 4 && QUERY_ALIASES[q.slice(0, -1)] === undefined) {
    const singular = q.slice(0, -1);
    if (QUERY_ALIASES[singular]) return QUERY_ALIASES[singular];
    return singular; // return de-pluralized for substring matching
  }
  return q;
}

// City-name → ZIP resolution (backend mirror of frontend parseQuery)
const CITY_TO_ZIP = {
  'nocatee': '32081',
  'ponte vedra': '32082', 'ponte vedra beach': '32082', 'pvb': '32082',
  'st johns': '32092', 'saint johns': '32092',
  'st augustine': '32084', 'saint augustine': '32084',
  'st augustine beach': '32080', 'saint augustine beach': '32080',
  'palm valley': '32082',
  'jacksonville': '32202',
  'jax': '32202',
};

function resolveZip(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  // Strip "in <city>" or "near <city>" patterns
  const m = q.match(/(?:in|near|at)\s+([a-z\s.]+?)(?:\s*$|\s+\d)/);
  if (!m) return null;
  const city = m[1].trim().replace(/\.$/, '');
  return CITY_TO_ZIP[city] || null;
}

function extractZipFromQuery(query) {
  if (!query) return null;
  const m = query.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

function toolSearch({ zip, query, category, group, limit = 20 }) {
  let results = loadBusinesses();
  // Resolve ZIP: explicit param > numeric in query string > city name in query
  const resolvedZip = zip || extractZipFromQuery(query) || resolveZip(query);
  if (resolvedZip) results = results.filter(b => b.zip === resolvedZip);
  if (category) results = results.filter(b => b.category === category);
  if (group)    results = results.filter(b => getGroup(b.category) === group);
  if (query) {
    // Strip ZIP and city/location phrase before tokenizing so they don't score against addresses
    const strippedQuery = query
      .replace(/\b\d{5}\b/g, '')                       // remove ZIP digits
      .replace(/(?:in|near|at)\s+[a-z\s.]+$/i, '')    // remove "in ponte vedra" etc
      .trim();
    const raw   = (strippedQuery || query).toLowerCase().trim();
    const q     = normalizeQuery(raw);  // alias + de-plural
    const STOP  = new Set(['for','the','and','near','in','at','of','a','an','show','me','find','get','list','all','any','some','what','where','who','how','is','are','there','best','top','good','great','closest','nearby','around','here','places','spots','shops','open','now','today','local','services','service','things','stuff','options']);
    // Generate word variants: original + de-pluraled + alias-resolved
    const wordVariants = (w) => {
      const variants = new Set([w]);
      if (QUERY_ALIASES[w]) variants.add(QUERY_ALIASES[w]);
      if (w.length >= 5 && w.endsWith('s')) variants.add(w.slice(0, -1));
      if (w.length >= 6 && w.endsWith('es')) variants.add(w.slice(0, -2));
      return [...variants];
    };
    const words = raw.split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
      .flatMap(wordVariants);

    // Score each business — normalized query + word-level fuzzy
    const scored = results.map(b => {
      const name = (b.name     || '').toLowerCase();
      const cat  = (b.category || '').toLowerCase();
      const addr = (b.address  || '').toLowerCase();
      const grp  = getGroup(b.category).toLowerCase();
      let score  = 0;

      // Exact normalized match
      if (name.includes(q))    score += 100;
      if (cat  === q)          score += 90;   // exact category hit
      if (cat.includes(q))     score += 70;
      if (grp  === q)          score += 50;   // group-level match ("food", "health")
      if (addr.includes(q))    score += 30;

      // Also check against original raw query
      if (raw !== q) {
        if (name.includes(raw)) score += 80;
        if (cat.includes(raw))  score += 60;
      }

      // Word-level overlap
      for (const w of words) {
        if (name.includes(w))  score += 20;
        if (cat.includes(w))   score += 15;
        if (grp.includes(w))   score += 10;
        if (addr.includes(w))  score += 5;
      }

      return { b, score };
    }).filter(({ score }) => score > 0);

    results = scored.sort((a, z) => z.score - a.score).map(({ b }) => b);
  }
  if (!query) results.sort((a, b) => b.confidence - a.confidence);
  const total = results.length;
  results = results.slice(0, Math.min(limit, 50));

  return {
    total,
    returned: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      group: getGroup(b.category),
      zip: b.zip,
      address: b.address || '',
      lat: b.lat,
      lon: b.lon,
      phone: b.phone || '',
      website: b.website || '',
      hours: b.hours || '',
      confidence: b.confidence,
      claimed: b.claimed || false,
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: results.map(b => fmtBusiness(b)).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_nearby
 * Returns businesses within radius_miles of a lat/lon, sorted by distance.
 * Core tool for "what's near X" agent queries.
 */
function toolNearby({ lat, lon, radius_miles = 0.5, category, group, limit = 15 }) {
  if (!lat || !lon) return { error: 'lat and lon required' };
  const refLat = parseFloat(lat);
  const refLon = parseFloat(lon);

  let results = loadBusinesses().filter(b => b.lat && b.lon);
  if (category) results = results.filter(b => b.category === category);
  if (group)    results = results.filter(b => getGroup(b.category) === group);

  results = results
    .map(b => ({ ...b, _dist: distanceMiles(refLat, refLon, b.lat, b.lon) }))
    .filter(b => b._dist <= parseFloat(radius_miles))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, Math.min(limit, 50));

  return {
    center: { lat: refLat, lon: refLon },
    radius_miles,
    total: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      group: getGroup(b.category),
      address: b.address || '',
      lat: b.lat,
      lon: b.lon,
      distance_miles: parseFloat(b._dist.toFixed(3)),
      bearing: bearing(refLat, refLon, b.lat, b.lon),
      phone: b.phone || '',
      hours: b.hours || '',
      confidence: b.confidence,
      claimed: b.claimed || false,
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: results.map(b => fmtBusiness(b, refLat, refLon)).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_zone
 * Returns spending zone + demographic intelligence for a zip.
 */
function toolZone({ zip }) {
  const zones = loadZones();
  const zoneData = zones.zones?.[zip];
  if (!zoneData) {
    return { error: `No zone data for ${zip}. Covered: ${Object.keys(zones.zones || {}).join(', ')}` };
  }
  const center = ZIP_CENTERS[zip];
  const lines = [
    `ZONE: ${zip} · ${center?.label || zip}, FL`,
    `Population: ${(zoneData.population || 0).toLocaleString()}`,
    `Median Household Income: $${(zoneData.median_income || 0).toLocaleString()}`,
    `Median Home Value: $${(zoneData.median_home_value || 0).toLocaleString()}`,
    `Median Rent: $${(zoneData.median_rent || 0).toLocaleString()}/mo`,
    `Homeownership Rate: ${zoneData.ownership_rate || 0}%`,
    `Zone Score: ${zoneData.zone_score || 'N/A'} · ${zoneData.zone_label || ''}`,
    `Dominant Spending: ${zoneData.dominant_spend || 'N/A'}`,
    `County Establishments: ${(zoneData.county_establishments || 0).toLocaleString()}`,
    `County Employees: ${(zoneData.county_employees || 0).toLocaleString()}`,
    `County Payroll: $${zoneData.county_payroll_millions || 0}M`,
  ];
  return { zip, ...zoneData, context_block: lines.join('\n') };
}

/**
 * local_intel_corridor
 * Returns businesses along a named street corridor.
 * Useful for "what's on A1A" type queries.
 */
function toolCorridor({ street, zip, limit = 20 }) {
  if (!street) return { error: 'street name required' };
  const results = loadBusinesses()
    .filter(b => {
      if (zip && b.zip !== zip) return false;
      return (b.address || '').toLowerCase().includes(street.toLowerCase());
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.min(limit, 50));

  return {
    corridor: street,
    zip: zip || 'all',
    total: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      address: b.address || '',
      lat: b.lat,
      lon: b.lon,
      phone: b.phone || '',
      hours: b.hours || '',
      confidence: b.confidence,
      claimed: b.claimed || false,
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: `CORRIDOR: ${street}${zip ? ` (${zip})` : ''}\n` +
      results.map(b => fmtBusiness(b)).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_changes
 * Returns recently added or owner-verified listings.
 * Agents use this to detect new businesses opening.
 */
function toolChanges({ zip, limit = 20 }) {
  let results = loadBusinesses()
    .filter(b => b.addedAt || b.claimed || (b.sources || []).includes('owner_verified'));
  if (zip) results = results.filter(b => b.zip === zip);
  results.sort((a, b) => {
    const da = a.addedAt ? new Date(a.addedAt) : new Date(0);
    const db = b.addedAt ? new Date(b.addedAt) : new Date(0);
    if (b.claimed && !a.claimed) return 1;
    if (a.claimed && !b.claimed) return -1;
    return db - da;
  });
  results = results.slice(0, Math.min(limit, 50));

  return {
    total: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      zip: b.zip,
      address: b.address || '',
      addedAt: b.addedAt || null,
      claimed: b.claimed || false,
      confidence: b.confidence,
      sources: b.sources || [],
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: `RECENT CHANGES / VERIFIED LISTINGS:\n` +
      results.map(b =>
        `  ${b.name} [${b.category}] ${b.zip}${b.addedAt ? ` · added:${b.addedAt.slice(0,10)}` : ''}${b.claimed ? ' · owner_verified' : ''}`
      ).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_stats
 * Dataset coverage summary — useful for agents evaluating data quality.
 */
function toolStats() {
  const data = loadBusinesses();
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch { return []; } })();
  const byZip = {}, byGroup = {};
  let ownerVerified = 0, totalConf = 0;

  for (const b of data) {
    byZip[b.zip] = (byZip[b.zip] || 0) + 1;
    byGroup[getGroup(b.category)] = (byGroup[getGroup(b.category)] || 0) + 1;
    if (b.claimed) ownerVerified++;
    totalConf += b.confidence || 0;
  }

  const totalQueries = ledger.length;
  const totalRevenue = ledger.reduce((s, e) => s + (e.cost || 0), 0);

  const freshness = zipFreshnessBlock(data);
  return {
    total_businesses: data.length,
    owner_verified: ownerVerified,
    avg_confidence: data.length ? Math.round(totalConf / data.length) : 0,
    covered_zips: Object.keys(ZIP_CENTERS),
    by_zip: byZip,
    by_group: byGroup,
    total_queries: totalQueries,
    total_revenue_pathusd: parseFloat(totalRevenue.toFixed(4)),
    sources: ['OSM', 'Census ACS 2022', 'owner_verified'],
    data_freshness: freshness,
    context_block: [
      `LOCALINTEL DATASET STATS`,
      `Businesses: ${data.length} | Owner-verified: ${ownerVerified} | Avg confidence: ${data.length ? Math.round(totalConf/data.length) : 0}`,
      `Freshness grade: ${freshness.grade} | FRESH:${freshness.tier_distribution.FRESH||0} WARM:${freshness.tier_distribution.WARM||0} STALE:${freshness.tier_distribution.STALE||0} COLD:${freshness.tier_distribution.COLD||0}`,
      `Possibly closed flags: ${freshness.possibly_closed_count}`,
      `Zips: ${Object.entries(byZip).map(([z,c]) => `${z}:${c}`).join(', ')}`,
      `Categories: ${Object.entries(byGroup).map(([g,c]) => `${g}:${c}`).join(', ')}`,
      `Total queries served: ${totalQueries} | Revenue: $${totalRevenue.toFixed(4)} pathUSD`,
      `Sources: OSM · Census ACS 2022 · owner_verified`,
    ].join('\n'),
  };
}

// ── MCP tool registry ─────────────────────────────────────────────────────────
const TOOLS = {
  local_intel_context:   { fn: toolContext,    desc: 'Full spatial context block for a zip or lat/lon. Best first call for any location query.' },
  local_intel_search:    { fn: toolSearch,     desc: 'Search businesses by name, category, or group.' },
  local_intel_nearby:    { fn: toolNearby,     desc: 'Businesses within radius_miles of a lat/lon point, sorted by distance.' },
  local_intel_zone:      { fn: toolZone,       desc: 'Spending zone, demographic, and economic data for a zip code.' },
  local_intel_corridor:  { fn: toolCorridor,   desc: 'Businesses along a named street corridor (e.g. A1A, Palm Valley Rd).' },
  local_intel_changes:   { fn: toolChanges,    desc: 'Recently added or owner-verified business listings.' },
  local_intel_stats:     { fn: toolStats,      desc: 'Dataset coverage stats and usage metrics.' },
  // ── Tidal layer tools (Layer 0-3 intelligence) ──
  local_intel_tide:      { fn: handleTide,     desc: 'Tidal reading for a ZIP — temperature, direction, seasonal context. Combines all 4 data layers.' },
  local_intel_signal:    { fn: handleSignal,   desc: 'Investment + activity signal for a ZIP — composite score from bedrock through wave surface.' },
  local_intel_bedrock:   { fn: handleBedrock,  desc: 'Infrastructure momentum — permits, road projects, flood zones. Leading indicator (12-36mo ahead).' },
  local_intel_for_agent: { fn: handleForAgent, desc: 'Premium composite entry point. Declare agent_type + intent, get pre-ranked signals for your use case.' },
  local_intel_oracle:    { fn: handleOracle,   desc: 'Pre-baked economic narrative for a ZIP: restaurant saturation, price-tier gaps, growth trajectory, and the 3 questions you should be asking with answers.' },
  // ── Vertical agents (trained on 100 industry prompts each) ─────────────────────────
  local_intel_realtor:      { fn: (p) => handleVerticalQuery('realtor',      p.query, p.zip), desc: 'Real estate intelligence for a ZIP: demographics, commercial gaps, flood risk, infrastructure, market signals. Trained for buyer briefs and investment analysis.' },
  local_intel_healthcare:   { fn: (p) => handleVerticalQuery('healthcare',   p.query, p.zip), desc: 'Healthcare market intelligence: provider density, demographics, patient demand gaps, senior population signals.' },
  local_intel_retail:       { fn: (p) => handleVerticalQuery('retail',       p.query, p.zip), desc: 'Retail market intelligence: store categories, spending capture, consumer profile, undersupplied niches.' },
  local_intel_construction: { fn: (p) => handleVerticalQuery('construction', p.query, p.zip), desc: 'Construction and home services intelligence: active permits, contractor density, population growth driving demand.' },
  local_intel_restaurant:   { fn: (p) => handleVerticalQuery('restaurant',   p.query, p.zip), desc: 'Restaurant market intelligence: saturation scores, price-tier gaps, capture rate, corridor analysis, tidal momentum.' },
  local_intel_ask:          { fn: handleAsk, desc: 'Composite NL query layer — ask any plain-English question about a ZIP and get a synthesized, sourced answer. Routes internally to zone, oracle, search, bedrock, signal, tide, corridor, changes, and nearby tools. Single entry point for humans and LLMs.' },
};

// ── MCP manifest (tools/list response) ───────────────────────────────────────
const MCP_MANIFEST = {
  name: 'localintel',
  version: '1.0.0',
  description: 'LocalIntel — agentic business intelligence for St. Johns County FL (32081 + 32082). Spatial context, business search, spending zones, corridor analysis.',
  tools: [
    {
      name: 'local_intel_context',
      description: 'Full spatial context block for a zip or lat/lon. Returns anchor business, nearby businesses in distance rings, zone intelligence, and category breakdown. Best first call for any location query.',
      inputSchema: {
        type: 'object',
        properties: {
          zip:          { type: 'string', description: 'ZIP code (32081 or 32082)' },
          lat:          { type: 'number', description: 'Latitude (alternative to zip)' },
          lon:          { type: 'number', description: 'Longitude (alternative to zip)' },
          radius_miles: { type: 'number', description: 'Search radius in miles (default 1.0)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_search',
      description: 'Search businesses by name, category, or semantic group (food, retail, health, finance, civic, services).',
      inputSchema: {
        type: 'object',
        properties: {
          zip:      { type: 'string', description: 'Filter by ZIP code' },
          query:    { type: 'string', description: 'Text search on name/category/address' },
          category: { type: 'string', description: 'Exact OSM category (restaurant, bank, dentist...)' },
          group:    { type: 'string', description: 'Semantic group: food | retail | health | finance | civic | services' },
          limit:    { type: 'integer', description: 'Max results (default 20, max 50)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_nearby',
      description: 'Find businesses within a radius of any lat/lon point, sorted by distance with compass bearing.',
      inputSchema: {
        type: 'object',
        required: ['lat', 'lon'],
        properties: {
          lat:          { type: 'number', description: 'Latitude of center point' },
          lon:          { type: 'number', description: 'Longitude of center point' },
          radius_miles: { type: 'number', description: 'Search radius in miles (default 0.5)' },
          category:     { type: 'string', description: 'Filter by OSM category' },
          group:        { type: 'string', description: 'Filter by semantic group' },
          limit:        { type: 'integer', description: 'Max results (default 15)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_zone',
      description: 'Spending zone and demographic data for a ZIP code: population, income, home value, rent, ownership rate, zone score.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip: { type: 'string', description: 'ZIP code (32081 or 32082)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_corridor',
      description: 'Businesses along a named street corridor. Use for queries like "what is on A1A" or "businesses on Palm Valley Road".',
      inputSchema: {
        type: 'object',
        required: ['street'],
        properties: {
          street: { type: 'string', description: 'Street name (e.g. "A1A", "Palm Valley", "Crosswater")' },
          zip:    { type: 'string', description: 'Optional ZIP filter' },
          limit:  { type: 'integer', description: 'Max results (default 20)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_changes',
      description: 'Recently added or owner-verified business listings. Use to detect new openings or data updates.',
      inputSchema: {
        type: 'object',
        properties: {
          zip:   { type: 'string', description: 'Optional ZIP filter' },
          limit: { type: 'integer', description: 'Max results (default 20)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_stats',
      description: 'Dataset coverage stats: total businesses, confidence scores, query volume, revenue earned.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_tide',
      description: 'Tidal reading for a ZIP — temperature (0-100), direction (surging/heating/stable/cooling/receding), seasonal context. Synthesizes all 4 data layers. Best for agents deciding WHERE to act next.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip:            { type: 'string', description: 'ZIP code to read tidal state for' },
          include_layers: { type: 'array',  description: 'Layers to include: bedrock, ocean_floor, surface_current, wave_surface (default: all)' },
          query_context:  { type: 'object', description: 'Optional: { agent_type, agent_id, purpose }' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_signal',
      description: 'Investment and activity signal for a ZIP. Composite score 0-100 with band (strong_buy/accumulate/hold/reduce/avoid), top reasons, and avoid flags. Best for real estate and financial agents.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip:           { type: 'string', description: 'ZIP code' },
          agent_type:    { type: 'string', description: 'real_estate | financial | ad_placement | logistics | business_owner | civic' },
          query_context: { type: 'object', description: 'Optional: { agent_id, purpose }' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_bedrock',
      description: 'Infrastructure momentum score and active leading indicators for a ZIP from Layer 0. Permits, road projects, flood zones, utility extensions. Predicts conditions 12-36 months ahead. \'Let Google pay for the satellites — we sell the weather forecast.\'',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip:           { type: 'string', description: 'ZIP code' },
          query_context: { type: 'object', description: 'Optional: { agent_type, agent_id }' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_for_agent',
      description: 'PREMIUM composite entry point ($0.05). Declare your agent_type and intent, receive pre-ranked top-10 signals assembled from all 4 data layers, personalized for your use case. Includes delta since your last query if agent_id provided. Best first call for any new agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_type: { type: 'string', description: 'real_estate | financial | ad_placement | logistics | business_owner | civic' },
          intent:     { type: 'string', description: 'Plain-language description of what you are trying to decide or do' },
          zip:        { type: 'string', description: 'Target ZIP code' },
          lat:        { type: 'number', description: 'Latitude (if no ZIP)' },
          lon:        { type: 'number', description: 'Longitude (if no ZIP)' },
          budget:     { type: 'number', description: 'Agent budget in pathUSD (optional, for signal prioritization)' },
          depth:      { type: 'string', description: 'quick (top 5 signals) | full (top 10 + context blocks)' },
          agent_id:   { type: 'string', description: 'Your agent UUID for memory + delta computation' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_oracle',
      description: 'Pre-baked economic oracle for a ZIP. Returns: restaurant saturation (is there room for another?), price-tier gap analysis (what menu price is missing?), growth trajectory (growing/empty-nest/stable), and 3 pre-formed questions with answers baked in. No LLM needed — answers derived from population, income, business density, school count, and infrastructure signals.',
      inputSchema: {
        type: 'object',
        properties: {
          zip: { type: 'string', description: 'ZIP code to analyze (e.g. 32081)' },
        },
        required: ['zip'],
      },
      annotations: { readOnly: true },
    },
    // ── Vertical agents ───────────────────────────────────────────
    {
      name: 'local_intel_realtor',
      description: 'Real estate intelligence for a ZIP. Ask natural-language questions: demographics, commercial gaps, flood risk, school proximity, infrastructure signals, market saturation. Returns structured data with confidence score. Trained on 100 realtor use-case prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question (e.g. "What is the flood risk for this ZIP?", "What commercial gaps exist?")' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_healthcare',
      description: 'Healthcare market intelligence for a ZIP. Ask about provider density, patient demographics, demand gaps, senior population. Returns structured data with confidence score. Trained on 100 healthcare business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about healthcare market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_retail',
      description: 'Retail market intelligence for a ZIP. Ask about store categories, spending capture rates, consumer profile, undersupplied niches. Returns structured data with confidence score. Trained on 100 retail business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about retail market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_construction',
      description: 'Construction and home services market intelligence for a ZIP. Ask about contractor density, active permits, housing starts, population growth driving demand. Returns structured data with confidence score. Trained on 100 construction business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about construction market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_restaurant',
      description: 'Restaurant and food service market intelligence for a ZIP. Ask about saturation scores, price-tier gaps, capture rates, corridor analysis, tidal momentum. Returns structured data with confidence score. Trained on 100 restaurant business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about restaurant market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_ask',
      description: 'Composite NL query layer. Ask any plain-English question about a ZIP — demographics, market opportunity, restaurant gaps, retail saturation, construction activity, investment signals, healthcare, corridor analysis, recent changes, nearby businesses. Routes internally to the right tools and returns a synthesized, sourced answer with confidence score. Best single entry point for humans and LLMs.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Plain English question, e.g. "What restaurant categories are missing in 32082?"' },
          zip: { type: 'string', description: 'ZIP code (optional — will be extracted from question if present, defaults to 32082)' },
        },
        required: ['question'],
      },
      annotations: { readOnly: true },
    },
  ],
};

// ── JSON-RPC 2.0 handler ──────────────────────────────────────────────────────
function handleRPC(req) {
  const { jsonrpc, id, method, params } = req;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } };
  }

  // MCP handshake
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: MCP_MANIFEST.name, version: MCP_MANIFEST.version },
      },
    };
  }

  if (method === 'notifications/initialized') return null; // no response needed

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_MANIFEST.tools } };
  }
  if (method === 'prompts/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        prompts: [
          {
            name: 'local_context_brief',
            description: 'Get a plain-language business context brief for a ZIP code or location.',
            arguments: [
              { name: 'zip', description: 'ZIP code (32081 or 32082)', required: false },
              { name: 'lat', description: 'Latitude', required: false },
              { name: 'lon', description: 'Longitude', required: false },
            ],
          },
          {
            name: 'investment_signal_brief',
            description: 'Get a plain-language investment signal summary for a ZIP code.',
            arguments: [
              { name: 'zip', description: 'ZIP code (32081 or 32082)', required: true },
              { name: 'agent_type', description: 'real_estate | financial | logistics | civic', required: false },
            ],
          },
        ],
      },
    };
  }

  if (method === 'resources/list') {
    // Dynamically build resource list from whatever ZIPs are in the live dataset
    const allData = loadData();
    const zipCounts = {};
    for (const biz of allData) {
      if (biz.zip) zipCounts[biz.zip] = (zipCounts[biz.zip] || 0) + 1;
    }
    const ZIP_LABELS = {
      '32081': 'Ponte Vedra Beach / Nocatee',
      '32082': 'Ponte Vedra Beach South',
      '32092': 'St. Johns / World Golf Village',
      '32095': 'Ponte Vedra / Palm Valley',
      '32259': 'Fruit Cove / Julington Creek',
      '32256': 'Tinseltown / Baymeadows',
      '32257': 'Mandarin South',
      '32258': 'Mandarin North',
      '32065': 'Orange Park',
      '32073': 'Orange Park West',
    };
    const resources = Object.entries(zipCounts).sort().map(([zip, count]) => ({
      uri: `localintel://coverage/${zip}`,
      name: `ZIP ${zip} Coverage Report`,
      description: `${ZIP_LABELS[zip] || 'St. Johns County'} (${zip}) — ${count} businesses in live dataset.`,
      mimeType: 'application/json',
    }));
    // Add a system-wide summary resource
    resources.unshift({
      uri: 'localintel://coverage/all',
      name: 'Full Coverage Summary',
      description: `All ${Object.keys(zipCounts).length} ZIPs in LocalIntel — ${allData.length} total businesses.`,
      mimeType: 'application/json',
    });
    return { jsonrpc: '2.0', id, result: { resources } };
  }



  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    const caller   = params?._caller || 'unknown';

    if (!TOOLS[toolName]) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
    }

    try {
      const t0 = Date.now();
      const result = TOOLS[toolName].fn(toolArgs);
      const latency = Date.now() - t0;
      // Extract zip + intent for observability (present on local_intel_ask results)
      const parsed = (typeof result === 'object' && result !== null) ? result : {};
      logUsage(toolName, caller, {
        entry:   params?._entry || 'free',
        zip:     toolArgs?.zip || parsed?.zip || null,
        intent:  parsed?.intent || null,
        latency,
      });
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          _meta: { cost_pathusd: TOOL_COSTS[toolName] || 0, latency_ms: latency },
        },
      };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, server: 'LocalIntel MCP', version: '1.0.0', tools: Object.keys(TOOLS).length }));
  }

  // MCP manifest (for discovery)
  if (req.method === 'GET' && req.url === '/manifest') {
    res.writeHead(200);
    return res.end(JSON.stringify(MCP_MANIFEST));
  }

  // JSON-RPC endpoint
  if (req.method === 'POST' && (req.url === '/' || req.url === '/mcp')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        // Handle batch requests
        if (Array.isArray(parsed)) {
          const responses = parsed.map(handleRPC).filter(Boolean);
          res.writeHead(200);
          return res.end(JSON.stringify(responses));
        }
        const response = handleRPC(parsed);
        if (response === null) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found. POST /mcp for JSON-RPC, GET /manifest for tool list.' }));
});

server.listen(PORT, () => {
  console.log(`[LocalIntelMCP] MCP server listening on port ${PORT}`);
  console.log(`[LocalIntelMCP] ${Object.keys(TOOLS).length} tools registered`);
  console.log(`[LocalIntelMCP] Covered zips: ${Object.keys(ZIP_CENTERS).join(', ')}`);
});

// _tools: lazy export consumed by callTool() in localIntelTidalTools.js
module.exports = { handleRPC, MCP_MANIFEST, _tools: TOOLS };
