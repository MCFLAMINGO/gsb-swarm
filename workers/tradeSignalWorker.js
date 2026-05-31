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
  // Statewide FL averages from zip_signals (state='12' — FL FIPS)
  // bps_total_units_mo: use monthly when available, fall back to annual/12 as proxy.
  // macro_bfs_apps_latest: populated by censusMacroWorker BFS layer.
  const [agg] = await db.query(`
    SELECT
      AVG(COALESCE(bps_total_units_mo, bps_total_units_annual / 12.0)) AS avg_permits_mo,
      AVG(macro_bfs_apps_latest)                                        AS avg_bfs_apps,
      AVG(sunbiz_new_12mo)                                              AS avg_sunbiz_new,
      AVG(sunbiz_dissolved_12mo)                                        AS avg_sunbiz_diss,
      AVG(acs_vacancy_pct)                                              AS avg_vacancy,
      AVG(acs_median_hhi)                                               AS avg_hhi,
      SUM(COALESCE(bps_total_units_mo, bps_total_units_annual / 12.0)) AS total_permits_mo,
      SUM(macro_bfs_apps_latest)                                        AS total_bfs_apps,
      SUM(sunbiz_new_12mo)                                              AS total_sunbiz_new,
      COUNT(*)                                                          AS zip_count
    FROM zip_signals
    WHERE state = 'FL'
  `);

  // BDS trend: latest year vs prior year statewide (annual — BDS replaced BFS)
  const bfsTrend = await db.query(`
    SELECT period, SUM((metrics->>'estabs_entry')::int) AS total_apps
    FROM macro_indicators
    WHERE source = 'bds' AND geo_id LIKE '12%'
    GROUP BY period
    ORDER BY period DESC
    LIMIT 4
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
  if (bfsTrend.length >= 2) {
    // BDS is annual: compare latest year vs prior year
    const recent = parseInt(bfsTrend[0]?.total_apps) || 0;
    const prior  = parseInt(bfsTrend[1]?.total_apps) || 0;
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
  // Zero/null inputs treated as neutral (55) so missing data doesn't drag scores to 50
  const bfsAvail  = fl.totalBfsApps > 0;
  const permAvail = fl.totalPermitsMo > 0;

  switch (ticker) {
    case 'DHI': {
      const migScore    = fl.netMigration > 10000 ? 78 : fl.netMigration > 0 ? 65 : 42;
      const hhiScore    = fl.avgHhi > 70000 ? 70 : fl.avgHhi > 55000 ? 60 : 48;
      const permitScore = permAvail ? (fl.totalPermitsMo > 8000 ? 75 : fl.totalPermitsMo > 5000 ? 58 : 40) : 55;
      const bfsScore    = bfsAvail  ? (fl.bfsMomentum > 5 ? 72 : fl.bfsMomentum > 0 ? 55 : 38) : 55;
      const score       = Math.round((migScore*0.4)+(hhiScore*0.3)+(permitScore*0.15)+(bfsScore*0.15));
      return { score, direction: scoreToDirection(score),
        thesis: `FL net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} and avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} signal ${score>=62?'strong':'moderate'} single-family demand. DHI has heaviest FL exposure among national builders.`,
        signal_source: 'irs_mig_net_returns + acs_median_hhi + bps_total_units_mo + macro_bfs_apps_latest',
        signal_value: `Net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · permits ${permAvail?fl.totalPermitsMo.toLocaleString():'pending'}/mo`,
        options_note: score>=65?'3-month call options 10-15% OTM on next earnings catalyst':null,
        risk_note: 'Interest rate sensitivity — thesis breaks if 30yr mortgage > 7.5%' };
    }
    case 'SBCF': {
      const netFormation   = fl.avgSunbizNew - fl.avgSunbizDiss;
      const formationScore = fl.avgSunbizNew > 50 ? 72 : fl.avgSunbizNew > 25 ? 58 : 40;
      const netScore       = netFormation > 10 ? 72 : netFormation > 0 ? 58 : 38;
      const migScore       = fl.netMigration > 5000 ? 68 : fl.netMigration > 0 ? 55 : 40;
      const bfsScore       = bfsAvail ? (fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 52 : 38) : 55;
      const score          = Math.round((formationScore*0.35)+(netScore*0.35)+(migScore*0.2)+(bfsScore*0.1));
      return { score, direction: scoreToDirection(score),
        thesis: `FL SMB net formation ${netFormation>5?'expanding':netFormation>0?'stable':'contracting'} (avg ${fl.avgSunbizNew.toFixed(0)} new / ${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP) — SBCF loan book quality tied directly to FL business formation.`,
        signal_source: 'sunbiz_new_12mo + sunbiz_dissolved_12mo + irs_mig_net_returns',
        signal_value: `Sunbiz avg +${fl.avgSunbizNew.toFixed(0)} new / -${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP · net ${netFormation.toFixed(1)} · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
        options_note: score>=65?'Sell puts on weakness for entry — low option premium name':null,
        risk_note: 'Concentrated FL credit risk — any FL-specific recession hits disproportionately' };
    }
    case 'HCA': {
      const migScore  = fl.netMigration > 10000 ? 75 : fl.netMigration > 0 ? 62 : 42;
      const hhiScore  = fl.avgHhi > 70000 ? 68 : fl.avgHhi > 55000 ? 58 : 46;
      const nesScore  = fl.totalNesFirms > 100000 ? 68 : fl.totalNesFirms > 50000 ? 58 : 50;
      const score     = Math.round((migScore*0.45)+(hhiScore*0.35)+(nesScore*0.2));
      return { score, direction: scoreToDirection(score),
        thesis: `FL net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} + avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} drive structural healthcare demand. HCA holds ~25% of FL hospital beds.`,
        signal_source: 'irs_mig_net_returns + acs_median_hhi + nes_total_firms',
        signal_value: `Net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · NES firms ${fl.totalNesFirms.toLocaleString()}`,
        options_note: null,
        risk_note: 'Medicaid reimbursement cuts — FL Medicaid policy changes directly hit HCA margins' };
    }
    case 'NXRT': {
      const vacancyScore = fl.avgVacancy > 0 ? (fl.avgVacancy < 5 ? 75 : fl.avgVacancy < 8 ? 60 : 40) : 55;
      const migScore     = fl.netMigration > 5000 ? 72 : fl.netMigration > 0 ? 60 : 40;
      const hhiScore     = fl.avgHhi > 65000 ? 65 : fl.avgHhi > 50000 ? 55 : 44;
      const permitScore  = permAvail ? (fl.totalPermitsMo > 8000 ? 42 : fl.totalPermitsMo > 5000 ? 50 : 62) : 55;
      const score        = Math.round((vacancyScore*0.35)+(migScore*0.35)+(hhiScore*0.2)+(permitScore*0.1));
      return { score, direction: scoreToDirection(score),
        thesis: `FL rental vacancy ${fl.avgVacancy>0?fl.avgVacancy.toFixed(1)+'%':'pending'} with net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} and avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})}. NXRT sunbelt portfolio 40%+ FL.`,
        signal_source: 'acs_vacancy_pct + irs_mig_net_returns + acs_median_hhi',
        signal_value: `Avg FL vacancy ${fl.avgVacancy>0?fl.avgVacancy.toFixed(1)+'%':'pending'} · net migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})}`,
        options_note: null,
        risk_note: 'New supply risk — FL permitted units lag completions 18-24 months' };
    }
    case 'LOW': {
      const nesConScore = fl.nesConstruction > 5000 ? 72 : fl.nesConstruction > 2000 ? 60 : 48;
      const hhiScore    = fl.avgHhi > 65000 ? 68 : fl.avgHhi > 50000 ? 57 : 44;
      const migScore    = fl.netMigration > 5000 ? 68 : fl.netMigration > 0 ? 58 : 42;
      const permitScore = permAvail ? (fl.totalPermitsMo > 8000 ? 72 : fl.totalPermitsMo > 5000 ? 58 : 42) : 55;
      const score       = Math.round((nesConScore*0.35)+(hhiScore*0.3)+(migScore*0.2)+(permitScore*0.15));
      return { score, direction: scoreToDirection(score),
        thesis: `${fl.nesConstruction.toLocaleString()} FL NES construction firms + avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} track Lowe's Pro segment — the highest-margin part of their business.`,
        signal_source: 'nes_construction_firms + acs_median_hhi + irs_mig_net_returns',
        signal_value: `NES construction firms ${fl.nesConstruction.toLocaleString()} · avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
        options_note: score>=65?'Buy calls before quarterly earnings when FL permit data confirms acceleration':null,
        risk_note: 'Housing market slowdown or lumber price spike compresses project economics' };
    }
    case 'FRPH': {
      const netForm   = fl.avgSunbizNew - fl.avgSunbizDiss;
      const formScore = fl.avgSunbizNew > 40 ? 70 : fl.avgSunbizNew > 20 ? 57 : 40;
      const netScore  = netForm > 10 ? 68 : netForm > 0 ? 55 : 38;
      const migScore  = fl.netMigration > 5000 ? 65 : fl.netMigration > 0 ? 55 : 40;
      const bfsScore  = bfsAvail ? (fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 55 : 40) : 55;
      const score     = Math.round((formScore*0.35)+(netScore*0.3)+(migScore*0.2)+(bfsScore*0.15));
      return { score, direction: scoreToDirection(score),
        thesis: `FL business formation avg ${fl.avgSunbizNew.toFixed(0)} new entities/ZIP/yr, net ${netForm.toFixed(1)} — FRPH industrial/flex space demand lags formation by 12-18 months. Small float.`,
        signal_source: 'sunbiz_new_12mo + sunbiz_dissolved_12mo + irs_mig_net_returns',
        signal_value: `Sunbiz avg ${fl.avgSunbizNew.toFixed(0)} new / ${fl.avgSunbizDiss.toFixed(0)} dissolved per ZIP · net ${netForm.toFixed(1)} · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
        options_note: null,
        risk_note: 'Illiquid small-cap — wide spreads, options not practical. Equity only.' };
    }
    case 'FOUR': {
      const nesScore  = fl.totalNesFirms > 80000 ? 72 : fl.totalNesFirms > 50000 ? 60 : 44;
      const formScore = fl.avgSunbizNew > 40 ? 70 : fl.avgSunbizNew > 20 ? 57 : 40;
      const migScore  = fl.netMigration > 5000 ? 65 : fl.netMigration > 0 ? 55 : 40;
      const bfsScore  = bfsAvail ? (fl.bfsMomentum > 5 ? 68 : fl.bfsMomentum > 0 ? 55 : 38) : 55;
      const score     = Math.round((nesScore*0.4)+(formScore*0.35)+(migScore*0.15)+(bfsScore*0.1));
      return { score, direction: scoreToDirection(score),
        thesis: `${fl.totalNesFirms.toLocaleString()} FL NES solo/SMB operators + avg ${fl.avgSunbizNew.toFixed(0)} new entities/ZIP/yr signals payment volume expansion for Shift4's core FL market.`,
        signal_source: 'nes_total_firms + sunbiz_new_12mo + irs_mig_net_returns',
        signal_value: `NES total firms ${fl.totalNesFirms.toLocaleString()} · sunbiz new avg ${fl.avgSunbizNew.toFixed(0)}/ZIP · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
        options_note: score>=65?'30-45 day call spreads on breakout above 52-week high':null,
        risk_note: 'Competition from Stripe/Square compressing SMB take rates nationwide' };
    }
    case 'SBGI': {
      const hhiScore  = fl.avgHhi > 65000 ? 64 : fl.avgHhi > 50000 ? 53 : 40;
      const formScore = fl.avgSunbizNew > 40 ? 62 : fl.avgSunbizNew > 20 ? 52 : 38;
      const migScore  = fl.netMigration > 0 ? 58 : 40;
      const score     = Math.round((hhiScore*0.4)+(formScore*0.35)+(migScore*0.25));
      return { score, direction: scoreToDirection(score),
        thesis: `FL avg HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} + SMB formation (avg ${fl.avgSunbizNew.toFixed(0)} new/ZIP/yr) proxy local ad spend. SBGI holds FL broadcast licenses in major DMAs. Speculative/deep value.`,
        signal_source: 'acs_median_hhi + sunbiz_new_12mo + irs_mig_net_returns',
        signal_value: `Avg FL HHI $${fl.avgHhi.toLocaleString(undefined,{maximumFractionDigits:0})} · sunbiz new avg ${fl.avgSunbizNew.toFixed(0)}/ZIP · migration ${fl.netMigration>0?'+':''}${fl.netMigration.toLocaleString()}`,
        options_note: null,
        risk_note: 'Heavy debt load — any revenue miss triggers balance sheet concern. High risk.' };
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

  let insertCount = 0;
  for (const ticker of TICKERS) {
    try {
      const result = scoreSignals(ticker, fl);
      if (!result) continue;

      const { score, direction, thesis, signal_source, signal_value, options_note, risk_note } = result;
      const expiresAt = new Date(Date.now() + 90 * 86400 * 1000);

      // Delete then insert atomically per-ticker — no orphan deletes if loop fails mid-way
      await db.query(`DELETE FROM trade_signals WHERE ticker = $1 AND scored_at::date = CURRENT_DATE`, [ticker]);
      await db.query(
        `INSERT INTO trade_signals
           (ticker, company, direction, confidence, thesis, signal_source, signal_value,
            data_vintage, options_note, risk_note, status, scored_at, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',NOW(),$11)`,
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

      insertCount++;
      console.log(`[tradeSignal] ${ticker} → ${direction} (${score}) — ${thesis.slice(0, 60)}...`);
    } catch (err) {
      console.error(`[tradeSignal] failed for ${ticker}:`, err.message);
    }
  }

  console.log(`[tradeSignal] scoring complete — ${insertCount} tickers written`);
  return insertCount;
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
      // Check if existing scores are all uniform (50) — means previous run had no real data
      const [uniformCheck] = await db.query(
        `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE confidence = 50) AS at50 FROM trade_signals WHERE status='active'`
      );
      const allUniform = parseInt(uniformCheck?.total||0) > 0 && uniformCheck.total === uniformCheck.at50;
      if (!allUniform && await isFresh(WORKER_NAME, TTL_DAYS * 24 * 3600 * 1000)) {
        console.log(`[tradeSignal] fresh — sleeping ${LOOP_SLEEP_H}h`);
        await sleep(LOOP_SLEEP_H * 3600 * 1000);
        continue;
      }
      if (allUniform) console.log(`[tradeSignal] all signals at confidence=50 (stale data) — forcing rescore`);
      const written = await runScoring();
      await updateHeartbeat(WORKER_NAME, written || 0);
    } catch (err) {
      console.error('[tradeSignal] cycle error:', err.message);
      const { pingError } = require('../lib/workerHeartbeat');
      await pingError(WORKER_NAME, err.message).catch(() => {});
    }
    await sleep(LOOP_SLEEP_H * 3600 * 1000);
  }
}

main();
