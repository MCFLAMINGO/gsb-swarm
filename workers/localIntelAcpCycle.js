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

const fs   = require('fs');
const path = require('path');

const { getZipsByPriority }               = require('./flZipRegistry');
const { handleVerticalQuery }             = require('./verticalAgentWorker');
const { handleSignal, handleBedrock }     = require('../localIntelTidalTools');

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_DIR       = path.join(__dirname, '..');
const BRIEFS_DIR     = path.join(BASE_DIR, 'data', 'briefs');
const OSM_DIR        = path.join(BASE_DIR, 'data', 'osm');
const CENSUS_DIR     = path.join(BASE_DIR, 'data', 'census_layer');
const ZONES_PATH     = path.join(BASE_DIR, 'data', 'spendingZones.json');
const CYCLE_INTERVAL = 30 * 60 * 1000;  // 30 min
const ZIPS_PER_CYCLE = 5;
const BRIEF_TTL_H    = 48;

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms)    { return new Promise(r => setTimeout(r, ms)); }
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function readJson(fp)  { try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; } }

function loadZone(zip) {
  const zones = readJson(ZONES_PATH) || [];
  return zones.find(z => String(z.zip || z.zipCode) === String(zip)) || null;
}
function loadOsm(zip)    { return readJson(path.join(OSM_DIR,    `${zip}.json`)); }
function loadCensus(zip) { return readJson(path.join(CENSUS_DIR, `${zip}.json`)); }

function briefAge(zip) {
  const b = readJson(path.join(BRIEFS_DIR, `${zip}.json`));
  if (!b?.generated_at) return Infinity;
  return Date.now() - new Date(b.generated_at).getTime();
}

function saveBrief(zip, data) {
  ensureDir(BRIEFS_DIR);
  fs.writeFileSync(
    path.join(BRIEFS_DIR, `${zip}.json`),
    JSON.stringify({ zip, generated_at: new Date().toISOString(), ...data })
  );
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
function alphaWhitespaceScan(zip) {
  const cl   = loadCensus(zip);
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
function tokenAnalystUnderwrite(zip) {
  const zone = loadZone(zip);
  const osm  = loadOsm(zip);
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

  // Token Analyst and Alpha Scanner are sync reads — run instantly
  const token = tokenAnalystUnderwrite(zip);
  const alpha = alphaWhitespaceScan(zip);

  // CEO (async tidal) and Wallet Profiler (async vertical) run in parallel
  const [ceo, wallet] = await Promise.all([
    ceoInvestorScan(zip),
    walletProfilerScan(zip),
  ]);

  const thread = threadWriterSynthesize(zip, { ceo, alpha, token, wallet });

  saveBrief(zip, { ceo, alpha, token, wallet, thread });
  console.log(`[acp-cycle] ZIP ${zip} done — ${ceo.signal_band ?? 'no signal'} | gaps:${alpha.total_gaps} | "${thread.brief.slice(0, 60)}..."`);
}

// ── Pick ZIPs needing briefs ──────────────────────────────────────────────────
function pickNextZips(n) {
  const ttl   = BRIEF_TTL_H * 60 * 60 * 1000;
  return getZipsByPriority()
    .filter(z => briefAge(z.zip) > ttl)
    .slice(0, n)
    .map(z => z.zip);
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  console.log('[acp-cycle] ACP intelligence cycle started');
  ensureDir(BRIEFS_DIR);

  // Stagger 2 min — let Overpass + IRS SOI initialize first
  await sleep(2 * 60 * 1000);

  while (true) {
    const zips = pickNextZips(ZIPS_PER_CYCLE);
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
