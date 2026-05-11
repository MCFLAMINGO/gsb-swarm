'use strict';
/**
 * lib/deadEndLog.js — fire-and-forget dead-end query logger.
 *
 * Writes a row to intent_dead_ends whenever a user query falls into a
 * dead-end path (no_intent, no_results, no_wallet, rfq_fail,
 * reservation_fail, unknown). Callers MUST NOT await this — it returns
 * synchronously after kicking off the insert and swallows any error
 * via .catch(). It must never block the response path or throw.
 */

const db = require('./db');

function logDeadEnd({ query, zip, channel, failReason, intentPath, callerId } = {}) {
  try {
    db.query(
      `INSERT INTO intent_dead_ends (query, zip, channel, fail_reason, intent_path, caller_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        query || '',
        zip || null,
        channel || null,
        failReason || 'unknown',
        intentPath || null,
        callerId || null,
      ]
    ).catch(err => console.error('[deadEndLog] insert failed:', err.message));
  } catch (err) {
    console.error('[deadEndLog] sync error:', err.message);
  }
}

module.exports = { logDeadEnd };
