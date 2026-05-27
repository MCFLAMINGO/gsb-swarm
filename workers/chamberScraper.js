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
const { CHAMBER_DIRECTORY, getChambersForZip } = require('./chamberDirectory');
const BASE_URL   = 'https://business.sjcchamber.com';
const DELAY_MS   = 1200; // polite crawl delay

// Only scrape chambers with working parsers — unknown needs custom extractors
const SCRAPEABLE_PARSERS = new Set(['growthzone', 'chambermaster']);

// Postgres direct write (non-fatal if DB unavailable)
let _db = null;
function getDb() {
  if (!_db && process.env.LOCAL_INTEL_DB_URL) {
    try { _db = require('../lib/db'); } catch (_) {}
  }
  return _db;
}

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

// ── Upsert Chamber member directly to Postgres ───────────────────────────────
async function upsertToPostgres(zipCode, business) {
  const db = getDb();
  if (!db) return 'skipped';
  try {
    const { created } = await db.upsertBusiness({
      name:             business.name,
      zip:              zipCode,
      address:          business.address || null,
      city:             null,
      phone:            business.phone   || null,
      website:          business.website || null,
      hours:            business.hours   || null,
      category:         business.category || 'business',
      category_group:   'services',
      status:           'active',
      lat:              business.lat     || null,
      lon:              business.lon     || null,
      confidence_score: 0.82,
      tags:             [],
      description:      business.description || null,
      source_id:        'chamber',
      source_weight:    0.5,
      source_raw:       null,
    });
    return created ? 'added' : 'enriched';
  } catch (e) {
    console.warn(`[ChamberScraper] Postgres upsert error (${business.name}):`, e.message);
    return 'skipped';
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
        // No hardcoded ZIP fallback — let the reverse geocode resolve or skip
        zip = null;
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

    const result = await upsertToPostgres(zip, m);
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

// ── Scrape a single chamber using its directory URL ─────────────────────────
async function scrapeChamber(chamber) {
  const { name, url, parser, zips } = chamber;
  console.log(`[ChamberScraper] Scraping ${name} (${parser}) — ${zips.length} ZIPs`);

  const { status, body } = await fetchRaw(url);
  if (status !== 200) {
    console.log(`[ChamberScraper] HTTP ${status} on ${url} — skipping`);
    return { added: 0, enriched: 0, skipped: 0 };
  }

  const members = parseListingCard(body);
  console.log(`[ChamberScraper] ${name}: parsed ${members.length} members`);

  let added = 0, enriched = 0, skipped = 0;
  for (const m of members) {
    // Infer ZIP from address — fallback to first ZIP in chamber's coverage
    let zip = null;
    if (m.address) {
      const zipMatch = m.address.match(/\b(\d{5})\b/);
      if (zipMatch && zips.includes(zipMatch[1])) zip = zipMatch[1];
    }
    if (!zip) zip = zips[0]; // fallback to primary ZIP
    if (!zip) { skipped++; continue; }

    const result = await upsertToPostgres(zip, { ...m, source: `chamber_${chamber.county.toLowerCase().replace(/\s+/g,'_')}` });
    if      (result === 'added')    added++;
    else if (result === 'enriched') enriched++;
    else                            skipped++;
    await sleep(300);
  }

  console.log(`[ChamberScraper] ${name} done — added:${added} enriched:${enriched} skipped:${skipped}`);
  return { added, enriched, skipped };
}

// ── Mark a chamber as scraped in Postgres KV ─────────────────────────────────
async function markChamberDone(chamberKey) {
  const db = getDb();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO chamber_scraper_state (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [`chamber_scraped_${chamberKey}`, JSON.stringify({ ts: new Date().toISOString() })]
    );
  } catch (_) {}
}

async function isChamberDone(chamberKey) {
  const db = getDb();
  if (!db) return false;
  try {
    const rows = await db.query(
      `SELECT value FROM chamber_scraper_state WHERE key = $1`, [`chamber_scraped_${chamberKey}`]
    );
    if (!rows.length) return false;
    const { ts } = JSON.parse(rows[0].value);
    // Re-scrape after 30 days
    return (Date.now() - new Date(ts).getTime()) < 30 * 24 * 60 * 60 * 1000;
  } catch (_) { return false; }
}

// ── Worker loop — iterates all scrapeable chambers, then sleeps 24h ───────────
async function workerLoop() {
  console.log('[ChamberScraper] Worker started — FL-wide chamber directory mode');
  const scrapeable = CHAMBER_DIRECTORY.filter(c => SCRAPEABLE_PARSERS.has(c.parser));
  console.log(`[ChamberScraper] ${scrapeable.length} scrapeable chambers (growthzone/chambermaster), ${CHAMBER_DIRECTORY.length - scrapeable.length} skipped (unknown/custom)`);

  while (true) {
    let didWork = false;
    for (const chamber of scrapeable) {
      const key = `${chamber.state}_${chamber.county}`.toLowerCase().replace(/[^a-z0-9]/g, '_');
      const done = await isChamberDone(key);
      if (done) {
        console.log(`[ChamberScraper] Skip ${chamber.name} (scraped within 30 days)`);
        continue;
      }
      try {
        await scrapeChamber(chamber);
        await markChamberDone(key);
        didWork = true;
      } catch (e) {
        console.error(`[ChamberScraper] Error scraping ${chamber.name}:`, e.message);
      }
      await sleep(DELAY_MS * 2); // polite gap between chambers
    }

    if (!didWork) {
      console.log('[ChamberScraper] All chambers up to date — sleeping 24h');
    } else {
      console.log('[ChamberScraper] Pass complete — sleeping 24h');
    }
    await sleep(24 * 60 * 60 * 1000); // 24 hours
  }
}

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
  } else {
    // Forked as worker by index.js — run the loop
    workerLoop().catch(err => {
      console.error('[ChamberScraper] Fatal:', err.message);
      process.exit(1);
    });
  }
}

module.exports = { enrichFromChamber, bulkImport, router };
