'use strict';
/**
 * businessMergeWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Finds duplicate business rows in Postgres, merges them into one confident
 * canonical record, and deletes the weaker duplicates.
 *
 * Duplicate detection — a cluster is formed when rows share ANY of:
 *   1. Same normalized 10-digit phone number (strongest signal)
 *   2. Same normalized name slug + same normalized address block
 *
 * Merge strategy — canonical row = highest score row in the cluster:
 *   wallet(8) + claimed_at(4) + website(2) + phone(1) + hours_json(1) + description(1)
 *
 * Merge fills in the canonical row with the best fields from all cluster members:
 *   phone, website, hours_json, description, services_text, category, lat, lon,
 *   address, city, confidence_score
 *
 * Before deleting a non-canonical row:
 *   - Reassign its business_tasks to the canonical business_id
 *
 * Worker contract:
 *   1. Skip set — track merge runs via worker_events (skip if last run < 6h ago
 *      unless FULL_REFRESH=true)
 *   2. Work     — find clusters, merge, delete
 *   3. Log      — worker_events
 *   4. Loop     — runs every 12h (and can be triggered externally)
 */

const db = require('../lib/db');

const LOOP_SLEEP_H  = 12;
const MIN_RUN_GAP_H = 6;   // don't re-run if last run was < 6h ago (unless FULL_REFRESH)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Normalisation helpers ─────────────────────────────────────────────────────
const normPhone = p => (p || '').replace(/\D/g, '').slice(-10);
const normName  = n => (n || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
// Normalise address to first ~20 alphanum chars of the street component
const normAddr  = a => {
  if (!a) return '';
  // Strip unit/suite suffixes, lowercase, keep only alphanum
  return a.toLowerCase()
    .replace(/\b(suite|ste|unit|apt|#|floor|fl|building|bldg)[\s\d]*/gi, '')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 20);
};

// ── Row scoring (higher = richer, wins the merge) ─────────────────────────────
function scoreRow(r) {
  return (r.wallet       ? 8 : 0)
       + (r.claimed_at   ? 4 : 0)
       + (r.website      ? 2 : 0)
       + (r.phone        ? 1 : 0)
       + (r.hours_json   ? 1 : 0)
       + (r.description  ? 1 : 0);
}

// ── Build duplicate clusters from full row set ────────────────────────────────
function buildClusters(rows) {
  // Union-Find (path-compressed)
  const parent = {};
  const find = id => {
    if (parent[id] === undefined) parent[id] = id;
    if (parent[id] !== id) parent[id] = find(parent[id]);
    return parent[id];
  };
  const union = (a, b) => { parent[find(a)] = find(b); };

  // Index by phone
  const byPhone = {};  // normPhone → first business_id seen
  // Index by name+addr
  const byNameAddr = {};  // normName|normAddr → first business_id seen

  for (const r of rows) {
    const ph = normPhone(r.phone);
    const nm = normName(r.name);
    const ad = normAddr(r.address);
    const id = r.business_id;

    // Phone cluster — only cluster if names are similar (share ≥4 char common prefix
    // or one name contains the other) to avoid grouping different practices at shared lines
    if (ph && ph.length === 10) {
      if (byPhone[ph] !== undefined) {
        const existingRow = rows.find(r => r.business_id === byPhone[ph]);
        const existingNm = existingRow ? normName(existingRow.name) : '';
        const prefixLen = Math.min(nm.length, existingNm.length);
        const commonPrefix = nm.slice(0, prefixLen) === existingNm.slice(0, prefixLen) ? prefixLen : 0;
        const oneContains = nm.includes(existingNm.slice(0,6)) || existingNm.includes(nm.slice(0,6));
        if (commonPrefix >= 4 || oneContains) {
          union(id, byPhone[ph]);
        }
      } else {
        byPhone[ph] = id;
      }
    }

    // Name+address cluster
    if (nm && ad && ad.length >= 4) {
      const key = `${nm}|${ad}`;
      if (byNameAddr[key] !== undefined) {
        union(id, byNameAddr[key]);
      } else {
        byNameAddr[key] = id;
      }
    }
  }

  // Group rows by root
  const clusters = {};
  for (const r of rows) {
    const root = find(r.business_id);
    if (!clusters[root]) clusters[root] = [];
    clusters[root].push(r);
  }

  // Only return clusters with 2+ members
  return Object.values(clusters).filter(c => c.length >= 2);
}

// ── Merge a cluster into one canonical row ────────────────────────────────────
async function mergeCluster(cluster) {
  // Sort: highest score first
  cluster.sort((a, b) => scoreRow(b) - scoreRow(a));
  const canonical = cluster[0];
  const dupes     = cluster.slice(1);

  // Build merged field values — best non-null from all members
  const merged = {
    name:          canonical.name,
    phone:         canonical.phone,
    website:       canonical.website,
    hours_json:    canonical.hours_json,
    description:   canonical.description,
    services_text: canonical.services_text,
    category:      canonical.category,
    lat:           canonical.lat,
    lon:           canonical.lon,
    address:       canonical.address,
    city:          canonical.city,
    confidence_score: parseFloat(canonical.confidence_score || 0.5),
  };

  for (const dupe of dupes) {
    if (!merged.phone     && dupe.phone)       merged.phone       = dupe.phone;
    if (!merged.website   && dupe.website)     merged.website     = dupe.website;
    if (!merged.hours_json && dupe.hours_json) merged.hours_json  = dupe.hours_json;
    if (!merged.address   && dupe.address)     merged.address     = dupe.address;
    if (!merged.city      && dupe.city)        merged.city        = dupe.city;
    // Prefer most precise lat/lon (most decimal places)
    if (dupe.lat && dupe.lon) {
      const dupePrec = (String(dupe.lat).split('.')[1] || '').length;
      const canPrec  = (String(merged.lat || '').split('.')[1] || '').length;
      if (dupePrec > canPrec) { merged.lat = dupe.lat; merged.lon = dupe.lon; }
    }
    // Prefer longer description
    if (dupe.description && (dupe.description.length > (merged.description || '').length)) {
      merged.description = dupe.description;
    }
    // Merge services_text tokens (union of unique comma-separated terms)
    if (dupe.services_text) {
      const existing = new Set((merged.services_text || '').split(',').map(s => s.trim()).filter(Boolean));
      dupe.services_text.split(',').map(s => s.trim()).filter(Boolean).forEach(t => existing.add(t));
      merged.services_text = [...existing].join(', ');
    }
    // Prefer non-LocalBusiness category
    if ((!merged.category || merged.category === 'LocalBusiness') && dupe.category && dupe.category !== 'LocalBusiness') {
      merged.category = dupe.category;
    }
    // Bump confidence per merged source (cap at 1.0)
    merged.confidence_score = Math.min(1.0, merged.confidence_score + 0.1);
  }

  // OSM source wins on name and category — most reliable ground truth
  const osmRow = cluster.find(r =>
    r.source_id && (r.source_id.startsWith('osm') || r.source_id === 'overpass')
  );
  if (osmRow) {
    if (osmRow.name) merged.name = osmRow.name;
    if (osmRow.category && osmRow.category !== 'LocalBusiness') {
      merged.category = osmRow.category;
    }
  }

  // Within a transaction:
  // 1. Reassign tasks from dupes to canonical
  // 2. Update canonical with merged data
  // 3. Delete dupes
  const dupeIds = dupes.map(d => d.business_id);

  try {
    // Batch reassign tasks from ALL dupes to canonical in two queries
    const dupePlaceholders = dupeIds.map((_, i) => `$${i + 2}`).join(',');

    // 1. Delete tasks on dupes whose title already exists on canonical (avoid conflict)
    await db.query(
      `DELETE FROM business_tasks
       WHERE business_id IN (${dupePlaceholders})
         AND title IN (
           SELECT title FROM business_tasks WHERE business_id = $1
         )`,
      [canonical.business_id, ...dupeIds]
    );

    // 2. Reassign remaining dupe tasks to canonical (no conflict now)
    await db.query(
      `UPDATE business_tasks SET business_id = $1
       WHERE business_id IN (${dupePlaceholders})`,
      [canonical.business_id, ...dupeIds]
    );

    // Update canonical with merged data
    await db.query(
      `UPDATE businesses SET
         name             = COALESCE($13, name),
         phone            = COALESCE($2,  phone),
         website          = COALESCE($3,  website),
         hours_json       = COALESCE($4,  hours_json),
         description      = $5,
         services_text    = $6,
         category         = $7,
         lat              = $8,
         lon              = $9,
         address          = COALESCE($10, address),
         city             = COALESCE($11, city),
         confidence_score = $12,
         enrichment_updated_at = NOW()
       WHERE business_id = $1`,
      [
        canonical.business_id,
        merged.phone       || null,
        merged.website     || null,
        merged.hours_json  || null,
        merged.description || null,
        merged.services_text || null,
        merged.category    || null,
        merged.lat         || null,
        merged.lon         || null,
        merged.address     || null,
        merged.city        || null,
        merged.confidence_score,
        merged.name        || null,
      ]
    );

    // Delete dupe rows (tasks already reassigned/deleted above)
    if (dupeIds.length) {
      const placeholders = dupeIds.map((_, i) => `$${i + 1}`).join(',');
      await db.query(
        `DELETE FROM businesses WHERE business_id IN (${placeholders})`,
        dupeIds
      );
    }

    return { canonical: canonical.business_id, merged: dupeIds.length };
  } catch (e) {
    console.warn(`[merge] Cluster merge failed (canonical=${canonical.business_id}): ${e.message}`);
    return { canonical: canonical.business_id, merged: 0, error: e.message };
  }
}

// ── Main run ──────────────────────────────────────────────────────────────────
async function runMerge() {
  console.log('[businessMerge] Starting merge run...');
  const t0 = Date.now();

  // Fetch all businesses that have at least one field for clustering
  // (phone, or name+address). Only FL ZIPs to keep it scoped.
  // Scoped to 7 target ZIPs — fast index hit, no full FL scan
  const TARGET_ZIPS = ['32082','32081','32250','32266','32233','32259','32034'];
  const zipPlaceholders = TARGET_ZIPS.map((_, i) => `$${i + 1}`).join(',');
  const rows = await db.query(
    `SELECT business_id, name, phone, address, city, zip,
            website, hours_json, description, services_text,
            category, lat, lon, confidence_score,
            claimed_at, wallet, source_id
     FROM businesses
     WHERE zip IN (${zipPlaceholders})
       AND (phone IS NOT NULL OR address IS NOT NULL)`,
    TARGET_ZIPS
  );

  console.log(`[businessMerge] Loaded ${rows.length} rows for cluster analysis`);

  const clusters = buildClusters(rows);
  console.log(`[businessMerge] Found ${clusters.length} duplicate clusters`);

  let totalMerged = 0, totalDeleted = 0, errors = 0;

  // Process clusters sequentially — each cluster touches business_tasks, parallel
  // execution causes unique constraint races on the canonical's task list
  for (const cluster of clusters) {
    const result = await mergeCluster(cluster);
    if (result.error) {
      errors++;
    } else {
      totalMerged++;
      totalDeleted += result.merged;
    }
  }

  const elapsed = Date.now() - t0;
  console.log(
    `[businessMerge] Done — clusters: ${clusters.length}, ` +
    `merged: ${totalMerged}, rows deleted: ${totalDeleted}, ` +
    `errors: ${errors}, elapsed: ${elapsed}ms`
  );

  // Log to worker_events
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, meta, created_at)
       VALUES ($1, $2, $3, NOW())`,
      ['businessMergeWorker', 'run_complete', JSON.stringify({
        clusters: clusters.length,
        merged: totalMerged,
        deleted: totalDeleted,
        errors,
        elapsed_ms: elapsed,
      })]
    );
  } catch (_) {}

  return { clusters: clusters.length, merged: totalMerged, deleted: totalDeleted };
}

// ── Skip logic ────────────────────────────────────────────────────────────────
async function shouldSkip() {
  if (process.env.FULL_REFRESH === 'true') return false;
  try {
    const rows = await db.query(
      `SELECT created_at FROM worker_events
       WHERE worker_name = 'businessMergeWorker' AND event_type = 'run_complete'
       ORDER BY created_at DESC LIMIT 1`
    );
    if (!rows.length) return false;
    const lastRun = new Date(rows[0].created_at);
    const hoursSince = (Date.now() - lastRun.getTime()) / 3600000;
    return hoursSince < MIN_RUN_GAP_H;
  } catch (_) {
    return false;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────
// External trigger — called by overpassWorker after each pass
async function triggerMerge() {
  if (await shouldSkip()) {
    console.log('[businessMerge] Skipping — ran recently');
    return;
  }
  return runMerge();
}

async function start() {
  // Initial run on start
  await runMerge();

  // Loop every 12h
  setInterval(async () => {
    if (!(await shouldSkip())) await runMerge();
  }, LOOP_SLEEP_H * 60 * 60 * 1000);
}

module.exports = { start, triggerMerge, runMerge };
