/**
 * enrichmentAgent.js
 *
 * Autonomous enrichment agent. Runs every 30 minutes, cycles all per-zip
 * JSON files, finds businesses with confidence < 85, enriches them.
 *
 * Source priority (all free, no paid keys):
 *   1. Yelp public page parse  — review count, rating, phone, hours, categories
 *   2. Foursquare Places free  — 1000 calls/day, phone, hours, website, rating
 *   3. OSM Nominatim           — phone, website, hours (extratags)
 *   4. Phone → 411.com reverse lookup → confirm name + website hint
 *      Name → domain guesser (HEAD requests) → scrape own website
 *      Extracts: hours, menu/services, owner name, events, social links
 *
 * NON-BLOCKING: every source has a timeout. If it fails, log + move on.
 * Foot traffic proxy = yelp review count bucketed into velocity tier.
 *
 * Port: 3007
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const http    = require('http');

const PORT        = 3007;
const DATA_DIR    = path.join(__dirname, '../data');
const ZIPS_DIR    = path.join(DATA_DIR, 'zips');
const ENRICH_LOG  = path.join(DATA_DIR, 'enrichmentLog.json');
const SOURCE_LOG  = path.join(DATA_DIR, 'sourceLog.json');

// Foursquare free tier — 1000 calls/day. Set FSQ_API_KEY in Railway env.
const FSQ_KEY = process.env.FSQ_API_KEY || null;

// ── HTTP helper ───────────────────────────────────────────────────────────────

function fetchRaw(url, opts = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        ...opts.headers,
      },
    };
    const req = lib.get(url, options, (res) => {
      // Follow up to 3 redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, opts, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function fetchJson(url, opts = {}, timeoutMs = 15000) {
  return fetchRaw(url, {
    ...opts,
    headers: { 'Accept': 'application/json', ...opts.headers },
  }, timeoutMs).then(r => {
    try { return { status: r.status, body: JSON.parse(r.body) }; }
    catch (e) { return { status: r.status, body: r.body }; }
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Source log ────────────────────────────────────────────────────────────────

function logSource(zip, source, status, detail) {
  let slog = {};
  if (fs.existsSync(SOURCE_LOG)) {
    try { slog = JSON.parse(fs.readFileSync(SOURCE_LOG)); } catch(e) {}
  }
  if (!slog[zip]) slog[zip] = {};
  slog[zip][source] = { status, detail, checked_at: new Date().toISOString() };
  fs.writeFileSync(SOURCE_LOG, JSON.stringify(slog, null, 2));
}

// ── Source 1: Yelp public page parse ─────────────────────────────────────────
// No API key. Fetches the Yelp search page by name+location, extracts:
//   - review count → foot traffic proxy
//   - rating
//   - phone (often in page JSON-LD)
//   - hours (JSON-LD)
//   - categories

async function yelpPublicSearch(name, lat, lon) {
  // Step 1: search page to get business URL
  const searchUrl = `https://www.yelp.com/search?find_desc=${encodeURIComponent(name)}&find_loc=${lat},${lon}`;
  try {
    const { status, body } = await fetchRaw(searchUrl, {}, 12000);

    if (status === 429 || status === 503) {
      return { blocked: true, reason: `Yelp rate limited (${status})` };
    }
    if (status !== 200) {
      return { blocked: true, reason: `Yelp HTTP ${status}` };
    }

    // Extract first result business URL from page HTML
    const bizUrlMatch = body.match(/href="(\/biz\/[^"?]+)"/);
    if (!bizUrlMatch) return { blocked: false, data: null };

    const bizUrl = `https://www.yelp.com${bizUrlMatch[1]}`;
    await sleep(1200); // polite delay

    // Step 2: fetch business page
    const { status: bizStatus, body: bizBody } = await fetchRaw(bizUrl, {}, 12000);
    if (bizStatus !== 200) return { blocked: false, data: null };

    // Extract JSON-LD structured data (most reliable)
    const jsonLdMatch = bizBody.match(/<script type="application\/ld\+json">(\{[\s\S]*?\})<\/script>/);
    let structured = null;
    if (jsonLdMatch) {
      try { structured = JSON.parse(jsonLdMatch[1]); } catch(e) {}
    }

    // Review count — from JSON-LD or HTML
    let reviewCount = null;
    if (structured && structured.aggregateRating) {
      reviewCount = structured.aggregateRating.reviewCount || null;
    }
    if (!reviewCount) {
      const rcMatch = bizBody.match(/(\d[\d,]+)\s+reviews?/i);
      if (rcMatch) reviewCount = parseInt(rcMatch[1].replace(/,/g, ''));
    }

    // Rating
    let rating = null;
    if (structured && structured.aggregateRating) {
      rating = parseFloat(structured.aggregateRating.ratingValue) || null;
    }

    // Phone — JSON-LD or meta
    let phone = null;
    if (structured && structured.telephone) {
      phone = structured.telephone;
    }
    if (!phone) {
      const phoneMatch = bizBody.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
      if (phoneMatch) phone = phoneMatch[0];
    }

    // Hours — JSON-LD openingHours
    let hours = null;
    if (structured && structured.openingHours) {
      hours = Array.isArray(structured.openingHours)
        ? structured.openingHours.join(', ')
        : structured.openingHours;
    }

    // Website
    let website = null;
    if (structured && structured.url) website = structured.url;

    return {
      blocked: false,
      data: {
        review_count: reviewCount,
        rating,
        phone,
        hours,
        website,
        foot_traffic_proxy: bucketReviewCount(reviewCount),
        yelp_url: bizUrl,
        source: 'yelp_public',
      },
    };
  } catch (err) {
    return { blocked: false, data: null, error: err.message };
  }
}

function bucketReviewCount(count) {
  if (!count) return null;
  if (count > 500) return 'very_high';
  if (count > 200) return 'high';
  if (count > 75)  return 'medium';
  if (count > 20)  return 'low';
  return 'very_low';
}

// ── Source 2: Foursquare Places free tier ────────────────────────────────────
// 1000 free calls/day. Key: FSQ_API_KEY in Railway env.
// Returns: phone, website, hours, rating, categories.

async function foursquareSearch(name, lat, lon) {
  if (!FSQ_KEY) return null;

  const params = new URLSearchParams({
    query: name,
    ll: `${lat},${lon}`,
    radius: 200,
    limit: 1,
    fields: 'name,tel,website,hours,rating,categories,stats',
  });

  try {
    const { status, body } = await fetchJson(
      `https://api.foursquare.com/v3/places/search?${params}`,
      { headers: { Authorization: FSQ_KEY, Accept: 'application/json' } },
      10000
    );

    if (status === 429) {
      console.log('[EnrichmentAgent] Foursquare daily limit hit — skipping for today');
      return null;
    }
    if (status !== 200 || !body.results || body.results.length === 0) return null;

    const place = body.results[0];

    // Confidence check — name must roughly match
    const incomingNorm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const foundNorm = (place.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!foundNorm.includes(incomingNorm.slice(0, 5)) && !incomingNorm.includes(foundNorm.slice(0, 5))) {
      return null; // different business
    }

    // Hours — Foursquare returns structured open/close per day
    let hours = null;
    if (place.hours && place.hours.regular) {
      const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      const byDay = {};
      place.hours.regular.forEach(h => {
        const day = days[h.day] || h.day;
        byDay[day] = `${h.open}-${h.close}`;
      });
      hours = JSON.stringify(byDay);
    }

    return {
      phone:   place.tel    || null,
      website: place.website || null,
      hours,
      rating:  place.rating  || null,
      fsq_visits: place.stats && place.stats.total_tips ? place.stats.total_tips : null,
      source: 'foursquare',
    };
  } catch (err) {
    return null;
  }
}

// ── Source 3: Nominatim extratags (phone, website, hours) ────────────────────

async function nominatimExtratags(name, lat, lon) {
  try {
    await sleep(1100); // 1 req/sec hard limit
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(name)}&lat=${lat}&lon=${lon}&format=json&addressdetails=1&extratags=1&limit=1`;
    const { status, body } = await fetchJson(url, {
      headers: { 'User-Agent': 'LocalIntel-Enrichment/1.0 (localintel.ai)' }
    }, 10000);
    if (status !== 200 || !body || !body.length) return null;
    const extra = body[0].extratags || {};
    return {
      phone:   extra.phone || extra['contact:phone'] || null,
      website: extra.website || extra['contact:website'] || null,
      hours:   extra.opening_hours || null,
      source: 'nominatim',
    };
  } catch (err) {
    return null;
  }
}

// ── Enrich one business ───────────────────────────────────────────────────────

async function enrichBusiness(biz) {
  let changed = false;

  // ── Source 1: Yelp — DISABLED (no key, rate-limited) ────────────────────
  // Re-enable when FSQ_API_KEY or Yelp Fusion key is added to Railway env.

  // ── Source 2: Foursquare — DISABLED (no key) ────────────────────────
  // Re-enable when FSQ_API_KEY is added to Railway env.

  const needsMore = !biz.phone || !biz.hours || !biz.website;

  // ── Source 3: Nominatim extratags (always run as final fallback) ──
  if (!biz.phone || !biz.hours) {
    const nom = await nominatimExtratags(biz.name, biz.lat, biz.lon);
    if (nom) {
      if (!biz.phone   && nom.phone)   { biz.phone = nom.phone; changed = true; }
      if (!biz.website && nom.website) { biz.website = nom.website; changed = true; }
      if (!biz.hours   && nom.hours)   { biz.hours = nom.hours; changed = true; }
      if (changed) biz.confidence = Math.min(82, (biz.confidence || 50) + 5);
      logSource(biz.zip, 'nominatim', 'ok', biz.name);
    }
  }

  // ── Source 4: phone → 411 reverse → domain guess → own website scrape ──
  const s4Changed = await source4WebsiteScrape(biz);
  if (s4Changed) {
    changed = true;
    logSource(biz.zip, 'own_website', 'ok', `${biz.name} → ${biz.scraped_url || biz.website}`);
  }

  if (changed) {
    biz.enriched_at = new Date().toISOString();
    biz.enrichment_sources = [
      (!biz.phone || !biz.hours) ? 'nominatim'   : null,
      biz.scraped_url            ? 'own_website'  : null,
      biz.phone                  ? '411'          : null,
    ].filter(Boolean).join('+') || 'nominatim';
  }

  return { biz, changed };
}

// ── Source 4a: Phone → 411.com reverse lookup ───────────────────────────────
// Confirms business name and surfaces website hint from public directory.

async function reverseLookup411(phone) {
  if (!phone) return null;
  // Normalize: strip non-digits
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  const formatted = `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6,10)}`;

  try {
    const { status, body } = await fetchRaw(
      `https://www.411.com/phone/${formatted}`,
      {}, 10000
    );
    if (status !== 200) return null;

    // Extract business name from page title or h1
    const titleMatch = body.match(/<title>([^<]+)<\/title>/i);
    const h1Match    = body.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    const name = (h1Match && h1Match[1].trim()) ||
                 (titleMatch && titleMatch[1].split('|')[0].trim()) || null;

    // Extract website if present
    const websiteMatch = body.match(/href="(https?:\/\/(?!www\.411)[^"]+)"[^>]*>[^<]*website/i) ||
                         body.match(/class="[^"]*website[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i);
    const website = websiteMatch ? websiteMatch[1] : null;

    // Extract address
    const addrMatch = body.match(/<span[^>]*itemprop="streetAddress"[^>]*>([^<]+)<\/span>/i);
    const address = addrMatch ? addrMatch[1].trim() : null;

    return { name, website, address, source: '411' };
  } catch (err) {
    return null;
  }
}

// ── Source 4b: Name → domain guesser ─────────────────────────────────────────
// Generates candidate domains from business name, tests with HEAD requests.

function generateDomainCandidates(name) {
  // Strip legal suffixes and punctuation
  const clean = name
    .toLowerCase()
    .replace(/\b(llc|inc|corp|co|ltd|the|of|and|&)\b/g, '')
    .replace(/[^a-z0-9\s]/g, '')
    .trim();

  const words = clean.split(/\s+/).filter(Boolean);
  const full  = words.join('');

  // Abbreviation: first letter of each word
  const abbrev = words.map(w => w[0]).join('');

  // Partial: drop words > 8 chars to their first 4
  const partial = words.map(w => w.length > 8 ? w.slice(0, 4) : w).join('');

  const tlds = ['.com', '.net', '.co'];
  const bases = [...new Set([full, partial, abbrev + 'restaurant', abbrev + 'cafe', abbrev])]
    .filter(b => b.length >= 3);

  const candidates = [];
  for (const base of bases.slice(0, 4)) {
    for (const tld of tlds) {
      candidates.push(`https://www.${base}${tld}`);
      candidates.push(`https://${base}${tld}`);
    }
  }
  return [...new Set(candidates)].slice(0, 12); // max 12 attempts
}

async function probeWebsite(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    try {
      const lib = url.startsWith('https') ? https : http;
      const req = lib.request(url, { method: 'HEAD', timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        resolve(res.statusCode < 400 ? url : null);
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch (e) { resolve(null); }
  });
}

async function guessDomain(name, knownWebsite) {
  if (knownWebsite) return knownWebsite; // already have it

  const candidates = generateDomainCandidates(name);
  // Probe in batches of 4 in parallel
  for (let i = 0; i < candidates.length; i += 4) {
    const batch = candidates.slice(i, i + 4);
    const results = await Promise.all(batch.map(url => probeWebsite(url)));
    const found = results.find(r => r !== null);
    if (found) return found;
  }
  return null;
}

// ── Source 4c: Scrape own website ─────────────────────────────────────────────
// Fetches homepage and extracts authoritative business data.

async function scrapeWebsite(url) {
  if (!url) return null;
  try {
    const { status, body } = await fetchRaw(url, {}, 12000);
    if (status !== 200 || typeof body !== 'string') return null;

    const result = {};

    // JSON-LD structured data (most authoritative)
    const jsonLdBlocks = [...body.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/gis)];
    for (const block of jsonLdBlocks) {
      try {
        const ld = JSON.parse(block[1]);
        if (ld.telephone && !result.phone)          result.phone    = ld.telephone;
        if (ld.openingHours && !result.hours)       result.hours    = Array.isArray(ld.openingHours) ? ld.openingHours.join(', ') : ld.openingHours;
        if (ld.name && !result.confirmed_name)      result.confirmed_name = ld.name;
        if (ld.address && !result.address) {
          const a = ld.address;
          result.address = [a.streetAddress, a.addressLocality, a.addressRegion].filter(Boolean).join(', ');
        }
        if (ld.servesCuisine && !result.cuisine)    result.cuisine  = Array.isArray(ld.servesCuisine) ? ld.servesCuisine.join(', ') : ld.servesCuisine;
        if (ld.menu && !result.menu_url)            result.menu_url = ld.menu;
        if (ld.founder && !result.owner_name)       result.owner_name = typeof ld.founder === 'string' ? ld.founder : ld.founder.name;
        if (ld.employee && !result.owner_name) {
          const emp = Array.isArray(ld.employee) ? ld.employee[0] : ld.employee;
          if (emp && emp.name) result.owner_name = emp.name;
        }
      } catch(e) {}
    }

    // Phone from meta / tel links if not in JSON-LD
    if (!result.phone) {
      const telMatch = body.match(/href="tel:([^"]+)"/i);
      if (telMatch) result.phone = decodeURIComponent(telMatch[1]);
    }
    if (!result.phone) {
      const phoneMatch = body.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
      if (phoneMatch) result.phone = phoneMatch[0];
    }

    // Hours from common patterns if not in JSON-LD
    if (!result.hours) {
      const hoursMatch = body.match(/(?:mon|tue|wed|thu|fri|sat|sun)[^<]{5,60}(?:am|pm)/i);
      if (hoursMatch) result.hours = hoursMatch[0].replace(/<[^>]+>/g, '').trim();
    }

    // Social links
    const socials = {};
    const fbMatch  = body.match(/href="(https?:\/\/(?:www\.)?facebook\.com\/[^"?]+)"/);
    const igMatch  = body.match(/href="(https?:\/\/(?:www\.)?instagram\.com\/[^"?]+)"/);
    if (fbMatch) socials.facebook  = fbMatch[1];
    if (igMatch) socials.instagram = igMatch[1];
    if (Object.keys(socials).length) result.socials = socials;

    // Services / menu keywords from visible text (rough signal)
    const stripped = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const serviceMatch = stripped.match(/(?:we offer|our services?|specialt(?:y|ies)|featuring)[^.]{10,120}/i);
    if (serviceMatch) result.services_hint = serviceMatch[0].trim().slice(0, 120);

    result.scraped_at  = new Date().toISOString();
    result.scraped_url = url;
    result.source      = 'own_website';
    return Object.keys(result).length > 3 ? result : null;
  } catch (err) {
    return null;
  }
}

// ── Source 4: full chain — phone → identity → domain → scrape ────────────────

async function source4WebsiteScrape(biz) {
  let changed = false;

  // Step 1: reverse phone lookup → confirm + get website hint
  // Runs if phone is known; if no phone, skip straight to domain guess
  if (biz.phone) {
    const lookup = await reverseLookup411(biz.phone);
    if (lookup) {
      if (!biz.website && lookup.website) { biz.website = lookup.website; changed = true; }
      if (!biz.address && lookup.address) { biz.address = lookup.address; changed = true; }
    }
    await sleep(600);
  }

  // Step 2: domain guess — runs for EVERY business regardless of phone
  // Uses name + existing website hint (if any) to find the real URL
  const resolvedUrl = await guessDomain(biz.name, biz.website);
  if (resolvedUrl && !biz.website) {
    biz.website = resolvedUrl;
    changed = true;
  }
  await sleep(400);

  // Step 3: scrape the website
  if (resolvedUrl) {
    const scraped = await scrapeWebsite(resolvedUrl);
    if (scraped) {
      if (!biz.phone         && scraped.phone)          { biz.phone          = scraped.phone;          changed = true; }
      if (!biz.hours         && scraped.hours)          { biz.hours          = scraped.hours;          changed = true; }
      if (!biz.address       && scraped.address)        { biz.address        = scraped.address;        changed = true; }
      if (!biz.cuisine       && scraped.cuisine)        { biz.cuisine        = scraped.cuisine;        changed = true; }
      if (!biz.menu_url      && scraped.menu_url)       { biz.menu_url       = scraped.menu_url;       changed = true; }
      if (!biz.owner_name    && scraped.owner_name)     { biz.owner_name     = scraped.owner_name;     changed = true; }
      if (!biz.services_hint && scraped.services_hint)  { biz.services_hint  = scraped.services_hint;  changed = true; }
      if (!biz.socials       && scraped.socials)        { biz.socials        = scraped.socials;        changed = true; }
      if (changed) {
        biz.scraped_url = scraped.scraped_url;
        biz.scraped_at  = scraped.scraped_at;
        // Own website is highest-confidence source
        biz.confidence  = Math.min(95, (biz.confidence || 50) + 15);
      }
    }
  }

  return changed;
}

// ── Enrichment cycle ──────────────────────────────────────────────────────────

let stats = { total: 0, enriched: 0, lastRun: null, running: false };

function loadLog()    { try { return JSON.parse(fs.readFileSync(ENRICH_LOG)); } catch(e) { return []; } }
function saveLog(log) { fs.writeFileSync(ENRICH_LOG, JSON.stringify(log.slice(-2000), null, 2)); }

async function enrichmentCycle() {
  if (stats.running) return;
  stats.running = true;
  stats.lastRun = new Date().toISOString();

  if (!fs.existsSync(ZIPS_DIR)) {
    console.log('[EnrichmentAgent] No zips dir yet — waiting for ZipAgent');
    stats.running = false;
    return;
  }

  const zipFiles = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[EnrichmentAgent] Scanning ${zipFiles.length} zip files`);

  const log = loadLog();
  let totalEnriched = 0;
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const file of zipFiles) {
    let businesses;
    try { businesses = JSON.parse(fs.readFileSync(path.join(ZIPS_DIR, file))); }
    catch (e) { continue; }

    const candidates = businesses.filter(b =>
      b.confidence < 85 &&
      !(b.enriched_at && new Date(b.enriched_at).getTime() > oneDayAgo)
    );

    if (!candidates.length) continue;
    console.log(`[EnrichmentAgent] ${file}: ${candidates.length} candidates`);

    let fileChanged = false;
    for (const biz of candidates) {
      try {
        const { biz: enriched, changed } = await enrichBusiness(biz);
        if (changed) {
          Object.assign(biz, enriched);
          totalEnriched++;
          fileChanged = true;
          log.push({
            zip: biz.zip, name: biz.name,
            enrichedAt: new Date().toISOString(),
            confidence: biz.confidence,
            sources: biz.enrichment_sources,
          });
        }
      } catch (err) {
        console.error(`[EnrichmentAgent] Error on ${biz.name}:`, err.message);
      }
      await sleep(400);
    }

    if (fileChanged) {
      fs.writeFileSync(path.join(ZIPS_DIR, file), JSON.stringify(businesses, null, 2));
      console.log(`[EnrichmentAgent] Updated ${file}`);
    }
  }

  stats.total   += zipFiles.length;
  stats.enriched += totalEnriched;
  stats.running  = false;
  console.log(`[EnrichmentAgent] Cycle done — enriched ${totalEnriched} businesses`);
  saveLog(log);
}

// ── Express API ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get('/health', (req, res) => res.json({
  worker: 'enrichmentAgent',
  port: PORT,
  status: stats.running ? 'enriching' : 'idle',
  sources: {
    yelp_public: 'active — HTML parse, no key',
    foursquare:  FSQ_KEY ? 'active — free tier (1000/day)' : 'inactive — set FSQ_API_KEY in Railway env',
    nominatim:   'active — always-on fallback',
    own_website: 'active — phone→411→domain guess→scrape (no key)',  
  },
  stats,
}));

app.post('/run', async (req, res) => {
  res.json({ status: 'dispatched' });
  enrichmentCycle().catch(err => console.error('[EnrichmentAgent]', err));
});

app.get('/log', (req, res) => res.json(loadLog().slice(-100)));

// ── Boot ──────────────────────────────────────────────────────────────────────

const CYCLE_MS = 30 * 60 * 1000; // every 30 minutes

app.listen(PORT, () => {
  console.log(`[EnrichmentAgent] Running on port ${PORT}`);
  console.log(`[EnrichmentAgent] Sources: yelp_public + ${FSQ_KEY ? 'foursquare' : 'foursquare(no key)'} + nominatim + own_website_scrape`);
  enrichmentCycle().catch(err => console.error('[EnrichmentAgent] Init error:', err));
  setInterval(() => enrichmentCycle().catch(err => console.error('[EnrichmentAgent]', err)), CYCLE_MS);
});
