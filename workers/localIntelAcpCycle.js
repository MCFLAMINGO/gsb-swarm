'use strict';
/**
 * localIntelAcpCycle.js
 * ─────────────────────────────────────────────────────────────────────────────
 * 5-agent ACP intelligence cycle for LocalIntel ZIP coverage.
 *
 * Each cycle picks the highest-population uncached ZIPs and runs them through
 * a simulated development intelligence team:
 *
 *   GSB CEO (Investor)        → signal + oracle      → local_intel_signal, local_intel_oracle
 *   Alpha Scanner (Deal Scout)→ whitespace            → local_intel_sector_gap
 *   Token Analyst (Underwriter)→ economics            → local_intel_zone + IRS data
 *   Wallet Profiler (Demographics)→ buyer profile     → local_intel_healthcare, local_intel_retail
 *   Thread Writer (Narrator)  → market brief          → local_intel_ask (synthesis)
 *
 * Output: data/briefs/{zip}.json — plain JSON, LLM-queryable, no formatting overhead
 *
 * Cycle: every 30 min, 5 ZIPs per cycle, cheapest possible internal calls
 * All calls are internal (no HTTP) — directly require the handler functions
 */

const fs   = require('fs');
const path = require('path');

const { getZipsByPriority } = require('./flZipRegistry');

// ── Internal tool handlers (no HTTP, no cost) ─────────────────────────────────
const { handleRPC }          = require('../localIntelMCP');
const { handleVerticalQuery } = require('./verticalAgentWorker');

// ── Config ────────────────────────────────────────────────────────────────────
const BRIEFS_DIR     = path.join(__dirname, '..', 'data', 'briefs');
const ZIPS_DIR       = path.join(__dirname, '..', 'data', 'zips');
const CYCLE_INTERVAL = 30 * 60 * 1000;   // 30 min
const ZIPS_PER_CYCLE = 5;
const BRIEF_TTL_H    = 48;               // re-run ZIP after 48h

// ── Helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function briefAge(zip) {
  const fp = path.join(BRIEFS_DIR, `${zip}.json`);
  try {
    const b = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const age = Date.now() - new Date(b.generated_at || 0).getTime();
    return age;
  } catch { return Infinity; }
}

function saveBrief(zip, brief) {
  ensureDir(BRIEFS_DIR);
  fs.writeFileSync(
    path.join(BRIEFS_DIR, `${zip}.json`),
    JSON.stringify({ zip, generated_at: new Date().toISOString(), ...brief })
  );
}

// Call an internal MCP tool directly (no HTTP)
async function callTool(toolName, params) {
  try {
    const result = await handleRPC({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: params }
    });
    if (result?.result?.content?.[0]?.text) {
      return JSON.parse(result.result.content[0].text);
    }
    return result?.result || null;
  } catch (e) {
    return { error: e.message };
  }
}

// ── Agent roles ───────────────────────────────────────────────────────────────

// GSB CEO — investor view: signal + oracle
async function ceoInvestorScan(zip) {
  const [signal, oracle] = await Promise.all([
    callTool('local_intel_signal', { zip }),
    callTool('local_intel_oracle', { zip }),
  ]);
  return {
    agent: 'ceo',
    role: 'investor',
    signal_score: signal?.score ?? null,
    signal_band: signal?.band ?? null,
    signal_reasons: signal?.reasons ?? [],
    oracle_summary: oracle?.summary ?? null,
    oracle_questions: oracle?.questions ?? [],
  };
}

// Alpha Scanner — deal scout: sector gaps = whitespace
async function alphaWhitespaceScan(zip) {
  const gaps = await callTool('local_intel_sector_gap', { zip });
  return {
    agent: 'alpha_scanner',
    role: 'deal_scout',
    top_gaps: (gaps?.sector_gaps ?? []).slice(0, 3).map(g => ({
      sector: g.sector_name,
      naics: g.naics,
      demand_est: g.demand_estimate,
      confidence: g.confidence_tier,
      signal: g.signal,
    })),
  };
}

// Token Analyst — underwriter: zone economics
async function tokenAnalystUnderwrite(zip) {
  const zone = await callTool('local_intel_zone', { zip });
  return {
    agent: 'token_analyst',
    role: 'underwriter',
    population: zone?.population ?? null,
    median_hhi: zone?.median_hhi ?? null,
    home_value: zone?.median_home_value ?? null,
    zone_score: zone?.zone_score ?? null,
    irs_agi_median: zone?.irs_agi_median ?? null,
    irs_wage_share: zone?.irs_wage_share_pct ?? null,
  };
}

// Wallet Profiler — demographics: retail + healthcare buyer profile
async function walletProfilerScan(zip) {
  const [retail, health] = await Promise.all([
    handleVerticalQuery('retail',     `retail market profile for ${zip}`, zip).catch(() => null),
    handleVerticalQuery('healthcare', `healthcare demand in ${zip}`, zip).catch(() => null),
  ]);
  return {
    agent: 'wallet_profiler',
    role: 'demographics',
    retail_summary:     retail?.answer  ?? retail?.summary  ?? null,
    retail_score:       retail?.score   ?? null,
    healthcare_summary: health?.answer  ?? health?.summary  ?? null,
    healthcare_score:   health?.score   ?? null,
  };
}

// Thread Writer — narrator: plain synthesis via local_intel_ask
async function threadWriterSynthesize(zip, agentFindings) {
  const question = `Summarize the development intelligence for ZIP ${zip} in 3 sentences covering investment signal, top sector gap, and demographics.`;
  const ask = await callTool('local_intel_ask', { question, zip });
  return {
    agent: 'thread_writer',
    role: 'narrator',
    brief: ask?.answer ?? ask?.summary ?? null,
    confidence: ask?.confidence ?? null,
    sources: ask?.sources ?? [],
  };
}

// ── Full cycle for one ZIP ────────────────────────────────────────────────────
async function runZipCycle(zip) {
  console.log(`[acp-cycle] Running ZIP ${zip}`);

  const [ceo, alpha, token, wallet] = await Promise.all([
    ceoInvestorScan(zip),
    alphaWhitespaceScan(zip),
    tokenAnalystUnderwrite(zip),
    walletProfilerScan(zip),
  ]);

  // Thread Writer synthesizes last (needs other findings for context)
  const thread = await threadWriterSynthesize(zip, { ceo, alpha, token, wallet });

  const brief = { ceo, alpha, token, wallet, thread };
  saveBrief(zip, brief);

  console.log(`[acp-cycle] ${zip} brief saved — signal:${ceo.signal_band} gaps:${alpha.top_gaps?.length} brief:"${(thread.brief||'').slice(0,80)}..."`);
  return brief;
}

// ── Pick next ZIPs to run ─────────────────────────────────────────────────────
function pickNextZips(n) {
  const all   = getZipsByPriority(); // sorted by population desc
  const ttl   = BRIEF_TTL_H * 60 * 60 * 1000;
  const stale = all.filter(z => briefAge(z.zip) > ttl);
  return stale.slice(0, n).map(z => z.zip);
}

// ── Main loop ─────────────────────────────────────────────────────────────────
(async function main() {
  console.log('[acp-cycle] ACP intelligence cycle started');
  ensureDir(BRIEFS_DIR);

  // Stagger startup by 2 min to let other workers initialize first
  await sleep(2 * 60 * 1000);

  while (true) {
    const zips = pickNextZips(ZIPS_PER_CYCLE);
    if (zips.length === 0) {
      console.log('[acp-cycle] All ZIPs fresh — sleeping until stale');
    } else {
      console.log(`[acp-cycle] Cycle start — ${zips.length} ZIPs: ${zips.join(', ')}`);
      for (const zip of zips) {
        try {
          await runZipCycle(zip);
        } catch (err) {
          console.error(`[acp-cycle] ${zip} failed:`, err.message);
        }
        await sleep(3000); // 3s between ZIPs
      }
      console.log(`[acp-cycle] Cycle complete`);
    }

    await sleep(CYCLE_INTERVAL);
  }
})();
