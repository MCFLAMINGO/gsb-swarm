'use strict';
/**
 * workers/sunbizWorker.js
 * Railway-ready Sunbiz import worker.
 *
 * Flow:
 *   SFTP download → /tmp/sunbiz/cordata.zip
 *   execSync('unzip -o ...') → /tmp/sunbiz/extracted/  (system unzip, supports DEFLATE64)
 *   readline → parseRecord() → upsertBatch() → Postgres
 *   fs.rmSync('/tmp/sunbiz', { recursive: true, force: true })
 *
 * Postgres is the only persistence layer. /tmp is process-memory and is cleared
 * between deploys — perfect for transient download/extract.
 *
 * The `lines_imported` checkpoint allows resuming within a session. On restart
 * /tmp is cleared, so re-download + re-extract happens, then import resumes
 * from `lines_imported`. Once `import_complete = true`, the worker idles.
 */

require('dotenv').config();
const fs           = require('fs');
const path         = require('path');
const readline     = require('readline');
const { execSync } = require('child_process');
const SftpClient   = require('ssh2-sftp-client');
const db           = require('../lib/db');
const hb           = require('../lib/workerHeartbeat');

const SUNBIZ_DIR  = '/tmp/sunbiz';
const ZIP_FILE    = path.join(SUNBIZ_DIR, 'cordata.zip');
const EXTRACT_DIR = path.join(SUNBIZ_DIR, 'extracted');

// One-time cleanup of legacy disk artifacts. Pre-B83 worker versions wrote to
// the Railway persistent volume (data/sunbiz*) and filled it. Also clean any
// stale /tmp/sunbiz from a previous run in the same process lifecycle.
(function cleanLegacyDiskArtifacts() {
  // Only wipe legacy Railway-volume paths — NOT /tmp/sunbiz (partial downloads must survive restarts)
  const legacyPaths = [
    path.join(__dirname, '..', 'data', 'sunbiz'),
    path.join(__dirname, '..', 'data', 'sunbiz-extract'),
  ];
  for (const p of legacyPaths) {
    try {
      if (fs.existsSync(p)) {
        fs.rmSync(p, { recursive: true, force: true });
        console.log('[sunbizWorker] Cleaned artifact:', p);
      }
    } catch (e) {
      console.warn('[sunbizWorker] Could not clean:', p, e.message);
    }
  }
})();

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

const SFTP_HOST   = 'sftp.floridados.gov';
const SFTP_USER   = 'Public';
const SFTP_PASS   = 'PubAccess1845!';
const REMOTE_PATH = 'doc/quarterly/cor/cordata.zip';

const BATCH_SIZE  = 500;

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

// ── Download zip from SFTP to /tmp ────────────────────────────────────────────
async function downloadZip() {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: SFTP_HOST, port: 22, username: SFTP_USER, password: SFTP_PASS, readyTimeout: 30000 });

    const remoteSize = (await sftp.stat(REMOTE_PATH)).size;
    console.log(`[sunbizWorker] Remote: ${(remoteSize / 1024 / 1024).toFixed(1)} MB`);

    const lastRemoteSize = await getState('remote_size');
    if (lastRemoteSize && parseInt(lastRemoteSize) !== remoteSize) {
      console.log('[sunbizWorker] New quarterly file detected — resetting checkpoint');
      await setState('lines_imported', '0');
      await setState('import_complete', 'false');
    }
    await setState('remote_size', String(remoteSize));

    fs.mkdirSync(SUNBIZ_DIR, { recursive: true });

    // Resume partial download if file exists
    let localSize = 0;
    if (fs.existsSync(ZIP_FILE)) {
      localSize = fs.statSync(ZIP_FILE).size;
      if (localSize === remoteSize) {
        console.log(`[sunbizWorker] ZIP already complete (${(localSize/1024/1024).toFixed(1)} MB) — skipping download`);
        await sftp.end();
        return remoteSize;
      }
      console.log(`[sunbizWorker] Resuming download from ${(localSize/1024/1024).toFixed(1)} MB / ${(remoteSize/1024/1024).toFixed(1)} MB`);
    } else {
      console.log(`[sunbizWorker] Starting download SFTP → ${ZIP_FILE}`);
    }

    // Stream from offset into append stream
    await new Promise((resolve, reject) => {
      const remoteStream = sftp.createReadStream(REMOTE_PATH, { start: localSize, autoClose: true });
      const writeFlags = localSize > 0 ? 'a' : 'w';
      const localStream = fs.createWriteStream(ZIP_FILE, { flags: writeFlags, start: localSize });
      let downloaded = localSize;
      remoteStream.on('data', chunk => {
        downloaded += chunk.length;
        if (Math.floor(downloaded / (100*1024*1024)) > Math.floor((downloaded - chunk.length) / (100*1024*1024))) {
          console.log(`[sunbizWorker] Downloaded ${(downloaded/1024/1024).toFixed(0)} MB / ${(remoteSize/1024/1024).toFixed(0)} MB`);
        }
      });
      remoteStream.on('error', reject);
      localStream.on('error', reject);
      localStream.on('finish', resolve);
      remoteStream.pipe(localStream);
    });

    const finalSize = fs.statSync(ZIP_FILE).size;
    if (finalSize !== remoteSize) {
      throw new Error(`Download size mismatch: local=${finalSize} remote=${remoteSize}`);
    }
    console.log(`[sunbizWorker] Download complete: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);

    return remoteSize;
  } finally {
    try { await sftp.end(); } catch (_) {}
  }
}

// ── Extract zip with system unzip (DEFLATE64 support) ─────────────────────────
function extractZip() {
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  console.log(`[sunbizWorker] Extracting ${ZIP_FILE} → ${EXTRACT_DIR}`);
  execSync(`unzip -o "${ZIP_FILE}" -d "${EXTRACT_DIR}"`, { stdio: 'inherit' });

  const entries = fs.readdirSync(EXTRACT_DIR);
  const txtFile = entries.find(f => /\.txt$/i.test(f));
  if (!txtFile) {
    throw new Error(`No .txt file found in extracted zip. Entries: ${entries.join(', ')}`);
  }
  const txtPath = path.join(EXTRACT_DIR, txtFile);
  console.log(`[sunbizWorker] Extracted: ${txtPath} (${(fs.statSync(txtPath).size / 1024 / 1024).toFixed(1)} MB)`);
  return txtPath;
}

// ── Stream .txt → Postgres ────────────────────────────────────────────────────
async function importTxtToPostgres(txtPath) {
  const resumeLine = parseInt(await getState('lines_imported') || '0');
  console.log(`[sunbizWorker] Streaming ${txtPath} → Postgres. Resume line: ${resumeLine}`);

  const rl = readline.createInterface({
    input: fs.createReadStream(txtPath),
    crlfDelay: Infinity,
  });

  let imported = resumeLine;
  let skipped  = 0;
  let lineNum  = 0;
  let batch    = [];

  for await (const line of rl) {
    lineNum++;
    if (lineNum <= resumeLine) continue;
    if (!line.trim()) continue;

    const record = parseRecord(line);
    if (!record) {
      skipped++;
      if (skipped <= 3) console.warn(`[sunbizWorker] parseRecord rejected line ${lineNum} (first 120 chars): ${JSON.stringify(line.slice(0,120))}`);
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

  await setState('import_complete', 'true');
  console.log(`[sunbizWorker] Import complete: ${imported.toLocaleString()} records, ${skipped} skipped`);
  return { imported, skipped };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────
async function runImport() {
  const _importStart = Date.now();
  try {
    await downloadZip();
    const txtPath = extractZip();
    const { imported, skipped } = await importTxtToPostgres(txtPath);

    await logWorkerEvent({
      eventType: 'complete',
      recordsIn: imported + skipped,
      recordsOut: imported,
      durationMs: Date.now() - _importStart,
    });
    await hb.ping('sunbizWorker');
    // Only clean up on success — partial downloads must survive errors for resume
    try {
      fs.rmSync(SUNBIZ_DIR, { recursive: true, force: true });
      console.log('[sunbizWorker] Cleaned /tmp/sunbiz');
    } catch (e) {
      console.warn('[sunbizWorker] Cleanup failed:', e.message);
    }
  } catch (e) {
    console.error('[sunbizWorker] Import error:', e.message);
    console.log('[sunbizWorker] Leaving /tmp/sunbiz intact for resume on next trigger');
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

// Only auto-run when executed directly (not when require()'d by dashboard-server)
if (require.main === module) {
  run().catch(e => console.error('[sunbizWorker] Fatal:', e.message));
}

module.exports = { runImport };
