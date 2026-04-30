'use strict';
/**
 * bbbScraper.js — BBB Business Discovery + Enrichment
 *
 * Two modes:
 *   1. BULK DISCOVERY  — search BBB by ZIP, pull all accredited businesses,
 *                        merge into data/zips/{zip}.json as net-new records
 *   2. SINGLE LOOKUP   — enrichFromBBB(bizName, zip) — used by enrichmentAgent
 *
 * BBB accredited businesses are higher quality: verified address, phone, category,
 * years in business, complaints data. Great signal for "real, operating businesses."
 *
 * Rate limit: polite 1.5s delay between requests, no API key needed.
 */

const fs   = require('fs');
const path = require('path');
const http = require('https');
const { stamp } = require('../lib/categoryNormalizer');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');

const DELAY_MS   = 1500;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// Postgres direct write (non-fatal if DB unavailable)
let _db = null;
function getDb() {
  if (!_db && process.env.LOCAL_INTEL_DB_URL) {
    try { _db = require('../lib/db'); } catch (_) {}
  }
  return _db;
}

// ZIP → BBB location search params
// BBB uses city+state in URL and geo proximity
const ZIP_CITY_MAP = {
  '32081': 'Nocatee',
  '32082': 'Ponte Vedra Beach',
  '32092': 'Saint Johns',
  '32084': 'Saint Augustine',
  '32086': 'Saint Augustine',
  '32095': 'Ponte Vedra',
  '32065': 'Orange Park',
  '32073': 'Orange Park',
  '32003': 'Fleming Island',
  '32068': 'Middleburg',
  '32259': 'Fruit Cove',
  '32207': 'Jacksonville',
  '32205': 'Jacksonville',
  '32246': 'Jacksonville',
  '32223': 'Jacksonville',
  '32244': 'Jacksonville',
  '32210': 'Jacksonville',
  '32218': 'Jacksonville',
  '32256': 'Jacksonville',
  '32257': 'Jacksonville',
  '32258': 'Jacksonville',
  '32225': 'Jacksonville',
};

// ── HTTP fetch ────────────────────────────────────────────────────────────────

function fetchRaw(url, extraHeaders = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const req = http.get(url, {
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
        ...extraHeaders,
      },
      timeout: timeoutMs,
    }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTML parsers ──────────────────────────────────────────────────────────────

function extractText(html, pattern) {
  const m = html.match(pattern);
  return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') : null;
}

function extractPhone(html) {
  // BBB phone patterns
  const patterns = [
    /"telephone":"([^"]+)"/,
    /tel:(\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/,
    /phone[^>]*>([^<]*\d{3}[^<]*\d{4}[^<]*)</i,
    /(\(\d{3}\)\s*\d{3}-\d{4})/,
    /(\d{3}[-.\s]\d{3}[-.\s]\d{4})/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      const phone = m[1].trim();
      if (phone.replace(/\D/g, '').length >= 10) return phone;
    }
  }
  return null;
}

function extractAddress(html) {
  // JSON-LD structured data
  const ldMatch = html.match(/"streetAddress"\s*:\s*"([^"]+)"/);
  const cityMatch = html.match(/"addressLocality"\s*:\s*"([^"]+)"/);
  const stateMatch = html.match(/"addressRegion"\s*:\s*"([^"]+)"/);
  const zipMatch = html.match(/"postalCode"\s*:\s*"([^"]+)"/);

  if (ldMatch) {
    const parts = [ldMatch[1]];
    if (cityMatch) parts.push(cityMatch[1]);
    if (stateMatch && zipMatch) parts.push(`${stateMatch[1]} ${zipMatch[1]}`);
    return parts.join(', ');
  }

  // Try meta address
  const metaAddr = html.match(/content="([^"]*(?:Street|Ave|Blvd|Rd|Dr|Ln|Way|Ct)[^"]*,\s*[A-Za-z\s]+,\s*FL[^"]*)"/)
  return metaAddr ? metaAddr[1].trim() : null;
}

function extractWebsite(html) {
  // BBB "Visit Website" link
  const patterns = [
    /"url"\s*:\s*"(https?:\/\/(?!www\.bbb\.org)[^"]+)"/,
    /href="(https?:\/\/(?!www\.bbb\.org|javascript)[^"]+)"[^>]*>(?:Visit Website|website)/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1].trim();
  }
  return null;
}

function extractCategory(html) {
  const m = html.match(/"@type"\s*:\s*"([^"]+)"/);
  if (m && m[1] !== 'Organization' && m[1] !== 'LocalBusiness') return m[1].toLowerCase();
  const catM = html.match(/category[^>]*>([^<]{3,60})</i);
  return catM ? catM[1].trim().toLowerCase() : 'business';
}

// ── Parse BBB search results page ─────────────────────────────────────────────

function parseSearchResults(html) {
  const results = [];

  // BBB search results have structured JSON-LD or data attributes per card
  // Try JSON-LD array first
  const jsonBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of jsonBlocks) {
    try {
      const inner = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
      const data = JSON.parse(inner);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        if (!item.name) continue;
        const addr = item.address || {};
        const address = [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean).join(', ');
        const zip = addr.postalCode || null;
        results.push({
          name:     item.name,
          phone:    item.telephone || null,
          website:  item.url && !item.url.includes('bbb.org') ? item.url : null,
          address:  address || null,
          zip:      zip,
          category: (item['@type'] || 'business').toLowerCase(),
          detail_url: item.url && item.url.includes('bbb.org') ? item.url : null,
        });
      }
    } catch (_) {}
  }

  if (results.length) return results;

  // Fallback: parse business card links
  const cardPattern = /href="(https:\/\/www\.bbb\.org\/us\/fl\/[^"]+\/profile\/[^"]+)"[^>]*>([^<]{2,80})</g;
  let m;
  while ((m = cardPattern.exec(html)) !== null) {
    const name = m[2].trim().replace(/&amp;/g, '&');
    if (name && !results.find(r => r.name === name)) {
      results.push({
        name,
        detail_url: m[1],
        phone: null, website: null, address: null, zip: null, category: 'business',
      });
    }
  }

  return results;
}

// ── Fetch detail page for a single BBB listing ─────────────────────────────────

async function fetchDetail(detailUrl) {
  if (!detailUrl) return {};
  const { status, body } = await fetchRaw(detailUrl);
  if (status !== 200) return {};
  return {
    phone:   extractPhone(body),
    address: extractAddress(body),
    website: extractWebsite(body),
    category: extractCategory(body),
  };
}

// ── Upsert BBB business directly to Postgres ─────────────────────────────────

async function upsertToPostgres(zipCode, biz) {
  if (!zipCode) return 'skipped';
  const db = getDb();
  if (!db) return 'skipped';
  try {
    const category = mapCategory(biz.category);
    const { created } = await db.upsertBusiness({
      name:             biz.name,
      zip:              zipCode,
      address:          biz.address  || null,
      city:             null,
      phone:            biz.phone    || null,
      website:          biz.website  || null,
      hours:            null,
      category,
      category_group:   'services',
      status:           'active',
      lat:              null,
      lon:              null,
      confidence_score: 0.82,
      tags:             [],
      description:      null,
      source_id:        'bbb',
      source_weight:    0.5,
      source_raw:       null,
    });
    return created ? 'added' : 'enriched';
  } catch (e) {
    console.warn(`[BBB] Postgres upsert error (${biz.name}):`, e.message);
    return 'skipped';
  }
}

// Map BBB category strings to our schema
function mapCategory(cat) {
  if (!cat) return 'business';
  const c = cat.toLowerCase();
  if (c.includes('restaurant') || c.includes('food') || c.includes('dining') || c.includes('pizza') || c.includes('sushi')) return 'restaurant';
  if (c.includes('bar') || c.includes('pub') || c.includes('tavern') || c.includes('lounge')) return 'bar';
  if (c.includes('cafe') || c.includes('coffee') || c.includes('bakery')) return 'cafe';
  if (c.includes('dentist') || c.includes('dental')) return 'dentist';
  if (c.includes('doctor') || c.includes('physician') || c.includes('medical') || c.includes('clinic')) return 'clinic';
  if (c.includes('pharmacy') || c.includes('drug store')) return 'pharmacy';
  if (c.includes('gym') || c.includes('fitness') || c.includes('yoga') || c.includes('pilates')) return 'gym';
  if (c.includes('salon') || c.includes('hair') || c.includes('barber') || c.includes('spa') || c.includes('nail')) return 'hairdresser';
  if (c.includes('bank') || c.includes('credit union') || c.includes('financial')) return 'bank';
  if (c.includes('real estate') || c.includes('realtor')) return 'estate_agent';
  if (c.includes('insurance')) return 'insurance';
  if (c.includes('law') || c.includes('attorney') || c.includes('legal')) return 'financial';
  if (c.includes('auto') || c.includes('car repair') || c.includes('mechanic')) return 'car_repair';
  if (c.includes('hotel') || c.includes('motel') || c.includes('inn')) return 'hotel';
  if (c.includes('school') || c.includes('education') || c.includes('tutoring')) return 'school';
  if (c.includes('contractor') || c.includes('construction') || c.includes('plumber') || c.includes('electrician')) return 'office';
  if (c.includes('pet') || c.includes('veterinary') || c.includes('vet')) return 'veterinary';
  return 'office';
}

// ── Bulk discovery per ZIP ────────────────────────────────────────────────────
// Searches BBB for the city, pulls up to 3 pages of results, merges new businesses

async function bulkScrapeZip(zip) {
  const city = ZIP_CITY_MAP[zip];
  if (!city) {
    console.log(`[BBB] No city mapping for ${zip} — skipping`);
    return { added: 0, enriched: 0, skipped: 0 };
  }

  console.log(`[BBB] Scraping ${city} (${zip})...`);
  let added = 0, enriched = 0, skipped = 0;

  // BBB search URL: businesses in city, FL, page N
  for (let page = 1; page <= 4; page++) {
    const url = `https://www.bbb.org/search?find_text=&find_loc=${encodeURIComponent(city + ', FL ' + zip)}&page=${page}`;
    console.log(`[BBB] ${city} p${page}: ${url}`);

    const { status, body } = await fetchRaw(url);
    if (status !== 200) {
      console.log(`[BBB] HTTP ${status} on ${city} p${page} — stopping`);
      break;
    }

    const results = parseSearchResults(body);
    if (results.length === 0) {
      console.log(`[BBB] No results on ${city} p${page} — stopping`);
      break;
    }

    console.log(`[BBB] ${city} p${page}: ${results.length} listings`);

    for (const biz of results) {
      // Determine ZIP — use biz.zip if parseable, else fall back to input zip
      const targetZip = (biz.zip && /^\d{5}$/.test(biz.zip)) ? biz.zip : zip;

      // Fetch detail page if we're missing key fields and have a detail URL
      if ((!biz.phone || !biz.address) && biz.detail_url) {
        await sleep(DELAY_MS);
        const detail = await fetchDetail(biz.detail_url);
        if (detail.phone   && !biz.phone)   biz.phone   = detail.phone;
        if (detail.address && !biz.address) biz.address = detail.address;
        if (detail.website && !biz.website) biz.website = detail.website;
        if (detail.category) biz.category = detail.category;
      }

      const r = await upsertToPostgres(targetZip, biz);
      if      (r === 'added')    { added++;    console.log(`[BBB] + ${biz.name} (${targetZip})`); }
      else if (r === 'enriched') { enriched++; }
      else                       { skipped++;  }

      await sleep(400); // polite delay between businesses
    }

    await sleep(DELAY_MS);
  }

  console.log(`[BBB] ${zip} done — added:${added} enriched:${enriched} skipped:${skipped}`);
  return { added, enriched, skipped };
}

// ── Single-business enrichment (used by enrichmentAgent Source 5) ─────────────

async function enrichFromBBB(bizName, city = 'Ponte Vedra Beach') {
  try {
    const q = encodeURIComponent(`${bizName}`);
    const loc = encodeURIComponent(`${city}, FL`);
    const url = `https://www.bbb.org/search?find_text=${q}&find_loc=${loc}`;
    const { status, body } = await fetchRaw(url);
    if (status !== 200) return null;
    const results = parseSearchResults(body);
    if (!results.length) return null;

    const nameLower = bizName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const best = results.find(r => {
      const rLower = (r.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return rLower === nameLower || rLower.includes(nameLower) || nameLower.includes(rLower);
    }) || results[0];

    // Fetch detail if needed
    if ((!best.phone || !best.address) && best.detail_url) {
      const detail = await fetchDetail(best.detail_url);
      if (detail.phone   && !best.phone)   best.phone   = detail.phone;
      if (detail.address && !best.address) best.address = detail.address;
      if (detail.website && !best.website) best.website = detail.website;
    }

    return best.phone || best.address ? best : null;
  } catch (_) { return null; }
}

// ── Express router ─────────────────────────────────────────────────────────────

const express = require('express');
const router  = express.Router();

let bulkStatus = { running: false, lastRun: null, stats: null };

router.post('/bulk-scrape', async (req, res) => {
  if (bulkStatus.running) return res.json({ status: 'already_running', ...bulkStatus });
  const { zip } = req.body || {};
  res.json({ status: 'started', zip: zip || 'all' });

  bulkStatus.running = true;
  try {
    const zips = zip ? [zip] : Object.keys(ZIP_CITY_MAP);
    let total = { added: 0, enriched: 0, skipped: 0 };
    for (const z of zips) {
      const r = await bulkScrapeZip(z);
      total.added    += r.added;
      total.enriched += r.enriched;
      total.skipped  += r.skipped;
      if (zips.length > 1) await sleep(2000);
    }
    bulkStatus.stats   = total;
    bulkStatus.lastRun = new Date().toISOString();
    console.log(`[BBB] Full run complete — added:${total.added} enriched:${total.enriched}`);
  } catch(e) {
    console.error('[BBB] Bulk scrape error:', e.message);
  } finally {
    bulkStatus.running = false;
  }
});

router.get('/status', (req, res) => res.json(bulkStatus));

// ── CLI: node bbbScraper.js --zip 32082 ───────────────────────────────────────
if (require.main === module) {
  const zipArg = process.argv.find(a => a.match(/^\d{5}$/));
  const allFlag = process.argv.includes('--all');
  if (zipArg) {
    bulkScrapeZip(zipArg).then(r => { console.log('[BBB] Done:', r); process.exit(0); });
  } else if (allFlag) {
    (async () => {
      for (const z of Object.keys(ZIP_CITY_MAP)) {
        await bulkScrapeZip(z);
        await sleep(3000);
      }
      process.exit(0);
    })();
  } else {
    console.log('Usage: node bbbScraper.js 32082  OR  node bbbScraper.js --all');
    process.exit(1);
  }
}

module.exports = { bulkScrapeZip, enrichFromBBB, router };
