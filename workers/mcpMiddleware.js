'use strict';
/**
 * mcpMiddleware.js — LocalIntel MCP Middleware
 *
 * Wraps MCP tool handlers to:
 *   1. Capture query events (delegates to waveSurfaceWorker.appendEvent)
 *   2. Compute and append signal_block to every tool result
 *
 * Exports:
 *   wrapMCPHandler(toolName, handler)  — returns a wrapped handler function
 *   computeSignalBlock(zip, agentType, result)  — returns signal_block object
 *   rankByPersona(results, agentType)  — re-ranks results array for agent type
 */

const path = require('path');
const fs   = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');

// ── Safe JSON file reader ─────────────────────────────────────────────────────
function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

// ── Data freshness grade → numeric confidence ─────────────────────────────────
// Grade A=100, B=75, C=50, D=25, missing=0
function gradeToScore(grade) {
  if (!grade) return 0;
  switch (String(grade).toUpperCase()) {
    case 'A': return 100;
    case 'B': return 75;
    case 'C': return 50;
    case 'D': return 25;
    default:  return 0;
  }
}

// ── Freshness check — is data file older than 30 days? ───────────────────────
function isStalePath(filePath) {
  try {
    const stat = fs.statSync(filePath);
    const ageDays = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60 * 24);
    return ageDays > 30;
  } catch {
    return false; // file missing — handled separately
  }
}

// ── computeSignalBlock ────────────────────────────────────────────────────────
/**
 * Reads available tidal layer files for a ZIP and returns a signal_block.
 *
 * @param {string} zip
 * @param {string} agentType
 * @param {object} result  — raw tool result (unused directly; here for future extension)
 * @returns {object} signal_block
 */
function computeSignalBlock(zip, agentType, result) {
  try {
    const zipStr = String(zip || '');

    // ── Read available layer files ──────────────────────────────────────────
    const bedrockPath = path.join(DATA_DIR, 'bedrock',        `${zipStr}.json`);
    const surfacePath = path.join(DATA_DIR, 'surface_current', `${zipStr}.json`);
    const wavePath    = path.join(DATA_DIR, 'wave_surface',    `${zipStr}.json`);

    const bedrock = readJson(bedrockPath);
    const surface = readJson(surfacePath);
    const wave    = readJson(wavePath);

    const hasBedrock = Object.keys(bedrock).length > 0;
    const hasSurface = Object.keys(surface).length > 0;
    const hasWave    = Object.keys(wave).length > 0;

    // ── Score (0-100) ───────────────────────────────────────────────────────
    const bedrockMomentum = hasBedrock
      ? (bedrock.infrastructure_momentum_score != null ? bedrock.infrastructure_momentum_score : 50)
      : 50;
    const surfaceVelocity = hasSurface
      ? (surface.velocity_score != null ? surface.velocity_score : 50)
      : 50;

    let waveSignal = 0;
    if (hasWave) {
      const q24h   = wave.mcp_activity?.queries_24h || 0;
      const avgDly = wave.mcp_activity?.avg_daily_queries || 1;
      waveSignal   = Math.min(30, (q24h / Math.max(1, avgDly)) * 20);
    }

    const score = Math.round(
      (bedrockMomentum * 0.35) +
      (surfaceVelocity * 0.35) +
      waveSignal
    );

    // ── Direction ───────────────────────────────────────────────────────────
    // Use whichever layer is fresher
    let direction = 'stable';
    let surfaceTs = 0;
    let waveTs    = 0;
    try { surfaceTs = hasSurface && surface.last_refreshed ? new Date(surface.last_refreshed).getTime() : 0; } catch {}
    try { waveTs    = hasWave    && wave.last_event        ? new Date(wave.last_event).getTime()        : 0; } catch {}

    if (surfaceTs >= waveTs && hasSurface && surface.current_direction) {
      direction = surface.current_direction;
    } else if (hasWave && wave.tidal_state?.state) {
      direction = wave.tidal_state.state;
    } else if (hasSurface && surface.current_direction) {
      direction = surface.current_direction;
    }

    // ── Confidence: average freshness across available layers ───────────────
    const layerScores = [];
    if (hasBedrock) {
      const grade = bedrock.confidence_decay?.data_freshness_grade || (isStalePath(bedrockPath) ? 'C' : 'B');
      layerScores.push(gradeToScore(grade));
    } else {
      layerScores.push(0);
    }
    if (hasSurface) {
      const grade = surface.confidence_decay?.data_freshness_grade || (isStalePath(surfacePath) ? 'C' : 'B');
      layerScores.push(gradeToScore(grade));
    } else {
      layerScores.push(0);
    }
    if (hasWave) {
      layerScores.push(isStalePath(wavePath) ? 50 : 75);
    } else {
      layerScores.push(0);
    }

    const confidence = Math.round(layerScores.reduce((a, b) => a + b, 0) / layerScores.length);

    // ── Top signal (strongest single human-readable signal) ─────────────────
    let topSignal = 'No strong signal detected';
    if (hasBedrock) {
      const permitCount  = bedrock.infrastructure_signals?.building_permits?.total_permit_valuation_usd;
      const roadProjects = bedrock.infrastructure_signals?.road_projects?.active_road_projects_count;
      const momentum     = bedrock.infrastructure_momentum_score;
      if (roadProjects > 0 && momentum >= 60) {
        topSignal = `${roadProjects} active road project${roadProjects !== 1 ? 's' : ''} + infrastructure surge (score ${momentum})`;
      } else if (permitCount > 500000) {
        topSignal = `$${(permitCount / 1e6).toFixed(1)}M in active permits`;
      } else if (momentum >= 40) {
        topSignal = `Infrastructure momentum ${momentum}/100 (${bedrock.band || 'building'})`;
      }
    } else if (hasSurface && surface.velocity_score >= 60) {
      topSignal = `Business velocity ${surface.velocity_score}/100 — ${surface.current_direction || 'active'}`;
    } else if (hasWave && wave.mcp_activity?.queries_24h > 0) {
      topSignal = `${wave.mcp_activity.queries_24h} agent queries in last 24h`;
    }

    // ── Predicted state 90 days out ─────────────────────────────────────────
    const band = hasBedrock ? (bedrock.band || 'building') : 'unknown';
    let predicted90d = 'stable';
    if (['surging', 'erupting'].includes(band) && ['flooding', 'pooling'].includes(direction)) {
      predicted90d = 'accelerating_growth';
    } else if (['dormant', 'stirring'].includes(band) && ['ebbing', 'receding'].includes(direction)) {
      predicted90d = 'continued_slow';
    } else if (['building', 'surging'].includes(band)) {
      predicted90d = 'gradual_growth';
    } else if (direction === 'flooding') {
      predicted90d = 'near_term_activity';
    }

    // ── Agent priority (best agents for this ZIP right now) ─────────────────
    const agentPriority = [];
    if (hasBedrock && (bedrock.infrastructure_momentum_score || 0) >= 50) {
      agentPriority.push('real_estate');
    }
    if (hasSurface && (surface.velocity_score || 0) >= 50) {
      agentPriority.push('financial');
    }
    if (hasWave && (wave.mcp_activity?.queries_24h || 0) > 5) {
      agentPriority.push('ad_placement');
    }
    if (agentPriority.length === 0) {
      agentPriority.push('business_owner', 'logistics');
    }

    // ── Freshness warnings ───────────────────────────────────────────────────
    const warnings = [];
    if (!hasBedrock) warnings.push('bedrock layer missing');
    else if (isStalePath(bedrockPath)) warnings.push('bedrock data > 30 days old');
    if (!hasSurface) warnings.push('surface_current layer missing');
    else if (isStalePath(surfacePath)) warnings.push('surface_current data > 30 days old');
    if (!hasWave) warnings.push('wave_surface layer missing');
    else if (isStalePath(wavePath)) warnings.push('wave_surface data > 30 days old');
    const freshnessWarning = warnings.length > 0 ? warnings.join('; ') : null;

    return {
      score,
      direction,
      confidence,
      top_signal: topSignal,
      predicted_state_90d: predicted90d,
      agent_priority: agentPriority.slice(0, 3),
      freshness_warning: freshnessWarning,
    };

  } catch (err) {
    return {
      score: 50,
      direction: 'stable',
      confidence: 0,
      top_signal: 'Signal computation error',
      predicted_state_90d: 'unknown',
      agent_priority: [],
      freshness_warning: `signal_block error: ${err.message}`,
    };
  }
}

// ── rankByPersona ─────────────────────────────────────────────────────────────
/**
 * Re-ranks an array of business result objects by agent persona.
 *
 * @param {Array}  results    — array of business/result objects
 * @param {string} agentType  — persona key
 * @returns {Array} sorted copy
 */
function rankByPersona(results, agentType) {
  try {
    if (!Array.isArray(results)) return results;
    const sorted = [...results];

    switch (agentType) {
      case 'real_estate':
        // infrastructure_momentum_score DESC, confidence DESC
        sorted.sort((a, b) => {
          const scoreDiff = (b.infrastructure_momentum_score || 0) - (a.infrastructure_momentum_score || 0);
          if (scoreDiff !== 0) return scoreDiff;
          return (b.confidence || 0) - (a.confidence || 0);
        });
        break;

      case 'financial':
        // velocity_score DESC (use confidence as proxy if missing)
        sorted.sort((a, b) => {
          const va = a.velocity_score != null ? a.velocity_score : (a.confidence || 0);
          const vb = b.velocity_score != null ? b.velocity_score : (b.confidence || 0);
          return vb - va;
        });
        break;

      case 'ad_placement':
        // category_gap_score DESC, confidence DESC
        sorted.sort((a, b) => {
          const gapDiff = (b.category_gap_score || 0) - (a.category_gap_score || 0);
          if (gapDiff !== 0) return gapDiff;
          return (b.confidence || 0) - (a.confidence || 0);
        });
        break;

      case 'logistics':
        // corridor density proxy: sort by lon ASC (businesses along A1A, west-to-east)
        sorted.sort((a, b) => (a.lon || 0) - (b.lon || 0));
        break;

      case 'business_owner':
        // recency DESC — most recently added/verified first
        sorted.sort((a, b) => {
          const da = a.addedAt || a.last_updated || a.first_seen || '';
          const db = b.addedAt || b.last_updated || b.first_seen || '';
          return db.localeCompare(da);
        });
        break;

      default:
        // confidence DESC
        sorted.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
        break;
    }

    return sorted;
  } catch {
    return results;
  }
}

// ── wrapMCPHandler ────────────────────────────────────────────────────────────
/**
 * Wraps a tool handler function with event capture and signal_block injection.
 *
 * @param {string}   toolName  — MCP tool name (e.g. 'local_intel_nearby')
 * @param {Function} handler   — original handler(params) => result
 * @returns {Function} wrapped handler
 */
function wrapMCPHandler(toolName, handler) {
  return function wrappedHandler(params) {
    try {
      // ── Extract location context ──────────────────────────────────────────
      const zip       = params.zip       || null;
      const lat       = params.lat       || null;
      const lon       = params.lon       || null;
      const agentType = (params.query_context && params.query_context.agent_type) || null;
      const agentId   = (params.query_context && params.query_context.agent_id)   || null;

      // ── Append wave surface event (non-blocking, best-effort) ────────────
      try {
        const waveSurfaceWorker = require('./waveSurfaceWorker');
        if (typeof waveSurfaceWorker.appendEvent === 'function') {
          waveSurfaceWorker.appendEvent({
            ts:              new Date().toISOString(),
            tool:            toolName,
            zip:             zip || '',
            lat:             lat,
            lon:             lon,
            agent_type:      agentType,
            session_id:      agentId,
            query_text:      params.query    || null,
            category_filter: params.category || null,
          });
        }
      } catch {
        // waveSurfaceWorker not yet available — silently continue
      }

      // ── Record in agent memory (non-blocking, best-effort) ───────────────
      if (agentId && zip) {
        try {
          const agentMemoryWorker = require('./agentMemoryWorker');
          if (typeof agentMemoryWorker.recordQuery === 'function') {
            // recordQuery is async — fire-and-forget, errors silently swallowed
            Promise.resolve(agentMemoryWorker.recordQuery(agentId, zip, toolName, agentType)).catch(() => {});
          }
        } catch {
          // agentMemoryWorker not yet available — silently continue
        }
      }

      // ── Call the original handler ─────────────────────────────────────────
      const result = handler(params);

      // ── Compute signal_block and append to result ─────────────────────────
      if (result && typeof result === 'object' && !result.error) {
        const resolvedZip = zip || result.zip || '';
        result.signal_block = computeSignalBlock(resolvedZip, agentType, result);
      }

      return result;
    } catch (err) {
      // Never throw — return partial result with error note
      return {
        error: `wrapMCPHandler error: ${err.message}`,
        signal_block: {
          score: 50,
          direction: 'stable',
          confidence: 0,
          top_signal: 'Handler error',
          predicted_state_90d: 'unknown',
          agent_priority: [],
          freshness_warning: err.message,
        },
      };
    }
  };
}

module.exports = { wrapMCPHandler, computeSignalBlock, rankByPersona };
