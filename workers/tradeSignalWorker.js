'use strict';
/**
 * tradeSignalWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Scores FL-concentrated equities against LocalIntel Postgres data weekly.
 * Writes to trade_signals table. No external APIs. No flat files.
 *
 * WHY THIS WORKER EXISTS:
 *   LocalIntel accumulates ZIP/county-level leading indicators that precede
 *   macro analyst coverage by months. This worker reads those signals and
 *   scores 8 FL-concentrated tickers — producing plain-English trade theses
 *   readable from the dashboard or any LLM session.
 *
 * ── TICKERS TRACKED ──────────────────────────────────────────────────────────
 *   DHI   — D.R. Horton (homebuilder, FL heavy)
 *   SBCF  — Seacoast Banking FL (FL community bank, SMB loans)
 *   HCA   — HCA Healthcare (FL hospital concentration)
 *   NXRT  — NexPoint Residential (FL sunbelt multifamily REIT)
 *   LOW   — Lowe's (home improvement, permit-correlated)
 *   FRPH  — FRP Holdings (FL commercial/industrial RE)
 *   FOUR  — Shift4 Payments (FL HQ, SMB payments)
 *   SBGI  — Sinclair (FL media markets — local ad spend proxy)
 *
 * ── SIGNALS READ FROM POSTGRES ───────────────────────────────────────────────
 *   zip_signals:       bps_total_units_mo, macro_bfs_apps_latest, sunbiz_new_12mo,
 *                      sunbiz_dissolved_12mo, acs_median_hhi, acs_vacancy_pct
 *   zip_macro_signals: nes_total_firms, nes_construction_firms, bfs_county_apps_highprop,
 *                      ecn_total_sales_k, bfs_county_period
 *   macro_indicators:  BFS trend (last 3 months vs prior 3 months)
 *   zip_signals:       irs_mig_net_returns (migration inflow/outflow)
 *
 * ── SCORING LOGIC ────────────────────────────────────────────────────────────
 *   Each ticker has 2-3 signal inputs mapped from LocalIntel data.
 *   Score 0-100 = weighted average of signal deltas vs FL baseline.
 *   Direction: LONG (score >= 60), WATCH (40-59), SHORT (< 40)
 *   Confidence = how many signals agree (all agree = high, mixed = low)
 *
 * ── WORKER CONTRACT ──────────────────────────────────────────────────────────
 *   Runs weekly. Idempotent — UNIQUE(ticker, scored_at::date) prevents dupes.
 *   No flat files. No /tmp. Postgres only.
 */

const db = require('../lib/db');
const { ping: updateHeartbeat, isFresh } = require('../lib/workerHeartbeat');

const WORKER_NAME  = 'tradeSignalWorker';
const TTL_DAYS     = 7;    // re-score weekly
const LOOP_SLEEP_H = 24;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Signal aggregation ────────────────────────────────────────────────────────

async function getFlAggregates() {
  // Statewide FL averages from zip_signals
  const [agg] = await db.query(`
    SELECT
      AVG(bps_total_units_mo)          AS avg_permits_mo,
      AVG(macro_bfs_apps_latest)       AS avg_bfs_apps,
      AVG(sunbiz_new_12mo)             AS avg_sunbiz_new,
      AVG(sunbiz_dissolved_12mo)       AS avg_sunbiz_diss,
      AVG(acs_vacancy_pct)             AS avg_vacancy,
      AVG(acs_median_hhi)              AS avg_hhi,
      SUM(bps_total_units_mo)          AS total_permits_mo,
      SUM(macro_bfs_apps_latest)       AS total_bfs_apps,
      SUM(sunbiz_new_12mo)             AS total_sunbiz_new,
      COUNT(*)                         AS zip_count
    FROM zip_signals
    WHERE state = '12' OR zip IS NOT NULL
  `);

  // BFS trend: last 3 months vs prior 3 months statewide
  const bfsTrend = await db.query(`
    SELECT period, SUM((metrics->>'ba_total')::int) AS total_apps
    FROM macro_indicators
    WHERE source = 'bfs' AND geo_id LIKE '12%'
    GROUP BY period
    ORDER BY period DESC
    LIMIT 6
  `);

  // NES statewide
  const [nes] = await db.query(`
    SELECT
      SUM(nes_total_firms)        AS total_nes_firms,
      SUM(nes_construction_firms) AS total_nes_construction,
      AVG(nes_receipts_per_firm)  AS avg_receipts_per_firm
    FROM zip_macro_signals
  `);

  // Migration net inflow statewide
  const [mig] = await db.query(`
    SELECT
      SUM(irs_mig_net_returns) AS net_migration,
      AVG(irs_mig_net_returns) AS avg_mig_per_zip
    FROM zip_signals
    WHERE irs_mig_net_returns IS NOT NULL
  `);

  // BFS momentum: compare recent 3 months vs prior 3 months
  let bfsMomentum = 0;
  if (bfsTrend.length >= 6) {
    const recent = bfsTrend.slice(0, 3).reduce((s, r) => s + (parseInt(r.total_apps) || 0), 0);
    const prior  = bfsTrend.slice(3, 6).reduce((s, r) => s + (parseInt(r.total_apps) || 0), 0);
    bfsMomentum  = prior > 0 ? Math.round(((recent - prior) / prior) * 100) : 0;
  }

  return {
    avgPermitsMo:     parseFloat(agg?.avg_permits_mo)  || 0,
    avgBfsApps:       parseFloat(agg?.avg_bfs_apps)    || 0,
    avgSunbizNew:     parseFloat(agg?.avg_sunbiz_new)  || 0,
    avgSunbizDiss:    parseFloat(agg?.avg_sunbiz_diss) || 0,
    avgVacancy:       parseFloat(agg?.avg_vacancy)     || 0,
    avgHhi:           parseFloat(agg?.avg_hhi)         || 0,
    totalPermitsMo:   parseInt(agg?.total_permits_mo)  || 0,
    totalBfsApps:     parseInt(agg?.total_bfs_apps)    || 0,
    totalSunbizNew:   parseInt(agg?.total_sunbiz_new)  || 0,
    zipCount:         parseInt(agg?.zip_count)         || 1,
    bfsMomentum,
    totalNesFirms:    parseInt(nes?.total_nes_firms)         || 0,
    nesConstruction:  parseInt(nes?.total_nes_construction)  || 0,
    netMigration:     parseInt(mig?.net_migration)           || 0,
    bfsTrendPeriod:   bfsTrend[0]?.period || 'unknown',
    latestBfsPeriod:  bfsTrend[0]?.period || null,
  };
}

// ── Ticker scoring ────────────────────────────────────────────────────────────

function scoreToDirection(score) {
  if (score >= 62) return 'LONG';
  if (score >= 42) return 'WATCH';
  return 'SHORT';
}

function scoreSignals(ticker, fl) {
  switch (ticker) {

    case 'DHI': { // D.R. Horton — driven by FL permit velocity + BFS formation
      const permitScore   = fl.totalPermitsMo > 8000 ? 75 : fl.totalPermitsMo > 5000 ? 55 : 35;
      const bfsScore      = fl.bfsMomentum > 5 ? 75 : fl.bfsMomentum > 0 ? 55 : 35;
      const migScore      = fl.netMigration > 0 ? 70 : 40;
      const score         = Math.round((permitScore * 0.5) + (bfsScore * 0.3) + (migScore * 0.2));
      const sigVal        = `${fl.totalPermitsMo.toLocaleString()} units/mo FL statewide · BFS momentum ${fl.bfsMomentum > 0 ? '+' : ''}${fl.bfsMomentum}% · net migration ${fl.netMigration > 0 ? '+' : ''}${fl.netMigration}`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL permit volume and BFS formation signal ${score >= 62 ? 'accelerating' : score >= 42 ? 'steady' : 'slowing'} housing demand. DHI has heaviest FL single-family exposure among national builders.`,
        signal_source: 'bps_total_units_mo + macro_bfs_apps_latest + irs_mig_net_returns',
        signal_value: sigVal,
        options_note: score >= 65 ? '3-month call options 10-15% OTM on next earnings catalyst' : null,
        risk_note: 'Interest rate sensitivity — thesis breaks if 30yr mortgage > 7.5%',
      };
    }

    case 'SBCF': { // Seacoast Banking FL — SMB loan book driven by sunbiz formation
      const formationScore = fl.avgSunbizNew > 50 ? 72 : fl.avgSunbizNew > 25 ? 55 : 38;
      const netFormation   = fl.avgSunbizNew - fl.avgSunbizDiss;
      const netScore       = netFormation > 10 ? 70 : netFormation > 0 ? 55 : 35;
      const bfsScore       = fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 52 : 38;
      const score          = Math.round((formationScore * 0.4) + (netScore * 0.35) + (bfsScore * 0.25));
      const sigVal         = `Sunbiz avg +${fl.avgSunbizNew.toFixed(0)} new / -${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP · net ${netFormation.toFixed(1)} · BFS ${fl.bfsMomentum > 0 ? '+' : ''}${fl.bfsMomentum}%`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL SMB formation rate ${netFormation > 5 ? 'expanding' : netFormation > 0 ? 'stable' : 'contracting'} — SBCF loan book quality directly tied to net business formation in FL counties.`,
        signal_source: 'sunbiz_new_12mo + sunbiz_dissolved_12mo + macro_bfs_apps_latest',
        signal_value: sigVal,
        options_note: score >= 65 ? 'Sell puts on weakness for entry — low option premium name' : null,
        risk_note: 'Concentrated FL credit risk — any FL-specific recession hits disproportionately',
      };
    }

    case 'HCA': { // HCA Healthcare — FL hospital utilization driven by demographics + migration
      const hhiScore   = fl.avgHhi > 70000 ? 65 : fl.avgHhi > 50000 ? 55 : 48;
      const migScore   = fl.netMigration > 5000 ? 72 : fl.netMigration > 0 ? 58 : 42;
      const nesScore   = fl.totalNesFirms > 100000 ? 65 : 55; // more solo workers = more uninsured = ER demand
      const score      = Math.round((hhiScore * 0.4) + (migScore * 0.4) + (nesScore * 0.2));
      const sigVal     = `Avg FL HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · net migration ${fl.netMigration > 0 ? '+' : ''}${fl.netMigration.toLocaleString()} · NES firms ${fl.totalNesFirms.toLocaleString()}`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL population inflows drive structural healthcare demand. HCA holds ~25% of FL hospital beds. Migration + aging demographics = multi-year volume tailwind.`,
        signal_source: 'acs_median_hhi + irs_mig_net_returns + nes_total_firms',
        signal_value: sigVal,
        options_note: null,
        risk_note: 'Medicaid reimbursement cuts — FL Medicaid policy changes directly hit HCA margins',
      };
    }

    case 'NXRT': { // NexPoint Residential — FL multifamily REIT driven by vacancy + migration
      const vacancyScore = fl.avgVacancy < 5 ? 72 : fl.avgVacancy < 8 ? 58 : 38;
      const migScore     = fl.netMigration > 0 ? 70 : 42;
      const permitScore  = fl.totalPermitsMo > 6000 ? 45 : 62; // fewer new permits = tighter rental market
      const score        = Math.round((vacancyScore * 0.4) + (migScore * 0.4) + (permitScore * 0.2));
      const sigVal       = `Avg FL vacancy ${fl.avgVacancy.toFixed(1)}% · net migration ${fl.netMigration > 0 ? '+' : ''}${fl.netMigration.toLocaleString()} · permits ${fl.totalPermitsMo.toLocaleString()}/mo`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL rental market ${fl.avgVacancy < 5 ? 'tight' : 'softening'} — vacancy at ${fl.avgVacancy.toFixed(1)}% with ${fl.netMigration > 0 ? 'positive' : 'negative'} migration. NXRT sunbelt portfolio 40%+ FL concentrated.`,
        signal_source: 'acs_vacancy_pct + irs_mig_net_returns + bps_total_units_mo',
        signal_value: sigVal,
        options_note: null,
        risk_note: 'New supply risk — FL permitted 100k+ units/yr; completions lag 18-24 months',
      };
    }

    case 'LOW': { // Lowe's — home improvement correlated to permit volume + HHI
      const permitScore = fl.totalPermitsMo > 8000 ? 72 : fl.totalPermitsMo > 5000 ? 58 : 40;
      const hhiScore    = fl.avgHhi > 65000 ? 68 : fl.avgHhi > 50000 ? 55 : 42;
      const nesConScore = fl.nesConstruction > 5000 ? 70 : 55; // solo contractors = Lowe's pro customers
      const score       = Math.round((permitScore * 0.45) + (hhiScore * 0.3) + (nesConScore * 0.25));
      const sigVal      = `FL permits ${fl.totalPermitsMo.toLocaleString()}/mo · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · NES construction firms ${fl.nesConstruction.toLocaleString()}`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL permit velocity + solo contractor density (${fl.nesConstruction.toLocaleString()} NES construction firms) directly tracks Lowe's Pro segment — the highest-margin part of their business.`,
        signal_source: 'bps_total_units_mo + acs_median_hhi + nes_construction_firms',
        signal_value: sigVal,
        options_note: score >= 65 ? 'Buy calls before quarterly earnings when FL permit data confirms acceleration' : null,
        risk_note: 'Housing market slowdown or lumber price spike compresses project economics',
      };
    }

    case 'FRPH': { // FRP Holdings — FL industrial/commercial RE driven by business formation + ECN
      const bfsScore    = fl.bfsMomentum > 5 ? 70 : fl.bfsMomentum > 0 ? 55 : 38;
      const formScore   = fl.avgSunbizNew > 40 ? 68 : fl.avgSunbizNew > 20 ? 55 : 40;
      const score       = Math.round((bfsScore * 0.5) + (formScore * 0.5));
      const sigVal      = `BFS momentum ${fl.bfsMomentum > 0 ? '+' : ''}${fl.bfsMomentum}% · sunbiz avg ${fl.avgSunbizNew.toFixed(0)} new entities/ZIP/yr`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL business formation ${fl.bfsMomentum > 0 ? 'accelerating' : 'contracting'} — FRPH industrial/flex space demand lags business formation by 12-18 months. Small float, low coverage.`,
        signal_source: 'macro_bfs_apps_latest + sunbiz_new_12mo',
        signal_value: sigVal,
        options_note: null,
        risk_note: 'Illiquid small-cap — wide spreads, options not practical. Equity only.',
      };
    }

    case 'FOUR': { // Shift4 Payments — FL HQ, SMB payment volume driven by NES + sunbiz
      const nesScore    = fl.totalNesFirms > 80000 ? 70 : fl.totalNesFirms > 50000 ? 58 : 42;
      const formScore   = fl.avgSunbizNew > 40 ? 68 : fl.avgSunbizNew > 20 ? 55 : 40;
      const bfsScore    = fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 55 : 38;
      const score       = Math.round((nesScore * 0.4) + (formScore * 0.35) + (bfsScore * 0.25));
      const sigVal      = `NES total firms ${fl.totalNesFirms.toLocaleString()} · sunbiz new avg ${fl.avgSunbizNew.toFixed(0)}/ZIP · BFS ${fl.bfsMomentum > 0 ? '+' : ''}${fl.bfsMomentum}%`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL solo/SMB operator density (${fl.totalNesFirms.toLocaleString()} NES firms) + formation velocity signals payment volume expansion for Shift4's core FL market.`,
        signal_source: 'nes_total_firms + sunbiz_new_12mo + macro_bfs_apps_latest',
        signal_value: sigVal,
        options_note: score >= 65 ? '30-45 day call spreads on breakout above 52-week high' : null,
        risk_note: 'Competition from Stripe/Square compressing SMB take rates nationwide',
      };
    }

    case 'SBGI': { // Sinclair Broadcast — FL local ad spend proxy driven by HHI + business density
      const hhiScore  = fl.avgHhi > 65000 ? 62 : fl.avgHhi > 50000 ? 52 : 40;
      const bizScore  = fl.avgSunbizNew > 40 ? 60 : fl.avgSunbizNew > 20 ? 50 : 38;
      const score     = Math.round((hhiScore * 0.5) + (bizScore * 0.5));
      const sigVal    = `Avg FL HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · sunbiz new avg ${fl.avgSunbizNew.toFixed(0)}/ZIP`;
      return {
        score, direction: scoreToDirection(score),
        thesis: `FL local ad spend proxy — SMB formation + HHI signal advertiser budget health. SBGI holds FL broadcast licenses in major DMAs. Speculative/deep value only.`,
        signal_source: 'acs_median_hhi + sunbiz_new_12mo',
        signal_value: sigVal,
        options_note: null,
        risk_note: 'Heavy debt load — any revenue miss triggers balance sheet concern. High risk.',
      };
    }

    default:
      return null;
  }
}

// ── Main loop ─────────────────────────────────────────────────────────────────

const TICKERS = ['DHI','SBCF','HCA','NXRT','LOW','FRPH','FOUR','SBGI'];

async function runScoring() {
  console.log('[tradeSignal] scoring FL-concentrated tickers...');

  let fl;
  try {
    fl = await getFlAggregates();
  } catch (e) {
    console.error('[tradeSignal] failed to load FL aggregates:', e.message);
    return;
  }

  console.log(`[tradeSignal] FL state: ${fl.zipCount} ZIPs · permits ${fl.totalPermitsMo}/mo · BFS momentum ${fl.bfsMomentum}% · migration ${fl.netMigration}`);

  for (const ticker of TICKERS) {
    try {
      const result = scoreSignals(ticker, fl);
      if (!result) continue;

      const { score, direction, thesis, signal_source, signal_value, options_note, risk_note } = result;

      // Expire in 90 days
      const expiresAt = new Date(Date.now() + 90 * 86400 * 1000);

      await db.query(
        `INSERT INTO trade_signals
           (ticker, company, direction, confidence, thesis, signal_source, signal_value,
            data_vintage, options_note, risk_note, status, scored_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',NOW(),$11)
         ON CONFLICT (ticker, (scored_at::date)) DO UPDATE SET
           direction     = EXCLUDED.direction,
           confidence    = EXCLUDED.confidence,
           thesis        = EXCLUDED.thesis,
           signal_source = EXCLUDED.signal_source,
           signal_value  = EXCLUDED.signal_value,
           data_vintage  = EXCLUDED.data_vintage,
           options_note  = EXCLUDED.options_note,
           risk_note     = EXCLUDED.risk_note,
           expires_at    = EXCLUDED.expires_at`,
        [
          ticker,
          { DHI:'D.R. Horton', SBCF:'Seacoast Banking FL', HCA:'HCA Healthcare',
            NXRT:'NexPoint Residential', LOW:"Lowe's", FRPH:'FRP Holdings',
            FOUR:'Shift4 Payments', SBGI:'Sinclair Broadcast' }[ticker],
          direction, score, thesis, signal_source, signal_value,
          fl.latestBfsPeriod ? `BFS ${fl.latestBfsPeriod}` : 'LocalIntel',
          options_note, risk_note, expiresAt,
        ]
      );

      console.log(`[tradeSignal] ${ticker} → ${direction} (${score}) — ${thesis.slice(0, 60)}...`);
    } catch (err) {
      console.error(`[tradeSignal] failed for ${ticker}:`, err.message);
    }
  }

  console.log('[tradeSignal] scoring complete');
}

async function main() {
  console.log('[tradeSignal] worker starting...');

  let dbReady = false;
  for (let i = 0; i < 10; i++) {
    try { await db.query('SELECT 1'); dbReady = true; break; }
    catch (e) { console.warn(`[tradeSignal] DB not ready (${i+1}/10)`); await sleep(5000); }
  }
  if (!dbReady) { console.error('[tradeSignal] DB never ready — exiting'); process.exit(1); }

  while (true) {
    try {
      if (await isFresh(WORKER_NAME, TTL_DAYS * 24 * 3600 * 1000)) {
        console.log(`[tradeSignal] fresh — sleeping ${LOOP_SLEEP_H}h`);
        await sleep(LOOP_SLEEP_H * 3600 * 1000);
        continue;
      }
      await runScoring();
      await updateHeartbeat(WORKER_NAME);
    } catch (err) {
      console.error('[tradeSignal] cycle error:', err.message);
    }
    await sleep(LOOP_SLEEP_H * 3600 * 1000);
  }
}

main();
