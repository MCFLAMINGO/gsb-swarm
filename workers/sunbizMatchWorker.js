'use strict';
/**
 * workers/sunbizMatchWorker.js — B120
 *
 * Match rows in sunbiz_raw to rows in businesses, then:
 *   1. Upsert agent + state-registry evidence into source_evidence (source_id='fl_sunbiz').
 *   2. When the business has a website, derive probable owner emails
 *      (firstname.lastname@domain, firstnamelastname@domain, firstname@domain)
 *      from the registered_agent name and store them in source_evidence
 *      under source_id='fl_sunbiz_probable_email' with confidence 0.4.
 *   3. Mark the business as state-verified by including 'state_verified' in tags.
 *
 * Match rules:
 *   - normalize(corp_name) ≈ normalize(business_name)  (strip LLC, INC, CORP, CO, LP)
 *   - zip first 5 chars match
 *   - Use pg_trgm similarity ≥ 0.55 for fuzzy comparison, gated by exact-zip equality
 *
 * Worker contract: read Postgres → skip already processed → work new → upsert → exit clean.
 * Idempotent — safe to re-run. Process in batches of 500. Manual trigger only.
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

// ── Already-processed set ─────────────────────────────────────────────────────
// We treat a sunbiz_raw row as processed when `resolved = TRUE`.
// The schema already provides sunbiz_raw.resolved and sunbiz_raw.resolved_business_id.

async function fetchUnresolvedBatch(offset) {
  return db.query(
    `SELECT id, doc_number, entity_name, status, principal_zip,
            registered_agent, agent_address, filed_date
       FROM sunbiz_raw
      WHERE resolved = FALSE
        AND entity_name IS NOT NULL
        AND principal_zip IS NOT NULL
      ORDER BY id
      LIMIT $1 OFFSET $2`,
    [BATCH_SIZE, offset]
  );
}

async function findBusinessMatch(rawRow) {
  const normCorp = normalizeName(rawRow.entity_name);
  if (!normCorp) return null;
  const zip5 = String(rawRow.principal_zip || '').trim().substring(0, 5);
  if (!/^\d{5}$/.test(zip5)) return null;

  // Same zip + similarity on the normalized names.
  // Use translate/regexp_replace inline for businesses.name normalization to mirror normalizeName.
  const rows = await db.query(
    `SELECT business_id, name, website, zip
       FROM businesses
      WHERE zip = $1
        AND name IS NOT NULL
        AND similarity(
              regexp_replace(upper(name), '\\m(LLC|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|PA|PLLC|PC|LTD)\\M', '', 'g'),
              $2
            ) >= $3
      ORDER BY similarity(
                 regexp_replace(upper(name), '\\m(LLC|INC|INCORPORATED|CORP|CORPORATION|CO|COMPANY|LP|LLP|PA|PLLC|PC|LTD)\\M', '', 'g'),
                 $2
               ) DESC
      LIMIT 1`,
    [zip5, normCorp, SIMILARITY_THRESHOLD]
  );
  return rows && rows.length ? rows[0] : null;
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

async function markRawResolved(rawId, businessId) {
  await db.query(
    `UPDATE sunbiz_raw
        SET resolved = TRUE,
            resolved_business_id = $2
      WHERE id = $1`,
    [rawId, businessId]
  );
}

async function processOne(raw) {
  const biz = await findBusinessMatch(raw);
  if (!biz) {
    // No match — leave resolved=FALSE so future runs (with more businesses) can retry.
    return { matched: false, emails: 0 };
  }

  // 1. Officer / agent evidence
  await upsertEvidence(
    biz.business_id,
    'fl_sunbiz',
    raw.doc_number,
    {
      corp_num: raw.doc_number,
      corp_name: raw.entity_name,
      status: raw.status,
      file_date: raw.filed_date,
      principal_zip: raw.principal_zip,
      registered_agent_name: raw.registered_agent || null,
      registered_agent_address: raw.agent_address || null,
    },
    0.9
  );

  // 2. Probable email derivation when website + real person agent name exist
  let emailsCount = 0;
  const domain = extractDomain(biz.website);
  const person = parsePersonName(raw.registered_agent);
  if (domain && person) {
    const emails = deriveEmails(person, domain);
    if (emails.length) {
      await upsertEvidence(
        biz.business_id,
        'fl_sunbiz_probable_email',
        raw.doc_number,
        {
          corp_num: raw.doc_number,
          agent_name: raw.registered_agent,
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

  // 3. Tag business state-verified
  await tagStateVerified(biz.business_id);

  // 4. Mark raw row resolved
  await markRawResolved(raw.id, biz.business_id);

  return { matched: true, emails: emailsCount };
}

async function runMatch() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.error('[sunbizMatchWorker] LOCAL_INTEL_DB_URL not set — exiting');
    return { skipped: true };
  }

  await ensureExtensions();

  const t0 = Date.now();
  await logWorkerEvent({ eventType: 'start' });

  const totalRaw = await db.query(`SELECT COUNT(*)::int AS c FROM sunbiz_raw`);
  const unresolvedCount = await db.query(`SELECT COUNT(*)::int AS c FROM sunbiz_raw WHERE resolved = FALSE`);
  console.log(`[sunbizMatchWorker] sunbiz_raw total=${totalRaw[0]?.c || 0}, unresolved=${unresolvedCount[0]?.c || 0}`);

  let totalSeen = 0;
  let totalMatched = 0;
  let totalEmails = 0;
  let offset = 0;
  let nextProgressMark = 1000;

  for (;;) {
    const batch = await fetchUnresolvedBatch(offset);
    if (!batch || batch.length === 0) break;

    let matchedInBatch = 0;
    for (const raw of batch) {
      totalSeen++;
      const { matched, emails } = await processOne(raw);
      if (matched) {
        totalMatched++;
        matchedInBatch++;
        totalEmails += emails;
      }
      if (totalMatched >= nextProgressMark) {
        console.log(`[sunbizMatchWorker] progress — scanned=${totalSeen} matched=${totalMatched} emails=${totalEmails}`);
        nextProgressMark += 1000;
      }
    }

    // Matched rows flipped to resolved=TRUE and dropped out of the WHERE clause —
    // they no longer occupy positions in subsequent fetches.
    // Unmatched rows remain at resolved=FALSE; advance offset past them to make progress.
    offset += (batch.length - matchedInBatch);
    if (batch.length < BATCH_SIZE) break;
  }

  const durationMs = Date.now() - t0;
  await logWorkerEvent({
    eventType: 'end',
    recordsIn: totalSeen,
    recordsOut: totalMatched,
    durationMs,
  });
  console.log(`[sunbizMatchWorker] DONE — scanned=${totalSeen} matched=${totalMatched} probable_emails=${totalEmails} duration_ms=${durationMs}`);
  return { scanned: totalSeen, matched: totalMatched, probable_emails: totalEmails, duration_ms: durationMs };
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
