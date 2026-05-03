'use strict';
/**
 * businessMergeWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Cluster-merge duplicate `businesses` rows into one canonical record.
 *
 *   Zero LLM. Pure deterministic clustering on phone + name/address proximity.
 *
 * Algorithm:
 *   1. Load candidate rows (active, not already marked duplicate_of)
 *   2. Build Union-Find over rows with edges when EITHER:
 *        - same normalized phone (digits only, ≥10), OR
 *        - same normalized name AND (same zip OR same address-prefix)
 *   3. For every cluster of size ≥ 2:
 *        - score each row (confidence + claimed + completeness)
 *        - pick highest-scoring row as canonical
 *        - merge best non-null fields from siblings into canonical
 *        - reassign business_tasks.business_id from sibling → canonical
 *        - DELETE sibling rows (FKs cascade where set; otherwise reassign first)
 *
 * Exports:
 *   runMerge()      — full pass, returns { clusters, merged, deleted, errors }
 *   triggerMerge()  — fire-and-forget alias around runMerge() for hooks
 *
 * Cycle (when run as standalone worker):
 *   once on start, then every 6h.
 */

const db = require('../lib/db');
const { logWorker } = require('../lib/telemetry');

const CYCLE_MS = 6 * 60 * 60 * 1000;
const STAGGER_MS = 90 * 1000;

// ── Helpers ──────────────────────────────────────────────────────────────────
function normalizePhone(p) {
  if (!p) return null;
  const digits = String(p).replace(/\D/g, '');
  if (digits.length < 10) return null;
  // Drop leading "1" country code for US numbers
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

function normalizeName(n) {
  if (!n) return null;
  let s = String(n).toLowerCase().trim();
  // Drop common suffixes that Overpass appends like " - Barbecue Restaurant"
  s = s.replace(/\s*-\s*[a-z][a-z\s]+$/i, '');
  // Strip non-alnum
  s = s.replace(/[^a-z0-9]+/g, ' ').trim();
  // Drop trivial trailing words
  s = s.replace(/\b(restaurant|inc|llc|co|company|the)\b/g, '').trim();
  s = s.replace(/\s+/g, ' ');
  return s || null;
}

function normalizeAddrPrefix(a) {
  if (!a) return null;
  const s = String(a).toLowerCase().trim();
  // Take everything up to the first comma OR the first 30 chars
  const head = s.split(',')[0].trim().slice(0, 30);
  return head.replace(/\s+/g, ' ') || null;
}

// Score for canonical selection — higher = better.
function scoreRow(row) {
  let s = 0;
  s += Number(row.confidence_score || 0) * 100;       // 0..100 scaled
  if (row.claimed_at)               s += 200;          // claimed beats unclaimed
  if (row.owner_verified)           s += 80;
  if (row.phone)                    s += 10;
  if (row.website)                  s += 10;
  if (row.hours || row.hours_json)  s += 8;
  if (row.description)              s += 6;
  if (row.category)                 s += 4;
  if (row.lat && row.lon)           s += 4;
  if (row.address)                  s += 4;
  if (row.services_text)            s += 4;
  if (row.category_intel)           s += 4;
  if (row.menu_url)                 s += 2;
  // Tie-break: longer name (more specific) wins slightly
  s += Math.min(20, (row.name || '').length / 5);
  return s;
}

// ── Union-Find ───────────────────────────────────────────────────────────────
class UF {
  constructor() { this.p = new Map(); }
  find(x) {
    if (!this.p.has(x)) this.p.set(x, x);
    let r = x;
    while (this.p.get(r) !== r) r = this.p.get(r);
    // Path compression
    let cur = x;
    while (this.p.get(cur) !== r) {
      const nxt = this.p.get(cur);
      this.p.set(cur, r);
      cur = nxt;
    }
    return r;
  }
  union(a, b) {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.p.set(ra, rb);
  }
}

// ── Cluster build ────────────────────────────────────────────────────────────
function buildClusters(rows) {
  const uf = new UF();
  const byPhone = new Map();
  const byNameZip = new Map();
  const byNameAddr = new Map();

  for (const r of rows) {
    uf.find(r.business_id);  // ensure node exists

    const phone = normalizePhone(r.phone);
    if (phone) {
      if (byPhone.has(phone)) uf.union(r.business_id, byPhone.get(phone));
      else byPhone.set(phone, r.business_id);
    }

    const name = normalizeName(r.name);
    if (name) {
      if (r.zip) {
        const k = name + '|' + String(r.zip).trim();
        if (byNameZip.has(k)) uf.union(r.business_id, byNameZip.get(k));
        else byNameZip.set(k, r.business_id);
      }
      const addr = normalizeAddrPrefix(r.address);
      if (addr) {
        const k = name + '|' + addr;
        if (byNameAddr.has(k)) uf.union(r.business_id, byNameAddr.get(k));
        else byNameAddr.set(k, r.business_id);
      }
    }
  }

  // Group rows by cluster root, only keep clusters of size ≥ 2
  const clusters = new Map();
  for (const r of rows) {
    const root = uf.find(r.business_id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(r);
  }
  return [...clusters.values()].filter(c => c.length >= 2);
}

// ── Merge a single cluster ───────────────────────────────────────────────────
async function mergeCluster(cluster) {
  const sorted = [...cluster].sort((a, b) => scoreRow(b) - scoreRow(a));
  const canonical = sorted[0];
  const siblings = sorted.slice(1);

  // Merge: for each sibling, fold non-null fields into canonical (only if canonical missing)
  const fillFields = [
    'phone', 'website', 'hours', 'hours_json', 'address', 'city', 'state',
    'lat', 'lon', 'category', 'category_group', 'description', 'tags',
    'services_text', 'services_json', 'menu_url', 'category_intel',
    'pos_config', 'price_tier', 'sunbiz_doc_number', 'sunbiz_entity_type',
    'sunbiz_status', 'sunbiz_agent_name', 'sunbiz_agent_addr', 'naics_code',
    'has_hours',
  ];
  const merged = { ...canonical };
  for (const sib of siblings) {
    for (const f of fillFields) {
      if (merged[f] == null || merged[f] === '') {
        if (sib[f] != null && sib[f] !== '') merged[f] = sib[f];
      }
    }
    // Keep highest confidence_score across cluster
    if (Number(sib.confidence_score || 0) > Number(merged.confidence_score || 0)) {
      merged.confidence_score = sib.confidence_score;
    }
  }

  // Persist merged canonical
  await db.query(
    `UPDATE businesses SET
        phone               = COALESCE($2, phone),
        website             = COALESCE($3, website),
        hours               = COALESCE($4, hours),
        hours_json          = COALESCE($5, hours_json),
        address             = COALESCE($6, address),
        city                = COALESCE($7, city),
        state               = COALESCE($8, state),
        lat                 = COALESCE($9, lat),
        lon                 = COALESCE($10, lon),
        category            = COALESCE($11, category),
        category_group      = COALESCE($12, category_group),
        description         = COALESCE(NULLIF(description, ''), $13),
        tags                = COALESCE(tags, $14),
        services_text       = COALESCE(NULLIF(services_text, ''), $15),
        services_json       = COALESCE(services_json, $16),
        menu_url            = COALESCE(menu_url, $17),
        category_intel      = COALESCE(category_intel, $18),
        pos_config          = COALESCE(pos_config, $19),
        price_tier          = COALESCE(price_tier, $20),
        sunbiz_doc_number   = COALESCE(sunbiz_doc_number, $21),
        sunbiz_entity_type  = COALESCE(sunbiz_entity_type, $22),
        sunbiz_status       = COALESCE(sunbiz_status, $23),
        sunbiz_agent_name   = COALESCE(sunbiz_agent_name, $24),
        sunbiz_agent_addr   = COALESCE(sunbiz_agent_addr, $25),
        naics_code          = COALESCE(naics_code, $26),
        has_hours           = COALESCE(has_hours, $27),
        confidence_score    = GREATEST(confidence_score, $28),
        updated_at          = NOW()
      WHERE business_id = $1`,
    [
      canonical.business_id,
      merged.phone, merged.website, merged.hours, merged.hours_json,
      merged.address, merged.city, merged.state, merged.lat, merged.lon,
      merged.category, merged.category_group, merged.description, merged.tags,
      merged.services_text,
      merged.services_json ? JSON.stringify(merged.services_json) : null,
      merged.menu_url,
      merged.category_intel ? JSON.stringify(merged.category_intel) : null,
      merged.pos_config ? JSON.stringify(merged.pos_config) : null,
      merged.price_tier,
      merged.sunbiz_doc_number, merged.sunbiz_entity_type, merged.sunbiz_status,
      merged.sunbiz_agent_name, merged.sunbiz_agent_addr,
      merged.naics_code, merged.has_hours,
      Number(merged.confidence_score || 0),
    ]
  );

  // Reassign business_tasks BEFORE deleting siblings (no ON DELETE SET NULL there)
  const sibIds = siblings.map(s => s.business_id);
  if (sibIds.length) {
    // Run all FK reassigns in parallel — they touch different tables, no interlock
    const reassignTables = [
      'business_tasks', 'source_evidence', 'notification_queue',
      'task_events', 'business_responsiveness',
    ];
    await Promise.all(reassignTables.map(t =>
      db.query(
        `UPDATE ${t} SET business_id = $1 WHERE business_id = ANY($2::uuid[])`,
        [canonical.business_id, sibIds]
      ).catch(() => null)  // table may not exist
    ));
    // Clear any duplicate_of self-refs that point at the siblings
    await db.query(
      `UPDATE businesses SET duplicate_of = $1 WHERE duplicate_of = ANY($2::uuid[])`,
      [canonical.business_id, sibIds]
    ).catch(() => null);
    // Finally delete the sibling rows
    await db.query(
      `DELETE FROM businesses WHERE business_id = ANY($1::uuid[])`,
      [sibIds]
    );
  }

  return { canonical: canonical.business_id, merged_in: sibIds.length };
}

// ── Main entrypoint ──────────────────────────────────────────────────────────
async function runMerge() {
  const t0 = Date.now();
  console.log('[business-merge] Pass starting');

  const rows = await db.query(
    `SELECT business_id, name, name_aliases, phone, address, city, state, zip,
            lat, lon, website, hours, hours_json, category, category_group,
            description, tags, services_text, services_json, menu_url,
            category_intel, pos_config, price_tier, naics_code, has_hours,
            sunbiz_doc_number, sunbiz_entity_type, sunbiz_status,
            sunbiz_agent_name, sunbiz_agent_addr,
            confidence_score, owner_verified, claimed_at,
            duplicate_of, status
       FROM businesses
      WHERE (status IS NULL OR status = 'active')
        AND duplicate_of IS NULL`
  );

  console.log(`[business-merge] Loaded ${rows.length} active rows`);

  const clusters = buildClusters(rows);
  console.log(`[business-merge] Found ${clusters.length} cluster(s) of ≥2 rows`);

  let merged = 0, deleted = 0, errors = 0;
  // Process clusters with bounded concurrency — pool max=2, but with parallel
  // FK reassigns inside each cluster, 2-wide cluster pipeline keeps the pool
  // saturated without queuing.
  const CONCURRENCY = 2;
  let idx = 0;
  async function worker() {
    while (idx < clusters.length) {
      const i = idx++;
      try {
        const r = await mergeCluster(clusters[i]);
        merged++;
        deleted += r.merged_in;
      } catch (e) {
        errors++;
        console.error('[business-merge] cluster merge failed:', e.message);
      }
      if ((merged + errors) % 100 === 0) {
        console.log(`[business-merge] progress — clusters=${merged + errors}/${clusters.length} deleted=${deleted}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  const duration = Date.now() - t0;
  const summary = {
    rows: rows.length,
    clusters: clusters.length,
    merged,
    deleted,
    errors,
    duration_ms: duration,
  };
  console.log(`[business-merge] Pass complete — ${JSON.stringify(summary)}`);

  try {
    await logWorker({
      worker_name: 'businessMergeWorker',
      event_type: errors > 0 ? 'complete' : 'complete',
      input_summary: `rows=${rows.length}`,
      output_summary: `clusters=${clusters.length} merged=${merged} deleted=${deleted} errors=${errors}`,
      duration_ms: duration,
      records_in: rows.length,
      records_out: deleted,
      success_rate: clusters.length ? Math.round((merged / clusters.length) * 100) : 100,
      meta: summary,
    });
  } catch (_) {}

  return summary;
}

// Fire-and-forget hook used by overpassWorker at the end of every runPass()
async function triggerMerge() {
  try {
    return await runMerge();
  } catch (e) {
    console.error('[business-merge] triggerMerge error:', e.message);
    return { error: e.message };
  }
}

module.exports = { runMerge, triggerMerge };

// ── Daemon mode (only when invoked as the main process) ──────────────────────
if (require.main === module) {
  (async function main() {
    console.log('[business-merge] Worker started — deterministic cluster merge, zero LLM');
    await new Promise(r => setTimeout(r, STAGGER_MS));

    while (true) {
      try {
        await runMerge();
      } catch (err) {
        console.error('[business-merge] Cycle error:', err.message);
        try {
          await logWorker({
            worker_name: 'businessMergeWorker',
            event_type: 'fail',
            error_message: err.message,
          });
        } catch (_) {}
      }
      await new Promise(r => setTimeout(r, CYCLE_MS));
    }
  })();
}
