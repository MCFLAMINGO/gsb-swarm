/**
 * chamberScraper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scrapes the St. Johns County Chamber of Commerce member directory:
 *   https://business.sjcchamber.com/member-directory
 *
 * Two modes:
 *   1. BULK IMPORT  — run once, pulls all 841 members, merges into zip JSON files
 *   2. ENRICHMENT   — called per-business by enrichmentAgent to fill phone/hours/website
 *
 * Data available per listing:
 *   name, phone, email, website, address, category, hours, description
 *
 * No API key required. Polite: 1s delay between requests.
 */

'use strict';

const http   = require('http');
const https  = require('https');
const path   = require('path');
const fs     = require('fs');

const DATA_DIR   = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { computeConfidence } = require('../lib/computeConfidence');
const BASE_URL   = 'https://business.sjcchamber.com';
const DELAY_MS   = 1200; // polite crawl delay

// ── Utility: fetch raw HTML ──────────────────────────────────────────────────
function fetchRaw(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LocalIntelBot/1.0; +https://gsb-swarm-production.up.railway.app)',
        'Accept': 'text/html,application/xhtml+xml',
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : BASE_URL + res.headers.location;
        return resolve(fetchRaw(redirectUrl, headers, timeoutMs));
      }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Parse a single listing card from directory HTML ──────────────────────────
function parseListingCard(html) {
  const businesses = [];

  // Each member card contains data-id or a link to Details/
  const cardRegex = /<div[^>]*class="[^"]*gz-member[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*gz-member[^"]*"|$)/gi;
  let match;

  while ((match = cardRegex.exec(html)) !== null) {
    const card = match[1];

    // Name
    const nameMatch = card.match(/<span[^>]*class="[^"]*gz-card-name[^"]*"[^>]*>([^<]+)<\/span>/i)
      || card.match(/<h4[^>]*class="[^"]*gz-name[^"]*"[^>]*>([^<]+)<\/h4>/i)
      || card.match(/<strong[^>]*>([^<]{3,80})<\/strong>/i);
    if (!nameMatch) continue;
    const name = nameMatch[1].trim();

    // Phone
    const phoneMatch = card.match(/tel:([0-9+\-\s().]+)"/i)
      || card.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
    const phone = phoneMatch
      ? (phoneMatch[1] || phoneMatch[0]).replace(/tel:/i, '').trim()
      : null;

    // Website
    const websiteMatch = card.match(/href="(https?:\/\/(?!business\.sjcchamber)[^"]+)"[^>]*>[^<]*[Ww]ebsite/i)
      || card.match(/class="[^"]*gz-card-website[^"]*"[^>]*href="([^"]+)"/i);
    const website = websiteMatch ? websiteMatch[1] : null;

    // Address
    const addrMatch = card.match(/<address[^>]*>([\s\S]*?)<\/address>/i);
    const address = addrMatch
      ? addrMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
      : null;

    // Category
    const catMatch = card.match(/<span[^>]*class="[^"]*gz-card-category[^"]*"[^>]*>([^<]+)<\/span>/i)
      || card.match(/class="[^"]*category[^"]*"[^>]*>([^<]{2,60})<\//i);
    const category = catMatch ? catMatch[1].trim() : null;

    // Detail page URL
    const detailMatch = card.match(/href="(\/member-directory\/Details\/[^"]+)"/i);
    const detailUrl = detailMatch ? BASE_URL + detailMatch[1] : null;

    businesses.push({ name, phone, website, address, category, detailUrl, source: 'sjc_chamber' });
  }

  return businesses;
}

// ── Scrape detail page for hours + description ───────────────────────────────
async function scrapeDetail(url) {
  if (!url) return {};
  const { status, body } = await fetchRaw(url);
  if (status !== 200) return {};

  // Hours — often in a table or dl
  const hoursMatch = body.match(/Hours[^<]*<\/[^>]+>\s*<[^>]+>([^<]{5,200})/i)
    || body.match(/<dt[^>]*>[^<]*[Hh]ours[^<]*<\/dt>\s*<dd[^>]*>([^<]+)<\/dd>/i);
  const hours = hoursMatch ? hoursMatch[1].replace(/\s+/g, ' ').trim() : null;

  // Description
  const descMatch = body.match(/<div[^>]*class="[^"]*gz-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const description = descMatch
    ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 400)
    : null;

  // Phone fallback from detail page
  const phoneMatch = body.match(/tel:([0-9+\-\s().]{10,20})"/i);
  const phone = phoneMatch ? phoneMatch[1].trim() : null;

  return { hours, description, phone };
}

// ── Fetch all members from directory (alphabetical pages A-Z + 0-9) ──────────
async function fetchAllMembers() {
  const terms = ['%23%21']; // %23%21 = #! = "all members"
  const allMembers = [];
  const seen = new Set();

  for (const term of terms) {
    const url = `${BASE_URL}/member-directory/FindStartsWith?term=${term}`;
    console.log(`[ChamberScraper] Fetching: ${url}`);
    const { status, body } = await fetchRaw(url);
    if (status !== 200) {
      console.log(`[ChamberScraper] HTTP ${status} on ${url}`);
      continue;
    }

    const members = parseListingCard(body);
    console.log(`[ChamberScraper] Parsed ${members.length} members from term=${term}`);

    for (const m of members) {
      const key = m.name.toLowerCase().trim();
      if (!seen.has(key)) {
        seen.add(key);
        allMembers.push(m);
      }
    }

    await sleep(DELAY_MS);
  }

  return allMembers;
}

// ── Geocode a business address to lat/lon using Nominatim ───────────────────
async function geocodeAddress(address) {
  if (!address) return null;
  try {
    const q = encodeURIComponent(address + ', St. Johns County, FL');
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    const { status, body } = await fetchRaw(url, {
      'User-Agent': 'LocalIntelBot/1.0 (contact: erik@mcflamingo.com)',
    });
    if (status !== 200) return null;
    const results = JSON.parse(body);
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
  } catch (_) { return null; }
}

// ── Infer ZIP from address string ────────────────────────────────────────────
function inferZip(address) {
  if (!address) return null;
  const zipMatch = address.match(/\b(3208[012]|32095)\b/);
  return zipMatch ? zipMatch[1] : null;
}

// ── Merge Chamber member into ZIP data file ──────────────────────────────────
function mergeIntoZipFile(zipCode, business) {
  const filePath = path.join(DATA_DIR, `${zipCode}.json`);
  let data = { businesses: [] };

  if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) {}
  }

  if (!data.businesses) data.businesses = [];

  // Match by name (case-insensitive, fuzzy)
  const nameLower = business.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const existing = data.businesses.find(b => {
    const bLower = (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return bLower === nameLower || bLower.includes(nameLower) || nameLower.includes(bLower);
  });

  const now = new Date().toISOString();

  if (existing) {
    // Enrich existing record
    let changed = false;
    if (!existing.phone    && business.phone)    { existing.phone    = business.phone;    changed = true; }
    if (!existing.website  && business.website)  { existing.website  = business.website;  changed = true; }
    if (!existing.hours    && business.hours)    { existing.hours    = business.hours;    changed = true; }
    if (!existing.category && business.category) { existing.category = business.category; changed = true; }
    if (!existing.address  && business.address)  { existing.address  = business.address;  changed = true; }
    if (changed) {
      existing.chamber_member   = true;
      existing.chamber_source   = 'sjc_chamber';
      existing.last_enriched    = now;
      existing.confidence       = computeConfidence(existing);
    }
    return changed ? 'enriched' : 'skipped';
  } else {
    // Add as new business
    const newBiz = {
      name:           business.name,
      phone:          business.phone || null,
      website:        business.website || null,
      address:        business.address || null,
      hours:          business.hours || null,
      category:       business.category || 'business',
      zip:            zipCode,
      lat:            business.lat || null,
      lon:            business.lon || null,
      chamber_member: true,
      chamber_source: 'sjc_chamber',
      source:         'sjc_chamber',
      added_at:       now,
      last_enriched:  now,
    };
    newBiz.confidence = computeConfidence(newBiz);
    data.businesses.push(newBiz);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return 'added';
  }
}

// ── BULK IMPORT: scrape all 841 + geocode + merge ───────────────────────────
async function bulkImport() {
  console.log('[ChamberScraper] Starting bulk import of SJC Chamber members...');

  const members = await fetchAllMembers();
  console.log(`[ChamberScraper] Total unique members found: ${members.length}`);

  let added = 0, enriched = 0, skipped = 0, noZip = 0;

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    process.stdout.write(`\r[ChamberScraper] Processing ${i + 1}/${members.length}: ${m.name.slice(0, 40).padEnd(40)}`);

    // Try to get ZIP from address
    let zip = inferZip(m.address);

    // Geocode if no ZIP or no lat/lon
    if (!zip && m.address) {
      await sleep(1100); // Nominatim rate limit: 1/sec
      const geo = await geocodeAddress(m.address);
      if (geo) {
        m.lat = geo.lat;
        m.lon = geo.lon;
        // Default to 32081 for Nocatee/PVB area
        zip = (geo.lat >= 30.05 && geo.lat <= 30.25) ? '32081' : null;
      }
    }

    if (!zip) {
      // Default SJC businesses without a clear ZIP to 32092 (SJC catch-all) — skip for now
      noZip++;
      continue;
    }

    // Optionally scrape detail page for hours (throttled — only for businesses missing hours)
    if (!m.hours && m.detailUrl && i % 10 === 0) {
      await sleep(DELAY_MS);
      const detail = await scrapeDetail(m.detailUrl);
      if (detail.hours)       m.hours       = detail.hours;
      if (detail.description) m.description = detail.description;
      if (detail.phone && !m.phone) m.phone = detail.phone;
    }

    const result = mergeIntoZipFile(zip, m);
    if      (result === 'added')    added++;
    else if (result === 'enriched') enriched++;
    else                            skipped++;

    await sleep(300);
  }

  console.log(`\n[ChamberScraper] Bulk import complete:`);
  console.log(`  Added:    ${added}`);
  console.log(`  Enriched: ${enriched}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  No ZIP:   ${noZip}`);
  return { added, enriched, skipped, noZip, total: members.length };
}

// ── ENRICHMENT: look up a single business by name in Chamber directory ───────
// Checks the correct chamber for the business's ZIP, falls back to SJC.
async function enrichFromChamber(bizName, zip) {
  try {
    const chambers = zip ? getChambersForZip(zip) : [];
    const chamberUrl = chambers.length
      ? chambers[0].url.replace('/FindStartsWith?term=%23%21', '')
      : BASE_URL;

    const q = encodeURIComponent(bizName);
    const url = `${chamberUrl}/member-directory/FindStartsWith?term=${q}`;
    const { status, body } = await fetchRaw(url);
    if (status !== 200) return null;

    const results = parseListingCard(body);
    if (!results.length) return null;

    // Best match — exact name preferred
    const nameLower = bizName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const best = results.find(r => {
      const rLower = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return rLower === nameLower;
    }) || results[0];

    // Fetch detail for hours
    if (best.detailUrl) {
      await sleep(DELAY_MS);
      const detail = await scrapeDetail(best.detailUrl);
      if (detail.hours && !best.hours)             best.hours       = detail.hours;
      if (detail.description && !best.description) best.description = detail.description;
      if (detail.phone && !best.phone)             best.phone       = detail.phone;
    }

    return best;
  } catch (_) { return null; }
}

// ── Express route (mounted by enrichmentAgent / dashboard-server) ─────────────
const express = require('express');
const router  = express.Router();

router.post('/bulk-import', async (req, res) => {
  res.json({ status: 'started', message: 'Chamber bulk import running in background' });
  bulkImport().then(stats => {
    console.log('[ChamberScraper] Bulk import finished:', stats);
  }).catch(err => {
    console.error('[ChamberScraper] Bulk import error:', err);
  });
});

router.get('/status', (req, res) => {
  res.json({ source: 'sjc_chamber', url: BASE_URL + '/member-directory', status: 'active' });
});

// ── CLI: node chamberScraper.js --bulk ───────────────────────────────────────
if (require.main === module) {
  if (process.argv.includes('--bulk')) {
    bulkImport().then(stats => {
      console.log('Done:', stats);
      process.exit(0);
    }).catch(err => {
      console.error(err);
      process.exit(1);
    });
  }
}

module.exports = { enrichFromChamber, bulkImport, router };
