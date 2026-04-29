'use strict';

/**
 * menuFetchAgent.js
 * Fetches a business website/menu page and extracts structured services_json.
 * No LLM — deterministic HTML parsing + pattern matching.
 *
 * Usage:
 *   node workers/menuFetchAgent.js --url https://mcflamingo.com/menu --business-id <uuid>
 *   node workers/menuFetchAgent.js --url https://mcflamingo.com/menu --name "McFlamingo" --zip 32082
 *
 * Or call fetchAndStoreMenu() programmatically.
 *
 * Writes services_json to businesses table in Postgres.
 * Creates services_json column if it doesn't exist.
 */

const db = require('../lib/db');

// ── Price pattern: $12.99 or 12.99 ───────────────────────────────────────────
const PRICE_RE = /\$?\s*(\d{1,3}(?:\.\d{2})?)/;

// ── Cuisine / food tag vocabulary ─────────────────────────────────────────────
const CUISINE_KEYWORDS = {
  'burger':    ['burger','double double','smash','patty','beef','cheeseburger'],
  'chicken':   ['chicken','poultry','wings','tenders','nuggets','grilled chicken'],
  'seafood':   ['fish','seafood','shrimp','salmon','tuna','crab','lobster','oyster','clam'],
  'healthy':   ['healthy','bowl','salad','grain','quinoa','kale','açaí','acai','wrap','lean','fresh','organic','green'],
  'pizza':     ['pizza','pie','calzone','stromboli','slice'],
  'mexican':   ['taco','burrito','enchilada','quesadilla','nacho','fajita','salsa','guac'],
  'italian':   ['pasta','spaghetti','lasagna','ravioli','alfredo','marinara','penne','risotto'],
  'asian':     ['sushi','ramen','pho','thai','chinese','wok','stir fry','dim sum','dumpling','bao'],
  'bbq':       ['bbq','barbeque','barbecue','ribs','brisket','pulled pork','smoked'],
  'sandwich':  ['sandwich','sub','hoagie','panini','club','blt','grinder'],
  'breakfast': ['breakfast','brunch','egg','omelette','pancake','waffle','bacon','french toast'],
  'dessert':   ['dessert','ice cream','gelato','cake','cookie','brownie','cheesecake','pie'],
  'drinks':    ['smoothie','juice','shake','lemonade','coffee','espresso','latte','tea'],
  'vegan':     ['vegan','vegetarian','plant based','plant-based','meatless'],
  'american':  ['american','comfort','classic','homestyle','traditional'],
};

// ── Section header patterns ────────────────────────────────────────────────────
const SECTION_RE = /^(appetizer|starter|entr[eé]e|main|burger|sandwich|salad|soup|side|dessert|drink|beverage|special|combo|breakfast|lunch|dinner|kids)/i;

/**
 * Fetch a URL and return the raw text content (stripped of scripts/styles).
 */
async function fetchPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'LocalIntel Menu Agent/1.0 (thelocalintel.com)',
      'Accept': 'text/html,application/xhtml+xml,*/*',
    },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  const html = await res.text();
  // Strip script, style, nav, footer tags
  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<[^>]+>/g, ' ')      // strip remaining tags
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, '')
    .replace(/\s{2,}/g, '\n')      // collapse whitespace
    .trim();
  return stripped;
}

/**
 * Extract menu items from plain text.
 * Heuristic: lines with a price are likely menu items.
 * Lines before a priced line (within 2 lines) are the item name.
 */
function extractMenuItems(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const items = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const priceMatch = line.match(PRICE_RE);
    if (!priceMatch) continue;

    const price = parseFloat(priceMatch[1]);
    if (price < 1 || price > 200) continue; // filter out non-menu prices

    // Name is usually the line itself (if it has text before the price)
    // or the line just before it
    let name = line.replace(PRICE_RE, '').replace(/[-–—|·•]+$/, '').trim();
    if (name.length < 3 && i > 0) {
      name = lines[i - 1].replace(PRICE_RE, '').trim();
    }
    if (name.length < 3) continue;
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());

    // Description: next line if it doesn't have a price and is long enough
    let description = '';
    if (i + 1 < lines.length && !lines[i + 1].match(PRICE_RE) && lines[i + 1].length > 10) {
      description = lines[i + 1].trim();
    }

    // Tags from name + description
    const combined = (name + ' ' + description).toLowerCase();
    const tags = inferTags(combined);

    items.push({ name, price, description: description || null, tags });
  }

  return items;
}

/**
 * Infer cuisine/diet tags from text.
 */
function inferTags(text) {
  const lower = text.toLowerCase();
  const tags = new Set();
  for (const [tag, keywords] of Object.entries(CUISINE_KEYWORDS)) {
    if (keywords.some(kw => lower.includes(kw))) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Infer top-level cuisine categories from all menu items + page text.
 */
function inferCuisines(items, pageText) {
  const combined = (items.map(i => i.name + ' ' + (i.description || '')).join(' ') + ' ' + pageText).toLowerCase();
  const cuisines = new Set();
  for (const [tag, keywords] of Object.entries(CUISINE_KEYWORDS)) {
    if (keywords.some(kw => combined.includes(kw))) {
      cuisines.add(tag);
    }
  }
  return [...cuisines];
}

/**
 * Detect if page mentions delivery / pickup / online ordering.
 */
function detectCapabilities(text) {
  const lower = text.toLowerCase();
  return {
    delivery: /\bdeliver(y|s|ed|ing)?\b/.test(lower),
    pickup:   /\bpickup\b|\bpick up\b|\bcarryout\b|\bcarry out\b|\bto.?go\b/.test(lower),
    online_ordering: /\border online\b|\bonline order\b|\bplace.{0,10}order\b/.test(lower),
    catering: /\bcater(ing)?\b/.test(lower),
  };
}

/**
 * Find an order URL on the page.
 */
function findOrderUrl(html, baseUrl) {
  const matches = html.match(/href="([^"]*(?:order|menu|cart|checkout)[^"]*)"/gi) || [];
  for (const m of matches) {
    const url = m.replace(/href="/i, '').replace(/"$/, '');
    if (url.startsWith('http')) return url;
    if (url.startsWith('/')) {
      try { return new URL(url, baseUrl).href; } catch {}
    }
  }
  return null;
}

/**
 * Main: fetch a menu URL and return structured services_json.
 */
async function buildServicesJson(url) {
  console.log('[menuFetchAgent] Fetching:', url);
  const res = await fetch(url, {
    headers: { 'User-Agent': 'LocalIntel Menu Agent/1.0 (thelocalintel.com)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, '\n')
    .trim();

  const items      = extractMenuItems(text);
  const cuisines   = inferCuisines(items, text);
  const caps       = detectCapabilities(text);
  const orderUrl   = findOrderUrl(html, url) || url;

  const services = {
    source_url:     url,
    fetched_at:     new Date().toISOString(),
    cuisine:        cuisines,
    menu_items:     items.slice(0, 100), // cap at 100 items
    item_count:     items.length,
    delivery:       caps.delivery,
    pickup:         caps.pickup,
    online_ordering:caps.online_ordering,
    catering:       caps.catering,
    order_url:      orderUrl,
  };

  console.log('[menuFetchAgent] Extracted:', items.length, 'items, cuisines:', cuisines.join(', '));
  return services;
}

/**
 * Fetch menu and store in Postgres businesses table.
 * Matches by business_id (UUID) or by name+zip.
 */
async function fetchAndStoreMenu({ url, businessId, name, zip }) {
  const services = await buildServicesJson(url);

  // Ensure services_json column exists
  await db.query(`
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS services_json JSONB;
    ALTER TABLE businesses ADD COLUMN IF NOT EXISTS menu_fetched_at TIMESTAMPTZ;
  `).catch(e => console.warn('[menuFetchAgent] alter table:', e.message));

  let result;
  if (businessId) {
    result = await db.query(
      `UPDATE businesses SET services_json = $1, menu_fetched_at = NOW()
       WHERE id::text = $2 RETURNING id, name, zip`,
      [JSON.stringify(services), businessId]
    );
  } else if (name && zip) {
    result = await db.query(
      `UPDATE businesses SET services_json = $1, menu_fetched_at = NOW()
       WHERE LOWER(name) LIKE LOWER($2) AND zip = $3 RETURNING id, name, zip`,
      [JSON.stringify(services), `%${name}%`, zip]
    );
  } else {
    throw new Error('Must provide either businessId or name+zip');
  }

  if (!result || result.length === 0) {
    console.warn('[menuFetchAgent] No business matched — services_json not stored in DB');
    console.log('[menuFetchAgent] services_json preview:', JSON.stringify(services, null, 2).slice(0, 500));
    return { stored: false, services };
  }

  console.log('[menuFetchAgent] Stored for:', result[0].name, result[0].zip);
  return { stored: true, business: result[0], services };
}

module.exports = { fetchAndStoreMenu, buildServicesJson, extractMenuItems, inferTags };

// ── CLI entrypoint ─────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);
  const get  = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  const url  = get('--url');
  const id   = get('--business-id');
  const name = get('--name');
  const zip  = get('--zip');

  if (!url) {
    console.error('Usage: node menuFetchAgent.js --url <url> [--business-id <id> | --name <name> --zip <zip>]');
    process.exit(1);
  }

  // If no DB target given, just print what we'd store
  if (!id && !name) {
    buildServicesJson(url)
      .then(s => { console.log('\nservices_json:\n', JSON.stringify(s, null, 2)); process.exit(0); })
      .catch(e => { console.error(e.message); process.exit(1); });
  } else {
    fetchAndStoreMenu({ url, businessId: id, name, zip })
      .then(r => { console.log('\nResult:', JSON.stringify(r, null, 2).slice(0, 800)); process.exit(0); })
      .catch(e => { console.error(e.message); process.exit(1); });
  }
}
