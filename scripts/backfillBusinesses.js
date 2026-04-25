#!/usr/bin/env node
'use strict';
/**
 * backfillBusinesses.js
 *
 * Fast, idempotent bulk backfill of all flat-file businesses into Postgres.
 * Uses batch INSERT ... ON CONFLICT DO NOTHING (500 rows/batch) rather than
 * per-row fuzzy upsert — designed to handle 100k+ records in minutes.
 *
 * Skips ZIPs where PG count already matches flat-file count.
 * Safe to re-run at any time — duplicates are silently ignored.
 *
 * Sources:
 *   1. data/zips/*.json       — primary ZIP flat files
 *   2. data/localIntel.json   — global flat file
 *   3. data/gap_fill_*.json   — standalone gap-fill source files
 *
 * Wired into index.js boot — runs async in background before workers launch.
 */

if (!process.env.LOCAL_INTEL_DB_URL) {
  console.log('[backfill] LOCAL_INTEL_DB_URL not set — skipping');
  module.exports = {};
  return;
}

const { Pool } = require('pg');
const fs   = require('fs');
const path = require('path');
const { computeConfidence } = require('../lib/computeConfidence');

const pool = new Pool({
  connectionString: process.env.LOCAL_INTEL_DB_URL,
  max: 5,
  idleTimeoutMillis: 30000,
});

const DATA_DIR = path.join(__dirname, '..', 'data');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');
const BATCH    = 500;

const PG_GROUP_MAP = {
  restaurant:'food', fast_food:'food', cafe:'food', bar:'food', pub:'food',
  doctor:'health', dentist:'health', clinic:'health', hospital:'health', pharmacy:'health',
  chiropractor:'health', physical_therapy:'health', optometrist:'health',
  bank:'finance', insurance:'finance', finance:'finance', accounting:'finance', mortgage:'finance',
  legal:'legal', attorney:'legal',
  retail:'retail', boutique:'retail', salon:'retail', spa:'retail', gym:'retail', fitness:'retail',
  school:'civic', church:'civic', government:'civic', library:'civic',
};
function pgGroup(cat) {
  if (!cat) return 'services';
  return PG_GROUP_MAP[cat.toLowerCase().replace(/[^a-z_]/g, '_')] || 'services';
}

function toRow(b, defaultZip) {
  const zip = (b.zip || defaultZip || '').toString().trim();
  const confidence_score = computeConfidence(b) / 100;
  return {
    name:             (b.name || '').trim().slice(0, 255),
    zip,
    address:          (b.address   || null),
    city:             (b.city      || null),
    phone:            (b.phone     || null),
    website:          (b.website   || null),
    hours:            (b.hours     || null),
    category:         (b.category  || null),
    category_group:   b.group || pgGroup(b.category),
    status:           b.status    || 'active',
    lat:              b.lat       || null,
    lon:              b.lon       || null,
    confidence_score,
    sources:          Array.isArray(b.sources) ? b.sources : (b.source ? [b.source] : ['flat_backfill']),
    primary_source:   b.source || b.primary_source || 'flat_backfill',
  };
}

/**
 * Insert a batch of rows using a single multi-value INSERT.
 * ON CONFLICT (lower(name), zip) WHERE sunbiz_doc_number IS NULL → DO NOTHING
 * This is the fast path — no fuzzy scan per row.
 */
async function insertBatch(rows) {
  if (!rows.length) return 0;

  const valid = rows.filter(r => r.name && r.zip);
  if (!valid.length) return 0;

  // Build parameterized multi-row INSERT
  const cols = [
    'name','zip','address','city','phone','website','hours',
    'category','category_group','status','lat','lon',
    'confidence_score','sources','primary_source','last_confirmed',
  ];
  const values = [];
  const params = [];
  let pi = 1;

  for (const r of valid) {
    values.push(`($${pi},$${pi+1},$${pi+2},$${pi+3},$${pi+4},$${pi+5},$${pi+6},$${pi+7},$${pi+8},$${pi+9},$${pi+10},$${pi+11},$${pi+12},$${pi+13},$${pi+14},NOW())`);
    params.push(
      r.name, r.zip, r.address, r.city, r.phone, r.website, r.hours,
      r.category, r.category_group, r.status,
      r.lat !== null ? parseFloat(r.lat) : null,
      r.lon !== null ? parseFloat(r.lon) : null,
      r.confidence_score,
      r.sources,
      r.primary_source,
    );
    pi += 15;
  }

  const sql = `
    INSERT INTO businesses (${cols.join(',')})
    VALUES ${values.join(',')}
    ON CONFLICT (lower(name), zip) WHERE sunbiz_doc_number IS NULL
    DO UPDATE SET
      confidence_score = GREATEST(businesses.confidence_score, EXCLUDED.confidence_score),
      phone    = COALESCE(NULLIF(EXCLUDED.phone,''),    businesses.phone),
      website  = COALESCE(NULLIF(EXCLUDED.website,''),  businesses.website),
      hours    = COALESCE(NULLIF(EXCLUDED.hours,''),    businesses.hours),
      address  = COALESCE(NULLIF(EXCLUDED.address,''),  businesses.address),
      updated_at = NOW()
  `;

  try {
    const res = await pool.query(sql, params);
    return res.rowCount || valid.length;
  } catch (e) {
    // On batch error, fall back to one-by-one to isolate bad records
    let written = 0;
    for (const r of valid) {
      try {
        const s = `
          INSERT INTO businesses (${cols.join(',')})
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
          ON CONFLICT (lower(name), zip) WHERE sunbiz_doc_number IS NULL
          DO UPDATE SET
            confidence_score = GREATEST(businesses.confidence_score, EXCLUDED.confidence_score),
            phone    = COALESCE(NULLIF(EXCLUDED.phone,''),    businesses.phone),
            website  = COALESCE(NULLIF(EXCLUDED.website,''),  businesses.website),
            hours    = COALESCE(NULLIF(EXCLUDED.hours,''),    businesses.hours),
            address  = COALESCE(NULLIF(EXCLUDED.address,''),  businesses.address),
            updated_at = NOW()
        `;
        await pool.query(s, [
          r.name, r.zip, r.address, r.city, r.phone, r.website, r.hours,
          r.category, r.category_group, r.status,
          r.lat !== null ? parseFloat(r.lat) : null,
          r.lon !== null ? parseFloat(r.lon) : null,
          r.confidence_score,
          r.sources,
          r.primary_source,
        ]);
        written++;
      } catch (_) {}
    }
    return written;
  }
}

async function getZipCountsPG(zips) {
  if (!zips.length) return {};
  const rows = await pool.query(
    'SELECT zip, COUNT(*) FROM businesses WHERE zip = ANY($1) GROUP BY zip',
    [zips]
  );
  const map = {};
  for (const r of rows.rows) map[r.zip] = parseInt(r.count, 10);
  return map;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function processRecords(records, label) {
  let written = 0;
  for (let i = 0; i < records.length; i += BATCH) {
    const batch = records.slice(i, i + BATCH);
    written += await insertBatch(batch);
    if (i > 0 && i % 5000 === 0) await sleep(20);
  }
  console.log(`[backfill] ${label}: +${written} upserted`);
  return written;
}

(async () => {
  const t0 = Date.now();
  let total = 0;

  // ── 1. data/zips/*.json ────────────────────────────────────────────────────
  if (fs.existsSync(ZIPS_DIR)) {
    const files = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json'));

    // Load all flat files, check PG counts, only process ZIPs not in sync
    const flatMap = {};
    for (const f of files) {
      const zip = f.replace('.json', '');
      try {
        const data = JSON.parse(fs.readFileSync(path.join(ZIPS_DIR, f), 'utf8'));
        const bizs = Array.isArray(data) ? data : (data.businesses || []);
        if (bizs.length) flatMap[zip] = bizs;
      } catch (_) {}
    }

    const pgCounts = await getZipCountsPG(Object.keys(flatMap));
    let skipped = 0;

    for (const [zip, bizs] of Object.entries(flatMap)) {
      const pgCount   = pgCounts[zip] || 0;
      if (pgCount >= bizs.length) { skipped += bizs.length; continue; }

      const records = bizs.map(b => toRow(b, zip));
      const w = await processRecords(records, `zip ${zip} (${bizs.length - pgCount} new)`);
      total += w;
    }

    console.log(`[backfill] ZIP files done | total: +${total} | skipped (synced): ${skipped}`);
  }

  // ── 2. data/localIntel.json ────────────────────────────────────────────────
  const liPath = path.join(DATA_DIR, 'localIntel.json');
  if (fs.existsSync(liPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(liPath, 'utf8'));
      const bizs = Array.isArray(data) ? data : (data.businesses || []);
      if (bizs.length) {
        const records = bizs.map(b => toRow(b, b.zip || ''));
        total += await processRecords(records, 'localIntel.json');
      }
    } catch (e) { console.warn('[backfill] localIntel.json:', e.message); }
  }

  // ── 3. data/gap_fill_*.json ────────────────────────────────────────────────
  const gapFiles = fs.readdirSync(DATA_DIR)
    .filter(f => f.startsWith('gap_fill_') && f.endsWith('.json'));
  for (const f of gapFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8'));
      if (!Array.isArray(data) || !data.length) continue;
      const records = data.map(b => toRow(b, b.zip || ''));
      total += await processRecords(records, f);
    } catch (e) { console.warn(`[backfill] ${f}:`, e.message); }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[backfill] COMPLETE — ${total} total upserted in ${elapsed}s`);
  await pool.end();
})().catch(e => {
  console.error('[backfill] Fatal:', e.message);
  pool.end().catch(() => {});
});
