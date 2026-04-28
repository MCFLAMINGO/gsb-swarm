'use strict';
/**
 * lib/enrichmentTrigger.js
 *
 * Called by rfqService when an RFQ gap is detected (matched_count < limit/2).
 * Logs the gap to rfq_gaps and optionally triggers the enrichment worker
 * to go find more businesses for that category+zip.
 *
 * Self-improvement loop: every failed RFQ match teaches the system where
 * its coverage gaps are. The enrichment worker fills them.
 */

const db = require('./db');

/**
 * triggerEnrichment({ category, zip, reason, requested, matched })
 * Fire-and-forget — logs gap, kicks enrichmentAgent worker if running.
 */
function triggerEnrichment({ category, zip, reason, requested, matched }) {
  setImmediate(async () => {
    try {
      const pool = db.getPool();

      // Log to rfq_gaps (table created by rfqService, may already exist)
      await pool.query(
        `INSERT INTO rfq_gaps (category, zip, job_type, requested, matched, verified)
         VALUES ($1, $2, $3, $4, $5, 0)
         ON CONFLICT DO NOTHING`,
        [category || null, zip || null, reason || 'rfq_gap', requested || 0, matched || 0]
      ).catch(() => {}); // non-fatal if table doesn't exist yet

      console.log(`[enrichmentTrigger] gap logged category=${category} zip=${zip} matched=${matched}/${requested}`);

      // Signal the enrichment agent worker via Postgres NOTIFY
      // enrichmentAgent.js listens on channel 'enrichment_needed'
      await pool.query(
        `SELECT pg_notify('enrichment_needed', $1)`,
        [JSON.stringify({ category, zip, reason: reason || 'rfq_gap', requested, matched, ts: new Date().toISOString() })]
      ).catch(() => {});

    } catch (e) {
      // Always non-fatal — enrichment is best-effort
      console.warn('[enrichmentTrigger] non-fatal:', e.message);
    }
  });
}

module.exports = { triggerEnrichment };
