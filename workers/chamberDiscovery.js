/**
 * chamberDiscovery.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Autonomous chamber-of-commerce discovery and member import for ANY city/ZIP.
 *
 * Strategy:
 *   1. Look up the chamber URL from a known ZIP→chamber registry (seeded + runtime-learned)
 *   2. If not known, search YellowPages + DuckDuckGo for "{city} chamber of commerce"
 *   3. Detect CMS type (GrowthZone, Chambermaster, generic) and try to pull members
 *   4. Geocode member addresses with Nominatim → merge into zip JSON files
 *   5. Write discovered chamber URL back to registry for future runs
 *
 * CMS Support:
 *   • GrowthZone  — same as SJC (business.sjcchamber.com style)
 *                   URL pattern: /member-directory/FindStartsWith?term=%23%21
 *   • Chambermaster — /list/ql/category_id/all or /search/MemberSearch.aspx
 *   • Generic HTML — best-effort name/phone/address extraction
 *
 * No API keys required. Polite: 1.2s between requests.
 *
 * Usage:
 *   const { discoverAndImport } = require('./chamberDiscovery');
 *   const stats = await discoverAndImport({ zip: '32256', city: 'Jacksonville', state: 'FL' });
 *
 * CLI:
 *   node chamberDiscovery.js --zip 32256 --city Jacksonville --state FL
 */

'use strict';

const http  = require('http');
const https = require('https');
const path  = require('path');
const fs    = require('fs');

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const ZIPS_DIR   = path.join(DATA_DIR, 'zips');
const REGISTRY_FILE = path.join(DATA_DIR, 'chamberRegistry.json');
const DELAY_MS   = 1300;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Known chamber registry (seeded, auto-grows at runtime) ──────────────────
// Maps ZIP or city slug → { url, cms, name }
// Add more as you expand. chamberRegistry.json on Railway volume fills in the rest.
const SEED_REGISTRY = {
  // SJC — already handled by chamberScraper.js
  '32081': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },
  '32082': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },
  '32084': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },
  '32086': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },
  '32092': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },
  '32095': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },

  // Jacksonville / Duval — JAXUSA Partnership + JAX Chamber
  '32256': { url: 'https://www.memberplanet.com/jaxchamber', cms: 'generic', name: 'JAX Chamber' },
  '32258': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32223': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32225': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32246': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32218': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32244': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32210': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32205': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },
  '32207': { url: 'https://www.jaxchamber.com', cms: 'generic', name: 'JAX Chamber' },

  // Ponte Vedra / Beaches — separate from SJC
  '32080': { url: 'https://business.sjcchamber.com', cms: 'growthzone', name: 'St. Johns County Chamber' },

  // Tampa metro — Greater Tampa Chamber
  '33629': { url: 'https://www.tampachamber.com', cms: 'generic', name: 'Greater Tampa Chamber of Commerce' },
  '33618': { url: 'https://www.tampachamber.com', cms: 'generic', name: 'Greater Tampa Chamber of Commerce' },
  '33647': { url: 'https://www.tampachamber.com', cms: 'generic', name: 'Greater Tampa Chamber of Commerce' },
  '33626': { url: 'https://www.tampachamber.com', cms: 'generic', name: 'Greater Tampa Chamber of Commerce' },
  // Lakewood Ranch — Manatee Chamber
  '34202': { url: 'https://www.manateechamber.com', cms: 'growthzone', name: 'Manatee Chamber of Commerce' },

  // Orlando metro
  '32828': { url: 'https://www.orlando.org', cms: 'generic', name: 'Orlando Economic Partnership' },
  '32836': { url: 'https://www.orlando.org', cms: 'generic', name: 'Orlando Economic Partnership' },
  '34786': { url: 'https://www.orlando.org', cms: 'generic', name: 'Orlando Economic Partnership' },
  '32771': { url: 'https://www.sanfordchamber.com', cms: 'generic', name: 'Sanford Chamber' },
  '34711': { url: 'https://www.lakecountychamber.com', cms: 'generic', name: 'Lake County Chamber' },

  // South Florida
  '33458': { url: 'https://www.jupiterfl.org', cms: 'generic', name: 'Jupiter-Tequesta-Juno Beach Chamber' },
  '33496': { url: 'https://www.bocaratonchamber.com', cms: 'growthzone', name: 'Greater Boca Raton Chamber' },
  '33433': { url: 'https://www.bocaratonchamber.com', cms: 'growthzone', name: 'Greater Boca Raton Chamber' },
  '33076': { url: 'https://www.pembrokepineschamber.org', cms: 'generic', name: 'Chamber South' },
  '33326': { url: 'https://www.westonchamber.com', cms: 'generic', name: 'Weston Chamber of Commerce' },
  // Alabama Gulf Coast — Mobile Area Chamber
  '36695': { url: 'https://www.mobilechamber.com', cms: 'generic', name: 'Mobile Area Chamber of Commerce' },
  '36608': { url: 'https://www.mobilechamber.com', cms: 'generic', name: 'Mobile Area Chamber of Commerce' },
  '36609': { url: 'https://www.mobilechamber.com', cms: 'generic', name: 'Mobile Area Chamber of Commerce' },
  // Alabama Gulf Coast — Eastern Shore Chamber
  '36526': { url: 'https://www.eschamber.com', cms: 'growthzone', name: 'Eastern Shore Chamber of Commerce' },
  '36532': { url: 'https://www.eschamber.com', cms: 'growthzone', name: 'Eastern Shore Chamber of Commerce' },
  // Alabama Gulf Coast — Gulf Shores / Orange Beach
  '36542': { url: 'https://www.gulfshores.com', cms: 'generic', name: 'Gulf Shores & Orange Beach Tourism' },
  '36561': { url: 'https://www.orangebeach.com', cms: 'generic', name: 'Orange Beach Chamber' },
  // Georgia — Savannah Area Chamber
  '31405': { url: 'https://www.savannahchamber.com', cms: 'generic', name: 'Savannah Area Chamber of Commerce' },
  '31406': { url: 'https://www.savannahchamber.com', cms: 'generic', name: 'Savannah Area Chamber of Commerce' },
  '31419': { url: 'https://www.savannahchamber.com', cms: 'generic', name: 'Savannah Area Chamber of Commerce' },
  '31407': { url: 'https://www.savannahchamber.com', cms: 'generic', name: 'Savannah Area Chamber of Commerce' },
  '31322': { url: 'https://www.poolerchamber.com', cms: 'growthzone', name: 'Pooler Chamber of Commerce' },
  '31326': { url: 'https://www.savannahchamber.com', cms: 'generic', name: 'Savannah Area Chamber of Commerce' },
  // Georgia — Atlanta suburbs
  '30097': { url: 'https://www.johnskreekchamber.com', cms: 'generic', name: 'Johns Creek Chamber of Commerce' },
  '30022': { url: 'https://www.alpharettachamber.org', cms: 'growthzone', name: 'Greater North Fulton Chamber' },
  '30005': { url: 'https://www.alpharettachamber.org', cms: 'growthzone', name: 'Greater North Fulton Chamber' },
  '30009': { url: 'https://www.alpharettachamber.org', cms: 'growthzone', name: 'Greater North Fulton Chamber' },
  '30024': { url: 'https://www.suwaneechamber.com', cms: 'generic', name: 'Suwanee Business Alliance' },
  '30068': { url: 'https://www.cobbchamber.org', cms: 'generic', name: 'Cobb Chamber of Commerce' },
  '30062': { url: 'https://www.cobbchamber.org', cms: 'generic', name: 'Cobb Chamber of Commerce' },
  // Texas Gulf Coast — Houston metro
  '77494': { url: 'https://www.katychamber.com', cms: 'growthzone', name: 'Katy Area Chamber of Commerce' },
  '77450': { url: 'https://www.katychamber.com', cms: 'growthzone', name: 'Katy Area Chamber of Commerce' },
  '77479': { url: 'https://www.sugarlandtx.gov/chamber', cms: 'generic', name: 'Fort Bend Chamber of Commerce' },
  '77459': { url: 'https://www.fortbendchamber.com', cms: 'generic', name: 'Fort Bend Chamber of Commerce' },
  '77584': { url: 'https://www.pearlandtxchamber.com', cms: 'growthzone', name: 'Pearland Chamber of Commerce' },
  '77382': { url: 'https://www.woodlandschamber.org', cms: 'growthzone', name: 'The Woodlands Chamber' },
  '77380': { url: 'https://www.woodlandschamber.org', cms: 'growthzone', name: 'The Woodlands Chamber' },
  '77573': { url: 'https://www.leaguecitychamber.com', cms: 'growthzone', name: 'League City Regional Chamber' },
  // Texas Gulf Coast — Corpus Christi
  '78412': { url: 'https://www.corpuschristichamber.org', cms: 'generic', name: 'Corpus Christi Chamber of Commerce' },
  '78413': { url: 'https://www.corpuschristichamber.org', cms: 'generic', name: 'Corpus Christi Chamber of Commerce' },
  '78418': { url: 'https://www.corpuschristichamber.org', cms: 'generic', name: 'Corpus Christi Chamber of Commerce' },
};

// ── HTTP helper ───────────────────────────────────────────────────────────────
function fetchRaw(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; LocalIntelBot/1.0; +https://localintel.ai)',
          'Accept': 'text/html,application/xhtml+xml,application/json',
          ...headers,
        },
        timeout: timeoutMs,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
          return resolve(fetchRaw(next, headers, timeoutMs));
        }
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      req.on('error', () => resolve({ status: 0, body: '' }));
      req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
    } catch (e) {
      resolve({ status: 0, body: '' });
    }
  });
}

// ── Registry helpers ─────────────────────────────────────────────────────────
function loadRegistry() {
  let saved = {};
  if (fs.existsSync(REGISTRY_FILE)) {
    try { saved = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8')); } catch (_) {}
  }
  return { ...SEED_REGISTRY, ...saved };
}

function saveRegistry(reg) {
  // Only persist non-seed entries so seed stays clean
  const toSave = {};
  for (const [k, v] of Object.entries(reg)) {
    if (!SEED_REGISTRY[k] || JSON.stringify(SEED_REGISTRY[k]) !== JSON.stringify(v)) {
      toSave[k] = v;
    }
  }
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify(toSave, null, 2));
}

// ── CMS detection ─────────────────────────────────────────────────────────────
function detectCMS(html, baseUrl) {
  if (!html) return 'unknown';
  if (html.includes('GrowthZone') || html.includes('gz-member') || html.includes('growthzone')) return 'growthzone';
  if (html.includes('ChamberMaster') || html.includes('chambermaster') || html.includes('MemberSearch.aspx')) return 'chambermaster';
  if (html.includes('memberplanet')) return 'memberplanet';
  return 'generic';
}

// ── GrowthZone member pull ───────────────────────────────────────────────────
// Same logic as chamberScraper.js — GrowthZone is the dominant CMS
async function pullGrowthZone(baseUrl, options = {}) {
  const url = `${baseUrl}/member-directory/FindStartsWith?term=%23%21`;
  console.log(`[ChamberDiscovery] GrowthZone pull: ${url}`);
  const { status, body } = await fetchRaw(url);
  if (status !== 200) {
    console.log(`[ChamberDiscovery] GrowthZone HTTP ${status}`);
    return [];
  }
  return parseGrowthZoneHTML(body);
}

function parseGrowthZoneHTML(html) {
  const businesses = [];
  const cardRegex = /<div[^>]*class="[^"]*gz-member[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*gz-member[^"]*"|$)/gi;
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const card = match[1];
    const nameMatch = card.match(/<span[^>]*class="[^"]*gz-card-name[^"]*"[^>]*>([^<]+)<\/span>/i)
      || card.match(/<h4[^>]*>([^<]+)<\/h4>/i)
      || card.match(/<strong[^>]*>([^<]{3,80})<\/strong>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const phoneMatch = card.match(/tel:([0-9+\-\s().]+)"/i) || card.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
    const phone = phoneMatch ? (phoneMatch[1] || phoneMatch[0]).replace(/tel:/i, '').trim() : null;
    const websiteMatch = card.match(/href="(https?:\/\/[^"]+)"[^>]*>[^<]*[Ww]ebsite/i);
    const website = websiteMatch ? websiteMatch[1] : null;
    const addrMatch = card.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
    const address = addrMatch ? addrMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : null;
    const catMatch = card.match(/<span[^>]*class="[^"]*gz-card-category[^"]*"[^>]*>([^<]+)<\/span>/i);
    const category = catMatch ? catMatch[1].trim() : null;
    businesses.push({ name, phone, website, address, category, source: 'chamber_growthzone' });
  }
  return businesses;
}

// ── Chambermaster member pull ────────────────────────────────────────────────
async function pullChambermaster(baseUrl) {
  // Try the standard Chambermaster search endpoint
  const searchUrl = `${baseUrl}/list/ql/category_id/all`;
  console.log(`[ChamberDiscovery] Chambermaster pull: ${searchUrl}`);
  const { status, body } = await fetchRaw(searchUrl);
  if (status !== 200) return [];
  return parseChambermaster(body);
}

function parseChambermaster(html) {
  const businesses = [];
  // Chambermaster uses .chambermaster_list_item or similar
  const cardRegex = /<div[^>]*class="[^"]*(?:list_item|member_result|memberlistitem)[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*(?:list_item|member_result|memberlistitem)[^"]*"|$)/gi;
  let match;
  while ((match = cardRegex.exec(html)) !== null) {
    const card = match[1];
    const nameMatch = card.match(/<(?:h3|h4|strong|span)[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)<\//i)
      || card.match(/<a[^>]*class="[^"]*name[^"]*"[^>]*>([^<]+)<\/a>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();
    const phoneMatch = card.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
    const phone = phoneMatch ? phoneMatch[0] : null;
    businesses.push({ name, phone, website: null, address: null, category: null, source: 'chamber_chambermaster' });
  }
  return businesses;
}

// ── Generic HTML member extraction ───────────────────────────────────────────
// Last-resort fallback — pulls any name/phone patterns from a membership page
async function pullGeneric(baseUrl) {
  // Common membership directory paths to try
  const paths = [
    '/member-directory',
    '/members',
    '/business-directory',
    '/membership-directory',
    '/directory',
  ];

  for (const p of paths) {
    const url = `${baseUrl}${p}`;
    const { status, body } = await fetchRaw(url, {}, 12000);
    if (status === 200 && body.length > 500) {
      console.log(`[ChamberDiscovery] Generic: found content at ${url}`);
      return parseGenericDirectory(body, baseUrl);
    }
    await sleep(700);
  }
  console.log(`[ChamberDiscovery] Generic: no directory page found at ${baseUrl}`);
  return [];
}

function parseGenericDirectory(html, baseUrl) {
  const businesses = [];
  const seen = new Set();

  // Extract h2/h3/h4 headings that look like business names + nearby phone
  const headingRegex = /<h[234][^>]*>([^<]{4,80})<\/h[234]>/gi;
  const phoneRegex = /\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g;

  // Chunk HTML into ~2KB blocks to associate names with nearby phones
  const chunkSize = 2000;
  for (let i = 0; i < Math.min(html.length, 200000); i += chunkSize) {
    const chunk = html.slice(i, i + chunkSize);
    const headings = [...chunk.matchAll(headingRegex)];
    for (const h of headings) {
      const name = h[1].replace(/<[^>]+>/g, '').trim();
      if (name.length < 3 || seen.has(name.toLowerCase())) continue;
      // Skip navigation/boilerplate headings
      if (/^(home|about|contact|events|news|join|login|search|directory|members|menu)$/i.test(name)) continue;
      seen.add(name.toLowerCase());

      // Look for phone in surrounding 500 chars
      const surrounding = html.slice(Math.max(0, i + h.index - 200), i + h.index + 500);
      const phones = [...surrounding.matchAll(phoneRegex)];
      const phone = phones.length ? phones[0][0] : null;

      businesses.push({ name, phone, website: null, address: null, category: null, source: 'chamber_generic' });
    }
  }

  return businesses;
}

// ── Discover chamber URL for a city (when not in registry) ───────────────────
async function discoverChamberUrl(city, state) {
  // Try DuckDuckGo HTML search (no key needed)
  const query = encodeURIComponent(`${city} ${state} chamber of commerce official site`);
  const ddgUrl = `https://html.duckduckgo.com/html/?q=${query}`;

  try {
    const { status, body } = await fetchRaw(ddgUrl, {
      'Accept-Language': 'en-US,en;q=0.9',
    }, 15000);

    if (status !== 200) return null;

    // Extract result URLs from DDG HTML
    const urlMatches = [...body.matchAll(/href="(https?:\/\/(?!duckduckgo\.com|google\.com|yelp\.com|facebook\.com)[^"]+)"/g)];
    for (const m of urlMatches) {
      const url = m[1];
      if (/chamber|commerce|business.*directory/i.test(url)) {
        // Validate — check if URL responds
        const base = new URL(url).origin;
        const { status: s } = await fetchRaw(base, {}, 8000);
        if (s === 200) {
          console.log(`[ChamberDiscovery] Discovered chamber for ${city}: ${base}`);
          return base;
        }
      }
    }
  } catch (_) {}

  return null;
}

// ── Geocode member address ───────────────────────────────────────────────────
async function geocodeMember(address, city, state) {
  if (!address) return null;
  try {
    const q = encodeURIComponent(`${address}, ${city}, ${state}`);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    const { status, body } = await fetchRaw(url, {
      'User-Agent': 'LocalIntelBot/1.0 (contact: erik@mcflamingo.com)',
    }, 10000);
    if (status !== 200) return null;
    const results = JSON.parse(body);
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } catch (_) { return null; }
}

// ── Merge member into zip file ────────────────────────────────────────────────
function mergeIntoZipFile(zipCode, business, chamberName) {
  if (!fs.existsSync(ZIPS_DIR)) fs.mkdirSync(ZIPS_DIR, { recursive: true });
  const filePath = path.join(ZIPS_DIR, `${zipCode}.json`);
  let data = [];
  if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }
  if (!Array.isArray(data)) data = [];

  const nameLower = business.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const existing = data.find(b => {
    const bLower = (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return bLower === nameLower || bLower.includes(nameLower) || nameLower.includes(bLower);
  });

  const now = new Date().toISOString();

  if (existing) {
    let changed = false;
    ['phone', 'website', 'hours', 'address'].forEach(f => {
      if (!existing[f] && business[f]) { existing[f] = business[f]; changed = true; }
    });
    if (changed) {
      existing.chamber_member  = true;
      existing.chamber_source  = chamberName;
      existing.last_enriched   = now;
      existing.confidence      = Math.min(90, (existing.confidence || 60) + 8);
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return changed ? 'enriched' : 'skipped';
  } else {
    data.push({
      name:           business.name,
      phone:          business.phone || null,
      website:        business.website || null,
      address:        business.address || null,
      hours:          null,
      category:       business.category || 'business',
      zip:            zipCode,
      lat:            business.lat || null,
      lon:            business.lon || null,
      confidence:     72,
      chamber_member: true,
      chamber_source: chamberName,
      source:         business.source || 'chamber',
      added_at:       now,
      last_enriched:  now,
    });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return 'added';
  }
}

// ── Infer ZIP from address string ─────────────────────────────────────────────
function inferZipFromAddress(address) {
  if (!address) return null;
  const m = address.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

// ── Main: discover + import for a given ZIP/city ─────────────────────────────
async function discoverAndImport({ zip, city, state = 'FL', lat, lon }) {
  console.log(`[ChamberDiscovery] Starting for ZIP ${zip} — ${city}, ${state}`);

  const registry = loadRegistry();
  let entry = registry[zip] || registry[city?.toLowerCase()];

  // If not in registry, try to discover
  if (!entry) {
    console.log(`[ChamberDiscovery] No registry entry for ${zip} — running discovery`);
    const discovered = await discoverChamberUrl(city, state);
    if (discovered) {
      const homeBody = (await fetchRaw(discovered, {}, 10000)).body;
      const cms = detectCMS(homeBody, discovered);
      entry = { url: discovered, cms, name: `${city} Chamber of Commerce` };
      registry[zip] = entry;
      saveRegistry(registry);
    } else {
      console.log(`[ChamberDiscovery] Could not discover chamber for ${city} — skipping`);
      return { added: 0, enriched: 0, skipped: 0, reason: 'no_chamber_found' };
    }
  }

  console.log(`[ChamberDiscovery] Using ${entry.name} (${entry.cms}) at ${entry.url}`);

  // Pull members based on CMS type
  let members = [];
  try {
    if (entry.cms === 'growthzone') {
      members = await pullGrowthZone(entry.url);
    } else if (entry.cms === 'chambermaster') {
      members = await pullChambermaster(entry.url);
    } else {
      members = await pullGeneric(entry.url);
    }
  } catch (e) {
    console.log(`[ChamberDiscovery] Pull failed for ${entry.name}: ${e.message}`);
    return { added: 0, enriched: 0, skipped: 0, reason: e.message };
  }

  console.log(`[ChamberDiscovery] Found ${members.length} members from ${entry.name}`);
  if (members.length === 0) {
    return { added: 0, enriched: 0, skipped: 0, reason: 'no_members_found' };
  }

  let added = 0, enriched = 0, skipped = 0;

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    if (!m.name || m.name.length < 2) continue;

    // Determine ZIP for this member
    let memberZip = inferZipFromAddress(m.address) || zip;

    // Geocode if we have an address and no lat/lon yet
    if (m.address && !m.lat && i % 5 === 0) { // geocode every 5th to be polite
      await sleep(1100); // Nominatim 1/sec
      const geo = await geocodeMember(m.address, city, state);
      if (geo) { m.lat = geo.lat; m.lon = geo.lon; }
    }

    const result = mergeIntoZipFile(memberZip, m, entry.name);
    if      (result === 'added')    added++;
    else if (result === 'enriched') enriched++;
    else                            skipped++;

    if (i % 20 === 0 && i > 0) await sleep(300); // occasional pause
  }

  console.log(`[ChamberDiscovery] Done — added:${added} enriched:${enriched} skipped:${skipped}`);
  return { added, enriched, skipped, total: members.length, chamber: entry.name };
}

// ── CLI mode ─────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = {};
  process.argv.slice(2).forEach((v, i, arr) => {
    if (v.startsWith('--')) args[v.slice(2)] = arr[i + 1];
  });
  if (!args.zip || !args.city) {
    console.error('Usage: node chamberDiscovery.js --zip 32256 --city Jacksonville --state FL');
    process.exit(1);
  }
  discoverAndImport({ zip: args.zip, city: args.city, state: args.state || 'FL' })
    .then(stats => { console.log('Result:', stats); process.exit(0); })
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { discoverAndImport, loadRegistry };
