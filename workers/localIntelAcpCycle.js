'use strict';
/**
 * localIntelAcpCycle.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 5-agent ACP intelligence cycle for LocalIntel ZIP coverage.
 *
 * Agents act as a development intelligence team scanning FL ZIPs:
 *   GSB CEO (Investor)         → signal + bedrock
 *   Alpha Scanner (Deal Scout) → sector gaps from census_layer
 *   Token Analyst (Underwriter)→ zone economics + IRS/OSM data
 *   Wallet Profiler (Demo)     → retail + healthcare vertical scans
 *   Thread Writer (Narrator)   → plain-text synthesis (no LLM cost)
 *
 * Output: data/briefs/{zip}.json — raw JSON, LLM-queryable, no formatting
 * Cycle: every 30 min, 5 ZIPs per run, cheapest possible calls (no HTTP)
 */

const path = require('path');
const fs   = require('fs');  // for spendingZones.json static seed only

const { getZipsByPriority }               = require('./flZipRegistry');
const { handleVerticalQuery }             = require('./verticalAgentWorker');
const { handleSignal, handleBedrock }     = require('../localIntelTidalTools');
const pgStore                              = require('../lib/pgStore');
const db                                   = require('../lib/db');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_DIR       = path.join(__dirname, '..');
const ZONES_PATH     = path.join(BASE_DIR, 'data', 'spendingZones.json');  // static seed
const CYCLE_INTERVAL = 30 * 60 * 1000;  // 30 min
const ZIPS_PER_CYCLE = 5;
const BRIEF_TTL_H    = 48;
const FULL_REFRESH   = process.env.FULL_REFRESH === 'true';

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }

function readJson(fp)  { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }

function loadZone(zip) {
  const zones = readJson(ZONES_PATH) || [];
  return zones.find(z => String(z.zip || z.zipCode) === String(zip)) || null;
}

async function loadOsm(zip) {
  const row = await pgStore.getZipEnrichment(zip);
  return row?.osm_json || null;
}

async function loadCensus(zip) {
  const row = await pgStore.getCensusLayer(zip);
  return row || null;
}

async function briefAge(zip) {
  const b = await pgStore.getZipBrief(zip);
  if (!b?._stored_at) return Infinity;
  return Date.now() - new Date(b._stored_at).getTime();
}

async function saveBrief(zip, data) {
  // Direct upsert into zip_briefs — no flat-file fallback.
  const brief = { zip, generated_at: new Date().toISOString(), ...data };
  await db.query(
    `INSERT INTO zip_briefs (zip, brief_json, generated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (zip) DO UPDATE SET brief_json = EXCLUDED.brief_json, generated_at = NOW()`,
    [zip, JSON.stringify(brief)]
  );
}

async function getFreshZipSet() {
  if (FULL_REFRESH) return new Set();
  try {
    const rows = await db.query(
      `SELECT zip FROM zip_briefs WHERE generated_at > NOW() - INTERVAL '48 hours'`
    );
    return new Set(rows.map(r => r.zip));
  } catch (e) {
    console.warn('[acp-cycle] fresh-zip lookup failed:', e.message);
    return new Set();
  }
}

// ── Agent 1: GSB CEO — investor signal ───────────────────────────────────────
async function ceoInvestorScan(zip) {
  const [signal, bedrock] = await Promise.all([
    Promise.resolve(handleSignal({ zip })).catch(() => null),
    Promise.resolve(handleBedrock({ zip })).catch(() => null),
  ]);
  return {
    agent        : 'ceo',
    role         : 'investor',
    signal_score : signal?.score   ?? null,
    signal_band  : signal?.band    ?? null,
    signal_reasons: (signal?.reasons ?? []).slice(0, 3),
    bedrock_score: bedrock?.score  ?? null,
    bedrock_flags: (bedrock?.flags ?? []).slice(0, 3),
  };
}

// ── Agent 2: Alpha Scanner — sector gap whitespace ────────────────────────────
async function alphaWhitespaceScan(zip) {
  const cl   = await loadCensus(zip);
  const gaps = cl?.sector_gaps ?? [];
  return {
    agent     : 'alpha_scanner',
    role      : 'deal_scout',
    top_gaps  : gaps.slice(0, 3).map(g => ({
      sector    : g.sector_name || g.sector || null,
      naics     : g.naics || null,
      demand_est: g.demand_estimate || null,
      confidence: g.confidence_tier || g.confidence || null,
      signal    : g.signal || null,
    })),
    total_gaps: gaps.length,
  };
}

// ── Agent 3: Token Analyst — zone economics ───────────────────────────────────
async function tokenAnalystUnderwrite(zip) {
  const zone = loadZone(zip);
  const osm  = await loadOsm(zip);
  return {
    agent          : 'token_analyst',
    role           : 'underwriter',
    population     : zone?.population        ?? null,
    median_hhi     : zone?.median_hhi        ?? null,
    home_value     : zone?.median_home_value ?? null,
    zone_score     : zone?.zone_score        ?? null,
    irs_agi_median : osm?.irs_agi_median     ?? zone?.irs_agi_median    ?? null,
    irs_wage_share : osm?.irs_wage_share_pct ?? zone?.irs_wage_share_pct ?? null,
    osm_poi_count  : osm?.osm_poi_count      ?? null,
  };
}

// ── Agent 4: Wallet Profiler — retail + healthcare scan ───────────────────────
async function walletProfilerScan(zip) {
  const [retail, health] = await Promise.all([
    handleVerticalQuery('retail',     `retail market profile for zip ${zip}`, zip).catch(() => null),
    handleVerticalQuery('healthcare', `healthcare demand in zip ${zip}`,      zip).catch(() => null),
  ]);
  return {
    agent              : 'wallet_profiler',
    role               : 'demographics',
    retail_summary     : (retail?.answer  ?? retail?.summary  ?? '').slice(0, 200) || null,
    retail_score       : retail?.score    ?? null,
    healthcare_summary : (health?.answer  ?? health?.summary  ?? '').slice(0, 200) || null,
    healthcare_score   : health?.score    ?? null,
  };
}

// ── Agent 5: Thread Writer — plain-text synthesis (zero cost) ─────────────────
function threadWriterSynthesize(zip, { ceo, alpha, token, wallet }) {
  const parts = [];
  if (ceo.signal_band)         parts.push(`Signal: ${ceo.signal_band} (${ceo.signal_score ?? '?'}/100).`);
  if (alpha.top_gaps?.length)  parts.push(`Top gap: ${alpha.top_gaps[0].sector}.`);
  const demo = [
    token.population  ? `pop ${(token.population).toLocaleString()}`        : '',
    token.median_hhi  ? `HHI $${Math.round(token.median_hhi / 1000)}k`      : '',
    token.osm_poi_count != null ? `${token.osm_poi_count} OSM POIs`         : '',
  ].filter(Boolean).join(', ');
  if (demo) parts.push(demo + '.');
  if (wallet.retail_summary)      parts.push(`Retail: ${wallet.retail_summary}`);
  if (wallet.healthcare_summary)  parts.push(`Healthcare: ${wallet.healthcare_summary}`);

  return {
    agent : 'thread_writer',
    role  : 'narrator',
    brief : parts.join(' ').slice(0, 600),
  };
}

// ── Full cycle for one ZIP ────────────────────────────────────────────────────
async function runZipCycle(zip) {
  console.log(`[acp-cycle] ZIP ${zip} start`);

  const [token, alpha, ceo, wallet] = await Promise.all([
    tokenAnalystUnderwrite(zip),
    alphaWhitespaceScan(zip),
    ceoInvestorScan(zip),
    walletProfilerScan(zip),
  ]);

  const thread = threadWriterSynthesize(zip, { ceo, alpha, token, wallet });

  await saveBrief(zip, { ceo, alpha, token, wallet, thread });
  console.log(`[acp-cycle] ZIP ${zip} done — ${ceo.signal_band ?? 'no signal'} | gaps:${alpha.total_gaps} | "${thread.brief.slice(0, 60)}..."`);
}

// ── Pick ZIPs needing briefs ──────────────────────────────────────────────────
async function pickNextZips(n) {
  // Step 1 of the contract: ASK Postgres what's already done (fresh briefs).
  const freshSet = await getFreshZipSet();
  const candidates = getZipsByPriority();
  const stale = [];
  for (const z of candidates) {
    if (stale.length >= n) break;
    if (freshSet.has(z.zip)) continue;
    stale.push(z.zip);
  }
  return stale;
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  console.log('[acp-cycle] ACP intelligence cycle started');

  // Stagger 2 min — let Overpass + IRS SOI initialize first
  await sleep(2 * 60 * 1000);

  while (true) {
    const zips = await pickNextZips(ZIPS_PER_CYCLE);
    if (zips.length === 0) {
      console.log('[acp-cycle] All ZIPs fresh — waiting');
    } else {
      console.log(`[acp-cycle] Cycle — ${zips.join(', ')}`);
      for (const zip of zips) {
        try   { await runZipCycle(zip); }
        catch (err) { console.error(`[acp-cycle] ${zip} error:`, err.message); }
        await sleep(3000);
      }
    }
    await sleep(CYCLE_INTERVAL);
  }
})();
