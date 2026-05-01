'use strict';

/**
 * telemetry.js
 * Lightweight event logging for the LocalIntel intelligence layer.
 *
 * Two write functions:
 *   logTask(fields)   → task_events
 *   logWorker(fields) → worker_events
 *
 * Road classification:
 *   highway    = UCP/Surge → agent_closed (fully machine)
 *   local      = SMS/voice → human_assisted
 *   cul-de-sac = email/RFQ → dropped or pending
 *
 * All writes are fire-and-forget (non-blocking). A failure here
 * NEVER propagates to the caller — telemetry must be silent on error.
 */

const db = require('./db');

// ── Road classifier ─────────────────────────────────────────────────────────
function classifyRoad(handoffType, resolutionType) {
  if (resolutionType === 'agent_closed') return 'highway';
  if (handoffType === 'surge_checkout' || handoffType === 'ucp') return 'highway';
  if (handoffType === 'sms' || handoffType === 'voice') return 'local';
  if (handoffType === 'email' || handoffType === 'rfq' || !handoffType) return 'cul-de-sac';
  return 'local';
}

// ── logTask ──────────────────────────────────────────────────────────────────
/**
 * Log a task event. Fire-and-forget — never throws.
 *
 * @param {object} fields
 * @param {string}  fields.task_type        voice_order | agent_query | mcp_call | rfq | voice_listing
 * @param {string}  [fields.business_id]
 * @param {string}  [fields.zip]
 * @param {string}  [fields.category]
 * @param {string}  [fields.category_group]
 * @param {string}  [fields.channel_in]     twilio | mcp | api | http
 * @param {string}  [fields.pos_type]       ucp | toast | square | other | null
 * @param {string}  [fields.handoff_type]   surge_checkout | sms | email | none
 * @param {string}  [fields.resolution_type] agent_closed | human_assisted | dropped | pending | failed
 * @param {number}  [fields.lane_depth]
 * @param {string}  [fields.agent_session_id]
 * @param {string}  [fields.agent_id]
 * @param {string}  [fields.agent_origin]
 * @param {Date}    [fields.initiated_at]
 * @param {Date}    [fields.responded_at]
 * @param {Date}    [fields.completed_at]
 * @param {string}  [fields.error_message]
 * @param {object}  [fields.meta]
 */
async function logTask(fields) {
  try {
    const road = classifyRoad(fields.handoff_type, fields.resolution_type);
    await db.query(
      `INSERT INTO task_events (
        task_type, business_id, zip, category, category_group,
        channel_in, pos_type, handoff_type, road_type,
        resolution_type, lane_depth,
        agent_session_id, agent_id, agent_origin,
        initiated_at, responded_at, completed_at,
        error_message, meta
      ) VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,$9,
        $10,$11,
        $12,$13,$14,
        $15,$16,$17,
        $18,$19
      )`,
      [
        fields.task_type,
        fields.business_id   || null,
        fields.zip           || null,
        fields.category      || null,
        fields.category_group || null,
        fields.channel_in    || null,
        fields.pos_type      || null,
        fields.handoff_type  || null,
        road,
        fields.resolution_type || 'pending',
        fields.lane_depth    || 1,
        fields.agent_session_id || null,
        fields.agent_id      || null,
        fields.agent_origin  || null,
        fields.initiated_at  || new Date(),
        fields.responded_at  || null,
        fields.completed_at  || null,
        fields.error_message || null,
        JSON.stringify(fields.meta || {}),
      ]
    );
  } catch (e) {
    // Telemetry must NEVER crash the caller
    console.error('[telemetry] logTask error (non-fatal):', e.message);
  }
}

// ── logWorker ────────────────────────────────────────────────────────────────
/**
 * Log a worker lifecycle event. Fire-and-forget — never throws.
 *
 * @param {object} fields
 * @param {string}  fields.worker_name    voiceIntake | posRouter | geocodingWorker | localIntelMCP | rfqFallback
 * @param {string}  fields.event_type     start | complete | fail | retry | stall
 * @param {string}  [fields.input_summary]
 * @param {string}  [fields.output_summary]
 * @param {number}  [fields.duration_ms]
 * @param {string}  [fields.error_message]
 * @param {number}  [fields.records_in]
 * @param {number}  [fields.records_out]
 * @param {number}  [fields.success_rate]  0–100
 * @param {object}  [fields.meta]
 */
async function logWorker(fields) {
  try {
    await db.query(
      `INSERT INTO worker_events (
        worker_name, event_type, input_summary, output_summary,
        duration_ms, error_message, records_in, records_out,
        success_rate, meta
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        fields.worker_name,
        fields.event_type,
        fields.input_summary  || null,
        fields.output_summary || null,
        fields.duration_ms    || null,
        fields.error_message  || null,
        fields.records_in     || null,
        fields.records_out    || null,
        fields.success_rate   || null,
        JSON.stringify(fields.meta || {}),
      ]
    );
  } catch (e) {
    console.error('[telemetry] logWorker error (non-fatal):', e.message);
  }
}

// ── upsertAgentSession ───────────────────────────────────────────────────────
/**
 * Read X-Agent-* headers from an incoming request and upsert an agent_sessions row.
 * Returns the session_id (UUID string) or null if no agent headers present.
 *
 * Headers read:
 *   X-Agent-Id        agent identifier
 *   X-Agent-Origin    origin domain / platform
 *   X-Agent-Session   existing session UUID (optional — allows agent to continue a session)
 *   X-Visited         comma-separated prior sources
 *   X-Failed          comma-separated failed sources
 *   X-Principal-Intent free-text description of what the principal needs
 *
 * @param {object} req  Node.js IncomingMessage
 * @param {string} [zip]
 * @param {string} [category]
 * @returns {Promise<string|null>} session_id
 */
async function upsertAgentSession(req, zip, category) {
  try {
    const agentId    = req.headers['x-agent-id']        || null;
    const origin     = req.headers['x-agent-origin']    || null;
    const existingSid = req.headers['x-agent-session']  || null;
    const visited    = req.headers['x-visited']         || '';
    const failed     = req.headers['x-failed']          || '';
    const intent     = req.headers['x-principal-intent'] || null;

    // No agent headers — skip
    if (!agentId && !origin && !existingSid) return null;

    const priorSources  = visited ? visited.split(',').map(s => s.trim()).filter(Boolean) : [];
    const failedSources = failed  ? failed.split(',').map(s => s.trim()).filter(Boolean)  : [];

    if (existingSid) {
      // Update existing session
      const rows = await db.query(
        `UPDATE agent_sessions SET
          call_count         = call_count + 1,
          last_seen_at       = NOW(),
          zips_queried       = CASE WHEN $1 IS NOT NULL
                                THEN array_append(zips_queried, $1::TEXT)
                                ELSE zips_queried END,
          categories_queried = CASE WHEN $2 IS NOT NULL
                                THEN array_append(categories_queried, $2::TEXT)
                                ELSE categories_queried END,
          prior_sources      = CASE WHEN array_length($3::TEXT[], 1) > 0
                                THEN $3::TEXT[]
                                ELSE prior_sources END,
          failed_sources     = CASE WHEN array_length($4::TEXT[], 1) > 0
                                THEN $4::TEXT[]
                                ELSE failed_sources END,
          principal_intent   = COALESCE($5, principal_intent)
        WHERE session_id = $6
        RETURNING session_id`,
        [zip || null, category || null, priorSources, failedSources, intent, existingSid]
      );
      if (rows.length) return rows[0].session_id;
      // Session not found — fall through to create new
    }

    // Create new session
    const rows = await db.query(
      `INSERT INTO agent_sessions (
        agent_id, origin_domain, prior_sources, failed_sources,
        principal_intent, zips_queried, categories_queried
      ) VALUES ($1,$2,$3,$4,$5,
        CASE WHEN $6 IS NOT NULL THEN ARRAY[$6::TEXT] ELSE '{}' END,
        CASE WHEN $7 IS NOT NULL THEN ARRAY[$7::TEXT] ELSE '{}' END
      )
      RETURNING session_id`,
      [
        agentId, origin, priorSources, failedSources,
        intent, zip || null, category || null,
      ]
    );
    return rows[0]?.session_id || null;
  } catch (e) {
    console.error('[telemetry] upsertAgentSession error (non-fatal):', e.message);
    return null;
  }
}

module.exports = { logTask, logWorker, upsertAgentSession, classifyRoad };
