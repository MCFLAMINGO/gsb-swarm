'use strict';
/**
 * Local Intel Agent — GSB Swarm
 *
 * ACP offering: local_intel_query
 * Serves hyperlocal business intelligence for any US zip code.
 *
 * Currently covers: 32081 (Nocatee) + 32082 (Ponte Vedra Beach), FL
 * Expandable: add new zip pulls to the data directory and re-register.
 *
 * Data sources:
 *   - OpenStreetMap (OSM) — named businesses, amenities, services
 *   - US Census ACS 2022 — population, income, housing, rent vs own
 *   - SJC Business Tax Receipts — active licensed businesses (pending)
 *   - FL Sunbiz — registered corporations (pending)
 *
 * Endpoints consumed by ACP jobs:
 *   POST /api/local-intel  { zip, query, category, limit }
 *   GET  /api/local-intel/zones  — spending zone summary
 *   GET  /api/local-intel/stats  — coverage stats
 */

/**
 * Normalized LocalIntel intent shape.
 *
 * Documentation only — no runtime validation, no class, no new file.
 * Every LocalIntel entry path should normalize into this shape before
 * routing or logging: search/ask/MCP, Twilio voice, RFQ SMS/email/callback,
 * and later Siri/Gemini adapter layers.
 *
 * @typedef {Object} LocalIntelIntent
 * @property {'search'|'ask'|'mcp'|'twilio_voice'|'rfq_sms'|'rfq_email'|'rfq_callback'} source
 * Source rail that produced the intent.
 *
 * @property {Object} actor
 * @property {'human'|'business'|'agent'|'provider'} actor.type
 * @property {string|null} actor.phone
 * @property {string|null} actor.email
 * @property {string|null} actor.agent_key
 * @property {string|null} actor.session_id
 * @property {string|null} actor.call_sid
 *
 * @property {string} raw_input
 * Original user text, transcript, SMS body, or inbound email text before routing.
 *
 * @property {Object} command
 * @property {'local_intel'|'voice_order'|'rfq'|'identity'} command.family
 * @property {'query'|'nearby'|'ask'|'oracle'|'place_order'|'service_request'|'rfq_yes'|'rfq_select'|'confirm_email'|'attach_wallet'} command.name
 * Operational command name. Keep adapter-friendly and route-specific.
 * @property {string|null} command.stage
 * Optional current stage for multi-turn flows, e.g. greeting, menu_presented,
 * order_building, order_confirmed.
 *
 * @property {Object} task
 * @property {string|null} task.category
 * @property {string|number|null} task.business_id
 * @property {string|null} task.business_name
 * @property {string|null} task.zip
 * @property {string|null} task.city
 * @property {number|null} task.lat
 * @property {number|null} task.lon
 * @property {number|null} task.radius_miles
 * @property {string|null} task.description
 * @property {Array<Object>} task.items
 * Parsed order items or structured requested items when applicable.
 *
 * @property {Object} task.constraints
 * @property {number|null} task.constraints.budget
 * @property {number|null} task.constraints.eta_minutes
 * @property {string|null} task.constraints.time_window
 *
 * @property {Object} routing
 * @property {'answer'|'business_search'|'pos_router'|'rfq_broadcast'|'identity_update'|'callback_flow'} routing.destination
 * @property {string|null} routing.pos_type
 * Read from businesses.pos_config->>'pos_type' when a business is selected.
 * @property {number|null} routing.confidence
 * Optional normalized confidence score if a handler computes one.
 * @property {string|null} routing.fallback_reason
 * Why the request fell back to RFQ, callback, clarification, or manual handling.
 *
 * @property {Object} delivery
 * @property {'voice'|'sms'|'email'|'json'} delivery.channel
 * @property {boolean} delivery.reply_expected
 * Whether the current channel expects a user reply or next-step interaction.
 */

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { paymentMiddleware } = require('x402-express');
const { declareDiscoveryExtension } = require('@x402/extensions/bazaar');
const { createPublicClient, createWalletClient, http, getAddress, publicActions } = require('viem');
const { base } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const { exact } = require('x402/schemes');

// ── API key middleware (pathUSD + USDC, Postgres-backed) ─────────────────────
const { createApiKeyMiddleware } = require('./lib/apiKeyMiddleware');
const db = require('./lib/db');
const { resolveIntent, detectOpenIntent } = require('./lib/intentMap');
const { resolveIntent: resolveNlIntentFromRegistry } = require('./lib/intentRegistry');
const { isOpenNow } = require('./workers/hoursParseWorker');
const { classifyIntent } = require('./workers/intentRouter');
const { dispatchTask } = require('./lib/taskDispatch');
const apiKeyMiddleware = createApiKeyMiddleware(db);

// Phase 2 — multi-ZIP fanout when caller doesn't pin a ZIP
const TARGET_ZIPS = ['32082','32081','32250','32266','32233','32259','32034'];

// Coerce hours from row → object so isOpenNow can read it. The DB can hand back
// either a JSON string (jsonb-as-text) or a parsed object depending on the column.
function _parseHours(h) {
  if (!h) return null;
  if (typeof h === 'object') return h;
  try { return JSON.parse(h); } catch (_) { return null; }
}

// Phase 2 — category-filter search. Returns flat array (db.query returns array).
async function searchByCategory(intent, zip, limit = 50) {
  const cats = intent.categories;
  const zips = (!zip || zip === 'all') ? TARGET_ZIPS : [zip];
  const sql = `
    SELECT
      business_id, name, address, city, zip, phone, website,
      hours, category, category_group, tags, description, cuisine,
      confidence_score AS confidence, confidence_score, lat, lon, sunbiz_doc_number,
      claimed_at IS NOT NULL AS claimed,
      wallet,
      pos_config->>'pos_type' AS pos_type,
      CASE WHEN wallet IS NOT NULL THEN 1 ELSE 0 END AS has_wallet
    FROM businesses
    WHERE status != 'inactive'
      AND zip = ANY($1::text[])
      AND category = ANY($2::text[])
    ORDER BY has_wallet DESC, confidence_score DESC, name ASC
    LIMIT $3
  `;
  const rows = await db.query(sql, [zips, cats, limit]);
  if (intent.needsOpenNow) {
    return rows.filter(r => {
      const parsed = _parseHours(r.hours);
      const open   = isOpenNow(parsed);
      // Treat unknown (null) as "maybe open" so we don't hide everything
      return open === null || open === true;
    });
  }
  return rows;
}

// Phase 2 — tsvector full-text search.
async function searchByText(query, zip, limit = 50) {
  const tokens = String(query || '').trim().toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const tsq = tokens.join(' & ');
  const zips = (!zip || zip === 'all') ? TARGET_ZIPS : [zip];
  const sql = `
    SELECT
      business_id, name, address, city, zip, phone, website,
      hours, category, category_group, tags, description, cuisine,
      confidence_score AS confidence, confidence_score, lat, lon, sunbiz_doc_number,
      claimed_at IS NOT NULL AS claimed,
      wallet,
      pos_config->>'pos_type' AS pos_type,
      ts_rank(search_vector, to_tsquery('english', $2)) AS rank,
      CASE WHEN wallet IS NOT NULL THEN 1 ELSE 0 END AS has_wallet
    FROM businesses
    WHERE status != 'inactive'
      AND zip = ANY($1::text[])
      AND search_vector @@ to_tsquery('english', $2)
    ORDER BY has_wallet DESC, rank DESC, confidence_score DESC
    LIMIT $3
  `;
  return db.query(sql, [zips, tsq, limit]);
}

// Phase 4 — human-readable reason a business matched the query.
const _CATEGORY_LABELS = {
  bar: 'Bar & cocktails', liquor_store: 'Liquor store',
  restaurant: 'Restaurant', cafe: 'Café', fast_food: 'Fast food',
  grocery: 'Grocery', convenience: 'Convenience store',
  pharmacy: 'Pharmacy', hardware: 'Hardware store',
  gas_station: 'Gas station', car_repair: 'Auto repair',
  pet: 'Pet supplies', veterinary: 'Veterinary',
  beauty: 'Beauty & salon', hairdresser: 'Hair salon',
  fitness: 'Gym & fitness', wellness: 'Spa & wellness',
  laundry: 'Laundry & dry cleaning', florist: 'Florist',
  bank: 'Bank & ATM', hotel: 'Hotel',
  bakery: 'Bakery', deli: 'Deli',
};

function buildMatchReason(biz, intent, query) {
  const parts = [];
  const hours = _parseHours(biz.hours);
  if (hours && isOpenNow(hours) === true) parts.push('Open now');
  if (biz.category && biz.category !== 'LocalBusiness') {
    parts.push(_CATEGORY_LABELS[biz.category] || biz.category);
  }
  if (biz.cuisine) {
    parts.push(biz.cuisine.charAt(0).toUpperCase() + biz.cuisine.slice(1));
  }
  if (biz.wallet) parts.push('✓ Accepts crypto');
  const conf = biz.confidence_score != null ? biz.confidence_score : biz.confidence;
  if (conf != null && conf >= 0.8) parts.push('Verified');
  return parts.slice(0, 3).join(' · ') || null;
}

// Phase 4 — sort results: open first, then claimed (wallet), then confidence.
function sortResults(rows) {
  rows.sort((a, b) => {
    const aHours = _parseHours(a.hours);
    const bHours = _parseHours(b.hours);
    const aOpen = aHours && isOpenNow(aHours) === true ? 1 : 0;
    const bOpen = bHours && isOpenNow(bHours) === true ? 1 : 0;
    if (bOpen !== aOpen) return bOpen - aOpen;
    const aWallet = a.wallet ? 1 : 0;
    const bWallet = b.wallet ? 1 : 0;
    if (bWallet !== aWallet) return bWallet - aWallet;
    const aConf = a.confidence_score != null ? a.confidence_score : (a.confidence || 0);
    const bConf = b.confidence_score != null ? b.confidence_score : (b.confidence || 0);
    return bConf - aConf;
  });
  return rows;
}

// ── x402 payment config ───────────────────────────────────────────────
// TREASURY receives USDC on Base mainnet.
// Agents without a Base wallet still use the Tempo/pathUSD endpoint (/api/local-intel/mcp).
// This x402 gate is ADDITIVE — a second payment rail, not a replacement.
// Base mainnet USDC treasury — separate from Tempo treasury
const X402_TREASURY = process.env.BASE_TREASURY || '0x1447612B0Dc9221434bA78F63026E356de7F30FA';

// ── Self-hosted facilitator (avoids x402.org/facilitator which is testnet-only) ──
// Uses exact.evm.verify (local EIP-3009 sig check) + exact.evm.settle (on-chain USDC transfer).
// TREASURY_PK is used to submit the transferWithAuthorization settlement tx.
// Client is extended with publicActions so exact.evm.settle can call verifyTypedData internally.
const _treasuryRaw = process.env.THROW_TREASURY_PK || '';
const TREASURY_PK  = _treasuryRaw.startsWith('0x') ? _treasuryRaw : (_treasuryRaw ? '0x' + _treasuryRaw : null);

const basePublicClient = createPublicClient({ chain: base, transport: http() });
// Extended wallet = walletClient + publicActions (needed for exact.evm.settle which calls verifyTypedData)
const baseTreasuryWallet = TREASURY_PK
  ? createWalletClient({ account: privateKeyToAccount(TREASURY_PK), chain: base, transport: http() }).extend(publicActions)
  : null;

// Self-facilitator: verify + settle EIP-3009 payments directly on Base
const selfFacilitator = {
  // x402-express calls {url}/verify and {url}/settle — we mount these as routes below
  // and pass the URL to paymentMiddleware
  url: 'http://localhost:3001/api/local-intel/x402-facilitator',
};

// NOTE: Route keys must be router-relative paths (req.path inside mounted router),
// not the full /api/local-intel/* paths. The middleware uses req.path for matching.
const x402Middleware = paymentMiddleware(
  X402_TREASURY,
  {
    'POST /mcp/x402': {
      price: '$0.01',
      network: 'base',
      config: {
        description: 'LocalIntel MCP — standard local business intelligence query. Returns businesses, demographics, sector gaps, and market data for any Florida ZIP code.',
        discoverable: true,
        inputSchema: {
          type: 'object',
          properties: {
            method:  { type: 'string', enum: ['tools/call'] },
            tool:    { type: 'string', description: 'MCP tool name, e.g. local_intel_query, local_intel_ask, local_intel_zone' },
            zip:     { type: 'string', description: 'Target ZIP code (Florida)' },
            query:   { type: 'string', description: 'Natural language query, e.g. "best restaurants near 32082"' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            businesses: { type: 'array',  description: 'Matched business records with name, address, phone, category, confidence' },
            zip:        { type: 'string',  description: 'ZIP code queried' },
            total:      { type: 'number',  description: 'Total businesses in dataset for this ZIP' },
            vertical:   { type: 'string',  description: 'Detected vertical: food, health, retail, auto, legal, financial, etc.' },
          },
        },
        ...declareDiscoveryExtension({
          output: {
            example: { businesses: [{ name: 'Example Cafe', address: '123 Main St, Ponte Vedra Beach, FL', category: 'restaurant', confidence: 85 }], zip: '32082', total: 557, vertical: 'food' },
            schema: {
              type: 'object',
              properties: {
                businesses: { type: 'array' },
                zip:        { type: 'string' },
                total:      { type: 'number' },
                vertical:   { type: 'string' },
              },
            },
          },
        }),
      },
    },
    'POST /mcp/x402/premium': {
      price: '$0.05',
      network: 'base',
      config: {
        description: 'LocalIntel MCP — deep composite analysis. Returns full market brief, spending zones, sector gap analysis, and demographic overlay for a Florida ZIP code.',
        discoverable: true,
        inputSchema: {
          type: 'object',
          properties: {
            zip:   { type: 'string', description: 'Target ZIP code (Florida)' },
            query: { type: 'string', description: 'Deep analysis query' },
          },
        },
        outputSchema: {
          type: 'object',
          properties: {
            brief:         { type: 'object', description: 'Full ZIP market brief with narrative, group breakdown, gaps, and saturation signals' },
            spending_zones: { type: 'array',  description: 'Consumer spending zone scores by sector' },
            demographics:  { type: 'object', description: 'Census ACS demographics: population, income, housing, ownership rate' },
            sector_gaps:   { type: 'array',  description: 'Underserved business categories with opportunity scores' },
          },
        },
        ...declareDiscoveryExtension({
          output: {
            example: { brief: { zip: '32082', label: 'Ponte Vedra Beach', total: 557, narrative: 'Upscale coastal market...' }, spending_zones: [], demographics: { population: 28000, median_hhi: 142000 }, sector_gaps: [{ category: 'urgent_care', score: 0.87 }] },
            schema: {
              type: 'object',
              properties: {
                brief:          { type: 'object' },
                spending_zones: { type: 'array' },
                demographics:   { type: 'object' },
                sector_gaps:    { type: 'array' },
              },
            },
          },
        }),
      },
    },
  },
  selfFacilitator
);

const router = express.Router();

// ── Usage ledger middleware ──────────────────────────────────────────────────────
// Logs every query to Postgres usage_ledger. This is the billing layer.
// caller_id = x-agent-id header | x-api-key first 8 chars | ip
// credits_charged: oracle=1, brief=1, nl-query=5
async function logUsage(callerId, queryType, zip, credits) {
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  try {
    const db = require('./lib/db');
    await db.query(
      `INSERT INTO usage_ledger (caller_id, query_type, zip, credits_charged)
       VALUES ($1, $2, $3, $4)`,
      [callerId, queryType, zip || null, credits]
    );
  } catch (e) { /* non-fatal — never block a query over billing */ }
}
function getCallerId(req) {
  return req.headers['x-agent-id']
    || (req.headers['x-api-key'] ? req.headers['x-api-key'].slice(0,8) : null)
    || req.ip
    || 'anon';
}

// ── Load dataset ──────────────────────────────────────────────────────────────
// In production this would be a DB — for now it's the JSON file written by the pull script
const DATA_PATH = path.join(__dirname, 'data', 'localIntel.json');
const ZONES_PATH = path.join(__dirname, 'data', 'spendingZones.json');
const LEDGER_PATH = path.join(__dirname, 'data', 'usageLedger.json');
const ZIPS_DIR_AGENT = path.join(__dirname, 'data', 'zips');

function loadData() {
  // Merge seed file + all accumulated zip files so tools see the full dataset
  const seen = new Set();
  const all  = [];
  const addBiz = (b) => {
    const key = `${(b.name||'').toLowerCase()}|${b.zip||''}|${b.lat||''}|${b.lon||''}`;
    if (!seen.has(key)) { seen.add(key); all.push(b); }
  };
  try { JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).forEach(addBiz); } catch {}
  try {
    if (fs.existsSync(ZIPS_DIR_AGENT)) {
      fs.readdirSync(ZIPS_DIR_AGENT).filter(f => f.endsWith('.json')).forEach(f => {
        try { JSON.parse(fs.readFileSync(path.join(ZIPS_DIR_AGENT, f), 'utf8')).forEach(addBiz); } catch {}
      });
    }
  } catch {}
  return all;
}

function loadZones() {
  try { return JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); }
  catch { return {}; }
}

// ── Category normalizer ───────────────────────────────────────────────────────
const CATEGORY_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','food_court','alcohol'],
  retail:   ['supermarket','convenience','clothes','shoes','electronics','hairdresser','beauty',
              'chemist','mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre','gym',
              'sports_centre','swimming_pool','yoga'],
  finance:  ['bank','atm','estate_agent','insurance','financial','accountant'],
  civic:    ['school','college','place_of_worship','church','library','post_office',
              'police','fire_station','government','social_centre','community_centre'],
  services: ['fuel','car_wash','car_repair','hotel','motel','office','coworking'],
};

function getGroup(cat) {
  for (const [group, cats] of Object.entries(CATEGORY_GROUPS)) {
    if (cats.includes(cat)) return group;
  }
  return 'other';
}

// ── POST /api/local-intel — main query endpoint ───────────────────────────────
// NL intent → group/tag mapping lives in lib/intentRegistry.js (single source of truth).

router.post('/', async (req, res) => {
  const { zip, query, category, group, limit = 50, minConfidence = 0 } = req.body || {};

  try {
    const db = require('./lib/db');

    // ── Phase 2 — intent-aware search bar path ──────────────────────────────
    // Only kicks in for free-text queries (no explicit category/group filter).
    // ORDER_ITEM falls through to the legacy handler (Basalt order flow lives there).
    if (query && !category && !group) {
      const intent = classifyIntent(query);
      if (intent.type === 'CATEGORY_SEARCH' || intent.type === 'TEXT_SEARCH') {
        try {
          const lim = Math.min(Number(limit) || 50, 200);
          const phase2Rows = intent.type === 'CATEGORY_SEARCH'
            ? await searchByCategory(intent, zip, lim)
            : await searchByText(intent.raw, zip, lim);

          if (phase2Rows && phase2Rows.length > 0) {
            const sorted = sortResults(phase2Rows.slice());
            const enriched = sorted.map(r => {
              const out = { ...r };
              if (r.pos_type === 'other' && r.wallet) {
                out.ucp_order_url = 'https://surge.basalthq.com/api/ucp/checkout-sessions';
                out.ucp_wallet    = r.wallet;
                out.ucp_note      = 'POST ucp_order_url with shopSlug resolved via GET https://surge.basalthq.com/api/directory/shops?q=' + encodeURIComponent(r.name);
              }
              out.matchReason = buildMatchReason(r, intent, query);
              delete out.pos_type;
              delete out.has_wallet;
              delete out.confidence_score;
              return out;
            });
            return res.json({
              ok:       true,
              total:    enriched.length,
              returned: enriched.length,
              zips:     zip ? [zip] : TARGET_ZIPS,
              results:  enriched,
              meta: {
                source:        'postgres+intent',
                intent_type:   intent.type,
                categories:    intent.categories || null,
                needs_open:    !!intent.needsOpenNow,
                matched_keyword: intent.matchedKeyword || null,
                coverage:      '113,684 businesses — Florida statewide',
              },
            });
          }
          // 0 rows from Phase 2 → dispatch as a task to the agent network.
          // ORDER_ITEM intent stays out of the dispatch loop (Basalt order flow handles it).
          if (intent && intent.type !== 'ORDER_ITEM') {
            try {
              const task = await dispatchTask(intent, query, zip);
              return res.json({
                ok: true,
                taskCreated: true,
                taskId: task.task_id,
                message: `We're on it — looking for "${query}" in ${zip || 'your area'}. You'll hear back shortly.`,
                businesses: [],
                results: [],
                total: 0,
                returned: 0,
                meta: {
                  source:     'task_dispatch',
                  gap:        true,
                  gap_query:  query,
                  gap_intent: intent.type || 'DISCOVER',
                },
              });
            } catch (taskErr) {
              console.error('[taskDispatch] failed to create task:', taskErr.message);
              // Fall through to normal empty/legacy response — never block the user.
            }
          }
          // 0 rows → fall through to legacy ILIKE path below
        } catch (phase2Err) {
          console.error('[local-intel phase2 search]', phase2Err.message);
          // fall through to legacy path
        }
      }
    }

    // ── Resolve NL intent ────────────────────────────────────────────────────
    const nlIntent = (!group && !category)
      ? resolveNlIntentFromRegistry(query)
      : { taskClass: null, group: null, tags: null, cuisine: null, category: null, resolvesVia: 'search' };
    const effectiveGroup    = group || nlIntent.group;
    const effectiveCategory = category || nlIntent.category;

    // ── Build Postgres query — all filtering in SQL ──────────────────────────
    const conditions = ["status != 'inactive'"]; // matches active + null, excludes only explicitly inactive
    const params = [];
    let p = 1;

    if (zip) {
      conditions.push(`zip = $${p++}`);
      params.push(zip);
    }
    if (effectiveCategory) {
      conditions.push(`category = $${p++}`);
      params.push(effectiveCategory);
    }
    if (effectiveGroup && !effectiveCategory) {
      // Use the CATEGORY_GROUPS mapping — pass the categories that belong to this group
      const groupCats = CATEGORY_GROUPS[effectiveGroup];
      if (groupCats && groupCats.length) {
        conditions.push(`category = ANY($${p++})`);
        params.push(groupCats);
      }
    }
    if (minConfidence) {
      conditions.push(`confidence_score >= $${p++}`);
      params.push(minConfidence);
    }

    // Cuisine filter — additive when NL intent resolved a cuisine
    if (nlIntent.cuisine) {
      conditions.push(`(cuisine = $${p} OR cuisine ILIKE $${p + 1} OR description ILIKE $${p + 1})`);
      params.push(nlIntent.cuisine);
      params.push(`%${nlIntent.cuisine}%`);
      p += 2;
    }

    // Name/address text search
    let orderBy = 'confidence_score DESC, name ASC';
    if (query && !effectiveGroup && !effectiveCategory) {
      conditions.push(`(
        name ILIKE $${p} OR
        category ILIKE $${p} OR
        address ILIKE $${p} OR
        description ILIKE $${p}
      )`);
      params.push(`%${query}%`);
      p++;
    }

    // Tag boost for semantic queries (e.g. "healthy food")
    let tagBoost = '';
    if (nlIntent.tags && nlIntent.tags.length) {
      tagBoost = `, CASE WHEN tags && $${p++}::text[] THEN 1 ELSE 0 END AS tag_score`;
      params.push(nlIntent.tags);
      orderBy = 'tag_score DESC, confidence_score DESC';
    }

    const lim = Math.min(Number(limit) || 50, 200);
    params.push(lim);

    const sql = `
      SELECT
        business_id, name, address, city, zip, phone, website,
        hours, category, category_group, tags, description, cuisine,
        confidence_score AS confidence, confidence_score, lat, lon, sunbiz_doc_number,
        claimed_at IS NOT NULL AS claimed,
        wallet,
        pos_config->>'pos_type' AS pos_type
        ${tagBoost}
      FROM businesses
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${p}
    `;

    let rawRows = await db.query(sql, params);

    // ── tsvector fallback — main ILIKE returned 0 rows but the user typed a meaningful query ──
    let usedTsFallback = false;
    if ((!rawRows || rawRows.length === 0) && query && typeof query === 'string') {
      const _STOPWORDS = new Set([
        'the','a','an','is','are','can','i','where','get','find','nearest','closest',
        'me','my','to','for','of','in','on','at','or','and','do','you','any','some',
      ]);
      const tokens = String(query).toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t && !_STOPWORDS.has(t));
      if (tokens.length) {
        const tsq = tokens.join(' & ');
        const fbZips = zip ? [zip] : TARGET_ZIPS;
        const fbSql = `
          SELECT
            business_id, name, address, city, zip, phone, website,
            hours, category, category_group, tags, description, cuisine,
            confidence_score AS confidence, confidence_score, lat, lon, sunbiz_doc_number,
            claimed_at IS NOT NULL AS claimed,
            wallet,
            pos_config->>'pos_type' AS pos_type,
            ts_rank(search_vector, to_tsquery('english', $1)) AS rank
          FROM businesses
          WHERE status != 'inactive'
            AND zip = ANY($2::text[])
            AND search_vector @@ to_tsquery('english', $1)
          ORDER BY rank DESC, confidence_score DESC
          LIMIT 20
        `;
        try {
          rawRows = await db.query(fbSql, [tsq, fbZips]);
          usedTsFallback = (rawRows && rawRows.length > 0);
        } catch (tsErr) {
          // Bad tsquery (e.g. reserved chars) — non-fatal, keep empty results
          console.error('[local-intel ts-fallback]', tsErr.message);
          rawRows = [];
        }
      }
    }

    // ── 0-result task dispatch — open the loop to the agent network ──
    // Skip when caller pinned a category/group filter (they got an empty page from a real filter,
    // not a free-text search miss) and when the NL intent looks like ORDER/STATUS (Basalt order
    // flow handles those separately).
    let dispatchedGap = false;
    if ((!rawRows || rawRows.length === 0) && query && !category && !group
        && nlIntent.taskClass !== 'ORDER' && nlIntent.taskClass !== 'STATUS') {
      try {
        const dispatchIntent = {
          type: 'TEXT_SEARCH',
          categories: nlIntent.category ? [nlIntent.category] : [],
          cuisines:   nlIntent.cuisine  ? [nlIntent.cuisine]  : [],
          group:      nlIntent.group    || null,
          taskClass:  nlIntent.taskClass || 'DISCOVER',
          raw:        query,
        };
        // Fire and forget — never block the user response on dispatch.
        Promise.resolve()
          .then(() => dispatchTask(dispatchIntent, query, zip))
          .catch(e => console.error('[taskDispatch legacy 0-result]', e.message));
        dispatchedGap = true;
      } catch (dispatchInitErr) {
        console.error('[taskDispatch legacy init]', dispatchInitErr.message);
      }
    }

    // Enrich rows with UCP order URL for Surge-connected businesses + matchReason
    const rows = (rawRows || []).map(r => {
      const enriched = { ...r };
      if (r.pos_type === 'other' && r.wallet) {
        // Surge shop slug derived from wallet — agents can also use /api/directory/shops to discover
        enriched.ucp_order_url = 'https://surge.basalthq.com/api/ucp/checkout-sessions';
        enriched.ucp_wallet    = r.wallet;
        enriched.ucp_note      = 'POST ucp_order_url with shopSlug resolved via GET https://surge.basalthq.com/api/directory/shops?q=' + encodeURIComponent(r.name);
      }
      try {
        enriched.matchReason = buildMatchReason(r, nlIntent, query);
      } catch (_) {
        enriched.matchReason = null;
      }
      // Remove internal fields agents don't need
      delete enriched.pos_type;
      delete enriched.confidence_score;
      return enriched;
    });

    // ── Notify claimed businesses ────────────────────────────────────────────
    if (zip && effectiveGroup) {
      try {
        const nq = require('./lib/notificationQueue');
        const subject = `Market query in your area — ${zip}`;
        const payload = {
          body: `An agent queried the ${effectiveGroup} market in ZIP ${zip}.`,
          zip, category_group: effectiveGroup,
          cta_url: 'https://thelocalintel.com', cta_label: 'View Details',
        };
        setImmediate(() =>
          nq.enqueueForZipCategory(zip, effectiveGroup, subject, payload)
            .then(n => { if (n > 0) return nq.processQueue(20); })
            .catch(e => console.error('[query-notify]', e.message))
        );
      } catch (notifyErr) {
        console.error('[query-notify-init]', notifyErr.message);
      }
    }

    // Real total: COUNT(*) with same WHERE but no LIMIT — so callers know the full set size.
    // Skip when the tsvector fallback ran (those rows were resolved via search_vector, not the
    // ILIKE WHERE clause built above, so the COUNT would not represent that result set).
    let realTotal = rows.length;
    if (!usedTsFallback) {
      try {
        // countParams = everything except the final LIMIT param
        const countParams  = params.slice(0, -1);
        const countSql     = `SELECT COUNT(*) AS total FROM businesses WHERE ${conditions.join(' AND ')}`;
        const countRows    = await db.query(countSql, countParams);
        realTotal          = parseInt(countRows[0]?.total || rows.length, 10);
      } catch (_) { /* non-fatal — fall back to page size */ }
    }

    res.json({
      ok:       true,
      total:    realTotal,
      returned: rows.length,
      zips:     zip ? [zip] : [],
      results:  rows,
      meta: {
        source:        usedTsFallback ? 'postgres+tsvector' : 'postgres',
        intent_class:  nlIntent.taskClass || null,
        intent_group:  nlIntent.group     || null,
        intent_cuisine: nlIntent.cuisine  || null,
        ts_fallback:   usedTsFallback,
        ...(dispatchedGap && {
          gap:        true,
          gap_query:  query,
          gap_intent: nlIntent.taskClass || 'DISCOVER',
        }),
        coverage:      '113,684 businesses — Florida statewide',
      },
    });
  } catch (e) {
    console.error('[local-intel query]', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/local-intel/zones — spending zone summary ────────────────────────
router.get('/zones', (req, res) => {
  const zones = loadZones();
  res.json({ ok: true, ...zones });
});


// ─── CLAIM ENDPOINTS ──────────────────────────────────────────────────────────

// GET /api/local-intel/claim/lookup?name=&zip=
router.get('/claim/lookup', async (req, res) => {
  const { name, zip } = req.query;
  if (!name && !zip) return res.status(400).json({ error: 'name or zip required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `SELECT business_id, name, address, city, zip, phone, website,
              category, category_group, status, lat, lon,
              sunbiz_doc_number,
              (claimed_at IS NOT NULL) as is_claimed
         FROM businesses
        WHERE status != 'inactive'
          AND ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
          AND ($2::text IS NULL OR zip = $2)
        ORDER BY
          CASE WHEN claimed_at IS NOT NULL THEN 0 ELSE 1 END,
          CASE WHEN lat IS NOT NULL THEN 0 ELSE 1 END,
          name ASC
        LIMIT 10`,
      [name || null, zip || null]
    );
    res.json({ results: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/local-intel/claim/start
router.post('/claim/start', express.json(), async (req, res) => {
  const { business_id, contact_email, contact_phone, carrier,
          notify_sms, notify_email, notify_push, notify_web, wallet } = req.body || {};
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!contact_email && !contact_phone) return res.status(400).json({ error: 'email or phone required' });
  try {
    const db     = require('./lib/db');
    const crypto = require('crypto');
    const nq     = require('./lib/notificationQueue');

    const [biz] = await db.query(
      `SELECT business_id, name, claimed_at FROM businesses WHERE business_id = $1 AND status = 'active'`,
      [business_id]
    );
    if (!biz)           return res.status(404).json({ error: 'business not found' });
    // Already claimed = returning owner. Still send a code so they can re-verify and get their inbox link.
    // Do NOT block here — fall through to send the code.

    const token    = String(Math.floor(100000 + Math.random() * 900000));
    const tokenExp = new Date(Date.now() + 30 * 60 * 1000);

    await db.query(
      `UPDATE businesses SET
         claim_token        = $1, claim_token_exp   = $2,
         notification_phone = $3, notification_email = $4,
         notify_sms = $5, notify_email = $6, notify_push = $7, notify_web = $8,
         wallet = COALESCE($9, wallet)
       WHERE business_id = $10`,
      [token, tokenExp, contact_phone||null, contact_email||null,
       !!notify_sms, !!notify_email, !!notify_push, !!notify_web,
       wallet||null, business_id]
    );

    const verifyChannel = contact_email ? 'email' : 'sms';
    await nq.enqueue(business_id,
      `Your LocalIntel code: ${token}`,
      { body: `Verification code: ${token}. Expires in 30 minutes.`, code: token, carrier: carrier||'verizon' },
      [verifyChannel]
    );
    setImmediate(() => nq.processQueue(5).catch(e => console.error('[notify]', e.message)));
    res.json({ ok: true, channel: verifyChannel, expires_in: 30 });
  } catch (err) {
    console.error('[claim/start]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/local-intel/claim/verify
router.post('/claim/verify', express.json(), async (req, res) => {
  const { business_id, token } = req.body || {};
  if (!business_id || !token) return res.status(400).json({ error: 'business_id and token required' });
  try {
    const db  = require('./lib/db');
    const nq  = require('./lib/notificationQueue');
    const [biz] = await db.query(
      `SELECT business_id, name, claim_token, claim_token_exp, claimed_at, dispatch_token,
              notify_sms, notify_email, notify_push, notify_web
         FROM businesses WHERE business_id = $1 AND status = 'active'`,
      [business_id]
    );
    if (!biz)             return res.status(404).json({ error: 'business not found' });
    if (!biz.claim_token) return res.status(400).json({ error: 'no pending claim' });
    if (biz.claim_token !== String(token)) return res.status(401).json({ error: 'invalid code' });
    if (new Date(biz.claim_token_exp) < new Date()) return res.status(401).json({ error: 'code expired' });

    // Already claimed — returning owner verified. Return their existing inbox link.
    if (biz.claimed_at && biz.dispatch_token) {
      return res.json({
        ok: true,
        returning: true,
        business_id:    biz.business_id,
        name:           biz.name,
        dispatch_token: biz.dispatch_token,
        inbox_url:      `https://www.thelocalintel.com/inbox?token=${biz.dispatch_token}`,
      });
    }

    // Generate a persistent dispatch_token — this is their inbox login, never expires
    const { randomUUID } = require('crypto');
    const dispatchToken = randomUUID();
    // sunbiz_id may be passed from claim flow step 3 (verifyDoc field)
    const sunbizId = req.body?.sunbiz_id || null;
    await db.query(
      `UPDATE businesses
          SET claimed_at = NOW(), claim_token = NULL, claim_token_exp = NULL,
              dispatch_token = $2
              ${sunbizId ? ', sunbiz_id = $3' : ''}
        WHERE business_id = $1`,
      sunbizId ? [business_id, dispatchToken, sunbizId] : [business_id, dispatchToken]
    );

    // Register business in agent_registry so deposit listener can credit their wallet
    // Each business gets a unique deposit address derived deterministically
    const pool = db.getPool ? db.getPool() : db;
    await pool.query(`
      CREATE TABLE IF NOT EXISTS agent_registry (
        token              TEXT PRIMARY KEY,
        label              TEXT,
        type               TEXT NOT NULL DEFAULT 'agent',
        balance_usd_micro  BIGINT NOT NULL DEFAULT 0,
        total_spent_micro  BIGINT NOT NULL DEFAULT 0,
        total_queries      BIGINT NOT NULL DEFAULT 0,
        deposit_address    TEXT,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at       TIMESTAMPTZ
      )
    `);
    await pool.query(`ALTER TABLE agent_registry ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'agent'`);
    // Generate a deterministic deposit address placeholder — real address assigned by Treasury in v2
    const depositAddr = '0x' + Buffer.from(business_id + dispatchToken).toString('hex').slice(0, 40);
    await pool.query(
      `INSERT INTO agent_registry (token, label, type, deposit_address)
       VALUES ($1, $2, 'business', $3)
       ON CONFLICT (token) DO UPDATE SET label = EXCLUDED.label, deposit_address = EXCLUDED.deposit_address`,
      [dispatchToken, biz.name, depositAddr]
    );

    const channels = ['web'];
    if (biz.notify_sms)   channels.push('sms');
    if (biz.notify_email) channels.push('email');
    await nq.enqueue(business_id,
      `Welcome to LocalIntel, ${biz.name}`,
      { body: `Your listing is claimed. You'll receive market intelligence when agents query your area.`, cta_url: 'https://thelocalintel.com', cta_label: 'View Dashboard' },
      channels
    );
    setImmediate(() => nq.processQueue(5).catch(() => {}));
    res.json({ ok: true, claimed: true, business_id, name: biz.name,
      dispatch_token: dispatchToken,
      deposit_address: depositAddr,
      inbox_url: `https://www.thelocalintel.com/inbox?token=${dispatchToken}` });
  } catch (err) {
    console.error('[claim/verify]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/claim/notifications?business_id=&since=
router.get('/claim/notifications', async (req, res) => {
  const { business_id, since } = req.query;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const db   = require('./lib/db');
    const rows = await db.query(
      `SELECT id, channel, subject, payload, status, created_at, sent_at
         FROM notification_queue
        WHERE business_id = $1
          AND ($2::timestamptz IS NULL OR created_at > $2)
        ORDER BY created_at DESC LIMIT 50`,
      [business_id, since || null]
    );
    res.json({ notifications: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/local-intel/claim (legacy — same as /claim/start)
router.post('/claim', express.json(), async (req, res) => {
  res.redirect(307, '/api/local-intel/claim/start');
});

// ── Magic link login ──────────────────────────────────────────────────────────
// POST /api/local-intel/auth/magic
// Body: { email }
// Looks up business by notification_email, sends Resend magic link to inbox.
// Returns { ok: true } regardless (no email enumeration).
router.post('/auth/magic', express.json(), async (req, res) => {
  try {
    const db  = require('./lib/db');
    const nq  = require('./lib/notificationQueue');
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email || !/^[^@]+@[^@]+\.[^@]+$/.test(email)) {
      return res.status(400).json({ error: 'valid email required' });
    }

    // Always return ok — don't reveal whether email exists
    res.json({ ok: true });

    // Look up claimed business by notification_email
    const [biz] = await db.query(
      `SELECT business_id, name, dispatch_token, notification_email
         FROM businesses
        WHERE LOWER(notification_email) = $1
          AND claimed_at IS NOT NULL
          AND status = 'active'
        LIMIT 1`,
      [email]
    );

    if (!biz || !biz.dispatch_token) return; // no match — silent

    const inboxUrl = `https://www.thelocalintel.com/inbox.html?token=${biz.dispatch_token}`;

    // Send directly via Resend — do not use notificationQueue (wrong signature for custom to)
    const { Resend } = require('resend');
    const resend = new Resend(process.env.RESEND_API_KEY);
    const result = await resend.emails.send({
      from:    'LocalIntel <intel@thelocalintel.com>',
      to:      biz.notification_email,
      subject: 'Your LocalIntel dashboard link',
      html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:32px 24px;">
  <p style="font-size:18px;font-weight:700;color:#111827;margin-bottom:4px;">LocalIntel</p>
  <p style="color:#6B7280;font-size:13px;margin-bottom:28px;">thelocalintel.com</p>
  <p style="font-size:15px;color:#111827;">Hi <strong>${biz.name}</strong>,</p>
  <p style="font-size:15px;color:#374151;margin-top:12px;">Here is your permanent dashboard link:</p>
  <p style="margin:28px 0;">
    <a href="${inboxUrl}" style="background:#16A34A;color:#fff;padding:13px 26px;border-radius:8px;text-decoration:none;font-weight:600;font-size:15px;">Open My Dashboard &rarr;</a>
  </p>
  <p style="font-size:13px;color:#6B7280;">Or copy this link:<br><a href="${inboxUrl}" style="color:#16A34A;word-break:break-all;">${inboxUrl}</a></p>
  <p style="font-size:13px;color:#6B7280;margin-top:20px;">Bookmark it — this link never expires.</p>
  <hr style="border:none;border-top:1px solid #E5E7EB;margin:28px 0;">
  <p style="font-size:12px;color:#9CA3AF;">LocalIntel Data Services &mdash; thelocalintel.com</p>
</div>`,
    });
    console.log(`[auth/magic] sent to ${biz.notification_email} — id: ${result.data?.id}, err: ${result.error?.message}`);
  } catch (err) {
    console.error('[auth/magic]', err.message);
    // Response already sent, just log
  }
});

// ── RFQ Inbox API ─────────────────────────────────────────────────────────────

/**
 * GET /api/local-intel/inbox?token=<dispatch_token>
 * Returns business info + open RFQs matching their zip+category.
 */
router.get('/inbox', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const rfqService = require('./lib/rfqService');
    // Look up by dispatch_token (set during claim flow or migration)
    const [biz] = await db.query(
      `SELECT business_id, name, zip, category, notification_email,
              notify_push, claimed_at,
              COALESCE(has_hours, false) AS has_hours,
              COALESCE(sunbiz_id, sunbiz_doc_number) AS sunbiz_id,
              hours_json, services_text, menu_url, menu_fetched_at, menu_fetch_error, services_json,
              CASE WHEN pos_config IS NOT NULL THEN (pos_config->>'pos_type') ELSE NULL END AS pos_type
         FROM businesses
        WHERE dispatch_token = $1
          AND status != 'inactive'
        LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    // Fetch wallet balance from agent_registry
    const pool = db.getPool ? db.getPool() : db;
    const { rows: [reg] } = await pool.query(
      `SELECT balance_usd_micro, deposit_address FROM agent_registry WHERE token = $1`,
      [token]
    ).catch(() => ({ rows: [null] }));

    const open_rfqs = await rfqService.getOpenRfqs(biz.zip, biz.category);

    res.json({
      business_name:     biz.name,
      zip:               biz.zip,
      category:          biz.category,
      business_id:       biz.business_id,
      notify_push:       biz.notify_push || false,
      claimed_at:        biz.claimed_at || null,
      has_hours:         biz.has_hours  || false,
      sunbiz_id:         biz.sunbiz_id  || null,
      sunbiz_verified:   !!biz.sunbiz_id,
      balance_usd_micro: reg ? reg.balance_usd_micro : 0,
      wallet_funded:     reg ? (reg.balance_usd_micro || 0) > 0 : false,
      deposit_address:   reg ? reg.deposit_address : null,
      open_rfqs,
      hours_json:       biz.hours_json      || null,
      services_text:    biz.services_text   || null,
      menu_url:         biz.menu_url        || null,
      menu_fetched_at:  biz.menu_fetched_at || null,
      menu_fetch_error: biz.menu_fetch_error|| null,
      services_json:    biz.services_json   || null,
      pos_type:         biz.pos_type        || null,
    });
  } catch (err) {
    console.error('[inbox GET]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/local-intel/inbox/respond
 * Body: { token, rfq_id, quote_usd, message, eta_minutes }
 */
router.post('/inbox/respond', express.json(), async (req, res) => {
  const { token, rfq_id, quote_usd, message, eta_minutes } = req.body || {};
  if (!token)  return res.status(401).json({ error: 'token required' });
  if (!rfq_id) return res.status(400).json({ error: 'rfq_id required' });
  try {
    const rfqService = require('./lib/rfqService');
    const [biz] = await db.query(
      `SELECT business_id, name FROM businesses
        WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    const result = await rfqService.submitResponse(
      rfq_id,
      biz.business_id,
      { quote_usd: quote_usd || null, message: message || null, eta_minutes: eta_minutes || null }
    );
    res.json(result);
  } catch (err) {
    console.error('[inbox/respond POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/local-intel/inbox/book
 * Body: { token, rfq_id, response_id }
 * For approve/human autonomy — human confirms a booking.
 */
router.post('/inbox/book', express.json(), async (req, res) => {
  const { token, rfq_id, response_id } = req.body || {};
  if (!token)      return res.status(401).json({ error: 'token required' });
  if (!rfq_id)     return res.status(400).json({ error: 'rfq_id required' });
  if (!response_id) return res.status(400).json({ error: 'response_id required' });
  try {
    const rfqService = require('./lib/rfqService');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses
        WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    const result = await rfqService.bookRfq(rfq_id, response_id, 'confirmed by human');
    res.json(result);
  } catch (err) {
    console.error('[inbox/book POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/surge/menu/:id — fetch live Surge menu (UUID or Sunbiz ID) ──
router.get('/surge/menu/:id', async (req, res) => {
  try {
    const db   = require('./lib/db');
    const id   = req.params.id;
    // Accept either internal UUID or Sunbiz ID
    const isUuid = /^[0-9a-f-]{36}$/.test(id);
    const [biz] = await db.query(
      isUuid
        ? `SELECT business_id FROM businesses WHERE business_id = $1 LIMIT 1`
        : `SELECT business_id FROM businesses WHERE sunbiz_id = $1 OR sunbiz_doc_number = $1 LIMIT 1`,
      [id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });
    const surge = require('./lib/surgeAgent');
    const menu  = await surge.fetchMenu(biz.business_id);
    res.json({ ok: true, business_id: biz.business_id, menu });
  } catch (err) {
    console.error('[surge/menu]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/surge/order — place order + send SMS payment link ──
router.post('/surge/order', express.json(), async (req, res) => {
  const { business_id, sunbiz_id, customer_phone, order_text, jurisdiction_code } = req.body || {};
  const lookupId = business_id || sunbiz_id;
  if (!lookupId)   return res.status(400).json({ error: 'business_id or sunbiz_id required' });
  if (!order_text) return res.status(400).json({ error: 'order_text required' });
  try {
    const db     = require('./lib/db');
    const isUuid = /^[0-9a-f-]{36}$/.test(lookupId);
    const [biz]  = await db.query(
      isUuid
        ? `SELECT business_id FROM businesses WHERE business_id = $1 LIMIT 1`
        : `SELECT business_id FROM businesses WHERE sunbiz_id = $1 OR sunbiz_doc_number = $1 LIMIT 1`,
      [lookupId]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });
    const surge  = require('./lib/surgeAgent');
    const result = await surge.placeOrderFromVoice({
      businessId:      biz.business_id,
      customerPhone:   customer_phone || null,
      orderText:       order_text,
      jurisdictionCode: jurisdiction_code || 'US-FL',
    });
    res.json(result);
  } catch (err) {
    console.error('[surge/order]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/surge/webhook — receive Surge payment status events ──
router.post('/surge/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const deliveryId = req.headers['x-basaltsurge-delivery'];
    const signature  = req.headers['x-basaltsurge-signature'];
    const rawBody    = req.body?.toString('utf8') || '';
    const payload    = JSON.parse(rawBody);
    const receiptId  = payload.receiptId || payload.id;
    const status     = payload.status;

    console.log(`[surge/webhook] delivery=${deliveryId} status=${status} receiptId=${receiptId}`);

    // TODO: look up order by receiptId, verify signature, update rfq_bookings, release escrow on paid
    // For now: log and acknowledge
    const db = require('./lib/db');
    await db.query(
      `INSERT INTO rfq_gaps (raw_text, source, created_at)
       VALUES ($1, 'surge_webhook', NOW())
       ON CONFLICT DO NOTHING`,
      [JSON.stringify({ receiptId, status, deliveryId })]
    ).catch(() => {});

    if (status === 'paid' || status === 'checkout_success') {
      console.log(`[surge/webhook] PAYMENT CONFIRMED for receipt ${receiptId}`);
      // TODO: release escrow, notify business, update booking status
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[surge/webhook]', err.message);
    res.status(200).json({ ok: true }); // always 200 to Surge
  }
});

// ── POST /api/local-intel/inbox/hours — save business hours ──────────────────
router.post('/inbox/hours', express.json(), async (req, res) => {
  const { token, hours } = req.body || {};
  if (!token) return res.status(401).json({ error: 'token required' });
  if (!hours || typeof hours !== 'object') return res.status(400).json({ error: 'hours object required' });
  try {
    const db = require('./lib/db');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    await db.query(
      `UPDATE businesses SET hours_json = $1, has_hours = true WHERE business_id = $2`,
      [JSON.stringify(hours), biz.business_id]
    );
    console.log(`[inbox/hours] saved for ${biz.business_id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('[inbox/hours POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/inbox/services — save services text + menu URL ───────
router.post('/inbox/services', express.json(), async (req, res) => {
  const { token, services_text, menu_url } = req.body || {};
  if (!token) return res.status(401).json({ error: 'token required' });
  try {
    const db = require('./lib/db');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    await db.query(
      `UPDATE businesses SET
         services_text    = COALESCE($1, services_text),
         menu_url         = COALESCE($2, menu_url),
         menu_fetched_at  = NULL
       WHERE business_id = $3`,
      [services_text || null, menu_url || null, biz.business_id]
    );
    // If menu_url provided, trigger async fetch
    if (menu_url) {
      setImmediate(async () => {
        try {
          const menuFetch = require('./workers/menuFetchAgent');
          await menuFetch.fetchMenuForBusiness(biz.business_id, menu_url);
          console.log(`[inbox/services] menu fetch complete for ${biz.business_id}`);
        } catch (e) {
          console.warn('[inbox/services] menu fetch error:', e.message);
          // Store error so UI can surface it
          const db2 = require('./lib/db');
          await db2.query(
            `UPDATE businesses SET menu_fetch_error = $1 WHERE business_id = $2`,
            [e.message.slice(0, 500), biz.business_id]
          ).catch(() => {});
        }
      });
    }
    console.log(`[inbox/services] saved for ${biz.business_id}`);
    res.json({ ok: true, menu_fetch_queued: !!menu_url });
  } catch (err) {
    console.error('[inbox/services POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/inbox/pos — save POS credentials (AES-256 encrypted) ─
router.post('/inbox/pos', express.json(), async (req, res) => {
  const { token, pos_type, credentials } = req.body || {};
  if (!token)       return res.status(401).json({ error: 'token required' });
  if (!pos_type)    return res.status(400).json({ error: 'pos_type required (toast|square|clover|other)' });
  if (!credentials) return res.status(400).json({ error: 'credentials object required' });
  try {
    const db     = require('./lib/db');
    const crypto = require('crypto');
    const [biz] = await db.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });

    // AES-256-GCM encrypt credentials
    const key = Buffer.from(
      (process.env.POS_ENCRYPT_KEY || 'localintel-pos-key-32-bytes-here!').padEnd(32).slice(0, 32)
    );
    const iv         = crypto.randomBytes(12);
    const cipher     = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted  = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    const authTag    = cipher.getAuthTag();
    const posConfig  = {
      pos_type,
      iv:      iv.toString('hex'),
      tag:     authTag.toString('hex'),
      data:    encrypted.toString('hex'),
      saved_at: new Date().toISOString()
    };

    await db.query(
      `UPDATE businesses SET pos_config = $1 WHERE business_id = $2`,
      [JSON.stringify(posConfig), biz.business_id]
    );
    console.log(`[inbox/pos] saved ${pos_type} credentials for ${biz.business_id}`);
    res.json({ ok: true, pos_type });
  } catch (err) {
    console.error('[inbox/pos POST]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/push/vapid-public-key — return VAPID public key for subscription ──
router.get('/push/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: key });
});

// ── POST /api/local-intel/push/subscribe — save push subscription for a business ──
router.post('/push/subscribe', express.json(), async (req, res) => {
  const { token, subscription } = req.body || {};
  if (!token)        return res.status(401).json({ error: 'token required' });
  if (!subscription) return res.status(400).json({ error: 'subscription required' });
  try {
    const pool = db.getPool ? db.getPool() : db;
    // Ensure push_subscriptions table exists
    await pool.query(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        business_id  TEXT NOT NULL,
        endpoint     TEXT NOT NULL UNIQUE,
        p256dh       TEXT,
        auth         TEXT,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ
      )
    `);
    await pool.query(`
      ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notify_push BOOLEAN DEFAULT false
    `);
    // Look up business by dispatch_token
    const { rows: [biz] } = await pool.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 AND status != 'inactive' LIMIT 1`,
      [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    // Upsert subscription
    await pool.query(
      `INSERT INTO push_subscriptions (business_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE
         SET business_id = EXCLUDED.business_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             last_used_at = NOW()`,
      [biz.business_id, subscription.endpoint,
       subscription.keys?.p256dh || null, subscription.keys?.auth || null]
    );
    // Mark business as push-enabled
    await pool.query(
      `UPDATE businesses SET notify_push = true WHERE business_id = $1`,
      [biz.business_id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('[push/subscribe]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/local-intel/push/unsubscribe — remove push subscription ──
router.post('/push/unsubscribe', express.json(), async (req, res) => {
  const { token, endpoint } = req.body || {};
  if (!token || !endpoint) return res.status(400).json({ error: 'token and endpoint required' });
  try {
    const pool = db.getPool ? db.getPool() : db;
    const { rows: [biz] } = await pool.query(
      `SELECT business_id FROM businesses WHERE dispatch_token = $1 LIMIT 1`, [token]
    );
    if (!biz) return res.status(401).json({ error: 'invalid token' });
    await pool.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND business_id = $2`,
      [endpoint, biz.business_id]);
    // Check if any subs remain
    const { rows } = await pool.query(
      `SELECT id FROM push_subscriptions WHERE business_id = $1 LIMIT 1`, [biz.business_id]
    );
    if (rows.length === 0) {
      await pool.query(`UPDATE businesses SET notify_push = false WHERE business_id = $1`, [biz.business_id]);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/ingest', express.json({ limit: '50mb' }), async (req, res) => {
  try {
    const body = JSON.stringify(req.body || {});
    const response = await fetch('http://localhost:3005/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'DataIngestWorker unavailable: ' + e.message });
  }
});

// ── GET /api/local-intel/ingest/log — proxy to DataIngestWorker log ────────────
router.get('/ingest/log', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3005/ingest/log');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'DataIngestWorker unavailable: ' + e.message });
  }
});

// ── Server-card at the MCP path — Smithery fetches .well-known relative to the URL given
// If URL given is /api/local-intel/mcp, they fetch /api/local-intel/.well-known/mcp/server-card.json
router.get('/.well-known/mcp/server-card.json', (req, res) => {
  res.json({
    serverInfo: { name: 'LocalIntel by MCFLAMINGO', version: '1.1.0', description: 'Agentic business intelligence for St. Johns County FL (32081 + 32082). 18 MCP tools across 5 verticals. Composite NL query via local_intel_ask. Two payment rails: $0.01–$0.05/call USDC on Base (x402) or pathUSD on Tempo mainnet.' },
    authentication: { required: false },
    tools: [
      { name: 'local_intel_ask',       description: 'BEST FIRST CALL. Composite NL query layer — ask any plain-English question about a ZIP and get a synthesized, sourced answer with confidence score. Routes internally to zone, oracle, search, bedrock, signal, tide, corridor, changes, and nearby. Single entry point for humans and LLMs.', inputSchema: { type: 'object', required: ['question'], properties: { question: { type: 'string', description: 'Plain English question', examples: ['What restaurant categories are missing in 32082?', 'Investment signals for 32081', 'Healthcare provider gaps near A1A'] }, zip: { type: 'string', description: 'ZIP code — optional, extracted from question if present' } } } },
      { name: 'local_intel_context',   description: 'Full spatial context block for a ZIP or lat/lon. Returns anchor business, nearby businesses in distance rings, zone intelligence, and category breakdown.', inputSchema: { type: 'object', properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] }, lat: { type: 'number', description: 'Latitude' }, lon: { type: 'number', description: 'Longitude' } } } },
      { name: 'local_intel_search',    description: 'Search businesses by name, category, or semantic group (food, retail, health, finance, civic, services).', inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string', description: 'Business name, category, or group', examples: ['restaurants', 'dentist', 'coffee'] }, zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_nearby',    description: 'Find businesses within a radius of any lat/lon point, sorted by distance with compass bearing.', inputSchema: { type: 'object', required: ['lat', 'lon'], properties: { lat: { type: 'number', description: 'Center latitude' }, lon: { type: 'number', description: 'Center longitude' }, radius: { type: 'number', description: 'Radius in miles (default: 1)' } } } },
      { name: 'local_intel_zone',      description: 'Spending zone and demographic data for a ZIP: population, income, home value, rent, ownership rate, zone score.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_corridor',  description: 'Businesses along a named street corridor (e.g. A1A, Palm Valley Road).', inputSchema: { type: 'object', required: ['street'], properties: { street: { type: 'string', description: 'Street or corridor name', examples: ['A1A', 'Palm Valley Road'] }, zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_changes',   description: 'Recently added or owner-verified business listings. Detect new openings or data updates.', inputSchema: { type: 'object', properties: { zip: { type: 'string', description: 'Optional ZIP filter' }, days: { type: 'number', description: 'Look back N days (default: 30)' } } } },
      { name: 'local_intel_stats',     description: 'Dataset coverage stats: total businesses, confidence scores, query volume, revenue earned.', inputSchema: { type: 'object', properties: { zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_tide',      description: 'Tidal momentum reading for a ZIP — temperature 0-100, direction (surging/heating/stable/cooling/receding), seasonal context.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_signal',    description: 'Investment signal score 0-100 for a ZIP with band (strong_buy/accumulate/hold/reduce/avoid), top reasons, and avoid flags.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_bedrock',   description: 'Infrastructure momentum score from permits, road projects, flood zones, utility extensions. Predicts conditions 12-36 months ahead.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_for_agent', description: 'PREMIUM ($0.05). Declare agent_type and intent, receive pre-ranked top-10 signals from all 4 data layers personalized for your use case.', inputSchema: { type: 'object', required: ['agent_type', 'intent'], properties: { agent_type: { type: 'string', description: 'Agent role', examples: ['real_estate', 'restaurant', 'investor'] }, intent: { type: 'string', description: 'What the agent is trying to accomplish' }, zip: { type: 'string', description: 'Optional ZIP filter' } } } },
      { name: 'local_intel_oracle',    description: 'Pre-baked economic oracle for a ZIP. Returns restaurant saturation, price-tier gap analysis, growth trajectory, and 3 pre-formed questions with answers. Time-series trend tracking across 6h cycles.', inputSchema: { type: 'object', required: ['zip'], properties: { zip: { type: 'string', description: 'ZIP code', examples: ['32081', '32082'] } } } },
      { name: 'local_intel_realtor',   description: 'Real estate intelligence for a ZIP: demographics, commercial gaps, flood risk, infrastructure momentum, market signals. Trained on 100 realtor business prompts.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about real estate or demographics', examples: ['What is the average household income?', 'Are there commercial vacancies?'] }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_healthcare', description: 'Healthcare market intelligence: provider density, demographics, patient demand gaps, senior population signals.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about healthcare market' }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_retail',    description: 'Retail market intelligence: store categories, spending capture, consumer profile, undersupplied niches.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about retail market' }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_construction', description: 'Construction and home services intelligence: active permits, contractor density, population growth driving demand.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about construction market' }, zip: { type: 'string', description: 'ZIP code' } } } },
      { name: 'local_intel_restaurant', description: 'Restaurant and food service market intelligence: saturation scores, price-tier gaps, capture rates, corridor analysis, tidal momentum. Trained on 100 restaurant prompts.', inputSchema: { type: 'object', required: ['query', 'zip'], properties: { query: { type: 'string', description: 'Natural language question about restaurant market' }, zip: { type: 'string', description: 'ZIP code' } } } },
    ],
    resources: [],
    prompts: [
      { name: 'restaurant_viability', description: "Analyze whether a ZIP code can support another restaurant. Returns saturation status, demand capture rate, price-tier gaps, and a plain-English recommendation.", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32081, 32082)", "required": true}] },
      { name: 'investment_signal', description: "Get the investment signal score and growth trajectory for a ZIP. Returns composite score 0-100, band (strong_buy to avoid), top reasons, and infrastructure momentum.", arguments: [{"name": "zip", "description": "ZIP code to score (e.g. 32081, 32082)", "required": true}] },
      { name: 'missing_category', description: "Identify which business category or price tier is most undersupplied in a ZIP relative to its income and population. Returns top gap with supporting data.", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32081, 32082)", "required": true}] },
      { name: 're_demographic_profile', description: "[Real Estate] What is the demographic profile and income level of buyers in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_commercial_gaps', description: "[Real Estate] Are there commercial gaps that signal neighborhood appreciation potential?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_flood_risk', description: "[Real Estate] What is the flood zone risk percentage for this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_infrastructure', description: "[Real Estate] What infrastructure projects are active near this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_new_businesses', description: "[Real Estate] What businesses are opening or recently added in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_owner_occupancy', description: "[Real Estate] What is the owner-occupancy rate and home value median?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 're_undersupplied_retail', description: "[Real Estate] What upscale dining or retail is undersupplied in this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_investment_signal', description: "[Real Estate] What is the investment signal score for this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_a1a_corridor', description: "[Real Estate] What restaurants are on the A1A corridor?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_healthcare_access', description: "[Real Estate] What healthcare providers are accessible in this neighborhood?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_tidal_momentum', description: "[Real Estate] What is the tidal momentum direction for buyer activity in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_school_services', description: "[Real Estate] What school-related businesses or services are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_fb_saturation', description: "[Real Estate] What is the market saturation status for food and beverage?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_growth_trajectory', description: "[Real Estate] What growth trajectory is this ZIP on \u2014 growing, stable, or transitioning?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_contractors', description: "[Real Estate] What construction or remodeling contractors operate in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_income_32084', description: "[Real Estate] What is the household income and consumer profile for this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 're_business_count', description: "[Real Estate] How many businesses are in this ZIP and what categories dominate?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32086"}] },
      { name: 're_capture_rate', description: "[Real Estate] What is the capture rate for food spending in this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32092"}] },
      { name: 're_nearby_coords', description: "[Real Estate] What businesses are near latitude 30.189 longitude -81.38?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 're_opportunity_signals', description: "[Real Estate] What are the top market opportunity signals for a residential buyer?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'hc_dentists', description: "[Healthcare] What dentists operate in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_pharmacies', description: "[Healthcare] What pharmacies are accessible in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_physicians', description: "[Healthcare] How many physicians or clinics are in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_income', description: "[Healthcare] What is the median household income of patients in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_undersupplied', description: "[Healthcare] What healthcare services are undersupplied relative to population?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_senior_pop', description: "[Healthcare] What is the senior population percentage that drives home health demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_mental_health', description: "[Healthcare] What mental health or counseling services exist in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_wellness', description: "[Healthcare] What fitness or wellness businesses operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_nearby_3mi', description: "[Healthcare] What healthcare businesses are within 3 miles of Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_consumer_profile', description: "[Healthcare] What is the consumer profile \u2014 does it skew toward affluent established patients?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_optometrists', description: "[Healthcare] What optometrists or vision care providers are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'hc_physical_therapy', description: "[Healthcare] What physical therapy or rehab centers operate in St Johns County?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32092"}] },
      { name: 'hc_population_growth', description: "[Healthcare] What is the population growth trend that affects patient demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'hc_new_businesses', description: "[Healthcare] What are new healthcare businesses recently added to this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'hc_urgent_care', description: "[Healthcare] What urgent care or walk-in clinics are in this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32086"}] },
      { name: 'rx_grocery', description: "[Retail] What grocery stores or supermarkets operate in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_undersupplied', description: "[Retail] What retail categories are undersupplied for the income level here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_consumer_profile', description: "[Retail] What is the consumer spending profile \u2014 affluent or budget-conscious?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_a1a_specialty', description: "[Retail] What specialty retail shops operate on A1A in Ponte Vedra?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_hardware', description: "[Retail] What hardware or home improvement stores are nearby?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_apparel', description: "[Retail] What clothing or apparel retailers serve this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_total_retail', description: "[Retail] How many retail businesses are in this ZIP total?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_pet_supply', description: "[Retail] What pet supply or pet service businesses exist here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_nocatee_convenience', description: "[Retail] What convenience stores operate in Nocatee?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'rx_capture_rate', description: "[Retail] What is the capture rate for retail spending in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_new_openings', description: "[Retail] What businesses have recently opened in this retail market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_wine_liquor', description: "[Retail] What wine or liquor stores operate in Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_florists', description: "[Retail] What florists or gift shops are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_hhi_tier', description: "[Retail] What is the household income that determines retail price tier demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'rx_bookstores', description: "[Retail] What bookstores or stationery shops exist in St Johns County?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'cx_general_contractors', description: "[Construction] What general contractors operate in Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_roofing', description: "[Construction] What roofing companies serve this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_plumbing', description: "[Construction] What plumbing businesses are in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_hvac', description: "[Construction] What HVAC or air conditioning companies operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_electricians', description: "[Construction] What electricians serve Nocatee and surrounding ZIPs?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'cx_landscaping', description: "[Construction] What landscaping companies operate in St Johns County?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_infrastructure_score', description: "[Construction] What is the infrastructure momentum score \u2014 are there active permits?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_active_projects', description: "[Construction] What new construction or development projects are active in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_pool_builders', description: "[Construction] What pool builders or outdoor construction companies are nearby?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_population_growth', description: "[Construction] What is the population growth rate that drives construction demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'cx_painters', description: "[Construction] What painting or interior finishing contractors operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_flooring', description: "[Construction] What flooring or tile companies serve this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_home_inspection', description: "[Construction] What home inspection services are available in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'cx_windows_doors', description: "[Construction] What window or door replacement companies serve this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'cx_pest_control', description: "[Construction] What pest control or remediation businesses operate in 32086?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32086"}] },
      { name: 'fb_pvb_restaurants', description: "[Restaurant] What restaurants are in Ponte Vedra Beach?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_upscale_gap', description: "[Restaurant] Is the upscale dining market undersupplied in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_saturation', description: "[Restaurant] What is the restaurant saturation status \u2014 room for more or oversupplied?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_fast_casual_nocatee', description: "[Restaurant] What fast casual restaurants operate in Nocatee?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32081"}] },
      { name: 'fb_capture_rate', description: "[Restaurant] What is the food and beverage capture rate for this market?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_fine_dining', description: "[Restaurant] What fine dining options exist in 32082?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_bars_nightlife', description: "[Restaurant] What bars or nightlife venues operate in this area?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_breakfast_brunch', description: "[Restaurant] What breakfast or brunch spots are in Ponte Vedra?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_a1a_corridor', description: "[Restaurant] How many restaurants are on the A1A corridor?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_meal_demand', description: "[Restaurant] What is the estimated daily meal demand vs. current capacity?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_coffee_cafes', description: "[Restaurant] What coffee shops or cafes serve this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_food_trucks', description: "[Restaurant] What food trucks or pop-up food businesses operate here?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_hhi_tier', description: "[Restaurant] What is the median household income that determines restaurant price tier demand?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
      { name: 'fb_sushi_st_aug', description: "[Restaurant] What sushi or Asian cuisine restaurants are in St Augustine?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32084"}] },
      { name: 'fb_tidal_momentum', description: "[Restaurant] What is the tidal momentum for food and beverage investment in this ZIP?", arguments: [{"name": "zip", "description": "ZIP code to analyze (e.g. 32082, 32081, 32084)", "required": false, "default": "32082"}] },
    ],
    configSchema: { type: 'object', properties: {}, required: [] },
  });
});

// ── GET /api/local-intel/mcp — Smithery/scanner discovery ──────────────────
// Streamable HTTP spec: GET returns server info so scanners don't fall through
// to the static HTML handler.
router.get('/mcp', async (req, res) => {
  try {
    // Forward to internal MCP server for tools/list so Smithery sees real tools
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const data = await response.json();
    // Return as MCP initialize shape with embedded tools for discovery
    res.json({
      jsonrpc: '2.0',
      id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'localintel', version: '1.0.0' },
        capabilities: { tools: {} },
        tools: data?.result?.tools || [],
      },
    });
  } catch (e) {
    res.json({
      jsonrpc: '2.0',
      id: null,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'localintel', version: '1.0.0' },
        capabilities: { tools: {} },
      },
    });
  }
});

// ── Caller source detection ───────────────────────────────────────────────────
function detectSource(req) {
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const xc = (req.headers['x-caller'] || req.headers['x-agent-id'] || '').toLowerCase();
  if (xc) return xc;
  if (ua.includes('smithery'))   return 'smithery';
  if (ua.includes('claude'))     return 'claude';
  if (ua.includes('cursor'))     return 'cursor';
  if (ua.includes('copilot'))    return 'copilot';
  if (ua.includes('openai') || ua.includes('gpt')) return 'openai';
  if (ua.includes('perplexity')) return 'perplexity';
  if (ua.includes('python'))     return 'python-client';
  if (ua.includes('node') || ua.includes('undici')) return 'node-client';
  if (ua.includes('postman'))    return 'postman';
  if (ua)                        return ua.split('/')[0].slice(0, 32);
  return 'unknown';
}

// ── POST /api/mcp — proxy to MCP server on port 3004 ───────────────────────
// This is the public MCP endpoint agents call from outside Railway.
// Full URL: https://gsb-swarm-production.up.railway.app/api/mcp
// Payment: X-LocalIntel-Key required. pathUSD (Tempo) or USDC (Base). Free: tools/list, notifications.
router.post('/mcp', express.json(), apiKeyMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    // MCP notifications have no "id" — return 204 immediately, never proxy
    // (Smithery + other clients send notifications/initialized before tools/list)
    if (body.method && body.method.startsWith('notifications/') && body.id === undefined) {
      return res.status(204).end();
    }
    // Inject caller source into params so MCP server can log it
    if (body.method === 'tools/call' && body.params) {
      body.params._caller = detectSource(req);
      body.params._entry  = 'free';
      const _intent = {
        source: 'mcp',
        actor: {
          type: 'agent',
          phone: null,
          email: null,
          agent_key: req.headers['x-localintel-key'] || null,
          session_id: null,
          call_sid: null,
        },
        raw_input: body.params.arguments?.query || body.params.arguments?.prompt || '',
        command: {
          family: 'local_intel',
          name: (
            body.params.name === 'local_intel_nearby' ? 'nearby' :
            body.params.name === 'local_intel_ask'    ? 'ask'    :
            body.params.name === 'local_intel_oracle' ? 'oracle' :
            body.params.name === 'local_intel_rfq'    ? 'service_request' :
            'query'
          ),
          stage: null,
        },
        task: {
          category:      body.params.arguments?.category     || null,
          business_id:   null,
          business_name: null,
          zip:           body.params.arguments?.zip          || null,
          city:          null,
          lat:           null,
          lon:           null,
          radius_miles:  body.params.arguments?.radius_miles || null,
          description:   body.params.arguments?.query || body.params.arguments?.prompt || null,
          items: [],
          constraints: { budget: null, eta_minutes: null, time_window: null },
        },
        routing: {
          destination: (
            body.params.name === 'local_intel_rfq'    ? 'rfq_broadcast'   :
            body.params.name === 'local_intel_nearby' ? 'business_search' :
            'answer'
          ),
          pos_type: null, confidence: null, fallback_reason: null,
        },
        delivery: { channel: 'json', reply_expected: false },
      };
      console.log('[mcp] intent', JSON.stringify(_intent));
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP server unavailable: ' + e.message } });
  }
});

// ── x402 whitelist — agents in WHITELIST_USER_AGENTS bypass the payment gate ──
// Set Railway env var: WHITELIST_USER_AGENTS=lovable,smithery  (comma-separated, case-insensitive)
// Clear or remove the var to re-enable billing for all agents without a deploy.
const _x402Whitelist = (process.env.WHITELIST_USER_AGENTS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

function isX402Whitelisted(req) {
  if (_x402Whitelist.length === 0) return false;
  const ua = (req.headers['user-agent'] || '').toLowerCase();
  const match = _x402Whitelist.find(agent => ua.includes(agent));
  if (match) console.log(`[x402] whitelisted bypass for agent: ${match}`);
  return !!match;
}

// ── x402 MCP endpoints — Base/USDC payment rail (additive alongside pathUSD) ──
// Standard: $0.01 USDC on Base  |  Premium (local_intel_for_agent): $0.05 USDC
// Agents without Base wallets continue using /api/local-intel/mcp (Tempo/pathUSD)
// x402Middleware is scoped ONLY to these two routes — does NOT touch /mcp
router.post('/mcp/x402', express.json(), async (req, res, next) => {
  if (isX402Whitelisted(req)) return next();
  x402Middleware(req, res, next);
}, async (req, res) => {
  try {
    const body = req.body || {};
    if (body.method && body.method.startsWith('notifications/') && body.id === undefined) {
      return res.status(204).end();
    }
    if (body.method === 'tools/call' && body.params) {
      body.params._caller = detectSource(req);
      body.params._entry  = 'x402';
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP unavailable: ' + e.message } });
  }
});

router.post('/mcp/x402/premium', express.json(), async (req, res, next) => {
  if (isX402Whitelisted(req)) return next();
  x402Middleware(req, res, next);
}, async (req, res) => {
  try {
    const body = req.body || {};
    // Force premium tool so agents can't use the $0.05 endpoint for cheap calls
    if (body.method === 'tools/call' && body.params?.name !== 'local_intel_for_agent') {
      return res.status(400).json({ jsonrpc: '2.0', id: body.id || null, error: { code: -32600, message: 'Premium endpoint is for local_intel_for_agent only' } });
    }
    if (body.method === 'tools/call' && body.params) {
      body.params._caller = detectSource(req);
      body.params._entry  = 'x402-premium';
    }
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP unavailable: ' + e.message } });
  }
});

// ── GET /api/mcp/manifest — MCP tool discovery ────────────────────────────────
router.get('/mcp/manifest', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3004/manifest');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'MCP server unavailable' });
  }
});

// ── GET /api/local-intel/osm-queue — proxy to worker ─────────────────────────
router.get('/osm-queue', async (req, res) => {
  try {
    const response = await fetch('http://localhost:3003/osm-queue');
    const data = await response.json();
    res.json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Local Intel Worker unavailable: ' + e.message });
  }
});

// ── GET /api/local-intel/stats — coverage stats (Florida only) ──────────────
router.get('/stats', async (req, res) => {
  // Active states only — controlled by ACTIVE_STATES env var (default: FL)
  const { isActiveZip, coverageSummary } = require('./lib/stateConfig');
  try {
    // Group counts directly from Postgres — never .rows, db.query returns array.
    const zipRows = await db.query(
      `SELECT zip, COUNT(*)::int AS count, AVG(confidence_score)::float AS avg_conf
         FROM businesses
        WHERE status != 'inactive' AND zip IS NOT NULL
        GROUP BY zip`
    );
    const groupRows = await db.query(
      `SELECT COALESCE(category_group, 'other') AS grp, COUNT(*)::int AS count
         FROM businesses
        WHERE status != 'inactive'
        GROUP BY 1`
    );

    const byZip = {};
    let total = 0, confSum = 0, confCount = 0;
    for (const r of zipRows) {
      if (!isActiveZip(r.zip)) continue;
      byZip[r.zip] = r.count;
      total += r.count;
      if (r.avg_conf !== null && r.avg_conf !== undefined) {
        confSum += r.avg_conf * r.count;
        confCount += r.count;
      }
    }
    const byGroup = {};
    for (const r of groupRows) byGroup[r.grp] = r.count;

    // Confidence is stored 0..1 in Postgres; legacy JSON returned 0..100 — keep that shape.
    const avgConfRaw = confCount ? confSum / confCount : 0;
    const avgConf = avgConfRaw <= 1 ? Math.round(avgConfRaw * 100) : Math.round(avgConfRaw);

    res.json({
      ok: true,
      totalBusinesses: total,
      avgConfidence:   avgConf,
      coverage:        coverageSummary(),
      byZip,
      byGroup,
      sources: ['OSM','Census ACS 2022','FL Sunbiz'],
      pendingSources: ['SJC BTR','SJC Permits'],
      lastSync: new Date().toISOString().slice(0, 10),
    });
  } catch (e) {
    console.error('[stats] error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── GET /api/local-intel/agent-card ────────────────────────────────────────────────
const AGENT_CARD = {
  schema_version: 'v1',
  name: 'LocalIntel Data Services',
  description: 'Hyperlocal business intelligence for AI agents. ZIP-level business data covering Florida and expanding across the Sunbelt. Phone, hours, foot traffic proxy, categories, confidence scores. Pay-per-query via pathUSD.',
  url: 'https://gsb-swarm-production.up.railway.app',
  mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  a2a_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
  skills: ['nearby_businesses', 'corridor_data', 'zip_stats', 'zone_context', 'business_search', 'change_detection'],
  pricing: { per_call: '$0.01-0.05', currency: 'pathUSD', subscription: '$49-499/month' },
  coverage: { current: 'Florida SJC zips + expanding', target: 'Florida 983 zips, then full Sunbelt' },
  contact: 'localintel@mcflamingo.com',
  provider: 'LocalIntel Data Services / MCFL Restaurant Holdings LLC',
};

router.get('/agent-card', (req, res) => {
  res.json(AGENT_CARD);
});

// ── GET /api/local-intel/revenue-summary ──────────────────────────────────────────────
router.get('/revenue-summary', (req, res) => {
  let ledger = [];
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
  } catch (e) {
    // Return zeros on parse error
  }

  const now = Date.now();
  const startOfToday   = new Date(); startOfToday.setUTCHours(0,0,0,0);
  const sevenDaysAgo   = now - 7  * 24 * 60 * 60 * 1000;
  const thirtyDaysAgo  = now - 30 * 24 * 60 * 60 * 1000;

  function summarise(entries) {
    return {
      calls: entries.length,
      revenue_pathusd: parseFloat(entries.reduce((s, e) => s + (e.amount || 0), 0).toFixed(6)),
    };
  }

  const todayEntries  = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= startOfToday.getTime());
  const weekEntries   = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= sevenDaysAgo);
  const monthEntries  = ledger.filter(e => e.timestamp && new Date(e.timestamp).getTime() >= thirtyDaysAgo);

  // Top tools
  const toolMap = {};
  for (const e of ledger) {
    const key = e.tool || 'unknown';
    if (!toolMap[key]) toolMap[key] = { tool: key, calls: 0, revenue: 0 };
    toolMap[key].calls += 1;
    toolMap[key].revenue += (e.amount || 0);
  }
  const topTools = Object.values(toolMap)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(t => ({ ...t, revenue: parseFloat(t.revenue.toFixed(6)) }));

  // Top callers
  const callerMap = {};
  for (const e of ledger) {
    const key = e.caller || 'unknown';
    if (!callerMap[key]) callerMap[key] = { caller: key, calls: 0, revenue: 0 };
    callerMap[key].calls += 1;
    callerMap[key].revenue += (e.amount || 0);
  }
  const topCallers = Object.values(callerMap)
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 10)
    .map(c => ({ ...c, revenue: parseFloat(c.revenue.toFixed(6)) }));

  // Last call
  const sorted = [...ledger].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const lastCall = sorted.length ? sorted[0].timestamp : null;

  res.json({
    today:      summarise(todayEntries),
    week:       summarise(weekEntries),
    month:      summarise(monthEntries),
    allTime:    summarise(ledger),
    topTools,
    topCallers,
    lastCall,
    generatedAt: new Date().toISOString(),
  });
});

// ── Dashboard data proxy routes ──────────────────────────────────────────────
// These aggregate data files so the Vercel dashboard can poll one origin.

// ── GET /api/local-intel/call-log — last N calls with full trace ───────────────
router.get('/call-log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  try {
    // Auto-create per spec — no-op if existing usage_ledger has the legacy shape.
    await db.query(`
      CREATE TABLE IF NOT EXISTS usage_ledger (
        id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(),
        tool TEXT, caller TEXT, entry TEXT, zip TEXT, intent TEXT,
        latency INTEGER, cost NUMERIC, paid BOOLEAN DEFAULT false
      )
    `);

    // Detect schema (existing schema may use called_at/tool_name/cost_path_usd).
    const cols = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_ledger'`
    );
    const have = new Set(cols.map(c => c.column_name));
    const tsCol     = have.has('ts')          ? 'ts'          : (have.has('called_at')     ? 'called_at'     : null);
    const toolCol   = have.has('tool')        ? 'tool'        : (have.has('tool_name')     ? 'tool_name'     : null);
    const costCol   = have.has('cost')        ? 'cost'        : (have.has('cost_path_usd') ? 'cost_path_usd' : null);
    const callerCol = have.has('caller')      ? 'caller'      : (have.has('agent_token')   ? 'agent_token'   : null);
    const latCol    = have.has('latency')     ? 'latency'     : (have.has('response_ms')   ? 'response_ms'   : null);
    const orderCol  = tsCol || 'id';

    const sql = `SELECT
      ${tsCol     ? tsCol     + ' AS ts'      : 'NULL AS ts'},
      ${toolCol   ? toolCol   + ' AS tool'    : "'unknown' AS tool"},
      ${callerCol ? callerCol + ' AS caller'  : "'unknown' AS caller"},
      ${have.has('entry')    ? 'entry'    : "'free' AS entry"},
      ${have.has('zip')      ? 'zip'      : 'NULL AS zip'},
      ${have.has('intent')   ? 'intent'   : 'NULL AS intent'},
      ${latCol    ? latCol    + ' AS latency' : 'NULL AS latency'},
      ${costCol   ? costCol   + ' AS cost'    : '0 AS cost'},
      ${have.has('paid')     ? 'paid'     : 'false AS paid'}
      FROM usage_ledger ORDER BY ${orderCol} DESC LIMIT $1`;
    const rows = await db.query(sql, [limit]);

    const calls = rows.map(e => ({
      ts:      e.ts ? new Date(e.ts).toISOString() : null,
      tool:    e.tool    || 'unknown',
      caller:  e.caller  || 'unknown',
      entry:   e.entry   || 'free',
      zip:     e.zip     || null,
      intent:  e.intent  || null,
      latency: e.latency || null,
      cost:    Number(e.cost) || 0,
      paid:    !!e.paid,
    }));

    res.json({ count: calls.length, calls, generatedAt: new Date().toISOString() });
  } catch (e) {
    console.error('[call-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const DATA_DIR_AGENT = path.join(__dirname, 'data');

router.get('/coverage-stats', async (req, res) => {
  try {
    const { isActiveZip: isActiveZip2 } = require('./lib/stateConfig');

    const rows = await db.query(`
      SELECT zip, COUNT(*)::int AS businesses,
             AVG(confidence_score)::float AS conf,
             MAX(created_at) AS completed_at
        FROM businesses
       WHERE status != 'inactive' AND zip IS NOT NULL
       GROUP BY zip ORDER BY zip
    `);

    let totalBusinesses = 0, confSum = 0, confCount = 0;
    const completedZips = [];
    for (const r of rows) {
      if (!isActiveZip2(r.zip)) continue;
      // Persist confidence as 0..100 in the response (legacy shape).
      const confPct = r.conf == null ? 0 : (r.conf <= 1 ? r.conf * 100 : r.conf);
      completedZips.push({
        zip: r.zip,
        businesses: r.businesses,
        confidence: Math.round(confPct),
        completedAt: r.completed_at,
        source: 'businesses',
      });
      totalBusinesses += r.businesses;
      confSum += confPct * r.businesses;
      confCount += r.businesses;
    }

    // Queue progress comes from zip_queue if available.
    let inProgress = 0, pending = 0, failed = 0, queueTotal = 0;
    try {
      const queueRows = await db.query(
        `SELECT status, COUNT(*)::int AS n FROM zip_queue GROUP BY status`
      );
      for (const q of queueRows) {
        queueTotal += q.n;
        if (q.status === 'inProgress' || q.status === 'in_progress') inProgress = q.n;
        else if (q.status === 'pending') pending = q.n;
        else if (q.status === 'failed') failed = q.n;
      }
    } catch (_) {}

    const queueTotalDynamic = queueTotal > 0 ? queueTotal : 1013;

    const recentZips = [...completedZips]
      .sort((a, b) => new Date(b.completedAt || 0) - new Date(a.completedAt || 0))
      .slice(0, 20);

    let lastRun = null;
    try {
      const lr = await db.query(`SELECT MAX(updated_at) AS t FROM businesses`);
      lastRun = lr[0]?.t ? new Date(lr[0].t).toISOString() : null;
    } catch (_) {}

    res.json({
      zipsCompleted:    completedZips.length,
      zipsTotal:        queueTotalDynamic,
      totalBusinesses,
      avgConfidence:    confCount ? Math.round(confSum / confCount) : 0,
      activeAgents:     inProgress,
      pendingZips:      pending,
      failedZips:       failed,
      recentZips,
      lastRun,
      generatedAt:      new Date().toISOString(),
    });
  } catch(e) {
    console.error('[coverage-stats] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/source-log', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT worker_name AS source, event_type, payload, created_at AS timestamp
         FROM worker_events ORDER BY created_at DESC LIMIT 100`
    );
    // Latest status per source for legacy compatibility
    const sources = {};
    for (const r of rows) {
      const cur = sources[r.source];
      if (!cur || new Date(r.timestamp) > new Date(cur.checked_at)) {
        sources[r.source] = {
          checked_at: r.timestamp,
          event_type: r.event_type,
          payload:    r.payload,
        };
      }
    }
    res.json({ sources, raw: rows, generatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('[source-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/enrichment-log', async (req, res) => {
  try {
    const rows = await db.query(
      `SELECT worker_name, event_type, payload, created_at
         FROM worker_events
        WHERE worker_name = 'enrichmentAgent'
        ORDER BY created_at DESC LIMIT 100`
    );
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const enrichedToday = rows.filter(e => e.created_at && new Date(e.created_at) >= today).length;
    const recent = rows.slice(0, 20).map(r => ({
      worker_name: r.worker_name,
      event_type:  r.event_type,
      payload:     r.payload,
      enrichedAt:  r.created_at,
    }));
    res.json({ enrichedToday, recent, total: rows.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('[enrichment-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/broadcast-log', async (req, res) => {
  try {
    // Auto-create — safe, no-op if already there.
    await db.query(`
      CREATE TABLE IF NOT EXISTS acp_broadcast_log (
        id SERIAL PRIMARY KEY, zip TEXT, registry TEXT, status TEXT,
        business_count INTEGER, message TEXT,
        broadcast_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    const rows = await db.query(
      `SELECT id, zip, registry, status, business_count, message, broadcast_at
         FROM acp_broadcast_log ORDER BY broadcast_at DESC LIMIT 50`
    );
    const recent = rows.slice(0, 10).map(r => ({
      ...r,
      timestamp: r.broadcast_at,
    }));
    const lastByRegistry = {};
    for (const r of rows) {
      const ok = (r.status || '').includes('reachable') || r.status === 'ok' || r.status === 'cycle_complete';
      if (ok) {
        if (!lastByRegistry[r.registry] || new Date(r.broadcast_at) > new Date(lastByRegistry[r.registry])) {
          lastByRegistry[r.registry] = r.broadcast_at;
        }
      }
    }
    res.json({ recent, lastByRegistry, total: rows.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    console.error('[broadcast-log] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/mcp-probe-log', async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS mcp_probe_log (
        id SERIAL PRIMARY KEY, ts TIMESTAMPTZ DEFAULT NOW(),
        persona TEXT, tool TEXT, zip TEXT, score INTEGER, reason TEXT, error TEXT
      )
    `);
    const log = await db.query(
      `SELECT ts, persona, tool, zip, score, reason, error
         FROM mcp_probe_log ORDER BY ts DESC LIMIT 500`
    );
    const byPersona = {};
    for (const e of log) {
      if (!byPersona[e.persona]) byPersona[e.persona] = { total: 0, totalScore: 0, errors: 0, noData: 0 };
      byPersona[e.persona].total++;
      byPersona[e.persona].totalScore += (e.score || 0);
      if (e.error) byPersona[e.persona].errors++;
      if (e.reason === 'no_data' || e.reason === 'empty_response') byPersona[e.persona].noData++;
    }
    const summary = Object.entries(byPersona).map(([persona, s]) => ({
      persona,
      queries:   s.total,
      avg_score: s.total ? Math.round(s.totalScore / s.total) : 0,
      errors:    s.errors,
      no_data:   s.noData,
    }));
    const recent = [...log].sort((a,b) => new Date(b.ts) - new Date(a.ts)).slice(0, 50);
    res.json({ summary, recent, total: log.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/brief/:zip', async (req, res) => {
  try {
    const zip  = (req.params.zip || '').replace(/\D/g, '').slice(0, 5);
    const row  = await pgStore.getZipBrief(zip);
    if (!row) return res.status(404).json({ error: `No brief for ZIP ${zip} yet — check back after next brief worker cycle` });
    logUsage(getCallerId(req), 'brief', zip, 1);
    res.json(row.brief_json || row);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/briefs', async (req, res) => {
  try {
    const rows = await pgStore.getAllZipBriefs ? await pgStore.getAllZipBriefs() :
      await db.query('SELECT zip, brief_json, generated_at FROM zip_briefs ORDER BY zip');
    const summaries = rows.map(r => {
      const b = r.brief_json || r;
      return { zip: b.zip || r.zip, label: b.label, total: b.total, data_grade: b.data_grade, generated_at: r.generated_at || b.generated_at };
    }).filter(Boolean).sort((a,b) => (b.total||0)-(a.total||0));
    res.json({ count: summaries.length, zips: summaries });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/router-learning', async (req, res) => {
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS router_learning_log (
        id SERIAL PRIMARY KEY, run_at TIMESTAMPTZ DEFAULT NOW(),
        new_terms JSONB, failing_queries JSONB,
        improvement_rate NUMERIC, patch_summary TEXT
      )
    `);
    const runs = await db.query(
      `SELECT id, run_at, new_terms, failing_queries, improvement_rate, patch_summary
         FROM router_learning_log ORDER BY run_at DESC LIMIT 50`
    );
    if (runs.length === 0) {
      return res.json({ status: 'no_data_yet', message: 'Router learning worker has not run a cycle yet — check back in 35 minutes' });
    }
    const lastRun = runs[0];
    const recentPatches = runs.slice(0, 20).flatMap(r =>
      Array.isArray(r.new_terms) ? r.new_terms.map(p => ({ ts: r.run_at, ...p })) : []
    );
    const scoreTrend = runs.slice(0, 10).map(r => ({ ts: r.run_at, improvement_rate: r.improvement_rate }));
    res.json({
      total_patches_applied: recentPatches.reduce((s, p) => s + (p.terms?.length || 0), 0),
      last_run:              lastRun,
      recent_patches:        recentPatches,
      score_trend:           scoreTrend,
      verticals:             null,
      generatedAt:           new Date().toISOString(),
    });
  } catch(e) {
    console.error('[router-learning] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/router-learning/report ──────────────────────────────
// Structured patch history: score_before, score_after, delta per vertical per run.
// Query params:
//   ?vertical=restaurant   — filter to one vertical
//   ?limit=N               — last N patches (default 50)
//   ?runs=1                — include run-level summary alongside patches
router.get('/router-learning/report', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'router_learning.json');
    if (!fs.existsSync(file)) {
      return res.json({
        status:  'no_data_yet',
        message: 'Router learning worker has not run yet — check back in ~35 minutes',
      });
    }

    const data     = JSON.parse(fs.readFileSync(file));
    const limit    = Math.min(parseInt(req.query.limit || '50', 10), 500);
    const vertical = req.query.vertical || null;
    const includeRuns = req.query.runs === '1';

    // ── Patch history ─────────────────────────────────────────────────────────
    let patches = (data.patches || []).slice(-limit);
    if (vertical) patches = patches.filter(p => p.vertical === vertical);

    // Enrich each patch with a human-readable summary line
    const patchRows = patches.map(p => ({
      ts:           p.ts,
      cycle:        p.cycle,
      vertical:     p.vertical,
      terms_added:  p.terms || [],
      score_before: p.score_before ?? null,
      score_after:  p.score_after  ?? null,
      delta:        p.delta        ?? null,
      improved:     typeof p.delta === 'number' ? p.delta > 0 : null,
      confirmations: (p.confirmations || []).map(c => ({
        query:        c.query,
        zip:          c.zip,
        score_before: c.score_before,
        score_after:  c.score_after,
        delta:        c.delta,
      })),
    }));

    // ── Per-vertical aggregate ─────────────────────────────────────────────────
    const VERTICALS = ['restaurant','healthcare','retail','construction','realtor'];
    const verticalSummary = {};
    for (const v of VERTICALS) {
      const vPatches = (data.patches || []).filter(p => p.vertical === v);
      const withDelta = vPatches.filter(p => typeof p.delta === 'number');
      const avgBefore = withDelta.length
        ? Math.round(withDelta.reduce((s, p) => s + p.score_before, 0) / withDelta.length)
        : null;
      const avgAfter = withDelta.length
        ? Math.round(withDelta.reduce((s, p) => s + p.score_after, 0) / withDelta.length)
        : null;
      const totalImproved = withDelta.filter(p => p.delta > 0).length;
      const totalDegraded = withDelta.filter(p => p.delta < 0).length;
      // Latest score trend from rolling history
      const vHistory = data.verticals?.[v];
      const latestBefore = vHistory?.avg_score_before?.slice(-1)[0] ?? null;
      const latestAfter  = vHistory?.avg_score_after?.slice(-1)[0]  ?? null;
      verticalSummary[v] = {
        total_patches:   vPatches.length,
        patches_with_measurement: withDelta.length,
        avg_score_before: avgBefore,
        avg_score_after:  avgAfter,
        avg_delta:        avgBefore !== null && avgAfter !== null ? avgAfter - avgBefore : null,
        patches_improved: totalImproved,
        patches_degraded: totalDegraded,
        latest_score_before: latestBefore,
        latest_score_after:  latestAfter,
        latest_delta: latestBefore !== null && latestAfter !== null ? latestAfter - latestBefore : null,
        terms_learned: (vHistory?.patches || []).length,
      };
    }

    // ── Overall health score ───────────────────────────────────────────────────
    const allWithDelta = (data.patches || []).filter(p => typeof p.delta === 'number');
    const overallAvgDelta = allWithDelta.length
      ? Math.round(allWithDelta.reduce((s, p) => s + p.delta, 0) / allWithDelta.length)
      : null;
    const improvementRate = allWithDelta.length
      ? Math.round(allWithDelta.filter(p => p.delta > 0).length / allWithDelta.length * 100)
      : null;

    const payload = {
      generated_at:           new Date().toISOString(),
      total_patches_applied:  data.total_patches_applied || 0,
      patches_with_measurement: allWithDelta.length,
      overall_avg_delta:      overallAvgDelta,
      improvement_rate_pct:   improvementRate,
      last_run_at:            data.runs?.[data.runs.length - 1]?.ts || null,
      total_runs:             data.runs?.length || 0,
      vertical_summary:       verticalSummary,
      patches:                patchRows,
    };

    if (includeRuns) {
      payload.runs = (data.runs || []).slice(-20).map(r => ({
        ts:             r.ts,
        cycle:          r.cycle,
        log_entries:    r.log_entries,
        failures_found: r.failures_found,
        patches_count:  r.patches?.length || 0,
        score_trends:   r.score_trends,
      }));
    }

    res.json(payload);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/zip-queue', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    const queue = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    res.json({
      total:      queue.length,
      pending:    queue.filter(z => z.status === 'pending').length,
      inProgress: queue.filter(z => z.status === 'inProgress').length,
      complete:   queue.filter(z => z.status === 'complete').length,
      failed:     queue.filter(z => z.status === 'failed').length,
      active:     queue.filter(z => z.status === 'inProgress'),
      generatedAt: new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/local-intel/reset-queue ───────────────────────────────────────────────
// Reset all completed ZIPs to pending so enrichment re-runs immediately
router.post('/reset-queue', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Queue file not found' });
    const queue = JSON.parse(fs.readFileSync(file));
    const before = queue.filter(z => z.status === 'complete').length;
    queue.forEach(z => {
      if (z.status === 'complete' || z.status === 'failed') {
        z.status = 'pending';
        z.attempts = 0;
        z.startedAt = null;
      }
    });
    fs.writeFileSync(file, JSON.stringify(queue, null, 2));
    // Also reset coverage lastRun so coordinator triggers immediately
    const covFile = path.join(DATA_DIR_AGENT, 'coverage.json');
    if (fs.existsSync(covFile)) {
      const cov = JSON.parse(fs.readFileSync(covFile));
      cov.lastRun = new Date(0).toISOString(); // epoch forces refresh
      fs.writeFileSync(covFile, JSON.stringify(cov, null, 2));
    }
    res.json({ ok: true, reset: before, message: `${before} ZIPs reset to pending — enrichment will resume within 2 minutes` });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/budget-status ────────────────────────────────────────────────
// Proxies from zipCoordinatorWorker (port 3006) and normalises to snake_case
router.get('/budget-status', async (req, res) => {
  try {
    const r = await fetch('http://localhost:3006/budget-status', { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error(`zip-coordinator HTTP ${r.status}`);
    const d = await r.json();
    res.json({
      concurrent_agents: d.concurrentAgents ?? null,
      gate_status:       d.gateStatus       ?? 'normal',
      revenue_7d:        d.revenue7d        ?? 0,
      generatedAt:       d.generatedAt,
    });
  } catch (e) {
    // Return safe defaults so the dashboard doesn’t break
    res.json({ concurrent_agents: null, gate_status: 'normal', revenue_7d: 0, error: e.message });
  }
});

// ── POST /api/local-intel/nl-query — NIM natural language → structured oracle ──
// Parses free-text queries like "high-income ZIPs near Jacksonville with low WFH"
// into structured filters, runs oracle on matching ZIPs, returns ranked results.
router.post('/nl-query', express.json(), async (req, res) => {
  try {
    const { question } = req.body || {};
    if (!question || typeof question !== 'string') {
      return res.status(400).json({ error: 'question required' });
    }
    logUsage(getCallerId(req), 'nl-query', null, 5);

    const nvim = require('./lib/nvim');
    const { getAllZips } = require('./workers/flZipRegistry');

    // Step 1 — NIM parses intent into structured filters
    const systemPrompt = `You are a geospatial query parser for a Florida local business intelligence platform.
Extract search filters from the user's natural language query and return ONLY valid JSON.

Fields you can extract (all optional):
- near_city: string — city name (e.g. "Jacksonville", "Tampa", "Miami")
- min_income: number — minimum median household income in USD
- max_income: number — maximum median household income in USD  
- min_population: number — minimum ZIP population
- max_wfh_pct: number — maximum WFH saturation (0-100)
- min_wfh_pct: number — minimum WFH saturation (0-100)
- growth_state: string — one of: growing, stable, transitioning, transient
- vertical: string — one of: restaurant, retail, health, finance, services
- saturation: string — one of: undersupplied, oversupplied, balanced
- limit: number — max ZIPs to return (default 5, max 10)
- intent: string — 1 sentence description of what the user wants

Return ONLY a JSON object with these fields. No explanation.`;

    const userPrompt = `Query: "${question}"`;

    let filters = {};
    try {
      const raw = await nvim.nvimChat(systemPrompt, userPrompt, 300);
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (jsonMatch) filters = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.warn('[nl-query] NIM parse failed:', e.message);
      return res.status(500).json({ error: 'NIM unavailable — set NVIDIA_API_KEY in Railway' });
    }

    // Step 2 — Load oracle index + ZIP registry, apply filters
    const fs = require('fs');
    const path = require('path');
    const DATA_DIR_NL = path.join(__dirname, 'data');

    // City → lat/lon for proximity filter
    const CITY_COORDS = {
      'jacksonville': { lat: 30.33, lon: -81.66 },
      'tampa':        { lat: 27.95, lon: -82.46 },
      'orlando':      { lat: 28.54, lon: -81.38 },
      'miami':        { lat: 25.77, lon: -80.19 },
      'fort lauderdale': { lat: 26.12, lon: -80.14 },
      'gainesville':  { lat: 29.65, lon: -82.32 },
      'tallahassee':  { lat: 30.44, lon: -84.28 },
      'sarasota':     { lat: 27.34, lon: -82.53 },
      'fort myers':   { lat: 26.64, lon: -81.87 },
      'pensacola':    { lat: 30.42, lon: -87.22 },
      'daytona':      { lat: 29.21, lon: -81.02 },
      'st augustine': { lat: 29.89, lon: -81.32 },
      'ponte vedra':  { lat: 30.19, lon: -81.38 },
      'nocatee':      { lat: 30.11, lon: -81.42 },
    };

    function haversine(lat1, lon1, lat2, lon2) {
      const R = 3958.8; // miles
      const dLat = (lat2 - lat1) * Math.PI / 180;
      const dLon = (lon2 - lon1) * Math.PI / 180;
      const a = Math.sin(dLat/2)**2 + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
      return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }

    const allZips = getAllZips();
    const oracleDir = path.join(DATA_DIR_NL, 'oracle');
    const censusDir = path.join(DATA_DIR_NL, 'census_layer');
    const limit = Math.min(filters.limit || 5, 10);

    // ── Postgres pre-load: bulk fetch oracle + census for all ZIPs ──────────
    // Primary source = Postgres; flat files are fallback only
    const pgStore = require('./lib/pgStore');
    const oraclePgMap  = new Map(); // zip -> oracle_json
    const censusPgMap  = new Map(); // zip -> layer_json
    try {
      const dbMod = require('./lib/db');
      if (dbMod.isReady()) {
        const [oracleRows, censusRows] = await Promise.all([
          dbMod.query('SELECT zip, oracle_json FROM zip_intelligence').catch(() => ({ rows: [] })),
          dbMod.query('SELECT zip, layer_json FROM census_layer').catch(() => ({ rows: [] })),
        ]);
        for (const r of (oracleRows.rows || [])) if (r.oracle_json) oraclePgMap.set(r.zip, r.oracle_json);
        for (const r of (censusRows.rows || [])) if (r.layer_json) censusPgMap.set(r.zip, r.layer_json);
      }
    } catch (_pgErr) { /* DB not ready — fall through to flat files */ }

    // Proximity center
    const cityKey = (filters.near_city || '').toLowerCase().trim();
    const cityCenter = CITY_COORDS[cityKey] || null;
    const RADIUS_MILES = 60; // default search radius

    // Score + filter each ZIP
    const candidates = [];
    for (const zipEntry of allZips) {
      const { zip, population, median_hhi, lat, lon } = zipEntry;

      // Proximity filter
      if (cityCenter) {
        if (!lat || !lon) continue;
        const dist = haversine(cityCenter.lat, cityCenter.lon, lat, lon);
        if (dist > RADIUS_MILES) continue;
      }

      // Income filter (use registry median_hhi as fast fallback)
      const income = median_hhi || 0;
      if (filters.min_income && income < filters.min_income) continue;
      if (filters.max_income && income > filters.max_income) continue;

      // Population filter
      if (filters.min_population && (population || 0) < filters.min_population) continue;

      // Load oracle data — Postgres first, flat file fallback
      let oracle = oraclePgMap.get(zip) || null;
      if (!oracle) {
        const oracleFile = path.join(oracleDir, `${zip}.json`);
        if (fs.existsSync(oracleFile)) {
          try { oracle = JSON.parse(fs.readFileSync(oracleFile, 'utf8')); } catch {}
        }
      }

      // Load census layer — Postgres first, flat file fallback
      let census = censusPgMap.get(zip) || null;
      if (!census) {
        const censusFile = path.join(censusDir, `${zip}.json`);
        if (fs.existsSync(censusFile)) {
          try { census = JSON.parse(fs.readFileSync(censusFile, 'utf8')); } catch {}
        }
      }

      const wfhPct = census?.wfh_pct || oracle?.demographics?.wfh_pct || null;

      // WFH filter
      if (filters.max_wfh_pct != null && wfhPct != null && wfhPct > filters.max_wfh_pct) continue;
      if (filters.min_wfh_pct != null && wfhPct != null && wfhPct < filters.min_wfh_pct) continue;

      // Growth state filter
      if (filters.growth_state && oracle?.growth_trajectory?.state !== filters.growth_state) continue;

      // Saturation filter
      if (filters.saturation && oracle?.restaurant_capacity?.saturation_status !== filters.saturation) continue;

      // Score: higher income + matching oracle signals = higher rank
      const score = (income / 1000) +
        (oracle ? 20 : 0) +
        (wfhPct != null ? (filters.max_wfh_pct ? (filters.max_wfh_pct - wfhPct) : wfhPct) : 0) +
        (cityCenter && lat && lon ? Math.max(0, RADIUS_MILES - haversine(cityCenter.lat, cityCenter.lon, lat, lon)) : 0);

      candidates.push({
        zip,
        name: oracle?.name || zip,
        population: population || oracle?.demographics?.population || 0,
        median_household_income: income || oracle?.demographics?.median_household_income || 0,
        wfh_pct: wfhPct,
        growth_trajectory: oracle?.growth_trajectory || null,
        saturation_status: oracle?.restaurant_capacity?.saturation_status || null,
        gap_count: oracle?.restaurant_capacity?.gap_count || 0,
        oracle_narrative: oracle?.oracle_narrative || null,
        top_gap: oracle?.market_gaps?.top_gap || null,
        has_oracle: !!oracle,
        score,
      });
    }

    // Sort by score desc, return top N
    candidates.sort((a, b) => b.score - a.score);
    const top = candidates.slice(0, limit);

    res.json({
      ok: true,
      question,
      intent: filters.intent || question,
      filters_applied: filters,
      total_matched: candidates.length,
      results: top,
    });

  } catch (err) {
    console.error('[nl-query] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/oracle?zip=XXXXX ───────────────────────────────────
// Returns pre-baked economic narrative for a ZIP: restaurant capacity, market gaps, growth
router.get('/oracle', async (req, res) => {
  try {
    const zip = (req.query.zip || '').replace(/\D/g, '').slice(0, 5);
    logUsage(getCallerId(req), 'oracle', zip || 'all', 1);
    const oracleDir = path.join(DATA_DIR_AGENT, 'oracle');

    if (zip) {
      // Single ZIP — Postgres first, flat file fallback for local dev
      let oracleData = null;
      if (process.env.LOCAL_INTEL_DB_URL) {
        try {
          const { getZipIntelligenceRow } = require('./lib/pgStore');
          oracleData = await getZipIntelligenceRow(zip);
        } catch (_) {}
      }
      if (!oracleData) {
        const file = path.join(oracleDir, `${zip}.json`);
        if (fs.existsSync(file)) {
          try { oracleData = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
        }
      }
      if (!oracleData) {
        return res.status(404).json({ error: `No oracle data for ${zip}. Oracle worker may still be computing.` });
      }

      // ── Notify claimed businesses in this ZIP about the market query ──
      // Fire-and-forget — never block the oracle response
      try {
        const nq = require('./lib/notificationQueue');
        // Determine top gap category group from oracle, fallback to 'services'
        const topGroup = oracleData?.market_gaps?.top_gap?.category_group
          || oracleData?.restaurant_capacity?.top_gap_group
          || null;
        if (topGroup) {
          const subject = `Market query in your area — ${zip}`;
          const payload = {
            body: `An agent queried the ${topGroup} market in ZIP ${zip}. Check LocalIntel for full details.`,
            zip,
            category_group: topGroup,
            cta_url: `https://thelocalintel.com/claim.html?business_id=`,
            cta_label: 'View Market Intelligence',
          };
          setImmediate(() =>
            nq.enqueueForZipCategory(zip, topGroup, subject, payload)
              .then(n => { if (n > 0) return nq.processQueue(20); })
              .catch(e => console.error('[oracle-notify]', e.message))
          );
        }
      } catch (notifyErr) {
        console.error('[oracle-notify-init]', notifyErr.message);
      }

      return res.json(oracleData);
    }

    // No ZIP specified — build index from Postgres (durable), flat file fallback
    if (process.env.LOCAL_INTEL_DB_URL) {
      try {
        const db2 = require('./lib/db');
        const rows = await db2.query(
          `SELECT zip, name, saturation_status, growth_state, consumer_profile, computed_at, oracle_json
           FROM zip_intelligence WHERE oracle_json IS NOT NULL ORDER BY zip`
        );
        const zips = {};
        for (const r of rows) {
          const oj = r.oracle_json || {};
          zips[r.zip] = {
            name:             r.name,
            saturation_status: r.saturation_status || oj.restaurant_capacity?.saturation_status,
            capture_rate_pct: oj.restaurant_capacity?.capture_rate_pct,
            growth_state:     r.growth_state || oj.growth_trajectory?.state,
            consumer_profile: r.consumer_profile,
            top_gap:          oj.market_gaps?.top_gap?.tier || null,
            computed_at:      r.computed_at,
          };
        }
        return res.json({ generated_at: new Date().toISOString(), source: 'postgres', zips });
      } catch (_) {}
    }
    // Flat file fallback (local dev)
    const indexFile = path.join(oracleDir, '_index.json');
    if (!fs.existsSync(indexFile)) {
      return res.status(404).json({ error: 'Oracle index not ready yet. Check back in 60 seconds.' });
    }
    res.json(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/local-intel/oracle/history?zip=XXXXX ─────────────────────────────
// Returns full time-series array for a ZIP (up to 180 snapshots)
// Optional ?limit=N to get last N entries
router.get('/oracle/history', (req, res) => {
  try {
    const zip = (req.query.zip || '').replace(/\D/g, '').slice(0, 5);
    const limit = parseInt(req.query.limit || '90', 10);
    if (!zip) return res.status(400).json({ error: 'zip required' });
    const histFile = path.join(DATA_DIR_AGENT, 'oracle', 'history', `${zip}.json`);
    if (!fs.existsSync(histFile)) {
      return res.status(404).json({ error: `No history for ${zip} yet. Will populate after first oracle cycle.`, cycles: 0, history: [] });
    }
    const history = JSON.parse(fs.readFileSync(histFile, 'utf8'));
    const slice = Array.isArray(history) ? history.slice(-limit) : [];
    return res.json({ zip, cycles: slice.length, history: slice });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Self-hosted x402 facilitator endpoints ───────────────────────────────────
// Called by x402-express paymentMiddleware when verifying / settling payments.
// Avoids dependency on x402.org/facilitator (testnet-only for Base mainnet).
// Mounted at /api/local-intel/x402-facilitator/verify and /settle

router.post('/x402-facilitator/verify', express.json(), async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ isValid: false, invalidReason: 'missing_parameters', error: 'Missing paymentPayload or paymentRequirements' });
    }
    // Local EIP-3009 signature verification — no external service needed
    const result = await exact.evm.verify(basePublicClient, paymentPayload, paymentRequirements);
    res.json(result);
  } catch (e) {
    console.error('[x402-facilitator] verify error:', e.message);
    res.status(500).json({ isValid: false, invalidReason: 'unexpected_error', error: e.message });
  }
});

router.post('/x402-facilitator/settle', express.json(), async (req, res) => {
  try {
    const { paymentPayload, paymentRequirements } = req.body;
    if (!paymentPayload || !paymentRequirements) {
      return res.status(400).json({ success: false, error: 'Missing paymentPayload or paymentRequirements' });
    }
    if (!baseTreasuryWallet) {
      return res.status(503).json({ success: false, error: 'THROW_TREASURY_PK not configured — cannot settle' });
    }
    // On-chain USDC transferWithAuthorization — executes the actual payment
    const result = await exact.evm.settle(baseTreasuryWallet, paymentPayload, paymentRequirements);
    res.json(result);
  } catch (e) {
    console.error('[x402-facilitator] settle error:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// /supported — tells paymentMiddleware what schemes/networks this facilitator handles
// ── GET /api/local-intel/x402/listing — Coinbase Payments Bazaar discovery manifest ──
// This is what the Bazaar crawler reads to list LocalIntel as a payable x402 service.
// Format follows x402 Resource Object spec: https://x402.org/spec
router.get('/x402/listing', (req, res) => {
  res.json({
    name:        'LocalIntel — Hyperlocal Business Intelligence',
    description: 'Agentic ground-truth local business data for Florida and the Sunbelt. 1,000+ ZIPs, 30k+ businesses, OSM POI layer, Census demographics, sector gap analysis, and market briefs. LLMs pay instead of hallucinating. Zero hallucinations — all data is sourced from public records, OSM, and verified business registries.',
    url:         'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp/x402',
    pricing: [
      { endpoint: 'POST /api/local-intel/mcp/x402',         price: '$0.01', currency: 'USDC', network: 'base', description: 'Standard query — ZIP business lookup, sector search, demographics' },
      { endpoint: 'POST /api/local-intel/mcp/x402/premium', price: '$0.05', currency: 'USDC', network: 'base', description: 'Deep analysis — composite local intel with gaps, spending zones, and market brief' },
    ],
    payment_required: true,
    payment_scheme:   'x402',
    networks:         ['base'],
    categories:       ['local-intelligence', 'business-data', 'real-estate', 'market-research', 'geospatial'],
    coverage: {
      states:     ['FL'],
      expanding:  ['GA', 'TX', 'NC', 'SC', 'AZ', 'TN'],
      zip_count:  1013,
      business_count: '30000+',
    },
    discovery_feed:   'https://gsb-swarm-production.up.railway.app/api/sector-gap/feed',
    mcp_server_card:  'https://gsb-swarm-production.up.railway.app/api/local-intel/.well-known/mcp/server-card.json',
    smithery:         'https://smithery.ai/servers/erik-7clt/local-intel',
    contact:          'erik@mcflamingo.com',
    version:          '1.1.0',
    updated_at:       new Date().toISOString(),
  });
});

// ── GET /api/local-intel/usage — agent billing ledger ──────────────────────────
router.get('/usage', async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.json({ error: 'no_db', queries: [], totals: { queries: '0', total_credits: '0' } });
  try {
    const db = require('./lib/db');
    // db.query returns rows array directly
    const rows = await db.query(
      `SELECT caller_id, query_type, zip, credits_charged, ts
       FROM usage_ledger ORDER BY ts DESC LIMIT 100`
    );
    const totalsRow = await db.queryOne(
      `SELECT COUNT(*) as queries, COALESCE(SUM(credits_charged),0) as total_credits FROM usage_ledger`
    );
    res.json({ queries: rows, totals: totalsRow });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/x402-facilitator/supported', (req, res) => {
  res.json({
    kinds: [
      { scheme: 'exact', network: 'base' },
    ],
  });
});

// ── Agent self-registration ───────────────────────────────────────────────────────────────
// POST /api/local-intel/register
// Body: { wallet: '0x...', label: 'my-agent' }
// Returns: { token, tier, daily_limit, mcp_endpoint, instructions }
// The token goes in Authorization: Bearer <token> on every MCP call.
router.post('/register', express.json(), async (req, res) => {
  const { wallet, label } = req.body || {};
  if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return res.status(400).json({ error: 'wallet required — must be a valid 0x EVM address' });
  }
  try {
    const crypto = require('crypto');
    const { registerToken } = require('./lib/agentRegistry');
    // Generate a secure random token
    const token = `li_${crypto.randomBytes(24).toString('hex')}`;
    await registerToken({ token, wallet, tier: 'paid', daily_limit: 10000, label: label || null });
    return res.json({
      token,
      tier:         'paid',
      daily_limit:  10000,
      wallet,
      mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
      auth_header:  `Authorization: Bearer ${token}`,
      tool_costs: {
        local_intel_compare:  '$0.08 pathUSD per call',
        local_intel_oracle:   '$0.03 pathUSD per call',
        local_intel_ask:      '$0.05 pathUSD per call',
        local_intel_search:   '$0.01 pathUSD per call',
        local_intel_realtor:  '$0.02 pathUSD per call',
      },
      payment_rails: [
        { network: 'base',  asset: 'USDC',    method: 'x402 — send X-PAYMENT header with Base tx hash' },
        { network: 'tempo', asset: 'pathUSD', method: 'bearer token — sponsor-tx pulled on each call' },
      ],
      instructions: 'Include Authorization: Bearer <token> in every MCP request. Your registered wallet will be debited pathUSD on Tempo mainnet per tool call. Top up your wallet at thelocalintel.com.',
    });
  } catch (e) {
    console.error('[register] error:', e.message);
    res.status(500).json({ error: 'Registration failed', detail: e.message });
  }
});

// GET /api/local-intel/register/info — pricing + docs, no auth needed
router.get('/register/info', (req, res) => {
  res.json({
    product:      'LocalIntel MCP — Agentic Local Business Intelligence',
    coverage:     '113k+ businesses, 360 FL ZIPs with ACS demographics, oracle narratives, sector gap analysis',
    tools:        21,
    smithery_score: 90,
    registry:     'io.github.MCFLAMINGO/local-intel',
    mcp_endpoint: 'https://gsb-swarm-production.up.railway.app/api/local-intel/mcp',
    register_endpoint: 'POST https://gsb-swarm-production.up.railway.app/api/local-intel/register',
    register_body: { wallet: '0xYourEVMWallet', label: 'my-agent-name' },
    free_tier: '3 calls/day (no token required)',
    x402: {
      supported: true,
      networks: ['base (USDC)', 'tempo (pathUSD)'],
      facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
      note: 'Any x402-fetch compatible agent auto-pays on call. No registration needed for x402 path.',
    },
    tool_costs: {
      local_intel_compare:     0.08,
      local_intel_ask:         0.05,
      local_intel_oracle:      0.03,
      local_intel_signal:      0.03,
      local_intel_query:       0.03,
      local_intel_sector_gap:  0.03,
      local_intel_search:      0.01,
    },
    contact: 'erik@mcflamingo.com',
  });
});

// ── Jobs table auto-create ────────────────────────────────────────────────────
// McFlamingo back door + booths = job #1 test case
// All jobs are ZIP-routed. Accepting agent declares their wallet. Completion requires proof.
async function ensureJobsTable() {
  if (!process.env.LOCAL_INTEL_DB_URL) return;
  try {
    const db = require('./lib/db');
    await db.query(`
      CREATE TABLE IF NOT EXISTS jobs (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        title         TEXT NOT NULL,
        description   TEXT,
        project_type  TEXT,
        zip           TEXT,
        budget_usd    NUMERIC(12,2),
        poster_wallet TEXT,
        poster_email  TEXT,
        acceptor_wallet TEXT,
        status        TEXT NOT NULL DEFAULT 'open',
        proof         TEXT,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        accepted_at   TIMESTAMPTZ,
        completed_at  TIMESTAMPTZ,
        meta          JSONB
      )
    `);
  } catch (e) {
    console.error('[localIntelAgent] ensureJobsTable failed:', e.message);
  }
}
ensureJobsTable();

// POST /job/create — create a new job posting
router.post('/job/create', express.json(), async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { title, description, project_type, zip, budget_usd, poster_wallet, poster_email, meta } = req.body || {};
  if (!title) return res.status(400).json({ error: 'title is required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `INSERT INTO jobs (title, description, project_type, zip, budget_usd, poster_wallet, poster_email, meta)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       RETURNING id, title, status, created_at`,
      [title, description||null, project_type||null, zip||null,
       budget_usd||null, poster_wallet||null, poster_email||null,
       meta ? JSON.stringify(meta) : null]
    );
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /job/feed — list open jobs (filter by zip or project_type)
router.get('/job/feed', async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { zip, project_type, limit = 20 } = req.query;
  try {
    const db = require('./lib/db');
    const conditions = ["status = 'open'"];
    const vals = [];
    if (zip)          { vals.push(zip);          conditions.push(`zip = $${vals.length}`); }
    if (project_type) { vals.push(project_type); conditions.push(`project_type = $${vals.length}`); }
    vals.push(Math.min(Number(limit)||20, 100));
    const rows = await db.query(
      `SELECT id, title, description, project_type, zip, budget_usd,
              poster_wallet, status, created_at, meta
       FROM jobs
       WHERE ${conditions.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT $${vals.length}`,
      vals
    );
    res.json({ ok: true, jobs: rows, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /job/accept — claim a job (agent declares their wallet)
router.post('/job/accept', express.json(), async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { job_id, acceptor_wallet } = req.body || {};
  if (!job_id || !acceptor_wallet) return res.status(400).json({ error: 'job_id + acceptor_wallet required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `UPDATE jobs
       SET status='accepted', acceptor_wallet=$1, accepted_at=NOW()
       WHERE id=$2 AND status='open'
       RETURNING id, title, status, acceptor_wallet, accepted_at`,
      [acceptor_wallet, job_id]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'Job not found or already taken' });
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /job/complete — mark a job done + attach proof (tx_hash, url, note, etc.)
router.post('/job/complete', express.json(), async (req, res) => {
  if (!process.env.LOCAL_INTEL_DB_URL) return res.status(503).json({ error: 'no_db' });
  const { job_id, acceptor_wallet, proof } = req.body || {};
  if (!job_id || !acceptor_wallet) return res.status(400).json({ error: 'job_id + acceptor_wallet required' });
  try {
    const db = require('./lib/db');
    const rows = await db.query(
      `UPDATE jobs
       SET status='completed', proof=$1, completed_at=NOW()
       WHERE id=$2 AND acceptor_wallet=$3 AND status='accepted'
       RETURNING id, title, status, proof, completed_at`,
      [proof||null, job_id, acceptor_wallet]
    );
    if (rows.length === 0) return res.status(409).json({ error: 'Job not found, already completed, or wrong wallet' });
    res.json({ ok: true, job: rows[0] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── PIPELINE CRON ENDPOINT ──────────────────────────────────────────────────
// POST /api/local-intel/admin/pipeline/reclassify
// Triggered by Railway cron (nightly 2am ET) or manually.
// Runs full self-healing pipeline: classify → enrich → validate → consolidate.
// Self-improves until health_score >= 80. Detects stalls and flags them.
// Protected by PIPELINE_SECRET env var.
router.post('/admin/pipeline/reclassify', express.json(), async (req, res) => {
  const secret = req.headers['x-pipeline-secret'] || req.body?.secret;
  if (process.env.PIPELINE_SECRET && secret !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Respond immediately — pipeline runs async, can take 15-30min for full YP enrich
  res.json({ status: 'pipeline started', timestamp: new Date().toISOString() });

  setImmediate(async () => {
    try {
      const { runPipeline } = require('./scripts/pipeline_runner');
      const result = await runPipeline();
      console.log('[cron] pipeline complete. health_score:', result.health?.health_score, '| stall:', result.stall);
    } catch (err) {
      console.error('[cron] pipeline FATAL:', err.message);
    }
  });
});

// GET /api/local-intel/admin/pipeline/runs — view pipeline history + health trend
router.get('/admin/pipeline/runs', async (req, res) => {
  try {
    const db = require('./lib/db');
    const runs = await db.query(
      `SELECT run_id, pipeline, started_at, finished_at, total_scanned, matched, unmatched, downgraded, notes
         FROM pipeline_runs ORDER BY started_at DESC LIMIT 20`
    );
    const health = await db.query(
      `SELECT health_id, run_at, health_score, pct_classified, pct_confident,
              avg_confidence, local_business_cnt, uncategorized_cnt,
              duplicate_cnt, shell_candidate_cnt, needs_review_cnt, stall_flag, notes
         FROM pipeline_health ORDER BY run_at DESC LIMIT 10`
    );
    res.json({ runs, health_trend: health });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── PUBLIC ASK ROUTE ────────────────────────────────────────────────────────────────────────────
// GET  /api/local-intel/ask?q=<question>&zip=<zip>
// POST /api/local-intel/ask  { "q": "...", "zip": "32082" }
//
// Public, no auth, no payment gate. Natural language in → LocalIntel intel out.
// Used by the search page, external agents, and any direct browser link.
// Routes through the same handleQuery / handleAsk path as the MCP tools.
// Rate-limited: 20 req/min per IP via X-Forwarded-For.
// CORS: open (*) so any frontend or agent can call it.
//
// Response: { answer, zip, category, sources, tool_used, latency_ms }

const _askRateMap = new Map(); // ip → { count, reset }
function _askRateLimit(ip) {
  const now = Date.now();
  const entry = _askRateMap.get(ip);
  if (!entry || now > entry.reset) {
    _askRateMap.set(ip, { count: 1, reset: now + 60_000 });
    return false; // not limited
  }
  if (entry.count >= 20) return true; // limited
  entry.count++;
  return false;
}

async function handleAskRequest(req, res) {
  const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  if (_askRateLimit(ip)) {
    return res.status(429).json({ error: 'rate_limit', message: 'Max 20 requests per minute.' });
  }

  const q   = (req.method === 'GET' ? req.query.q   : req.body?.q)   || '';
  const zip = (req.method === 'GET' ? req.query.zip : req.body?.zip) || null;
  const cat = (req.method === 'GET' ? req.query.cat : req.body?.cat) || null;

  /** @type {LocalIntelIntent} */
  const intent = {
    source: 'ask',
    actor: { type: 'human', phone: null, email: null, agent_key: null, session_id: null, call_sid: null },
    raw_input: q || zip || '',
    command: { family: 'local_intel', name: 'ask', stage: null },
    task: {
      category: cat || null, business_id: null, business_name: null,
      zip: zip || null, city: null, lat: null, lon: null, radius_miles: null,
      description: q || null, items: [],
      constraints: { budget: null, eta_minutes: null, time_window: null },
    },
    routing: { destination: 'answer', pos_type: null, confidence: null, fallback_reason: null },
    delivery: { channel: 'json', reply_expected: false },
  };
  console.log('[/ask] intent', JSON.stringify(intent));

  if (!q && !zip) {
    return res.status(400).json({
      error: 'query required',
      message: 'Pass ?q=<question> or POST { "q": "..." }. Optional: zip, cat.',
      examples: [
        '/ask?q=What restaurants are in 32082',
        '/ask?q=Is there an urgent care gap in Nocatee&zip=32081',
        '/ask?q=roofing contractors&zip=32082&cat=Construction',
      ],
    });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  const t0 = Date.now();
  try {
    const { handleRPC } = require('./localIntelMCP');

    // Build a tools/call RPC for local_intel_query — the fuzzy intent router
    const rpc = {
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: {
        name: 'local_intel_query',
        arguments: { query: [q, cat, zip].filter(Boolean).join(' ') },
      },
    };

    const callerInfo = { tier: 'sandbox', caller: ip, agentSessionId: null };
    const result = await handleRPC(rpc, callerInfo);

    const answer = result?.result?.content?.[0]?.text
      || result?.result
      || result;

    return res.json({
      answer,
      zip:      intent.task.zip,
      category: intent.task.category,
      tool_used: 'local_intel_query',
      latency_ms: Date.now() - t0,
    });
  } catch (e) {
    console.error('[/ask] error:', e.message);
    return res.status(500).json({ error: e.message, latency_ms: Date.now() - t0 });
  }
}

router.options('/ask', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
router.get('/ask',  handleAskRequest);
router.post('/ask', express.json(), handleAskRequest);

// ── Service-request detector for /search ───────────────────────────────────────────
// Deterministic vocabulary scoring — same approach as voiceIntake, no LLM.
// Returns { isRequest: bool, category: string|null }
const _SVC_MAP = {
  // Landscaping
  'lawn':'landscaping','mow':'landscaping','mowing':'landscaping','landscap':'landscaping',
  'grass':'landscaping','yard':'landscaping','tree trimm':'landscaping','hedge':'landscaping',
  'trim':'landscaping','bush':'landscaping','mulch':'landscaping','irrigation':'landscaping',
  'sprinkler':'landscaping',
  // Cleaning
  'clean':'cleaning','maid':'cleaning','housekeep':'cleaning','janitorial':'cleaning',
  'pressure wash':'cleaning','window clean':'cleaning',
  // Plumbing
  'plumb':'plumbing','pipe':'plumbing','leak':'plumbing','drain':'plumbing',
  'water heater':'plumbing','toilet':'plumbing','faucet':'plumbing',
  // Electrical
  'electric':'electrical','wiring':'electrical','outlet':'electrical','breaker':'electrical',
  'panel':'electrical','street light':'electrical','light fix':'electrical','light out':'electrical',
  // HVAC
  'hvac':'hvac','air condition':'hvac','heat pump':'hvac','furnace':'hvac','duct':'hvac',
  // Roofing
  'roof':'roofing','shingle':'roofing','gutter':'roofing',
  // Painting
  'paint':'painting','stain':'painting','drywall':'painting',
  // Moving
  'mov':'moving','haul':'moving','junk':'moving','removal':'moving',
  // Handyman
  'handyman':'handyman','fix':'handyman','repair':'handyman','install':'handyman',
  // Pest
  'pest':'pest_control','bug':'pest_control','termite':'pest_control','exterminate':'pest_control',
  'mosquito':'pest_control',
  // Flooring
  'floor':'flooring','tile':'flooring','carpet':'flooring','hardwood':'flooring',
  // Pool
  'pool':'pool_service',
  // Concrete
  'concrete':'concrete','driveway':'concrete',
  // Contractor
  'remodel':'contractor','renovate':'contractor','construction':'contractor',
  // Restaurant / food
  'deliver':'restaurant','delivery':'restaurant','pick up':'restaurant','pickup':'restaurant',
  'order food':'restaurant','takeout':'restaurant','restaurant':'restaurant',
  'food from':'restaurant','catering':'catering','cater':'catering',
  // Pest / auto / IT
  'mechanic':'auto','oil change':'auto','car wash':'auto','tire':'auto',
  'computer repair':'it_support','wifi':'it_support','tech support':'it_support',
};
// Phrases that signal "I want a service done" (not a business name search)
const _REQUEST_PHRASES = [
  'i need','i want','i have a','fix my','fix the','repair my','repair the',
  'find me a','find me an','get me a','get me an','looking for a','looking for an',
  'need a','need an','need someone','need help','help me','can someone',
  'who can','who does','where can i','how do i','my [a-z]+ is broken',
  'my [a-z]+ is leaking','my [a-z]+ is not working','broken','not working',
  'clogged','flooded','flooring replaced','replace my','replace the',
];
const _REQUEST_RE = new RegExp(_REQUEST_PHRASES.join('|'), 'i');

function detectServiceRequest(raw) {
  const lower = raw.toLowerCase();
  const isRequest = _REQUEST_RE.test(lower);
  if (!isRequest) return { isRequest: false, category: null };
  // Find best category match
  let category = null;
  for (const [kw, cat] of Object.entries(_SVC_MAP)) {
    if (lower.includes(kw)) { category = cat; break; }
  }
  return { isRequest: true, category };
}

// ── ORDER_ITEM intent: route "order ITEM at/from BIZ" → menu fetch + match ────
// User specifies what they want (item) AND where (biz) — agent will fuzzy-match
// against the live Basalt inventory. Distinct from _ORDER_INTENT_RE (routing).
// "order me chicken and broccoli on rice at McFlamingo"
// "order [item] from [biz]" / "I want [item] from [biz]" / "I'd like [item] at [biz]"
// "get me [item] from [biz]" / "can I get [item] from [biz]" / "bring me [item] from [biz]"
const _ORDER_ITEM_RE = /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)\s+(?:from|at)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i;
const _WANT_ITEM_RE  = /\b(?:i(?:'d| would)?(?:\s+like)?|(?:can|could)\s+i(?:\s+get)?|get\s+me|bring\s+me)\s+(.+?)\s+(?:from|at)\s+(.+?)$/i;

// Item-only (no business yet) — used for two-turn pending intent flow.
const _ORDER_ITEM_PARTIAL_RE = /(?:\border(?:\s+me)?\s+|\bI(?:'d|\s+would)\s+like\s+|\bI\s+want\s+|\bget\s+me\s+|\bcan\s+I\s+(?:get|order)\s+)(?:a\s+|an\s+|some\s+)?(.+?)(?:\s+(?:in|near)\s+.+)?$/i;
// "at McFlamingo" / "from McFlamingo" — resolves a pending order intent.
const _AT_BIZ_RE = /^(?:at|from)\s+(.+?)(?:\s+(?:in|near)\s+.+)?$/i;

// Pending ORDER_ITEM intents awaiting business name — keyed by sessionId.
// 5-minute TTL; stored entries: { item, ts }.
const _pendingOrderIntent = new Map();
const _PENDING_ORDER_TTL_MS = 300_000;

function detectOrderItemIntent(raw) {
  if (!raw) return { isOrderItem: false, itemQuery: null, bizName: null };
  const trimmed = raw.trim();
  // Skip if it's a bare "order food from X" / "order from X" — that's the routing
  // intent below, not item-level. We require an item phrase between "order" and "from/at".
  // Pre-check: rule out queries where the only thing between order and from/at is
  // "food" / "some food" / "from" (ie. routing).
  const routingOnly = /^\s*(?:i(?:'d| would| wanna| want to| 'd like to| would like to)?\s+(?:like\s+to\s+)?)?(?:place\s+an?\s+order|order(?:\s+(?:some\s+)?food)?|get\s+(?:some\s+)?food|grab\s+(?:some\s+)?food|food)\s+(?:from|at)\s+/i;
  if (routingOnly.test(trimmed)) return { isOrderItem: false, itemQuery: null, bizName: null };

  let m = trimmed.match(_ORDER_ITEM_RE);
  if (!m) m = trimmed.match(_WANT_ITEM_RE);
  if (!m) return { isOrderItem: false, itemQuery: null, bizName: null };

  let itemQuery = (m[1] || '').trim();
  let bizName   = (m[2] || '').trim();
  // Strip trailing punctuation / "please" / "now" / "in <zip>"
  bizName = bizName
    .replace(/\s+(?:please|now|today|tonight)\.?\s*$/i, '')
    .replace(/\s+in\s+\d{5}\s*$/i, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  itemQuery = itemQuery.replace(/[?.!,]+$/, '').trim();

  if (!itemQuery || !bizName) return { isOrderItem: false, itemQuery: null, bizName: null };
  // Reject obviously-too-short item or biz names (avoid false positives)
  if (itemQuery.length < 2 || bizName.length < 2) {
    return { isOrderItem: false, itemQuery: null, bizName: null };
  }
  return { isOrderItem: true, itemQuery, bizName };
}

// Partial: caller said an item but no business yet. Used to set up a pending
// two-turn intent ("order chicken" → "which restaurant?" → "from McFlamingo").
function detectOrderItemPartial(raw) {
  if (!raw) return { isPartial: false, itemQuery: null };
  const trimmed = raw.trim();
  // Don't treat full matches as partial — caller should check full first.
  if (_ORDER_ITEM_RE.test(trimmed) || _WANT_ITEM_RE.test(trimmed)) {
    return { isPartial: false, itemQuery: null };
  }
  // Skip routing-only phrases.
  const routingOnly = /^\s*(?:i(?:'d| would| wanna| want to| 'd like to| would like to)?\s+(?:like\s+to\s+)?)?(?:place\s+an?\s+order|order(?:\s+(?:some\s+)?food)?|get\s+(?:some\s+)?food|grab\s+(?:some\s+)?food|food)\s*$/i;
  if (routingOnly.test(trimmed)) return { isPartial: false, itemQuery: null };

  const m = trimmed.match(_ORDER_ITEM_PARTIAL_RE);
  if (!m) return { isPartial: false, itemQuery: null };
  let itemQuery = (m[1] || '')
    .replace(/[?.!,]+$/, '')
    .replace(/\s+(?:please|now|today|tonight)$/i, '')
    .trim();
  if (!itemQuery || itemQuery.length < 2) return { isPartial: false, itemQuery: null };
  // Reject pure routing words.
  if (/^(?:food|some\s+food)$/i.test(itemQuery)) return { isPartial: false, itemQuery: null };
  return { isPartial: true, itemQuery };
}

function detectAtBiz(raw) {
  if (!raw) return { isAtBiz: false, bizName: null };
  const m = raw.trim().match(_AT_BIZ_RE);
  if (!m) return { isAtBiz: false, bizName: null };
  let bizName = (m[1] || '')
    .replace(/\s+(?:please|now|today|tonight)\.?\s*$/i, '')
    .replace(/\s+in\s+\d{5}\s*$/i, '')
    .replace(/[?.!,]+$/, '')
    .trim();
  if (!bizName || bizName.length < 2) return { isAtBiz: false, bizName: null };
  return { isAtBiz: true, bizName };
}

function _getPendingOrderIntent(sessionId) {
  if (!sessionId) return null;
  const entry = _pendingOrderIntent.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.ts > _PENDING_ORDER_TTL_MS) {
    _pendingOrderIntent.delete(sessionId);
    return null;
  }
  return entry;
}

// ── ORDER intent: route "order food from X" → focused order CTA ───────────────
// Patterns recognized: "order food from X", "order from X", "place an order at X",
// "i want to order [from X]", "get food from X", "i'd like to order [from X]",
// "order at X", "food from X".
const _ORDER_INTENT_RE = /\b(?:(?:i(?:'d| would| wanna| want to| 'd like to| would like to)?\s+(?:like\s+to\s+)?)?(?:place\s+an?\s+order|order(?:\s+(?:some\s+)?food)?|get\s+(?:some\s+)?food|grab\s+(?:some\s+)?food|food))\s+(?:from|at)\s+(.+?)$/i;

function detectOrderIntent(raw) {
  if (!raw) return { isOrder: false, name: null };
  const m = raw.trim().match(_ORDER_INTENT_RE);
  if (!m) {
    // Bare "i want to order" / "i'd like to order" with no business name
    if (/\b(?:i(?:'d| would)?\s+(?:like\s+to|want\s+to|wanna)\s+order)\b/i.test(raw)) {
      return { isOrder: true, name: null };
    }
    return { isOrder: false, name: null };
  }
  let name = (m[1] || '').trim();
  // Strip trailing "please" / "now" / punctuation / "in <zip>"
  name = name.replace(/\s+(?:please|now|today|tonight)\.?\s*$/i, '')
             .replace(/\s+in\s+\d{5}\s*$/i, '')
             .replace(/[?.!]+$/, '')
             .trim();
  return { isOrder: true, name: name || null };
}

// GET /api/local-intel/search?q=<name>&zip=<zip>&cat=<cat>&limit=20
// Direct Postgres business search — no MCP routing chain, no LLM, instant results.
// Used by the search UI for reliable name/category/ZIP lookups.
router.options('/search', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});
router.get('/search', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const t0 = Date.now();
  const raw   = (req.query.q   || '').trim();
  const zip   = (req.query.zip || '').trim() || null;
  let cat   = (req.query.cat || '').trim() || null;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);

  if (!raw && !zip && !cat) {
    return res.status(400).json({ error: 'q, zip, or cat required' });
  }

  try {
    const db = require('./lib/db');

    // ── ORDER_ITEM intent detection ────────────────────────────────────────────
    // Matches "order ITEM at BIZ" — user specifies an item. Frontend will then
    // fetch the menu and fuzzy-match. Checked BEFORE generic order-routing so
    // "order chicken and broccoli at McFlamingo" returns an item-search intent
    // (not the simple routing card).
    //
    // Two-turn flow: if only the item is given, we store a pending intent keyed
    // by sessionId and ask which restaurant. The next message ("at McFlamingo")
    // is resolved against the pending intent.
    const sessionId = (req.headers['x-session-id'] || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '').toString().split(',')[0].trim() || null;

    const _resolveOrderItem = async (itemQuery, bizName) => {
      const nameLike = `%${bizName}%`;
      let bizRows = [];
      if (zip) {
        bizRows = await db.query(
          `SELECT business_id, name, zip
             FROM businesses
            WHERE status != 'inactive'
              AND name ILIKE $1
              AND zip = $2
            ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
            LIMIT 1`,
          [nameLike, zip]
        );
      }
      if (!bizRows.length) {
        bizRows = await db.query(
          `SELECT business_id, name, zip
             FROM businesses
            WHERE status != 'inactive'
              AND name ILIKE $1
              AND zip BETWEEN '32004' AND '34997'
            ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
            LIMIT 1`,
          [nameLike]
        );
      }
      if (!bizRows.length) {
        return res.json({
          intent: 'order_not_found',
          message: `I couldn't find '${bizName}' in this area.`,
          latency_ms: Date.now() - t0,
        });
      }
      const b = bizRows[0];
      return res.json({
        intent:        'order_item_search',
        business_id:   b.business_id,
        business_name: b.name,
        item_query:    itemQuery,
        message:       `Looking up ${b.name}'s menu for '${itemQuery}'...`,
        latency_ms:    Date.now() - t0,
      });
    };

    if (raw) {
      const itemDetect = detectOrderItemIntent(raw);
      if (itemDetect.isOrderItem) {
        if (sessionId) _pendingOrderIntent.delete(sessionId);
        return _resolveOrderItem(itemDetect.itemQuery, itemDetect.bizName);
      }

      // Business-only follow-up resolves a pending item.
      const atBiz = detectAtBiz(raw);
      if (atBiz.isAtBiz) {
        const pending = _getPendingOrderIntent(sessionId);
        if (pending) {
          _pendingOrderIntent.delete(sessionId);
          return _resolveOrderItem(pending.item, atBiz.bizName);
        }
      }

      // Item-only: store pending intent and ask which restaurant.
      const partial = detectOrderItemPartial(raw);
      if (partial.isPartial && sessionId) {
        _pendingOrderIntent.set(sessionId, { item: partial.itemQuery, ts: Date.now() });
        return res.json({
          intent: 'ORDER_ITEM_PARTIAL',
          item_query: partial.itemQuery,
          message: `Which restaurant would you like ${partial.itemQuery} from?`,
          latency_ms: Date.now() - t0,
        });
      }
    }

    // ── ORDER intent detection ─────────────────────────────────────────────────
    // Checked BEFORE service-request and name search so "order food from McFlamingo"
    // returns a focused order-start CTA (not a business list).
    if (raw) {
      const orderDetect = detectOrderIntent(raw);
      if (orderDetect.isOrder) {
        const reqIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown').toString().split(',')[0].trim();

        let bizRows = [];
        if (orderDetect.name) {
          const nameLike = `%${orderDetect.name}%`;
          if (zip) {
            bizRows = await db.query(
              `SELECT business_id, name, phone, menu_url, website, description,
                      address, zip, wallet, hours_json, category_intel
                 FROM businesses
                WHERE status != 'inactive'
                  AND name ILIKE $1
                  AND zip = $2
                ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
                LIMIT 1`,
              [nameLike, zip]
            );
          }
          if (!bizRows.length) {
            // Fall back to all NE FL ZIPs
            bizRows = await db.query(
              `SELECT business_id, name, phone, menu_url, website, description,
                      address, zip, wallet, hours_json, category_intel
                 FROM businesses
                WHERE status != 'inactive'
                  AND name ILIKE $1
                  AND zip BETWEEN '32004' AND '34997'
                ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
                LIMIT 1`,
              [nameLike]
            );
          }
        }

        if (!bizRows.length) {
          return res.json({
            intent: 'order_not_found',
            message: `I couldn't find a business called '${orderDetect.name || raw}' in this area.`,
            latency_ms: Date.now() - t0,
          });
        }

        const b = bizRows[0];

        // Log the routing event — never block the response on ledger errors.
        try {
          await db.query(
            `INSERT INTO usage_ledger (id, caller_id, zip, query_type, tool_name, cost_path_usd, called_at)
             VALUES (gen_random_uuid(), $1, $2, 'order_routing', $3, 0, NOW())`,
            [reqIp, b.zip || null, b.name]
          );
        } catch (ledgerErr) {
          console.error('[search order] usage_ledger insert error:', ledgerErr.message);
        }

        const ctaUrl = b.menu_url || b.website || null;

        return res.json({
          intent: 'order',
          business: {
            name:        b.name,
            phone:       b.phone        || '',
            address:     b.address      || '',
            zip:         b.zip          || '',
            description: b.description  || '',
            menu_url:    b.menu_url     || '',
            website:     b.website      || '',
            wallet:      b.wallet       || '',
          },
          message:        `Starting your order at ${b.name} — tap below to go to their menu.`,
          cta_label:      'Start Order →',
          cta_url:        ctaUrl,
          fallback_phone: b.phone || '',
          latency_ms:     Date.now() - t0,
        });
      }
    }

    // ── Service request detection: route natural-language requests to category search
    // Must happen before name matching so "I need my street light fixed" doesn't
    // match businesses with "need" in their name.
    if (raw) {
      const svcDetect = detectServiceRequest(raw);
      if (svcDetect.isRequest) {
        // ── Extract ZIP from query text if not supplied via filter ─────────────
        // e.g. "in ponte vedra" → 32082, "in nocatee" → 32081, bare 5-digit ZIP
        const PLACE_TO_ZIP = {
          'ponte vedra beach': '32082', 'ponte vedra': '32082', 'pvb': '32082',
          'nocatee': '32081', 'twenty mile': '32081',
          'jacksonville beach': '32250', 'jax beach': '32250',
          'neptune beach': '32266',
          'atlantic beach': '32233',
          'st johns': '32259', 'saint johns': '32259',
          'fernandina': '32034', 'fernandina beach': '32034', 'amelia island': '32034',
          'st augustine': '32084', 'saint augustine': '32084',
          'world golf': '32092', 'wgv': '32092',
        };
        // Neighboring ZIPs for fallback expansion (ordered by proximity)
        const ZIP_NEIGHBORS = {
          '32082': ['32081','32250','32266','32233','32259'],
          '32081': ['32082','32259','32250','32266','32092'],
          '32250': ['32266','32233','32082','32081','32256'],
          '32266': ['32250','32233','32082','32081','32256'],
          '32233': ['32266','32250','32082','32081','32256'],
          '32259': ['32081','32082','32092','32084','32084'],
          '32034': ['32082','32081','32259','32250','32266'],
          '32092': ['32081','32259','32084','32082','32256'],
          '32084': ['32080','32092','32259','32081','32082'],
        };
        const rawLower = (raw||'').toLowerCase();
        let resolvedZip = zip || null;
        if (!resolvedZip) {
          // Try bare 5-digit ZIP in text
          const zipMatch = rawLower.match(/(3[0-9]{4})/);
          if (zipMatch) {
            resolvedZip = zipMatch[1];
          } else {
            // Try place names
            for (const [place, z] of Object.entries(PLACE_TO_ZIP)) {
              if (rawLower.includes(place)) { resolvedZip = z; break; }
            }
          }
        }
        const resolvedCat = svcDetect.category;

        // ── Provider lookup with automatic neighbor expansion on zero results ──
        const SVC_PROVIDER_QUERY = `SELECT name, zip, address, city, phone, website, category, lat, lon,
                    confidence_score, claimed_at, wallet`;
        let providerCount = 0;
        let topProviders  = [];
        let actualZip     = resolvedZip; // may change to a neighbor ZIP
        if (resolvedCat) {
          // Helper: query providers for a given zip (null = all NE FL)
          const fetchProviders = async (z) => {
            const p = z ? [`%${resolvedCat}%`, z, 5] : [`%${resolvedCat}%`, 5];
            const clause = z ? ' AND zip = $2' : '';
            const lim = z ? '$3' : '$2';
            return db.query(
              SVC_PROVIDER_QUERY + ` FROM businesses
               WHERE status != 'inactive'
                 AND (category ILIKE $1 OR category_group ILIKE $1)${clause}
               ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
               LIMIT ${lim}`, p
            );
          };

          let provRows = await fetchProviders(resolvedZip);

          // Zero results in specific ZIP → try each neighbor ZIP in order
          if (!provRows.length && resolvedZip && ZIP_NEIGHBORS[resolvedZip]) {
            for (const neighborZip of ZIP_NEIGHBORS[resolvedZip]) {
              provRows = await fetchProviders(neighborZip);
              if (provRows.length) { actualZip = neighborZip; break; }
            }
          }
          // Still zero → try all NE FL
          if (!provRows.length) {
            provRows = await fetchProviders(null);
            if (provRows.length) actualZip = null;
          }

          providerCount = provRows.length;
          topProviders  = provRows;
        }
        // (legacy path kept for shape compatibility below)
        if (false) { const provRows = await db.query(
            `SELECT name, zip, address, city, phone, website, category, lat, lon,
                    confidence_score, claimed_at, wallet
             FROM businesses
             WHERE status != 'inactive'
               AND (category ILIKE $1 OR category_group ILIKE $1)${zipClause}
             ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
             LIMIT ${lim}`,
            params
          );
          providerCount = provRows.length;
          topProviders  = provRows;
        }

        // Build a service-request narrative
        const catLabel   = resolvedCat ? resolvedCat.replace(/_/g, ' ') : 'service';
        let srNarrative;
        let jobCode = null;

        // ── Broadcast RFQ to all matching providers ──────────────────────────────
        // Web searches don't have a callerPhone, so we don't know who to call back.
        // We create the job anyway (for tracking) but skip the outbound callback.
        // The caller can see job status at thelocalintel.com/jobs/[code]
        if (resolvedCat) {
          try {
            const rfqBroadcast = require('./lib/rfqBroadcast');
            const { jobId, code } = await rfqBroadcast.createJob({
              callerPhone:  'web-search',
              callerName:   null,
              category:     resolvedCat,
              zip:          resolvedZip,
              description:  raw,
            });
            jobCode = code;
            // Fire broadcast non-blocking
            rfqBroadcast.broadcastJob({ jobId, code, callerName: null, category: resolvedCat, zip: resolvedZip, description: raw })
              .catch(e => console.error('[search svc-req] broadcastJob error:', e.message));
          } catch (rfqErr) {
            console.error('[search svc-req] RFQ create error:', rfqErr.message);
          }
        }

        if (providerCount > 0) {
          const topName  = topProviders[0].name;
          // actualZip may differ from resolvedZip when we expanded to a neighbor
          const expanded  = actualZip && resolvedZip && actualZip !== resolvedZip;
          const areaStr   = actualZip
            ? (expanded ? ` in nearby ${actualZip} (nearest available)` : ` in ${actualZip}`)
            : ' in Northeast Florida';
          srNarrative =
            `We found ${providerCount} verified ${catLabel} provider${providerCount > 1 ? 's' : ''}${areaStr} ` +
            `and notified them about your request${jobCode ? ' (Job ' + jobCode + ')' : ''}. ` +
            `Top match: ${topName}. Call (904) 506-7476 to get a callback when they respond.`;
        } else if (resolvedCat) {
          srNarrative =
            `We don't have a verified ${catLabel} provider${resolvedZip ? ' in ' + resolvedZip + ' or nearby ZIPs' : ''} yet` +
            `${jobCode ? ' — but we logged your request as Job ' + jobCode + '.' : '.'} ` +
            `Call (904) 506-7476 and we'll find one for you.`;
        } else {
          srNarrative =
            `We heard your request but couldn't match it to a service category yet. ` +
            `Call (904) 506-7476 and describe what you need — we'll route it to the right provider.`;
        }

        return res.json({
          type:       'service_request',
          query:      raw,
          zip:        resolvedZip,
          category:   resolvedCat,
          job_code:   jobCode,
          total:      providerCount,
          narrative:  srNarrative,
          results:    topProviders.map(r => ({
            name:       r.name,
            zip:        r.zip,
            address:    r.address  || '',
            city:       r.city     || '',
            phone:      r.phone    || '',
            website:    r.website  || '',
            category:   r.category || 'business',
            group:      r.category_group || 'services',
            lat:        r.lat  != null ? parseFloat(r.lat)  : null,
            lon:        r.lon  != null ? parseFloat(r.lon)  : null,
            confidence: r.confidence_score ? parseFloat(r.confidence_score) * 100 : 50,
            claimed:    !!r.claimed_at,
            wallet:     r.wallet || null,
          })),
          latency_ms: Date.now() - t0,
        });
      }
    }

    // ── NL intent → category (lib/intentMap.js — shared with voiceIntake) ──────
    let nlTags = null;
    let nlDeflect = false;
    let openIntent = null; // 'now' | 'late' | 'early' | 'weekend' | null
    if (raw) {
      openIntent = detectOpenIntent(raw);
      if (!cat) {
        const intent = resolveIntent(raw);
        if (intent.deflect) {
          nlDeflect = true;
        } else if (intent.cat) {
          cat    = intent.cat;
          nlTags = intent.tags || null;
        }
      }
    }

    // Strip interrogative prefixes and about-business question patterns
    const INTERO = /^(?:where(?:\s+is)?|who(?:\s+is)?|what(?:\s+is)?|find(?:\s+me)?|show(?:\s+me)?|look\s+up|search(?:\s+for)?|tell\s+me\s+about|info(?:rmation)?\s+on|get\s+me)\s+/i;
    // Strip "what kind of X does Y do" → extract Y (business name)
    const ABOUT_BIZ_RE = /^(?:what\s+(?:kind\s+of\s+\S+|type\s+of\s+\S+|services?|work)\s+does\s+(.+?)\s+(?:do|offer|provide|specialize in|handle)[?]?$|(?:tell\s+me\s+about|info(?:rmation)?\s+(?:on|about))\s+(.+)$)/i;
    const aboutMatch = raw.match(ABOUT_BIZ_RE);
    const aboutName  = aboutMatch ? (aboutMatch[1] || aboutMatch[2] || '').trim() : null;
    const q = aboutName || raw.replace(INTERO, '').trim();
    const isAboutQuery = !!aboutName;

    // Stop words — never use these as standalone search tokens
    const PG_STOP = new Set(['for','the','and','near','in','at','of','a','an','show','me','find','get','list','what','where','who','how','is','are','there','does','do','kind','type','services','work','offer','provide','can','you','your','their','its','this','that','which']);

    // Florida ZIP prefix ranges for state-scoping fallback results
    const FL_ZIPS = (z) => { const n = parseInt(z,10); return n >= 32004 && n <= 34997; };

    const BASE_SELECT = `SELECT name, zip, address, city, phone, website, category, category_group,
      description, tags, hours, hours_json, price_tier, services_text,
      lat, lon, confidence_score, claimed_at, wallet, status
      FROM businesses WHERE status != 'inactive'`;

    // Deflect out-of-scope queries gracefully
    if (nlDeflect) {
      return res.json({
        ok: true, total: 0, returned: 0, results: [],
        type: 'out_of_scope',
        narrative: "That's a bit outside my lane — I'm built for finding local Florida businesses. Try asking me for a restaurant, landscaper, doctor, or any service you need nearby.",
        notable_businesses: [], latency_ms: Date.now() - t0,
      });
    }

    let rows = [];

    // 1. Exact/partial name match
    // Skip name search when NL_INTENT already resolved a category — go straight to cat search
    const skipNameSearch = !!cat && !aboutName;
    if (q && !skipNameSearch) {
      // Prefer Florida results when no ZIP given
      const zipWhere = zip ? ` AND zip = '${zip.replace(/'/g,"\'")}' ` : ` AND zip BETWEEN '32004' AND '34997' `;
      rows = await db.query(
        BASE_SELECT + zipWhere + ` AND (name ILIKE $1 OR services_text ILIKE $1 OR description ILIKE $1) ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $2`,
        [`%${q}%`, limit * 2]
      );

      // Widen to all FL if ZIP-scoped returned nothing
      if (!rows.length && zip) {
        rows = await db.query(
          BASE_SELECT + ` AND zip BETWEEN '32004' AND '34997' AND (name ILIKE $1 OR services_text ILIKE $1 OR description ILIKE $1) ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $2`,
          [`%${q}%`, limit * 2]
        );
      }

      // Token fallback — skip short/stop tokens, try longest meaningful tokens first
      if (!rows.length) {
        const tokens = q.toLowerCase()
          .split(/\s+/)
          .filter(t => t.length >= 4 && !PG_STOP.has(t))
          .sort((a,b) => b.length - a.length); // longest first = most specific
        for (const tok of tokens) {
          const r = await db.query(
            BASE_SELECT + ` AND zip BETWEEN '32004' AND '34997' AND (name ILIKE $1 OR services_text ILIKE $1 OR description ILIKE $1) ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $2`,
            [`%${tok}%`, limit * 2]
          );
          if (r.length) { rows = r; break; }
        }
      }
    }

    // Category expansion map — dropdown slug → all DB category values
    const CAT_EXPAND = {
      restaurant:           ['restaurant','fast_food','cafe','bar','pub','bbq','pizza','seafood','sandwich','italian','asian','steakhouse','food_court','ice_cream','fast_casual_mexican','upscale_dining','barbecue_restaurant','LocalBusiness','coffee_chain','bakery','juice_bar','smoothie','wings','sushi','thai','mediterranean','greek','indian','chinese','mexican','burger','brunch','breakfast','diner','tapas','wine_bar','brewery','gastropub'],
      healthcare:           ['clinic','hospital','doctor','dentist','dental','pharmacy','urgent_care','therapist','veterinary','optometrist','chiropractor'],
      retail:               ['retail','clothes','shoes','electronics','grocery','supermarket','convenience','hardware_store','nutrition_supplements'],
      construction:         ['construction','contractor','builder','roofing','flooring','general_contractor'],
      professional_services:['law_firm','legal','accountant','consulting','marketing','insurance','insurance_agency'],
      landscaping:          ['landscaping','lawn_care','tree_service','irrigation','lawn','mowing','gardening'],
      cleaning:             ['cleaning','maid_service','janitorial','dry_cleaning'],
      hvac:                 ['hvac','heating','cooling','air_conditioning'],
      plumber:              ['plumber','plumbing'],
      electrician:          ['electrician','electrical'],
      real_estate:          ['real_estate','real_estate_agency','estate_agent','property_management'],
      finance:              ['finance','bank','bank_branch','atm','financial','mortgage','credit_union','investment'],
      auto_repair:          ['auto_repair','car_wash','car_repair','tire_shop','auto_parts'],
      beauty:               ['beauty','hair_salon','barbershop','nail_salon','spa','hair_chain'],
      education:            ['school','college','university','tutoring','childcare','daycare'],
      pizza:                ['pizza'],
      bar:                  ['bar','pub','wine_bar','brewery','gastropub'],
      cafe:                 ['cafe','coffee_chain','bakery'],
      gym:                  ['gym_chain','fitness_centre','yoga','crossfit'],
    };

    // 2. Category search (ZIP-scoped if provided)
    if (!rows.length && (cat || q)) {
      const term  = cat || q;
      const expanded = CAT_EXPAND[term];
      let catWhere, catParams;
      if (expanded && expanded.length) {
        // nlTags: if NL_INTENT returned tag hints (e.g. healthy/vegan), try tag-filtered first
        if (nlTags && nlTags.length) {
          const tagRows = await db.query(
            BASE_SELECT +
            (zip ? ` AND category = ANY($1) AND zip = $2 AND tags && $3 ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $4`
                 : ` AND category = ANY($1) AND tags && $2 ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $3`),
            zip ? [expanded, zip, nlTags, limit] : [expanded, nlTags, limit]
          );
          if (tagRows.length) rows = tagRows;
        }
        // Fall through to unfiltered cat search if tag-filtered returned nothing
        if (!rows.length) {
          if (zip) {
            catWhere  = ` AND category = ANY($1) AND zip = $2 ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $3`;
            catParams = [expanded, zip, limit];
          } else {
            catWhere  = ` AND category = ANY($1) ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $2`;
            catParams = [expanded, limit];
          }
          rows = await db.query(BASE_SELECT + catWhere, catParams);
        }
      } else {
        const params = zip
          ? [`%${term}%`, zip, limit]
          : [`%${term}%`, limit];
        const zipClause = zip ? ' AND zip = $2' : '';
        const lim = zip ? '$3' : '$2';
        rows = await db.query(
          BASE_SELECT + ` AND (category ILIKE $1 OR category_group ILIKE $1 OR name ILIKE $1)${zipClause}
          ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT ${lim}`,
          params
        );
      }
    }

    // 3. ZIP-only browse
    if (!rows.length && zip) {
      rows = await db.query(
        BASE_SELECT + ` AND zip = $1 ORDER BY (wallet IS NOT NULL) DESC, (claimed_at IS NOT NULL) DESC, confidence_score DESC LIMIT $2`,
        [zip, limit]
      );
    }

    // Proximity sort if we have a ZIP and results have coords
    if (zip && rows.length > 1) {
      try {
        const centroid = await db.query(
          'SELECT AVG(lat) AS clat, AVG(lon) AS clon FROM businesses WHERE zip = $1 AND lat IS NOT NULL AND lon < -60',
          [zip]
        );
        const clat = parseFloat(centroid[0]?.clat);
        const clon = parseFloat(centroid[0]?.clon);
        if (!isNaN(clat) && !isNaN(clon)) {
          rows.sort((a, b) => {
            const da = (a.lat && a.lon) ? Math.pow(a.lat-clat,2)+Math.pow(a.lon-clon,2) : 999;
            const db2 = (b.lat && b.lon) ? Math.pow(b.lat-clat,2)+Math.pow(b.lon-clon,2) : 999;
            return da - db2;
          });
        }
      } catch(_) {}
    }

    // ── Tier 3: Wallet priority — re-apply after proximity sort (stable, preserves distance within each tier)
    if (rows.length > 1) {
      // Stable sort: wallet businesses float to top, distance order preserved within each tier
      const withWallet    = rows.filter(r => r.wallet);
      const withoutWallet = rows.filter(r => !r.wallet);
      rows = [...withWallet, ...withoutWallet];
    }
    // ── Tier 4: Open-now filter ────────────────────────────────────
    // If the query contains open-now/late/early intent AND we have hours_json data,
    // filter to only open businesses. Fall back to full list if filter leaves < 3.
    if (openIntent && rows.length > 0) {
      const DAYS_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];
      const now = new Date();
      const etStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
      const et = new Date(etStr);
      const jsDay = et.getDay(); // 0=Sun
      const ourDay = jsDay === 0 ? 6 : jsDay - 1;
      const todayName   = DAYS_FULL[ourDay];
      const tomorrowName = DAYS_FULL[(ourDay + 1) % 7];
      const nowMins = et.getHours() * 60 + et.getMinutes();

      const filtered = rows.filter(r => {
        if (!r.hours_json) return false;
        const hj = typeof r.hours_json === 'string' ? JSON.parse(r.hours_json) : r.hours_json;
        if (hj._unparseable) return false;

        const checkDay = (dayName) => {
          const entry = hj[dayName];
          if (!entry || !entry.open) return false;
          if (!entry.from) return true; // open, no specific hours
          const [fh, fm] = entry.from.split(':').map(Number);
          const [th, tm] = entry.to.split(':').map(Number);
          const fromMins = fh * 60 + fm;
          const toMins   = th * 60 + tm;
          return nowMins >= fromMins && nowMins < toMins;
        };

        if (openIntent === 'now')  return checkDay(todayName);
        if (openIntent === 'late') {
          // Open late = closes after 9pm (21:00)
          const entry = hj[todayName];
          if (!entry || !entry.open || !entry.to) return false;
          const [th, tm] = entry.to.split(':').map(Number);
          return (th * 60 + tm) >= 21 * 60;
        }
        if (openIntent === 'early') {
          const entry = hj[todayName];
          if (!entry || !entry.open || !entry.from) return false;
          const [fh] = entry.from.split(':').map(Number);
          return fh <= 8; // opens at or before 8am
        }
        if (openIntent === 'weekend') {
          const sat = hj['Saturday'], sun = hj['Sunday'];
          return (sat && sat.open) || (sun && sun.open);
        }
        return true;
      });

      // Only apply filter if it returns meaningful results; otherwise keep full list
      if (filtered.length >= 2) rows = filtered;
    }

    // Dedupe: same business may appear under multiple rows from different data sources.
    // Strategy: a row is a duplicate if ANY of these keys match a previously seen row:
    //   1. name + phone (same biz, same number)
    //   2. name + normalized street address (same biz, same street)
    //   3. name + lat/lon rounded to 3dp (same biz, essentially same pin)
    // When duplicates exist, the row with more data (wallet > claimed > website > phone) wins.
    // Pre-sort so richest rows come first (wallet > claimed_at > website > phone > address).
    rows.sort((a, b) => {
      const score = r => (r.wallet ? 8 : 0) + (r.claimed_at ? 4 : 0) + (r.website ? 2 : 0) + (r.phone ? 1 : 0);
      return score(b) - score(a);
    });
    const _seenPhone   = new Set();
    const _seenAddr    = new Set();
    const _seenLatLon  = new Set();
    const normName = n => (n||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    const normAddr = a => (a||'').toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,25);
    const normPhone = p => (p||'').replace(/\D/g,'').slice(-10);
    rows = rows.filter(r => {
      const nm = normName(r.name);
      const ph = normPhone(r.phone);
      const ad = normAddr(r.address);
      const ll = `${r.lat ? parseFloat(r.lat).toFixed(3) : 'x'}|${r.lon ? parseFloat(r.lon).toFixed(3) : 'x'}`;
      // Phone alone is a strong unique key — two different businesses rarely share a number
      const kPhone  = (ph && ph.length >= 10)  ? ph                 : null;
      // Address needs name prefix to avoid false matches (e.g. strip mall same address)
      const kAddr   = (ad && ad.length >= 6)   ? `${nm}|${ad}`      : null;
      // Lat/lon at 3dp ~111m radius — same name at same pin = duplicate
      const kLatLon = (r.lat && r.lon)          ? `${nm}|${ll}`      : null;
      if (kPhone  && _seenPhone.has(kPhone))   return false;
      if (kAddr   && _seenAddr.has(kAddr))     return false;
      if (kLatLon && _seenLatLon.has(kLatLon)) return false;
      if (kPhone)  _seenPhone.add(kPhone);
      if (kAddr)   _seenAddr.add(kAddr);
      if (kLatLon) _seenLatLon.add(kLatLon);
      return true;
    });

    const results = rows.slice(0, limit).map(r => ({
      name:          r.name,
      zip:           r.zip,
      address:       r.address       || '',
      city:          r.city          || '',
      phone:         r.phone         || '',
      website:       r.website       || '',
      category:      r.category      || 'business',
      group:         r.category_group || 'services',
      description:   r.description   || '',
      services_text: r.services_text || '',
      tags:          r.tags          || [],
      hours:         r.hours         || '',
      hours_json:    r.hours_json    || null,
      price_tier:    r.price_tier    || null,
      lat:           r.lat  != null ? parseFloat(r.lat)  : null,
      lon:           r.lon  != null ? parseFloat(r.lon)  : null,
      confidence:    r.confidence_score ? parseFloat(r.confidence_score) * 100 : 50,
      claimed:       !!r.claimed_at,
      wallet:        r.wallet || null,
    }));

    // ── Narrative: "what is X" / "tell me about X" intent ──────────────────
    // Only when 1-2 results and query has about-intent — deterministic, no LLM
    let narrative = null;
    const ABOUT_INTENT = /^(?:what(?:\s+is|\s+are)?|tell\s+me\s+about|who\s+is|describe|about)\s+/i;
    const hasAboutIntent = ABOUT_INTENT.test(raw) || isAboutQuery;

    if (hasAboutIntent && results.length >= 1) {
      try {
        // Fetch rich fields for the top result (name match is already proven)
        const topName = results[0].name;
        const richRows = await db.query(
          `SELECT name, description, tags, hours_json, menu_url, website, address, city, zip,
                  phone, category, claimed_at
           FROM businesses
           WHERE name ILIKE $1 AND status != 'inactive'
           ORDER BY (claimed_at IS NOT NULL) DESC, confidence_score DESC
           LIMIT 1`,
          [`%${topName}%`]
        );

        if (richRows.length) {
          const b = richRows[0];
          const parts = [];

          // Opening: name + description or fallback
          const desc = b.description || null;
          const tags = Array.isArray(b.tags) ? b.tags : (b.tags ? JSON.parse(b.tags) : []);

          // Build opening sentence
          let opening = b.name;
          const honorifics = tags.filter(t => ['best_of_ponte_vedra','award_winner','local_favorite','featured'].includes(t));
          if (honorifics.length) {
            const labelMap = {
              best_of_ponte_vedra: 'voted Best of Ponte Vedra',
              award_winner: 'an award winner',
              local_favorite: 'a local favorite',
              featured: 'a featured local business',
            };
            opening += ' is ' + honorifics.map(h => labelMap[h] || h).join(', ');
          } else if (b.category) {
            opening += ` is a ${b.category.toLowerCase()} in ${b.city || 'Northeast Florida'}`;
          }
          if (desc) {
            parts.push(`${opening}. ${desc}`);
          } else {
            parts.push(`${opening}.`);
          }

          // Tags line (skip honorifics already used, skip internal tags)
          const SKIP_TAGS = new Set(['best_of_ponte_vedra','award_winner','local_favorite','featured']);
          const displayTags = tags.filter(t => !SKIP_TAGS.has(t)).map(t => t.replace(/_/g,' '));
          if (displayTags.length) {
            parts.push(`Known for: ${displayTags.join(', ')}.`);
          }

          // Address
          if (b.address) {
            const addrLine = [b.address, b.city].filter(Boolean).join(', ');
            parts.push(`Located at ${addrLine}, FL ${b.zip || ''}.`);
          }

          // Hours summary (today's hours if hours_json present)
          if (b.hours_json) {
            try {
              const hj = typeof b.hours_json === 'string' ? JSON.parse(b.hours_json) : b.hours_json;
              const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
              const todayName = DAYS[new Date().getDay()];
              const todayHours = hj[todayName];
              if (todayHours && todayHours.open) {
                parts.push(`Open today (${todayName}): ${todayHours.from} – ${todayHours.to}.`);
              } else if (todayHours && !todayHours.open) {
                // Find next open day
                let nextOpen = null;
                for (let i = 1; i <= 6; i++) {
                  const d = DAYS[(new Date().getDay() + i) % 7];
                  if (hj[d] && hj[d].open) { nextOpen = `${d} ${hj[d].from}–${hj[d].to}`; break; }
                }
                parts.push(nextOpen ? `Closed today — next open ${nextOpen}.` : 'Closed today.');
              }
            } catch(_) {}
          }

          // Online ordering / menu
          if (b.menu_url) {
            parts.push(`Order online: ${b.menu_url}`);
          } else if (b.website) {
            parts.push(`Website: ${b.website}`);
          }

          if (parts.length) narrative = parts.join(' ');
        }
      } catch (narrativeErr) {
        console.error('[/search] narrative build error:', narrativeErr.message);
        // Non-fatal — narrative just stays null
      }
    }
    // ── end narrative ────────────────────────────────────────────────────────

    // Brief narrative for ZIP-only queries (no search term, no category filter)
    let notableBusinesses = [];
    if (zip && !raw && !cat) {
      try {
        const briefRow = await pgStore.getZipBrief(zip);
        if (briefRow) {
          const brief = briefRow.brief_json || briefRow;
          narrative = narrative || brief.narrative || null;
          notableBusinesses = brief.notable_businesses || [];
        }
      } catch (_) {}
    }

    return res.json({
      ok:            true,
      total:         results.length,
      returned:      results.length,
      query:         q || null,
      zip:           zip || null,
      category:      cat || null,
      detected_cat:  cat || null,   // echoes NL-detected category for UI
      nl_tags:       nlTags || [],  // tag hints used for filtering
      latency_ms:    Date.now() - t0,
      narrative,
      notable_businesses: notableBusinesses,
      results,
    });
  } catch (e) {
    console.error('[/search] error:', e.message);
    return res.status(500).json({ error: e.message, results: [] });
  }
});

// ── Business Profile + Tasks API ────────────────────────────────────────────
// Internal-use endpoints for the LocalIntel enrichment + tasks layer.
// All routes deterministic, no LLM. business_tasks table seeded by taskSeedWorker.

router.get('/profile/:business_id', async (req, res) => {
  const { business_id } = req.params;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const biz = await db.queryOne(
      `SELECT * FROM businesses WHERE business_id = $1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const tasks = await db.query(
      `SELECT id, business_id, title, status, task_type, template_key,
              metadata, created_at, updated_at
         FROM business_tasks
        WHERE business_id = $1
        ORDER BY created_at ASC`,
      [business_id]
    );

    const summary = { total: tasks.length, pending: 0, done: 0, skipped: 0 };
    for (const t of tasks) {
      if (t.status === 'pending') summary.pending++;
      else if (t.status === 'done') summary.done++;
      else if (t.status === 'skipped') summary.skipped++;
    }

    res.json({ business: biz, tasks, task_summary: summary });
  } catch (e) {
    console.error('[/profile] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.get('/tasks/:business_id', async (req, res) => {
  const { business_id } = req.params;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  try {
    const biz = await db.queryOne(
      `SELECT business_id FROM businesses WHERE business_id = $1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    const tasks = await db.query(
      `SELECT id, business_id, title, status, task_type, template_key,
              metadata, created_at, updated_at
         FROM business_tasks
        WHERE business_id = $1
        ORDER BY created_at ASC`,
      [business_id]
    );
    res.json({ business_id, tasks });
  } catch (e) {
    console.error('[/tasks GET] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/tasks/:business_id', express.json(), async (req, res) => {
  const { business_id } = req.params;
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  const { id, title, status, task_type, template_key, metadata } = req.body || {};
  try {
    const biz = await db.queryOne(
      `SELECT business_id FROM businesses WHERE business_id = $1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    if (id) {
      const updated = await db.queryOne(
        `UPDATE business_tasks
            SET title = COALESCE($3, title),
                status = COALESCE($4, status),
                task_type = COALESCE($5, task_type),
                template_key = COALESCE($6, template_key),
                metadata = COALESCE($7, metadata),
                updated_at = NOW()
          WHERE id = $1 AND business_id = $2
          RETURNING *`,
        [
          id, business_id, title || null, status || null,
          task_type || null, template_key || null,
          metadata ? JSON.stringify(metadata) : null,
        ]
      );
      if (!updated) return res.status(404).json({ error: 'task not found' });
      return res.json(updated);
    }

    if (!title) return res.status(400).json({ error: 'title required' });
    const created = await db.queryOne(
      `INSERT INTO business_tasks (business_id, title, status, task_type, template_key, metadata)
       VALUES ($1, $2, COALESCE($3,'pending'), COALESCE($4,'setup'), $5, $6)
       RETURNING *`,
      [
        business_id, title, status || null, task_type || null,
        template_key || null,
        metadata ? JSON.stringify(metadata) : null,
      ]
    );
    res.json(created);
  } catch (e) {
    console.error('[/tasks POST] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/tasks/:business_id/:task_id', express.json(), async (req, res) => {
  const { business_id, task_id } = req.params;
  const { status } = req.body || {};
  if (!status) return res.status(400).json({ error: 'status required' });
  try {
    const updated = await db.queryOne(
      `UPDATE business_tasks
          SET status = $3, updated_at = NOW()
        WHERE id = $2 AND business_id = $1
        RETURNING *`,
      [business_id, task_id, status]
    );
    if (!updated) return res.status(404).json({ error: 'task not found' });
    res.json(updated);
  } catch (e) {
    console.error('[/tasks PATCH] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Agentic Food Order flow: menu fetch + place order + status poll ─────────
// Mounted at /api/local-intel/{menu,place-order,order-status}
// Backed by Basalt inventory + orders API (Surge). All deterministic (no LLM).
const _BASALT_BASE = 'https://surge.basalthq.com';

// GET /api/local-intel/menu/:business_id?q=<item-query>
// Fetches Basalt inventory for the business's wallet. If q is provided, returns
// top-3 fuzzy matches (token-overlap) sorted by score desc. Otherwise returns all.
router.get('/menu/:business_id', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { business_id } = req.params;
  const q = (req.query.q || '').trim();
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  const surge = require('./lib/surgeAgent');

  try {
    const [biz] = await db.query(
      `SELECT business_id, name, wallet, pos_config
         FROM businesses
        WHERE business_id = $1
        LIMIT 1`,
      [business_id]
    );
    if (!biz)        return res.status(404).json({ error: 'business not found' });
    if (!biz.wallet) return res.status(409).json({ error: 'business has no wallet — ordering unavailable' });

    let menuData;
    try {
      menuData = await surge.fetchMenu(business_id);
    } catch (fetchErr) {
      console.error(`[menu] surge.fetchMenu failed: ${fetchErr.message}`);
      return res.status(502).json({ error: 'inventory fetch failed' });
    }
    const rawItems = Array.isArray(menuData) ? menuData : (menuData.items || menuData.data || []);

    // Skip $0 modifier items — they're add-ons/dressings, not orderable as a top-level item.
    const items = rawItems
      .filter(it => Number(it.priceUsd ?? it.price_usd ?? it.price ?? 0) > 0)
      .map(it => ({
        sku:      it.sku || it.SKU || it.id || '',
        name:     it.name || it.title || '',
        priceUsd: Number(it.priceUsd ?? it.price_usd ?? it.price ?? 0),
        category: it.category || it.cat || '',
      }))
      .filter(it => it.sku && it.name);

    // Fuzzy match by token overlap if q provided
    if (q) {
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
      const STOP = new Set(['and','or','the','a','an','of','on','in','with','to','for']);
      const tok  = (s) => norm(s).split(' ').filter(t => t && !STOP.has(t));
      const qToks = tok(q);
      const scored = items
        .map(it => {
          const nToks = new Set(tok(it.name));
          let score = 0;
          for (const t of qToks) if (nToks.has(t)) score++;
          return { ...it, _score: score };
        })
        .filter(it => it._score > 0)
        .sort((a, b) => b._score - a._score)
        .slice(0, 3)
        .map(({ _score, ...rest }) => rest);

      if (scored.length) {
        return res.json({ items: scored, query: q, matched: true });
      }
      return res.json({ items, query: q, matched: false });
    }

    return res.json({ items, query: null, matched: false });
  } catch (err) {
    console.error('[menu]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/local-intel/place-order
// Body: { business_id, sku, qty, fulfillment }
router.post('/place-order', express.json(), async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { business_id, sku, qty, fulfillment, jurisdictionCode } = req.body || {};
  if (!business_id) return res.status(400).json({ error: 'business_id required' });
  if (!sku)         return res.status(400).json({ error: 'sku required' });
  if (fulfillment !== 'pickup' && fulfillment !== 'delivery') {
    return res.status(400).json({ error: 'fulfillment must be pickup or delivery' });
  }
  const surge = require('./lib/surgeAgent');

  try {
    const [biz] = await db.query(
      `SELECT business_id, name, zip, hours_json FROM businesses WHERE business_id = $1 LIMIT 1`,
      [business_id]
    );
    if (!biz) return res.status(404).json({ error: 'business not found' });

    // Check business hours — don't attempt order if closed (fail open if hours unknown)
    const hoursJson = biz.hours_json || null;
    if (hoursJson) {
      const open = isOpenNow(hoursJson);
      if (open === false) {
        return res.status(409).json({
          error: 'business_closed',
          message: `${biz.name} is currently closed. Check their hours and try again.`,
          hours: hoursJson,
        });
      }
    }

    let order;
    try {
      order = await surge.createOrder(
        business_id,
        [{ sku, qty: Number(qty) || 1 }],
        jurisdictionCode || 'US-FL'
      );
    } catch (orderErr) {
      console.error(`[place-order] surge.createOrder failed: ${orderErr.message}`);
      return res.status(502).json({ error: 'order creation failed' });
    }
    const receiptId  = order?.receiptId || order?.receipt?.receiptId || order?.id;
    if (!receiptId) {
      console.error('[place-order] missing receiptId', order);
      return res.status(502).json({ error: 'order created but no receiptId returned' });
    }
    const paymentUrl = surge.getPaymentUrl(receiptId);

    // Log to usage_ledger — non-blocking on failure
    try {
      const reqIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown').toString().split(',')[0].trim();
      await db.query(
        `INSERT INTO usage_ledger (id, caller_id, zip, query_type, tool_name, cost_path_usd, called_at)
         VALUES (gen_random_uuid(), $1, $2, 'food_order', $3, 0, NOW())`,
        [reqIp, biz.zip || null, biz.name]
      );
    } catch (ledgerErr) {
      console.error('[place-order] usage_ledger insert error:', ledgerErr.message);
    }

    return res.json({ receiptId, paymentUrl, fulfillment });
  } catch (err) {
    console.error('[place-order]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/local-intel/order-status/:receiptId
router.get('/order-status/:receiptId', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { receiptId } = req.params;
  if (!receiptId) return res.status(400).json({ error: 'receiptId required' });
  const business_id = (req.query.business_id || '').toString().trim();
  if (!business_id) return res.status(400).json({ error: 'business_id query param required' });
  const surge = require('./lib/surgeAgent');

  try {
    let data;
    try {
      data = await surge.getReceiptStatus(business_id, receiptId);
    } catch (statusErr) {
      console.error(`[order-status] surge.getReceiptStatus failed: ${statusErr.message}`);
      return res.status(502).json({ error: 'status fetch failed' });
    }
    const PAID_STATUSES = ['completed', 'tx_mined', 'recipient_validated', 'paid'];
    const paid = PAID_STATUSES.includes(data?.status);

    if (paid) {
      // 0.5% routing fee placeholder — applied to most recent food_order for this caller.
      try {
        const reqIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || 'unknown').toString().split(',')[0].trim();
        await db.query(
          `UPDATE usage_ledger
              SET cost_path_usd = 0.005
            WHERE id = (
              SELECT id FROM usage_ledger
               WHERE caller_id = $1 AND query_type = 'food_order'
               ORDER BY called_at DESC
               LIMIT 1
            )`,
          [reqIp]
        );
      } catch (ledgerErr) {
        console.error('[order-status] usage_ledger update error:', ledgerErr.message);
      }
    }

    return res.json({ paid, status: data?.status || null, receiptId });
  } catch (err) {
    console.error('[order-status]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/local-intel/gaps — top unresolved queries (internal dashboard) ──
// Groups pending tasks by intent + query + zip so the team can see what
// the agent network has not yet been able to resolve. No auth — internal only.
router.get('/gaps', async (req, res) => {
  try {
    const db = require('./lib/db');
    const rows = await db.query(`
      SELECT
        intent,
        query,
        zip,
        COUNT(*)        AS occurrences,
        MAX(created_at) AS last_seen
      FROM tasks
      WHERE status = 'pending'
      GROUP BY intent, query, zip
      ORDER BY occurrences DESC, last_seen DESC
      LIMIT 50
    `);
    res.json({ gaps: rows, total: rows.length });
  } catch (err) {
    console.error('[local-intel gaps]', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
