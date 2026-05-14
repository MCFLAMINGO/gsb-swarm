'use strict';
/**
 * chatGapWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads chat_log entries with data_confidence < 60 from the last 30 days.
 * Aggregates missing_signals counts to surface which deterministic workers
 * need to run to improve LLM answer quality.
 * Pure read-only analysis — logs results to console.
 * ──────────────────────────────────────────────────────────────────────���──────
 */

module.exports = async function chatGapWorker(db, logEvent) {
  const workerName = 'chatGapWorker';
  await logEvent(workerName, 'START', null, 'Scanning chat_log for low-confidence answers');

  const rows = await db.query(
    `SELECT zip, data_confidence, missing_signals
       FROM chat_log
      WHERE data_confidence < 60
        AND created_at >= NOW() - INTERVAL '30 days'`
  );

  if (!rows.length) {
    await logEvent(workerName, 'END', null, 'No low-confidence chat entries in last 30 days');
    return { scanned: 0, gaps: [] };
  }

  const signalCounts = {};
  const zipCounts    = {};
  for (const r of rows) {
    const ms = Array.isArray(r.missing_signals) ? r.missing_signals : [];
    for (const s of ms) {
      signalCounts[s] = (signalCounts[s] || 0) + 1;
    }
    if (r.zip) zipCounts[r.zip] = (zipCounts[r.zip] || 0) + 1;
  }

  const topSignals = Object.entries(signalCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([signal, count]) => ({ signal, count }));

  const topZips = Object.entries(zipCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([zip, count]) => ({ zip, count }));

  console.log(`[chatGapWorker] Scanned ${rows.length} low-confidence entries (last 30 days)`);
  console.log(`[chatGapWorker] Top missing signals:`);
  for (const s of topSignals) {
    console.log(`  - ${s.signal}: missing in ${s.count} queries`);
  }
  console.log(`[chatGapWorker] Top affected ZIPs:`);
  for (const z of topZips) {
    console.log(`  - ${z.zip}: ${z.count} low-confidence queries`);
  }

  await logEvent(workerName, 'END', null,
    `Scanned ${rows.length} low-confidence entries. Top gap: ${topSignals[0] ? topSignals[0].signal : 'n/a'}`
  );

  return { scanned: rows.length, gaps: topSignals, zips: topZips };
};

// ── Standalone entry point — MUST be after module.exports assignment ──────────
if (require.main === module) {
  const db = require('../lib/db');
  async function logEvent(worker, type, zip, msg) {
    try {
      await db.query(
        `INSERT INTO worker_events (worker_name, event_type, error_message, meta, created_at)
         VALUES ($1, $2, NULL, $3, NOW())`,
        [worker, type, JSON.stringify({ message: msg, zip: zip || null })]
      );
    } catch (_) {}
    console.log(`[${worker}] ${type}${zip ? ' ' + zip : ''}: ${msg}`);
  }
  module.exports(db, logEvent)
    .then(r => { console.log('[chatGapWorker] done:', JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error('[chatGapWorker] fatal:', e.message); process.exit(1); });
}
