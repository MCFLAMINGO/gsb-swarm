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
const apiKeyMiddleware = createApiKeyMiddleware(db);

// ── x402 payment config ───────────────────────────────────────────────
// TREASURY receives USDC on Base mainnet.
// Agents without a Base wallet still use the Tempo/pathUSD endpoint (/api/local-intel/mcp).
// This x402 gate is ADDITIVE — a second payment rail, not a replacement.
const X402_TREASURY = process.env.X402_TREASURY || '0x774f484192Cf3F4fB9716Af2e15f44371fD32FEA';

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
// NIM-powered intent → group/tag mapping for human queries
const NL_INTENT_MAP = [
  { patterns: [/healthy|health food|organic|clean eat|nutritious|salad|vegan|vegetarian|juice|smoothie/i], group: 'food', tags: ['healthy','organic','vegan','vegetarian','juice','salad'] },
  { patterns: [/restaurant|eat|dining|food|lunch|dinner|breakfast|cafe|coffee|pizza|sushi|burger|taco|bbq|bar/i], group: 'food', tags: null },
  { patterns: [/doctor|dentist|clinic|medical|health|urgent care|physic|therapy|chiro|optom/i], group: 'health', tags: null },
  { patterns: [/lawyer|attorney|legal|law firm/i], group: 'legal', tags: null },
  { patterns: [/bank|finance|invest|insurance|mortgage|credit/i], group: 'finance', tags: null },
  { patterns: [/shop|store|retail|boutique|salon|spa|beauty|gym|fitness/i], group: 'retail', tags: null },
];

function resolveNlIntent(query) {
  if (!query) return { group: null, tags: null };
  for (const rule of NL_INTENT_MAP) {
    if (rule.patterns.some(p => p.test(query))) {
      return { group: rule.group, tags: rule.tags };
    }
  }
  return { group: null, tags: null };
}

router.post('/', async (req, res) => {
  const { zip, query, category, group, limit = 50, minConfidence = 0 } = req.body || {};

  try {
    const db = require('./lib/db');
    // ── Resolve NL intent ────────────────────────────────────────────────────
    const nlIntent = (!group && !category) ? resolveNlIntent(query) : { group: null, tags: null };
    const effectiveGroup = group || nlIntent.group;

    // ── Build Postgres query — all filtering in SQL ──────────────────────────
    const conditions = ["status != 'inactive'"]; // matches active + null, excludes only explicitly inactive
    const params = [];
    let p = 1;

    if (zip) {
      conditions.push(`zip = $${p++}`);
      params.push(zip);
    }
    if (category) {
      conditions.push(`category = $${p++}`);
      params.push(category);
    }
    if (effectiveGroup) {
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

    // Name/address text search
    let orderBy = 'confidence_score DESC, name ASC';
    if (query && !effectiveGroup) {
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
        hours, category, category_group, tags, description,
        confidence_score AS confidence, lat, lon, sunbiz_doc_number,
        claimed_at IS NOT NULL AS claimed
        ${tagBoost}
      FROM businesses
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${orderBy}
      LIMIT $${p}
    `;

    const rows = await db.query(sql, params);

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

    // Real total: COUNT(*) with same WHERE but no LIMIT — so callers know the full set size
    let realTotal = rows.length;
    try {
      // countParams = everything except the final LIMIT param
      const countParams  = params.slice(0, -1);
      const countSql     = `SELECT COUNT(*) AS total FROM businesses WHERE ${conditions.join(' AND ')}`;
      const countRows    = await db.query(countSql, countParams);
      realTotal          = parseInt(countRows[0]?.total || rows.length, 10);
    } catch (_) { /* non-fatal — fall back to page size */ }

    res.json({
      ok:       true,
      total:    realTotal,
      returned: rows.length,
      zips:     zip ? [zip] : [],
      results:  rows,
      meta: {
        source:   'postgres',
        coverage: '113,684 businesses — Florida statewide',
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
    if (biz.claimed_at) return res.status(409).json({ error: 'already claimed', claimed: true });

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
      `SELECT business_id, name, claim_token, claim_token_exp, claimed_at,
              notify_sms, notify_email, notify_push, notify_web
         FROM businesses WHERE business_id = $1 AND status = 'active'`,
      [business_id]
    );
    if (!biz)             return res.status(404).json({ error: 'business not found' });
    if (biz.claimed_at)   return res.status(409).json({ error: 'already claimed' });
    if (!biz.claim_token) return res.status(400).json({ error: 'no pending claim' });
    if (biz.claim_token !== String(token)) return res.status(401).json({ error: 'invalid code' });
    if (new Date(biz.claim_token_exp) < new Date()) return res.status(401).json({ error: 'code expired' });

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
              COALESCE(sunbiz_id, sunbiz_doc_number) AS sunbiz_id
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

// ── x402 MCP endpoints — Base/USDC payment rail (additive alongside pathUSD) ──
// Standard: $0.01 USDC on Base  |  Premium (local_intel_for_agent): $0.05 USDC
// Agents without Base wallets continue using /api/local-intel/mcp (Tempo/pathUSD)
// x402Middleware is scoped ONLY to these two routes — does NOT touch /mcp
router.post('/mcp/x402', x402Middleware, express.json(), async (req, res) => {
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

router.post('/mcp/x402/premium', x402Middleware, express.json(), async (req, res) => {
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
router.get('/stats', (req, res) => {
  // Florida ZIPs only — 32xxx, 33xxx, 34xxx
  const data = loadData().filter(b => b.zip && (
    b.zip.startsWith('32') || b.zip.startsWith('33') || b.zip.startsWith('34')
  ));
  const byZip = {};
  const byGroup = {};

  for (const b of data) {
    byZip[b.zip] = (byZip[b.zip] || 0) + 1;
    const g = getGroup(b.category);
    byGroup[g] = (byGroup[g] || 0) + 1;
  }

  const avgConf = data.length
    ? Math.round(data.reduce((s, b) => s + b.confidence, 0) / data.length)
    : 0;

  res.json({
    ok: true,
    totalBusinesses: data.length,
    avgConfidence:   avgConf,
    coverage: 'Florida only — 32xxx, 33xxx, 34xxx ZIPs',
    byZip,
    byGroup,
    sources: ['OSM','Census ACS 2022','FL Sunbiz'],
    pendingSources: ['SJC BTR','SJC Permits'],
    lastSync: '2026-04-20',
  });
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
router.get('/call-log', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  let ledger = [];
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
    }
  } catch {}

  const sorted = [...ledger]
    .sort((a, b) => new Date(b.ts || b.timestamp || 0) - new Date(a.ts || a.timestamp || 0))
    .slice(0, limit)
    .map(e => ({
      ts:      e.ts || e.timestamp || null,
      tool:    e.tool    || 'unknown',
      caller:  e.caller  || 'unknown',
      entry:   e.entry   || 'free',
      zip:     e.zip     || null,
      intent:  e.intent  || null,
      latency: e.latency || null,
      cost:    e.cost    || 0,
      paid:    e.paid    || false,
    }));

  res.json({ count: sorted.length, calls: sorted, generatedAt: new Date().toISOString() });
});

const DATA_DIR_AGENT = path.join(__dirname, 'data');

router.get('/coverage-stats', (req, res) => {
  try {
    const covFile   = path.join(DATA_DIR_AGENT, 'zipCoverage.json');
    const queueFile = path.join(DATA_DIR_AGENT, 'zipQueue.json');
    const zipsDir   = path.join(DATA_DIR_AGENT, 'zips');

    const cov   = covFile   && fs.existsSync(covFile)   ? JSON.parse(fs.readFileSync(covFile))   : { completed: {} };
    const queue = queueFile && fs.existsSync(queueFile) ? JSON.parse(fs.readFileSync(queueFile)) : [];

    // Build completedZips from actual data/zips/ files — zipCoverage.json may only
    // have seed entries and won't reflect 3 days of enrichment agent work.
    // Florida ZIPs only — filter any non-FL entries from coverage data
    const isFloridaZip = z => z && (z.startsWith('32') || z.startsWith('33') || z.startsWith('34'));
    let completedZips = Object.entries(cov.completed || {}).filter(([z]) => isFloridaZip(z));
    if (fs.existsSync(zipsDir)) {
      const zipFiles = fs.readdirSync(zipsDir).filter(f => f.endsWith('.json') && isFloridaZip(f.replace('.json','')));
      if (zipFiles.length > completedZips.length) {
        // Rebuild from actual files — these are the ground truth
        const fromFiles = {};
        // Carry over any metadata from zipCoverage.json first
        Object.entries(cov.completed || {}).forEach(([z, v]) => { fromFiles[z] = v; });
        zipFiles.forEach(f => {
          const zip = f.replace('.json', '');
          try {
            const bizs = JSON.parse(fs.readFileSync(path.join(zipsDir, f)));
            if (Array.isArray(bizs) && bizs.length > 0) {
              fromFiles[zip] = Object.assign({}, fromFiles[zip] || {}, {
                businesses: bizs.length,
                confidence: Math.round(bizs.reduce((s, b) => s + (b.confidence || 0), 0) / bizs.length),
                completedAt: fromFiles[zip]?.completedAt || new Date().toISOString(),
                source: 'zips_dir',
              });
            }
          } catch(e) { /* non-fatal */ }
        });
        completedZips = Object.entries(fromFiles);
      }
    }
    let totalBusinesses = completedZips.reduce((s, [, v]) => s + (v.businesses || 0), 0);

    // Average confidence from zip files
    let confSum = 0, confCount = 0;
    if (fs.existsSync(zipsDir)) {
      fs.readdirSync(zipsDir).filter(f => f.endsWith('.json')).forEach(f => {
        try {
          const bizs = JSON.parse(fs.readFileSync(path.join(zipsDir, f)));
          bizs.forEach(b => { confSum += (b.confidence || 0); confCount++; });
        } catch(e) {}
      });
    }

    // ── Fallback: if zip files have 0 businesses, count from localIntel.json ──
    if (totalBusinesses === 0 || confCount === 0) {
      try {
        const flat = JSON.parse(fs.readFileSync(DATA_PATH));
        if (Array.isArray(flat) && flat.length > 0) {
          totalBusinesses = flat.length;
          flat.forEach(b => { confSum += (b.confidence || 0); confCount++; });
          // Also synthesize completedZips from localIntel.json grouping if cov is empty
          if (completedZips.length === 0) {
            const byZip = {};
            flat.forEach(b => { const z = b.zip || 'unknown'; byZip[z] = (byZip[z] || 0) + 1; });
            Object.entries(byZip).forEach(([zip, count]) => {
              completedZips.push([zip, { businesses: count, completedAt: new Date().toISOString(), source: 'localIntel.json' }]);
            });
          }
        }
      } catch(e) { console.warn('[coverage-stats] localIntel.json fallback failed:', e.message); }
    }

    const inProgress = queue.filter(z => z.status === 'inProgress').length;
    const pending    = queue.filter(z => z.status === 'pending').length;
    const failed     = queue.filter(z => z.status === 'failed').length;

    // Last 20 completed zips sorted by completedAt desc
    // Enrich with businesses + confidence from zip files if coordinator didn't capture them
    const recentZips = completedZips
      .map(([zip, v]) => {
        let businesses = v.businesses;
        let confidence = v.confidence;
        // If count is missing or zero, try reading the zip file directly
        if (!businesses) {
          try {
            const zipFile = path.join(zipsDir, `${zip}.json`);
            if (fs.existsSync(zipFile)) {
              const bizs = JSON.parse(fs.readFileSync(zipFile));
              if (Array.isArray(bizs) && bizs.length > 0) {
                businesses = bizs.length;
                confidence = Math.round(bizs.reduce((s, b) => s + (b.confidence || 0), 0) / bizs.length);
              }
            }
          } catch(e) { /* non-fatal */ }
        }
        return { zip, ...v, businesses: businesses || 0, confidence: confidence || 0 };
      })
      .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt))
      .slice(0, 20);

    // Dynamic total: FL=1013 + unlocked sunbelt phases. Use queue length when available.
    const queueTotalDynamic = queue.length > 0 ? queue.length : 1013;
    res.json({
      zipsCompleted:    completedZips.length,
      zipsTotal:        queueTotalDynamic,
      totalBusinesses,
      avgConfidence:    confCount ? Math.round(confSum / confCount) : 0,
      activeAgents:     inProgress,
      pendingZips:      pending,
      failedZips:       failed,
      recentZips,
      lastRun:          cov.lastRun || null,
      generatedAt:      new Date().toISOString(),
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/source-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'sourceLog.json');
    const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : {};
    // Flatten to per-source latest status across all zips
    const sources = {};
    Object.values(data).forEach(zipSources => {
      Object.entries(zipSources).forEach(([source, entry]) => {
        if (!sources[source] || new Date(entry.checked_at) > new Date(sources[source].checked_at)) {
          sources[source] = entry;
        }
      });
    });
    res.json({ sources, raw: data, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/enrichment-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'enrichmentLog.json');
    const log  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const enrichedToday = log.filter(e => e.enrichedAt && new Date(e.enrichedAt) >= today).length;
    const recent = [...log].sort((a,b) => new Date(b.enrichedAt) - new Date(a.enrichedAt)).slice(0, 20);
    res.json({ enrichedToday, recent, total: log.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/broadcast-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'broadcastLog.json');
    const log  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    const recent = [...log].sort((a,b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 10);
    // Last successful hit per registry
    const lastByRegistry = {};
    log.forEach(e => {
      if (e.status === 'ok' && (!lastByRegistry[e.registry] || new Date(e.timestamp) > new Date(lastByRegistry[e.registry]))) {
        lastByRegistry[e.registry] = e.timestamp;
      }
    });
    res.json({ recent, lastByRegistry, total: log.length, generatedAt: new Date().toISOString() });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/mcp-probe-log', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'mcp_probe_log.json');
    const log  = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : [];
    // Summary by persona
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

router.get('/brief/:zip', (req, res) => {
  try {
    const zip  = (req.params.zip || '').replace(/\D/g, '').slice(0, 5);
    const file = path.join(DATA_DIR_AGENT, 'briefs', `${zip}.json`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: `No brief for ZIP ${zip} yet — check back after next brief worker cycle` });
    logUsage(getCallerId(req), 'brief', zip, 1);
    res.json(JSON.parse(fs.readFileSync(file)));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/briefs', (req, res) => {
  try {
    const dir = path.join(DATA_DIR_AGENT, 'briefs');
    if (!fs.existsSync(dir)) return res.json({ count: 0, zips: [] });
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    const summaries = files.map(f => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(dir, f)));
        return { zip: b.zip, label: b.label, total: b.total, data_grade: b.data_grade, generated_at: b.generated_at };
      } catch { return null; }
    }).filter(Boolean).sort((a,b) => (b.total||0)-(a.total||0));
    res.json({ count: summaries.length, zips: summaries });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.get('/router-learning', (req, res) => {
  try {
    const file = path.join(DATA_DIR_AGENT, 'router_learning.json');
    if (!fs.existsSync(file)) return res.json({ status: 'no_data_yet', message: 'Router learning worker has not run a cycle yet — check back in 35 minutes' });
    const data = JSON.parse(fs.readFileSync(file));
    // Surface the most useful summary
    const lastRun   = data.runs?.[data.runs.length - 1] || null;
    const recentPatches = (data.patches || []).slice(-20);
    const scoreTrend    = (data.score_trend || []).slice(-10);
    res.json({
      total_patches_applied: data.total_patches_applied || 0,
      last_run:              lastRun,
      recent_patches:        recentPatches,
      score_trend:           scoreTrend,
      verticals:             data.verticals,
      generatedAt:           new Date().toISOString(),
    });
  } catch(e) {
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

module.exports = router;
