'use strict';
/**
 * conversationThread.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Stateful conversation threading for LocalIntel.
 * Keyed on caller_id (E.164 phone, session_id, or MCP agent_id).
 * Serves all channels: SMS (Twilio), voice, MCP agents, web.
 *
 * Two roles:
 *   1. appendTurn()   — write a turn (user query or system response) to thread
 *   2. getContext()   — read last N turns + derive enrichment for intent router
 *
 * getContext() returns a ThreadContext object that the POST handler uses to:
 *   - Fill missing ZIP from prior turns
 *   - Resolve referential phrases ("that one", "same place", "near there")
 *   - Carry forward partial task state (open RFQ, last business, preferred ZIP)
 *   - Surface unresolved dead ends ("you asked about a plumber last week")
 *
 * Zero LLM. Pure Postgres. Fire-and-forget writes — never block a response.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const db = require('./db');

const WINDOW = 6; // rolling turns to load for context

// ── Auto-migrate on first use ─────────────────────────────────────────────────
let _migrated = false;
async function ensureMigrated() {
  if (_migrated) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS conversation_threads (
      id            BIGSERIAL    PRIMARY KEY,
      caller_id     TEXT         NOT NULL,
      channel       TEXT         NOT NULL DEFAULT 'web',
      role          TEXT         NOT NULL DEFAULT 'user',
      content       TEXT         NOT NULL,
      zip           TEXT,
      intent        TEXT,
      business_id   UUID,
      business_name TEXT,
      rfq_id        UUID,
      resolves_via  TEXT,
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `).catch(() => {});
  await db.query(`CREATE INDEX IF NOT EXISTS idx_ct_caller_recent ON conversation_threads(caller_id, created_at DESC)`).catch(() => {});
  _migrated = true;
}

// ── Referential phrase detection ──────────────────────────────────────────────
// These patterns signal the caller is referring to something from a prior turn.
const REFERENTIAL = [
  /\bthat (one|place|business|restaurant|plumber|guy|shop|clinic|store)\b/i,
  /\bsame (place|one|business|person|guy|shop)\b/i,
  /\bthe one\b/i,
  /\bthere\b.*\bagain\b/i,
  /\bbook (them|it|him|her)\b/i,
  /\bcall (them|him|her|it)\b/i,
  /\bthat (same|last)\b/i,
  /\bfrom (last time|before|earlier|yesterday|last week)\b/i,
  /\bstill\b.*\bneed\b/i,
  /\bsame (as|guy|place|one)\b/i,
];

function isReferential(query) {
  return REFERENTIAL.some(re => re.test(query));
}

// ── ZIP carry-forward detection ───────────────────────────────────────────────
// "near there" / "around here" / "in that area" = use ZIP from last turn
const ZIP_PROXY = [
  /\bnear (here|there)\b/i,
  /\baround (here|there)\b/i,
  /\bin (that|this|the same) area\b/i,
  /\bnearby\b/i,
  /\bsame (zip|area|location|neighborhood)\b/i,
];

function isZipProxy(query) {
  return ZIP_PROXY.some(re => re.test(query));
}

// ── Write a turn to the thread ────────────────────────────────────────────────
/**
 * appendTurn({ callerId, channel, role, content, zip, intent, businessId,
 *              businessName, rfqId, resolvesVia })
 * Fire-and-forget — never awaited by callers.
 */
function appendTurn({ callerId, channel = 'web', role = 'user', content,
                      zip = null, intent = null, businessId = null,
                      businessName = null, rfqId = null, resolvesVia = null }) {
  if (!callerId || !content) return Promise.resolve();
  return ensureMigrated()
    .then(() => db.query(
      `INSERT INTO conversation_threads
         (caller_id, channel, role, content, zip, intent, business_id, business_name, rfq_id, resolves_via)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [callerId, channel, role, content, zip, intent,
       businessId || null, businessName || null, rfqId || null, resolvesVia || null]
    ))
    .catch(e => console.error('[conversationThread] appendTurn failed:', e.message));
}

// ── Read thread + derive enrichment context ───────────────────────────────────
/**
 * getContext(callerId) → ThreadContext
 *
 * ThreadContext shape:
 * {
 *   turns:          Turn[]       — last WINDOW turns, newest first
 *   zip:            string|null  — most recent resolved ZIP in thread
 *   lastBusinessId: string|null  — most recent resolved business_id
 *   lastBusinessName: string|null
 *   lastIntent:     string|null  — most recent intent class
 *   openRfqId:      string|null  — most recent unresolved RFQ
 *   isReferential:  bool         — current query references a prior entity
 *   isZipProxy:     bool         — current query defers ZIP to prior context
 *   contextSummary: string       — human/agent readable summary of thread state
 * }
 */
async function getContext(callerId, currentQuery = '') {
  const empty = {
    turns: [], zip: null, lastBusinessId: null, lastBusinessName: null,
    lastIntent: null, openRfqId: null, isReferential: false, isZipProxy: false,
    contextSummary: null,
  };
  if (!callerId) return empty;

  try {
    await ensureMigrated();
    const turns = await db.query(
      `SELECT id, role, content, zip, intent, business_id, business_name, rfq_id, resolves_via, created_at
         FROM conversation_threads
        WHERE caller_id = $1
        ORDER BY created_at DESC
        LIMIT $2`,
      [callerId, WINDOW]
    );

    if (!turns.length) return { ...empty, isReferential: isReferential(currentQuery), isZipProxy: isZipProxy(currentQuery) };

    // Derive context from thread
    const zip            = turns.find(t => t.zip)?.zip || null;
    const lastBiz        = turns.find(t => t.business_id);
    const lastBusinessId   = lastBiz?.business_id   || null;
    const lastBusinessName = lastBiz?.business_name || null;
    const lastIntent     = turns.find(t => t.intent)?.intent || null;
    // Most recent RFQ that doesn't have a 'completed' or 'booked' follow-up
    const openRfqId      = turns.find(t => t.rfq_id)?.rfq_id || null;

    // Build a short context summary for agent hints
    const parts = [];
    if (zip)              parts.push(`ZIP context: ${zip}`);
    if (lastBusinessName) parts.push(`Last business: ${lastBusinessName}`);
    if (lastIntent)       parts.push(`Last intent: ${lastIntent}`);
    if (openRfqId)        parts.push(`Open RFQ: ${openRfqId}`);

    const refFlag = isReferential(currentQuery);
    const zipFlag = isZipProxy(currentQuery);

    if (refFlag && lastBusinessName) parts.push(`Caller refers to "${lastBusinessName}" from prior turn`);
    if (zipFlag && zip)              parts.push(`Caller defers ZIP — using ${zip} from prior turn`);

    return {
      turns,
      zip,
      lastBusinessId,
      lastBusinessName,
      lastIntent,
      openRfqId,
      isReferential: refFlag,
      isZipProxy:    zipFlag,
      contextSummary: parts.length ? parts.join(' | ') : null,
    };
  } catch (e) {
    console.error('[conversationThread] getContext failed:', e.message);
    return empty;
  }
}

/**
 * recentZips(callerId, limit=3) → string[]
 * Returns the last N distinct ZIPs this caller has queried.
 * Used by the intent router to expand ZIP fallback beyond TARGET_ZIPS.
 */
async function recentZips(callerId, limit = 3) {
  if (!callerId) return [];
  try {
    await ensureMigrated();
    return (await db.query(
      `SELECT zip FROM (
         SELECT zip, MAX(created_at) AS last_seen
           FROM conversation_threads
          WHERE caller_id=$1 AND zip IS NOT NULL
          GROUP BY zip
          ORDER BY last_seen DESC
          LIMIT $2
       ) sub`,
      [callerId, limit]
    )).map(r => r.zip);
  } catch (e) {
    return [];
  }
}

module.exports = { appendTurn, getContext, recentZips, isReferential, isZipProxy };
