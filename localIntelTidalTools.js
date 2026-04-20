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
function handleForAgent(params) {
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
          delta = agentMemoryWorker.getDelta(agentId, zip);
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

module.exports = { handleTide, handleSignal, handleBedrock, handleForAgent };
