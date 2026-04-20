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

const router = express.Router();

// ── Load dataset ──────────────────────────────────────────────────────────────
// In production this would be a DB — for now it's the JSON file written by the pull script
const DATA_PATH = path.join(__dirname, 'data', 'localIntel.json');
const ZONES_PATH = path.join(__dirname, 'data', 'spendingZones.json');

function loadData() {
  try { return JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')); }
  catch { return []; }
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
router.post('/', (req, res) => {
  const { zip, query, category, group, limit = 50, minConfidence = 0 } = req.body || {};

  let results = loadData();

  if (!results.length) {
    return res.status(503).json({ ok: false, error: 'Local intel dataset not loaded. Run data pull first.' });
  }

  // Filter
  if (zip)           results = results.filter(b => b.zip === zip);
  if (category)      results = results.filter(b => b.category === category);
  if (group)         results = results.filter(b => getGroup(b.category) === group);
  if (minConfidence) results = results.filter(b => b.confidence >= minConfidence);
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(b =>
      b.name.toLowerCase().includes(q) ||
      b.category.toLowerCase().includes(q) ||
      b.address.toLowerCase().includes(q)
    );
  }

  // Sort by confidence desc
  results.sort((a, b) => b.confidence - a.confidence);

  // Apply limit
  const total = results.length;
  results = results.slice(0, Math.min(limit, 200));

  res.json({
    ok:      true,
    total,
    returned: results.length,
    zips:    zip ? [zip] : ['32081','32082'],
    results,
    meta: {
      sources:      ['OSM','Census ACS 2022'],
      coverage:     '32081 (Nocatee) + 32082 (Ponte Vedra Beach)',
      lastSync:     '2026-04-20',
      pendingSources: ['FL Sunbiz','SJC BTR','SJC Permits'],
    },
  });
});

// ── GET /api/local-intel/zones — spending zone summary ────────────────────────
router.get('/zones', (req, res) => {
  const zones = loadZones();
  res.json({ ok: true, ...zones });
});

// ── POST /api/local-intel/claim — forward to worker on port 3003 ────────────
router.post('/claim', express.json(), async (req, res) => {
  try {
    const body = JSON.stringify(req.body || {});
    const response = await fetch('http://localhost:3003/claim', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ ok: false, error: 'Local Intel Worker unavailable: ' + e.message });
  }
});

// ── POST /api/mcp — proxy to MCP server on port 3004 ───────────────────────
// This is the public MCP endpoint agents call from outside Railway.
// Full URL: https://gsb-swarm-production.up.railway.app/api/mcp
router.post('/mcp', express.json(), async (req, res) => {
  try {
    const body = JSON.stringify(req.body || {});
    const response = await fetch('http://localhost:3004/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const data = await response.json();
    res.status(response.status).json(data);
  } catch (e) {
    res.status(503).json({ jsonrpc: '2.0', id: null, error: { code: -32603, message: 'MCP server unavailable: ' + e.message } });
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

// ── GET /api/local-intel/stats — coverage stats ───────────────────────────────
router.get('/stats', (req, res) => {
  const data = loadData();
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
    byZip,
    byGroup,
    sources: ['OSM','Census ACS 2022'],
    pendingSources: ['FL Sunbiz','SJC BTR','SJC Permits'],
    lastSync: '2026-04-20',
  });
});

module.exports = router;
