'use strict';
/**
 * lib/agentBid.js — Agent-to-Agent RFQ Protocol
 *
 * When a business has an agent_endpoint set, LocalIntel POSTs a structured
 * RFQ bid request directly to that endpoint instead of (or in addition to)
 * sending an SMS/email. The agent responds with a structured bid.
 *
 * Bid request shape (sent to agent_endpoint):
 * {
 *   rfq_id:       string    — LocalIntel RFQ UUID
 *   job_code:     string    — 6-char human code
 *   category:     string
 *   zip:          string
 *   description:  string
 *   budget_usd:   number | null
 *   deadline_at:  ISO string | null
 *   requester_id: string    — masked caller ID (last 4 of phone or 'anon')
 *   timestamp:    ISO string
 *   source:       'localintel'
 * }
 *
 * Expected bid response shape from business agent (standard):
 * {
 *   accept:    boolean   — is the agent accepting this job?
 *   price:     number    — quoted USD price
 *   eta:       string    — e.g. "45 minutes" or "tomorrow 9am"
 *   message:   string    — short human-readable note
 *   agent_id:  string    — agent's self-identifier
 * }
 *
 * Non-compliant or timed-out responses: fall back to SMS/email.
 * All bids are stored in rfq_agent_bids table (auto-created).
 *
 * Best bid selection: lowest price among accepting agents with valid eta.
 * Tie-break: fastest eta_seconds parsed from eta string.
 * Notification: best bid triggers confirmSelection flow + fee log.
 */

const db = require('./db');

const BID_TIMEOUT_MS     = 8000;   // 8s per agent
const MAX_AGENT_TARGETS  = 10;     // max agents to fan out to per job
const BID_WAIT_MS        = 12000;  // wait 12s for all bids before selecting

// ── Table auto-create ─────────────────────────────────────────────────────────
let migrated = false;

async function migrate() {
  if (migrated) return;
  // Add agent columns to businesses if not present
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS agent_endpoint TEXT`);
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS agent_key TEXT`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS rfq_agent_bids (
      id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      rfq_id          TEXT NOT NULL,
      job_code        TEXT,
      business_id     TEXT NOT NULL,
      business_name   TEXT,
      agent_endpoint  TEXT NOT NULL,
      bid_accept      BOOLEAN,
      bid_price_usd   NUMERIC(10,2),
      bid_eta         TEXT,
      bid_message     TEXT,
      bid_agent_id    TEXT,
      http_status     INT,
      error           TEXT,
      latency_ms      INT,
      selected        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS rfq_agent_bids_rfq_id_idx ON rfq_agent_bids(rfq_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS rfq_agent_bids_business_id_idx ON rfq_agent_bids(business_id)`);
  migrated = true;
}

// ── Parse eta string to seconds (best effort) ─────────────────────────────────
function parseEtaSeconds(eta) {
  if (!eta) return Infinity;
  const s = String(eta).toLowerCase();
  const minMatch = s.match(/(\d+)\s*min/);
  const hrMatch  = s.match(/(\d+)\s*h(our)?/);
  const dayMatch = s.match(/(\d+)\s*day/);
  let secs = 0;
  if (dayMatch)  secs += parseInt(dayMatch[1], 10) * 86400;
  if (hrMatch)   secs += parseInt(hrMatch[1], 10) * 3600;
  if (minMatch)  secs += parseInt(minMatch[1], 10) * 60;
  // "tomorrow" = ~18h
  if (!secs && s.includes('tomorrow')) secs = 64800;
  return secs || Infinity;
}

// ── Send a single bid request to one agent ────────────────────────────────────
async function requestBid(agent, payload, agentKey) {
  const start = Date.now();
  let httpStatus = null;
  let error = null;
  let bid = null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BID_TIMEOUT_MS);

    const headers = {
      'Content-Type':  'application/json',
      'X-Source':      'localintel',
      'X-RFQ-ID':      payload.rfq_id,
    };
    if (agentKey) headers['X-Agent-Key'] = agentKey;

    const res = await fetch(agent.agent_endpoint, {
      method:  'POST',
      headers,
      body:    JSON.stringify(payload),
      signal:  controller.signal,
    });
    clearTimeout(timer);
    httpStatus = res.status;

    if (res.ok) {
      const json = await res.json().catch(() => null);
      if (json && typeof json.accept === 'boolean') {
        bid = {
          accept:    json.accept,
          price:     typeof json.price === 'number' ? json.price : null,
          eta:       json.eta   || null,
          message:   json.message || null,
          agent_id:  json.agent_id || null,
        };
      } else {
        error = 'non-standard response shape';
      }
    } else {
      error = `HTTP ${httpStatus}`;
    }
  } catch (e) {
    error = e.name === 'AbortError' ? 'timeout' : e.message;
  }

  return {
    business_id:    agent.business_id,
    business_name:  agent.name,
    agent_endpoint: agent.agent_endpoint,
    http_status:    httpStatus,
    error,
    latency_ms:     Date.now() - start,
    bid,
  };
}

// ── broadcastAgentRfq — fan out to all agents, collect bids ───────────────────
/**
 * Fan out a structured RFQ to all businesses in the matched set that
 * have an agent_endpoint set. Returns bids sorted by best price.
 *
 * @param {Object} job   — { id (uuid), code, category, zip, description, budget_usd, deadline_at, caller_phone }
 * @param {Array}  providers — from rfqBroadcast provider query (businesses rows)
 * @returns {Promise<{ bids: Array, selected: Object|null, agent_count: number }>}
 */
async function broadcastAgentRfq(job, providers) {
  await migrate();

  // Filter to only businesses with agent_endpoint
  const agentProviders = providers
    .filter(p => p.agent_endpoint)
    .slice(0, MAX_AGENT_TARGETS);

  if (!agentProviders.length) {
    return { bids: [], selected: null, agent_count: 0 };
  }

  // Mask caller phone — last 4 digits only
  const callerId = job.caller_phone
    ? '***-***-' + String(job.caller_phone).replace(/\D/g, '').slice(-4)
    : 'anon';

  const payload = {
    rfq_id:       job.id,
    job_code:     job.code,
    category:     job.category || null,
    zip:          job.zip || null,
    description:  job.description || '',
    budget_usd:   job.budget_usd || null,
    deadline_at:  job.deadline_at || null,
    requester_id: callerId,
    timestamp:    new Date().toISOString(),
    source:       'localintel',
  };

  console.log(`[agentBid] Broadcasting to ${agentProviders.length} agents for job ${job.code}`);

  // Fan out in parallel
  const bidPromises = agentProviders.map(p => requestBid(p, payload, p.agent_key || null));

  // Wait for all with a global ceiling
  const results = await Promise.all(
    bidPromises.map(p =>
      Promise.race([
        p,
        new Promise(resolve =>
          setTimeout(() => resolve({ business_id: null, error: 'global_timeout', bid: null }), BID_WAIT_MS)
        ),
      ])
    )
  );

  // Persist all bids to Postgres
  for (const r of results) {
    if (!r.business_id) continue;
    try {
      await db.query(
        `INSERT INTO rfq_agent_bids
           (rfq_id, job_code, business_id, business_name, agent_endpoint,
            bid_accept, bid_price_usd, bid_eta, bid_message, bid_agent_id,
            http_status, error, latency_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          job.id,
          job.code,
          r.business_id,
          r.business_name || null,
          r.agent_endpoint,
          r.bid?.accept ?? null,
          r.bid?.price ?? null,
          r.bid?.eta || null,
          r.bid?.message || null,
          r.bid?.agent_id || null,
          r.http_status || null,
          r.error || null,
          r.latency_ms || null,
        ]
      );
    } catch (e) {
      console.error('[agentBid] bid insert error:', e.message);
    }
  }

  // Collect valid accepting bids
  const accepting = results
    .filter(r => r.bid?.accept === true && typeof r.bid.price === 'number')
    .sort((a, b) => {
      // Primary sort: price ascending
      const priceDiff = (a.bid.price || 0) - (b.bid.price || 0);
      if (priceDiff !== 0) return priceDiff;
      // Tie-break: fastest eta
      return parseEtaSeconds(a.bid.eta) - parseEtaSeconds(b.bid.eta);
    });

  const selected = accepting[0] || null;

  if (selected) {
    // Mark selected in DB
    await db.query(
      `UPDATE rfq_agent_bids SET selected = TRUE
        WHERE rfq_id = $1 AND business_id = $2 AND selected = FALSE
        ORDER BY created_at DESC
        LIMIT 1`,
      [job.id, selected.business_id]
    ).catch(() => {}); // non-fatal

    console.log(
      `[agentBid] Job ${job.code} — best bid: ${selected.business_name || selected.business_id} ` +
      `$${selected.bid.price} ETA=${selected.bid.eta || 'N/A'}`
    );
  } else {
    console.log(`[agentBid] Job ${job.code} — no accepting agent bids`);
  }

  return {
    bids:        accepting,
    selected,
    agent_count: agentProviders.length,
    all_results: results,
  };
}

// ── getAgentBidsForJob — used by dashboard + confirmSelection ─────────────────
async function getAgentBidsForJob(rfq_id) {
  await migrate();
  return db.query(
    `SELECT * FROM rfq_agent_bids WHERE rfq_id = $1 ORDER BY created_at ASC`,
    [rfq_id]
  );
}

module.exports = {
  broadcastAgentRfq,
  getAgentBidsForJob,
  migrate,
};
