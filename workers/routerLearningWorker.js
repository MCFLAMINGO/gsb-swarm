'use strict';
/**
 * routerLearningWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Closes the feedback loop between mcpProbeWorker and intentRouter.
 *
 * Postgres-only state. The Railway disk is wiped on every redeploy, and
 * file patching of inferenceCache.js silently fails there anyway, so:
 *   - Probe log is read from `mcp_probe_log` (Postgres) via pgStore
 *   - Router learning history is logged to `router_learning_log` (auto-created)
 *   - Every cycle records WHAT WOULD have been patched. A human applies the
 *     keyword changes to inferenceCache.js in source control as needed.
 *
 * Contract:
 *   START → SELECT last run_at FROM router_learning_log; skip if < 30 min ago
 *   END   → INSERT one row capturing the run summary
 *   FULL_REFRESH=true ignores skip logic
 *
 * Cycle: 30 minutes.
 */

const pgStore = require('../lib/pgStore');
const db      = require('../lib/db');

const CYCLE_MS   = 30 * 60 * 1000; // 30 min
const STAGGER_MS =  5 * 60 * 1000; // wait 5 min after startup

const LOW_SCORE_THRESHOLD = 50;
const MIN_FREQUENCY       = 2;
const MAX_NEW_TERMS       = 5;
const MIN_GAP_MS          = 30 * 60 * 1000;
const FULL_REFRESH        = process.env.FULL_REFRESH === 'true';

// ── Persona → intended vertical ───────────────────────────────────────────────
const PERSONA_VERTICAL = {
  realtor_rosa:    'realtor',
  chef_marco:      'restaurant',
  builder_ben:     'construction',
  retailer_rita:   'retail',
  health_harriet:  'healthcare',
};

const STOP = new Set([
  'the','a','an','and','or','in','is','are','what','where','how','does','do',
  'for','of','to','at','by','it','this','that','there','show','me','find',
  'get','tell','give','list','best','top','good','great','more','less','any',
  'some','all','my','your','i','we','they','can','will','have','has','been',
  'with','from','on','as','not','no','vs','versus','look','like','need',
  'want','would','could','should','which','who','when','why','new','old',
  'big','small','large','high','low','many','much','few','every','each',
  'into','over','under','about','around','near','between','through','here',
  'now','then','just','also','too','very','well','even','still','already',
  'only','both','while','after','before','since','without','across','against',
  'market','area','zip','local','florida','northeast','county','city','town',
  'currently','typically','usually','generally','specifically','overall',
]);

const KNOWN_TERMS = {
  restaurant:   new Set(['restaurant','dining','cafe','food','cuisine','eatery','bar','brewery','coffeehouse','diner','ramen','sushi','pizza','bbq','seafood','truck','ghost','kitchen','breakfast','lunch','dinner','daypart','franchise']),
  healthcare:   new Set(['clinic','healthcare','health','medical','doctor','physician','dentist','dental','urgent','care','therapy','mental','optometry','pediatric','senior','nursing','pharmacy','patient','provider','hospital']),
  retail:       new Set(['retail','store','shop','boutique','shopping','consumer','merchandise','ecommerce','fashion','apparel','grocery','convenience','hardware','sporting','pet','supply','home','goods']),
  construction: new Set(['construction','contractor','builder','permit','develop','remodel','renovation','roofing','hvac','plumbing','electrical','deck','pool','foundation','flood','remediation','improvement']),
  realtor:      new Set(['realtor','real','estate','property','home','value','listing','buyer','seller','invest','rental','vacancy','zoning','appreciation','neighborhood','condo','single','family','commercial']),
};

function tokenize(query) {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

// ── Schema ────────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS router_learning_log (
      id SERIAL PRIMARY KEY,
      run_at TIMESTAMPTZ DEFAULT NOW(),
      new_terms JSONB,
      failing_queries JSONB,
      improvement_rate NUMERIC,
      patch_summary TEXT
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_router_learning_run_at ON router_learning_log(run_at DESC)`);
}

async function lastRunAt() {
  try {
    const rows = await db.query(`SELECT run_at FROM router_learning_log ORDER BY run_at DESC LIMIT 1`);
    return rows[0]?.run_at ? new Date(rows[0].run_at).getTime() : 0;
  } catch (_) { return 0; }
}

async function logRun({ new_terms, failing_queries, improvement_rate, patch_summary }) {
  await db.query(
    `INSERT INTO router_learning_log (new_terms, failing_queries, improvement_rate, patch_summary)
     VALUES ($1, $2, $3, $4)`,
    [
      JSON.stringify(new_terms || []),
      JSON.stringify(failing_queries || []),
      improvement_rate ?? null,
      patch_summary || null,
    ]
  );
}

// ── Probe log loading ─────────────────────────────────────────────────────────
async function loadLog() {
  try { return await pgStore.getProbeLogForLearning(200); }
  catch { return []; }
}

// ── Analysis ──────────────────────────────────────────────────────────────────
function analyzeFailures(log) {
  const recent = log.slice(-200);
  const failures = {};
  for (const entry of recent) {
    if (entry.score >= LOW_SCORE_THRESHOLD) continue;
    const vertical = PERSONA_VERTICAL[entry.persona];
    if (!vertical) continue;
    if (!failures[vertical]) failures[vertical] = [];
    failures[vertical].push({
      query:  entry.query,
      score:  entry.score,
      reason: entry.reason,
      zip:    entry.zip,
      ts:     entry.ts,
    });
  }
  return failures;
}

function findCandidateTerms(failures, vertical) {
  const termFreq = {};
  for (const f of failures) {
    const tokens = tokenize(f.query || '');
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (KNOWN_TERMS[vertical]?.has(t)) continue;
      termFreq[t] = (termFreq[t] || 0) + 1;
    }
  }
  return Object.entries(termFreq)
    .filter(([, freq]) => freq >= MIN_FREQUENCY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NEW_TERMS)
    .map(([term, freq]) => ({ term, freq }));
}

function verticalScoreTrend(log, vertical) {
  const entries = log.filter(e => PERSONA_VERTICAL[e.persona] === vertical && typeof e.score === 'number');
  if (!entries.length) return { avg: 0, total: 0, low: 0 };
  const avg  = Math.round(entries.reduce((s, e) => s + e.score, 0) / entries.length);
  const low  = entries.filter(e => e.score < LOW_SCORE_THRESHOLD).length;
  return { avg, total: entries.length, low };
}

// ── Main learning cycle ───────────────────────────────────────────────────────
async function runLearningCycle(cycleIndex) {
  console.log(`[router-learning] Cycle ${cycleIndex + 1} — reading probe log`);

  if (!FULL_REFRESH) {
    const last = await lastRunAt();
    if (last && (Date.now() - last) < MIN_GAP_MS) {
      console.log('[router-learning] Skipped — last run < 30 min ago');
      return;
    }
  }

  const log = await loadLog();
  if (log.length === 0) {
    console.log('[router-learning] No probe log entries yet — skipping');
    return;
  }

  const failures = analyzeFailures(log);
  const trends = {};
  for (const v of Object.values(PERSONA_VERTICAL)) {
    trends[v] = verticalScoreTrend(log, v);
    console.log(`[router-learning]   ${v.padEnd(14)} avg:${trends[v].avg} total:${trends[v].total} low:${trends[v].low}`);
  }

  const proposed = []; // { vertical, terms, evidence }
  for (const [vertical, vFailures] of Object.entries(failures)) {
    if (!vFailures.length) continue;
    const candidates = findCandidateTerms(vFailures, vertical);
    if (!candidates.length) {
      console.log(`[router-learning]   ${vertical}: ${vFailures.length} failures, no new term candidates`);
      continue;
    }
    proposed.push({
      vertical,
      terms: candidates.map(c => c.term),
      evidence: vFailures.slice(0, 3).map(f => ({ query: f.query, score: f.score, zip: f.zip })),
    });
    console.log(`[router-learning]   ${vertical}: ${vFailures.length} failures → would add: ${candidates.map(c => c.term).join(', ')}`);

    // Persist patch suggestions in the existing pgStore route_patches table for
    // human review. NO file patching — Railway disk is ephemeral.
    try {
      await pgStore.saveRouterPatch(vertical, candidates.map(c => c.term),
        vFailures.slice(0,3).map(f => ({ query: f.query, score: f.score })), 0, 0);
    } catch (_) {}
  }

  const totalNewTerms = proposed.reduce((s, p) => s + p.terms.length, 0);
  const totalFailures = Object.values(failures).reduce((s, f) => s + f.length, 0);
  const improvementRate = log.length > 0
    ? (log.length - totalFailures) / log.length
    : 0;
  const summary = proposed.length
    ? proposed.map(p => `${p.vertical}: +${p.terms.join(',')}`).join(' | ')
    : 'no patches proposed';

  await logRun({
    new_terms:        proposed,
    failing_queries:  Object.entries(failures).flatMap(([v, fs]) =>
                        fs.slice(0, 5).map(f => ({ vertical: v, ...f }))),
    improvement_rate: improvementRate,
    patch_summary:    summary,
  });

  console.log(
    `[router-learning] Cycle ${cycleIndex + 1} complete — ` +
    `${totalNewTerms} terms suggested across ${proposed.length} verticals (logged to router_learning_log)`
  );
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  console.log('[router-learning] Router learning worker started — Postgres-only, no file patches');

  try { await ensureSchema(); }
  catch (e) { console.error('[router-learning] schema init failed:', e.message); }

  await new Promise(r => setTimeout(r, STAGGER_MS));

  let cycleIndex = 0;
  while (true) {
    try {
      await runLearningCycle(cycleIndex);
    } catch (err) {
      console.error('[router-learning] Cycle error:', err.message);
    }
    cycleIndex++;
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
})();
