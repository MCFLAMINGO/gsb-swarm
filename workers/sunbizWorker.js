'use strict';
/**
 * workers/sunbizWorker.js
 * Railway-ready Sunbiz import worker — fully streaming, zero disk writes.
 *
 * Flow:
 *   SFTP createReadStream → unzipper.Parse() → readline → parseRecord() → upsertBatch()
 *
 * Postgres is the only persistence layer. Nothing lands on disk.
 * Safe to restart at any point — resumes from `lines_imported` checkpoint.
 */

require('dotenv').config();
const readline    = require('readline');
const unzipper    = require('unzipper');
const SftpClient  = require('ssh2-sftp-client');
const db          = require('../lib/db');
const hb          = require('../lib/workerHeartbeat');

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

// ── Streaming pipeline: SFTP → unzipper → readline → Postgres ─────────────────
async function streamSunbizToPostgres() {
  const sftp = new SftpClient();
  const _importStart = Date.now();

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

    const resumeLine = parseInt(await getState('lines_imported') || '0');
    console.log(`[sunbizWorker] Streaming from SFTP. Resume line: ${resumeLine}`);

    const sftpStream = sftp.createReadStream(REMOTE_PATH, { autoClose: true });

    let imported = resumeLine;
    let skipped  = 0;
    let processedEntry = false;

    await new Promise((resolve, reject) => {
      const zipStream = sftpStream.pipe(unzipper.Parse());

      sftpStream.on('error', reject);
      zipStream.on('error', reject);

      zipStream.on('entry', async (entry) => {
        const fileName = entry.path;

        if (!/\.(txt|TXT)$/.test(fileName)) {
          entry.autodrain();
          return;
        }

        if (processedEntry) {
          // already processed the .txt — drain any other entries
          entry.autodrain();
          return;
        }
        processedEntry = true;

        console.log(`[sunbizWorker] Streaming entry: ${fileName}`);

        try {
          const rl = readline.createInterface({ input: entry, crlfDelay: Infinity });

          let lineNum = 0;
          let batch   = [];

          for await (const line of rl) {
            lineNum++;
            if (lineNum <= resumeLine) continue;
            if (!line.trim()) continue;

            const record = parseRecord(line);
            if (!record) { skipped++; continue; }

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
          resolve();
        } catch (err) {
          reject(err);
        }
      });

      zipStream.on('close', () => {
        if (!processedEntry) {
          reject(new Error('No .txt entry found in cordata.zip'));
        }
      });
    });

    await sftp.end();

    await logWorkerEvent({
      eventType: 'complete',
      recordsIn: imported + skipped,
      recordsOut: imported,
      durationMs: Date.now() - _importStart,
    });
    await hb.ping('sunbizWorker');
  } catch (e) {
    console.error('[sunbizWorker] Stream error:', e.message);
    try { await sftp.end(); } catch (_) {}
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
  await streamSunbizToPostgres();
  await logWorkerEvent({ eventType: 'end' });
}

run().catch(e => console.error('[sunbizWorker] Fatal:', e.message));
