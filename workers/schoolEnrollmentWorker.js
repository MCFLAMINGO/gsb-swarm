'use strict';
/**
 * schoolEnrollmentWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches all active FL public schools from Urban Institute Education Data
 * Portal (CCD 2022). Aggregates per zip_mailing then upserts:
 *   school_count, total_enrollment, school_pop_proxy
 * into zip_signals for every FL ZIP that has at least one active school.
 *
 * Worker contract:
 *   START → check heartbeat (skip if <90d) → fetch ALL FL schools → group → upsert → END
 *
 * No API key required. One HTTP call returns ~4144 FL schools.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const https   = require('https');
const db      = require('../lib/db');
const pgStore = require('../lib/pgStore');

const URL = 'https://educationdata.urban.org/api/v1/schools/ccd/directory/2022/?fips=12&school_status=1&limit=5000';
const FRESH_MS = 90 * 24 * 60 * 60 * 1000;

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': 'LocalIntel-DataWorker/1.0 (erik@mcflamingo.com)' },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error('JSON parse failed: ' + e.message)); }
      });
      res.on('error', reject);
    });
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.on('error', reject);
  });
}

async function run() {
  console.log('[schoolEnrollment] Starting schoolEnrollmentWorker — Urban Institute CCD 2022');
  const start = Date.now();

  // Freshness check — 90-day window
  try {
    const hb = await db.query(`SELECT last_run FROM worker_heartbeat WHERE worker_name = 'schoolEnrollmentWorker'`);
    if (Array.isArray(hb) && hb[0]?.last_run) {
      const age = Date.now() - new Date(hb[0].last_run).getTime();
      const days = age / 86400000;
      if (age < FRESH_MS) {
        console.log(`[schoolEnrollment] Data fresh (${days.toFixed(1)} days old, window 90d) — skipping run`);
        return;
      }
    }
  } catch (_) { /* no heartbeat yet — run */ }

  // FL ZIP set from fl_zip_geo
  let flZipSet;
  try {
    const rows = await db.query(`SELECT zip FROM fl_zip_geo`);
    if (!Array.isArray(rows) || rows.length === 0) {
      console.warn('[schoolEnrollment] fl_zip_geo is empty — skipping run');
      return;
    }
    flZipSet = new Set(rows.map(r => String(r.zip).trim()).filter(Boolean));
    console.log(`[schoolEnrollment] Loaded ${flZipSet.size} FL ZIPs from fl_zip_geo`);
  } catch (e) {
    console.error('[schoolEnrollment] Failed to load fl_zip_geo:', e.message);
    return;
  }

  // Fetch all FL schools
  let payload;
  try {
    payload = await fetchJson(URL);
  } catch (e) {
    console.error('[schoolEnrollment] Urban Institute fetch failed:', e.message);
    return;
  }

  const results = Array.isArray(payload?.results) ? payload.results : [];
  console.log(`[schoolEnrollment] API returned ${results.length} schools (count=${payload?.count})`);
  if (results.length === 0) {
    console.warn('[schoolEnrollment] No schools in API response — aborting upsert');
    return;
  }

  // Group by zip_mailing, filter to FL ZIPs with non-null/non-zero enrollment
  const byZip = new Map();
  let skipped = 0;
  for (const s of results) {
    const enrollment = s?.enrollment;
    if (enrollment == null || enrollment === 0) { skipped++; continue; }
    const zipRaw = s?.zip_mailing;
    if (!zipRaw) { skipped++; continue; }
    const zip = String(zipRaw).trim().slice(0, 5).padStart(5, '0');
    if (!flZipSet.has(zip)) { skipped++; continue; }

    if (!byZip.has(zip)) byZip.set(zip, { school_count: 0, total_enrollment: 0 });
    const agg = byZip.get(zip);
    agg.school_count += 1;
    agg.total_enrollment += Number(enrollment) || 0;
  }
  console.log(`[schoolEnrollment] Aggregated ${byZip.size} FL ZIPs (skipped ${skipped} schools)`);

  // Upsert
  let done = 0;
  for (const [zip, agg] of byZip) {
    const schoolPopProxy = Math.round(agg.total_enrollment / 0.18);
    try {
      await pgStore.upsertZipSignals(zip, {
        school_count:       agg.school_count,
        total_enrollment:   agg.total_enrollment,
        school_pop_proxy:   schoolPopProxy,
      });
      done++;
      if (done % 100 === 0) {
        console.log(`[schoolEnrollment] Upserted ${done}/${byZip.size} ZIPs`);
      }
    } catch (e) {
      console.error(`[schoolEnrollment] upsert failed for ${zip}:`, e.message);
    }
  }

  // Heartbeat
  await db.query(
    `INSERT INTO worker_heartbeat (worker_name, last_run) VALUES ('schoolEnrollmentWorker', NOW())
     ON CONFLICT (worker_name) DO UPDATE SET last_run = NOW()`
  ).catch(() => {});

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`[schoolEnrollment] ✅ Done — ${done} ZIP upserts — ${elapsed}s`);
  return;
}

run().catch(e => { console.error('[schoolEnrollment] fatal:', e.message); });
