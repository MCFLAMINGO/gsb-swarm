/**
 * yellowPagesScraper.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scrapes YellowPages.com by city+category to bulk-enrich LocalIntel.
 * No API key. Returns name, phone, address, website, category.
 *
 * Strategy:
 *   - Iterate city × category combinations for each covered area
 *   - Parse structured LD+JSON + HTML for phone, address, website
 *   - Merge into ZIP data files by name match or address geocode
 */

'use strict';

const https  = require('https');
const http   = require('http');
const path   = require('path');
const fs     = require('fs');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const { computeConfidence } = require('../lib/computeConfidence');
const { stamp } = require('../lib/categoryNormalizer');
const ZIPS_DIR  = path.join(DATA_DIR, 'zips');  // flat-array format, matches zipAgent + MCP

// Infer OSM-style category from business name when schema.org type is generic 'LocalBusiness'
function inferCategoryFromName(name) {
  const n = (name || '').toLowerCase();
  if (/dental|dentist|dds|dmg|smile|orthodont|endodont|periodon|oral surgeon/.test(n)) return 'dentist';
  if (/pharmacy|drug store|rx |apothecary/.test(n))                                  return 'chemist';
  if (/pizza|sushi|grill|restaurant|bistro|diner|kitchen|steakhouse|seafood|barbecue|bbq|taco|burger|eatery|tavern|grille|cantina|trattoria|chophouse/.test(n)) return 'restaurant';
  if (/\bbar\b|pub |brewery|taproom|cocktail|lounge/.test(n))                       return 'bar';
  if (/\bcoffee\b|espresso|roastery/.test(n))                                       return 'cafe';
  if (/hotel|inn |\bresort\b|\blodge\b|marriott|hilton|hyatt|westin|sheraton/.test(n)) return 'hotel';
  if (/fitness|crossfit|yoga|pilates|hiit|boot.?camp|orangetheory|anytime fitness|planet fitness/.test(n)) return 'fitness_centre';
  if (/massage|medspa|med spa|aesthetics|wellness center/.test(n))                  return 'beauty';
  if (/hair salon|hair studio|barber|nail |lash |blow dry/.test(n))                 return 'hairdresser';
  if (/realt|real estate|properties|homes |remax|keller williams|coldwell|century 21|compass realty|exp realty|berkshire/.test(n)) return 'estate_agent';
  if (/mortgage|wealth management|financial advisor|investment advisor|insurance|allstate|state farm|nationwide|farmers ins/.test(n)) return 'finance';
  if (/\bbank\b|credit union|fcu|federal savings|suntrust|truist|regions|ameris|hancock/.test(n)) return 'bank';
  if (/attorney|law firm|\blegal\b|litigation|\bllp\b|\bpa\b| esq/.test(n))       return 'legal';
  if (/urgent care|walk.?in|\bclinic\b|physician|\bmd\b|\bdo\b|medical group|health center|cardio|ortho|derma|pediatric|ob.gyn/.test(n)) return 'clinic';
  if (/veterinar|animal hospital|\bvet\b|pet clinic/.test(n))                       return 'veterinary';
  if (/child care|childcare|daycare|day care|preschool|montessori|learning center/.test(n)) return 'childcare';
  if (/landscap|lawn care|lawn service|tree service|irrigation/.test(n))            return 'landscaping';
  if (/plumb/.test(n))                                                               return 'plumber';
  if (/electri/.test(n))                                                             return 'electrician';
  if (/contractor|construction|builder|renovate|remodel/.test(n))                   return 'contractor';
  if (/auto repair|tire |car wash|mechanic|oil change|transmiss/.test(n))           return 'car_repair';
  if (/self.?storage|storage unit/.test(n))                                         return 'storage';
  if (/dry.?clean|laundry/.test(n))                                                 return 'dry_cleaning';
  if (/\bchurch\b|lutheran|baptist|presbyterian|methodist|catholic|episcopal|worship/.test(n)) return 'place_of_worship';
  return null; // keep as LocalBusiness if unknown
}
const DELAY_MS = 1500;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Cities + their primary ZIPs for SJC/Duval coverage
const CITY_ZIP_MAP = {
  'ponte-vedra-beach-fl': ['32081', '32082'],
  'nocatee-fl':           ['32081'],
  'saint-augustine-fl':   ['32092', '32095', '32084', '32086'],
  'jacksonville-fl':      ['32207', '32205', '32246', '32223', '32244', '32210', '32218', '32256', '32257', '32258', '32225'],
  'orange-park-fl':       ['32065', '32073'],
  'fleming-island-fl':    ['32003'],
  'middleburg-fl':        ['32068'],
  'fruit-cove-fl':        ['32259'],
};

// Categories to pull — covers most business types
const CATEGORIES = [
  'restaurants',
  'bars',
  'coffee',
  'grocery-stores',
  'pharmacies',
  'dentists',
  'doctors',
  'hair-salons',
  'gyms',
  'banks',
  'gas-stations',
  'auto-repair',
  'real-estate',
  'insurance',
  'lawyers',
  'accountants',
  'hotels',
  'contractors',
  'electricians',
  'plumbers',
  'landscaping',
  'pet-services',
  'child-care',
  'urgent-care',
  'dry-cleaning',
];

function fetchRaw(url, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Resolve relative redirects against the original URL
        let loc = res.headers.location;
        if (loc.startsWith('/')) loc = `https://www.yellowpages.com${loc}`;
        return resolve(fetchRaw(loc, timeoutMs));
      }
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: '' }); });
  });
}

// Parse YellowPages search results page
function parseYPResults(html, category) {
  const businesses = [];

  // Try structured LD+JSON first (most reliable)
  const ldBlocks = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ldBlocks) {
    try {
      const inner = block.replace(/<[^>]+>/g, '');
      const parsed = JSON.parse(inner);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item['@type'] === 'LocalBusiness' || item['@type'] === 'Restaurant' ||
            item['@type'] === 'MedicalBusiness' || item['@type'] === 'HealthAndBeautyBusiness') {
          const addr = item.address || {};
          businesses.push({
            name:     item.name,
            phone:    item.telephone || null,
            website:  item.url || null,
            address:  [addr.streetAddress, addr.addressLocality, addr.addressRegion, addr.postalCode]
                        .filter(Boolean).join(', ') || null,
            zip:      addr.postalCode || null,
            category: (item['@type'] === 'LocalBusiness' ? (inferCategoryFromName(item.name) || 'LocalBusiness') : item['@type']) || category,
            hours:    (() => {
              const raw = item.openingHours ? (Array.isArray(item.openingHours) ? item.openingHours.join(', ') : item.openingHours) : null;
              if (!raw) return null;
              // Sanitize: valid hours look like "Mo-Fr 09:00-17:00"
              // Reject anything containing JSON artifacts (Monkey, isFlock, isAm, {, })
              const s = String(raw).trim();
              const isClean = /^[A-Z][a-z]/.test(s) && s.length < 200
                && !s.includes('{') && !s.includes('}')
                && !s.includes('Monkey') && !s.includes('isFlock')
                && !s.includes('isAm') && !s.includes('":');
              return isClean ? s : null;
            })(),
            source:   'yellowpages',
          });
        }
      }
    } catch (_) {}
  }

  // Fallback: HTML parsing for listing cards
  if (businesses.length === 0) {
    const cardRegex = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]*class="[^"]*result[^"]*"|$)/gi;
    let m;
    while ((m = cardRegex.exec(html)) !== null) {
      const card = m[1];

      const nameMatch = card.match(/<a[^>]*class="[^"]*business-name[^"]*"[^>]*>[\s\S]*?<span[^>]*>([^<]+)<\/span>/i)
        || card.match(/<span[^>]*class="[^"]*business-name[^"]*"[^>]*>([^<]+)<\/span>/i);
      if (!nameMatch) continue;

      const phoneMatch = card.match(/\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/);
      const zipMatch   = card.match(/\b(3[0-3]\d{3})\b/);
      const webMatch   = card.match(/href="(https?:\/\/(?!www\.yellowpages)[^"]+)"[^>]*>[^<]*[Ww]ebsite/i);

      businesses.push({
        name:     nameMatch[1].trim(),
        phone:    phoneMatch ? phoneMatch[0] : null,
        website:  webMatch ? webMatch[1] : null,
        zip:      zipMatch ? zipMatch[1] : null,
        category,
        source:   'yellowpages',
      });
    }
  }

  return businesses;
}

// Infer ZIP from address string
function inferZip(address) {
  if (!address) return null;
  const m = address.match(/\b(3[0-3]\d{3})\b/);
  return m ? m[1] : null;
}

// Merge YP business into ZIP data file — flat array in data/zips/{zip}.json (matches zipAgent + MCP)
function mergeIntoZipFile(zipCode, biz) {
  if (!zipCode || !/^\d{5}$/.test(zipCode)) return 'skipped'; // guard malformed ZIPs
  if (!fs.existsSync(ZIPS_DIR)) fs.mkdirSync(ZIPS_DIR, { recursive: true });
  const filePath = path.join(ZIPS_DIR, `${zipCode}.json`);
  let data = [];
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      data = Array.isArray(raw) ? raw : (raw.businesses || []);
    } catch (_) {}
  }

  const nameLower = biz.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const existing = data.find(b => {
    const bLower = (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return bLower === nameLower || bLower.includes(nameLower) || nameLower.includes(bLower);
  });

  const now = new Date().toISOString();

  if (existing) {
    let changed = false;
    if (!existing.phone   && biz.phone)   { existing.phone   = biz.phone;   changed = true; }
    if (!existing.website && biz.website) { existing.website = biz.website; changed = true; }
    if (!existing.hours   && biz.hours)   { existing.hours   = biz.hours;   changed = true; }
    // Stamp category_group if missing — heals older records on every enrichment pass
    if (stamp(existing)) changed = true;
    if (changed) {
      existing.last_enriched = now;
      existing.yp_source = true;
      existing.confidence = computeConfidence(existing);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    }
    return changed ? 'enriched' : 'skipped';
  } else {
    const newBiz = {
      name:         biz.name,
      phone:        biz.phone || null,
      website:      biz.website || null,
      address:      biz.address || null,
      hours:        biz.hours || null,
      category:     biz.category || 'business',
      zip:          zipCode,
      lat:          null,
      lon:          null,
      source:       'yellowpages',
      yp_source:    true,
      added_at:     now,
      last_enriched: now,
    };
    stamp(newBiz); // always stamp on creation
    newBiz.confidence = computeConfidence(newBiz);
    data.push(newBiz);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return 'added';
  }
}

// ── Main bulk scrape ─────────────────────────────────────────────────────────
async function bulkScrapeYellowPages(options = {}) {
  const cities     = options.cities     || Object.keys(CITY_ZIP_MAP);
  const categories = options.categories || CATEGORIES;

  let added = 0, enriched = 0, skipped = 0, totalPages = 0;

  for (const city of cities) {
    const defaultZips = CITY_ZIP_MAP[city] || [];

    for (const cat of categories) {
      // Page 1
      for (let page = 1; page <= 10; page++) {
        const url = page === 1
          ? `https://www.yellowpages.com/${city}/${cat}`
          : `https://www.yellowpages.com/${city}/${cat}?page=${page}`;

        console.log(`[YP] ${city} / ${cat} p${page}`);
        const { status, body } = await fetchRaw(url);

        if (status !== 200) {
          if (status === 404) break; // no more pages
          await sleep(DELAY_MS * 2);
          continue;
        }

        const businesses = parseYPResults(body, cat);
        if (businesses.length === 0) break; // no results on this page

        totalPages++;

        for (const biz of businesses) {
          const zip = biz.zip || inferZip(biz.address) || defaultZips[0];
          if (!zip) { skipped++; continue; }

          const result = mergeIntoZipFile(zip, biz);
          if      (result === 'added')    added++;
          else if (result === 'enriched') enriched++;
          else                            skipped++;
        }

        await sleep(DELAY_MS);
        if (businesses.length < 10) break; // sparse page = last page
      }

      await sleep(DELAY_MS);
    }
  }

  console.log(`[YP] Done — pages: ${totalPages}, added: ${added}, enriched: ${enriched}, skipped: ${skipped}`);
  return { added, enriched, skipped, totalPages };
}

// ── Single-business lookup (for enrichmentAgent Source 5) ───────────────────
async function lookupYellowPages(bizName, city = 'ponte-vedra-beach-fl') {
  try {
    const q = encodeURIComponent(bizName);
    const url = `https://www.yellowpages.com/search?search_terms=${q}&geo_location_terms=${encodeURIComponent(city.replace(/-fl$/, ', FL').replace(/-/g, ' '))}`;
    const { status, body } = await fetchRaw(url);
    if (status !== 200) return null;

    const results = parseYPResults(body, 'business');
    if (!results.length) return null;

    const nameLower = bizName.toLowerCase().replace(/[^a-z0-9]/g, '');
    return results.find(r => {
      const rLower = r.name.toLowerCase().replace(/[^a-z0-9]/g, '');
      return rLower === nameLower || rLower.includes(nameLower) || nameLower.includes(rLower);
    }) || results[0];
  } catch (_) { return null; }
}

// ── Express router ───────────────────────────────────────────────────────────
const express = require('express');
const router  = express.Router();

router.post('/bulk-scrape', async (req, res) => {
  const { cities, categories } = req.body || {};
  res.json({ status: 'started', message: 'YellowPages bulk scrape running in background' });
  bulkScrapeYellowPages({ cities, categories }).then(stats => {
    console.log('[YP] Bulk scrape finished:', stats);
  }).catch(err => console.error('[YP] Error:', err));
});

router.get('/status', (req, res) => {
  res.json({ source: 'yellowpages', cities: Object.keys(CITY_ZIP_MAP), categories: CATEGORIES.length });
});

module.exports = { lookupYellowPages, bulkScrapeYellowPages, router };
