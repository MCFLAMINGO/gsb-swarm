'use strict';
/**
 * lib/smsQueryLog.js — fire-and-forget SMS query history logger (B16).
 * Called from localIntelAgent.js whenever an SMS response is about to be sent.
 * NEVER awaited, NEVER throws — failures only console.error.
 */

const db = require('./db');

function logSmsQuery({ messageSid, callerId, query, zip, intent, resolvedVia, responsePreview } = {}) {
  try {
    const preview = responsePreview
      ? String(responsePreview).substring(0, 200)
      : null;
    db.query(
      `INSERT INTO sms_query_log
         (message_sid, caller_id, query, zip, intent, resolved_via, response_preview)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        messageSid || null,
        callerId || null,
        query || '',
        zip || null,
        intent || 'unmatched',
        resolvedVia || 'unmatched',
        preview,
      ]
    ).catch(err => console.error('[smsQueryLog] insert failed:', err.message));
  } catch (err) {
    console.error('[smsQueryLog] sync error:', err.message);
  }
}

module.exports = { logSmsQuery };
