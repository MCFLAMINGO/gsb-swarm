'use strict';
/**
 * reportGenerator.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Generates structured consultation report artifacts from zip_signals,
 * zip_forecast, zip_anomalies, and zip_signals_history.
 *
 * The output is a JSON report stored in zip_reports. The same JSON is used
 * to render the HTML consultation deliverable.
 *
 * Pricing context: $750 basic → $2k–$5k full market analysis.
 * This generator produces the $750-level artifact automatically.
 * Analyst augmentation raises it to the $2k–$5k range.
 *
 * Usage:
 *   const { generateReport } = require('./reportGenerator');
 *   const report = await generateReport({ zip: '32082', leadId: 'uuid', reportType: 'full' });
 */

const db = require('./db');
const crypto = require('crypto');

// ── Generate report ───────────────────────────────────────────────────────────
async function generateReport({ zip, leadId = null, reportType = 'full', horizonMonths = 36 } = {}) {
  if (!zip) throw new Error('zip is required');

  console.log(`[reportGen] Generating ${reportType} report for ZIP ${zip}...`);

  // 1. Pull current signals
  const signals = await db.queryOne(
    `SELECT * FROM zip_signals WHERE zip = $1`,
    [zip]
  ).catch(() => null);

  // 2. Pull latest forecast
  const forecast = await db.queryOne(
    `SELECT * FROM zip_forecast WHERE zip = $1 ORDER BY generated_at DESC LIMIT 1`,
    [zip]
  ).catch(() => null);

  // 3. Pull open anomalies
  const anomalies = await db.query(
    `SELECT signal_name, actual_value, expected_value, z_score, direction, severity, question, candidate_causes
     FROM zip_anomalies WHERE zip = $1 AND status = 'open' ORDER BY ABS(z_score) DESC LIMIT 10`,
    [zip]
  ).catch(() => []);

  // 4. Pull historical snapshots (last 12)
  const history = await db.query(
    `SELECT snapshot_date, acs_population, irs_agi_median, bps_total_units_annual,
            cbp_total_establishments, sunbiz_net_12mo, sig_growth_score, sig_opportunity_score, sig_market_maturity
     FROM zip_signals_history WHERE zip = $1
     ORDER BY snapshot_date DESC LIMIT 12`,
    [zip]
  ).catch(() => []);

  // 5. Pull recent causal events for this ZIP/county
  const countyFips = signals?.county_fips || null;
  const causalEvents = countyFips
    ? await db.query(
        `SELECT event_type, event_category, title, description, announced_date, effective_date, start_date, completion_date, source_url
         FROM zip_causal_events
         WHERE (zip = $1 OR county = $2)
           AND (effective_date IS NULL OR effective_date > NOW() - INTERVAL '3 years')
         ORDER BY COALESCE(effective_date, announced_date) DESC LIMIT 10`,
        [zip, countyFips]
      ).catch(() => [])
    : [];

  // 6. Pull neighboring ZIPs for comparison context (same county)
  let peerZips = [];
  if (countyFips) {
    const peers = await db.query(
      `SELECT zs.zip, zs.sig_growth_score, zs.sig_opportunity_score, zs.sig_market_maturity,
              zs.acs_population, zs.irs_agi_median, zs.cbp_total_establishments
       FROM zip_signals zs
       JOIN zip_intelligence zi ON zi.zip = zs.zip
       WHERE zi.county_fips = $1 AND zs.zip != $2
       ORDER BY zs.sig_growth_score DESC NULLS LAST LIMIT 5`,
      [countyFips, zip]
    ).catch(() => []);
    peerZips = peers;
  }

  // 7. Pull business count from zip_intelligence for context
  const zipIntel = await db.queryOne(
    `SELECT population, name, county_name, city_name, lat, lon
     FROM zip_intelligence WHERE zip = $1`,
    [zip]
  ).catch(() => null);

  // ── Compute data quality summary ────────────────────────────────────────
  const KEY_SIGNALS = [
    'acs_population','acs_median_hhi','irs_agi_median','cbp_total_establishments',
    'bps_total_units_annual','osm_biz_count','sunbiz_active_entities',
    'irs_mig_net_returns','fcc_has_25_3',
  ];
  const populated = signals
    ? KEY_SIGNALS.filter(k => signals[k] !== null && signals[k] !== undefined).length
    : 0;
  const dataCompleteness = Math.round((populated / KEY_SIGNALS.length) * 100) / 100;

  // ── Compose report_json ─────────────────────────────────────────────────
  const now = new Date().toISOString();
  const reportJson = {
    meta: {
      zip,
      report_type:       reportType,
      generated_at:      now,
      model_version:     forecast?.model_version || 'v1-cohort-2026',
      data_completeness: dataCompleteness,
      confidence:        forecast?.proj_12mo_confidence || null,
      horizon_months:    horizonMonths,
    },
    location: {
      zip,
      city:          zipIntel?.city_name || signals?.city_name || 'Unknown',
      county:        zipIntel?.county_name || 'Unknown',
      area_name:     zipIntel?.name || zip,
      lat:           zipIntel?.lat || null,
      lon:           zipIntel?.lon || null,
    },
    current_state: {
      population:               signals?.acs_population              || null,
      households:               signals?.acs_households              || null,
      median_household_income:  signals?.acs_median_hhi              || null,
      median_agi:               signals?.irs_agi_median              || null,
      owner_occupied_pct:       signals?.acs_owner_occ_pct           || null,
      total_businesses:         signals?.cbp_total_establishments    || signals?.zbp_total_establishments || null,
      active_sunbiz_entities:   signals?.sunbiz_active_entities      || null,
      new_businesses_12mo:      signals?.sunbiz_new_12mo             || null,
      net_business_formation:   signals?.sunbiz_net_12mo             || null,
      osm_indexed_businesses:   signals?.osm_biz_count               || null,
      osm_with_website_pct:     signals?.osm_with_website_pct        || null,
      osm_with_phone_pct:       signals?.osm_with_phone_pct          || null,
      broadband_has_25_3:       signals?.fcc_has_25_3                || null,
      broadband_has_gigabit:    signals?.fcc_has_gigabit             || null,
      broadband_providers:      signals?.fcc_providers_cnt           || null,
    },
    growth_signals: {
      annual_res_permits_1unit:    signals?.bps_res_1unit_annual     || null,
      annual_res_permits_multifam: signals?.bps_res_multifam_annual  || null,
      annual_total_units_permitted:signals?.bps_total_units_annual   || null,
      monthly_units_most_recent:   signals?.bps_total_units_mo       || null,
      monthly_period:              signals?.bps_period_mo            || null,
      net_migration_households:    signals?.irs_mig_net_returns      || null,
      net_migration_agi_k:         signals?.irs_mig_net_agi          || null,
      top_migration_origin:        signals?.irs_mig_top_origin       || null,
      migration_vintage:           signals?.irs_mig_vintage          || null,
    },
    scores: {
      growth_score:      forecast?.proj_12mo_growth_score     || null,
      opportunity_score: forecast?.proj_12mo_opportunity      || null,
      market_maturity:   forecast?.proj_12mo_maturity         || null,
      peer_cohort:       forecast?.peer_cohort               || null,
      peer_zip_count:    forecast?.peer_zip_count            || null,
    },
    projections: {
      '12_month': {
        growth_score:     forecast?.proj_12mo_growth_score    || null,
        opportunity:      forecast?.proj_12mo_opportunity     || null,
        biz_delta_pct:    forecast?.proj_12mo_biz_delta_pct   || null,
        market_maturity:  forecast?.proj_12mo_maturity        || null,
        confidence:       forecast?.proj_12mo_confidence      || null,
        summary:          forecast?.summary_12mo              || null,
      },
      '24_month': {
        growth_score:     forecast?.proj_24mo_growth_score    || null,
        opportunity:      forecast?.proj_24mo_opportunity     || null,
        biz_delta_pct:    forecast?.proj_24mo_biz_delta_pct   || null,
        market_maturity:  forecast?.proj_24mo_maturity        || null,
        confidence:       forecast?.proj_24mo_confidence      || null,
      },
      '36_month': {
        growth_score:     forecast?.proj_36mo_growth_score    || null,
        opportunity:      forecast?.proj_36mo_opportunity     || null,
        biz_delta_pct:    forecast?.proj_36mo_biz_delta_pct   || null,
        market_maturity:  forecast?.proj_36mo_maturity        || null,
        confidence:       forecast?.proj_36mo_confidence      || null,
        summary:          forecast?.summary_36mo              || null,
      },
    },
    driver_signals:     forecast?.driver_signals     || [],
    opportunity_gaps:   forecast?.opportunity_gaps   || [],
    risk_factors:       forecast?.risk_factors       || [],
    anomalies: anomalies.map(a => ({
      signal:          a.signal_name,
      question:        a.question,
      actual:          a.actual_value,
      expected:        a.expected_value,
      z_score:         a.z_score,
      severity:        a.severity,
      candidate_causes: a.candidate_causes || [],
    })),
    historical_trend: history.map(h => ({
      date:               h.snapshot_date,
      growth_score:       h.sig_growth_score,
      opportunity_score:  h.sig_opportunity_score,
      market_maturity:    h.sig_market_maturity,
      businesses:         h.cbp_total_establishments,
      permits_annual:     h.bps_total_units_annual,
      sunbiz_net:         h.sunbiz_net_12mo,
    })),
    causal_events: causalEvents.map(e => ({
      type:           e.event_type,
      category:       e.event_category,
      title:          e.title,
      description:    e.description,
      announced:      e.announced_date,
      effective:      e.effective_date,
      completion:     e.completion_date,
      source:         e.source_url,
    })),
    peer_comparison: peerZips.map(p => ({
      zip:              p.zip,
      growth_score:     p.sig_growth_score,
      opportunity:      p.sig_opportunity_score,
      maturity:         p.sig_market_maturity,
      population:       p.acs_population,
      median_agi:       p.irs_agi_median,
      businesses:       p.cbp_total_establishments,
    })),
    recommendations: generateRecommendations(signals, forecast, anomalies),
    data_sources: {
      acs:            signals?.acs_vintage || 'ACS 5-year',
      irs_income:     signals?.irs_updated_at ? 'IRS SOI 2022' : null,
      irs_migration:  signals?.irs_mig_vintage || null,
      permits:        signals?.bps_updated_at ? 'Census BPS (all FL counties)' : null,
      osm:            signals?.osm_updated_at ? 'OpenStreetMap (Overpass)' : null,
      fcc:            signals?.fcc_updated_at ? 'FCC Form 477 (broadband coverage)' : null,
      sunbiz:         signals?.sunbiz_updated_at ? 'Florida Sunbiz (entity registrations)' : null,
    },
    disclaimer: 'This report is generated from public government data sources and statistical models. ' +
      'LocalIntel Data Services makes no guarantees of accuracy or fitness for any particular purpose. ' +
      'This is not investment, legal, or financial advice. Data is as of the dates shown. ' +
      'Projections are model estimates based on historical patterns and are inherently uncertain.',
  };

  // ── Generate HTML ────────────────────────────────────────────────────────
  const reportHtml = renderReportHtml(reportJson);

  // ── Store to zip_reports ─────────────────────────────────────────────────
  const accessToken = crypto.randomBytes(24).toString('hex');
  let reportId = null;
  try {
    const row = await db.queryOne(
      `INSERT INTO zip_reports
         (zip, model_version, report_type, lead_id, horizon_months,
          report_json, report_html, data_completeness, confidence_score, access_token, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ready')
       RETURNING id, access_token`,
      [
        zip,
        reportJson.meta.model_version,
        reportType,
        leadId || null,
        horizonMonths,
        JSON.stringify(reportJson),
        reportHtml,
        dataCompleteness,
        forecast?.proj_12mo_confidence || null,
        accessToken,
      ]
    );
    reportId = row?.id;
    console.log(`[reportGen] Report ${reportId} stored for ZIP ${zip} (token: ${accessToken.slice(0, 8)}...)`);
  } catch (e) {
    console.error('[reportGen] Failed to store report:', e.message);
  }

  return {
    report_id:    reportId,
    zip,
    access_token: accessToken,
    report:       reportJson,
    html:         reportHtml,
    data_completeness: dataCompleteness,
  };
}

// ── Recommendation engine ─────────────────────────────────────────────────────
function generateRecommendations(signals, forecast, anomalies) {
  const recs = [];

  // Broadband gap
  if (signals?.fcc_has_25_3 === false) {
    recs.push({
      priority: 'high',
      category: 'infrastructure',
      finding: 'Broadband coverage is below the FCC 25/3 Mbps minimum benchmark',
      action: 'Any broadband-dependent business (tech, remote work hub, streaming, POS systems) will face operational challenges. Monitor FCC EBS grant awards for this county.',
    });
  }

  // OSM discoverability gap
  if (signals?.osm_with_website_pct < 25) {
    recs.push({
      priority: 'high',
      category: 'digital_presence',
      finding: `Only ${signals.osm_with_website_pct}% of businesses in this ZIP have a website`,
      action: 'Massive SEO and agentic discoverability opportunity. Businesses here are invisible to AI-powered search. First-mover advantage for any business that invests in digital presence.',
    });
  } else if (signals?.osm_with_website_pct < 50) {
    recs.push({
      priority: 'medium',
      category: 'digital_presence',
      finding: `${signals.osm_with_website_pct}% of businesses have websites — below the 50% benchmark`,
      action: 'Above-average opportunity to capture local SEO share vs undigitized competitors.',
    });
  }

  // Strong growth with opportunity gap
  if (forecast?.proj_12mo_growth_score > 65 && forecast?.proj_12mo_opportunity > 60) {
    recs.push({
      priority: 'high',
      category: 'market_timing',
      finding: `High growth (score ${forecast.proj_12mo_growth_score}/100) combined with high opportunity (${forecast.proj_12mo_opportunity}/100)`,
      action: 'Optimal window for market entry. Growth signals are positive but the market is not yet saturated. 12-month window before conditions tighten.',
    });
  }

  // Net migration wealth inflow
  if (signals?.irs_mig_net_agi > 50000) {
    const agiM = Math.round(signals.irs_mig_net_agi / 1000);
    recs.push({
      priority: 'high',
      category: 'demand',
      finding: `Net AGI inflow of $${agiM}M (IRS migration data) — wealthy residents moving in`,
      action: signals.irs_mig_top_origin
        ? `Top origin: ${signals.irs_mig_top_origin}. These are high-income transplants seeking premium goods and services. Fine dining, professional services, and luxury retail are well-positioned.`
        : 'Net wealth inflow signals sustained premium spending demand.',
    });
  }

  // Permit surge — supply incoming
  if (signals?.bps_res_1unit_annual > 500) {
    recs.push({
      priority: 'medium',
      category: 'supply_signal',
      finding: `${signals.bps_res_1unit_annual} single-family permits issued in the most recent full year`,
      action: 'Significant residential supply coming. Businesses serving new homeowners (furniture, landscaping, home services, childcare, local dining) should position now ahead of population arrival.',
    });
  }

  // Anomaly-driven recommendations
  for (const anom of (anomalies || []).slice(0, 2)) {
    if (anom.severity === 'significant' || anom.severity === 'extreme') {
      recs.push({
        priority: 'medium',
        category: 'anomaly_signal',
        finding: anom.question,
        action: 'This is a statistically unusual pattern that warrants investigation before committing capital. A full market consultation is recommended to understand the underlying driver.',
      });
    }
  }

  return recs;
}

// ── HTML renderer ─────────────────────────────────────────────────────────────
function renderReportHtml(report) {
  const { meta, location, scores, projections, growth_signals, current_state, recommendations, anomalies, historical_trend } = report;
  const fmt = (v, type = 'number') => {
    if (v === null || v === undefined) return 'N/A';
    if (type === 'pct') return `${v}%`;
    if (type === 'money') return `$${Number(v).toLocaleString()}`;
    if (type === 'bool') return v ? 'Yes' : 'No';
    return typeof v === 'number' ? v.toLocaleString() : v;
  };
  const scoreBar = (score) => {
    if (score === null || score === undefined) return '';
    const color = score > 65 ? '#16A34A' : score > 45 ? '#CA8A04' : '#DC2626';
    return `<div style="height:8px;border-radius:4px;background:#e5e7eb;margin-top:4px">
      <div style="width:${score}%;height:100%;border-radius:4px;background:${color}"></div></div>`;
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>LocalIntel Market Report — ZIP ${meta.zip}</title>
  <style>
    body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 0 auto; padding: 24px; color: #111; }
    h1 { font-size: 24px; font-weight: 700; color: #111; margin-bottom: 4px; }
    h2 { font-size: 16px; font-weight: 700; color: #16A34A; text-transform: uppercase; letter-spacing: 0.05em; margin: 28px 0 12px; border-bottom: 2px solid #16A34A; padding-bottom: 6px; }
    .meta { color: #6b7280; font-size: 13px; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 16px; }
    .card { background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; }
    .card .label { font-size: 11px; font-weight: 600; color: #6b7280; text-transform: uppercase; letter-spacing: 0.04em; }
    .card .value { font-size: 24px; font-weight: 700; margin-top: 4px; }
    .signal-row { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #f3f4f6; font-size: 14px; }
    .signal-row:last-child { border-bottom: none; }
    .signal-label { color: #374151; }
    .signal-value { font-weight: 600; color: #111; }
    .rec { padding: 14px 16px; border-left: 4px solid; border-radius: 0 8px 8px 0; margin-bottom: 10px; }
    .rec.high    { background: #fef2f2; border-color: #dc2626; }
    .rec.medium  { background: #fffbeb; border-color: #d97706; }
    .rec .rec-category { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7280; }
    .rec .rec-finding { font-weight: 600; margin: 4px 0; }
    .rec .rec-action { font-size: 13px; color: #374151; }
    .anomaly { background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 14px; margin-bottom: 8px; }
    .anomaly .question { font-weight: 600; color: #166534; margin-bottom: 6px; }
    .anomaly .severity { display: inline-block; font-size: 11px; font-weight: 700; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; background: #dcfce7; color: #166534; margin-bottom: 8px; }
    .anomaly.significant .severity { background: #fef9c3; color: #854d0e; }
    .anomaly.extreme .severity { background: #fee2e2; color: #991b1b; }
    .proj-grid { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; }
    .proj-card { text-align: center; background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; }
    .proj-card .horizon { font-size: 11px; font-weight: 700; color: #16A34A; text-transform: uppercase; letter-spacing: 0.05em; }
    .proj-card .score { font-size: 32px; font-weight: 800; color: #111; }
    .proj-card .maturity { font-size: 12px; color: #6b7280; margin-top: 4px; }
    .disclaimer { font-size: 11px; color: #9ca3af; border-top: 1px solid #f3f4f6; margin-top: 32px; padding-top: 16px; line-height: 1.5; }
    .brand { font-weight: 800; color: #16A34A; }
  </style>
</head>
<body>
  <p class="meta"><span class="brand">LocalIntel</span> Data Services · Market Intelligence Report</p>
  <h1>ZIP ${meta.zip} — ${location.city}, ${location.county}</h1>
  <p class="meta">Generated ${new Date(meta.generated_at).toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })} · Model ${meta.model_version} · Data completeness ${Math.round(meta.data_completeness * 100)}%</p>

  <h2>Market Scores</h2>
  <div class="grid">
    <div class="card">
      <div class="label">Growth Score</div>
      <div class="value" style="color:#16A34A">${fmt(scores.growth_score)}<span style="font-size:14px;font-weight:400;color:#6b7280">/100</span></div>
      ${scoreBar(scores.growth_score)}
    </div>
    <div class="card">
      <div class="label">Opportunity Score</div>
      <div class="value" style="color:#16A34A">${fmt(scores.opportunity_score)}<span style="font-size:14px;font-weight:400;color:#6b7280">/100</span></div>
      ${scoreBar(scores.opportunity_score)}
    </div>
    <div class="card">
      <div class="label">Market Maturity</div>
      <div class="value" style="font-size:18px;text-transform:capitalize">${scores.market_maturity || 'N/A'}</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px">vs ${scores.peer_zip_count || '?'} peer ZIPs</div>
    </div>
  </div>

  <h2>12 / 24 / 36-Month Projections</h2>
  <div class="proj-grid">
    ${['12_month','24_month','36_month'].map(h => {
      const p = projections[h];
      return `<div class="proj-card">
        <div class="horizon">${h.replace('_',' ')}</div>
        <div class="score">${fmt(p?.growth_score)}</div>
        <div class="maturity" style="text-transform:capitalize">${p?.market_maturity || 'N/A'}</div>
        ${p?.biz_delta_pct !== null && p?.biz_delta_pct !== undefined
          ? `<div style="font-size:12px;margin-top:6px;color:${p.biz_delta_pct > 0 ? '#16A34A' : '#DC2626'}">${p.biz_delta_pct > 0 ? '+' : ''}${p.biz_delta_pct}% biz</div>`
          : ''}
        <div style="font-size:11px;color:#9ca3af;margin-top:4px">conf. ${p?.confidence !== null ? Math.round((p.confidence || 0)*100)+'%' : 'N/A'}</div>
      </div>`;
    }).join('')}
  </div>
  ${projections['12_month']?.summary ? `<p style="font-size:14px;color:#374151;margin-top:12px;line-height:1.6">${projections['12_month'].summary}</p>` : ''}

  <h2>Current Market Snapshot</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div>
      <div class="signal-row"><span class="signal-label">Population</span><span class="signal-value">${fmt(current_state.population)}</span></div>
      <div class="signal-row"><span class="signal-label">Total Households</span><span class="signal-value">${fmt(current_state.households)}</span></div>
      <div class="signal-row"><span class="signal-label">Median AGI</span><span class="signal-value">${fmt(current_state.median_agi, 'money')}</span></div>
      <div class="signal-row"><span class="signal-label">Owner Occupied</span><span class="signal-value">${fmt(current_state.owner_occupied_pct, 'pct')}</span></div>
      <div class="signal-row"><span class="signal-label">Broadband 25/3</span><span class="signal-value">${fmt(current_state.broadband_has_25_3, 'bool')}</span></div>
      <div class="signal-row"><span class="signal-label">Gigabit Available</span><span class="signal-value">${fmt(current_state.broadband_has_gigabit, 'bool')}</span></div>
    </div>
    <div>
      <div class="signal-row"><span class="signal-label">Total Businesses</span><span class="signal-value">${fmt(current_state.total_businesses)}</span></div>
      <div class="signal-row"><span class="signal-label">Active Sunbiz Entities</span><span class="signal-value">${fmt(current_state.active_sunbiz_entities)}</span></div>
      <div class="signal-row"><span class="signal-label">Net Biz Formation (12mo)</span><span class="signal-value">${fmt(current_state.net_business_formation)}</span></div>
      <div class="signal-row"><span class="signal-label">OSM-Indexed Businesses</span><span class="signal-value">${fmt(current_state.osm_indexed_businesses)}</span></div>
      <div class="signal-row"><span class="signal-label">Have Website</span><span class="signal-value">${fmt(current_state.osm_with_website_pct, 'pct')}</span></div>
      <div class="signal-row"><span class="signal-label">Have Phone</span><span class="signal-value">${fmt(current_state.osm_with_phone_pct, 'pct')}</span></div>
    </div>
  </div>

  <h2>Growth Signals</h2>
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div>
      <div class="signal-row"><span class="signal-label">Single-Family Permits (annual)</span><span class="signal-value">${fmt(growth_signals.annual_res_permits_1unit)}</span></div>
      <div class="signal-row"><span class="signal-label">Multifamily Permits (annual)</span><span class="signal-value">${fmt(growth_signals.annual_res_permits_multifam)}</span></div>
      <div class="signal-row"><span class="signal-label">Total Units Permitted (annual)</span><span class="signal-value">${fmt(growth_signals.annual_total_units_permitted)}</span></div>
    </div>
    <div>
      <div class="signal-row"><span class="signal-label">Net Migration (households)</span><span class="signal-value">${fmt(growth_signals.net_migration_households)}</span></div>
      <div class="signal-row"><span class="signal-label">Net AGI Migration ($000s)</span><span class="signal-value">${fmt(growth_signals.net_migration_agi_k)}</span></div>
      <div class="signal-row"><span class="signal-label">Top Migration Origin</span><span class="signal-value" style="font-size:12px">${growth_signals.top_migration_origin || 'N/A'}</span></div>
    </div>
  </div>

  ${recommendations.length > 0 ? `
  <h2>Analyst Recommendations</h2>
  ${recommendations.map(r => `
  <div class="rec ${r.priority}">
    <div class="rec-category">${r.category.replace(/_/g,' ')} · ${r.priority} priority</div>
    <div class="rec-finding">${r.finding}</div>
    <div class="rec-action">${r.action}</div>
  </div>`).join('')}` : ''}

  ${anomalies.length > 0 ? `
  <h2>Market Anomalies</h2>
  <p style="font-size:13px;color:#6b7280;margin-bottom:12px">Statistically unusual patterns detected by the LocalIntel world model. These are questions the data is asking — and they represent the highest-value consultation opportunities.</p>
  ${anomalies.map(a => `
  <div class="anomaly ${a.severity}">
    <div class="severity">${a.severity} anomaly · ${Math.abs(a.z_score).toFixed(1)}σ</div>
    <div class="question">${a.question}</div>
    ${a.candidate_causes?.length ? `<div style="font-size:12px;color:#374151"><strong>Candidate explanations:</strong> ${a.candidate_causes.slice(0,2).map(c => c.cause).join(' · ')}</div>` : ''}
  </div>`).join('')}` : ''}

  <div class="disclaimer">${report.disclaimer}</div>
  <p style="font-size:12px;color:#9ca3af;margin-top:8px">Report ID: ${meta.zip}-${new Date(meta.generated_at).toISOString().slice(0,10)} · <span class="brand">LocalIntel</span> Data Services · Erik Osol · <a href="https://www.thelocalintel.com" style="color:#16A34A">thelocalintel.com</a></p>
</body>
</html>`;
}

module.exports = { generateReport };
