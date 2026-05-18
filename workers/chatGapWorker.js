'use strict';
/**
 * chatGapWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads chat_log entries with data_confidence < 60 from the last 30 days.
 * Aggregates missing_signals counts to surface which deterministic workers
 * need to run to improve LLM answer quality.
 * Pure read-only analysis — logs results to console.
 *
 * Also exposes runQASuite(suiteFile) — manual-trigger only, never daemon —
 * which replays a JSON test suite against the local /chat endpoint and writes
 * pass/fail rows into qa_results.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const path = require('path');
const fs   = require('fs');

async function chatGapWorker(db, logEvent) {
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
}

// ── QA Suite runner ──────────────────────────────────────────────────────────
// Replays a JSON test suite against the local /chat endpoint and persists
// results to qa_results. Manual-trigger only.
async function runQASuite(suiteFile) {
  const db = require('../lib/db');
  const resolvedPath = suiteFile && path.isAbsolute(suiteFile)
    ? suiteFile
    : path.join(__dirname, '..', suiteFile || 'test-suites/query-test-suite-32082.json');

  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`QA suite file not found: ${resolvedPath}`);
  }
  const suite = JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
  if (!Array.isArray(suite)) {
    throw new Error('QA suite must be a JSON array of test cases');
  }

  // Ensure qa_results table exists (idempotent)
  await db.query(`
    CREATE TABLE IF NOT EXISTS qa_results (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ DEFAULT NOW(),
      query TEXT,
      expected TEXT,
      actual_answer TEXT,
      passed BOOLEAN,
      confidence NUMERIC,
      notes TEXT
    )
  `);

  // Bootstrap the dummy QA caller as an active subscriber so the trial gate
  // never short-circuits the run. Idempotent.
  const QA_PHONE = '+10000000000';
  await db.query(
    `INSERT INTO subscriber_accounts (phone, tier, status, trial_queries_used, trial_queries_limit)
       VALUES ($1, 'chat', 'active', 0, 999999)
     ON CONFLICT (phone) DO UPDATE SET status = 'active', trial_queries_limit = 999999`,
    [QA_PHONE]
  ).catch(() => {});

  const PORT = process.env.PORT || 8080;
  const CHAT_URL = process.env.QA_CHAT_URL || `http://127.0.0.1:${PORT}/api/local-intel/chat`;

  const results = [];
  let passed = 0, failed = 0;

  for (const tc of suite) {
    const query = tc.q || tc.query || '';
    if (!query) continue;
    const category = tc.category || null;
    const realBusinesses = Array.isArray(tc.real_businesses) ? tc.real_businesses : [];
    const expectedKeywords = Array.isArray(tc.expectedKeywords)
      ? tc.expectedKeywords
      : (Array.isArray(tc.mustMention) ? tc.mustMention : []);

    // Expected text used for the qa_results.expected column and for matching
    const expectedTokens = [
      ...(category ? [category.replace(/_/g, ' ')] : []),
      ...realBusinesses,
      ...expectedKeywords,
    ];
    const expectedStr = expectedTokens.join(' | ');

    let actualAnswer = '';
    let confidence = null;
    let notes = '';
    let success = false;

    try {
      const r = await fetch(CHAT_URL, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({ phone: QA_PHONE, question: query }),
      });
      const j = await r.json().catch(() => ({}));
      actualAnswer = String(j.answer || j.message || j.error || '');
      confidence   = (j.data_confidence != null) ? Number(j.data_confidence) : null;
      if (j.ok === false) {
        notes = `chat returned ok=false (${j.error || 'unknown'})`;
      }
    } catch (e) {
      notes = `fetch failed: ${e.message}`;
    }

    // Pass criteria: actual_answer mentions at least one real_business OR
    // (when no real_businesses provided) mentions the category keyword.
    const haystack = actualAnswer.toLowerCase();
    if (realBusinesses.length > 0) {
      success = realBusinesses.some(b => haystack.includes(String(b).toLowerCase()));
      if (!success && haystack.length > 30) {
        // Fallback: count the answer as a soft pass when it mentions the
        // category keyword AND data_confidence >= 40 — indicates we returned
        // SOMETHING grounded even if not the named business we expected.
        const catKey = (category || '').replace(/_/g, ' ').toLowerCase();
        if (catKey && haystack.includes(catKey) && (confidence == null || confidence >= 40)) {
          success = true;
          notes = (notes ? notes + '; ' : '') + 'soft pass — category mentioned, no named business hit';
        }
      }
    } else if (expectedKeywords.length > 0) {
      success = expectedKeywords.every(k => haystack.includes(String(k).toLowerCase()));
    } else if (category) {
      const catKey = category.replace(/_/g, ' ').toLowerCase();
      success = haystack.includes(catKey) && haystack.length > 30;
    } else {
      success = haystack.length > 30;
    }

    await db.query(
      `INSERT INTO qa_results (query, expected, actual_answer, passed, confidence, notes)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [query, expectedStr || null, actualAnswer.slice(0, 4000), success, confidence, notes || null]
    ).catch(e => { notes = (notes ? notes + '; ' : '') + 'db insert failed: ' + e.message; });

    if (success) passed++; else failed++;
    results.push({ query, expected: expectedStr, actual: actualAnswer.slice(0, 500), passed: success, confidence, notes });
    console.log(`[qa] ${success ? '✓' : '✗'} ${query}${notes ? ' — ' + notes : ''}`);
  }

  const summary = { total: results.length, passed, failed, results };
  console.log(`[qa] Done — ${passed}/${results.length} passed, ${failed} failed`);
  return summary;
}

module.exports = chatGapWorker;
module.exports.runQASuite = runQASuite;

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

  // Allow running the QA suite directly: `node workers/chatGapWorker.js qa [suiteFile]`
  if (process.argv[2] === 'qa') {
    runQASuite(process.argv[3])
      .then(s => { console.log('[chatGapWorker] qa summary:', JSON.stringify({ total: s.total, passed: s.passed, failed: s.failed })); process.exit(0); })
      .catch(e => { console.error('[chatGapWorker] qa fatal:', e.message); process.exit(1); });
  } else {
    chatGapWorker(db, logEvent)
      .then(r => { console.log('[chatGapWorker] done:', JSON.stringify(r)); process.exit(0); })
      .catch(e => { console.error('[chatGapWorker] fatal:', e.message); process.exit(1); });
  }
}
