'use strict';
/**
 * routerLearningWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Closes the feedback loop between mcpProbeWorker and intentRouter.
 *
 * What it does every 30 minutes:
 *   1. Reads mcp_probe_log.json — finds failed/low-score entries (score < 50)
 *   2. Extracts the failing query + expected vertical (from persona role)
 *   3. Diffs against current VERTICAL_SIGNALS to find which keywords are missing
 *   4. Patches inferenceCache.js VERTICAL_SIGNALS with new keyword terms
 *   5. Writes data/router_learning.json — tracks every patch, score trends,
 *      improvement rate across runs so you can review it in the morning
 *
 * Learning strategy: ZERO external calls, ZERO cost.
 *   - Persona → intended vertical mapping is authoritative (we designed the personas)
 *   - Tokenize the failing query, strip stop words, extract content words
 *   - Any content word not already in the vertical's regex gets added
 *   - Patch is written directly to inferenceCache.js (the source file)
 *   - Next probe cycle picks up the new patterns automatically
 *
 * Safety:
 *   - Never removes existing patterns, only adds
 *   - Caps new terms at 5 per run to avoid noise
 *   - Terms must appear in 2+ failing queries before being added (frequency gate)
 *   - All patches logged with before/after and query evidence
 */

const fs   = require('fs');
const path = require('path');

const BASE_DIR      = path.join(__dirname, '..');
const LOG_PATH      = path.join(BASE_DIR, 'data', 'mcp_probe_log.json');
const LEARNING_PATH = path.join(BASE_DIR, 'data', 'router_learning.json');
const CACHE_FILE    = path.join(__dirname, 'inferenceCache.js');

const CYCLE_MS   = 30 * 60 * 1000; // 30 min
const STAGGER_MS =  5 * 60 * 1000; // wait 5 min after startup

const LOW_SCORE_THRESHOLD = 50;
const MIN_FREQUENCY       = 2;   // term must appear in N+ failures before adding
const MAX_NEW_TERMS       = 5;   // max terms added per run per vertical

// ── Persona → intended vertical ───────────────────────────────────────────────
// These are the ground-truth mappings — the persona is authoritative
const PERSONA_VERTICAL = {
  realtor_rosa:    'realtor',
  chef_marco:      'restaurant',
  builder_ben:     'construction',
  retailer_rita:   'retail',
  health_harriet:  'healthcare',
};

// ── Stop words — don't add these as router keywords ──────────────────────────
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

// ── Known terms already in each vertical's regex ─────────────────────────────
// Extracted from inferenceCache.js VERTICAL_SIGNALS at startup
const KNOWN_TERMS = {
  restaurant:   new Set(['restaurant','dining','cafe','food','cuisine','eatery','bar','brewery','coffeehouse','diner','ramen','sushi','pizza','bbq','seafood','food','truck','ghost','kitchen','breakfast','lunch','dinner','daypart','franchise']),
  healthcare:   new Set(['clinic','healthcare','health','medical','doctor','physician','dentist','dental','urgent','care','therapy','mental','optometry','pediatric','senior','nursing','pharmacy','patient','provider','hospital']),
  retail:       new Set(['retail','store','shop','boutique','shopping','consumer','merchandise','ecommerce','fashion','apparel','grocery','convenience','hardware','sporting','pet','supply','home','goods']),
  construction: new Set(['construction','contractor','builder','permit','develop','remodel','renovation','roofing','hvac','plumbing','electrical','deck','pool','foundation','flood','remediation','improvement']),
  realtor:      new Set(['realtor','real','estate','property','home','value','listing','buyer','seller','invest','rental','vacancy','zoning','appreciation','neighborhood','condo','single','family','commercial']),
};

// ── Tokenizer ─────────────────────────────────────────────────────────────────
function tokenize(query) {
  return query
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 3 && !STOP.has(t) && !/^\d+$/.test(t));
}

// ── Load probe log ────────────────────────────────────────────────────────────
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_PATH, 'utf8')); }
  catch { return []; }
}

// ── Load learning history ─────────────────────────────────────────────────────
function loadLearning() {
  try { return JSON.parse(fs.readFileSync(LEARNING_PATH, 'utf8')); }
  catch {
    return {
      runs: [],
      patches: [],
      score_trend: [],
      total_patches_applied: 0,
      verticals: {
        restaurant: { patches: [], avg_score_before: [], avg_score_after: [] },
        healthcare: { patches: [], avg_score_before: [], avg_score_after: [] },
        retail:     { patches: [], avg_score_before: [], avg_score_after: [] },
        construction:{ patches: [], avg_score_before: [], avg_score_after: [] },
        realtor:    { patches: [], avg_score_before: [], avg_score_after: [] },
      },
    };
  }
}

function saveLearning(data) {
  fs.mkdirSync(path.dirname(LEARNING_PATH), { recursive: true });
  fs.writeFileSync(LEARNING_PATH, JSON.stringify(data, null, 2));
}

// ── Analyze failures ──────────────────────────────────────────────────────────
function analyzeFailures(log) {
  // Only look at recent entries (last 200) — avoid re-patching old fixed patterns
  const recent = log.slice(-200);

  // Group failures by intended vertical (from persona)
  const failures = {}; // vertical → [{ query, score, reason }]
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

// ── Find candidate terms to add ───────────────────────────────────────────────
function findCandidateTerms(failures, vertical) {
  // Count how many failure queries contain each token
  const termFreq = {};
  for (const f of failures) {
    const tokens = tokenize(f.query);
    const seen = new Set();
    for (const t of tokens) {
      if (seen.has(t)) continue;
      seen.add(t);
      // Skip if already known
      if (KNOWN_TERMS[vertical]?.has(t)) continue;
      termFreq[t] = (termFreq[t] || 0) + 1;
    }
  }

  // Only terms appearing in MIN_FREQUENCY+ failures
  return Object.entries(termFreq)
    .filter(([, freq]) => freq >= MIN_FREQUENCY)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_NEW_TERMS)
    .map(([term, freq]) => ({ term, freq }));
}

// ── Patch inferenceCache.js ───────────────────────────────────────────────────
function patchRouterFile(vertical, newTerms) {
  if (!newTerms.length) return false;

  const src = fs.readFileSync(CACHE_FILE, 'utf8');

  // Find the vertical's regex line
  // Matches: restaurant:   /restaurant|dining|..../i,
  const verticalKey = vertical === 'realtor' ? 'realtor' : vertical;
  const regexLine = new RegExp(
    `(${verticalKey}:\\s*/)((?:[^/]|(?<=\\\\)/)*)(\\/i,)`,
    's'
  );

  const match = src.match(regexLine);
  if (!match) {
    console.warn(`[router-learning] Could not find regex line for vertical: ${vertical}`);
    return false;
  }

  const existingPattern = match[2];
  const termsToAdd = newTerms
    .map(t => t.term)
    .filter(t => !existingPattern.includes(t));

  if (!termsToAdd.length) return false;

  const newPattern = existingPattern + '|' + termsToAdd.join('|');
  const patched = src.replace(
    regexLine,
    `$1${newPattern}$3`
  );

  // Safety check — don't write if the patch looks broken
  if (!patched.includes(termsToAdd[0])) {
    console.warn(`[router-learning] Patch safety check failed for ${vertical}`);
    return false;
  }

  fs.writeFileSync(CACHE_FILE, patched);

  // Update in-memory KNOWN_TERMS so we don't re-add next cycle
  termsToAdd.forEach(t => KNOWN_TERMS[vertical]?.add(t));

  return termsToAdd;
}

// ── Score trend for a vertical ────────────────────────────────────────────────
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

  const log      = loadLog();
  const learning = loadLearning();

  if (log.length === 0) {
    console.log('[router-learning] No probe log entries yet — skipping');
    return;
  }

  const failures      = analyzeFailures(log);
  const runRecord = {
    ts:            new Date().toISOString(),
    cycle:         cycleIndex + 1,
    log_entries:   log.length,
    failures_found: Object.values(failures).reduce((s, f) => s + f.length, 0),
    patches:       [],
    score_trends:  {},
  };

  // Score trends before patching
  for (const vertical of Object.keys(PERSONA_VERTICAL).map(p => PERSONA_VERTICAL[p])) {
    const trend = verticalScoreTrend(log, vertical);
    runRecord.score_trends[vertical] = trend;
    console.log(`[router-learning]   ${vertical.padEnd(14)} avg:${trend.avg} total:${trend.total} low:${trend.low}`);
  }

  // For each vertical with failures, find + apply patches
  for (const [vertical, vFailures] of Object.entries(failures)) {
    if (!vFailures.length) continue;

    const candidates = findCandidateTerms(vFailures, vertical);
    if (!candidates.length) {
      console.log(`[router-learning]   ${vertical}: ${vFailures.length} failures, no new term candidates`);
      continue;
    }

    console.log(`[router-learning]   ${vertical}: ${vFailures.length} failures → candidates: ${candidates.map(c => c.term).join(', ')}`);

    const applied = patchRouterFile(vertical, candidates);
    if (applied && applied.length) {
      const patch = {
        ts:       new Date().toISOString(),
        vertical,
        terms:    applied,
        evidence: vFailures.slice(0, 3).map(f => ({ query: f.query, score: f.score })),
        cycle:    cycleIndex + 1,
      };
      runRecord.patches.push(patch);
      learning.patches.push(patch);
      learning.total_patches_applied += applied.length;
      learning.verticals[vertical]?.patches.push(...applied);

      console.log(`[router-learning]   ✓ Patched ${vertical} with: ${applied.join(', ')}`);
    }
  }

  // Score trend rolling history (keep last 50 runs)
  learning.score_trend.push({
    ts:     runRecord.ts,
    trends: runRecord.score_trends,
  });
  if (learning.score_trend.length > 50) learning.score_trend = learning.score_trend.slice(-50);

  // Run history (keep last 100)
  learning.runs.push(runRecord);
  if (learning.runs.length > 100) learning.runs = learning.runs.slice(-100);

  saveLearning(learning);

  const patchCount = runRecord.patches.reduce((s, p) => s + p.terms.length, 0);
  console.log(`[router-learning] Cycle ${cycleIndex + 1} complete — ${patchCount} terms patched across ${runRecord.patches.length} verticals`);

  if (patchCount > 0) {
    console.log('[router-learning] Router updated — next probe cycle will use new patterns');
  }
}

// ── Daemon loop ───────────────────────────────────────────────────────────────
(async function main() {
  console.log('[router-learning] Router learning worker started — 30min cycles, zero external calls');
  console.log('[router-learning] Strategy: read probe failures → extract keywords → patch VERTICAL_SIGNALS');

  // Wait for probe worker to have a cycle first
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
