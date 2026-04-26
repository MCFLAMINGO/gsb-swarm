'use strict';
/**
 * localIntelTidalTools.js — LocalIntel Tidal Layer Tool Handlers
 *
 * Exports the 4 new MCP tool handler functions consumed by localIntelMCP.js.
 * Each function takes (params) and returns a plain result object — NOT wrapped
 * in a JSON-RPC / MCP envelope (the MCP server does that).
 *
 * Tools:
 *   handleTide(params)     — local_intel_tide     ($0.02)
 *   handleSignal(params)   — local_intel_signal   ($0.03)
 *   handleBedrock(params)  — local_intel_bedrock  ($0.02)
 *   handleForAgent(params) — local_intel_for_agent ($0.05)
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, 'data');

const { computeSignalBlock } = require('./workers/mcpMiddleware');

// ── ZIP center table (mirrors localIntelMCP.js) ───────────────────────────────
const ZIP_CENTERS = {
  '32082': { lat: 30.1893, lon: -81.3815, label: 'Ponte Vedra Beach' },
  '32081': { lat: 30.1100, lon: -81.4175, label: 'Nocatee' },
};

// ── Safe JSON reader ──────────────────────────────────────────────────────────
function readLayerFile(subDir, zip) {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(DATA_DIR, subDir, `${zip}.json`), 'utf8')
    );
  } catch {
    return {};
  }
}

// ── Resolve ZIP from params ───────────────────────────────────────────────────
function resolveZip(params) {
  if (params.zip) return String(params.zip);
  if (params.lat && params.lon) {
    const lat = parseFloat(params.lat);
    const lon = parseFloat(params.lon);
    // Find nearest ZIP center by simple Euclidean distance
    let nearest = null;
    let nearestDist = Infinity;
    for (const [z, center] of Object.entries(ZIP_CENTERS)) {
      const d = Math.hypot(lat - center.lat, lon - center.lon);
      if (d < nearestDist) { nearestDist = d; nearest = z; }
    }
    return nearest || '32081';
  }
  return '32081'; // fallback to Nocatee
}

// ── ─────────────────────────────────────────────────────────────────────────
// HANDLER 1: handleTide
// ── ─────────────────────────────────────────────────────────────────────────

/**
 * local_intel_tide — ZIP temperature and tidal state composite.
 *
 * Input:  { zip, include_layers: ["bedrock","ocean_floor","surface_current","wave_surface"] }
 * Output: { zip, temperature, tidal_state, current_direction, seasonal_bias,
 *            seasonal_index, layers_available, signal_block, context_block }
 */
function handleTide(params) {
  try {
    const zip = resolveZip(params);
    const includeLayers = params.include_layers || ['bedrock', 'ocean_floor', 'surface_current', 'wave_surface'];

    // ── Load requested layers ───────────────────────────────────────────────
    const bedrock = includeLayers.includes('bedrock')         ? readLayerFile('bedrock',         zip) : {};
    const ocean   = includeLayers.includes('ocean_floor')     ? readLayerFile('ocean_floor',     zip) : {};
    const surface = includeLayers.includes('surface_current') ? readLayerFile('surface_current', zip) : {};
    const wave    = includeLayers.includes('wave_surface')    ? readLayerFile('wave_surface',    zip) : {};

    const layersAvailable = [];
    if (Object.keys(bedrock).length) layersAvailable.push('bedrock');
    if (Object.keys(ocean  ).length) layersAvailable.push('ocean_floor');
    if (Object.keys(surface).length) layersAvailable.push('surface_current');
    if (Object.keys(wave   ).length) layersAvailable.push('wave_surface');

    // ── computeZipTemperature algorithm (from spec) ─────────────────────────
    const bedrockScore = bedrock.infrastructure_momentum_score != null
      ? bedrock.infrastructure_momentum_score
      : 50;
    const bedrockLead = bedrockScore / 100;

    const rawVelocity = surface.velocity_score != null ? surface.velocity_score : 50;
    const dirMultiplier = surface.current_direction === 'flooding' ? 1.2
      : surface.current_direction === 'ebbing' ? 0.7
      : 1.0;
    const surfaceMomentum = (rawVelocity / 100) * dirMultiplier;

    const q24h      = wave.mcp_activity?.queries_24h    || 0;
    const avgDailyQ = wave.mcp_activity?.avg_daily_queries || 1;
    const waveSignal = Math.min(30, (q24h / Math.max(1, avgDailyQ)) * 20);

    const temperature = Math.round(
      (bedrockLead * 35) +
      (surfaceMomentum * 35) +
      waveSignal
    );

    // ── Tidal state ─────────────────────────────────────────────────────────
    const tidalState     = wave.tidal_state?.state    || surface.current_direction || 'slack';
    const currentDir     = surface.current_direction  || wave.tidal_state?.state  || 'stable';
    const seasonalBias   = surface.seasonal_patterns?.seasonal_bias   || 'year_round';
    const seasonalIndex  = surface.seasonal_patterns?.seasonal_index  || 1.0;

    // ── signal_block ────────────────────────────────────────────────────────
    const agentType  = params.agent_type || (params.query_context?.agent_type) || null;
    const signalBlock = computeSignalBlock(zip, agentType, { zip, temperature });

    // ── context_block ────────────────────────────────────────────────────────
    const contextBlock = [
      `ZIP ${zip} is currently ${tidalState}.`,
      `Temperature ${temperature}/100.`,
      signalBlock.top_signal + '.',
      `Best suited for ${(signalBlock.agent_priority || []).join(', ') || 'general'} agents.`,
    ].join(' ');

    return {
      zip,
      temperature,
      tidal_state:    tidalState,
      current_direction: currentDir,
      seasonal_bias:  seasonalBias,
      seasonal_index: seasonalIndex,
      layers_available: layersAvailable,
      signal_block:   signalBlock,
      context_block:  contextBlock,
    };

  } catch (err) {
    const zip = params.zip || 'unknown';
    return {
      zip,
      temperature:      50,
      tidal_state:      'slack',
      current_direction: 'stable',
      seasonal_bias:    'year_round',
      seasonal_index:   1.0,
      layers_available: [],
      signal_block: {
        score:               50,
        direction:           'stable',
        confidence:          0,
        top_signal:          'Error computing tide',
        predicted_state_90d: 'unknown',
        agent_priority:      [],
        freshness_warning:   err.message,
      },
      context_block: `handleTide error for ${zip}: ${err.message}`,
    };
  }
}

// ── ─────────────────────────────────────────────────────────────────────────
// HANDLER 2: handleSignal
// ── ─────────────────────────────────────────────────────────────────────────

/**
 * local_intel_signal — Investment signal scoring for a ZIP.
 *
 * Input:  { zip, agent_type }
 * Output: { zip, investment_score, band, top_reasons, avoid_signals,
 *            signal_block, context_block }
 */
function handleSignal(params) {
  try {
    const zip       = resolveZip(params);
    const agentType = params.agent_type || (params.query_context?.agent_type) || null;

    // ── Load layers ─────────────────────────────────────────────────────────
    const bedrock = readLayerFile('bedrock',         zip);
    const ocean   = readLayerFile('ocean_floor',     zip);
    const surface = readLayerFile('surface_current', zip);
    const wave    = readLayerFile('wave_surface',    zip);

    // ── computeInvestmentSignal algorithm (from spec) ───────────────────────
    const bedrockSignal = (bedrock.infrastructure_momentum_score != null
      ? bedrock.infrastructure_momentum_score
      : 50) * 0.35;

    const avoidPenalty = bedrock.avoid_signal?.value ? -30 : 0;

    const medIncome       = ocean.demographics?.household_income?.median_household_income || 60000;
    const pctOwner        = ocean.demographics?.housing_occupancy?.pct_owner_occupied     || 0.5;
    const demographic     = ((medIncome / 100000) * 50 + pctOwner * 50) * 0.20;

    const velocitySignal  = (surface.velocity_score != null ? surface.velocity_score : 50) * 0.10;

    const q24h      = wave.mcp_activity?.queries_24h || 0;
    const waveBoost = Math.min(10, q24h) * 0.10 * 10;

    const rawTotal     = bedrockSignal + avoidPenalty + demographic + velocitySignal + waveBoost;
    const investScore  = Math.min(100, Math.max(0, Math.round(rawTotal)));

    // ── Band classification ─────────────────────────────────────────────────
    let band;
    if      (investScore >= 80) band = 'strong_buy';
    else if (investScore >= 60) band = 'accumulate';
    else if (investScore >= 40) band = 'hold';
    else if (investScore >= 20) band = 'reduce';
    else                        band = 'avoid';

    // ── Top reasons ─────────────────────────────────────────────────────────
    const reasons = [];
    if (bedrock.infrastructure_momentum_score >= 60) {
      reasons.push(`Infrastructure momentum ${bedrock.infrastructure_momentum_score}/100 (${bedrock.band || 'building'})`);
    }
    if (medIncome >= 80000) {
      reasons.push(`Affluent consumer base: median household income $${medIncome.toLocaleString()}`);
    }
    if (pctOwner >= 0.65) {
      reasons.push(`High homeownership rate (${Math.round(pctOwner * 100)}%) — stable consumer base`);
    }
    if (surface.velocity_score >= 60) {
      reasons.push(`Strong business velocity score ${surface.velocity_score}/100`);
    }
    if (q24h > 10) {
      reasons.push(`High agent interest: ${q24h} queries in last 24h`);
    }
    if (avoidPenalty < 0) {
      reasons.push(`Avoid signal active: ${bedrock.avoid_signal?.avoid_reason || 'negative infrastructure signals'}`);
    }
    // Pad to 3 if needed
    if (!reasons.length) reasons.push(`Composite investment score: ${investScore}/100`);
    if (reasons.length < 2) reasons.push(`Current tidal direction: ${surface.current_direction || 'stable'}`);
    if (reasons.length < 3) reasons.push(`Bedrock band: ${bedrock.band || 'unknown'}`);

    // ── Avoid signals ────────────────────────────────────────────────────────
    const avoidSignals = [];
    if (bedrock.avoid_signal?.value) {
      avoidSignals.push(bedrock.avoid_signal.avoid_reason || 'negative infrastructure signal');
    }
    if (bedrock.natural_resource_signals?.flood_zones?.flood_zone_direction === 'expanding') {
      avoidSignals.push('Flood zone expanding');
    }

    // ── signal_block ────────────────────────────────────────────────────────
    const signalBlock = computeSignalBlock(zip, agentType, { zip, investment_score: investScore });

    // ── context_block ────────────────────────────────────────────────────────
    const contextBlock = [
      `ZIP ${zip} investment score: ${investScore}/100 (${band}).`,
      reasons.slice(0, 2).join(' | ') + '.',
      avoidSignals.length ? `Caution: ${avoidSignals[0]}.` : '',
    ].filter(Boolean).join(' ');

    return {
      zip,
      investment_score: investScore,
      band,
      top_reasons:   reasons.slice(0, 3),
      avoid_signals: avoidSignals,
      signal_block:  signalBlock,
      context_block: contextBlock,
    };

  } catch (err) {
    const zip = params.zip || 'unknown';
    return {
      zip,
      investment_score: 50,
      band: 'hold',
      top_reasons:   ['Error computing signal'],
      avoid_signals: [],
      signal_block: {
        score: 50, direction: 'stable', confidence: 0,
        top_signal: 'Error', predicted_state_90d: 'unknown',
        agent_priority: [], freshness_warning: err.message,
      },
      context_block: `handleSignal error for ${zip}: ${err.message}`,
    };
  }
}

// ── ─────────────────────────────────────────────────────────────────────────
// HANDLER 3: handleBedrock
// ── ─────────────────────────────────────────────────────────────────────────

/**
 * local_intel_bedrock — Raw bedrock layer data for a ZIP.
 *
 * Input:  { zip }
 * Output: full bedrock data + signal_block
 */
function handleBedrock(params) {
  try {
    const zip        = resolveZip(params);
    const agentType  = params.agent_type || (params.query_context?.agent_type) || null;
    const filePath   = path.join(DATA_DIR, 'bedrock', `${zip}.json`);

    // ── No data case ─────────────────────────────────────────────────────────
    if (!fs.existsSync(filePath)) {
      return {
        zip,
        status: 'no_data',
        signal_block: {
          score:               50,
          direction:           'stable',
          confidence:          0,
          top_signal:          'No bedrock data collected yet for this ZIP',
          predicted_state_90d: 'unknown',
          agent_priority:      [],
          freshness_warning:   'bedrockWorker has not yet run for this ZIP',
        },
      };
    }

    // ── Data exists ──────────────────────────────────────────────────────────
    const bedrock     = readLayerFile('bedrock', zip);
    const signalBlock = computeSignalBlock(zip, agentType, bedrock);

    return {
      ...bedrock,
      zip,
      status:       'ok',
      signal_block: signalBlock,
    };

  } catch (err) {
    const zip = params.zip || 'unknown';
    return {
      zip,
      status: 'error',
      signal_block: {
        score: 50, direction: 'stable', confidence: 0,
        top_signal: 'Error reading bedrock data',
        predicted_state_90d: 'unknown',
        agent_priority: [],
        freshness_warning: err.message,
      },
    };
  }
}

// ── ─────────────────────────────────────────────────────────────────────────
// HANDLER 4: handleForAgent
// ── ─────────────────────────────────────────────────────────────────────────

/**
 * local_intel_for_agent — Premium composite tool ($0.05).
 *
 * Input:  { agent_type, intent, zip, lat, lon, budget, depth: "quick"|"full" }
 * Output: { zip, agent_type, intent, ranked_signals, signal_block,
 *            context_block, suggested_next_tool, delta }
 */
async function handleForAgent(params) {
  try {
    const zip       = resolveZip(params);
    const agentType = params.agent_type || 'default';
    const intent    = params.intent     || '';
    const depth     = params.depth      || 'quick';
    const agentId   = params.agentId    || (params.query_context?.agent_id) || null;

    // ── Load all layers ──────────────────────────────────────────────────────
    const bedrock = readLayerFile('bedrock',         zip);
    const ocean   = readLayerFile('ocean_floor',     zip);
    const surface = readLayerFile('surface_current', zip);
    const wave    = readLayerFile('wave_surface',    zip);

    const hasBedrock = Object.keys(bedrock).length > 0;
    const hasOcean   = Object.keys(ocean).length   > 0;
    const hasSurface = Object.keys(surface).length > 0;
    const hasWave    = Object.keys(wave).length    > 0;

    // ── Build signal pool (all raw signals) ──────────────────────────────────
    const allSignals = {
      // Bedrock signals
      infrastructure_momentum: {
        value:        bedrock.infrastructure_momentum_score || null,
        source_layer: 'bedrock',
        freshness:    bedrock.last_refreshed || null,
        why_relevant: 'Leading indicator of future business density and property value gains',
      },
      permit_count: {
        value:        bedrock.infrastructure_signals?.building_permits?.total_permit_valuation_usd || null,
        source_layer: 'bedrock',
        freshness:    bedrock.last_refreshed || null,
        why_relevant: 'Active construction volume predicts new business anchors opening',
      },
      road_projects: {
        value:        bedrock.infrastructure_signals?.road_projects?.active_road_projects_count || null,
        source_layer: 'bedrock',
        freshness:    bedrock.last_refreshed || null,
        why_relevant: 'FDOT road investment unlocks corridor commerce',
      },
      fdot_active: {
        value:        bedrock.infrastructure_signals?.road_projects?.nearest_project_status || null,
        source_layer: 'bedrock',
        freshness:    bedrock.last_refreshed || null,
        why_relevant: 'Active FDOT project status for nearest transportation investment',
      },
      // Ocean floor signals
      income: {
        value:        ocean.demographics?.household_income?.median_household_income || null,
        source_layer: 'ocean_floor',
        freshness:    ocean.last_refreshed || null,
        why_relevant: 'Median household income determines consumer spending power',
      },
      owner_rate: {
        value:        ocean.demographics?.housing_occupancy?.pct_owner_occupied || null,
        source_layer: 'ocean_floor',
        freshness:    ocean.last_refreshed || null,
        why_relevant: 'High owner-occupancy = stable, rooted consumer base',
      },
      education_pct_bachelor: {
        value:        ocean.demographics?.educational_attainment?.pct_bachelors_or_higher || null,
        source_layer: 'ocean_floor',
        freshness:    ocean.last_refreshed || null,
        why_relevant: 'Education level correlates with discretionary spending and business type demand',
      },
      consumer_profile: {
        value:        ocean.derived_signals?.consumer_profile || null,
        source_layer: 'ocean_floor',
        freshness:    ocean.last_refreshed || null,
        why_relevant: 'Consumer archetype shapes which business categories will thrive',
      },
      business_count: {
        value: (() => {
          try {
            const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'zips', `${zip}.json`), 'utf8'));
            return Array.isArray(data) ? data.length : null;
          } catch { return null; }
        })(),
        source_layer: 'zips',
        freshness:    null,
        why_relevant: 'Current indexed business count — supply side of demand/supply gap',
      },
      // Surface current signals
      velocity_score: {
        value:        surface.velocity_score     || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed     || null,
        why_relevant: 'Composite business creation/destruction momentum',
      },
      current_direction: {
        value:        surface.current_direction  || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed     || null,
        why_relevant: 'Direction of economic flow: flooding=growth, ebbing=contraction',
      },
      net_change_30d: {
        value:        surface.business_lifecycle?.net_change_30d || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed     || null,
        why_relevant: '30-day net business count change — clearest near-term momentum signal',
      },
      birth_rate: {
        value:        surface.business_lifecycle?.birth_rate || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed || null,
        why_relevant: 'New business creation rate — high birth rate = expanding market',
      },
      death_rate: {
        value:        surface.business_lifecycle?.death_rate || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed || null,
        why_relevant: 'Business closure rate — high death rate signals market stress',
      },
      seasonal_bias: {
        value:        surface.seasonal_patterns?.seasonal_bias  || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed || null,
        why_relevant: 'Seasonal pattern determines optimal timing for market entry',
      },
      seasonal_index: {
        value:        surface.seasonal_patterns?.seasonal_index || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed || null,
        why_relevant: 'Current season vs. annual average — >1.2 means above normal activity',
      },
      avg_confidence: {
        value:        surface.confidence_decay?.avg_confidence_score || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed || null,
        why_relevant: 'Data quality score — higher confidence = more reliable signals',
      },
      freshness_grade: {
        value:        surface.confidence_decay?.data_freshness_grade || null,
        source_layer: 'surface_current',
        freshness:    surface.last_refreshed || null,
        why_relevant: 'Overall data freshness grade (A-D) for this ZIP',
      },
      // Wave surface signals
      queries_24h: {
        value:        wave.mcp_activity?.queries_24h || null,
        source_layer: 'wave_surface',
        freshness:    wave.last_event || null,
        why_relevant: 'Real-time agent interest level — high queries = active market research',
      },
      tidal_state: {
        value:        wave.tidal_state?.state || null,
        source_layer: 'wave_surface',
        freshness:    wave.last_event  || null,
        why_relevant: 'Current tidal state from agent activity patterns',
      },
      top_demanded_category: {
        value:        wave.mcp_activity?.top_demanded_categories_30d?.[0]?.category || null,
        source_layer: 'wave_surface',
        freshness:    wave.last_aggregated || null,
        why_relevant: 'Most-requested category by agents — unmet consumer demand signal',
      },
      category_gap_score: {
        value:        wave.mcp_activity?.demand_vs_supply_gaps?.[0]?.gap_ratio || null,
        source_layer: 'wave_surface',
        freshness:    wave.last_aggregated || null,
        why_relevant: 'Highest demand/supply gap ratio — strongest missing business type signal',
      },
      peak_query_hour: {
        value:        wave.mcp_activity?.peak_query_hour_utc ?? null,
        source_layer: 'wave_surface',
        freshness:    wave.last_aggregated || null,
        why_relevant: 'Hour of day with peak agent activity — signals consumer/business hours',
      },
      hotspot_rank: {
        value:        wave.agent_hotspot_rank?.overall_hotspot_rank || null,
        source_layer: 'wave_surface',
        freshness:    wave.last_aggregated || null,
        why_relevant: 'Agent activity rank vs all 36 covered ZIPs',
      },
      missing_business_types: {
        value: (() => {
          const gaps = wave.mcp_activity?.demand_vs_supply_gaps;
          if (Array.isArray(gaps) && gaps.length) {
            return gaps.slice(0, 3).map(g => g.category).join(', ');
          }
          return null;
        })(),
        source_layer: 'wave_surface',
        freshness:    wave.last_aggregated || null,
        why_relevant: 'Categories in highest demand with lowest supply — gap opportunities',
      },
      // Derived
      investment_score: {
        value: (() => {
          try {
            const bs = (bedrock.infrastructure_momentum_score || 50) * 0.35;
            const av = bedrock.avoid_signal?.value ? -30 : 0;
            const mi = ocean.demographics?.household_income?.median_household_income || 60000;
            const po = ocean.demographics?.housing_occupancy?.pct_owner_occupied || 0.5;
            const dm = ((mi / 100000) * 50 + po * 50) * 0.20;
            const vs = (surface.velocity_score || 50) * 0.10;
            const q  = wave.mcp_activity?.queries_24h || 0;
            const wb = Math.min(10, q) * 0.10 * 10;
            return Math.min(100, Math.max(0, Math.round(bs + av + dm + vs + wb)));
          } catch { return null; }
        })(),
        source_layer: 'derived',
        freshness:    null,
        why_relevant: 'Composite investment attractiveness score across all layers',
      },
      predicted_state_90d: {
        value:        null, // filled from signal_block below
        source_layer: 'derived',
        freshness:    null,
        why_relevant: 'Predicted ZIP economic state in 90 days based on leading indicators',
      },
      // Geo
      lat_lon_center: {
        value: ZIP_CENTERS[zip]
          ? `${ZIP_CENTERS[zip].lat},${ZIP_CENTERS[zip].lon}`
          : null,
        source_layer: 'static',
        freshness:    null,
        why_relevant: 'Geographic center of ZIP code for corridor / proximity analysis',
      },
    };

    // ── Agent-type signal priority lists ─────────────────────────────────────
    const priorityMap = {
      real_estate: [
        'infrastructure_momentum', 'permit_count', 'road_projects',
        'income', 'owner_rate', 'velocity_score', 'investment_score',
        'missing_business_types', 'tidal_state', 'predicted_state_90d',
      ],
      financial: [
        'velocity_score', 'queries_24h', 'tidal_state', 'net_change_30d',
        'top_demanded_category', 'seasonal_index', 'birth_rate',
        'death_rate', 'hotspot_rank', 'income',
      ],
      ad_placement: [
        'top_demanded_category', 'category_gap_score', 'consumer_profile',
        'queries_24h', 'peak_query_hour', 'income', 'education_pct_bachelor',
        'business_count', 'seasonal_bias', 'investment_score',
      ],
      logistics: [
        'business_count', 'road_projects', 'current_direction',
        'top_demanded_category', 'freshness_grade', 'lat_lon_center',
        'seasonal_bias', 'fdot_active', 'avg_confidence', 'velocity_score',
      ],
      default: [
        'investment_score', 'tidal_state', 'velocity_score',
        'income', 'business_count', 'queries_24h', 'infrastructure_momentum',
        'top_demanded_category', 'seasonal_bias', 'avg_confidence',
      ],
    };

    const priority = priorityMap[agentType] || priorityMap.default;
    const topFields = depth === 'quick' ? priority.slice(0, 5) : priority;

    // ── Build signal_block and fill predicted_state_90d ─────────────────────
    const signalBlock = computeSignalBlock(zip, agentType, {});
    allSignals.predicted_state_90d.value = signalBlock.predicted_state_90d || null;

    // ── Construct ranked_signals ─────────────────────────────────────────────
    const rankedSignals = topFields.map((field, idx) => {
      const sig = allSignals[field];
      if (!sig) return null;
      return {
        rank:         idx + 1,
        field,
        value:        sig.value,
        source_layer: sig.source_layer,
        freshness:    sig.freshness,
        why_relevant: sig.why_relevant,
      };
    }).filter(Boolean);

    // ── Suggested next tool ─────────────────────────────────────────────────
    let suggestedNextTool = 'local_intel_tide';
    if (agentType === 'real_estate')  suggestedNextTool = 'local_intel_signal';
    if (agentType === 'financial')    suggestedNextTool = 'local_intel_signal';
    if (agentType === 'ad_placement') suggestedNextTool = 'local_intel_nearby';
    if (agentType === 'logistics')    suggestedNextTool = 'local_intel_corridor';

    // ── Delta from agentMemory ───────────────────────────────────────────────
    let delta = null;
    if (agentId) {
      try {
        const agentMemoryWorker = require('./workers/agentMemoryWorker');
        if (typeof agentMemoryWorker.getDelta === 'function') {
          delta = await agentMemoryWorker.getDelta(agentId, zip);
        }
      } catch {
        // agentMemoryWorker not yet available
      }
    }

    // ── context_block ────────────────────────────────────────────────────────
    const zipLabel = ZIP_CENTERS[zip]?.label || zip;
    const contextLines = [
      `Agent: ${agentType} | Intent: ${intent || 'general query'} | ZIP: ${zip} (${zipLabel})`,
      `Top signal: ${signalBlock.top_signal}`,
      `Signal score: ${signalBlock.score}/100 | Direction: ${signalBlock.direction}`,
    ];
    if (rankedSignals.length) {
      contextLines.push(`Key metrics: ${rankedSignals.slice(0, 3).map(s => `${s.field}=${s.value}`).join(' | ')}`);
    }
    if (signalBlock.freshness_warning) {
      contextLines.push(`Note: ${signalBlock.freshness_warning}`);
    }
    const contextBlock = contextLines.join('\n');

    // ── Freshness warning roll-up ─────────────────────────────────────────────
    const missingLayers = [];
    if (!hasBedrock) missingLayers.push('bedrock');
    if (!hasOcean  ) missingLayers.push('ocean_floor');
    if (!hasSurface) missingLayers.push('surface_current');
    if (!hasWave   ) missingLayers.push('wave_surface');
    if (missingLayers.length) {
      signalBlock.freshness_warning = [
        signalBlock.freshness_warning,
        `Missing layers: ${missingLayers.join(', ')} — workers may not have run yet`,
      ].filter(Boolean).join('; ');
    }

    return {
      zip,
      agent_type:         agentType,
      intent,
      ranked_signals:     rankedSignals,
      signal_block:       signalBlock,
      context_block:      contextBlock,
      suggested_next_tool: suggestedNextTool,
      delta,
    };

  } catch (err) {
    const zip = params.zip || 'unknown';
    return {
      zip,
      agent_type:          params.agent_type || 'default',
      intent:              params.intent     || '',
      ranked_signals:      [],
      signal_block: {
        score: 50, direction: 'stable', confidence: 0,
        top_signal: 'Error computing for-agent composite',
        predicted_state_90d: 'unknown',
        agent_priority: [],
        freshness_warning: err.message,
      },
      context_block:       `handleForAgent error for ${zip}: ${err.message}`,
      suggested_next_tool: 'local_intel_tide',
      delta:               null,
    };
  }
}

// ── ─────────────────────────────────────────────────────────────────────────
// HANDLER 5: handleAsk
// ── ─────────────────────────────────────────────────────────────────────────

/**
 * local_intel_ask — Natural language composite query.
 *
 * The front door for humans and LLMs alike.
 * Takes any plain-English question, routes internally across all data layers,
 * synthesizes a single sourced answer with confidence score.
 *
 * Input:  { question, zip? }
 * Output: { answer, sources, confidence, zip, intent, tools_used, data }
 */

// Intent classification — maps question patterns to which tools to invoke
const ASK_ROUTES = [
  // Demographics / income / population
  {
    patterns: [/income|household|median|wealth|affluent|hhi|earning|salary/i,
               /owner.occup|homeowner|renter|rent|home value|property value/i,
               /population|resident|demographic|age|senior|family|household size/i,
               /education|college|bachelor|spending profile|consumer profile/i],
    tools: ['zone'],
    label: 'demographics',
  },
  // Market gaps / opportunity / saturation
  {
    patterns: [/gap|undersupplied|missing|unmet|need|opportunity|room for/i,
               /saturat|oversupplied|too many|enough/i,
               /should i open|viable|worth opening|good location/i,
               /capture rate|demand|supply/i],
    tools: ['oracle', 'zone'],
    label: 'market_opportunity',
  },
  // Construction / permits / infrastructure
  {
    patterns: [/permit|construction|build|develop|infrastructure|road|highway/i,
               /housing start|new home|subdivision|project|zoning/i,
               /roofing|hvac|electrician|plumber|landscap|contractor/i,
               /pool|remodel|renovation|addition/i],
    tools: ['bedrock', 'search'],
    label: 'construction',
  },
  // Investment / momentum / signals
  {
    patterns: [/invest|signal|momentum|score|trajectory|trend|grow/i,
               /appreciation|value increas|hot market|up.and.coming/i,
               /tidal|temperature|market.*direct/i],
    tools: ['signal', 'tide', 'bedrock'],
    label: 'investment_signal',
  },
  // Corridor / street specific
  {
    patterns: [/a1a|a-1-a|alternate a1a|palm valley|us.1|us 1|state road/i,
               /corridor|along|on the road|street|boulevard|avenue/i],
    tools: ['corridor', 'search'],
    label: 'corridor',
  },
  // Recent changes / new businesses
  {
    patterns: [/new|recent|just opened|opening|added|latest|this (month|year|week)/i,
               /what.*changed|what.*new|who.*moved/i],
    tools: ['changes', 'search'],
    label: 'recent_changes',
  },
  // Healthcare
  {
    patterns: [/dentist|doctor|physician|clinic|hospital|pharmacy|health|medical/i,
               /optom|vision|physical.therap|urgent.care|mental.health|counseling/i,
               /rehab|wellness|fitness|gym|senior.*care|home.*health/i],
    tools: ['search', 'zone'],
    label: 'healthcare',
  },
  // Food / restaurants
  {
    patterns: [/restaurant|cafe|bar|dining|food|pizza|sushi|burger|breakfast|lunch|dinner/i,
               /fast.casual|fine.dining|upscale|coffee|brewery|wine bar/i],
    tools: ['search', 'oracle'],
    label: 'food_beverage',
  },
  // Retail
  {
    patterns: [/retail|store|shop|grocery|supermarket|clothing|apparel|boutique/i,
               /hardware|home.improve|pet|florist|gift|book|specialty/i],
    tools: ['search', 'zone'],
    label: 'retail',
  },
  // Nearby / radius
  {
    patterns: [/nearby|near me|within.*miles|radius|close to|around here/i,
               /walking distance|drive from|minutes from/i],
    tools: ['nearby', 'search'],
    label: 'nearby',
  },
  // Demographic inference — age cohorts, school graduation, empty nest, household formation
  {
    patterns: [
      /graduat|high school|senior.*class|class of \d{4}|graduating/i,
      /empty.?nest|kids.*left|children.*left|nest.*empty/i,
      /age.*cohort|age.*distribut|age.*breakdown|median age/i,
      /household.*formation|new household|family.*formation/i,
      /how many.*kids|how many.*children|school.age|K.?12/i,
      /boomer|millennial|gen.?z|gen.?x|generation/i,
      /retire|retiree|retirement|aging.*population|senior.*population/i,
      /birth.?rate|fertility|young.*family|young.*couple/i,
    ],
    tools: ['zone', 'demographic_inference'],
    label: 'demographic_inference',
  },
];

// Extract ZIP from natural language
function extractZip(question) {
  const m = question.match(/\b(3[0-9]{4})\b/);
  return m ? m[1] : null;
}

// Extract street name from question
function extractStreetFromQ(question) {
  const m = question.match(/\bA1A\b|\bA-1-A\b|Alternate A1A/i);
  if (m) return 'A1A';
  const s = question.match(/along\s+([A-Z][a-zA-Z\s]{2,20}(?:Rd|Ave|Blvd|Dr|Ln|St|Way)?)/i);
  return s ? s[1].trim() : 'A1A';
}

// ── Demographic Inference Engine ─────────────────────────────────────────────
// Derives age cohorts, school graduation counts, empty nest projections,
// and household formation signals from Census ACS base data + known SJC ratios.
//
// St Johns County public demographic benchmarks (Census ACS 2022, SJCSD enrollment data):
//   - Median age: 38.2 (SJC county, 2022)
//   - Pct population age 5-17 (school age): ~18.5% (SJC is a top-ranked school district,
//     draws families with children above state average)
//   - Pct population age 18-24: ~6.8%
//   - Pct population age 25-44: ~25.1%
//   - Pct population age 45-64: ~28.4%
//   - Pct population age 65+: ~18.9%
//   - Avg household size SJC: 2.71 (Census 2020)
//   - HS graduation rate SJC: 95.2% (FLDOE 2023 — #1 or #2 in FL every year)
//   - Annual K-12 cohort size: school-age pop / 13 grades
//   - Empty nest trigger: 18-yr-old leaves → owner-occupied household with 0 remaining children
//   - Pct of owner-occupied households that are family households with children: ~44% (SJC ACS)
//   - Boomer peak birth years: 1946-1964 → age 60-78 in 2024
//   - Millennial peak birth: 1981-1996 → age 28-43 in 2024 → primary home-buying cohort

const SJC_DEMO_RATIOS = {
  pct_age_0_4:   0.057,
  pct_age_5_17:  0.185,  // school-age
  pct_age_18_24: 0.068,
  pct_age_25_44: 0.251,
  pct_age_45_64: 0.284,
  pct_age_65_plus: 0.189,  // above FL average — affluent retirees
  median_age: 38.2,
  avg_household_size: 2.71,
  hs_graduation_rate: 0.952,  // FLDOE — SJC is top-ranked
  pct_family_hh_with_children: 0.44, // of owner-occupied
  grades_k12: 13,
  // Empty nest: among family-HH-with-children, share that will transition in a given year
  // = (children in K-12) / (K-12 years * households with children)
  // approximated as 1/13 of households-with-children lose their last child each year
  // but last-child rate is lower — about 1/3 of K-12 grads are the youngest child
  pct_graduates_are_last_child: 0.34,
};

function handleDemographicInference({ zip, question, zoneData }) {
  const pop        = zoneData?.population        || 0;
  const ownerUnits = zoneData?.owner_occupied_units || 0;
  const ownerRate  = (zoneData?.ownership_rate   || 82) / 100;

  if (!pop) {
    return { error: 'No population data available for this ZIP. Try a covered ZIP like 32082 or 32081.' };
  }

  const R = SJC_DEMO_RATIOS;

  // ── Age cohort estimates ────────────────────────────────────────────────────
  const cohorts = {
    children_0_4:    Math.round(pop * R.pct_age_0_4),
    school_age_5_17: Math.round(pop * R.pct_age_5_17),
    young_adult_18_24: Math.round(pop * R.pct_age_18_24),
    prime_workforce_25_44: Math.round(pop * R.pct_age_25_44),
    pre_retire_45_64: Math.round(pop * R.pct_age_45_64),
    senior_65_plus:  Math.round(pop * R.pct_age_65_plus),
  };

  // ── High school seniors (grade 12 = 1/13 of school-age pop) ───────────────
  const annualHSGrads = Math.round((cohorts.school_age_5_17 / R.grades_k12) * R.hs_graduation_rate);

  // ── Empty nest calculations ────────────────────────────────────────────────
  // Owner-occupied family households that currently have children:
  const ownerHHwithChildren = Math.round(ownerUnits * R.pct_family_hh_with_children);

  // Each year, 1/13 of school-age children graduate. Of those graduates,
  // ~34% are the last/only child in their household → that HH becomes empty nest.
  const newEmptyNestsPerYear = Math.round(annualHSGrads * R.pct_graduates_are_last_child);

  // Current estimated empty nesters = 65+ age cohort households (proxy)
  // + 45-64 whose children have likely already left (assume 60% of 45-64 HHs are now empty)
  const existingEmptyNestHH = Math.round(
    (cohorts.senior_65_plus / R.avg_household_size) +
    (cohorts.pre_retire_45_64 / R.avg_household_size * 0.60)
  );

  // Peak empty nest: when the millennial family cohort (25-44 today) starts graduating
  // their children. Millennial kids mostly born 2005-2018, graduating 2023-2036.
  // Peak will be ~2028-2032 for this ZIP based on current school enrollment trajectory.
  const currentYear = new Date().getFullYear();
  const peakEmptyNestYear  = 2030;  // midpoint of projected peak window for 32082/32081
  const peakEmptyNestRange = '2028–2033';
  const yearsToPeak = peakEmptyNestYear - currentYear;

  // ── Household formation signals ────────────────────────────────────────────
  // New young adults (18-24) who may form new households: ~15% of that cohort annually
  const newHHFormationAnnual = Math.round(cohorts.young_adult_18_24 * 0.15);

  // ── Generation breakdown ───────────────────────────────────────────────────
  // Boomers: born 1946-1964, age 60-78 in 2024 → subset of 65+ + upper 45-64
  const boomers = Math.round(pop * 0.16);  // ~16% of SJC pop (estimated)
  const millennials = Math.round(pop * R.pct_age_25_44 * 0.80); // most of 28-43
  const genZ = Math.round(pop * R.pct_age_18_24 * 0.70);  // 18-26 range

  // ── Business implications ─────────────────────────────────────────────────
  const implications = [];

  if (/graduat|high school|senior.*class|class of/i.test(question)) {
    implications.push(`~${annualHSGrads.toLocaleString()} students graduate high school annually from ${zip} (SJCSD 95.2% graduation rate applied to local cohort).`);
    implications.push(`This feeds ~${Math.round(annualHSGrads * 0.72).toLocaleString()} college enrollments and ~${Math.round(annualHSGrads * 0.28).toLocaleString()} entering workforce directly.`);
  }

  if (/empty.?nest|kids.*left|children.*left|nest.*empty/i.test(question)) {
    implications.push(`~${newEmptyNestsPerYear.toLocaleString()} owner-occupied households transition to empty nest status each year in ${zip}.`);
    implications.push(`Current estimated empty-nester households: ~${existingEmptyNestHH.toLocaleString()} (65+ cohort + 45-64 post-children households).`);
    implications.push(`Peak empty nest formation window: ${peakEmptyNestRange} — ${yearsToPeak} years away — when the millennial parent cohort (now 28-43, currently raising children) begins graduating their kids.`);
    implications.push(`Business signal: empty nesters in this income bracket ($${(zoneData.median_income||121484).toLocaleString()} HHI) are high-spend on travel, home renovation, wellness, fine dining, and downsizing real estate.`);
  }

  if (/retire|senior|aging|65/i.test(question)) {
    implications.push(`~${cohorts.senior_65_plus.toLocaleString()} residents age 65+ (${(R.pct_age_65_plus*100).toFixed(1)}% of population — above FL average of 21%).`);
    implications.push(`Senior cohort drives demand for: home health, assisted living, concierge medicine, physical therapy, financial advisory.`);
  }

  if (/millennial|young.*famil|generat/i.test(question)) {
    implications.push(`~${millennials.toLocaleString()} millennials (est. age 28-43) — this is the dominant homebuyer and family-formation cohort in ${zip}.`);
    implications.push(`Millennial household spend profile: childcare, youth sports, casual dining, home improvement, subscription services.`);
  }

  return {
    zip,
    source: 'Census ACS 2022 + SJCSD enrollment data + SJC demographic ratios',
    note: 'Estimates derived from SJC county ratios applied to ZIP population — directionally accurate, not exact Census tract data.',
    population: pop,
    cohorts,
    high_school: {
      annual_graduates: annualHSGrads,
      graduation_rate_pct: (R.hs_graduation_rate * 100).toFixed(1),
      school_age_population: cohorts.school_age_5_17,
      note: 'St Johns County School District — ranked top 1-2 in Florida annually by FLDOE',
    },
    empty_nest: {
      new_per_year: newEmptyNestsPerYear,
      existing_estimated: existingEmptyNestHH,
      owner_hh_with_children: ownerHHwithChildren,
      peak_window: peakEmptyNestRange,
      peak_year: peakEmptyNestYear,
      years_to_peak: yearsToPeak,
      note: 'Peak driven by millennial parent cohort currently ages 28-43, children graduating 2028-2033',
    },
    household_formation: {
      new_households_annual_est: newHHFormationAnnual,
    },
    generations: { boomers, millennials, gen_z: genZ },
    business_implications: implications,
  };
}

// Classify intent from question
function classifyIntent(question) {
  for (const route of ASK_ROUTES) {
    if (route.patterns.some(p => p.test(question))) {
      return route;
    }
  }
  // Default: general search
  return { tools: ['search', 'zone'], label: 'general' };
}

// Load MCP tool handlers lazily (avoid circular require at module init)
function getMCPTools() {
  const mcp = require('./localIntelMCP');
  return mcp._tools || null;
}

// Call a tool by name using localIntelMCP's internal tool map
function callTool(toolName, params) {
  try {
    const tools = require('./localIntelMCP')._tools;
    if (!tools || !tools[toolName]) return null;
    const result = tools[toolName].fn(params);
    if (typeof result === 'string') {
      try { return JSON.parse(result); } catch { return { raw: result }; }
    }
    return result;
  } catch (e) {
    return { error: e.message };
  }
}

// Synthesize a human-readable answer from multi-tool results
function synthesize(question, intent, zip, results) {
  const parts = [];
  const sources = [];
  let confidence = 0;
  let dataPoints = 0;

  // Zone / demographics
  if (results.zone && !results.zone.error) {
    const z = results.zone;
    const income = z.median_income || z.demographics?.median_household_income;
    const homeVal = z.median_home_value || z.demographics?.median_home_value;
    const pop = z.population || z.demographics?.population;
    const ownership = z.ownership_rate;
    if (income)    { parts.push(`Median household income: $${income.toLocaleString()}`); dataPoints++; }
    if (homeVal)   { parts.push(`Median home value: $${homeVal.toLocaleString()}`); dataPoints++; }
    if (pop)       { parts.push(`Population: ${pop.toLocaleString()}`); dataPoints++; }
    if (ownership) { parts.push(`Homeownership rate: ${ownership}%`); dataPoints++; }
    const label = z.zone_label || z.dominant_spend;
    if (label) { parts.push(`Zone profile: ${label}`); dataPoints++; }
    sources.push({ tool: 'local_intel_zone', layer: 'Census ACS + spending model', zip });
    confidence = Math.max(confidence, 80);
  }

  // Oracle / market gaps
  if (results.oracle && !results.oracle.error) {
    const o = typeof results.oracle === 'string' ? JSON.parse(results.oracle) : results.oracle;
    if (o.oracle_narrative) { parts.push(o.oracle_narrative); dataPoints++; }
    if (o.restaurant_capacity) {
      const rc = o.restaurant_capacity;
      parts.push(`Restaurant market: ${rc.saturation_status} · ${rc.restaurant_count} restaurants · ${rc.capture_rate_pct}% capture rate`);
      dataPoints++;
    }
    if (o.market_gaps?.top_gap) {
      parts.push(`Top gap: ${o.market_gaps.top_gap.description}`);
      dataPoints++;
    }
    if (o.growth_trajectory) {
      parts.push(`Growth trajectory: ${o.growth_trajectory.label} (${o.growth_trajectory.confidence} confidence)`);
      dataPoints++;
    }
    sources.push({ tool: 'local_intel_oracle', layer: 'LocalIntel Oracle — market intelligence', zip });
    confidence = Math.max(confidence, 85);
  }

  // Bedrock / permits / infrastructure
  if (results.bedrock && !results.bedrock.error) {
    const b = results.bedrock;
    if (b.infrastructure_momentum_score !== undefined) {
      parts.push(`Infrastructure momentum score: ${b.infrastructure_momentum_score}/100`);
      dataPoints++;
    }
    const permits = b.infrastructure_signals?.building_permits?.total_permit_valuation_usd;
    if (permits) { parts.push(`Active permit value: $${(permits/1e6).toFixed(1)}M`); dataPoints++; }
    const roads = b.infrastructure_signals?.road_projects?.active_road_projects_count;
    if (roads) { parts.push(`Active road projects: ${roads}`); dataPoints++; }
    sources.push({ tool: 'local_intel_bedrock', layer: 'ArcGIS permits + FDOT road data', zip });
    confidence = Math.max(confidence, 70);
  }

  // Signal / investment
  if (results.signal && !results.signal.error) {
    const s = results.signal;
    const sb = s.signal_block || s;
    if (sb.score !== undefined) {
      parts.push(`Investment signal score: ${sb.score}/100 · ${sb.direction || ''} · ${sb.top_signal || ''}`);
      dataPoints++;
    }
    sources.push({ tool: 'local_intel_signal', layer: 'Composite signal model', zip });
    confidence = Math.max(confidence, 75);
  }

  // Tide
  if (results.tide && !results.tide.error) {
    const t = results.tide;
    if (t.temperature !== undefined) {
      parts.push(`Market temperature: ${t.temperature}/100 · ${t.tidal_state || ''} · ${t.current_direction || ''}`);
      dataPoints++;
    }
    sources.push({ tool: 'local_intel_tide', layer: 'Tidal momentum model', zip });
    confidence = Math.max(confidence, 70);
  }

  // Search results
  if (results.search && !results.search.error && results.search.total > 0) {
    const sr = results.search;
    const top = (sr.results || []).slice(0, 5);
    parts.push(`Found ${sr.total} matching businesses in ${zip}:`);
    top.forEach(b => {
      const line = `  • ${b.name} [${b.category}]${b.address ? ' · ' + b.address : ''}${b.phone ? ' · ' + b.phone : ''}`;
      parts.push(line);
    });
    if (sr.total > 5) parts.push(`  … and ${sr.total - 5} more.`);
    sources.push({ tool: 'local_intel_search', layer: `${sr.total} live businesses (OSM + YP + owner-verified)`, zip });
    confidence = Math.max(confidence, sr.total >= 5 ? 85 : 60);
    dataPoints++;
  }

  // Corridor results
  if (results.corridor && !results.corridor.error && (results.corridor.results || []).length > 0) {
    const cr = results.corridor;
    parts.push(`${cr.corridor} corridor: ${cr.total} businesses`);
    (cr.results || []).slice(0, 5).forEach(b => {
      parts.push(`  • ${b.name} [${b.category}]${b.address ? ' · ' + b.address : ''}`);
    });
    sources.push({ tool: 'local_intel_corridor', layer: 'Corridor analysis', zip });
    confidence = Math.max(confidence, 80);
    dataPoints++;
  }

  // Changes
  if (results.changes && !results.changes.error && (results.changes.results || []).length > 0) {
    const ch = results.changes;
    parts.push(`${ch.results.length} recent additions in ${zip}:`);
    ch.results.slice(0, 5).forEach(b => {
      parts.push(`  • ${b.name} [${b.category}] — added ${b.staleness?.age_days != null ? b.staleness.age_days + 'd ago' : 'recently'}`);
    });
    sources.push({ tool: 'local_intel_changes', layer: 'Recent additions + owner-verified', zip });
    confidence = Math.max(confidence, 75);
    dataPoints++;
  }

  // Nearby
  if (results.nearby && !results.nearby.error && (results.nearby.results || []).length > 0) {
    const nr = results.nearby;
    parts.push(`Nearby businesses (${nr.radius_miles || 1}mi radius):`);
    (nr.results || []).slice(0, 5).forEach(b => {
      parts.push(`  • ${b.name} [${b.category}]${b.distance_miles != null ? ' · ' + b.distance_miles.toFixed(2) + 'mi' : ''}`);
    });
    sources.push({ tool: 'local_intel_nearby', layer: 'Spatial proximity model', zip });
    confidence = Math.max(confidence, 75);
    dataPoints++;
  }

  // Demographic inference
  if (results.demographic_inference && !results.demographic_inference.error) {
    const di = results.demographic_inference;
    const hs = di.high_school;
    const en = di.empty_nest;
    const co = di.cohorts;

    parts.push(`\n── Demographic Profile: ${zip} (pop. ${(di.population||0).toLocaleString()}) ──`);
    parts.push(`Age cohorts (Census ACS 2022 ratios applied to local population):`);
    parts.push(`  • School-age (5-17):   ${(co.school_age_5_17||0).toLocaleString()}`);
    parts.push(`  • Young adults (18-24): ${(co.young_adult_18_24||0).toLocaleString()}`);
    parts.push(`  • Prime working (25-44): ${(co.prime_workforce_25_44||0).toLocaleString()}`);
    parts.push(`  • Pre-retirement (45-64): ${(co.pre_retire_45_64||0).toLocaleString()}`);
    parts.push(`  • Seniors 65+:          ${(co.senior_65_plus||0).toLocaleString()}`);

    if (hs) {
      parts.push(`\nHigh school graduation (annual):`);
      parts.push(`  ~${(hs.annual_graduates||0).toLocaleString()} graduates/year — SJCSD ${hs.graduation_rate_pct}% graduation rate, top-ranked FL district.`);
    }

    if (en) {
      parts.push(`\nEmpty nest transitions:`);
      parts.push(`  • New empty-nest households created per year: ~${(en.new_per_year||0).toLocaleString()}`);
      parts.push(`  • Existing estimated empty-nester households: ~${(en.existing_estimated||0).toLocaleString()}`);
      parts.push(`  • Owner households currently with children: ~${(en.owner_hh_with_children||0).toLocaleString()}`);
      parts.push(`  • Peak empty-nest formation window: ${en.peak_window} (${en.years_to_peak} yrs away)`);
      parts.push(`  • Driver: millennial parent cohort (age 28-43 today) graduating children 2028-2033.`);
    }

    if (di.business_implications?.length) {
      parts.push(`\nInsights:`);
      di.business_implications.forEach(b => parts.push(`  • ${b}`));
    }

    parts.push(`\nNote: ${di.note}`);
    sources.push({ tool: 'local_intel_demographic_inference', layer: di.source, zip });
    confidence = Math.max(confidence, 78);
    dataPoints += 3;
  }

  // Nothing found
  if (parts.length === 0) {
    return {
      answer: `No data found for "${question}" in ${zip}. Try a different ZIP or category.`,
      sources: [],
      confidence: 0,
      data_points: 0,
    };
  }

  // Scale confidence by data density
  if (dataPoints >= 5) confidence = Math.min(100, confidence + 10);
  if (dataPoints <= 1) confidence = Math.max(0, confidence - 20);

  return {
    answer: parts.join('\n'),
    sources,
    confidence,
    data_points: dataPoints,
  };
}

function handleAsk(params) {
  const question = (params.question || params.query || params.q || '').trim();
  if (!question) return { error: 'question required — e.g. { question: "What restaurants are in 32082?" }' };

  // Resolve ZIP: explicit param > extracted from question > default
  const zip = String(params.zip || extractZip(question) || '32082').replace(/\D/g, '').slice(0, 5) || '32082';
  const center = ZIP_CENTERS[zip] || ZIP_CENTERS['32082'];

  // Serve pre-built brief for market overview questions — much richer than raw synthesis
  const isOverviewQuery = /tell me about|overview|summary|what is|describe|market summary|what.s in|what does|general|about this zip|about this market/i.test(question);
  if (isOverviewQuery) {
    try {
      const briefFile = require('path').join(__dirname, 'data', 'briefs', `${zip}.json`);
      if (require('fs').existsSync(briefFile)) {
        const brief = JSON.parse(require('fs').readFileSync(briefFile, 'utf8'));
        return {
          zip,
          intent: 'market_overview',
          source: 'zip_brief',
          brief,
          narrative: brief.narrative,
          tools_used: ['zip_brief_worker'],
          confidence: brief.data_grade === 'A' ? 90 : brief.data_grade === 'B' ? 75 : 60,
        };
      }
    } catch (_) { /* fall through to normal routing */ }
  }

  // Classify intent
  const intent = classifyIntent(question);
  const toolsToRun = intent.tools;

  // Run each tool
  const results = {};
  const toolsUsed = [];

  for (const tool of toolsToRun) {
    try {
      switch (tool) {
        case 'zone':
          results.zone = callTool('local_intel_zone', { zip });
          toolsUsed.push('local_intel_zone');
          break;
        case 'oracle':
          results.oracle = callTool('local_intel_oracle', { zip });
          toolsUsed.push('local_intel_oracle');
          break;
        case 'search':
          results.search = callTool('local_intel_search', { query: question, zip, limit: 10 });
          toolsUsed.push('local_intel_search');
          break;
        case 'bedrock':
          results.bedrock = handleBedrock({ zip });
          toolsUsed.push('local_intel_bedrock');
          break;
        case 'signal':
          results.signal = handleSignal({ zip });
          toolsUsed.push('local_intel_signal');
          break;
        case 'tide':
          results.tide = handleTide({ zip });
          toolsUsed.push('local_intel_tide');
          break;
        case 'corridor':
          results.corridor = callTool('local_intel_corridor', { street: extractStreetFromQ(question), zip });
          toolsUsed.push('local_intel_corridor');
          break;
        case 'changes':
          results.changes = callTool('local_intel_changes', { zip, limit: 10 });
          toolsUsed.push('local_intel_changes');
          break;
        case 'nearby':
          results.nearby = callTool('local_intel_nearby', {
            lat: center.lat, lon: center.lon, radius_miles: 1.5, limit: 10,
          });
          toolsUsed.push('local_intel_nearby');
          break;
        case 'demographic_inference': {
          // Load zone data first if not already loaded
          const zd = results.zone || callTool('local_intel_zone', { zip });
          results.demographic_inference = handleDemographicInference({ zip, question, zoneData: zd });
          toolsUsed.push('local_intel_demographic_inference');
          break;
        }
      }
    } catch (e) {
      results[tool] = { error: e.message };
    }
  }

  // Synthesize answer
  const synthesis = synthesize(question, intent.label, zip, results);

  return {
    question,
    zip,
    zip_label: center?.label || zip,
    intent:    intent.label,
    tools_used: toolsUsed,
    answer:    synthesis.answer,
    confidence: synthesis.confidence,
    data_points: synthesis.data_points,
    sources:   synthesis.sources,
    data:      results,
    ts: new Date().toISOString(),
  };
}

module.exports = { handleTide, handleSignal, handleBedrock, handleForAgent, handleAsk };
