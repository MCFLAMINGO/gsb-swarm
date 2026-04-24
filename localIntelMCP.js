'use strict';
/**
 * LocalIntel MCP Server — GSB Swarm
 *
 * Implements the Model Context Protocol (MCP) JSON-RPC 2.0 spec.
 * Agents (Claude, GPT, Cursor, etc.) connect via HTTP POST to /mcp
 * and call tools to query the SJC business + zone dataset.
 *
 * Tools exposed:
 *   local_intel_context     — spatial context block for a zip or lat/lon
 *   local_intel_search      — search businesses by name/category/zip
 *   local_intel_nearby      — businesses within radius of a lat/lon point
 *   local_intel_zone        — spending zone + demographic data for a zip
 *   local_intel_corridor    — businesses along a named street corridor
 *   local_intel_changes     — recently added/claimed/updated listings
 *   local_intel_stats       — dataset coverage stats
 *
 * Billing: each tool call logs to usage_ledger.json for future ACP billing.
 * Port: 3004 (internal Railway port, proxied via /api/mcp on port 3001)
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_PATH    = path.join(__dirname, 'data', 'localIntel.json');
const ZIPS_DIR_MCP = path.join(__dirname, 'data', 'zips');
const ZONES_PATH   = path.join(__dirname, 'data', 'spendingZones.json');
const LEDGER_PATH  = path.join(__dirname, 'data', 'usageLedger.json');
const PORT         = parseInt(process.env.LOCAL_INTEL_MCP_PORT || '3004');

// ── Cost per tool call (pathUSD) ──────────────────────────────────────────────
// ── Tidal tools ──────────────────────────────────────────────────────────────
const { handleTide, handleSignal, handleBedrock, handleForAgent, handleAsk } = require('./localIntelTidalTools');
const { handleVerticalQuery } = require('./workers/verticalAgentWorker');
const { route }               = require('./workers/intentRouter');
const inferenceCache          = require('./workers/inferenceCache');

// ── handleQuery — fuzzy intent router entry point ─────────────────────────────
// Single tool an LLM can call with any plain-English question about any market.
// Checks inference cache first, routes to correct vertical + ZIP, dispatches
// scout on low confidence. Multi-ZIP queries return ranked results.
async function handleQuery(params) {
  const query = (params.query || params.q || '').trim();
  if (!query) return { error: 'query required — pass any plain-English question about a local market' };

  const r = route(query);

  // Override ZIP if caller provided one explicitly; fall back to primary coverage ZIP
  const zip = (params.zip || r.zip || '').replace(/\D/g, '').slice(0, 5) || r.zip || '32082';

  // Cache check
  if (r.vertical) {
    const cached = inferenceCache.get(query, r.vertical, zip);
    if (cached) {
      return {
        query,
        routed_to:        r.tool,
        vertical:         r.vertical,
        zip,
        route_confidence: r.route_confidence,
        reasoning:        r.reasoning,
        answer:           cached.answer,
        confidence_score: cached.confidence,
        _cache:           { hit: true, similarity: cached.similarity, expires_at: cached.expires_at },
      };
    }
  }

  // Route to vertical handler or ask tool
  let answer;
  if (r.vertical) {
    answer = await handleVerticalQuery(r.vertical, query, zip);
  } else {
    answer = handleAsk({ query, zip });
    if (answer && typeof answer.then === 'function') answer = await answer;
  }

  // Multi-ZIP: run top additional ZIPs if region query
  let multiResults = null;
  if (r.multi_zip && r.zips.length > 1 && r.vertical) {
    multiResults = await Promise.all(
      r.zips.slice(1).map(z => handleVerticalQuery(r.vertical, query, z).catch(() => null))
    );
    multiResults = multiResults.filter(Boolean);
  }

  return {
    query,
    routed_to:        r.tool,
    vertical:         r.vertical,
    zip,
    zips_evaluated:   r.zips,
    route_confidence: r.route_confidence,
    reasoning:        r.reasoning,
    answer,
    multi_zip_results: multiResults,
    _cache:           { hit: false },
    _llm_hint:        r.route_confidence < 50
      ? 'Low routing confidence — consider calling local_intel_ask with a more specific ZIP or location name'
      : `Routed to ${r.tool} with ${r.route_confidence}% confidence. Chain local_intel_sector_gap for gap analysis.`,
  };
}

// ── Oracle handler ─────────────────────────────────────────────────────────────
function handleOracle(params) {
  const zip = (params.zip || '').replace(/\D/g, '').slice(0, 5);
  if (!zip) return { error: 'zip required' };
  const oracleDir = path.join(__dirname, 'data', 'oracle');
  const file = path.join(oracleDir, `${zip}.json`);
  if (!require('fs').existsSync(file)) {
    return { error: `Oracle not yet computed for ${zip}. The oracle worker runs every 6h — try again shortly.` };
  }
  return require('fs').readFileSync(file, 'utf8');
}


function handleSectorGap(params) {
  const zip = (params.zip || '').replace(/\D/g, '').slice(0, 5);
  if (!zip) return JSON.stringify({ error: 'zip required' });

  const layerDir   = path.join(__dirname, 'data', 'census_layer');
  const oracleDir  = path.join(__dirname, 'data', 'oracle');
  const zonesFile  = path.join(__dirname, 'data', 'spendingZones.json');
  const layerFile  = path.join(layerDir, zip + '.json');
  const fsLib      = require('fs');

  if (!fsLib.existsSync(layerFile)) {
    return JSON.stringify({
      error: 'Census layer not yet computed for ' + zip + '. The censusLayerWorker runs on startup.',
      zip,
    });
  }

  const layer = JSON.parse(fsLib.readFileSync(layerFile, 'utf8'));
  const gaps  = layer.sector_gaps || [];

  if (gaps.length === 0) {
    return JSON.stringify({
      zip,
      name:        layer.name || zip,
      county:      layer.county || '',
      message:     'No sector gaps found — all major NAICS sectors present at ZIP level, or ZBP data not yet ingested.',
      sector_gaps: [],
    });
  }

  let demo = {}, oracle = {};
  try {
    const zones = JSON.parse(fsLib.readFileSync(zonesFile, 'utf8'));
    demo = (zones && zones.zones && zones.zones[zip]) ? zones.zones[zip] : {};
  } catch (_) {}
  try {
    const oracleFile = path.join(oracleDir, zip + '.json');
    if (fsLib.existsSync(oracleFile)) oracle = JSON.parse(fsLib.readFileSync(oracleFile, 'utf8'));
  } catch (_) {}

  const population   = demo.population   || (oracle.demographics && oracle.demographics.population) || 0;
  const medianHHI    = demo.median_household_income || (oracle.demographics && oracle.demographics.median_hhi) || 0;
  const ownerOccPct  = demo.ownership_rate_pct   || 0;
  const affluencePct = demo.affluence_pct        || 0;
  const ultraAffPct  = demo.ultra_affluence_pct  || 0;
  const wfhPct       = demo.wfh_pct              || 0;
  const daytimeMult  = demo.daytime_pop_multiplier || 1.0;
  const renovWave    = demo.renovation_wave       || null;
  const familyHHPct  = demo.family_hh_pct        || 0;
  const retireeIndex = demo.retiree_index         || 1.0;
  const vacancyPct   = (demo.vacancy_rate_pct != null) ? demo.vacancy_rate_pct : null;

  const confidence = layer.confidence || {};
  const confTier   = confidence.confidence_tier       || 'ESTIMATED';
  const confScore  = confidence.data_confidence_score || 0;

  function sectorSignal(naics, countyEstab, countyEmpShare) {
    if (!population) return { demand_estimate: null, demand_narrative: 'Population data unavailable.', relevance_score: 0 };
    const hhi_k      = Math.round((medianHHI || 0) / 1000);
    const daytimePop = Math.round(population * daytimeMult);

    switch (naics) {
      case '61': {
        const schoolAge = Math.round(population * 0.18);
        const centers   = Math.max(2, Math.min(20, Math.round(schoolAge / 800)));
        const relevance = Math.round(30 + (familyHHPct * 0.4) + (affluencePct * 0.3) + (Math.min(hhi_k, 150) * 0.1));
        return {
          demand_estimate:  (centers - 2) + '\u2013' + (centers + 2) + ' tutoring/enrichment centers',
          demand_narrative: schoolAge.toLocaleString() + ' est. school-age residents. ' + familyHHPct + '% family HH, ' + affluencePct + '% earning $100k+. ' + countyEstab + ' Educational Services at county — none at ZIP.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '62': {
        const retirees  = Math.round(population * 0.15 * retireeIndex);
        const providers = Math.max(3, Math.round(population / 3500));
        const relevance = Math.round(40 + (retireeIndex * 15) + (Math.min(population, 70000) / 1500));
        return {
          demand_estimate:  (providers - 1) + '\u2013' + (providers + 2) + ' primary care / specialist providers',
          demand_narrative: population.toLocaleString() + ' residents, retiree index ' + retireeIndex.toFixed(1) + 'x (' + retirees.toLocaleString() + ' est. seniors). ' + countyEmpShare + '% of county employment is healthcare — structurally underserved at ZIP level.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '72': {
        const isSeasonal = (vacancyPct || 0) > 25;
        const concepts   = Math.max(2, Math.round(daytimePop / 2500));
        const relevance  = Math.round(35 + (daytimeMult * 20) + (isSeasonal ? 15 : 0) + ((ultraAffPct || 0) * 0.2));
        const vacStr     = isSeasonal ? (vacancyPct + '% housing vacancy = seasonal/tourist overlay.') : 'Primarily residential demand base.';
        return {
          demand_estimate:  (concepts - 1) + '\u2013' + (concepts + 3) + ' food/beverage concepts',
          demand_narrative: daytimePop.toLocaleString() + ' est. daytime pop (' + daytimeMult.toFixed(2) + 'x multiplier). ' + vacStr + ' $' + hhi_k + 'k median HHI supports hospitality.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '44':
      case '45': {
        const spendCap  = Math.round((population * medianHHI * 0.12) / 1e6 * 10) / 10;
        const stores    = Math.max(2, Math.round(population / 2000));
        const relevance = Math.round(30 + (Math.min(hhi_k, 150) * 0.15) + (wfhPct * 0.3) + ((affluencePct || 0) * 0.2));
        return {
          demand_estimate:  (stores - 1) + '\u2013' + (stores + 3) + ' retail establishments',
          demand_narrative: '~$' + spendCap + 'M annual retail spending capacity (' + population.toLocaleString() + ' residents x $' + hhi_k + 'k HHI x 12% retail share). ' + wfhPct + '% WFH drives daytime foot traffic. ' + countyEstab + ' retail establishments at county — structural gap at ZIP.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '52': {
        const relevance = Math.round(25 + (affluencePct * 0.4) + (ownerOccPct * 0.2) + (ultraAffPct * 0.3));
        const advisors  = Math.max(1, Math.round(population / 5000));
        return {
          demand_estimate:  advisors + '\u2013' + (advisors + 2) + ' financial services providers',
          demand_narrative: affluencePct + '% of HH earn $100k+ (' + ultraAffPct + '% earn $200k+). ' + ownerOccPct + '% owner-occupied. Wealth management, insurance, mortgage, and tax services underrepresented.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '53': {
        const relevance = Math.round(25 + (ownerOccPct * 0.25) + (affluencePct * 0.2) + (renovWave === 'HIGH' ? 20 : renovWave === 'MODERATE' ? 10 : 0));
        const agents    = Math.max(1, Math.round(population / 4000));
        const renovStr  = renovWave ? ('Renovation wave: ' + renovWave + '. ') : '';
        return {
          demand_estimate:  agents + '\u2013' + (agents + 3) + ' real estate / property management offices',
          demand_narrative: ownerOccPct + '% owner-occupied. ' + renovStr + '$' + hhi_k + 'k median HHI. County has ' + countyEstab + ' RE establishments — no local presence at ZIP level.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '54': {
        const relevance = Math.round(20 + (wfhPct * 0.5) + (affluencePct * 0.2) + (Math.min(hhi_k, 150) * 0.1));
        const firms     = Math.max(1, Math.round(population / 3500));
        return {
          demand_estimate:  firms + '\u2013' + (firms + 3) + ' professional services firms',
          demand_narrative: wfhPct + '% WFH drives demand for accounting, legal, consulting, and tech services. ' + affluencePct + '% affluent HH. County has ' + countyEstab + ' professional services firms — zero at ZIP.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '23': {
        const relevance   = Math.round(20 + (renovWave === 'HIGH' ? 30 : renovWave === 'MODERATE' ? 15 : 5) + (Math.min(population, 70000) / 2000));
        const contractors = Math.max(1, Math.round(population / 4500));
        return {
          demand_estimate:  contractors + '\u2013' + (contractors + 3) + ' construction / home services contractors',
          demand_narrative: 'Renovation wave: ' + (renovWave || 'UNKNOWN') + '. ' + countyEstab + ' construction establishments at county. ' + ownerOccPct + '% owner-occupied = strong home services demand.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '71': {
        const isSeasonal = (vacancyPct || 0) > 20;
        const relevance  = Math.round(15 + (isSeasonal ? 25 : 0) + (ultraAffPct * 0.4) + (daytimeMult * 10));
        const venues     = Math.max(1, Math.round(daytimePop / 8000));
        const vacStr2    = isSeasonal ? (vacancyPct + '% vacancy = seasonal/tourist market with entertainment demand spikes.') : 'Resident-anchored market.';
        return {
          demand_estimate:  venues + '\u2013' + (venues + 2) + ' entertainment / recreation venues',
          demand_narrative: vacStr2 + ' ' + ultraAffPct + '% ultra-affluent HH supports premium experiences. ' + daytimePop.toLocaleString() + ' daytime population.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      case '51': {
        const relevance = Math.round(10 + (wfhPct * 0.6) + (affluencePct * 0.15));
        return {
          demand_estimate:  '1\u20133 tech services / co-working providers',
          demand_narrative: wfhPct + '% WFH creates demand for co-working, IT support, and digital services. ' + affluencePct + '% affluent HH. County has ' + countyEstab + ' information sector establishments.',
          relevance_score:  Math.min(99, relevance),
        };
      }
      default: {
        const relevance = Math.round(10 + (countyEmpShare * 1.5));
        return {
          demand_estimate:  null,
          demand_narrative: countyEstab + ' establishments at county level (' + countyEmpShare + '% of county employment). No ZIP-level presence via ZBP 2018 baseline.',
          relevance_score:  Math.min(99, relevance),
        };
      }
    }
  }

  const rankedGaps = gaps.map(function(g) {
    var sig = sectorSignal(g.naics, g.county_estab, g.county_emp_share);
    return {
      rank:             0,
      naics:            g.naics,
      sector:           g.label,
      oracle_vertical:  g.oracle_vertical || null,
      county_estab:     g.county_estab,
      county_emp_share: g.county_emp_share,
      demand_estimate:  sig.demand_estimate,
      signal:           sig.demand_narrative,
      confidence:       confTier,
      relevance_score:  sig.relevance_score,
    };
  })
  .sort(function(a, b) { return b.relevance_score - a.relevance_score; })
  .map(function(g, i) { return Object.assign({}, g, { rank: i + 1 }); });

  const topGap    = rankedGaps[0];
  const hhi_k_d   = Math.round((medianHHI || 0) / 1000);
  const demoParts = [];
  if (population)          demoParts.push('Population: ' + population.toLocaleString());
  if (medianHHI)           demoParts.push('Median HHI: $' + hhi_k_d + 'k');
  if (affluencePct)        demoParts.push('Affluent HH (>$100k): ' + affluencePct + '%');
  if (ultraAffPct)         demoParts.push('Ultra-affluent HH (>$200k): ' + ultraAffPct + '%');
  if (ownerOccPct)         demoParts.push('Owner-occupied: ' + ownerOccPct + '%');
  if (wfhPct)              demoParts.push('WFH rate: ' + wfhPct + '%');
  if (daytimeMult !== 1.0) demoParts.push('Daytime pop multiplier: ' + daytimeMult.toFixed(2) + 'x');
  if (renovWave)           demoParts.push('Renovation wave: ' + renovWave);
  if (vacancyPct != null)  demoParts.push('Housing vacancy: ' + vacancyPct + '%');
  const demoBlock = demoParts.length ? demoParts.join(' | ') : 'Demographic data not yet loaded for this ZIP.';

  const result = {
    zip,
    name:     layer.name || zip,
    county:   layer.county || '',
    summary:  rankedGaps.length + ' sector gap' + (rankedGaps.length !== 1 ? 's' : '') + ' identified in ' + (layer.name || zip) + ' (' + zip + '). Top opportunity: ' + topGap.sector + ' (NAICS ' + topGap.naics + ') — ' + (topGap.demand_estimate || 'demand estimated from county benchmarks') + '. Data confidence: ' + confTier + ' (score ' + confScore + '/100).',
    demographics: demoBlock,
    data_confidence: {
      tier:  confTier,
      score: confScore,
      note:  confTier === 'SPARSE'    ? 'Low signal density — treat as directional only'
           : confTier === 'PROXY'     ? 'Moderate confidence — demographics estimated from proxies'
           : confTier === 'ESTIMATED' ? 'Good confidence — Census-backed with growing oracle history'
           :                            'High confidence — Census-verified with validated oracle signal history',
    },
    sector_gaps:  rankedGaps,
    generated_at: new Date().toISOString(),
    source:       'ZBP 2018 (ZIP-level) + CBP 2023 (county-level) + ACS 5-yr 2023 (demographics)',
    cost_pathusd: 0.03,
    _llm_hint:    'Use sector_gaps[].signal for actionable framing. Use sector_gaps[].oracle_vertical to chain into vertical agents (e.g. local_intel_healthcare for NAICS 62). Top gap by relevance_score is the strongest opportunity. ESTIMATED confidence = good to act on; SPARSE = verify before committing.',
  };

  return JSON.stringify(result, null, 2);
}

const { wrapMCPHandler } = require('./workers/mcpMiddleware');
const { getStaleness, stalenessBlock, zipFreshnessBlock } = require('./workers/stalenessUtils');

const TOOL_COSTS = {
  local_intel_context:   0.02,
  local_intel_search:    0.01,
  local_intel_nearby:    0.02,
  local_intel_zone:      0.01,
  local_intel_corridor:  0.02,
  local_intel_changes:   0.01,
  // Tidal layer tools
  local_intel_tide:      0.02,
  local_intel_signal:    0.03,
  local_intel_bedrock:   0.02,
  local_intel_for_agent: 0.05,
  local_intel_oracle:    0.03,
  local_intel_sector_gap: 0.03,
  local_intel_realtor:      0.02,
  local_intel_healthcare:   0.02,
  local_intel_retail:       0.02,
  local_intel_construction: 0.02,
  local_intel_restaurant:   0.02,
  local_intel_ask:          0.05,
  local_intel_query:        0.03,
  local_intel_stats:    0.005,
};

// ── Data loaders ──────────────────────────────────────────────────────────────
function loadBusinesses() {
  // Merge seed file + all accumulated zip files for the full dataset
  const seen  = new Map(); // key -> index in all[]
  const all   = [];
  const addBiz = (b) => {
    const name = (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const zip  = b.zip || '';
    // Primary key: normalized name + zip (catches same biz from OSM vs YP)
    // Secondary: if lat/lon present use them to further disambiguate chains
    const addrNorm = (b.address || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
    const key = `${name}|${zip}|${addrNorm}`;
    if (seen.has(key)) {
      // Keep higher-confidence record
      const existingIdx = seen.get(key);
      if ((b.confidence || 0) > (all[existingIdx].confidence || 0)) {
        all[existingIdx] = b;
      }
    } else {
      seen.set(key, all.length);
      all.push(b);
    }
  };
  try { JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')).forEach(addBiz); } catch {}
  try {
    if (fs.existsSync(ZIPS_DIR_MCP)) {
      fs.readdirSync(ZIPS_DIR_MCP).filter(f => f.endsWith('.json')).forEach(f => {
        try { JSON.parse(fs.readFileSync(path.join(ZIPS_DIR_MCP, f), 'utf8')).forEach(addBiz); } catch {}
      });
    }
  } catch {}
  return all;
}
function loadZones() {
  try { return JSON.parse(fs.readFileSync(ZONES_PATH, 'utf8')); } catch { return {}; }
}
function logUsage(tool, caller, meta) {
  try {
    const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch { return []; } })();
    const entry = {
      tool,
      caller:  caller || 'unknown',
      entry:   meta?.entry   || 'free',
      cost:    TOOL_COSTS[tool] || 0,
      paid:    false,
      ts:      new Date().toISOString(),
    };
    if (meta?.zip)     entry.zip     = meta.zip;
    if (meta?.intent)  entry.intent  = meta.intent;
    if (meta?.latency) entry.latency = meta.latency;
    ledger.push(entry);
    if (ledger.length > 10000) ledger.splice(0, ledger.length - 10000);
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
  } catch {}
}

// ── Haversine distance (miles) ────────────────────────────────────────────────
function distanceMiles(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
            Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) *
            Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Category grouper ──────────────────────────────────────────────────────────
const CAT_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','alcohol'],
  retail:   ['supermarket','convenience','clothes','hairdresser','beauty','chemist',
             'mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre',
             'sports_centre','swimming_pool'],
  finance:  ['bank','atm','estate_agent','insurance','accountant'],
  civic:    ['school','place_of_worship','church','library','post_office',
             'police','fire_station','community_centre','social_centre'],
  services: ['fuel','car_wash','car_repair','hotel','office','coworking'],
};
function getGroup(cat) {
  for (const [g, cats] of Object.entries(CAT_GROUPS)) {
    if (cats.includes(cat)) return g;
  }
  return 'other';
}

// ── ZIP centroids ─────────────────────────────────────────────────────────────
const ZIP_CENTERS = {
  // ── Core St Johns County (original coverage) ───────────────────────────────
  '32082': { lat: 30.1893, lon: -81.3815, label: 'Ponte Vedra Beach' },
  '32081': { lat: 30.1100, lon: -81.4175, label: 'Nocatee' },
  '32092': { lat: 30.0820, lon: -81.5270, label: 'World Golf Village' },
  '32084': { lat: 29.8943, lon: -81.3145, label: 'St. Augustine' },
  '32086': { lat: 29.8290, lon: -81.3100, label: 'St. Augustine South' },
  '32095': { lat: 30.1360, lon: -81.3870, label: 'Palm Valley' },
  '32080': { lat: 29.8590, lon: -81.2680, label: 'St. Augustine Beach' },
  // ── Expansion ZIPs — St Johns / Duval / Clay / Nassau (C1 candidates) ──────
  '32259': { lat: 30.0610, lon: -81.5720, label: 'Fruit Cove / Saint Johns' },
  '32250': { lat: 30.2760, lon: -81.3960, label: 'Jacksonville Beach' },
  '32266': { lat: 30.3140, lon: -81.4100, label: 'Neptune Beach' },
  '32258': { lat: 30.1330, lon: -81.6020, label: 'Bartram Park' },
  '32226': { lat: 30.4580, lon: -81.4900, label: 'North Jacksonville' },
  '32003': { lat: 30.1030, lon: -81.7120, label: 'Fleming Island' },
  '32034': { lat: 30.6680, lon: -81.4620, label: 'Fernandina Beach' },
  '32065': { lat: 30.1490, lon: -81.7920, label: 'Orange Park / Oakleaf' },
  '32097': { lat: 30.6340, lon: -81.5860, label: 'Yulee' },
  // ── Jacksonville Southside / Intracoastal (existing data) ──────────────────
  '32256': { lat: 30.1910, lon: -81.5610, label: 'Baymeadows / Tinseltown' },
  '32257': { lat: 30.1690, lon: -81.5720, label: 'Mandarin South' },
  '32224': { lat: 30.2830, lon: -81.4700, label: 'Jacksonville Intracoastal' },
  '32225': { lat: 30.3340, lon: -81.5100, label: 'Jacksonville Arlington' },
  '32246': { lat: 30.3030, lon: -81.5300, label: 'Jacksonville Regency' },
  '32233': { lat: 30.3470, lon: -81.3940, label: 'Atlantic Beach' },
  '32211': { lat: 30.3320, lon: -81.5820, label: 'Jacksonville East' },
  '32216': { lat: 30.2670, lon: -81.5510, label: 'Southside Blvd' },
  '32217': { lat: 30.2450, lon: -81.5710, label: 'San Jose' },
  '32207': { lat: 30.2920, lon: -81.6240, label: 'Jacksonville Southbank' },
  '32073': { lat: 30.1760, lon: -81.7790, label: 'Orange Park' },
};

// ── Compass bearing label ─────────────────────────────────────────────────────
function bearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) -
            Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  const brng = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  const dirs = ['N','NE','E','SE','S','SW','W','NW'];
  return dirs[Math.round(brng / 45) % 8];
}

// ── Format a business as a compact agent-readable line ────────────────────────
function fmtBusiness(b, refLat, refLon) {
  const parts = [`${b.name} [${b.category}]`];
  if (b.address) parts.push(b.address);
  if (refLat && refLon && b.lat && b.lon) {
    const d = distanceMiles(refLat, refLon, b.lat, b.lon);
    const dir = bearing(refLat, refLon, b.lat, b.lon);
    parts.push(`${d.toFixed(2)}mi ${dir}`);
  }
  if (b.phone) parts.push(`ph:${b.phone}`);
  if (b.hours) parts.push(`hours:${b.hours}`);
  if (b.website) parts.push(`web:${b.website}`);
  const conf = b.confidence >= 90 ? '' : ` | conf:${b.confidence}`;
  const claimed = b.claimed ? ' | owner_verified' : '';
  return `  ${parts.join(' · ')}${conf}${claimed}`;
}

// ── TOOL IMPLEMENTATIONS ──────────────────────────────────────────────────────

/**
 * local_intel_context
 * Returns a full spatial context block for a zip code or lat/lon.
 * This is the primary tool — gives an agent everything it needs in one call.
 */
function toolContext({ zip, lat, lon, radius_miles = 1.0 }) {
  const businesses = loadBusinesses();
  const zones = loadZones();

  // Resolve center point
  let centerLat, centerLon, label;
  if (lat && lon) {
    centerLat = parseFloat(lat);
    centerLon = parseFloat(lon);
    // Find nearest zip
    const nearestZip = Object.entries(ZIP_CENTERS)
      .sort((a, b) => distanceMiles(centerLat, centerLon, a[1].lat, a[1].lon) -
                      distanceMiles(centerLat, centerLon, b[1].lat, b[1].lon))[0];
    zip = nearestZip[0];
    label = nearestZip[1].label;
  } else if (zip && ZIP_CENTERS[zip]) {
    centerLat = ZIP_CENTERS[zip].lat;
    centerLon = ZIP_CENTERS[zip].lon;
    label = ZIP_CENTERS[zip].label;
  } else {
    return { error: `ZIP ${zip} not in covered dataset. Covered: ${Object.keys(ZIP_CENTERS).join(', ')}` };
  }

  // Find anchor (highest confidence business near center)
  const zoneBusinesses = businesses.filter(b => b.zip === zip && b.lat && b.lon);
  const anchor = zoneBusinesses
    .filter(b => b.claimed || b.confidence >= 90)
    .sort((a, b) => b.confidence - a.confidence)[0] ||
    zoneBusinesses.sort((a, b) => b.confidence - a.confidence)[0];

  // Bucket by distance rings
  const rings = [0.25, 0.5, 1.0, radius_miles];
  const ringLabels = ['0.25mi', '0.5mi', '1.0mi', `${radius_miles}mi`];
  const bucketed = {};
  rings.forEach(r => bucketed[r] = []);

  for (const b of zoneBusinesses) {
    if (b === anchor) continue;
    const d = distanceMiles(centerLat, centerLon, b.lat, b.lon);
    if (d > radius_miles) continue;
    const ring = rings.find(r => d <= r);
    if (ring) bucketed[ring].push({ ...b, _dist: d });
  }

  // Zone data
  const zoneData = zones.zones?.[zip] || {};

  // Build context block
  const lines = [];
  lines.push(`LOCATION CONTEXT: ${zip} · ${label}, FL`);
  lines.push(`CENTER: ${centerLat}, ${centerLon}`);
  lines.push('');

  if (anchor) {
    lines.push(`ANCHOR: ${anchor.name} [${anchor.category}] ${anchor.address || ''}`);
    lines.push(`  → ${distanceMiles(centerLat, centerLon, anchor.lat, anchor.lon).toFixed(2)}mi from center | confidence:${anchor.confidence}${anchor.claimed ? ' | owner_verified' : ''}`);
    lines.push('');
  }

  let prevMax = 0;
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    const bucket = bucketed[r];
    if (!bucket.length) continue;
    const sorted = bucket.sort((a, b) => a._dist - b._dist);
    const label2 = prevMax === 0 ? `WITHIN ${ringLabels[i]}` : `${ringLabels[prevMax > 0 ? i-1 : i]}–${ringLabels[i]}`;
    lines.push(`${label2} (${bucket.length} businesses):`);
    for (const b of sorted.slice(0, 8)) {
      lines.push(fmtBusiness(b, centerLat, centerLon));
    }
    if (sorted.length > 8) lines.push(`  ... +${sorted.length - 8} more`);
    lines.push('');
    prevMax = i;
  }

  // Zone intelligence
  if (Object.keys(zoneData).length) {
    lines.push('ZONE INTELLIGENCE:');
    if (zoneData.population)       lines.push(`  Pop: ${zoneData.population.toLocaleString()}`);
    if (zoneData.median_income)    lines.push(`  Med Income: $${zoneData.median_income.toLocaleString()}`);
    if (zoneData.median_home_value) lines.push(`  Home Value: $${zoneData.median_home_value.toLocaleString()}`);
    if (zoneData.ownership_rate)   lines.push(`  Ownership: ${zoneData.ownership_rate}%`);
    if (zoneData.zone_score)       lines.push(`  Zone Score: ${zoneData.zone_score} ${zoneData.zone_label || ''}`);
    if (zoneData.dominant_spend)   lines.push(`  Dominant spend: ${zoneData.dominant_spend}`);
    lines.push('');
  }

  // Category summary
  const catCounts = {};
  for (const b of zoneBusinesses) {
    const g = getGroup(b.category);
    catCounts[g] = (catCounts[g] || 0) + 1;
  }
  lines.push('CATEGORY BREAKDOWN:');
  for (const [g, count] of Object.entries(catCounts).sort((a,b) => b[1]-a[1])) {
    lines.push(`  ${g}: ${count}`);
  }
  lines.push('');
  lines.push(`DATASET: ${zoneBusinesses.length} businesses indexed | sources: OSM, owner_verified | last_sync: 2026-04-20`);

  return {
    zip,
    label,
    center: { lat: centerLat, lon: centerLon },
    total_businesses: zoneBusinesses.length,
    context_block: lines.join('\n'),
    data_freshness: zipFreshnessBlock(zoneBusinesses),
  };
}

/**
 * local_intel_search
 * Search businesses by name, category, or group within a zip.
 */
// ── Query normalizer — handles plurals, aliases, common shorthand ─────────────
const QUERY_ALIASES = {
  // Food
  'restaurants': 'restaurant', 'dining': 'restaurant', 'food': 'restaurant',
  'eats': 'restaurant', 'eateries': 'restaurant', 'eatery': 'restaurant',
  'cafes': 'cafe', 'coffee': 'cafe', 'coffee shop': 'cafe', 'coffee shops': 'cafe',
  'bars': 'bar', 'pubs': 'bar', 'pub': 'bar',
  'fast food': 'fast_food', 'fastfood': 'fast_food',
  'pizza': 'restaurant', 'sushi': 'restaurant', 'tacos': 'restaurant',
  // Health
  'dentists': 'dentist', 'doctors': 'clinic', 'doctor': 'clinic',
  'clinics': 'clinic', 'medical': 'clinic', 'vet': 'veterinary', 'vets': 'veterinary',
  'gym': 'fitness_centre', 'gyms': 'fitness_centre', 'fitness': 'fitness_centre',
  // Retail
  'grocery': 'supermarket', 'groceries': 'supermarket', 'supermarkets': 'supermarket',
  'convenience stores': 'convenience', 'gas': 'fuel', 'gas station': 'fuel', 'gas stations': 'fuel',
  'pharmacy': 'chemist', 'pharmacies': 'chemist', 'drug store': 'chemist',
  'salons': 'hairdresser', 'salon': 'hairdresser', 'hair': 'hairdresser',
  'beauty': 'hairdresser', 'nail': 'hairdresser',
  // Finance / Services
  'banks': 'bank', 'atms': 'atm',
  'realtors': 'estate_agent', 'realtor': 'estate_agent', 'real estate': 'estate_agent',
  'real estate agents': 'estate_agent', 'real estate agent': 'estate_agent',
  'mortgage': 'finance', 'mortgage lenders': 'finance', 'lenders': 'finance',
  'lawyers': 'legal', 'attorney': 'legal', 'attorneys': 'legal',
  'hotels': 'hotel', 'motels': 'hotel',
  // Home services
  'plumber': 'plumber', 'plumbers': 'plumber',
  'electrician': 'electrician', 'electricians': 'electrician',
  'landscaper': 'landscaping', 'landscapers': 'landscaping', 'lawn care': 'landscaping',
  'mover': 'moving', 'movers': 'moving', 'moving company': 'moving', 'moving companies': 'moving',
  'storage': 'storage', 'storage units': 'storage', 'self storage': 'storage',
  'home inspector': 'inspector', 'home inspectors': 'inspector', 'inspector': 'inspector',
  'pool': 'swimming_pool', 'pool company': 'swimming_pool', 'pool companies': 'swimming_pool',
  'roofer': 'roofing', 'roofers': 'roofing', 'roofing': 'roofing',
  // Health & wellness
  'chiropractor': 'chiropractor', 'chiropractors': 'chiropractor', 'chiro': 'chiropractor',
  'yoga': 'yoga', 'yoga studio': 'yoga', 'yoga studios': 'yoga',
  'massage': 'massage_therapist', 'massage therapy': 'massage_therapist', 'massage therapist': 'massage_therapist',
  'pediatrician': 'clinic', 'pediatricians': 'clinic', 'kids doctor': 'clinic', 'childrens doctor': 'clinic',
  'urgent care': 'clinic', 'walk in clinic': 'clinic', 'walk-in': 'clinic',
  // Family
  'daycare': 'childcare', 'daycares': 'childcare', 'day care': 'childcare',
  'preschool': 'childcare', 'preschools': 'childcare',
  'childcare': 'childcare',
  // Pets
  'dog grooming': 'pet_grooming', 'grooming': 'pet_grooming', 'pet groomer': 'pet_grooming',
  'dog groomer': 'pet_grooming',
  // Auto
  'car wash': 'car_wash', 'car washes': 'car_wash', 'auto wash': 'car_wash',
};

function normalizeQuery(raw) {
  const q = raw.toLowerCase().trim();
  // Direct alias match
  if (QUERY_ALIASES[q]) return QUERY_ALIASES[q];
  // Strip trailing 's' for simple plurals (restaurants→restaurant, dentists→dentist)
  if (q.endsWith('s') && q.length > 4 && QUERY_ALIASES[q.slice(0, -1)] === undefined) {
    const singular = q.slice(0, -1);
    if (QUERY_ALIASES[singular]) return QUERY_ALIASES[singular];
    return singular; // return de-pluralized for substring matching
  }
  return q;
}

// City-name → ZIP resolution (backend mirror of frontend parseQuery)
const CITY_TO_ZIP = {
  'nocatee': '32081',
  'ponte vedra': '32082', 'ponte vedra beach': '32082', 'pvb': '32082',
  'st johns': '32092', 'saint johns': '32092',
  'st augustine': '32084', 'saint augustine': '32084',
  'st augustine beach': '32080', 'saint augustine beach': '32080',
  'palm valley': '32082',
  'jacksonville': '32202',
  'jax': '32202',
};

function resolveZip(query) {
  if (!query) return null;
  const q = query.toLowerCase().trim();
  // Strip "in <city>" or "near <city>" patterns
  const m = q.match(/(?:in|near|at)\s+([a-z\s.]+?)(?:\s*$|\s+\d)/);
  if (!m) return null;
  const city = m[1].trim().replace(/\.$/, '');
  return CITY_TO_ZIP[city] || null;
}

function extractZipFromQuery(query) {
  if (!query) return null;
  const m = query.match(/\b(\d{5})\b/);
  return m ? m[1] : null;
}

function toolSearch({ zip, query, category, group, limit = 20 }) {
  let results = loadBusinesses();
  // Resolve ZIP: explicit param > numeric in query string > city name in query
  const resolvedZip = zip || extractZipFromQuery(query) || resolveZip(query);
  if (resolvedZip) results = results.filter(b => b.zip === resolvedZip);
  if (category) results = results.filter(b => b.category === category);
  if (group)    results = results.filter(b => getGroup(b.category) === group);
  if (query) {
    // Strip ZIP and city/location phrase before tokenizing so they don't score against addresses
    const strippedQuery = query
      .replace(/\b\d{5}\b/g, '')                       // remove ZIP digits
      .replace(/(?:in|near|at)\s+[a-z\s.]+$/i, '')    // remove "in ponte vedra" etc
      .trim();
    const raw   = (strippedQuery || query).toLowerCase().trim();
    const q     = normalizeQuery(raw);  // alias + de-plural
    const STOP  = new Set(['for','the','and','near','in','at','of','a','an','show','me','find','get','list','all','any','some','what','where','who','how','is','are','there','best','top','good','great','closest','nearby','around','here','places','spots','shops','open','now','today','local','services','service','things','stuff','options']);
    // Generate word variants: original + de-pluraled + alias-resolved
    const wordVariants = (w) => {
      const variants = new Set([w]);
      if (QUERY_ALIASES[w]) variants.add(QUERY_ALIASES[w]);
      if (w.length >= 5 && w.endsWith('s')) variants.add(w.slice(0, -1));
      if (w.length >= 6 && w.endsWith('es')) variants.add(w.slice(0, -2));
      return [...variants];
    };
    const words = raw.split(/\s+/)
      .filter(w => w.length > 2 && !STOP.has(w))
      .flatMap(wordVariants);

    // Score each business — normalized query + word-level fuzzy
    const scored = results.map(b => {
      const name = (b.name     || '').toLowerCase();
      const cat  = (b.category || '').toLowerCase();
      const addr = (b.address  || '').toLowerCase();
      const grp  = getGroup(b.category).toLowerCase();
      let score  = 0;

      // Exact normalized match
      if (name.includes(q))    score += 100;
      if (cat  === q)          score += 90;   // exact category hit
      if (cat.includes(q))     score += 70;
      if (grp  === q)          score += 50;   // group-level match ("food", "health")
      if (addr.includes(q))    score += 30;

      // Also check against original raw query
      if (raw !== q) {
        if (name.includes(raw)) score += 80;
        if (cat.includes(raw))  score += 60;
      }

      // Word-level overlap
      for (const w of words) {
        if (name.includes(w))  score += 20;
        if (cat.includes(w))   score += 15;
        if (grp.includes(w))   score += 10;
        if (addr.includes(w))  score += 5;
      }

      return { b, score };
    }).filter(({ score }) => score > 0);

    results = scored.sort((a, z) => z.score - a.score).map(({ b }) => b);
  }
  if (!query) results.sort((a, b) => b.confidence - a.confidence);
  const total = results.length;
  results = results.slice(0, Math.min(limit, 50));

  return {
    total,
    returned: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      group: getGroup(b.category),
      zip: b.zip,
      address: b.address || '',
      lat: b.lat,
      lon: b.lon,
      phone: b.phone || '',
      website: b.website || '',
      hours: b.hours || '',
      confidence: b.confidence,
      claimed: b.claimed || false,
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: results.map(b => fmtBusiness(b)).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_nearby
 * Returns businesses within radius_miles of a lat/lon, sorted by distance.
 * Core tool for "what's near X" agent queries.
 */
function toolNearby({ lat, lon, radius_miles = 0.5, category, group, limit = 15 }) {
  if (!lat || !lon) return { error: 'lat and lon required' };
  const refLat = parseFloat(lat);
  const refLon = parseFloat(lon);

  let results = loadBusinesses().filter(b => b.lat && b.lon);
  if (category) results = results.filter(b => b.category === category);
  if (group)    results = results.filter(b => getGroup(b.category) === group);

  results = results
    .map(b => ({ ...b, _dist: distanceMiles(refLat, refLon, b.lat, b.lon) }))
    .filter(b => b._dist <= parseFloat(radius_miles))
    .sort((a, b) => a._dist - b._dist)
    .slice(0, Math.min(limit, 50));

  return {
    center: { lat: refLat, lon: refLon },
    radius_miles,
    total: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      group: getGroup(b.category),
      address: b.address || '',
      lat: b.lat,
      lon: b.lon,
      distance_miles: parseFloat(b._dist.toFixed(3)),
      bearing: bearing(refLat, refLon, b.lat, b.lon),
      phone: b.phone || '',
      hours: b.hours || '',
      confidence: b.confidence,
      claimed: b.claimed || false,
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: results.map(b => fmtBusiness(b, refLat, refLon)).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_zone
 * Returns spending zone + demographic intelligence for a zip.
 */
function toolZone({ zip }) {
  const zones = loadZones();
  const zoneData = zones.zones?.[zip];
  if (!zoneData) {
    return { error: `No zone data for ${zip}. Covered: ${Object.keys(zones.zones || {}).join(', ')}` };
  }
  const center = ZIP_CENTERS[zip];
  const lines = [
    `ZONE: ${zip} · ${center?.label || zip}, FL`,
    `Population: ${(zoneData.population || 0).toLocaleString()}`,
    `Median Household Income: $${(zoneData.median_income || 0).toLocaleString()}`,
    `Median Home Value: $${(zoneData.median_home_value || 0).toLocaleString()}`,
    `Median Rent: $${(zoneData.median_rent || 0).toLocaleString()}/mo`,
    `Homeownership Rate: ${zoneData.ownership_rate || 0}%`,
    `Zone Score: ${zoneData.zone_score || 'N/A'} · ${zoneData.zone_label || ''}`,
    `Dominant Spending: ${zoneData.dominant_spend || 'N/A'}`,
    `County Establishments: ${(zoneData.county_establishments || 0).toLocaleString()}`,
    `County Employees: ${(zoneData.county_employees || 0).toLocaleString()}`,
    `County Payroll: $${zoneData.county_payroll_millions || 0}M`,
  ];
  return { zip, ...zoneData, context_block: lines.join('\n') };
}

/**
 * local_intel_corridor
 * Returns businesses along a named street corridor.
 * Useful for "what's on A1A" type queries.
 */
function toolCorridor({ street, zip, limit = 20 }) {
  if (!street) return { error: 'street name required' };
  const results = loadBusinesses()
    .filter(b => {
      if (zip && b.zip !== zip) return false;
      return (b.address || '').toLowerCase().includes(street.toLowerCase());
    })
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, Math.min(limit, 50));

  return {
    corridor: street,
    zip: zip || 'all',
    total: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      address: b.address || '',
      lat: b.lat,
      lon: b.lon,
      phone: b.phone || '',
      hours: b.hours || '',
      confidence: b.confidence,
      claimed: b.claimed || false,
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: `CORRIDOR: ${street}${zip ? ` (${zip})` : ''}\n` +
      results.map(b => fmtBusiness(b)).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_changes
 * Returns recently added or owner-verified listings.
 * Agents use this to detect new businesses opening.
 */
function toolChanges({ zip, limit = 20 }) {
  let results = loadBusinesses()
    .filter(b => b.addedAt || b.claimed || (b.sources || []).includes('owner_verified'));
  if (zip) results = results.filter(b => b.zip === zip);
  results.sort((a, b) => {
    const da = a.addedAt ? new Date(a.addedAt) : new Date(0);
    const db = b.addedAt ? new Date(b.addedAt) : new Date(0);
    if (b.claimed && !a.claimed) return 1;
    if (a.claimed && !b.claimed) return -1;
    return db - da;
  });
  results = results.slice(0, Math.min(limit, 50));

  return {
    total: results.length,
    results: results.map(b => ({
      name: b.name,
      category: b.category,
      zip: b.zip,
      address: b.address || '',
      addedAt: b.addedAt || null,
      claimed: b.claimed || false,
      confidence: b.confidence,
      sources: b.sources || [],
      possibly_closed: b.possibly_closed || false,
      staleness: stalenessBlock(b),
    })),
    context_block: `RECENT CHANGES / VERIFIED LISTINGS:\n` +
      results.map(b =>
        `  ${b.name} [${b.category}] ${b.zip}${b.addedAt ? ` · added:${b.addedAt.slice(0,10)}` : ''}${b.claimed ? ' · owner_verified' : ''}`
      ).join('\n'),
    data_freshness: zipFreshnessBlock(results),
  };
}

/**
 * local_intel_stats
 * Dataset coverage summary — useful for agents evaluating data quality.
 */
function toolStats() {
  const data = loadBusinesses();
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch { return []; } })();
  const byZip = {}, byGroup = {};
  let ownerVerified = 0, totalConf = 0;

  for (const b of data) {
    byZip[b.zip] = (byZip[b.zip] || 0) + 1;
    byGroup[getGroup(b.category)] = (byGroup[getGroup(b.category)] || 0) + 1;
    if (b.claimed) ownerVerified++;
    totalConf += b.confidence || 0;
  }

  const totalQueries = ledger.length;
  const totalRevenue = ledger.reduce((s, e) => s + (e.cost || 0), 0);

  const freshness = zipFreshnessBlock(data);
  return {
    total_businesses: data.length,
    owner_verified: ownerVerified,
    avg_confidence: data.length ? Math.round(totalConf / data.length) : 0,
    covered_zips: Object.keys(ZIP_CENTERS),
    by_zip: byZip,
    by_group: byGroup,
    total_queries: totalQueries,
    total_revenue_pathusd: parseFloat(totalRevenue.toFixed(4)),
    sources: ['OSM', 'Census ACS 2022', 'owner_verified'],
    data_freshness: freshness,
    context_block: [
      `LOCALINTEL DATASET STATS`,
      `Businesses: ${data.length} | Owner-verified: ${ownerVerified} | Avg confidence: ${data.length ? Math.round(totalConf/data.length) : 0}`,
      `Freshness grade: ${freshness.grade} | FRESH:${freshness.tier_distribution.FRESH||0} WARM:${freshness.tier_distribution.WARM||0} STALE:${freshness.tier_distribution.STALE||0} COLD:${freshness.tier_distribution.COLD||0}`,
      `Possibly closed flags: ${freshness.possibly_closed_count}`,
      `Zips: ${Object.entries(byZip).map(([z,c]) => `${z}:${c}`).join(', ')}`,
      `Categories: ${Object.entries(byGroup).map(([g,c]) => `${g}:${c}`).join(', ')}`,
      `Total queries served: ${totalQueries} | Revenue: $${totalRevenue.toFixed(4)} pathUSD`,
      `Sources: OSM · Census ACS 2022 · owner_verified`,
    ].join('\n'),
  };
}

// ── MCP tool registry ─────────────────────────────────────────────────────────
const TOOLS = {
  local_intel_context:   { fn: toolContext,    desc: 'Full spatial context block for a zip or lat/lon. Best first call for any location query.' },
  local_intel_search:    { fn: toolSearch,     desc: 'Search businesses by name, category, or group.' },
  local_intel_nearby:    { fn: toolNearby,     desc: 'Businesses within radius_miles of a lat/lon point, sorted by distance.' },
  local_intel_zone:      { fn: toolZone,       desc: 'Spending zone, demographic, and economic data for a zip code.' },
  local_intel_corridor:  { fn: toolCorridor,   desc: 'Businesses along a named street corridor (e.g. A1A, Palm Valley Rd).' },
  local_intel_changes:   { fn: toolChanges,    desc: 'Recently added or owner-verified business listings.' },
  local_intel_stats:     { fn: toolStats,      desc: 'Dataset coverage stats and usage metrics.' },
  // ── Tidal layer tools (Layer 0-3 intelligence) ──
  local_intel_tide:      { fn: handleTide,     desc: 'Tidal reading for a ZIP — temperature, direction, seasonal context. Combines all 4 data layers.' },
  local_intel_signal:    { fn: handleSignal,   desc: 'Investment + activity signal for a ZIP — composite score from bedrock through wave surface.' },
  local_intel_bedrock:   { fn: handleBedrock,  desc: 'Infrastructure momentum — permits, road projects, flood zones. Leading indicator (12-36mo ahead).' },
  local_intel_for_agent: { fn: handleForAgent, desc: 'Premium composite entry point. Declare agent_type + intent, get pre-ranked signals for your use case.' },
  local_intel_oracle:    { fn: handleOracle,   desc: 'Pre-baked economic narrative for a ZIP: restaurant saturation, price-tier gaps, growth trajectory, and the 3 questions you should be asking with answers.' },
  local_intel_sector_gap: { fn: handleSectorGap, desc: 'Ranked sector gap opportunities for a ZIP — NAICS sectors present at county but absent at ZIP. Returns demand estimates, demographic framing, and confidence tier. LLM-ready signal narrative per gap. Cross-references ZBP 2018 + CBP 2023 + ACS demographics.' },
  // ── Vertical agents (trained on 100 industry prompts each) ─────────────────────────
  local_intel_realtor:      { fn: (p) => handleVerticalQuery('realtor',      p.query, p.zip), desc: 'Real estate intelligence for a ZIP: demographics, commercial gaps, flood risk, infrastructure, market signals. Trained for buyer briefs and investment analysis.' },
  local_intel_healthcare:   { fn: (p) => handleVerticalQuery('healthcare',   p.query, p.zip), desc: 'Healthcare market intelligence: provider density, demographics, patient demand gaps, senior population signals.' },
  local_intel_retail:       { fn: (p) => handleVerticalQuery('retail',       p.query, p.zip), desc: 'Retail market intelligence: store categories, spending capture, consumer profile, undersupplied niches.' },
  local_intel_construction: { fn: (p) => handleVerticalQuery('construction', p.query, p.zip), desc: 'Construction and home services intelligence: active permits, contractor density, population growth driving demand.' },
  local_intel_restaurant:   { fn: (p) => handleVerticalQuery('restaurant',   p.query, p.zip), desc: 'Restaurant market intelligence: saturation scores, price-tier gaps, capture rate, corridor analysis, tidal momentum.' },
  local_intel_ask:          { fn: handleAsk, desc: 'Composite NL query layer — ask any plain-English question about a ZIP and get a synthesized, sourced answer. Routes internally to zone, oracle, search, bedrock, signal, tide, corridor, changes, and nearby tools. Single entry point for humans and LLMs.' },
  local_intel_query:        { fn: handleQuery, desc: 'Fuzzy intent router — pass any plain-English question about any local market. Automatically detects ZIP, industry vertical, and best tool. Checks inference cache first (instant return if hit). On cache miss, routes to the correct vertical agent, stores result, and dispatches a scout agent if confidence is low. Handles region queries ("Northeast Florida", "St Johns County") by evaluating top ZIPs in parallel. Best first call for any LLM that does not know the ZIP or industry in advance.' },
};

// ── MCP manifest (tools/list response) ───────────────────────────────────────
const MCP_MANIFEST = {
  name: 'localintel',
  version: '1.0.0',
  description: 'LocalIntel — agentic business intelligence for Northeast Florida. 20 tools: spatial context, business search, spending zones, corridor analysis, tidal momentum scores, sector gap ranking, vertical agents (restaurant/healthcare/retail/construction/realtor), inference cache with scout dispatch, and local_intel_query — a fuzzy intent router that resolves any plain-English market question to the right ZIP, vertical, and tool automatically. 500+ trained prompts across 27 ZIPs. Two payment rails: $0.01–$0.05/call USDC on Base via x402, or pathUSD on Tempo mainnet.',
  tools: [
    {
      name: 'local_intel_query',
      description: 'START HERE. Natural language entry point — send any plain-English question about any Florida market and get a structured answer. Auto-detects ZIP, industry vertical, and routes to the right tool. No tool knowledge required. Examples: "Is 32082 oversaturated with dentists?", "Where should I open a clinic in Northeast Florida?", "What food gaps exist in Nocatee?" Trained on 500+ real market queries across restaurant, healthcare, retail, construction, and real estate verticals.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Any plain-English market question. ZIP can be in the query or passed separately.' },
          zip:   { type: 'string', description: 'Optional ZIP override. If omitted, ZIP is detected from the query.' },
        },
        required: ['query'],
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_context',
      description: 'Full spatial context block for a zip or lat/lon. Returns anchor business, nearby businesses in distance rings, zone intelligence, and category breakdown. Best first call for any location query.',
      inputSchema: {
        type: 'object',
        properties: {
          zip:          { type: 'string', description: 'ZIP code (32081 or 32082)' },
          lat:          { type: 'number', description: 'Latitude (alternative to zip)' },
          lon:          { type: 'number', description: 'Longitude (alternative to zip)' },
          radius_miles: { type: 'number', description: 'Search radius in miles (default 1.0)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_search',
      description: 'Search businesses by name, category, or semantic group (food, retail, health, finance, civic, services).',
      inputSchema: {
        type: 'object',
        properties: {
          zip:      { type: 'string', description: 'Filter by ZIP code' },
          query:    { type: 'string', description: 'Text search on name/category/address' },
          category: { type: 'string', description: 'Exact OSM category (restaurant, bank, dentist...)' },
          group:    { type: 'string', description: 'Semantic group: food | retail | health | finance | civic | services' },
          limit:    { type: 'integer', description: 'Max results (default 20, max 50)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_nearby',
      description: 'Find businesses within a radius of any lat/lon point, sorted by distance with compass bearing.',
      inputSchema: {
        type: 'object',
        required: ['lat', 'lon'],
        properties: {
          lat:          { type: 'number', description: 'Latitude of center point' },
          lon:          { type: 'number', description: 'Longitude of center point' },
          radius_miles: { type: 'number', description: 'Search radius in miles (default 0.5)' },
          category:     { type: 'string', description: 'Filter by OSM category' },
          group:        { type: 'string', description: 'Filter by semantic group' },
          limit:        { type: 'integer', description: 'Max results (default 15)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_zone',
      description: 'Spending zone and demographic data for a ZIP code: population, income, home value, rent, ownership rate, zone score.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip: { type: 'string', description: 'ZIP code (32081 or 32082)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_corridor',
      description: 'Businesses along a named street corridor. Use for queries like "what is on A1A" or "businesses on Palm Valley Road".',
      inputSchema: {
        type: 'object',
        required: ['street'],
        properties: {
          street: { type: 'string', description: 'Street name (e.g. "A1A", "Palm Valley", "Crosswater")' },
          zip:    { type: 'string', description: 'Optional ZIP filter' },
          limit:  { type: 'integer', description: 'Max results (default 20)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_changes',
      description: 'Recently added or owner-verified business listings. Use to detect new openings or data updates.',
      inputSchema: {
        type: 'object',
        properties: {
          zip:   { type: 'string', description: 'Optional ZIP filter' },
          limit: { type: 'integer', description: 'Max results (default 20)' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_stats',
      description: 'Dataset coverage stats: total businesses, confidence scores, query volume, revenue earned.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_tide',
      description: 'Tidal reading for a ZIP — temperature (0-100), direction (surging/heating/stable/cooling/receding), seasonal context. Synthesizes all 4 data layers. Best for agents deciding WHERE to act next.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip:            { type: 'string', description: 'ZIP code to read tidal state for' },
          include_layers: { type: 'array',  description: 'Layers to include: bedrock, ocean_floor, surface_current, wave_surface (default: all)' },
          query_context:  { type: 'object', description: 'Optional: { agent_type, agent_id, purpose }' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_signal',
      description: 'Investment and activity signal for a ZIP. Composite score 0-100 with band (strong_buy/accumulate/hold/reduce/avoid), top reasons, and avoid flags. Best for real estate and financial agents.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip:           { type: 'string', description: 'ZIP code' },
          agent_type:    { type: 'string', description: 'real_estate | financial | ad_placement | logistics | business_owner | civic' },
          query_context: { type: 'object', description: 'Optional: { agent_id, purpose }' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_bedrock',
      description: 'Infrastructure momentum score and active leading indicators for a ZIP from Layer 0. Permits, road projects, flood zones, utility extensions. Predicts conditions 12-36 months ahead. \'Let Google pay for the satellites — we sell the weather forecast.\'',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip:           { type: 'string', description: 'ZIP code' },
          query_context: { type: 'object', description: 'Optional: { agent_type, agent_id }' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_for_agent',
      description: 'PREMIUM composite entry point ($0.05). Declare your agent_type and intent, receive pre-ranked top-10 signals assembled from all 4 data layers, personalized for your use case. Includes delta since your last query if agent_id provided. Best first call for any new agent.',
      inputSchema: {
        type: 'object',
        properties: {
          agent_type: { type: 'string', description: 'real_estate | financial | ad_placement | logistics | business_owner | civic' },
          intent:     { type: 'string', description: 'Plain-language description of what you are trying to decide or do' },
          zip:        { type: 'string', description: 'Target ZIP code' },
          lat:        { type: 'number', description: 'Latitude (if no ZIP)' },
          lon:        { type: 'number', description: 'Longitude (if no ZIP)' },
          budget:     { type: 'number', description: 'Agent budget in pathUSD (optional, for signal prioritization)' },
          depth:      { type: 'string', description: 'quick (top 5 signals) | full (top 10 + context blocks)' },
          agent_id:   { type: 'string', description: 'Your agent UUID for memory + delta computation' },
        },
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_oracle',
      description: 'Pre-baked economic oracle for a ZIP. Returns: restaurant saturation (is there room for another?), price-tier gap analysis (what menu price is missing?), growth trajectory (growing/empty-nest/stable), and 3 pre-formed questions with answers baked in. No LLM needed — answers derived from population, income, business density, school count, and infrastructure signals.',
      inputSchema: {
        type: 'object',
        properties: {
          zip: { type: 'string', description: 'ZIP code to analyze (e.g. 32081)' },
        },
        required: ['zip'],
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_sector_gap',
      description: 'Ranked sector gap analysis for a ZIP. Identifies NAICS sectors present at county level but absent at ZIP \u2014 the structural whitespace in a local economy. Returns ranked opportunities with: NAICS code, sector label, county employment share, demand estimate, confidence tier, and LLM-ready signal narrative. Backed by ZBP 2018 (ZIP-level establishment counts), CBP 2023 (county-level sector health), and ACS 5-yr 2023 demographics. Example output: \"NAICS 61 Educational Services: 0 establishments in 32259 vs 47 in St. Johns County. 69,866 residents, $144k median HHI, 89% owner-occupied. Estimated demand: 8\u201312 tutoring/enrichment centers. Confidence: ESTIMATED. Signal: Strong family formation market with no educational services presence.\" Use oracle_vertical field to chain into matching vertical agents. Cost: $0.03 pathUSD. Free discovery feed at /api/sector-gap/feed.',
      inputSchema: {
        type: 'object',
        required: ['zip'],
        properties: {
          zip: { type: 'string', description: 'ZIP code to analyze (e.g. 32081, 32082, 32259)' },
        },
      },
      annotations: { readOnly: true },
    },
    // ── Vertical agents ───────────────────────────────────────────
    {
      name: 'local_intel_realtor',
      description: 'Real estate intelligence for a ZIP. Ask natural-language questions: demographics, commercial gaps, flood risk, school proximity, infrastructure signals, market saturation. Returns structured data with confidence score. Trained on 100 realtor use-case prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question (e.g. "What is the flood risk for this ZIP?", "What commercial gaps exist?")' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_healthcare',
      description: 'Healthcare market intelligence for a ZIP. Ask about provider density, patient demographics, demand gaps, senior population. Returns structured data with confidence score. Trained on 100 healthcare business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about healthcare market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_retail',
      description: 'Retail market intelligence for a ZIP. Ask about store categories, spending capture rates, consumer profile, undersupplied niches. Returns structured data with confidence score. Trained on 100 retail business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about retail market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_construction',
      description: 'Construction and home services market intelligence for a ZIP. Ask about contractor density, active permits, housing starts, population growth driving demand. Returns structured data with confidence score. Trained on 100 construction business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about construction market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_restaurant',
      description: 'Restaurant and food service market intelligence for a ZIP. Ask about saturation scores, price-tier gaps, capture rates, corridor analysis, tidal momentum. Returns structured data with confidence score. Trained on 100 restaurant business prompts.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'Natural language question about restaurant market' }, zip: { type: 'string', description: 'ZIP code to analyze' } }, required: ['query', 'zip'] },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_ask',
      description: 'Composite NL query layer. Ask any plain-English question about a ZIP — demographics, market opportunity, restaurant gaps, retail saturation, construction activity, investment signals, healthcare, corridor analysis, recent changes, nearby businesses. Routes internally to the right tools and returns a synthesized, sourced answer with confidence score. Best single entry point for humans and LLMs.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Plain English question, e.g. "What restaurant categories are missing in 32082?"' },
          zip: { type: 'string', description: 'ZIP code (optional — will be extracted from question if present, defaults to 32082)' },
        },
        required: ['question'],
      },
      annotations: { readOnly: true },
    },
    {
      name: 'local_intel_query',
      description: '[DUPLICATE — see position 1 in tools list. This entry retained for backward compatibility.]',
      deprecated: true,
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Any plain-English question about a local market, e.g. "where should I open a clinic in Northeast Florida" or "what food gaps exist in Nocatee"' },
          zip:   { type: 'string', description: 'Optional ZIP code override. If omitted, ZIP is detected from the query or derived from region signals.' },
        },
        required: ['query'],
      },
      annotations: { readOnly: true },
    },
  ],
};

// ── JSON-RPC 2.0 handler ──────────────────────────────────────────────────────
async function handleRPC(req) {
  const { jsonrpc, id, method, params } = req;

  if (jsonrpc !== '2.0') {
    return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC version' } };
  }

  // MCP handshake
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: MCP_MANIFEST.name, version: MCP_MANIFEST.version },
        instructions: 'LocalIntel gives you autonomous business intelligence for any Florida ZIP code. Start with local_intel_ask for any plain-English question — it routes internally to the right tools automatically. Use local_intel_oracle for pre-baked economic narratives (restaurant saturation, price-tier gaps, growth trajectory). Use local_intel_signal for investment signals (0-100 score with buy/hold/avoid band). Use local_intel_tide for tidal momentum scores synthesizing all 4 data layers. Use local_intel_sector_gap to find structural whitespace (NAICS sectors present at county level but absent at ZIP). Vertical agents (local_intel_restaurant, local_intel_healthcare, local_intel_retail, local_intel_construction, local_intel_realtor) answer domain-specific natural-language questions. All tools are read-only. Pass your agent ID in the x-agent-id header for delta computation and billing.',
      },
    };
  }

  if (method === 'notifications/initialized') return null; // no response needed

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_MANIFEST.tools } };
  }
  if (method === 'prompts/list') {
    return {
      jsonrpc: '2.0', id,
      result: {
        prompts: [
          { name: 'fb_001_is_32082_oversaturated_with_casual', description: '[Restaurant] Is 32082 oversaturated with casual dining restaurants?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_002_what_cuisine_types_are_missing', description: '[Restaurant] What cuisine types are missing from the 32082 restaurant market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_003_im_thinking_about_opening_a', description: '[Restaurant] I\'m thinking about opening a ramen shop in Ponte Vedra Beach — is there any demand for Japanese noodle concepts in 32082 and how many direct competitors are already there?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_004_show_me_the_restaurant_density', description: '[Restaurant] Show me the restaurant density per capita in 32082 versus the county average.', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_005_whats_the_breakfasttodinner_ratio_of', description: '[Restaurant] What\'s the breakfast-to-dinner ratio of restaurant concepts in 32082 — is there a gap at the morning daypart?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_006_how_many_alcohol_licenses_are', description: '[Restaurant] How many alcohol licenses are active in the 32082 ZIP code and what\'s the density relative to population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_007_i_want_to_open_a', description: '[Restaurant] I want to open a wine bar in Ponte Vedra Beach. What\'s the income profile and is the alcohol license environment favorable?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_008_are_food_trucks_underrepresented_in', description: '[Restaurant] Are food trucks underrepresented in 32082 compared to similar high-income coastal markets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_009_what_does_the_deliveryversusdinein_split', description: '[Restaurant] What does the delivery-versus-dine-in split look like in 32082 — is there demand for a ghost kitchen concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_010_im_a_franchise_operator_evaluating', description: '[Restaurant] I\'m a franchise operator evaluating whether to bring a fast-casual Mediterranean brand to 32082. What\'s the competitive density and who are the closest similar concepts?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_011_does_32082_have_enough_tourist', description: '[Restaurant] Does 32082 have enough tourist traffic to support a seasonal seafood shack concept, or is it too locally driven?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_012_whats_the_touristtolocal_ratio_during', description: '[Restaurant] What\'s the tourist-to-local ratio during peak season in 32082 and how does it affect restaurant capture rates?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_013_compare_the_restaurant_saturation_in', description: '[Restaurant] Compare the restaurant saturation in 32082 versus 32081 — which ZIP has more whitespace?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_014_im_a_commercial_realtor_representing', description: '[Restaurant] I\'m a commercial realtor representing a restaurant client — what are the highest-traffic food-and-beverage corridors in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_015_is_there_a_gap_for', description: '[Restaurant] Is there a gap for a high-end sushi restaurant in Ponte Vedra Beach at the $80-120/person price point?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_016_what_percent_of_32082_restaurants', description: '[Restaurant] What percent of 32082 restaurants are price tier 1 (fast food/QSR) versus tier 3 (fine dining)?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_017_how_has_the_number_of', description: '[Restaurant] How has the number of new restaurant openings in 32082 trended over the last 3 years?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_018_is_the_32082_market_oversaturated', description: '[Restaurant] Is the 32082 market oversaturated with pizza concepts specifically?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_019_whats_the_average_salespersquarefoot_ben', description: '[Restaurant] What\'s the average sales-per-square-foot benchmark for sit-down restaurants in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_020_im_evaluating_a_second_location', description: '[Restaurant] I\'m evaluating a second location for my St. Augustine breakfast cafe — is 32084 a better fit than 32082 for a diner-style concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_021_what_cuisine_gaps_exist_in', description: '[Restaurant] What cuisine gaps exist in 32084 near the historic district that a tourist-facing restaurant could fill?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_022_how_does_restaurant_density_in', description: '[Restaurant] How does restaurant density in 32084 compare to foot traffic — are there underserved corridors?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_023_is_32084_oversaturated_with_seafood', description: '[Restaurant] Is 32084 oversaturated with seafood restaurants given the tourist volume?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_024_whats_the_alcohol_license_density', description: '[Restaurant] What\'s the alcohol license density in 32084 and is there room for a craft cocktail bar?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_025_i_want_to_open_a', description: '[Restaurant] I want to open a food hall concept in St. Augustine — does 32084 have the foot traffic and demographic mix to support it?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_026_how_many_fastcasual_concepts_are', description: '[Restaurant] How many fast-casual concepts are operating in 32084 and what\'s the average ticket price?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_027_is_there_a_delivery_gap', description: '[Restaurant] Is there a delivery gap in 32084 — what percentage of restaurants offer third-party delivery?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_028_what_are_the_seasonal_demand', description: '[Restaurant] What are the seasonal demand peaks for restaurants in 32084 and how does that affect a year-round business model?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_029_im_a_subway_franchisee_looking', description: '[Restaurant] I\'m a Subway franchisee looking at 32084 — how many QSR sandwich concepts are already in that ZIP?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_030_are_there_underserved_dinner_daypart', description: '[Restaurant] Are there underserved dinner daypart opportunities in 32081 (Nocatee)?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_031_whats_the_restaurant_capture_rate', description: '[Restaurant] What\'s the restaurant capture rate in 32081 — what share of resident food spending stays local versus leaking to 32082 or Jacksonville?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_032_im_evaluating_opening_a_familyfriendly', description: '[Restaurant] I\'m evaluating opening a family-friendly chain restaurant in Nocatee — what\'s the demographic profile of 32081 and how does it compare to the brand\'s target customer?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_033_how_many_restaurants_per_1000', description: '[Restaurant] How many restaurants per 1,000 residents exist in 32081 versus the national average for suburban growth markets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_034_is_32081_nocatee_ready_for', description: '[Restaurant] Is 32081 (Nocatee) ready for a full-service sit-down steakhouse or is it still too QSR-dominant?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_035_whats_the_growth_rate_of', description: '[Restaurant] What\'s the growth rate of restaurant openings in 32081 year-over-year and is the market keeping pace with population growth?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_036_is_there_an_indian_food', description: '[Restaurant] Is there an Indian food gap in 32081? I see a large South Asian population in master-planned communities nearby.', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_037_what_does_the_breakfast_restaurant', description: '[Restaurant] What does the breakfast restaurant landscape look like in 32081 — is there room for an independent breakfast concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_038_how_strong_is_the_lunch', description: '[Restaurant] How strong is the lunch daypart in 32081 for a fast-casual concept targeting remote workers and families?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_039_im_a_food_truck_operator', description: '[Restaurant] I\'m a food truck operator — is there a permitted food truck park or regular market in 32081 I could anchor to?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_040_whats_the_tidal_momentum_for', description: '[Restaurant] What\'s the tidal momentum for restaurant openings in 32086 — is the market growing or contracting?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_041_is_32086_south_st_augustine', description: '[Restaurant] Is 32086 (south St. Augustine) underserved for dining relative to its population size?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_042_what_price_tier_performs_best', description: '[Restaurant] What price tier performs best in 32086 — value, mid-scale, or upscale?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_043_im_a_franchise_operator_considering', description: '[Restaurant] I\'m a franchise operator considering a Tropical Smoothie or similar fast-casual health brand in 32086 — what\'s the competitive density?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_044_are_there_any_major_anchor', description: '[Restaurant] Are there any major anchor tenants in 32086 retail corridors that drive restaurant foot traffic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_045_what_is_the_dinein_versus', description: '[Restaurant] What is the dine-in versus takeout split in 32086 and how does it compare to 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_046_is_there_demand_for_latenight', description: '[Restaurant] Is there demand for late-night dining in 32086 or does the market shut down early?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_047_how_does_the_income_profile', description: '[Restaurant] How does the income profile of 32086 compare to 32082 — and does that change the viable price tier for a new restaurant?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_048_whats_the_food_truck_density', description: '[Restaurant] What\'s the food truck density in 32086 and are there gaps in cuisine type?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_049_im_evaluating_whether_to_open', description: '[Restaurant] I\'m evaluating whether to open a second location of my BBQ restaurant — should I choose 32086 or 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_050_whats_the_restaurant_landscape_in', description: '[Restaurant] What\'s the restaurant landscape in 32092 (World Golf Village area) — is it dominated by chains or are there independent operators?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_051_is_32092_underserved_for_restaurants', description: '[Restaurant] Is 32092 underserved for restaurants relative to its rooftop count?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_052_what_cuisine_types_are_missing', description: '[Restaurant] What cuisine types are missing in 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_053_is_there_demand_for_a', description: '[Restaurant] Is there demand for a sports bar concept in 32092 given the golf and outdoor lifestyle demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_054_how_many_fullservice_restaurants_are', description: '[Restaurant] How many full-service restaurants are in 32092 and what\'s the population-to-restaurant ratio?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_055_im_a_national_franchise_developer', description: '[Restaurant] I\'m a national franchise developer — is 32092 a viable site for a first Florida location of a fast-casual health concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_056_whats_the_alcohol_license_environment', description: '[Restaurant] What\'s the alcohol license environment in 32092 — are there gaps for a brewery or taproom?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_057_how_does_the_tourist_mix', description: '[Restaurant] How does the tourist mix in 32092 (golf resort visitors) affect restaurant demand seasonality?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_058_is_there_a_fine_dining', description: '[Restaurant] Is there a fine dining gap in 32092 or is the population too value-oriented?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_059_whats_the_competitive_set_for', description: '[Restaurant] What\'s the competitive set for Italian restaurants in 32092 specifically?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_060_is_32080_st_augustine_beach', description: '[Restaurant] Is 32080 (St. Augustine Beach) oversaturated with seafood concepts during summer months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_061_whats_the_touristtolocal_ratio_in', description: '[Restaurant] What\'s the tourist-to-local ratio in 32080 and how does it shape the viable restaurant types?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_062_i_want_to_open_a', description: '[Restaurant] I want to open a rooftop bar in St. Augustine Beach — what does the alcohol license density look like in 32080?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_063_how_does_restaurant_demand_in', description: '[Restaurant] How does restaurant demand in 32080 shift between peak summer and off-season — is a year-round concept viable?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_064_is_there_a_breakfast_gap', description: '[Restaurant] Is there a breakfast gap in 32080 for a cafe concept targeting beach visitors and short-term rental guests?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_065_whats_the_delivery_demand_in', description: '[Restaurant] What\'s the delivery demand in 32080 — are vacation rental guests a meaningful delivery segment?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_066_how_many_food_trucks_operate', description: '[Restaurant] How many food trucks operate regularly in 32080 and is there a gap for a specialty dessert or coffee truck?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_067_im_a_franchise_operator_for', description: '[Restaurant] I\'m a franchise operator for a national ice cream brand — does 32080 have enough tourist volume and summer foot traffic to justify a location?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_068_whats_the_fastestgrowing_cuisine_categor', description: '[Restaurant] What\'s the fastest-growing cuisine category across all St. Johns County ZIPs combined?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_069_which_zip_code_in_st', description: '[Restaurant] Which ZIP code in St. Johns County has the highest restaurant capture rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_070_compare_tidal_momentum_for_restaurant', description: '[Restaurant] Compare tidal momentum for restaurant openings across 32081, 32082, and 32092.', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_071_whats_the_correlation_between_median', description: '[Restaurant] What\'s the correlation between median household income and restaurant price tier performance across the six St. Johns County ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_072_im_an_investor_evaluating_a', description: '[Restaurant] I\'m an investor evaluating a multi-unit restaurant group acquisition in St. Johns County — which ZIPs show the strongest unit economics signals?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_073_where_in_st_johns_county', description: '[Restaurant] Where in St. Johns County is the gap between restaurant supply and household growth the widest?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_074_which_zip_has_the_most', description: '[Restaurant] Which ZIP has the most alcohol licenses per capita in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_075_whats_the_ghost_kitchen_viability', description: '[Restaurant] What\'s the ghost kitchen viability in St. Johns County — which ZIP has the highest delivery demand density?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_076_im_a_healthcare_real_estate', description: '[Restaurant] I\'m a healthcare real estate developer and I noticed high income in 32082 — does that translate to strong lunch demand near medical office parks?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_077_whats_the_ethnic_restaurant_diversity', description: '[Restaurant] What\'s the ethnic restaurant diversity score across each St. Johns County ZIP?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_078_is_there_a_franchise_gap', description: '[Restaurant] Is there a franchise gap for a national breakfast brand (think First Watch or Eggs Up Grill) anywhere in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_079_im_a_realtor_helping_a', description: '[Restaurant] I\'m a realtor helping a restaurant client find space — what are the best retail corridors in 32082 for a new food-and-beverage tenant?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_080_how_has_the_fastcasual_market', description: '[Restaurant] How has the fast-casual market share shifted versus full-service in 32082 over the past five years?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_081_whats_the_viability_of_a', description: '[Restaurant] What\'s the viability of a dim sum or Chinese banquet concept in 32082 — is there a Chinese-American population base to support it?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_082_is_there_evidence_of_tidal', description: '[Restaurant] Is there evidence of tidal momentum — new restaurant permits, new retail pads, infrastructure investment — in the US-1 corridor of 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_083_im_a_restaurant_equipment_supplier', description: '[Restaurant] I\'m a restaurant equipment supplier — which ZIP in St. Johns County has the most new restaurant permit activity in the last 12 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_084_how_many_restaurant_businesses_in', description: '[Restaurant] How many restaurant businesses in 32084 have opened and closed in the last 24 months — what\'s the churn rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_085_is_there_a_gap_for', description: '[Restaurant] Is there a gap for a brunch-only concept in 32082 operating Friday through Sunday?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_086_whats_the_capture_rate_for', description: '[Restaurant] What\'s the capture rate for restaurant spending in 32081 — how much do Nocatee residents spend at restaurants versus how much of that spend stays in ZIP?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_087_im_considering_a_popup_restaurant', description: '[Restaurant] I\'m considering a pop-up restaurant series in St. Johns County — which ZIPs have the most active food events or farmers markets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_088_is_a_mediterranean_fastcasual_concept', description: '[Restaurant] Is a Mediterranean fast-casual concept viable in 32092 — what\'s the competition and income profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'fb_089_whats_the_price_sensitivity_of', description: '[Restaurant] What\'s the price sensitivity of diners in 32086 versus 32082 based on demographic signals?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'fb_090_i_run_a_catering_company', description: '[Restaurant] I run a catering company in 32084 and want to open a brick-and-mortar — which ZIP adjacent to 32084 has the least competition for event catering and casual dining?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'fb_091_whats_the_coffee_shop_saturation', description: '[Restaurant] What\'s the coffee shop saturation in 32082 — is there room for an independent specialty coffee concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_092_how_does_school_calendar_seasonality', description: '[Restaurant] How does school calendar seasonality affect restaurant traffic in family-heavy ZIPs like 32081?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_093_are_there_gaps_in_the', description: '[Restaurant] Are there gaps in the late-night food landscape (after 10pm) across St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_094_whats_the_viability_of_a', description: '[Restaurant] What\'s the viability of a plant-based or vegan restaurant concept in 32082 given the demographic profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_095_im_an_outofstate_investor_looking', description: '[Restaurant] I\'m an out-of-state investor looking at a restaurant strip center in 32082 — what\'s the average lease rate and vacancy for food-and-beverage pads?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_096_how_does_the_shortterm_rental', description: '[Restaurant] How does the short-term rental density in 32080 and 32084 create demand for restaurant concepts that cater to vacationers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_097_what_would_the_estimated_weekly', description: '[Restaurant] What would the estimated weekly covers be for a new 80-seat casual seafood restaurant opening on A1A in 32080 during peak season?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'fb_098_whats_the_average_check_size', description: '[Restaurant] What\'s the average check size at full-service restaurants in 32082 versus 32086 — and does that delta support a mid-scale casual dining concept in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'fb_099_im_a_multiunit_operator_considering', description: '[Restaurant] I\'m a multi-unit operator considering a second BBQ concept in St. Johns County — which ZIP between 32081, 32092, and 32086 has the best combination of family demographics, lack of BBQ competition, and household income?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'fb_100_what_would_the_projected_annual', description: '[Restaurant] What would the projected annual revenue be for a 60-seat breakfast and brunch concept opening in 32081 targeting young Nocatee families, assuming 2 turns per seat on weekends and 1 turn on weekdays?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_001_is_32082_oversaturated_with_boutique', description: '[Retail] Is 32082 oversaturated with boutique clothing stores?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_002_what_retail_spending_categories_are', description: '[Retail] What retail spending categories are leaking out of 32082 to Jacksonville or online?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_003_im_considering_opening_a_highend', description: '[Retail] I\'m considering opening a high-end pet supply store in Ponte Vedra Beach — what\'s the pet ownership rate and current competition in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_004_whats_the_luxury_retail_gap', description: '[Retail] What\'s the luxury retail gap in 32082 — is there unmet demand for a jewelry or accessories boutique?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_005_how_does_ecommerce_displacement_affect', description: '[Retail] How does e-commerce displacement affect brick-and-mortar retail viability in 32082 specifically for apparel?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_006_what_anchor_tenants_are_driving', description: '[Retail] What anchor tenants are driving foot traffic to strip centers in 32082 and are there inline spaces benefiting from that traffic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_007_im_evaluating_a_standalone_versus', description: '[Retail] I\'m evaluating a standalone versus strip mall location for a gift shop in 32082 — what does the data say about format performance?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_008_is_there_a_specialty_outdoor', description: '[Retail] Is there a specialty outdoor and sporting goods gap in 32082 given the beach and golf lifestyle?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_009_what_is_the_consumer_spending', description: '[Retail] What is the consumer spending profile in 32082 — what categories do residents over-index on?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_010_im_a_franchise_operator_for', description: '[Retail] I\'m a franchise operator for a national beauty supply brand — is 32082 viable for a first St. Johns County location?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_011_whats_the_home_goods_retail', description: '[Retail] What\'s the home goods retail gap in 32082 — is there room for an independent furniture or decor store?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_012_how_does_the_income_level', description: '[Retail] How does the income level in 32082 translate to retail spending power per household?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_013_what_retail_categories_are_most', description: '[Retail] What retail categories are most resilient to e-commerce disruption in a high-income coastal market like 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_014_is_there_a_dollar_store', description: '[Retail] Is there a dollar store saturation problem in 32082 or is that mostly a lower-income ZIP phenomenon in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_015_whats_the_auto_parts_retail', description: '[Retail] What\'s the auto parts retail density in 32082 — is there room for an independent or franchise auto accessories store?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_016_im_a_commercial_real_estate', description: '[Retail] I\'m a commercial real estate investor — which retail corridors in 32082 have the lowest vacancy rates?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_017_how_does_the_tourist_population', description: '[Retail] How does the tourist population in 32082 affect demand for gift and souvenir retail?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_018_is_there_a_wine_and', description: '[Retail] Is there a wine and spirits retail gap in 32082 — what\'s the license density and consumer profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_019_what_is_the_competitive_landscape', description: '[Retail] What is the competitive landscape for health and wellness retail (supplements, vitamins, natural products) in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_020_i_want_to_open_a', description: '[Retail] I want to open a children\'s clothing and toy store in 32082 — what\'s the under-12 population and current competition?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_021_what_retail_spending_capture_rate', description: '[Retail] What retail spending capture rate does 32081 (Nocatee) achieve — how much do residents spend locally versus driving to 32082 or Jacksonville?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_022_is_32081_ready_for_a', description: '[Retail] Is 32081 ready for a full-service sporting goods store or is the market still too young?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_023_whats_the_retail_gap_for', description: '[Retail] What\'s the retail gap for a specialty baby and toddler boutique in 32081 given the young family demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_024_how_many_national_retail_chains', description: '[Retail] How many national retail chains have opened in 32081 in the past 3 years and what categories are they?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_025_im_evaluating_a_second_location', description: '[Retail] I\'m evaluating a second location of my outdoor lifestyle brand — is 32081 or 32082 a better demographic fit?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_026_whats_the_dollar_store_density', description: '[Retail] What\'s the dollar store density in 32081 — is the income profile too high to support value-tier retail?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_027_is_there_a_home_improvement', description: '[Retail] Is there a home improvement retail gap in 32081 given the volume of new construction and young homeowners?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_028_what_anchor_tenants_exist_in', description: '[Retail] What anchor tenants exist in 32081 retail centers and what inline tenant categories are underrepresented?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_029_is_a_specialty_running_or', description: '[Retail] Is a specialty running or triathlon store viable in 32081 based on fitness participation data?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_030_whats_the_beauty_and_personal', description: '[Retail] What\'s the beauty and personal care retail landscape in 32081 — nail salons, hair salons, and specialty cosmetics?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_031_what_retail_categories_are_most', description: '[Retail] What retail categories are most underserved in 32084 relative to the resident and tourist population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_032_is_32084_historic_st_augustine', description: '[Retail] Is 32084 (historic St. Augustine) a viable location for a high-end gift and home goods boutique?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_033_how_does_tourist_foot_traffic', description: '[Retail] How does tourist foot traffic in 32084 affect retail sales seasonality — is a year-round boutique viable?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_034_whats_the_souvenir_and_gift', description: '[Retail] What\'s the souvenir and gift retail saturation in 32084 and is there room for an elevated concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_035_im_a_franchise_operator_for', description: '[Retail] I\'m a franchise operator for a national candle and home fragrance brand — is 32084 a good tourist-district location?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_036_whats_the_apparel_retail_density', description: '[Retail] What\'s the apparel retail density in 32084 and what price tiers are underrepresented?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_037_how_does_the_st_augustine', description: '[Retail] How does the St. Augustine historic district foot traffic compare to other Florida tourist markets in terms of retail conversion?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_038_is_there_a_specialty_food', description: '[Retail] Is there a specialty food and gourmet retail gap in 32084 — think olive oil, artisan cheese, or specialty coffee retail?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_039_whats_the_art_gallery_and', description: '[Retail] What\'s the art gallery and craft retail density in 32084 and is there room for another fine art retailer?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_040_what_categories_of_retail_are', description: '[Retail] What categories of retail are performing best in 32084 in terms of new openings versus closures?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_041_is_32086_an_underserved_retail', description: '[Retail] Is 32086 an underserved retail market — what\'s the spending capture rate relative to household count?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_042_what_retail_categories_do_32086', description: '[Retail] What retail categories do 32086 residents drive to 32084 or 32082 to access?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_043_is_there_a_groceryanchored_strip', description: '[Retail] Is there a grocery-anchored strip center gap in 32086 that could anchor new inline retail?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_044_whats_the_income_and_spending', description: '[Retail] What\'s the income and spending profile of 32086 — does it support mid-tier or value retail more strongly?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_045_im_an_investor_evaluating_a', description: '[Retail] I\'m an investor evaluating a strip center acquisition in 32086 — what\'s the tenant mix risk and vacancy trend?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_046_is_there_an_auto_parts', description: '[Retail] Is there an auto parts or auto accessories retail gap in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_047_whats_the_competitive_landscape_for', description: '[Retail] What\'s the competitive landscape for dollar stores and value-tier retail in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_048_is_a_sporting_goods_or', description: '[Retail] Is a sporting goods or hunting and fishing supply store viable in 32086 given proximity to outdoor recreation areas?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_049_whats_the_pet_supply_retail', description: '[Retail] What\'s the pet supply retail density in 32086 and is there room for an independent pet boutique?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_050_how_does_32086_retail_performance', description: '[Retail] How does 32086 retail performance compare to 32084 for independent operators?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'rx_051_whats_the_retail_gap_analysis', description: '[Retail] What\'s the retail gap analysis for 32092 (World Golf Village) — what categories are residents spending elsewhere?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_052_is_32092_a_viable_market', description: '[Retail] Is 32092 a viable market for a luxury home goods or interior design showroom?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_053_what_sporting_goods_categories_are', description: '[Retail] What sporting goods categories are underrepresented in 32092 given the golf and outdoor lifestyle?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_054_i_want_to_open_a', description: '[Retail] I want to open a wine bar with retail component in 32092 — what\'s the wine and spirits retail landscape?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_055_whats_the_specialty_food_retail', description: '[Retail] What\'s the specialty food retail opportunity in 32092 — is there demand for a gourmet grocery or artisan market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_056_how_does_the_32092_golf', description: '[Retail] How does the 32092 golf resort visitor demographic affect retail spending patterns?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_057_is_there_a_beauty_and', description: '[Retail] Is there a beauty and wellness retail gap in 32092 — think med spa retail, upscale skincare, or luxury cosmetics?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_058_whats_the_childrens_specialty_retail', description: '[Retail] What\'s the children\'s specialty retail opportunity in 32092 given the family demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_059_im_a_national_franchise_developer', description: '[Retail] I\'m a national franchise developer evaluating a first Florida location of a specialty toy store — does 32092 have the household income and child population to support it?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_060_whats_the_dollar_store_and', description: '[Retail] What\'s the dollar store and value retail density in 32092 — is there a mismatch with the income profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_061_what_retail_categories_do_32080', description: '[Retail] What retail categories do 32080 (St. Augustine Beach) tourists spend on most heavily?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_062_is_there_a_surf_and', description: '[Retail] Is there a surf and beach lifestyle retail gap in 32080?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_063_whats_the_gift_and_souvenir', description: '[Retail] What\'s the gift and souvenir retail saturation in 32080 — is it different from 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_064_how_does_the_shortterm_rental', description: '[Retail] How does the short-term rental concentration in 32080 affect retail demand patterns — do vacation renters shop locally?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_065_is_there_a_premium_grocery', description: '[Retail] Is there a premium grocery or specialty food retail gap in 32080 for full-time residents?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_066_whats_the_outdoor_recreation_retail', description: '[Retail] What\'s the outdoor recreation retail density in 32080 — kayak rentals, paddleboard, fishing gear?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_067_im_a_franchise_operator_for', description: '[Retail] I\'m a franchise operator for a national beach apparel brand — is 32080 a viable tourist-facing location?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_068_whats_the_wine_and_spirits', description: '[Retail] What\'s the wine and spirits retail density in 32080 and is there room for a boutique bottle shop?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_069_is_there_demand_for_a', description: '[Retail] Is there demand for a fitness and athletic apparel store in 32080 given the active beach lifestyle demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_070_whats_the_art_and_photography', description: '[Retail] What\'s the art and photography gallery density in 32080 — is there a gap for a fine art retail concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_071_which_st_johns_county_zip', description: '[Retail] Which St. Johns County ZIP has the highest retail spending capture rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_072_compare_ecommerce_displacement_risk_acro', description: '[Retail] Compare e-commerce displacement risk across the six St. Johns County ZIPs — which ZIP has the most vulnerable retail base?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_073_im_an_institutional_investor_evaluating', description: '[Retail] I\'m an institutional investor evaluating retail center acquisitions across St. Johns County — what\'s the cap rate environment for grocery-anchored centers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_074_whats_the_luxury_retail_demand', description: '[Retail] What\'s the luxury retail demand signal across 32082 and 32080 combined — enough to support a multi-brand luxury boutique?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_075_where_is_the_biggest_gap', description: '[Retail] Where is the biggest gap between household income and available retail options in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_076_what_retail_categories_have_the', description: '[Retail] What retail categories have the strongest new opening momentum across St. Johns County in 2024?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_077_which_zip_code_in_st', description: '[Retail] Which ZIP code in St. Johns County has the most retail churn (openings and closures) in the past 24 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_078_im_a_commercial_realtor_what', description: '[Retail] I\'m a commercial realtor — what are the top retail submarkets in St. Johns County ranked by foot traffic and household density?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_079_what_does_the_pet_supply', description: '[Retail] What does the pet supply retail landscape look like across all six St. Johns County ZIPs combined?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_080_is_there_a_gap_for', description: '[Retail] Is there a gap for a regional specialty grocery (think Trader Joe\'s-style) in any St. Johns County ZIP?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_081_whats_the_beauty_and_personal', description: '[Retail] What\'s the beauty and personal care retail density across the county and where is the biggest gap?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_082_im_a_retail_consultant_evaluating', description: '[Retail] I\'m a retail consultant evaluating franchise viability for a national home services brand with a retail component — which St. Johns County ZIP has the best owner-occupancy and home value metrics?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_083_what_categories_of_retail_have', description: '[Retail] What categories of retail have been displaced by e-commerce in 32082 and what new categories are filling that space?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_084_is_there_a_gap_for', description: '[Retail] Is there a gap for a specialty athletic footwear retailer anywhere in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_085_how_does_backtoschool_retail_spending', description: '[Retail] How does back-to-school retail spending differ across the St. Johns County ZIPs — which has the most school-age children per household?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_086_whats_the_impact_of_the', description: '[Retail] What\'s the impact of the 32081 population growth on adjacent retail markets in 32082 — is new supply keeping up?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_087_is_there_a_plant_nursery', description: '[Retail] Is there a plant nursery or garden center gap in 32082 given the high homeownership rate and outdoor lifestyle?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_088_whats_the_craft_beer_and', description: '[Retail] What\'s the craft beer and bottle shop retail environment in 32084 — is the tourist market enough to support a premium retail concept?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'rx_089_im_opening_a_kitchen_and', description: '[Retail] I\'m opening a kitchen and cooking supply boutique — which ZIP in St. Johns County has the highest culinary engagement and household income to support a $150 average transaction?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_090_whats_the_correlation_between_new', description: '[Retail] What\'s the correlation between new housing permits in 32081 and demand for home furnishing retail?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_091_is_there_a_gap_for', description: '[Retail] Is there a gap for an independent pharmacy or compounding pharmacy in 32082 that also carries retail wellness products?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_092_what_does_the_toy_and', description: '[Retail] What does the toy and hobby retail landscape look like in 32092 and 32081 combined — is there room for a specialty independent store?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'rx_093_im_a_contractor_specializing_in', description: '[Retail] I\'m a contractor specializing in retail buildouts — which ZIP in St. Johns County is seeing the most new retail construction permits?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_094_whats_the_impact_of_the', description: '[Retail] What\'s the impact of the A1A tourist corridor on retail capture in 32080 versus year-round resident spending?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'rx_095_is_there_demand_for_a', description: '[Retail] Is there demand for a resale or consignment boutique in 32082 given the high-income demographic — or does that demographic skew away from resale?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_096_whats_the_office_supply_and', description: '[Retail] What\'s the office supply and business services retail gap in 32082 given the number of remote workers and small businesses?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_097_how_has_the_expansion_of', description: '[Retail] How has the expansion of Nocatee (32081) affected retail leakage patterns from 32092 — are residents shopping closer to home now?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_098_what_music_instrument_or_performing', description: '[Retail] What music instrument or performing arts retail gaps exist across St. Johns County given school enrollment growth?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'rx_099_im_a_commercial_tenant_rep', description: '[Retail] I\'m a commercial tenant rep looking for a 2,000 SF inline space in a grocery-anchored center in 32081 — what are the available options and what\'s the market rent?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'rx_100_whats_the_medical_and_wellness', description: '[Retail] What\'s the medical and wellness retail gap across 32082 — think compression garments, home health equipment, and pharmacy retail — given the aging affluent demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_001_is_32082_oversaturated_with_dentists', description: '[Healthcare] Is 32082 oversaturated with dentists?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_002_whats_the_primary_care_physician', description: '[Healthcare] What\'s the primary care physician density per 1,000 residents in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_003_im_considering_opening_a_highend', description: '[Healthcare] I\'m considering opening a high-end dental practice in Ponte Vedra Beach — what does the provider density look like compared to the income level and is there room for a cosmetic-focused practice at the $400-600/visit price point?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_004_what_specialist_gaps_exist_in', description: '[Healthcare] What specialist gaps exist in 32082 that a multi-specialty group could fill?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_005_is_there_demand_for_a', description: '[Healthcare] Is there demand for a cash-pay medical spa in 32082 — what\'s the income profile and current competition?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_006_whats_the_mental_health_provider', description: '[Healthcare] What\'s the mental health provider density in 32082 and is there a gap for a private pay therapy practice?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_007_how_does_the_senior_population', description: '[Healthcare] How does the senior population in 32082 translate to demand for orthopedics, cardiology, and other geriatric specialties?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_008_is_there_room_for_another', description: '[Healthcare] Is there room for another urgent care center in 32082 or is the market saturated?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_009_what_does_the_pediatric_care', description: '[Healthcare] What does the pediatric care landscape look like in 32082 — is there a gap for a pediatric dentist or pediatrician?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_010_whats_the_insurance_mix_in', description: '[Healthcare] What\'s the insurance mix in 32082 — what percentage of patients are commercially insured versus Medicare/Medicaid?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_011_is_a_med_spa_focused', description: '[Healthcare] Is a med spa focused on injectables and laser treatments viable in 32082 at the $300-500/session price point?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_012_whats_the_physical_therapy_provider', description: '[Healthcare] What\'s the physical therapy provider density in 32082 and is there whitespace for a sports-focused PT practice?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_013_is_there_a_pharmacy_access', description: '[Healthcare] Is there a pharmacy access gap in 32082 — are residents driving out of ZIP for prescriptions?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_014_whats_the_home_health_and', description: '[Healthcare] What\'s the home health and home care demand in 32082 given the aging demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_015_im_a_healthcare_reit_evaluating', description: '[Healthcare] I\'m a healthcare REIT evaluating medical office acquisitions in 32082 — what are the vacancy rates and cap rate signals?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_016_what_does_the_telehealth_competition', description: '[Healthcare] What does the telehealth competition look like for primary care in 32082 — how much demand is being captured by virtual-first providers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_017_is_there_an_ophthalmology_or', description: '[Healthcare] Is there an ophthalmology or optometry gap in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_018_whats_the_aesthetic_dermatology_market', description: '[Healthcare] What\'s the aesthetic dermatology market in 32082 — botox, filler, and skin resurfacing specifically?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_019_how_does_the_32082_demographic', description: '[Healthcare] How does the 32082 demographic profile compare to the target patient for a luxury concierge medicine practice?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_020_is_there_a_gap_for', description: '[Healthcare] Is there a gap for a chiropractic or integrative health practice in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_021_whats_the_primary_care_access', description: '[Healthcare] What\'s the primary care access situation in 32081 — is Nocatee underserved relative to its population growth?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_022_im_a_pediatrician_evaluating_a', description: '[Healthcare] I\'m a pediatrician evaluating a new practice location in 32081 — what\'s the under-18 population and current provider-to-patient ratio?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_023_is_there_a_mental_health', description: '[Healthcare] Is there a mental health access gap in 32081 given the young family demographic and new community stress factors?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_024_what_specialist_categories_are_most', description: '[Healthcare] What specialist categories are most needed in 32081 based on population demographics?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_025_is_urgent_care_capacity_sufficient', description: '[Healthcare] Is urgent care capacity sufficient in 32081 or is it a gap market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_026_whats_the_dental_saturation_in', description: '[Healthcare] What\'s the dental saturation in 32081 — how many dentists per capita and is there room for a new general dentist?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_027_im_a_franchise_operator_for', description: '[Healthcare] I\'m a franchise operator for a national chiropractic brand — is 32081 a viable first St. Johns County location?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_028_whats_the_vision_care_optometryophthalmo', description: '[Healthcare] What\'s the vision care (optometry/ophthalmology) density in 32081 and is there a gap?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_029_is_there_demand_for_a', description: '[Healthcare] Is there demand for a boutique fertility clinic or reproductive endocrinologist in 32081 given the young professional demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_030_whats_the_pharmacy_density_in', description: '[Healthcare] What\'s the pharmacy density in 32081 and is there room for an independent pharmacy or specialty compounding pharmacy?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_031_whats_the_healthcare_provider_density', description: '[Healthcare] What\'s the healthcare provider density in 32084 relative to the resident versus tourist population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_032_is_there_a_gap_for', description: '[Healthcare] Is there a gap for urgent care or emergency care in 32084 given the tourist volume?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_033_what_does_the_dental_market', description: '[Healthcare] What does the dental market look like in 32084 — is tourist demand enough to support additional capacity?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_034_how_does_the_older_tourist', description: '[Healthcare] How does the older tourist demographic in 32084 affect demand for certain healthcare specialties?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_035_is_there_a_mental_health', description: '[Healthcare] Is there a mental health provider gap in 32084 that could be addressed by a private pay practice?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_036_whats_the_physical_therapy_and', description: '[Healthcare] What\'s the physical therapy and rehabilitation density in 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_037_im_a_healthcare_developer_evaluating', description: '[Healthcare] I\'m a healthcare developer evaluating medical office space in 32084 — what\'s the demand for outpatient clinical space?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_038_is_there_demand_for_a', description: '[Healthcare] Is there demand for a medical spa or aesthetics practice in 32084 — what\'s the income and demographic profile of year-round residents?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_039_whats_the_home_health_demand', description: '[Healthcare] What\'s the home health demand in 32084 given the senior population concentration?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_040_is_there_a_gap_for', description: '[Healthcare] Is there a gap for a specialty eye care practice in 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'hc_041_is_32086_underserved_for_primary', description: '[Healthcare] Is 32086 underserved for primary care relative to its population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_042_what_specialist_gaps_exist_in', description: '[Healthcare] What specialist gaps exist in 32086 — which specialties are residents driving to 32084 or Jacksonville to access?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_043_is_there_demand_for_a', description: '[Healthcare] Is there demand for a freestanding urgent care center in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_044_whats_the_dental_saturation_in', description: '[Healthcare] What\'s the dental saturation in 32086 — how many practices per capita?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_045_is_there_room_for_a', description: '[Healthcare] Is there room for a physical therapy or orthopedic rehab clinic in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_046_whats_the_mental_health_access', description: '[Healthcare] What\'s the mental health access situation in 32086 — provider-to-resident ratio and insurance mix?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_047_im_a_healthcare_investor_evaluating', description: '[Healthcare] I\'m a healthcare investor evaluating a multi-specialty clinic acquisition in 32086 — what are the key demand drivers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_048_whats_the_pharmacy_access_situation', description: '[Healthcare] What\'s the pharmacy access situation in 32086 and is there a gap for an independent pharmacy?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_049_is_there_demand_for_a', description: '[Healthcare] Is there demand for a med spa or aesthetics practice in 32086 given the income and age profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_050_what_does_the_home_health', description: '[Healthcare] What does the home health and senior care market look like in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_051_whats_the_primary_care_physician', description: '[Healthcare] What\'s the primary care physician supply in 32092 versus the demand generated by residential growth?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_052_is_there_a_specialist_gap', description: '[Healthcare] Is there a specialist gap in 32092 — specifically cardiology, dermatology, or orthopedics?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_053_whats_the_dental_market_saturation', description: '[Healthcare] What\'s the dental market saturation in 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_054_is_urgent_care_adequately_supplied', description: '[Healthcare] Is urgent care adequately supplied in 32092 or is there a gap?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_055_whats_the_mental_health_provider', description: '[Healthcare] What\'s the mental health provider density in 32092 and is there room for a private pay practice?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_056_im_a_national_medial_franchise', description: '[Healthcare] I\'m a national medial franchise operator evaluating 32092 for a physical therapy or chiropractic concept — what\'s the competitive density?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_057_whats_the_med_spa_and', description: '[Healthcare] What\'s the med spa and aesthetics market in 32092 — income profile and current competition?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_058_is_there_a_vision_care', description: '[Healthcare] Is there a vision care gap in 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_059_what_does_the_pediatric_healthcare', description: '[Healthcare] What does the pediatric healthcare landscape look like in 32092 given the family demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_060_whats_the_pharmacy_density_in', description: '[Healthcare] What\'s the pharmacy density in 32092 and is there demand for a compounding or specialty pharmacy?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_061_what_healthcare_specialties_are_most', description: '[Healthcare] What healthcare specialties are most needed in 32080 given the beach community resident profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_062_is_urgent_care_adequately_available', description: '[Healthcare] Is urgent care adequately available in 32080 or do residents drive to 32084 for basic acute care?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_063_whats_the_dental_provider_density', description: '[Healthcare] What\'s the dental provider density in 32080?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_064_is_there_a_gap_for', description: '[Healthcare] Is there a gap for a physical therapy practice in 32080 focused on sports and beach injury rehab?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_065_whats_the_aesthetics_and_medical', description: '[Healthcare] What\'s the aesthetics and medical spa demand in 32080 — tourist versus resident mix?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_066_how_does_the_shortterm_rental', description: '[Healthcare] How does the short-term rental and vacation community in 32080 create episodic healthcare demand that a freestanding clinic could capture?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_067_whats_the_mental_health_provider', description: '[Healthcare] What\'s the mental health provider landscape in 32080?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_068_is_there_a_pharmacy_access', description: '[Healthcare] Is there a pharmacy access gap in 32080?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_069_whats_the_home_health_demand', description: '[Healthcare] What\'s the home health demand in 32080 given the senior retiree population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_070_is_there_demand_for_a', description: '[Healthcare] Is there demand for a concierge or direct primary care practice in 32080?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'hc_071_which_zip_code_in_st', description: '[Healthcare] Which ZIP code in St. Johns County has the largest primary care provider gap relative to population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_072_whats_the_total_specialist_physician', description: '[Healthcare] What\'s the total specialist physician supply across St. Johns County and which specialties have the biggest shortfalls?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_073_im_a_health_system_coo', description: '[Healthcare] I\'m a health system COO evaluating outpatient expansion into St. Johns County — which ZIP has the highest unmet demand for employed physician services?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_074_whats_the_mental_health_access', description: '[Healthcare] What\'s the mental health access gap across the county — how many licensed therapists and psychiatrists per 10,000 residents?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_075_how_does_the_medicare_advantage', description: '[Healthcare] How does the Medicare Advantage penetration rate in St. Johns County affect viability of a senior-focused primary care clinic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_076_whats_the_medical_spa_market', description: '[Healthcare] What\'s the medical spa market size estimate across the six St. Johns County ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_077_is_there_a_multispecialty_group', description: '[Healthcare] Is there a multi-specialty group acquisition opportunity in St. Johns County — which practices are in high-demand specialties in underserved ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_078_compare_the_dental_saturation_across', description: '[Healthcare] Compare the dental saturation across all six St. Johns County ZIPs — where is the clearest whitespace?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_079_whats_the_urgent_care_gap', description: '[Healthcare] What\'s the urgent care gap analysis across St. Johns County — how many residents are more than 10 minutes from an urgent care center?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_080_im_a_physical_therapy_franchise', description: '[Healthcare] I\'m a physical therapy franchise operator — which St. Johns County ZIP has the best combination of sports activity density and PT provider gap?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_081_whats_the_behavioral_health_crisis', description: '[Healthcare] What\'s the behavioral health crisis response gap in St. Johns County — are there mobile crisis teams or crisis stabilization units?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_082_is_there_a_pediatric_specialist', description: '[Healthcare] Is there a pediatric specialist gap (pediatric cardiology, ENT, or neurology) anywhere in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_083_whats_the_telehealth_utilization_rate', description: '[Healthcare] What\'s the telehealth utilization rate in St. Johns County and how does it differ by ZIP code?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_084_im_a_private_equity_investor', description: '[Healthcare] I\'m a private equity investor evaluating a dermatology platform acquisition in St. Johns County — what\'s the practice density and income signal across ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_085_is_there_a_home_health', description: '[Healthcare] Is there a home health agency gap in the rapidly growing corridors of 32081 and 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_086_whats_the_senior_living_and', description: '[Healthcare] What\'s the senior living and assisted living capacity versus demand in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_087_how_does_the_income_mix', description: '[Healthcare] How does the income mix in 32082 support cash-pay versus insurance-based healthcare models — what percentage of residents could afford a $2,500/year concierge medicine membership?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_088_whats_the_physical_therapy_saturation', description: '[Healthcare] What\'s the physical therapy saturation in 32082 compared to the injury and surgery volume generated by the active senior population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_089_is_there_a_gap_for', description: '[Healthcare] Is there a gap for a women\'s health or OB-GYN specialist in 32081 given the young family demographic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_090_whats_the_chiropractic_and_alternative', description: '[Healthcare] What\'s the chiropractic and alternative medicine density in 32082 — is there whitespace for a high-end integrative wellness clinic?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_091_is_there_demand_for_a', description: '[Healthcare] Is there demand for a free-standing birth center or midwifery practice in 32081?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'hc_092_what_would_be_the_estimated', description: '[Healthcare] What would be the estimated patient catchment for a new orthopedic surgery center opening in 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'hc_093_how_does_the_pharmacy_desert', description: '[Healthcare] How does the pharmacy desert risk in rural parts of 32086 affect demand for a mobile pharmacy or delivery pharmacy service?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'hc_094_is_there_an_addiction_medicine', description: '[Healthcare] Is there an addiction medicine or substance use treatment gap in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_095_whats_the_audiology_and_hearing', description: '[Healthcare] What\'s the audiology and hearing care density across St. Johns County — is there a gap given the senior population?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_096_whats_the_podiatry_and_foot', description: '[Healthcare] What\'s the podiatry and foot care provider density in 32082 — is there room for a sports-focused podiatry practice?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_097_im_a_healthcare_staffing_agency', description: '[Healthcare] I\'m a healthcare staffing agency evaluating St. Johns County — which specialties have the highest unfilled position rates across the ZIP codes?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_098_whats_the_weight_loss_and', description: '[Healthcare] What\'s the weight loss and metabolic medicine market in 32082 — especially given the rise of GLP-1 medications and cash-pay weight management programs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_099_is_there_a_gap_for', description: '[Healthcare] Is there a gap for an ambulatory surgery center in 32082 or 32081 — what procedures are residents traveling to Jacksonville to access?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'hc_100_whats_the_dermatology_provider_density', description: '[Healthcare] What\'s the dermatology provider density in 32082 versus the skin cancer risk profile of the coastal population — is there a medical dermatology gap distinct from the aesthetic market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_001_whats_the_permit_velocity_in', description: '[Construction] What\'s the permit velocity in 32082 — how many new residential permits were pulled in the last 12 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_002_is_32082_oversaturated_with_general', description: '[Construction] Is 32082 oversaturated with general contractors?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_003_whats_the_ratio_of_licensed', description: '[Construction] What\'s the ratio of licensed contractors to active building permits in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_004_im_a_roofing_contractor_evaluating', description: '[Construction] I\'m a roofing contractor evaluating 32082 — what\'s the housing age profile and what percentage of roofs are likely due for replacement?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_005_what_does_the_pool_construction', description: '[Construction] What does the pool construction market look like in 32082 — how many permits pulled and what\'s the saturation of pool contractors?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_006_is_there_a_solar_installation', description: '[Construction] Is there a solar installation gap in 32082 — what\'s the current adoption rate and how does it compare to comparable Florida markets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_007_whats_the_luxury_remodel_demand', description: '[Construction] What\'s the luxury remodel demand in 32082 — kitchen and bath renovation permits at the $100K+ price point?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_008_how_does_the_storm_season', description: '[Construction] How does the storm season (June-November) affect roofing contractor demand in 32082 and the surrounding area?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_009_whats_the_renovationversusnewbuild_split', description: '[Construction] What\'s the renovation-versus-new-build split in 32082 — which segment is growing faster?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_010_im_a_home_inspector_evaluating', description: '[Construction] I\'m a home inspector evaluating whether to open an office in 32082 — what\'s the transaction volume and inspector density?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_011_whats_the_adu_accessory_dwelling', description: '[Construction] What\'s the ADU (accessory dwelling unit) and home addition trend in 32082 — how many permits and what\'s the growth rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_012_is_there_a_landscaping_contractor', description: '[Construction] Is there a landscaping contractor saturation issue in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_013_whats_the_flood_remediation_and', description: '[Construction] What\'s the flood remediation and water damage restoration demand in 32082 given FEMA flood zone exposure?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_014_is_there_a_gap_for', description: '[Construction] Is there a gap for a high-end kitchen and bath remodel specialist in 32082 at the $75K-$200K project range?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_015_whats_the_irrigation_system_installation', description: '[Construction] What\'s the irrigation system installation demand in 32082 — new installs versus maintenance contracts?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_016_im_a_commercial_contractor_whats', description: '[Construction] I\'m a commercial contractor — what\'s the pipeline of new commercial permits in 32082 for the next 12-24 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_017_whats_the_home_inspection_density', description: '[Construction] What\'s the home inspection density in 32082 — inspectors per real estate transaction?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_018_is_the_hvac_service_and', description: '[Construction] Is the HVAC service and replacement market in 32082 growing with new construction or is it saturated?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_019_whats_the_concrete_and_hardscape', description: '[Construction] What\'s the concrete and hardscape contractor density in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_020_im_a_paint_contractor_whats', description: '[Construction] I\'m a paint contractor — what\'s the new construction pipeline and repaint cycle demand in 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_021_whats_the_permit_velocity_in', description: '[Construction] What\'s the permit velocity in 32081 (Nocatee) — is it the fastest-growing construction market in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_022_is_there_a_trade_contractor', description: '[Construction] Is there a trade contractor gap in 32081 — plumbers, electricians, or framers that can\'t keep up with new construction demand?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_023_whats_the_pool_construction_market', description: '[Construction] What\'s the pool construction market in 32081 — how many new pool permits are being pulled annually?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_024_is_solar_adoption_in_32081', description: '[Construction] Is solar adoption in 32081 accelerating and is there a gap for a local solar installer serving the new construction market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_025_whats_the_landscaping_contractor_market', description: '[Construction] What\'s the landscaping contractor market in 32081 — is demand outpacing supply given the rate of new home delivery?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_026_im_a_custom_home_builder', description: '[Construction] I\'m a custom home builder evaluating a move into 32081 — what\'s the land pipeline and lot absorption rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_027_whats_the_irrigation_installation_market', description: '[Construction] What\'s the irrigation installation market in 32081 — new installs per year and maintenance contract opportunity?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_028_is_there_an_adu_or', description: '[Construction] Is there an ADU or in-law suite addition trend in 32081 as the community matures?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_029_whats_the_home_inspection_market', description: '[Construction] What\'s the home inspection market in 32081 — how many inspectors per transaction and is there room for another firm?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_030_whats_the_commercial_construction_pipeli', description: '[Construction] What\'s the commercial construction pipeline in 32081 — retail, medical office, and mixed-use permits?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_031_whats_the_building_permit_activity', description: '[Construction] What\'s the building permit activity in 32084 — residential versus commercial split?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_032_is_the_renovation_market_in', description: '[Construction] Is the renovation market in 32084 stronger than new construction given the age of the housing stock?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_033_whats_the_historic_property_renovation', description: '[Construction] What\'s the historic property renovation permit volume in 32084 — and are there specialty contractors serving that niche?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_034_im_a_roofing_contractor_whats', description: '[Construction] I\'m a roofing contractor — what\'s the roof age distribution in 32084 and how many are approaching the 20-year replacement cycle?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_035_whats_the_flood_remediation_demand', description: '[Construction] What\'s the flood remediation demand in 32084 given the coastal location and storm risk?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_036_is_there_a_gap_for', description: '[Construction] Is there a gap for a licensed restoration contractor in 32084 specializing in storm damage and flood work?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_037_whats_the_commercial_renovation_permit', description: '[Construction] What\'s the commercial renovation permit volume in 32084 — restaurant buildouts, retail improvements, historic adaptive reuse?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_038_im_a_masonry_and_stucco', description: '[Construction] I\'m a masonry and stucco contractor — is 32084 a viable base market given the historic architecture?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_039_whats_the_hvac_market_in', description: '[Construction] What\'s the HVAC market in 32084 — replacement demand based on system age and new commercial installs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_040_is_there_a_pool_market', description: '[Construction] Is there a pool market opportunity in 32084 or does the urban/tourist character limit single-family pool installations?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_041_whats_the_permit_velocity_in', description: '[Construction] What\'s the permit velocity in 32086 and how does it compare to the county average?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_042_is_32086_seeing_renovation_momentum', description: '[Construction] Is 32086 seeing renovation momentum or is it predominantly a new construction market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_043_whats_the_roofing_replacement_cycle', description: '[Construction] What\'s the roofing replacement cycle demand in 32086 based on housing age?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_044_im_evaluating_a_flooring_and', description: '[Construction] I\'m evaluating a flooring and tile contracting business in 32086 — what\'s the new construction and renovation volume?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_045_whats_the_landscaping_contractor_density', description: '[Construction] What\'s the landscaping contractor density in 32086 and is there room for a new mid-size operation?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_046_is_there_a_solar_installation', description: '[Construction] Is there a solar installation gap in 32086 — what\'s the adoption rate compared to 32081?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_047_whats_the_commercial_construction_activi', description: '[Construction] What\'s the commercial construction activity in 32086 — permits, square footage, and project types?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_048_is_there_a_gap_for', description: '[Construction] Is there a gap for a custom deck and outdoor living contractor in 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_049_whats_the_pool_market_in', description: '[Construction] What\'s the pool market in 32086 — permits and contractor density?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_050_im_a_plumbing_contractor_expanding', description: '[Construction] I\'m a plumbing contractor expanding from Jacksonville — is 32086 a growth market worth entering?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_051_whats_the_new_residential_construction', description: '[Construction] What\'s the new residential construction pipeline in 32092 over the next 24 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_052_is_the_contractor_supply_in', description: '[Construction] Is the contractor supply in 32092 keeping pace with construction demand?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_053_whats_the_luxury_custom_home', description: '[Construction] What\'s the luxury custom home market in 32092 — how many permits at the $750K+ construction value threshold?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_054_im_a_pool_contractor_evaluating', description: '[Construction] I\'m a pool contractor evaluating expansion into 32092 — what\'s the pool permit volume and how saturated is the market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_055_whats_the_solar_adoption_rate', description: '[Construction] What\'s the solar adoption rate in 32092 and is there room for a dedicated residential solar installer?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_056_is_there_a_gap_for', description: '[Construction] Is there a gap for an ADU contractor in 32092 — how many addition and guest house permits have been pulled?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_057_whats_the_landscaping_market_in', description: '[Construction] What\'s the landscaping market in 32092 — new install versus maintenance, and how many active licensed landscapers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_058_im_a_general_contractor_whats', description: '[Construction] I\'m a general contractor — what\'s the renovation-versus-new-build split in 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_059_whats_the_roofing_contractor_density', description: '[Construction] What\'s the roofing contractor density in 32092 versus the volume of roofs in the replacement cycle?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_060_is_there_a_flood_remediation', description: '[Construction] Is there a flood remediation and waterproofing contractor gap in 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_061_whats_the_construction_permit_activity', description: '[Construction] What\'s the construction permit activity in 32080 — residential versus commercial?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_062_is_there_a_renovation_rebound', description: '[Construction] Is there a renovation rebound happening in 32080 as older beach homes are upgraded?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_063_whats_the_demand_for_elevated', description: '[Construction] What\'s the demand for elevated home reconstruction in 32080 given flood zone requirements?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_064_im_a_custom_deck_and', description: '[Construction] I\'m a custom deck and outdoor living contractor — is 32080 a viable market given the beach home ownership profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_065_whats_the_roofing_replacement_demand', description: '[Construction] What\'s the roofing replacement demand in 32080 based on post-storm cycle and housing age?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_066_is_the_hvac_market_in', description: '[Construction] Is the HVAC market in 32080 strong — what\'s the system replacement demand given the coastal salt air environment?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_067_whats_the_pool_construction_market', description: '[Construction] What\'s the pool construction market in 32080 — how many single-family homes lack pools and is there demand for new installs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_068_im_a_flood_remediation_specialist', description: '[Construction] I\'m a flood remediation specialist — how does FEMA flood zone concentration in 32080 translate to business volume?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_069_whats_the_solar_adoption_rate', description: '[Construction] What\'s the solar adoption rate in 32080 and is there a first-mover opportunity for a local installer?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_070_is_there_a_gap_for', description: '[Construction] Is there a gap for a high-end kitchen and bath remodeler in 32080 targeting beach home renovation clients?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_071_compare_permit_velocity_across_all', description: '[Construction] Compare permit velocity across all six St. Johns County ZIPs — which is growing fastest?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_072_whats_the_total_construction_dollar', description: '[Construction] What\'s the total construction dollar volume across St. Johns County in the past 12 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_073_im_a_construction_materials_supplier', description: '[Construction] I\'m a construction materials supplier — which ZIP in St. Johns County has the highest new residential construction activity?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_074_what_trades_are_in_shortest', description: '[Construction] What trades are in shortest supply across St. Johns County — electricians, plumbers, framers, or roofers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_075_is_there_a_gap_for', description: '[Construction] Is there a gap for a specialty contractor focused on luxury outdoor living (pergolas, outdoor kitchens, pools, landscaping) serving the 32082 and 32081 markets combined?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_076_whats_the_commercial_construction_pipeli', description: '[Construction] What\'s the commercial construction pipeline across St. Johns County for medical office, retail, and mixed-use for the next 18 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_077_im_a_private_equity_investor', description: '[Construction] I\'m a private equity investor evaluating a platform acquisition of residential renovation contractors in St. Johns County — what ZIPs have the best fundamentals?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_078_whats_the_storm_damage_insurance', description: '[Construction] What\'s the storm damage insurance claim volume in St. Johns County and what does that mean for restoration contractors?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_079_how_does_the_aging_housing', description: '[Construction] How does the aging housing stock in 32084 and 32086 compare to the new construction boom in 32081 — and what does that mean for a contractor wanting to serve both markets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_080_is_there_a_gap_for', description: '[Construction] Is there a gap for a certified energy efficiency contractor in St. Johns County given rising utility costs and new construction growth?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_081_whats_the_aduaccessory_dwelling_unit', description: '[Construction] What\'s the ADU/accessory dwelling unit permit trend across St. Johns County — is it gaining traction?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_082_how_does_the_school_construction', description: '[Construction] How does the school construction and public facility pipeline in St. Johns County affect commercial contractor demand?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_083_is_there_a_demand_signal', description: '[Construction] Is there a demand signal for a luxury custom homebuilder in 32082 at the $2M+ construction value range?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_084_whats_the_concrete_and_foundation', description: '[Construction] What\'s the concrete and foundation repair demand in older St. Johns County ZIPs like 32084 and 32086?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_085_im_a_home_warranty_company', description: '[Construction] I\'m a home warranty company evaluating a St. Johns County expansion — which ZIPs have the most homes in the 10-20 year age range that generate the most warranty claims?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_086_what_does_the_rental_property', description: '[Construction] What does the rental property renovation market look like in 32084 and 32080 — short-term rental owners upgrading properties?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 'cx_087_is_there_a_gap_for', description: '[Construction] Is there a gap for a licensed mold remediation contractor in the coastal ZIPs (32080, 32082, 32084)?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_088_whats_the_fence_and_hardscape', description: '[Construction] What\'s the fence and hardscape permit volume in 32081 — is there room for another licensed fencing contractor?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_089_how_has_the_surge_in', description: '[Construction] How has the surge in short-term rental properties in 32080 and 32084 driven demand for interior renovation and staging work?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_090_whats_the_electrical_panel_upgrade', description: '[Construction] What\'s the electrical panel upgrade demand across St. Johns County given the age of housing and EV charging installation growth?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_091_is_there_a_gap_for', description: '[Construction] Is there a gap for a licensed plumbing contractor in 32092 given the pace of new home construction?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 'cx_092_whats_the_roof_age_distribution', description: '[Construction] What\'s the roof age distribution in 32086 and when is the next major replacement wave expected?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_093_im_an_insurance_restoration_contractor', description: '[Construction] I\'m an insurance restoration contractor — which St. Johns County ZIP codes have the highest hurricane-related claim density historically?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_094_whats_the_permit_rejection_and', description: '[Construction] What\'s the permit rejection and revision rate in St. Johns County and how does that affect contractor project timelines?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_095_im_a_residential_architect_evaluating', description: '[Construction] I\'m a residential architect evaluating a move to St. Johns County — which ZIPs have the most custom home activity at the $1M+ build value?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_096_whats_the_impact_of_rising', description: '[Construction] What\'s the impact of rising insurance costs on renovation decisions in coastal ZIPs like 32080 and 32084 — are homeowners investing more or deferring maintenance?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 'cx_097_is_there_a_gap_for', description: '[Construction] Is there a gap for a licensed swimming pool renovation contractor in 32082 — how many pools are over 15 years old and likely due for resurfacing or equipment replacement?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 'cx_098_whats_the_concrete_block_and', description: '[Construction] What\'s the concrete block and CBS construction demand in 32086 for new builds — and is there a framing subcontractor shortage?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 'cx_099_im_evaluating_a_commercial_cleaning', description: '[Construction] I\'m evaluating a commercial cleaning and janitorial services business targeting new construction final clean in 32081 — what\'s the volume of new completions per month?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 'cx_100_whats_the_ev_charging_installation', description: '[Construction] What\'s the EV charging installation market across St. Johns County — how many new permits for EV charger installs in residential and commercial properties in the past 12 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_001_whats_the_median_household_income', description: '[Realtor] What\'s the median household income in 32082 and how does it compare to the St. Johns County average?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_002_is_32082_a_buyers_market', description: '[Realtor] Is 32082 a buyer\'s market or seller\'s market right now?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_003_whats_the_listingtosale_velocity_in', description: '[Realtor] What\'s the listing-to-sale velocity in 32082 — average days on market for single-family homes?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_004_what_percentage_of_homes_in', description: '[Realtor] What percentage of homes in 32082 are owner-occupied versus investment or rental properties?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_005_im_an_investor_evaluating_singlefamily', description: '[Realtor] I\'m an investor evaluating single-family rental acquisitions in 32082 — what cap rate signals can I find?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_006_whats_the_flood_zone_exposure', description: '[Realtor] What\'s the flood zone exposure in 32082 and how does it affect property values and insurance costs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_007_how_does_school_district_quality', description: '[Realtor] How does school district quality in 32082 affect resale values — what premium does the St. Johns County school system command?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_008_whats_the_new_development_pipeline', description: '[Realtor] What\'s the new development pipeline in 32082 — approved subdivisions, multifamily projects, and commercial entitlements?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_009_is_32082_a_viable_market', description: '[Realtor] Is 32082 a viable market for short-term rental investment given the Ponte Vedra Beach brand and proximity to the coast?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_010_whats_the_buyer_agent_density', description: '[Realtor] What\'s the buyer agent density in 32082 — how many active Realtors per transaction and is the market underserved by agents?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_011_what_price_tier_has_the', description: '[Realtor] What price tier has the highest absorption rate in 32082 — under $500K, $500K-$1M, or $1M+?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_012_is_there_a_1031_exchange', description: '[Realtor] Is there a 1031 exchange opportunity in 32082 — NNN retail or medical office properties with strong cap rates?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_013_whats_the_commercial_vacancy_rate', description: '[Realtor] What\'s the commercial vacancy rate in 32082 and what does it signal for a value-add investor?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_014_im_a_buyer_relocating_from', description: '[Realtor] I\'m a buyer relocating from the Northeast — what\'s the income and lifestyle profile of 32082 and is it right for a family with school-age children?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_015_what_infrastructure_investments_are_plan', description: '[Realtor] What infrastructure investments are planned for 32082 over the next 5 years that could increase property values?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_016_whats_the_shortterm_rental_regulatory', description: '[Realtor] What\'s the short-term rental regulatory environment in 32082 — are there restrictions I need to know about?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_017_whats_the_price_per_square', description: '[Realtor] What\'s the price per square foot trend for single-family homes in 32082 over the past 24 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_018_is_32082_attracting_net_migration', description: '[Realtor] Is 32082 attracting net migration from high-cost metros — what\'s the buyer origin profile?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_019_whats_the_investment_property_share', description: '[Realtor] What\'s the investment property share of recent closings in 32082 — are cash buyers dominant?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_020_im_a_realtor_helping_a', description: '[Realtor] I\'m a realtor helping a luxury client evaluate waterfront lots in 32082 — what\'s the land market and buildable lot supply?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_021_whats_the_median_home_price', description: '[Realtor] What\'s the median home price in 32081 (Nocatee) and how has it trended?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_022_is_32081_a_good_market', description: '[Realtor] Is 32081 a good market for short-term rentals or is it primarily owner-occupied?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_023_whats_the_buyer_profile_in', description: '[Realtor] What\'s the buyer profile in 32081 — age, income, household type, and origin?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_024_how_does_the_new_construction', description: '[Realtor] How does the new construction pipeline in 32081 affect resale values for existing homes?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_025_whats_the_daysonmarket_for_new', description: '[Realtor] What\'s the days-on-market for new construction homes in 32081 versus resale inventory?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_026_im_a_national_homebuilder_evaluating', description: '[Realtor] I\'m a national homebuilder evaluating land acquisition in 32081 — what\'s the lot pipeline and absorption rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_027_what_percentage_of_32081_homes', description: '[Realtor] What percentage of 32081 homes are occupied by first-time buyers versus move-up buyers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_028_is_there_a_1031_exchange', description: '[Realtor] Is there a 1031 exchange opportunity in 32081 — commercial property with stable tenants?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_029_what_school_zones_cover_32081', description: '[Realtor] What school zones cover 32081 and how do they affect buyer demand?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_030_what_flood_zone_risk_exists', description: '[Realtor] What flood zone risk exists in 32081 and does it affect specific subdivisions more than others?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_031_whats_the_average_days_on', description: '[Realtor] What\'s the average days on market for residential listings in 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_032_is_32084_historic_st_augustine', description: '[Realtor] Is 32084 (historic St. Augustine) a viable short-term rental investment market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_033_what_price_tier_performs_best', description: '[Realtor] What price tier performs best for investment property in 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_034_whats_the_vacation_rental_cap', description: '[Realtor] What\'s the vacation rental cap rate in 32084 based on occupancy rates and ADR?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_035_im_a_realtor_specializing_in', description: '[Realtor] I\'m a realtor specializing in historic homes — what\'s the inventory of pre-1950 properties in 32084 and what\'s the buyer demand for that product?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_036_whats_the_commercial_real_estate', description: '[Realtor] What\'s the commercial real estate vacancy rate in the 32084 historic district?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_037_how_has_shortterm_rental_regulation', description: '[Realtor] How has short-term rental regulation in St. Augustine affected investment activity in 32084?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_038_whats_the_flood_zone_exposure', description: '[Realtor] What\'s the flood zone exposure in 32084 and which neighborhoods carry the highest risk?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_039_is_there_a_1031_exchange', description: '[Realtor] Is there a 1031 exchange opportunity in 32084 — mixed-use or retail properties in the historic corridor?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_040_whats_the_new_construction_pipeline', description: '[Realtor] What\'s the new construction pipeline in 32084 and how does it compare to resale volume?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_041_whats_the_median_home_price', description: '[Realtor] What\'s the median home price in 32086 and how does it compare to the county average?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_042_is_32086_a_value_entry', description: '[Realtor] Is 32086 a value entry point into St. Johns County real estate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_043_what_percentage_of_32086_homes', description: '[Realtor] What percentage of 32086 homes are investment or rental properties?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_044_im_an_investor_evaluating_a', description: '[Realtor] I\'m an investor evaluating a 20-unit multifamily acquisition in 32086 — what are the vacancy rates and rent growth trends?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_045_whats_the_buyer_profile_in', description: '[Realtor] What\'s the buyer profile in 32086 — is it mostly local buyers or are there out-of-market investors?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_046_whats_the_daysonmarket_trend_in', description: '[Realtor] What\'s the days-on-market trend in 32086 and does it signal increasing or decreasing demand?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_047_how_does_flood_zone_risk', description: '[Realtor] How does flood zone risk in 32086 compare to the rest of St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_048_what_infrastructure_or_commercial_develo', description: '[Realtor] What infrastructure or commercial development is planned for 32086 that could be an investment catalyst?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_049_is_there_a_1031_exchange', description: '[Realtor] Is there a 1031 exchange opportunity in 32086 — net lease or retail strip with long-term tenants?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_050_what_school_zones_serve_32086', description: '[Realtor] What school zones serve 32086 and how do they affect buyer demand relative to 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_051_whats_the_median_home_price', description: '[Realtor] What\'s the median home price in 32092 and how has it appreciated over the past 3 years?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_052_is_32092_a_good_shortterm', description: '[Realtor] Is 32092 a good short-term rental market given the World Golf Village and resort amenities?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_053_whats_the_investment_property_share', description: '[Realtor] What\'s the investment property share in 32092 — how many closings are to non-owner-occupant buyers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_054_what_new_residential_development_is', description: '[Realtor] What new residential development is in the pipeline for 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_055_im_a_realtor_helping_a', description: '[Realtor] I\'m a realtor helping a golf-enthusiast couple relocate — is 32092 the right fit and what\'s the price range for golf course frontage properties?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_056_whats_the_commercial_vacancy_rate', description: '[Realtor] What\'s the commercial vacancy rate in 32092 and are there value-add opportunities for a private investor?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_057_how_does_the_school_district', description: '[Realtor] How does the school district in 32092 compare to 32082 in terms of buyer perception and price premium?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_058_whats_the_listingtosale_velocity_in', description: '[Realtor] What\'s the listing-to-sale velocity in 32092 versus the county average?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_059_is_there_a_1031_exchange', description: '[Realtor] Is there a 1031 exchange opportunity in 32092 — retail or mixed-use near the World Golf Village?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_060_what_flood_zone_exposure_exists', description: '[Realtor] What flood zone exposure exists in 32092 and does it affect specific neighborhoods?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32092' }] },
          { name: 're_061_whats_the_median_home_price', description: '[Realtor] What\'s the median home price in 32080 (St. Augustine Beach) and is it appreciating faster than the county average?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_062_is_32080_a_strong_shortterm', description: '[Realtor] Is 32080 a strong short-term rental investment market — what\'s the occupancy rate and average daily rate for vacation rentals?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_063_whats_the_flood_zone_risk', description: '[Realtor] What\'s the flood zone risk in 32080 and how does it affect insurance costs and investment returns?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_064_im_a_buyer_evaluating_a', description: '[Realtor] I\'m a buyer evaluating a beach condo in 32080 as a primary residence — what\'s the HOA landscape and price per square foot?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_065_what_percentage_of_32080_properties', description: '[Realtor] What percentage of 32080 properties are used as short-term rentals versus full-time residences?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_066_is_32080_subject_to_shortterm', description: '[Realtor] Is 32080 subject to short-term rental restrictions or is it an open STR market?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_067_whats_the_luxury_beach_home', description: '[Realtor] What\'s the luxury beach home market in 32080 — oceanfront properties above $2M?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_068_what_infrastructure_or_public_investment', description: '[Realtor] What infrastructure or public investment is planned for St. Augustine Beach that could affect 32080 values?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_069_whats_the_buyer_origin_for', description: '[Realtor] What\'s the buyer origin for 32080 purchasers — in-state versus out-of-state buyers?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_070_is_there_a_1031_exchange', description: '[Realtor] Is there a 1031 exchange opportunity in 32080 — vacation rental properties with proven income history?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_071_compare_median_home_prices_across', description: '[Realtor] Compare median home prices across all six St. Johns County ZIPs — which is the most and least expensive?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_072_which_st_johns_county_zip', description: '[Realtor] Which St. Johns County ZIP has the highest appreciation rate over the past 5 years?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_073_whats_the_total_residential_transaction', description: '[Realtor] What\'s the total residential transaction volume across St. Johns County in the last 12 months?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_074_which_st_johns_county_zip', description: '[Realtor] Which St. Johns County ZIP has the fastest days-on-market velocity?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_075_im_an_institutional_investor_evaluating', description: '[Realtor] I\'m an institutional investor evaluating a build-to-rent community in St. Johns County — which ZIP has the best combination of land cost, absorption rate, and renter demand?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_076_whats_the_flood_zone_exposure', description: '[Realtor] What\'s the flood zone exposure map for St. Johns County — which ZIPs have the highest percentage of properties in FEMA Zone AE or VE?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_077_which_zip_code_in_st', description: '[Realtor] Which ZIP code in St. Johns County has the highest short-term rental income potential?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_078_how_does_the_school_district', description: '[Realtor] How does the school district quality in St. Johns County affect home prices across the different ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_079_whats_the_commercial_cap_rate', description: '[Realtor] What\'s the commercial cap rate environment across St. Johns County for NNN retail and medical office?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_080_im_a_1031_exchange_buyer', description: '[Realtor] I\'m a 1031 exchange buyer with $1.5M to deploy in St. Johns County — where are the best NNN or net lease opportunities?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_081_whats_the_correlation_between_new', description: '[Realtor] What\'s the correlation between new construction permits and resale price appreciation across the St. Johns County ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_082_is_st_johns_county_seeing', description: '[Realtor] Is St. Johns County seeing net migration from other Florida counties or only from out-of-state markets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_083_whats_the_buyer_agent_density', description: '[Realtor] What\'s the buyer agent density across St. Johns County — are there underserved ZIPs where a new agent could build market share?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_084_what_does_the_price_tier', description: '[Realtor] What does the price tier distribution look like in St. Johns County — what share of homes are in the $300-500K, $500K-$1M, and $1M+ buckets?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_085_im_a_developer_evaluating_a', description: '[Realtor] I\'m a developer evaluating a mixed-use project in St. Johns County — which ZIP has the strongest demand signal for retail-over-residential?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_086_whats_the_impact_of_the', description: '[Realtor] What\'s the impact of the I-95 corridor on property values in 32086 and 32092?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32086' }] },
          { name: 're_087_how_does_investor_activity_cash', description: '[Realtor] How does investor activity (cash buyers, LLC purchases) differ across St. Johns County ZIPs?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_088_whats_the_luxury_home_market', description: '[Realtor] What\'s the luxury home market trend in 32082 — properties above $3M and who is buying them?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_089_is_there_a_missing_middle', description: '[Realtor] Is there a missing middle housing opportunity (townhomes, duplexes) anywhere in St. Johns County?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_090_what_does_the_rental_vacancy', description: '[Realtor] What does the rental vacancy rate look like across the St. Johns County ZIPs — where is rental demand strongest?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_091_im_a_realtor_advising_a', description: '[Realtor] I\'m a realtor advising a seller in 32082 — what\'s the current absorption rate and should they price at, above, or below recent comps?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_092_how_does_proximity_to_the', description: '[Realtor] How does proximity to the beach affect the premium paid per square foot in 32080 versus 32082?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_093_whats_the_new_construction_lot', description: '[Realtor] What\'s the new construction lot supply in 32081 and how many months of inventory remain at the current absorption rate?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_094_how_does_the_nocatee_cdd', description: '[Realtor] How does the Nocatee CDD (Community Development District) assessment affect buyer purchasing power and resale values in 32081?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_095_is_there_a_condo_and', description: '[Realtor] Is there a condo and townhome market gap in 32084 for buyers wanting a St. Augustine lifestyle at a lower price point?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32084' }] },
          { name: 're_096_whats_the_price_per_square', description: '[Realtor] What\'s the price per square foot for oceanfront versus ocean-view versus off-water properties in 32080 — and how large is the premium gap?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32080' }] },
          { name: 're_097_is_there_an_opportunity_for', description: '[Realtor] Is there an opportunity for a boutique real estate brokerage specializing in 55+ communities in St. Johns County — what\'s the size of that buyer segment?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_098_what_does_the_absorption_rate', description: '[Realtor] What does the absorption rate look like for attached product (condos and townhomes) in 32081 versus 32082 — which market has more demand relative to supply?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32081' }] },
          { name: 're_099_im_a_relocation_specialist_helping', description: '[Realtor] I\'m a relocation specialist helping corporate transferees move to Jacksonville — what percentage of my clients should I be steering toward St. Johns County ZIPs versus Duval County based on school quality and commute time?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
          { name: 're_100_whats_the_pipeline_of_agerestricted', description: '[Realtor] What\'s the pipeline of age-restricted (55+) community development in St. Johns County and which ZIPs are seeing the most activity?', arguments: [{ name: 'zip', description: 'ZIP code (e.g. 32082, 32081, 32084)', required: false, default: '32082' }] },
        ],
      },
    };
  }

  if (method === 'resources/list') {
    // Dynamically build resource list from whatever ZIPs are in the live dataset
    const allData = loadData();
    const zipCounts = {};
    for (const biz of allData) {
      if (biz.zip) zipCounts[biz.zip] = (zipCounts[biz.zip] || 0) + 1;
    }
    const ZIP_LABELS = {
      // Core St Johns County
      '32082': 'Ponte Vedra Beach',
      '32081': 'Nocatee',
      '32092': 'World Golf Village',
      '32084': 'St. Augustine',
      '32086': 'St. Augustine South',
      '32095': 'Palm Valley',
      '32080': 'St. Augustine Beach',
      // Expansion — top priority
      '32259': 'Fruit Cove / Saint Johns',
      '32250': 'Jacksonville Beach',
      '32266': 'Neptune Beach',
      '32258': 'Bartram Park',
      '32226': 'North Jacksonville',
      '32003': 'Fleming Island',
      '32034': 'Fernandina Beach',
      '32065': 'Orange Park / Oakleaf',
      '32097': 'Yulee',
      // Jacksonville Southside (existing data)
      '32256': 'Baymeadows / Tinseltown',
      '32257': 'Mandarin South',
      '32224': 'Jacksonville Intracoastal',
      '32225': 'Jacksonville Arlington',
      '32246': 'Jacksonville Regency',
      '32233': 'Atlantic Beach',
      '32211': 'Jacksonville East',
      '32216': 'Southside Blvd',
      '32217': 'San Jose',
      '32207': 'Jacksonville Southbank',
      '32073': 'Orange Park',
    };
    const resources = Object.entries(zipCounts).sort().map(([zip, count]) => ({
      uri: `localintel://coverage/${zip}`,
      name: `ZIP ${zip} Coverage Report`,
      description: `${ZIP_LABELS[zip] || 'St. Johns County'} (${zip}) — ${count} businesses in live dataset.`,
      mimeType: 'application/json',
    }));
    // Add a system-wide summary resource
    resources.unshift({
      uri: 'localintel://coverage/all',
      name: 'Full Coverage Summary',
      description: `All ${Object.keys(zipCounts).length} ZIPs in LocalIntel — ${allData.length} total businesses.`,
      mimeType: 'application/json',
    });
    return { jsonrpc: '2.0', id, result: { resources } };
  }



  if (method === 'tools/call') {
    const toolName = params?.name;
    const toolArgs = params?.arguments || {};
    const caller   = params?._caller || 'unknown';

    if (!TOOLS[toolName]) {
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
    }

    try {
      const t0 = Date.now();
      const result = await Promise.resolve(TOOLS[toolName].fn(toolArgs));
      const latency = Date.now() - t0;
      // Extract zip + intent for observability (present on local_intel_ask results)
      const parsed = (typeof result === 'object' && result !== null) ? result : {};
      logUsage(toolName, caller, {
        entry:   params?._entry || 'free',
        zip:     toolArgs?.zip || parsed?.zip || null,
        intent:  parsed?.intent || null,
        latency,
      });
      return {
        jsonrpc: '2.0', id,
        result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
          _meta: { cost_pathusd: TOOL_COSTS[toolName] || 0, latency_ms: latency },
        },
      };
    } catch (e) {
      return { jsonrpc: '2.0', id, error: { code: -32603, message: e.message } };
    }
  }

  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Health
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, server: 'LocalIntel MCP', version: '1.0.0', tools: Object.keys(TOOLS).length }));
  }

  // MCP manifest (for discovery)
  if (req.method === 'GET' && req.url === '/manifest') {
    res.writeHead(200);
    return res.end(JSON.stringify(MCP_MANIFEST));
  }

  // JSON-RPC endpoint
  if (req.method === 'POST' && (req.url === '/' || req.url === '/mcp')) {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(body);
        // Handle batch requests
        if (Array.isArray(parsed)) {
          const responses = (await Promise.all(parsed.map(handleRPC))).filter(Boolean);
          res.writeHead(200);
          return res.end(JSON.stringify(responses));
        }
        const response = await handleRPC(parsed);
        if (response === null) {
          res.writeHead(204);
          return res.end();
        }
        res.writeHead(200);
        res.end(JSON.stringify(response));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found. POST /mcp for JSON-RPC, GET /manifest for tool list.' }));
});

// Only bind the HTTP server when run directly (forked worker).
// When require()'d by localIntelTidalTools or localIntelAcpCycle, skip listen
// to avoid EADDRINUSE on port 3004.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[LocalIntelMCP] MCP server listening on port ${PORT}`);
    console.log(`[LocalIntelMCP] ${Object.keys(TOOLS).length} tools registered`);
    console.log(`[LocalIntelMCP] Covered zips: ${Object.keys(ZIP_CENTERS).join(', ')}`);
  });
}

// _tools: lazy export consumed by callTool() in localIntelTidalTools.js
module.exports = { handleRPC, MCP_MANIFEST, _tools: TOOLS };
