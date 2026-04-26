'use strict';
/**
 * workers/sunbizWorker.js
 * Railway-ready Sunbiz import worker.
 *
 * Flow:
 *   1. Check Postgres checkpoint — if import already complete, idle.
 *   2. Download cordata.zip from FL Sunbiz SFTP (resumes from last byte).
 *   3. Extract + parse pipe-delimited records in streaming batches.
 *   4. Upsert into businesses table via sunbiz_doc_number.
 *   5. Write progress to worker_heartbeat + sunbiz_import_state table.
 *
 * Runs once on startup, then checks weekly for a new quarterly file.
 * Safe to restart at any point — fully idempotent.
 */

require('dotenv').config();
const fs      = require('fs');
const path    = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const db      = require('../lib/db');
const hb      = require('../lib/workerHeartbeat');

const SFTP_HOST   = 'sftp.floridados.gov';
const SFTP_USER   = 'Public';
const SFTP_PASS   = 'PubAccess1845!';
const REMOTE_PATH = 'doc/quarterly/cor/cordata.zip';

const DATA_DIR    = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SUNBIZ_DIR  = path.join(DATA_DIR, 'sunbiz');
const ZIP_FILE    = path.join(SUNBIZ_DIR, 'cordata.zip');
const EXTRACT_DIR = path.join(SUNBIZ_DIR, 'extracted');

const BATCH_SIZE  = 500;   // upsert rows per transaction
const WEEKLY_MS   = 7 * 24 * 60 * 60 * 1000;

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

// ── Download ──────────────────────────────────────────────────────────────────
async function downloadSunbiz() {
  fs.mkdirSync(SUNBIZ_DIR, { recursive: true });

  let SftpClient;
  try { SftpClient = require('ssh2-sftp-client'); }
  catch (e) {
    console.error('[sunbizWorker] ssh2-sftp-client not installed — run: npm install ssh2-sftp-client');
    return false;
  }

  const localSize = fs.existsSync(ZIP_FILE) ? fs.statSync(ZIP_FILE).size : 0;
  console.log(`[sunbizWorker] Local: ${(localSize / 1024 / 1024).toFixed(1)} MB`);

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: SFTP_HOST, port: 22, username: SFTP_USER, password: SFTP_PASS, readyTimeout: 30000 });
    const stat = await sftp.stat(REMOTE_PATH);
    const remoteSize = stat.size;
    console.log(`[sunbizWorker] Remote: ${(remoteSize / 1024 / 1024).toFixed(1)} MB`);

    if (localSize >= remoteSize) {
      console.log('[sunbizWorker] ZIP already complete.');
      await sftp.end();
      return true;
    }

    // Check if remote file changed (new quarterly release)
    const lastRemoteSize = await getState('remote_size');
    if (lastRemoteSize && parseInt(lastRemoteSize) !== remoteSize) {
      console.log('[sunbizWorker] New quarterly file detected — resetting import state');
      await setState('lines_imported', '0');
      await setState('import_complete', 'false');
      if (fs.existsSync(ZIP_FILE)) fs.unlinkSync(ZIP_FILE);
    }
    await setState('remote_size', String(remoteSize));

    const writeFlags = localSize > 0 ? 'a' : 'w';
    const outStream  = fs.createWriteStream(ZIP_FILE, { flags: writeFlags });
    const readStream = await sftp.createReadStream(REMOTE_PATH, { start: localSize, autoClose: true });

    let downloaded = localSize;
    let lastLog = Date.now();
    readStream.on('data', chunk => {
      downloaded += chunk.length;
      if (Date.now() - lastLog > 10000) {
        console.log(`[sunbizWorker] Downloaded ${(downloaded / 1024 / 1024).toFixed(1)} / ${(remoteSize / 1024 / 1024).toFixed(1)} MB`);
        lastLog = Date.now();
      }
    });

    await new Promise((resolve, reject) => {
      readStream.pipe(outStream);
      outStream.on('finish', resolve);
      outStream.on('error', reject);
      readStream.on('error', reject);
    });

    console.log(`[sunbizWorker] Download complete: ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
    await sftp.end();
    return true;
  } catch (e) {
    console.error('[sunbizWorker] Download error:', e.message);
    try { await sftp.end(); } catch (_) {}
    return false;
  }
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

// ── Import ────────────────────────────────────────────────────────────────────
async function importSunbiz() {
  // Extract
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  console.log('[sunbizWorker] Extracting ZIP...');
  try {
    execSync(`unzip -o "${ZIP_FILE}" -d "${EXTRACT_DIR}"`, { stdio: 'pipe', timeout: 120000 });
  } catch (e) {
    console.error('[sunbizWorker] Unzip error:', e.message);
    return;
  }

  // Find the .txt file
  const files = fs.readdirSync(EXTRACT_DIR).filter(f => f.endsWith('.txt') || f.endsWith('.TXT'));
  if (!files.length) {
    console.error('[sunbizWorker] No .txt file found in extracted ZIP');
    return;
  }
  const txtFile = path.join(EXTRACT_DIR, files[0]);
  console.log(`[sunbizWorker] Parsing: ${files[0]}`);

  const resumeLine = parseInt(await getState('lines_imported') || '0');
  console.log(`[sunbizWorker] Resuming from line ${resumeLine}`);

  const rl = readline.createInterface({ input: fs.createReadStream(txtFile, 'utf8'), crlfDelay: Infinity });

  let lineNum = 0;
  let batch   = [];
  let imported = resumeLine;
  let skipped  = 0;

  for await (const line of rl) {
    lineNum++;
    if (lineNum <= resumeLine) continue; // resume from checkpoint
    if (!line.trim()) continue;

    const record = parseRecord(line);
    if (!record) { skipped++; continue; }

    batch.push(record);

    if (batch.length >= BATCH_SIZE) {
      await upsertBatch(batch);
      imported += batch.length;
      await setState('lines_imported', String(imported));
      console.log(`[sunbizWorker] Imported ${imported} records...`);
      batch = [];
    }
  }

  // Final batch
  if (batch.length) {
    await upsertBatch(batch);
    imported += batch.length;
  }

  await setState('lines_imported', String(imported));
  await setState('import_complete', 'true');
  await hb.ping('sunbizWorker');
  console.log(`[sunbizWorker] Import complete — ${imported} records, ${skipped} skipped`);
}

async function upsertBatch(records) {
  if (!records.length) return;
  // Upsert into businesses — match on sunbiz_doc_number
  const values = records.map((r, i) => {
    const base = i * 9;
    return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9})`;
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
       sources, primary_source, last_confirmed)
    VALUES ${values}
    ON CONFLICT (sunbiz_doc_number) DO UPDATE SET
      sunbiz_status       = EXCLUDED.sunbiz_status,
      sunbiz_entity_type  = EXCLUDED.sunbiz_entity_type,
      registered_date     = COALESCE(EXCLUDED.registered_date, businesses.registered_date),
      last_confirmed      = NOW(),
      updated_at          = NOW()
  `.replace('sources, primary_source, last_confirmed)', 
    'sources, primary_source, last_confirmed)').replace(
    `$${records.length * 9 - 0})`,
    `$${records.length * 9})`
  ), params).catch(async (e) => {
    // Fallback: upsert one by one if batch fails
    console.warn('[sunbizWorker] Batch upsert failed, falling back to single:', e.message);
    for (const r of records) {
      await db.query(`
        INSERT INTO businesses (sunbiz_doc_number, name, status, sunbiz_status, sunbiz_entity_type, registered_date, confidence_score, category, category_group, sources, primary_source, last_confirmed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,ARRAY['sunbiz'],'sunbiz',NOW())
        ON CONFLICT (sunbiz_doc_number) DO UPDATE SET
          sunbiz_status = $4, sunbiz_entity_type = $5, last_confirmed = NOW(), updated_at = NOW()
      `, [r.sunbiz_doc_number, r.name, r.status, r.sunbiz_status, r.sunbiz_entity_type, r.registered_date, r.confidence_score, r.category, r.category_group])
      .catch(e2 => console.warn('[sunbizWorker] Single upsert failed:', r.sunbiz_doc_number, e2.message));
    }
  });
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
    console.log('[sunbizWorker] Import already complete — idling until next weekly check');
    return;
  }

  const downloaded = await downloadSunbiz();
  if (!downloaded) {
    console.error('[sunbizWorker] Download failed — will retry next run');
    return;
  }

  await importSunbiz();
}

// Run on start, then weekly to catch new quarterly releases
run().catch(e => console.error('[sunbizWorker] Fatal:', e.message));
setInterval(() => {
  // Reset completion flag weekly so new quarterly files get picked up
  setState('import_complete', 'false')
    .then(() => run())
    .catch(e => console.error('[sunbizWorker] Weekly run error:', e.message));
}, WEEKLY_MS);

// Keep-alive
setInterval(() => {}, 1 << 30);
