'use strict';
/**
 * workers/sunbizWorker.js
 * Florida DOS SunBiz quarterly corporate import — 10-file split architecture (B101).
 *
 * The quarterly cordata is published as 10 files at
 *   doc/quarterly/cor/cordata{0..9}.zip
 * each containing records whose document number ends in the matching digit.
 * Each file is ~175 MB compressed (DEFLATE64 / ZIP method 21 — needs 7z binary).
 *
 * Flow per Railway boot:
 *   - Read sunbiz_import_state (files_completed JSON array, import_complete bool)
 *   - For each digit N in 0..9 not yet in files_completed:
 *       SFTP fastGet cordata{N}.zip (3 attempts, 30/60/120s backoff on ECONNRESET)
 *       7z extract to /tmp/sunbiz{N}/
 *       Stream-parse the fixed-width .txt, upsert active FL records into businesses
 *       Append N to files_completed checkpoint
 *       Delete /tmp/cordata{N}.zip and /tmp/sunbiz{N}/
 *   - After all 10 done: aggregateSunbizSignals() + set import_complete=true
 */

require('dotenv').config();
const fs         = require('fs');
const path       = require('path');
const readline   = require('readline');
const { spawn }  = require('child_process');
const SftpClient = require('ssh2-sftp-client');
const db         = require('../lib/db');
const hb         = require('../lib/workerHeartbeat');

const SFTP_HOST   = 'sftp.floridados.gov';
const SFTP_PORT   = 22;
const SFTP_USER   = 'Public';
const SFTP_PASS   = 'PubAccess1845!';
const REMOTE_DIR  = 'doc/quarterly/cor';

const BATCH_SIZE  = 500;
const SFTP_ATTEMPTS = 3;
const BACKOFF_MS  = [30_000, 60_000, 120_000];

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

// ── State table (KV) ──────────────────────────────────────────────────────────
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

async function getFilesCompleted() {
  const raw = await getState('files_completed');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(Number).filter(n => n >= 0 && n <= 9) : [];
  } catch { return []; }
}

async function setFilesCompleted(arr) {
  await setState('files_completed', JSON.stringify(arr));
}

// ── Fixed-width record parsing ────────────────────────────────────────────────
// SunBiz cordata fixed-width layout (per FL DOS spec):
//   doc_number   cols 1-12   (offset 0,   len 12)
//   corp_name    cols 13-172 (offset 12,  len 160)
//   status       cols 173-182 (offset 172, len 10)
//   filing_date  cols 183-191 (offset 182, len 9, MMDDYYYY-ish — try multiple)
//   state        cols 192-193 (offset 191, len 2)
//   zip          cols 224-233 (offset 223, len 10)
// Column numbers in the spec are 1-based; offsets here are 0-based.
function slice(s, off, len) {
  return s.length > off ? s.substr(off, len).trim() : '';
}

function parseFilingDate(raw) {
  if (!raw) return null;
  const clean = raw.replace(/[^0-9]/g, '');
  if (clean.length < 8) return null;
  // Try YYYYMMDD first, then MMDDYYYY
  let y, m, d;
  if (clean.length === 8) {
    // YYYYMMDD or MMDDYYYY — disambiguate by leading digits
    const first4 = clean.slice(0, 4);
    if (first4 >= '1800' && first4 <= '2099') {
      y = clean.slice(0, 4); m = clean.slice(4, 6); d = clean.slice(6, 8);
    } else {
      m = clean.slice(0, 2); d = clean.slice(2, 4); y = clean.slice(4, 8);
    }
  } else {
    return null;
  }
  const dt = new Date(`${y}-${m}-${d}T00:00:00Z`);
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString().split('T')[0];
}

function parseZip(raw) {
  if (!raw) return null;
  const m = raw.match(/(\d{5})/);
  return m ? m[1] : null;
}

function parseRecord(line) {
  if (!line || line.length < 20) return null;
  const docNumber  = slice(line, 0, 12);
  const corpName   = slice(line, 12, 160);
  const status     = slice(line, 172, 10);
  const filingDate = slice(line, 182, 9);
  const state      = slice(line, 191, 2);
  const zip        = parseZip(slice(line, 223, 10));

  if (!docNumber || !corpName) return null;
  // Active FL only
  if (!status.toUpperCase().includes('ACT')) return null;
  if (state.toUpperCase() !== 'FL') return null;

  return {
    sunbiz_doc_number: docNumber,
    name: corpName,
    sunbiz_status: status,
    sunbiz_entity_type: 'FL_CORP',
    registered_date: parseFilingDate(filingDate),
    status: 'active',
    category: 'business',
    category_group: 'general',
    confidence_score: 0.5,
    zip: zip || '00000',
  };
}

// ── Upsert ────────────────────────────────────────────────────────────────────
async function upsertBatch(records) {
  if (!records.length) return;

  const valueClauses = records.map((r, i) => {
    const b = i * 10;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},ARRAY['sunbiz'],'sunbiz',NOW())`;
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
    r.zip,
  ]);

  await db.query(`
    INSERT INTO businesses
      (sunbiz_doc_number, name, status, sunbiz_status, sunbiz_entity_type,
       registered_date, confidence_score, category, category_group, zip,
       sources, primary_source, last_confirmed)
    VALUES ${valueClauses}
    ON CONFLICT (sunbiz_doc_number) DO UPDATE SET
      sunbiz_status      = EXCLUDED.sunbiz_status,
      sunbiz_entity_type = EXCLUDED.sunbiz_entity_type,
      registered_date    = COALESCE(EXCLUDED.registered_date, businesses.registered_date),
      zip                = COALESCE(NULLIF(EXCLUDED.zip, '00000'), businesses.zip),
      last_confirmed     = NOW(),
      updated_at         = NOW()
  `, params);
}

// ── Aggregate sunbiz_new_12mo into zip_signals ────────────────────────────────
async function aggregateSunbizSignals() {
  console.log('[sunbizWorker] Aggregating all 4 sunbiz signals into zip_signals...');
  await db.query(`
    INSERT INTO zip_signals (
      zip,
      sunbiz_active_entities,
      sunbiz_new_12mo,
      sunbiz_dissolved_12mo,
      sunbiz_net_12mo,
      last_updated_at
    )
    SELECT
      zip,
      COUNT(*) FILTER (WHERE status = 'active')::int                                          AS sunbiz_active_entities,
      COUNT(*) FILTER (WHERE registered_date >= NOW() - INTERVAL '12 months')::int            AS sunbiz_new_12mo,
      COUNT(*) FILTER (WHERE status != 'active'
                         AND updated_at >= NOW() - INTERVAL '12 months')::int                 AS sunbiz_dissolved_12mo,
      (
        COUNT(*) FILTER (WHERE registered_date >= NOW() - INTERVAL '12 months')
        - COUNT(*) FILTER (WHERE status != 'active' AND updated_at >= NOW() - INTERVAL '12 months')
      )::int                                                                                   AS sunbiz_net_12mo,
      NOW()
    FROM businesses
    WHERE primary_source = 'sunbiz'
      AND zip IS NOT NULL
      AND zip != '00000'
      AND zip ~ '^[0-9]{5}$'
    GROUP BY zip
    ON CONFLICT (zip) DO UPDATE SET
      sunbiz_active_entities = EXCLUDED.sunbiz_active_entities,
      sunbiz_new_12mo        = EXCLUDED.sunbiz_new_12mo,
      sunbiz_dissolved_12mo  = EXCLUDED.sunbiz_dissolved_12mo,
      sunbiz_net_12mo        = EXCLUDED.sunbiz_net_12mo,
      last_updated_at        = NOW()
  `);
  console.log('[sunbizWorker] All 4 sunbiz signals aggregated (active, new_12mo, dissolved_12mo, net_12mo)');
}

// ── SFTP download with exponential backoff ────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function downloadFile(digit, localPath) {
  const remotePath = `${REMOTE_DIR}/cordata${digit}.zip`;
  let lastErr = null;

  for (let attempt = 0; attempt < SFTP_ATTEMPTS; attempt++) {
    let sftp = new SftpClient();
    try {
      console.log(`[sunbizWorker] SFTP connect attempt ${attempt + 1}/${SFTP_ATTEMPTS} for ${remotePath}`);
      await sftp.connect({
        host: SFTP_HOST,
        port: SFTP_PORT,
        username: SFTP_USER,
        password: SFTP_PASS,
        readyTimeout: 30000,
      });
      const stat = await sftp.stat(remotePath);
      console.log(`[sunbizWorker] Remote ${remotePath}: ${(stat.size / 1024 / 1024).toFixed(1)} MB — downloading to ${localPath}`);
      await sftp.fastGet(remotePath, localPath);
      await sftp.end().catch(() => {});
      console.log(`[sunbizWorker] Download complete: cordata${digit}.zip`);
      return;
    } catch (e) {
      lastErr = e;
      console.error(`[sunbizWorker] SFTP attempt ${attempt + 1} failed for cordata${digit}.zip: ${e.message}`);
      await sftp.end().catch(() => {});
      sftp = null;
      // Clean partial download
      try { if (fs.existsSync(localPath)) fs.unlinkSync(localPath); } catch (_) {}
      if (attempt < SFTP_ATTEMPTS - 1) {
        const wait = BACKOFF_MS[attempt];
        console.log(`[sunbizWorker] Backing off ${wait / 1000}s before retry...`);
        await sleep(wait);
      }
    }
  }

  console.error(`[sunbizWorker] All ${SFTP_ATTEMPTS} SFTP attempts failed for cordata${digit}.zip — exiting`);
  throw new Error(`SFTP download failed after ${SFTP_ATTEMPTS} attempts: ${lastErr?.message || 'unknown'}`);
}

// ── 7z extract zip to a directory ─────────────────────────────────────────────
function extractZip(zipPath, outDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(outDir, { recursive: true });
    const proc = spawn('7z', ['x', zipPath, `-o${outDir}`, '-y'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.stdout.on('data', () => {}); // drain
    proc.on('error', e => reject(new Error(`7z spawn failed: ${e.message}`)));
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`7z exit code ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

function findExtractedTxt(dir) {
  const entries = fs.readdirSync(dir);
  for (const f of entries) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isFile()) return full;
    if (stat.isDirectory()) {
      const sub = findExtractedTxt(full);
      if (sub) return sub;
    }
  }
  return null;
}

function rmrf(p) {
  try {
    if (!fs.existsSync(p)) return;
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    console.warn(`[sunbizWorker] rmrf ${p} failed: ${e.message}`);
  }
}

// ── Process one cordata{N}.zip ────────────────────────────────────────────────
async function processFile(digit) {
  const zipPath = `/tmp/cordata${digit}.zip`;
  const extractDir = `/tmp/sunbiz${digit}`;

  // Always clean stale extraction dir
  rmrf(extractDir);

  rmrf(zipPath);
  await downloadFile(digit, zipPath);

  console.log(`[sunbizWorker] Extracting cordata${digit}.zip with 7z...`);
  await extractZip(zipPath, extractDir);

  const txtPath = findExtractedTxt(extractDir);
  if (!txtPath) throw new Error(`No extracted file found in ${extractDir}`);
  console.log(`[sunbizWorker] Extracted to ${txtPath} — streaming parse...`);

  let batch = [];
  let imported = 0;
  let totalLines = 0;
  let skipped = 0;

  const stream = fs.createReadStream(txtPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    totalLines++;
    const rec = parseRecord(line);
    if (!rec) { skipped++; continue; }
    batch.push(rec);
    if (batch.length >= BATCH_SIZE) {
      const flush = batch;
      batch = [];
      await upsertBatch(flush);
      imported += flush.length;
      if (imported % 10000 < BATCH_SIZE) {
        console.log(`[sunbizWorker] File ${digit}: ${imported.toLocaleString()} FL active records → Postgres`);
      }
    }
  }
  if (batch.length) {
    await upsertBatch(batch);
    imported += batch.length;
  }

  console.log(`[sunbizWorker] File ${digit} complete — ${imported.toLocaleString()} FL active records parsed (from ${totalLines.toLocaleString()} total lines, ${skipped.toLocaleString()} skipped)`);

  // Cleanup tmp files
  rmrf(zipPath);
  rmrf(extractDir);

  return { imported, totalLines, skipped };
}

// ── Process a single-file zip from SUNBIZ_FILES_PATH ─────────────────────────
// FL DOS SFTP actually serves a single cordata.zip (1.6 GB) and corevent.zip (179 MB),
// not the cordata0..9 split. When SUNBIZ_FILES_PATH is set we read those single files.
async function processSingleFile(zipPath, tag) {
  const extractDir = `/tmp/sunbiz_${tag}`;

  rmrf(extractDir);

  if (!fs.existsSync(zipPath)) {
    throw new Error(`SUNBIZ_FILES_PATH mode: ${zipPath} not found`);
  }
  console.log(`[sunbizWorker] FILE-PATH MODE — using ${zipPath} (skipping SFTP)`);

  console.log(`[sunbizWorker] Extracting ${path.basename(zipPath)} with 7z...`);
  await extractZip(zipPath, extractDir);

  const txtPath = findExtractedTxt(extractDir);
  if (!txtPath) throw new Error(`No extracted file found in ${extractDir}`);
  console.log(`[sunbizWorker] Extracted to ${txtPath} — streaming parse...`);

  let batch = [];
  let imported = 0;
  let totalLines = 0;
  let skipped = 0;

  const stream = fs.createReadStream(txtPath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    totalLines++;
    const rec = parseRecord(line);
    if (!rec) { skipped++; continue; }
    batch.push(rec);
    if (batch.length >= BATCH_SIZE) {
      const flush = batch;
      batch = [];
      await upsertBatch(flush);
      imported += flush.length;
      if (imported % 10000 < BATCH_SIZE) {
        console.log(`[sunbizWorker] ${tag}: ${imported.toLocaleString()} FL active records → Postgres`);
      }
    }
  }
  if (batch.length) {
    await upsertBatch(batch);
    imported += batch.length;
  }

  console.log(`[sunbizWorker] ${tag} complete — ${imported.toLocaleString()} FL active records parsed (from ${totalLines.toLocaleString()} total lines, ${skipped.toLocaleString()} skipped)`);

  rmrf(extractDir);

  return { imported, totalLines, skipped };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function runImport() {
  const start = Date.now();

  const complete = await getState('import_complete');
  if (complete === 'true') {
    console.log('[sunbizWorker] Import already complete — idling');
    return;
  }

  const filesPath = process.env.SUNBIZ_FILES_PATH;
  let totalImported = 0;

  if (filesPath) {
    // FILE-PATH MODE: process single-file cordata.zip (+ corevent.zip if present)
    const cordataZip = path.join(filesPath, 'cordata.zip');
    const { imported: cordataImported } = await processSingleFile(cordataZip, 'cordata');
    totalImported += cordataImported;

    const coreventZip = path.join(filesPath, 'corevent.zip');
    if (fs.existsSync(coreventZip)) {
      try {
        const { imported: coreventImported } = await processSingleFile(coreventZip, 'corevent');
        totalImported += coreventImported;
      } catch (e) {
        // corevent has a different layout than cordata; if parsing yields 0 records
        // that's fine, but a hard failure (extract error) we surface.
        console.error(`[sunbizWorker] corevent.zip processing failed: ${e.message} — continuing`);
      }
    } else {
      console.log(`[sunbizWorker] ${coreventZip} not found — skipping corevent`);
    }
  } else {
    // SFTP MODE: 10-file split cordata0.zip..cordata9.zip
    const filesCompleted = await getFilesCompleted();
    console.log(`[sunbizWorker] Files already completed: [${filesCompleted.join(',') || 'none'}]`);

    for (let digit = 0; digit <= 9; digit++) {
      if (filesCompleted.includes(digit)) {
        console.log(`[sunbizWorker] Skipping file ${digit} (already complete)`);
        continue;
      }
      const { imported } = await processFile(digit);
      totalImported += imported;
      filesCompleted.push(digit);
      await setFilesCompleted(filesCompleted);
      console.log(`[sunbizWorker] Checkpoint saved: files_completed=[${filesCompleted.join(',')}]`);
    }
  }

  await aggregateSunbizSignals();
  await setState('import_complete', 'true');
  console.log(`[sunbizWorker] Import complete — aggregation done. Total imported this run: ${totalImported.toLocaleString()}`);

  await logWorkerEvent({
    eventType: 'complete',
    recordsOut: totalImported,
    durationMs: Date.now() - start,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function run() {
  // Safety guard — this worker must be triggered manually, not on auto-start.
  // If not explicitly triggered, exit immediately.
  if (process.env.SUNBIZ_MANUAL_TRIGGER !== 'true') {
    console.log('[sunbizWorker] Skipping auto-run — manual trigger required (set SUNBIZ_MANUAL_TRIGGER=true)');
    return;
  }

  if (process.env.SUNBIZ_FILES_PATH) {
    console.log(`[sunbizWorker] FILE-PATH MODE — reading from ${process.env.SUNBIZ_FILES_PATH}`);
  }

  if (process.env.SUNBIZ_FILES_PATH) {
    console.log('[sunbizWorker] Starting — file-path mode (cordata.zip + corevent.zip)');
  } else {
    console.log('[sunbizWorker] Starting — SFTP 10-file split (cordata0-9.zip)');
  }

  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.error('[sunbizWorker] LOCAL_INTEL_DB_URL not set — exiting');
    return;
  }

  await ensureStateTable();
  await logWorkerEvent({ eventType: 'start' });
  await runImport();
  await hb.ping('sunbizWorker');
  await logWorkerEvent({ eventType: 'end' });
}

if (require.main === module) {
  run()
    .then(() => {
      console.log('[sunbizWorker] Run complete — exiting cleanly');
      process.exit(0);
    })
    .catch(e => {
      console.error('[sunbizWorker] Fatal error:', e.message, e.stack);
      logWorkerEvent({ eventType: 'error', error: e.message }).catch(() => {});
      // SFTP exhaustion or other fatal — exit with code 1, Railway will backoff
      process.exit(1);
    });
}

module.exports = { runImport };
