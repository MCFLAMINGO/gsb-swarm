'use strict';
/**
 * workers/sunbizWorker.js
 * Railway-ready Sunbiz import worker — 3-trip streaming, no disk writes.
 *
 * Flow per trip:
 *   SFTP read stream → strip ZIP local file header → zlib.createInflateRaw()
 *   → readline → parseRecord() → upsertBatch() → Postgres
 *
 * Each Railway boot processes LINES_PER_TRIP lines starting from the
 * `lines_imported` checkpoint, then exits cleanly. ~3 boots covers the full
 * cordata.zip (~5-6M records). No /tmp, no disk, no unzip CLI.
 */

require('dotenv').config();
const zlib       = require('zlib');
const readline   = require('readline');
const SftpClient = require('ssh2-sftp-client');
const db         = require('../lib/db');
const hb         = require('../lib/workerHeartbeat');

const SFTP_HOST   = 'sftp.floridados.gov';
const SFTP_USER   = 'Public';
const SFTP_PASS   = 'PubAccess1845!';
const REMOTE_PATH = 'doc/quarterly/cor/cordata.zip';

const BATCH_SIZE      = 500;
const LINES_PER_TRIP  = 2_000_000;

// ── worker_events logger ──────────────────────────────────────────────────────
async function logWorkerEvent({ eventType, recordsIn, recordsOut, durationMs, error }) {
  try {
    await db.query(
      `INSERT INTO worker_events (worker_name, event_type, records_in, records_out, duration_ms, error_message, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
      ['fl_sunbiz', eventType, recordsIn || 0, recordsOut || 0, durationMs || 0, error || null]
    );
  } catch (e) { console.warn('[sunbizWorker] worker_events log failed:', e.message); }
}

// ── State table ───────────────────────────────────────────────────────────────
async function ensureStateTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS sunbiz_import_state (
      key   TEXT PRIMARY KEY,
      value TEXT
    )
  `);
}

async function getState(key) {
  const row = await db.queryOne(`SELECT value FROM sunbiz_import_state WHERE key = $1`, [key]);
  return row ? row.value : null;
}

async function setState(key, value) {
  await db.query(
    `INSERT INTO sunbiz_import_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, String(value)]
  );
}

// ── Parse record ──────────────────────────────────────────────────────────────
function parseRecord(line) {
  const fields = line.split('|');
  if (fields.length < 5) return null;
  const [docNumber, corpName, status, filedDate, stateOfFormation, feiEin] = fields;
  if (!docNumber || !corpName) return null;
  const name = corpName.trim();
  if (!name) return null;

  return {
    sunbiz_doc_number:   docNumber.trim(),
    name,
    sunbiz_status:       status?.trim() || 'UNKNOWN',
    sunbiz_entity_type:  stateOfFormation?.trim() === 'FL' ? 'FL_CORP' : 'FOREIGN',
    fei_ein:             feiEin?.trim() || null,
    registered_date:     parseDate(filedDate?.trim()),
    status:              (status?.trim() === 'ACTIVE') ? 'active' : 'inactive',
    category:            'business',
    category_group:      'general',
    confidence_score:    0.5,
    source_id:           'sunbiz',
    source_weight:       0.9,
  };
}

function parseDate(raw) {
  if (!raw || raw.length < 8) return null;
  try {
    const y = raw.slice(0,4), m = raw.slice(4,6), d = raw.slice(6,8);
    const dt = new Date(`${y}-${m}-${d}`);
    return isNaN(dt.getTime()) ? null : dt.toISOString().split('T')[0];
  } catch { return null; }
}

// ── Aggregate sunbiz_new_12mo into zip_signals ────────────────────────────────
async function aggregateSunbizSignals() {
  console.log('[sunbizWorker] Aggregating sunbiz_new_12mo into zip_signals...');
  try {
    await db.query(`
      INSERT INTO zip_signals (zip, sunbiz_new_12mo, last_updated_at)
      SELECT
        zip,
        COUNT(*)::int AS sunbiz_new_12mo,
        NOW()
      FROM businesses
      WHERE primary_source = 'sunbiz'
        AND registered_date >= NOW() - INTERVAL '12 months'
        AND zip IS NOT NULL
        AND zip != '00000'
        AND zip ~ '^[0-9]{5}$'
      GROUP BY zip
      ON CONFLICT (zip) DO UPDATE SET
        sunbiz_new_12mo = EXCLUDED.sunbiz_new_12mo,
        last_updated_at = NOW()
    `);
    console.log('[sunbizWorker] sunbiz_new_12mo aggregation complete');
  } catch (e) {
    console.error('[sunbizWorker] sunbiz_new_12mo aggregation failed:', e.message);
  }
}

// ── Upsert ────────────────────────────────────────────────────────────────────
async function upsertBatch(records) {
  if (!records.length) return;

  const valueClauses = records.map((r, i) => {
    const b = i * 9;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},ARRAY['sunbiz'],'sunbiz',NOW(),'00000')`;
  }).join(',');

  const params = records.flatMap(r => [
    r.sunbiz_doc_number,
    r.name,
    r.status,
    r.sunbiz_status,
    r.sunbiz_entity_type,
    r.registered_date,
    r.confidence_score,
    r.category,
    r.category_group,
  ]);

  await db.query(`
    INSERT INTO businesses
      (sunbiz_doc_number, name, status, sunbiz_status, sunbiz_entity_type,
       registered_date, confidence_score, category, category_group,
       sources, primary_source, last_confirmed, zip)
    VALUES ${valueClauses}
    ON CONFLICT (sunbiz_doc_number) DO UPDATE SET
      sunbiz_status      = EXCLUDED.sunbiz_status,
      sunbiz_entity_type = EXCLUDED.sunbiz_entity_type,
      registered_date    = COALESCE(EXCLUDED.registered_date, businesses.registered_date),
      last_confirmed     = NOW(),
      updated_at         = NOW()
  `, params);
}

// ── Stream SFTP → inflate → readline (no disk) ────────────────────────────────
// Strips the ZIP local file header from the head of the stream so the remaining
// bytes are raw DEFLATE, then pipes through zlib.createInflateRaw() to recover
// the plain-text cordata.txt stream. onLine is called for every line.
// Throw a TripComplete error from onLine to abort the stream early without crashing.
class TripComplete extends Error {}

async function streamSftpToReadline(onLine) {
  const sftp = new SftpClient();
  await sftp.connect({ host: SFTP_HOST, port: 22, username: SFTP_USER, password: SFTP_PASS, readyTimeout: 30000 });

  try {
    const remoteSize = (await sftp.stat(REMOTE_PATH)).size;
    console.log(`[sunbizWorker] Remote: ${(remoteSize/1024/1024).toFixed(1)} MB`);

    const lastRemoteSize = await getState('remote_size');
    if (lastRemoteSize && parseInt(lastRemoteSize) !== remoteSize) {
      console.log('[sunbizWorker] New quarterly file detected — resetting checkpoint');
      await setState('lines_imported', '0');
      await setState('import_complete', 'false');
    }
    await setState('remote_size', String(remoteSize));

    const remoteStream = await sftp.createReadStream(REMOTE_PATH);

    await new Promise((resolve, reject) => {
      const inflate = zlib.createInflateRaw();
      const rl = readline.createInterface({ input: inflate, crlfDelay: Infinity });

      let headerSkipped = false;
      let headerBuf = Buffer.alloc(0);
      let aborted = false;

      const cleanup = () => {
        try { remoteStream.unpipe?.(); } catch(_) {}
        try { remoteStream.destroy(); } catch(_) {}
        try { inflate.destroy(); } catch(_) {}
        try { rl.close(); } catch(_) {}
      };

      remoteStream.on('data', chunk => {
        if (aborted) return;
        if (!headerSkipped) {
          headerBuf = Buffer.concat([headerBuf, chunk]);
          if (headerBuf.length >= 30) {
            const sig = headerBuf.readUInt32LE(0);
            if (sig !== 0x04034b50) {
              aborted = true;
              cleanup();
              reject(new Error('Not a ZIP file (bad local-file-header signature)'));
              return;
            }
            const fnLen    = headerBuf.readUInt16LE(26);
            const extraLen = headerBuf.readUInt16LE(28);
            const dataStart = 30 + fnLen + extraLen;
            if (headerBuf.length >= dataStart) {
              headerSkipped = true;
              const tail = headerBuf.slice(dataStart);
              headerBuf = null;
              if (tail.length) inflate.write(tail);
            }
          }
        } else {
          inflate.write(chunk);
        }
      });

      remoteStream.on('end', () => { try { inflate.end(); } catch(_) {} });
      remoteStream.on('error', e => { if (!aborted) { aborted = true; cleanup(); reject(e); } });
      inflate.on('error', e => {
        if (aborted) return;
        // Inflate may error after we intentionally destroy the stream on TripComplete — swallow it
        aborted = true; cleanup(); reject(e);
      });

      rl.on('line', line => {
        if (aborted) return;
        try {
          onLine(line);
        } catch (e) {
          if (e instanceof TripComplete) {
            aborted = true;
            cleanup();
            resolve();
            return;
          }
          aborted = true;
          cleanup();
          reject(e);
        }
      });
      rl.on('close', () => { if (!aborted) resolve(); });
      rl.on('error', e => { if (!aborted) { aborted = true; cleanup(); reject(e); } });
    });
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

// ── Single trip: process LINES_PER_TRIP lines, checkpoint, exit ───────────────
async function runTrip() {
  const resumeLine = parseInt(await getState('lines_imported') || '0');
  const ceiling    = resumeLine + LINES_PER_TRIP;
  console.log(`[sunbizWorker] Trip: lines ${resumeLine.toLocaleString()} → ${ceiling.toLocaleString()}`);

  // Collect lines for this trip into memory, then process after the stream closes.
  // readline.onLine must be synchronous, but upsertBatch is async — collecting
  // first is the simplest correct pattern. 2M lines ≈ ~200 MB RAM, acceptable.
  const tripLines = [];
  let lineNum = 0;
  let reachedCeiling = false;

  try {
    await streamSftpToReadline((line) => {
      lineNum++;
      if (lineNum <= resumeLine) return;            // fast-skip previously imported
      if (lineNum > ceiling) {
        reachedCeiling = true;
        throw new TripComplete();
      }
      if (!line) return;
      tripLines.push(line);
    });
  } catch (e) {
    if (!(e instanceof TripComplete)) throw e;
  }

  console.log(`[sunbizWorker] Stream done. Total lines seen: ${lineNum.toLocaleString()}, lines in trip: ${tripLines.length.toLocaleString()}, reachedCeiling=${reachedCeiling}`);

  // Process tripLines in batches
  let imported = resumeLine;
  let skipped  = 0;
  let batch    = [];

  for (let i = 0; i < tripLines.length; i++) {
    const line = tripLines[i];
    if (!line.trim()) continue;
    const record = parseRecord(line);
    if (!record) {
      skipped++;
      if (skipped <= 3) console.warn(`[sunbizWorker] parseRecord rejected (first 120 chars): ${JSON.stringify(line.slice(0,120))}`);
      continue;
    }
    batch.push(record);
    if (batch.length >= BATCH_SIZE) {
      const flush = batch;
      batch = [];
      await upsertBatch(flush);
      imported += flush.length;
      await setState('lines_imported', String(imported));
      if (imported % 10000 < BATCH_SIZE) {
        console.log(`[sunbizWorker] ${imported.toLocaleString()} records → Postgres`);
      }
    }
  }

  if (batch.length) {
    await upsertBatch(batch);
    imported += batch.length;
    await setState('lines_imported', String(imported));
  }

  // Checkpoint reflects lineNum advance, not just records imported.
  // resumeLine + tripLines.length = total lines seen during the productive window.
  const newCheckpoint = resumeLine + tripLines.length;
  await setState('lines_imported', String(newCheckpoint));

  // Aggregate sunbiz_new_12mo into zip_signals after every trip (incremental)
  await aggregateSunbizSignals();

  if (!reachedCeiling) {
    // Stream ended naturally — full file consumed
    await setState('import_complete', 'true');
    console.log(`[sunbizWorker] Import complete: ${imported.toLocaleString()} records imported, ${skipped} skipped (cumulative)`);
  } else {
    console.log(`[sunbizWorker] Trip complete: checkpoint=${newCheckpoint.toLocaleString()} (${(imported - resumeLine).toLocaleString()} new records this trip, ${skipped} skipped), will resume next boot`);
  }

  return { imported, skipped, reachedCeiling };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function runImport() {
  const _importStart = Date.now();
  try {
    const complete = await getState('import_complete');
    if (complete === 'true') {
      console.log('[sunbizWorker] Import already complete — idling');
      return;
    }
    const { imported, skipped } = await runTrip();
    await logWorkerEvent({
      eventType: 'complete',
      recordsIn: imported + skipped,
      recordsOut: imported,
      durationMs: Date.now() - _importStart,
    });
    await hb.ping('sunbizWorker');
  } catch (e) {
    console.error('[sunbizWorker] Import error:', e.message);
    await logWorkerEvent({ eventType: 'error', durationMs: Date.now() - _importStart, error: e.message });
    throw e;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.error('[sunbizWorker] LOCAL_INTEL_DB_URL not set — exiting');
    return;
  }

  await ensureStateTable();

  const complete = await getState('import_complete');
  if (complete === 'true') {
    console.log('[sunbizWorker] Import already complete, idling.');
    return;
  }

  await logWorkerEvent({ eventType: 'start' });
  await runImport();
  await logWorkerEvent({ eventType: 'end' });
}

if (require.main === module) {
  run().catch(e => console.error('[sunbizWorker] Fatal:', e.message));
}

module.exports = { runImport };
