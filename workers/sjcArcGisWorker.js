/*
 * sjcArcGisWorker.js — St. Johns County ArcGIS enrichment
 *
 * DATA SOURCES (services1.arcgis.com/t2yugAJW83eUIFui):
 *   - WATS_Project_Point: active development permit applications
 *   - PUD_Development_Activity: planned unit developments
 *
 * SCOPE: St. Johns County only (SJC-specific ArcGIS portal)
 *
 * TODO — countyArcGisWorker (future B-series):
 *   Replace this worker with a registry-driven countyArcGisWorker.js
 *   that loops all FL counties with ArcGIS portals. Registry pattern:
 *
 *   const COUNTY_ARCGIS_REGISTRY = [
 *     { county: 'St. Johns', fips: '109', permitUrl: 'https://services1.arcgis.com/t2yugAJW83eUIFui/...WATS...', pudUrl: '...' },
 *     { county: 'Duval',     fips: '031', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Orange',    fips: '095', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Hillsborough', fips: '057', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Pinellas',  fips: '103', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Broward',   fips: '011', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Miami-Dade',fips: '025', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Sarasota',  fips: '115', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Volusia',   fips: '127', permitUrl: 'https://...', pudUrl: '...' },
 *     { county: 'Flagler',   fips: '035', permitUrl: 'https://...', pudUrl: '...' },
 *   ];
 *   // Each county entry: fetch permit points + PUD points, count by ZIP, upsert zip_signals
 *   // Columns: arcgis_permit_count INT, arcgis_pud_count INT (migration needed)
 */
'use strict';

const https  = require('https');
const db     = require('../lib/db');

const ARCGIS_BASE = 'https://services1.arcgis.com/t2yugAJW83eUIFui/arcgis/rest/services';
const WATS_URL    = `${ARCGIS_BASE}/WATS_Project_Point/FeatureServer/0/query?f=json&where=1=1&outFields=*&resultRecordCount=1000`;
const PUD_URL     = `${ARCGIS_BASE}/PUD_Development_Activity/FeatureServer/0/query?f=json&where=1=1&outFields=*&resultRecordCount=1000`;
const LOOP_H      = 24;

// Possible ZIP attribute names across SJC ArcGIS layers — try in order.
const ZIP_FIELDS = ['ZIP', 'ZIPCODE', 'ZIP_CODE', 'PostalCode', 'POSTAL_CODE', 'Zip', 'zip'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function logWorkerEvent({ eventType, recordsIn, recordsOut, durationMs, error }) {
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['sjc_arcgis', eventType, recordsIn || 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (e) { console.warn('[sjcArcGis] worker_events log failed:', e.message); }
}

function fetchGIS(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'LocalIntel-SJC/1.0' } }, res => {
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let b = '';
      res.setEncoding('utf8');
      res.on('data', c => { b += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(b)); }
        catch (e) { reject(new Error('JSON parse failed')); }
      });
      res.on('error', reject);
    });
    req.setTimeout(30000, () => { req.destroy(new Error('Timeout')); });
    req.on('error', reject);
  });
}

function extractZip(attrs) {
  if (!attrs) return null;
  for (const f of ZIP_FIELDS) {
    const v = attrs[f];
    if (v == null) continue;
    const s = String(v).trim();
    const m = s.match(/^(\d{5})/);
    if (m) return m[1];
  }
  return null;
}

function countByZip(features) {
  const counts = {};
  for (const f of (features || [])) {
    const zip = extractZip(f.attributes);
    if (!zip) continue;
    counts[zip] = (counts[zip] || 0) + 1;
  }
  return counts;
}

async function fetchWatsPermits() {
  console.log('[sjcArcGis] Fetching WATS_Project_Point...');
  const data = await fetchGIS(WATS_URL);
  const features = data.features || [];
  console.log(`[sjcArcGis] WATS features: ${features.length}`);
  return countByZip(features);
}

async function fetchPudDevelopments() {
  console.log('[sjcArcGis] Fetching PUD_Development_Activity...');
  const data = await fetchGIS(PUD_URL);
  const features = data.features || [];
  console.log(`[sjcArcGis] PUD features: ${features.length}`);
  return countByZip(features);
}

async function upsertZipSignals(watsCounts, pudCounts) {
  const zips = new Set([...Object.keys(watsCounts), ...Object.keys(pudCounts)]);
  let upserted = 0;
  for (const zip of zips) {
    const wats = watsCounts[zip] || 0;
    const pud  = pudCounts[zip]  || 0;
    await db.query(
      `INSERT INTO zip_signals (zip, sjc_wats_permit_count, sjc_pud_count, sjc_arcgis_updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (zip) DO UPDATE SET
         sjc_wats_permit_count = EXCLUDED.sjc_wats_permit_count,
         sjc_pud_count         = EXCLUDED.sjc_pud_count,
         sjc_arcgis_updated_at = NOW()`,
      [zip, wats, pud]
    );
    upserted++;
  }
  return upserted;
}

async function runPass() {
  const t0 = Date.now();
  await logWorkerEvent({ eventType: 'start' });

  const watsCounts = await fetchWatsPermits();
  await sleep(1000);
  const pudCounts  = await fetchPudDevelopments();

  const upserted = await upsertZipSignals(watsCounts, pudCounts);
  const durationMs = Date.now() - t0;

  const summary = {};
  for (const zip of new Set([...Object.keys(watsCounts), ...Object.keys(pudCounts)])) {
    summary[zip] = { wats: watsCounts[zip] || 0, pud: pudCounts[zip] || 0 };
  }
  console.log('[sjcArcGis] ZIP summary:', JSON.stringify(summary));

  await logWorkerEvent({ eventType: 'complete', recordsOut: upserted, durationMs });
  console.log(`[sjcArcGis] Pass complete — ${upserted} ZIPs upserted in ${durationMs}ms`);
}

(async function main() {
  console.log('[sjcArcGis] Worker started');
  while (true) {
    try { await runPass(); }
    catch (err) {
      console.error('[sjcArcGis] Pass crashed:', err.message);
      await logWorkerEvent({ eventType: 'error', error: err.message });
    }
    console.log(`[sjcArcGis] Sleeping ${LOOP_H}h`);
    await sleep(LOOP_H * 60 * 60 * 1000);
  }
})();

module.exports = { runPass };
