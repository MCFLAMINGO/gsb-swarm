'use strict';
/**
 * workers/sunbizMatchWorker.js — B121
 *
 * Enrichment pass over businesses that were imported from FL DOS SunBiz.
 * sunbizWorker now writes sunbiz_agent_name + sunbiz_agent_addr directly onto
 * the businesses row, so no cross-table fuzzy match is needed.
 *
 * This worker:
 *   1. Scans businesses WHERE sunbiz_doc_number IS NOT NULL (state-registered).
 *   2. Upserts fl_sunbiz evidence into source_evidence.
 *   3. When the business has a website + a real person agent name, derives
 *      probable owner emails (firstname.lastname@domain etc.) into source_evidence
 *      under source_id='fl_sunbiz_probable_email' with confidence 0.4.
 *   4. Tags the business state_verified + sets owner_verified = TRUE.
 *
 * Idempotency gate: source_evidence ON CONFLICT DO UPDATE — safe to re-run.
 * Uses owner_verified = FALSE as the "not yet processed" signal.
 * Worker contract: read Postgres → skip already processed → work new → upsert → exit clean.
 * Process in batches of 500. Manual trigger only.
 */

require('dotenv').config();
const db = require('../lib/db');
const hb = require('../lib/workerHeartbeat');

const BATCH_SIZE = 500;
const SIMILARITY_THRESHOLD = 0.55;
const PROBABLE_EMAIL_CONFIDENCE = 0.4;

// ── worker_events logger ──────────────────────────────────────────────────────
async function logWorkerEvent({ eventType, recordsIn, recordsOut, durationMs, error }) {
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['sunbizMatchWorker', eventType, recordsIn || 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (e) { console.warn('[sunbizMatchWorker] worker_events log failed:', e.message); }
}

// ── Normalize a business or corp name for matching ────────────────────────────
function normalizeName(s) {
  if (!s) return '';
  return String(s)
    .toUpperCase()
    .replace(/[.,'"]/g, ' ')
    .replace(/\b(LLC|L\.L\.C|LIMITED LIABILITY COMPANY|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|PA|PLLC|PC|LTD)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Domain extraction from website ────────────────────────────────────────────
function extractDomain(website) {
  if (!website) return null;
  try {
    let url = String(website).trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    // crude filter — must look like a real domain with a TLD
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) return null;
    // skip clearly aggregator hosts
    const blocked = new Set(['facebook.com', 'instagram.com', 'yelp.com', 'google.com', 'linkedin.com', 'twitter.com', 'x.com']);
    if (blocked.has(host)) return null;
    return host;
  } catch (_) { return null; }
}

// ── Officer name parsing — only allow real person names ───────────────────────
const NON_PERSON_TOKENS = /\b(LLC|INC|CORP|CO|COMPANY|LP|LLP|PA|PLLC|PC|LTD|SAME|ABOVE|AGENT|TRUST|TRUSTEE|HOLDING|GROUP|SERVICES|ASSOCIATES|PARTNERS)\b/i;

function parsePersonName(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length < 3 || s.length > 80) return null;
  if (NON_PERSON_TOKENS.test(s)) return null;

  // Sunbiz agent names often arrive as "LAST, FIRST MIDDLE" or "FIRST LAST"
  let first = null, last = null;
  if (s.includes(',')) {
    const [lastPart, restPart] = s.split(',', 2).map(p => p.trim());
    const restTokens = (restPart || '').split(/\s+/).filter(Boolean);
    last = lastPart;
    first = restTokens[0] || null;
  } else {
    const tokens = s.split(/\s+/).filter(Boolean);
    if (tokens.length < 2) return null;
    first = tokens[0];
    last = tokens[tokens.length - 1];
  }

  if (!first || !last) return null;
  first = first.replace(/[^A-Za-z\-]/g, '');
  last = last.replace(/[^A-Za-z\-]/g, '');
  if (first.length < 2 || last.length < 2) return null;
  // reject single-initial first names (e.g. "J SMITH")
  if (first.length < 2) return null;
  return {
    first: first.toLowerCase(),
    last: last.toLowerCase(),
  };
}

function deriveEmails(personName, domain) {
  if (!personName || !domain) return [];
  const { first, last } = personName;
  return [
    `${first}.${last}@${domain}`,
    `${first}${last}@${domain}`,
    `${first}@${domain}`,
  ];
}

// ── Ensure pg_trgm — schema.sql already creates it, but be defensive ──────────
async function ensureExtensions() {
  await db.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);
}

// ── Fetch businesses needing enrichment ──────────────────────────────────────
// Gate: sunbiz_doc_number set (imported from FL DOS) + not yet owner_verified.
// Idempotent — re-running after owner_verified=TRUE skips already-done rows.

async function fetchUnprocessedBatch(offset) {
  return db.query(
    `SELECT business_id, sunbiz_doc_number AS doc_number, name AS entity_name,
            status, zip AS principal_zip, registered_date AS filed_date,
            sunbiz_agent_name AS registered_agent,
            sunbiz_agent_addr AS agent_address,
            website
       FROM businesses
      WHERE sunbiz_doc_number IS NOT NULL
        AND owner_verified = FALSE
      ORDER BY business_id
      LIMIT $1 OFFSET $2`,
    [BATCH_SIZE, offset]
  );
}

async function upsertEvidence(businessId, sourceId, sourceRecordId, data, weight) {
  await db.query(
    `INSERT INTO source_evidence (business_id, source_id, source_record_id, raw_data, weight, fetched_at)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (business_id, source_id) DO UPDATE SET
       source_record_id = EXCLUDED.source_record_id,
       raw_data         = EXCLUDED.raw_data,
       weight           = EXCLUDED.weight,
       fetched_at       = NOW()`,
    [businessId, sourceId, sourceRecordId, JSON.stringify(data), weight]
  );
}

async function tagStateVerified(businessId) {
  await db.query(
    `UPDATE businesses
        SET tags = (
          SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(tags, '{}') || ARRAY['state_verified']))
        ),
        owner_verified = TRUE,
        updated_at = NOW()
      WHERE business_id = $1`,
    [businessId]
  );
}

// markRawResolved removed — sunbiz_raw is no longer the source of truth.
// businesses.owner_verified = TRUE is the idempotency gate.

async function processOne(biz) {
  // 1. State-registry evidence
  await upsertEvidence(
    biz.business_id,
    'fl_sunbiz',
    biz.doc_number,
    {
      corp_num: biz.doc_number,
      corp_name: biz.entity_name,
      status: biz.status,
      file_date: biz.filed_date,
      principal_zip: biz.principal_zip,
      registered_agent_name: biz.registered_agent || null,
      registered_agent_address: biz.agent_address || null,
    },
    0.9
  );

  // 2. Probable email derivation when website + real person agent name exist
  let emailsCount = 0;
  const domain = extractDomain(biz.website);
  const person = parsePersonName(biz.registered_agent);
  if (domain && person) {
    const emails = deriveEmails(person, domain);
    if (emails.length) {
      await upsertEvidence(
        biz.business_id,
        'fl_sunbiz_probable_email',
        biz.doc_number,
        {
          corp_num: biz.doc_number,
          agent_name: biz.registered_agent,
          domain,
          probable_emails: emails,
          confidence: PROBABLE_EMAIL_CONFIDENCE,
          unverified: true,
        },
        PROBABLE_EMAIL_CONFIDENCE
      );
      emailsCount = emails.length;
    }
  }

  // 3. Tag business state-verified + flip owner_verified so we skip on re-run
  await tagStateVerified(biz.business_id);

  return { emails: emailsCount };
}

async function runMatch() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.error('[sunbizMatchWorker] LOCAL_INTEL_DB_URL not set — exiting');
    return { skipped: true };
  }

  await ensureExtensions();

  const t0 = Date.now();
  await logWorkerEvent({ eventType: 'start' });

  const pendingCount = await db.query(
    `SELECT COUNT(*)::int AS c FROM businesses WHERE sunbiz_doc_number IS NOT NULL AND owner_verified = FALSE`
  );
  console.log(`[sunbizMatchWorker] businesses pending enrichment=${pendingCount[0]?.c || 0}`);

  let totalSeen = 0;
  let totalEmails = 0;
  let offset = 0;
  let nextProgressMark = 5000;

  for (;;) {
    const batch = await fetchUnprocessedBatch(offset);
    if (!batch || batch.length === 0) break;

    for (const biz of batch) {
      totalSeen++;
      const { emails } = await processOne(biz);
      totalEmails += emails;
      if (totalSeen >= nextProgressMark) {
        console.log(`[sunbizMatchWorker] progress — enriched=${totalSeen} probable_emails=${totalEmails}`);
        nextProgressMark += 5000;
      }
    }

    // owner_verified flipped to TRUE — those rows drop out of the next fetch.
    // offset stays at 0; window shrinks naturally.
    if (batch.length < BATCH_SIZE) break;
  }

  const durationMs = Date.now() - t0;
  await logWorkerEvent({
    eventType: 'end',
    recordsIn: totalSeen,
    recordsOut: totalEmails,
    durationMs,
  });
  console.log(`[sunbizMatchWorker] DONE — enriched=${totalSeen} probable_emails=${totalEmails} duration_ms=${durationMs}`);
  return { enriched: totalSeen, probable_emails: totalEmails, duration_ms: durationMs };
}

if (require.main === module) {
  // Manual trigger gate — mirrors sunbizWorker pattern.
  if (process.env.SUNBIZ_MATCH_MANUAL_TRIGGER !== 'true') {
    console.log('[sunbizMatchWorker] Skipping auto-run — manual trigger required (set SUNBIZ_MATCH_MANUAL_TRIGGER=true)');
    process.exit(0);
  }

  runMatch()
    .then(async (r) => {
      try { await hb.ping('sunbizMatchWorker'); } catch (_) {}
      console.log('[sunbizMatchWorker] Run complete:', JSON.stringify(r));
      process.exit(0);
    })
    .catch(async (e) => {
      console.error('[sunbizMatchWorker] Fatal error:', e.message, e.stack);
      await logWorkerEvent({ eventType: 'error', error: e.message }).catch(() => {});
      process.exit(1);
    });
}

module.exports = { runMatch, normalizeName, extractDomain, parsePersonName, deriveEmails };
