'use strict';
/**
 * data-seed/reseed_cron.js
 *
 * Railway-native quarterly property reseed for Duval (CO_NO=26) and St. Johns
 * (CO_NO=65). Replaces the Perplexity-hosted runner so the reseed runs entirely
 * on Railway infrastructure.
 *
 * Schedule (set in railway.toml): Jan/Apr/Jul/Oct 1 at 07:33 UTC.
 *
 * Steps:
 *   1. Duval — discover latest UNCERTIFIED real-estate TXT zip on jacksonville.gov,
 *      parse the pipe-delimited multi-record format, COPY+upsert into
 *      property_parcels.
 *   2. St. Johns — pull CAMAData.zip + CAMADataSup.zip from sftp.sjcpa.us,
 *      mdb-export the relevant tables, COPY+upsert into property_parcels.
 *   3. Verify row counts and log results.
 */

const fs       = require('fs');
const fsp      = require('fs/promises');
const path     = require('path');
const os       = require('os');
const zlib     = require('zlib');
const crypto   = require('crypto');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { Pool }  = require('pg');

const execFileP = promisify(execFile);

const TMP = '/tmp';

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(`[reseed_cron ${new Date().toISOString()}]`, ...args);
}

function getPool() {
  const url = process.env.LOCAL_INTEL_DB_URL;
  if (!url) throw new Error('LOCAL_INTEL_DB_URL not set');
  return new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
    max: 2,
    connectionTimeoutMillis: 10000,
  });
}

async function downloadFile(url, dest, { headers = {}, timeoutMs = 600000 } = {}) {
  log(`download ${url} -> ${dest}`);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (gsb-swarm reseed_cron)', ...headers },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const tmp = `${dest}.part`;
    await pipeline(res.body, fs.createWriteStream(tmp));
    await fsp.rename(tmp, dest);
    const sz = (await fsp.stat(dest)).size;
    log(`  downloaded ${(sz / 1024 / 1024).toFixed(1)}MB`);
  } finally {
    clearTimeout(t);
  }
}

// TSV-escape: \N for null, escape backslash + replace tab/newline with space.
function esc(v) {
  if (v === null || v === undefined) return '\\N';
  const s = String(v).trim();
  if (!s) return '\\N';
  return s.replace(/\\/g, '\\\\').replace(/\t/g, ' ').replace(/\r?\n/g, ' ');
}
function ni(v) {
  if (v === null || v === undefined) return '\\N';
  const s = String(v).trim();
  if (!s) return '\\N';
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return '\\N';
  return String(Math.trunc(n));
}
function nf(v) {
  if (v === null || v === undefined) return '\\N';
  const s = String(v).trim();
  if (!s) return '\\N';
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return '\\N';
  return String(n);
}

const COLS = [
  'parcel_id', 'co_no', 'county_name',
  'phy_addr1', 'phy_city', 'phy_zipcd',
  'own_name', 'jv', 'av_sd', 'tv_sd',
  'lnd_val', 'lnd_sqfoot', 'tot_lvg_ar',
  'eff_yr_blt', 'act_yr_blt',
  'no_buldng', 'no_res_unt', 'dor_uc',
  'sale_prc1', 'sale_yr1', 'sale_mo1',
  'beds', 'baths',
];

// ─────────────────────────────────────────────────────────────────────────────
// COPY upload
// ─────────────────────────────────────────────────────────────────────────────

async function copyAndUpsert(pool, tsvPath, tmpTable, upsertSql) {
  // Try to use pg-copy-streams if installed; else fall back to psql binary.
  let copyFrom;
  try { copyFrom = require('pg-copy-streams').from; } catch (_) { /* ignore */ }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE ${tmpTable} (LIKE property_parcels INCLUDING DEFAULTS) ON COMMIT DROP`);

    const copySql = `COPY ${tmpTable} (${COLS.join(',')}) FROM STDIN WITH (FORMAT text, NULL '\\N', DELIMITER E'\\t')`;

    if (copyFrom) {
      log(`  COPY via pg-copy-streams -> ${tmpTable}`);
      const stream = client.query(copyFrom(copySql));
      await pipeline(fs.createReadStream(tsvPath), stream);
    } else {
      // Buffer + send as single statement using a workaround: read TSV and
      // INSERT in chunks. This is slower but avoids extra deps. Prefer the
      // streaming path when pg-copy-streams is available.
      log('  pg-copy-streams not installed — falling back to chunked INSERT');
      await chunkedInsert(client, tsvPath, tmpTable);
    }

    const cntRes = await client.query(`SELECT COUNT(*)::int AS c FROM ${tmpTable}`);
    log(`  staged ${cntRes.rows[0].c.toLocaleString()} rows in ${tmpTable}`);

    log('  running upsert from temp table');
    const upRes = await client.query(upsertSql);
    log(`  upsert rowCount=${upRes.rowCount}`);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function chunkedInsert(client, tsvPath, tmpTable) {
  const data = await fsp.readFile(tsvPath, 'utf8');
  const lines = data.split('\n').filter((l) => l.length > 0);
  const placeholders = COLS.map((_, i) => `$${i + 1}`).join(',');
  const insertSql = `INSERT INTO ${tmpTable} (${COLS.join(',')}) VALUES (${placeholders})`;
  let n = 0;
  for (const line of lines) {
    const fields = line.split('\t').map((f) => (f === '\\N' ? null : f));
    if (fields.length !== COLS.length) continue;
    await client.query(insertSql, fields);
    n++;
    if (n % 50000 === 0) log(`    inserted ${n}`);
  }
  log(`    inserted ${n} total`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal ZIP reader (deflate + stored, no encryption). Suitable for the
// public county zips we consume. Avoids a runtime dep on adm-zip/unzipper.
// ─────────────────────────────────────────────────────────────────────────────

function readUInt32LE(buf, off) { return buf.readUInt32LE(off); }
function readUInt16LE(buf, off) { return buf.readUInt16LE(off); }

function findEOCD(buf) {
  // End of central directory record: signature 0x06054b50, near end of file.
  const sig = 0x06054b50;
  const maxScan = Math.min(buf.length, 65557);
  for (let i = buf.length - 22; i >= buf.length - maxScan; i--) {
    if (buf.readUInt32LE(i) === sig) return i;
  }
  throw new Error('EOCD not found in zip');
}

function listZipEntries(buf) {
  const eocd = findEOCD(buf);
  const cdCount  = readUInt16LE(buf, eocd + 10);
  const cdSize   = readUInt32LE(buf, eocd + 12);
  const cdOffset = readUInt32LE(buf, eocd + 16);
  const entries = [];
  let off = cdOffset;
  for (let i = 0; i < cdCount; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad CDH sig');
    const method      = readUInt16LE(buf, off + 10);
    const compSize    = readUInt32LE(buf, off + 20);
    const uncompSize  = readUInt32LE(buf, off + 24);
    const nameLen     = readUInt16LE(buf, off + 28);
    const extraLen    = readUInt16LE(buf, off + 30);
    const commentLen  = readUInt16LE(buf, off + 32);
    const localOffset = readUInt32LE(buf, off + 42);
    const name        = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    entries.push({ name, method, compSize, uncompSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
    if (off - cdOffset > cdSize + 65536) throw new Error('CDH overrun');
  }
  return entries;
}

function extractZipEntry(buf, entry) {
  // Parse local file header to find true data offset.
  const lfh = entry.localOffset;
  if (buf.readUInt32LE(lfh) !== 0x04034b50) throw new Error('bad LFH sig');
  const nameLen  = readUInt16LE(buf, lfh + 26);
  const extraLen = readUInt16LE(buf, lfh + 28);
  const dataOff  = lfh + 30 + nameLen + extraLen;
  const compData = buf.slice(dataOff, dataOff + entry.compSize);
  if (entry.method === 0) return compData;            // stored
  if (entry.method === 8) return zlib.inflateRawSync(compData); // deflate
  throw new Error(`unsupported zip method ${entry.method}`);
}

async function extractZipTo(zipPath, destDir, { match } = {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const buf = await fsp.readFile(zipPath);
  const entries = listZipEntries(buf);
  const out = [];
  for (const e of entries) {
    if (e.name.endsWith('/')) continue;
    if (match && !match.test(e.name)) continue;
    const data = extractZipEntry(buf, e);
    const target = path.join(destDir, path.basename(e.name));
    await fsp.writeFile(target, data);
    out.push(target);
    log(`  extracted ${e.name} (${(data.length / 1024 / 1024).toFixed(1)}MB) -> ${target}`);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Latin-1 line iterator over large TXT file (no full-file buffer)
// ─────────────────────────────────────────────────────────────────────────────

async function* latin1Lines(filePath) {
  const stream = fs.createReadStream(filePath, { highWaterMark: 1 << 20 });
  let carry = '';
  for await (const chunk of stream) {
    // latin-1: every byte maps to a Unicode code point of the same value
    let s = '';
    for (let i = 0; i < chunk.length; i++) s += String.fromCharCode(chunk[i]);
    s = carry + s;
    const lines = s.split(/\r?\n/);
    carry = lines.pop(); // last line may be partial
    for (const line of lines) yield line;
  }
  if (carry.length > 0) yield carry;
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 1 — Duval
// ─────────────────────────────────────────────────────────────────────────────

async function discoverDuvalZipUrl() {
  const PAGE = 'https://www.jacksonville.gov/departments/property-appraiser/data-offerings';
  log('discovering Duval UNCERTIFIED real-estate TXT zip URL');
  const res = await fetch(PAGE, {
    headers: { 'User-Agent': 'Mozilla/5.0 (gsb-swarm reseed_cron)' },
  });
  if (!res.ok) throw new Error(`Duval page HTTP ${res.status}`);
  const html = await res.text();

  // Look for URLs ending in REAL-ESTATE-PIPE-DELIMITED-TEXT-UNCERTIFIED-AS-OF-MM-DD-YYYY.zip
  // (case-insensitive; the language=en suffix is optional).
  const re = /https?:\/\/[^"'\s<>]*REAL-ESTATE-PIPE-DELIMITED-TEXT-UNCERTIFIED-AS-OF-(\d{2})-(\d{2})-(\d{4})\.zip[^"'\s<>]*/gi;
  const matches = [...html.matchAll(re)];
  if (!matches.length) {
    // Fallback: try a more permissive pattern
    const re2 = /https?:\/\/[^"'\s<>]*UNCERTIFIED[^"'\s<>]*\.zip[^"'\s<>]*/gi;
    const m2 = [...html.matchAll(re2)];
    if (!m2.length) throw new Error('No UNCERTIFIED Duval zip URL found on data-offerings page');
    log(`  fallback URL: ${m2[0][0]}`);
    return m2[0][0];
  }
  // Pick the most recent by date in the URL.
  matches.sort((a, b) => {
    const da = new Date(`${a[3]}-${a[1]}-${a[2]}`).getTime();
    const db = new Date(`${b[3]}-${b[1]}-${b[2]}`).getTime();
    return db - da;
  });
  const url = matches[0][0];
  log(`  latest: ${url}`);
  return url;
}

async function seedDuval(pool) {
  log('=== STEP 1: DUVAL (CO_NO=26) ===');

  const url = await discoverDuvalZipUrl();
  const zipPath = path.join(TMP, 'duval_re.zip');
  await downloadFile(url, zipPath, { timeoutMs: 600000 });

  const extractDir = path.join(TMP, 'duval_extract');
  await fsp.rm(extractDir, { recursive: true, force: true });
  const files = await extractZipTo(zipPath, extractDir, { match: /\.txt$/i });
  if (!files.length) throw new Error('No TXT file in Duval zip');
  const txtPath = files[0];

  log(`parsing ${txtPath}`);
  const parcels = new Map(); // strap -> { jv, av_sd, tv_sd, dor_uc, sqft }
  const owners  = new Map(); // strap -> name
  const sites   = new Map(); // strap -> { addr1, city, zip }
  const bldgs   = new Map(); // strap -> { act_yr, eff_yr, heat_ar }
  const beds    = new Map(); // strap -> int
  const baths   = new Map(); // strap -> float

  let lineCount = 0;
  for await (const line of latin1Lines(txtPath)) {
    lineCount++;
    if (line.length < 3) continue;
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const rtype = parts[0].trim();
    // NOTE: the spec uses 1-based index when reading from parts after rtype.
    // strap is at parts[1] in our 0-based array, dor_uc at parts[13], totalMarket
    // at parts[22], etc. Match seed_duval.py exactly.
    const strap = (parts[1] || '').trim();
    if (!strap) continue;

    if (rtype === '00001') {
      if (parts.length < 26) continue;
      parcels.set(strap, {
        jv:    (parts[22] || '').trim(),
        av_sd: (parts[23] || '').trim(),
        tv_sd: (parts[25] || '').trim(),
        dor_uc:(parts[13] || '').trim(),
        sqft:  (parts[30] || '').trim(),
      });
    } else if (rtype === '00003') {
      // 00003: owner — strap(1), lineNum(2)='1', ownerName(3)
      const ln = (parts[2] || '').trim();
      if (ln === '1' && parts.length > 3) {
        owners.set(strap, (parts[3] || '').trim());
      }
    } else if (rtype === '00004') {
      // 00004: site address — strap(1), strNum(2), prefix(3), street(4), suffix(5),
      // unit(6), city(7), zip(8)
      const num   = (parts[2] || '').trim();
      const pfx   = (parts[3] || '').trim();
      const nm    = (parts[4] || '').trim();
      const sfx   = (parts[5] || '').trim();
      const unit  = (parts[6] || '').trim();
      const city  = (parts[7] || '').trim();
      const zipcd = (parts[8] || '').trim();
      let addr1 = [num, pfx, nm, sfx].filter(Boolean).join(' ');
      if (unit) addr1 += ` ${unit}`;
      sites.set(strap, { addr1, city, zip: zipcd.slice(0, 5) });
    } else if (rtype === '00005') {
      if (!bldgs.has(strap) && parts.length >= 13) {
        bldgs.set(strap, {
          act_yr: (parts[8] || '').trim(),
          eff_yr: (parts[9] || '').trim(),
          heat_ar:(parts[12] || '').trim(),
        });
      }
    } else if (rtype === '00007' && parts.length >= 6) {
      const cd    = (parts[3] || '').trim();
      const desc  = (parts[4] || '').trim().toLowerCase();
      const units = (parts[5] || '').trim();
      const isBed  = cd === '1' || /bedroom|^br$|^bed$/.test(desc);
      const isBath = cd === '2' || /bath/.test(desc);
      if (isBed && !beds.has(strap)) {
        const n = parseFloat(units);
        if (Number.isFinite(n)) beds.set(strap, Math.trunc(n));
      } else if (isBath && !baths.has(strap)) {
        const n = parseFloat(units);
        if (Number.isFinite(n)) baths.set(strap, n);
      }
    }

    if (lineCount % 1000000 === 0) log(`  ...${lineCount.toLocaleString()} lines, ${parcels.size.toLocaleString()} parcels`);
  }
  log(`parsed ${lineCount.toLocaleString()} lines, ${parcels.size.toLocaleString()} parcels`);

  const tsvPath = path.join(TMP, 'duval_seed.tsv');
  const out = fs.createWriteStream(tsvPath);
  for (const [strap, p] of parcels) {
    const site = sites.get(strap) || {};
    const bldg = bldgs.get(strap) || {};
    const row = [
      esc(strap), '26', 'duval',
      esc(site.addr1 || ''), esc(site.city || ''), esc(site.zip || ''),
      esc(owners.get(strap) || ''),
      nf(p.jv), nf(p.av_sd), nf(p.tv_sd),
      '\\N', nf(p.sqft), nf(bldg.heat_ar || ''),
      ni(bldg.eff_yr || ''), ni(bldg.act_yr || ''),
      '\\N', '\\N', esc(p.dor_uc || ''),
      '\\N', '\\N', '\\N',
      beds.has(strap) ? String(beds.get(strap)) : '\\N',
      baths.has(strap) ? String(baths.get(strap)) : '\\N',
    ];
    if (!out.write(row.join('\t') + '\n')) {
      await new Promise((r) => out.once('drain', r));
    }
  }
  await new Promise((r) => out.end(r));
  const sz = (await fsp.stat(tsvPath)).size;
  log(`wrote ${tsvPath} ${(sz / 1024 / 1024).toFixed(1)}MB`);

  // Free memory before DB step
  parcels.clear(); owners.clear(); sites.clear(); bldgs.clear(); beds.clear(); baths.clear();
  if (global.gc) global.gc();

  const upsertSql = `
    INSERT INTO property_parcels (
      ${COLS.join(',')}, fetched_at
    )
    SELECT ${COLS.join(',')}, NOW() FROM tmp_duval
    ON CONFLICT (parcel_id) DO UPDATE SET
      own_name=EXCLUDED.own_name,
      jv=EXCLUDED.jv, av_sd=EXCLUDED.av_sd, tv_sd=EXCLUDED.tv_sd,
      tot_lvg_ar=EXCLUDED.tot_lvg_ar,
      eff_yr_blt=EXCLUDED.eff_yr_blt, act_yr_blt=EXCLUDED.act_yr_blt,
      phy_addr1=EXCLUDED.phy_addr1, phy_city=EXCLUDED.phy_city, phy_zipcd=EXCLUDED.phy_zipcd,
      sale_prc1=EXCLUDED.sale_prc1, sale_yr1=EXCLUDED.sale_yr1,
      beds=EXCLUDED.beds, baths=EXCLUDED.baths,
      fetched_at=NOW()`;
  await copyAndUpsert(pool, tsvPath, 'tmp_duval', upsertSql);

  log('Duval seed complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 2 — St. Johns
// ─────────────────────────────────────────────────────────────────────────────

function parseCsv(text) {
  // Minimal CSV parser — handles quotes and escaped quotes (RFC 4180-ish).
  const rows = [];
  let cur = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQ = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { cur.push(field); field = ''; }
      else if (c === '\n') { cur.push(field); rows.push(cur); cur = []; field = ''; }
      else if (c === '\r') { /* skip */ }
      else field += c;
    }
  }
  if (field.length || cur.length) { cur.push(field); rows.push(cur); }
  return rows;
}

async function mdbExportRows(mdbPath, tableName) {
  log(`  mdb-export ${path.basename(mdbPath)} :: ${tableName}`);
  const { stdout } = await execFileP('mdb-export', [mdbPath, tableName], {
    maxBuffer: 1024 * 1024 * 1024, // 1GB
  });
  const rows = parseCsv(stdout);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (r.length === 1 && r[0] === '') continue;
    const obj = {};
    for (let j = 0; j < header.length; j++) obj[header[j]] = r[j] ?? '';
    out.push(obj);
  }
  return out;
}

async function seedStJohns(pool) {
  log('=== STEP 2: ST. JOHNS (CO_NO=65) ===');

  const workDir = path.join(TMP, 'sjcpa');
  await fsp.mkdir(workDir, { recursive: true });

  // Download both zips
  const camaZip    = path.join(workDir, 'CAMAData.zip');
  const camaSupZip = path.join(workDir, 'CAMADataSup.zip');
  await downloadFile('https://sftp.sjcpa.us/CAMAData.zip',    camaZip,    { timeoutMs: 1200000 });
  await downloadFile('https://sftp.sjcpa.us/CAMADataSup.zip', camaSupZip, { timeoutMs: 1200000 });

  // Extract MDBs
  const camaFiles    = await extractZipTo(camaZip,    workDir, { match: /\.mdb$/i });
  const camaSupFiles = await extractZipTo(camaSupZip, workDir, { match: /\.mdb$/i });
  if (!camaFiles.length || !camaSupFiles.length) throw new Error('Missing MDB files after extract');

  // Find specific MDBs by name (or first match)
  const camaMdb    = camaFiles.find((f) => /CAMAData\.mdb$/i.test(f))    || camaFiles[0];
  const camaSupMdb = camaSupFiles.find((f) => /CAMADataSup\.mdb$/i.test(f)) || camaSupFiles[0];

  // Building lookup keyed by strap (first record per strap)
  // B13: BldView fields per SJCPA confirmation 2026-05-11:
  //   heated_ar → tot_lvg_ar (living_sqft)
  //   Act       → act_yr_blt (year_built)
  //   Eff       → eff_yr_blt
  // mdb-export lowercases headers, so we read r.heated_ar / r.act / r.eff.
  // (Older bundles emitted r.heat_ar — fall back to it.)
  log('  parsing BldView');
  const bldRows = await mdbExportRows(camaSupMdb, 'BldView');
  const bldByStrap = new Map();
  for (const r of bldRows) {
    const strap = (r.strap || '').trim();
    if (!strap || bldByStrap.has(strap)) continue;
    bldByStrap.set(strap, {
      heat_ar: r.heated_ar || r.heat_ar || '',
      eff:     r.eff       || '',
      act:     r.act       || '',
    });
  }
  log(`    ${bldByStrap.size.toLocaleString()} building records`);

  // B13: StructElemViewUnit — beds (cd=1) and baths (cd=2) per parcel.
  // SUM across building elements per strap (multi-building parcels contribute
  // multiple rows). cd identifies element type; units holds the count.
  log('  parsing StructElemViewUnit');
  const sevRows = await mdbExportRows(camaSupMdb, 'StructElemViewUnit').catch((e) => {
    log(`    WARN StructElemViewUnit export failed: ${e.message || e}`);
    return [];
  });
  const bedsByStrap  = new Map();
  const bathsByStrap = new Map();
  for (const r of sevRows) {
    const strap = (r.strap || '').trim();
    if (!strap) continue;
    const cd = (r.cd || '').trim();
    const unitsRaw = (r.units || '').trim();
    if (!unitsRaw) continue;
    const n = parseFloat(unitsRaw);
    if (!Number.isFinite(n) || n === 0) continue;
    if (cd === '1') {
      bedsByStrap.set(strap, (bedsByStrap.get(strap) || 0) + n);
    } else if (cd === '2') {
      bathsByStrap.set(strap, (bathsByStrap.get(strap) || 0) + n);
    }
  }
  log(`    ${bedsByStrap.size.toLocaleString()} parcels with beds, ${bathsByStrap.size.toLocaleString()} parcels with baths`);

  // Sales lookup — most recent qualified sale (qu='Q' or non-empty), by strap.
  log('  parsing SalesView');
  const salesRows = await mdbExportRows(camaSupMdb, 'SalesView');
  const salesByStrap = new Map();
  for (const r of salesRows) {
    const strap = (r.strap || '').trim();
    if (!strap) continue;
    const dos = (r.dos || '').trim();
    if (!dos) continue;
    // Parse MM/DD/YY
    const m = dos.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
    if (!m) continue;
    let year = parseInt(m[3], 10);
    if (year < 100) year = year < 50 ? 2000 + year : 1900 + year;
    const month = parseInt(m[1], 10);
    const ts = year * 10000 + month * 100 + parseInt(m[2], 10);
    const qu = (r.qu || '').trim().toUpperCase();
    const qualified = qu === 'Q' || qu === '01' || qu === '1';
    const prev = salesByStrap.get(strap);
    if (!prev || ts > prev.ts) {
      // Prefer qualified if available; only overwrite with unqualified if no prev qualified.
      if (!prev || qualified || !prev.qualified || ts > prev.ts) {
        salesByStrap.set(strap, {
          price: r.price || '',
          month: String(month),
          year:  String(year),
          ts,
          qualified,
        });
      }
    }
  }
  log(`    ${salesByStrap.size.toLocaleString()} sale records`);

  // ParcelView → main table
  log('  parsing ParcelView');
  const parcelRows = await mdbExportRows(camaMdb, 'ParcelView');
  log(`    ${parcelRows.length.toLocaleString()} parcel records`);

  const tsvPath = path.join(TMP, 'stjohns_seed.tsv');
  const out = fs.createWriteStream(tsvPath);
  let total = 0;
  for (const r of parcelRows) {
    const strap = (r.strap || '').trim();
    if (!strap) continue;

    let zipcd = (r.zip || '').trim();
    if (zipcd.includes('-')) zipcd = zipcd.split('-')[0];
    zipcd = zipcd.slice(0, 5);

    const jvRaw  = r.mkt_val || r.jst_val || '';
    const avRaw  = r.soh_val || '';
    const tvRaw  = r.tax_val || '';
    const lndV   = r.tot_lnd_val || '';
    const acreage = (r.acreage || '').trim();
    let lndS = '';
    if (acreage) {
      const a = parseFloat(acreage);
      if (Number.isFinite(a)) lndS = String(a * 43560);
    }

    const bld = bldByStrap.get(strap) || {};
    const sale = salesByStrap.get(strap);
    const bedsV  = bedsByStrap.get(strap);
    const bathsV = bathsByStrap.get(strap);

    const row = [
      esc(strap), '65', 'st_johns',
      esc(r.addr_1 || ''), esc(r.city || ''), esc(zipcd),
      esc(r.name || ''),
      nf(jvRaw), nf(avRaw), nf(tvRaw),
      nf(lndV), nf(lndS), nf(bld.heat_ar || ''),
      ni(bld.eff || ''), ni(bld.act || ''),
      '\\N', '\\N', esc(r.dor_cd || ''),
      sale ? nf(sale.price) : '\\N',
      sale ? ni(sale.year)  : '\\N',
      sale ? ni(sale.month) : '\\N',
      bedsV  !== undefined ? ni(bedsV)  : '\\N',
      bathsV !== undefined ? nf(bathsV) : '\\N',
    ];
    if (!out.write(row.join('\t') + '\n')) {
      await new Promise((res) => out.once('drain', res));
    }
    total++;
  }
  await new Promise((r) => out.end(r));
  const sz = (await fsp.stat(tsvPath)).size;
  log(`  wrote ${tsvPath} ${(sz / 1024 / 1024).toFixed(1)}MB (${total.toLocaleString()} rows)`);

  // Free memory
  bldByStrap.clear(); salesByStrap.clear(); bedsByStrap.clear(); bathsByStrap.clear();
  if (global.gc) global.gc();

  const upsertSql = `
    INSERT INTO property_parcels (
      ${COLS.join(',')}, fetched_at
    )
    SELECT ${COLS.join(',')}, NOW() FROM tmp_sj
    ON CONFLICT (parcel_id) DO UPDATE SET
      own_name=EXCLUDED.own_name,
      jv=EXCLUDED.jv, av_sd=EXCLUDED.av_sd, tv_sd=EXCLUDED.tv_sd,
      lnd_val=EXCLUDED.lnd_val, lnd_sqfoot=EXCLUDED.lnd_sqfoot,
      tot_lvg_ar=EXCLUDED.tot_lvg_ar,
      eff_yr_blt=EXCLUDED.eff_yr_blt, act_yr_blt=EXCLUDED.act_yr_blt,
      phy_addr1=EXCLUDED.phy_addr1, phy_city=EXCLUDED.phy_city, phy_zipcd=EXCLUDED.phy_zipcd,
      sale_prc1=EXCLUDED.sale_prc1, sale_yr1=EXCLUDED.sale_yr1,
      beds=COALESCE(EXCLUDED.beds, property_parcels.beds),
      baths=COALESCE(EXCLUDED.baths, property_parcels.baths),
      fetched_at=NOW()`;
  await copyAndUpsert(pool, tsvPath, 'tmp_sj', upsertSql);

  log('St. Johns seed complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// STEP 3 — Verify
// ─────────────────────────────────────────────────────────────────────────────

async function verify(pool) {
  log('=== STEP 3: VERIFY ===');
  const r = await pool.query(`
    SELECT county_name, COUNT(*)::int AS total, COUNT(beds)::int AS with_beds
    FROM property_parcels
    GROUP BY county_name
    ORDER BY county_name
  `);
  log('property_parcels counts:');
  for (const row of r.rows) {
    log(`  ${row.county_name}: total=${row.total.toLocaleString()} with_beds=${row.with_beds.toLocaleString()}`);
  }
  log('reseed_cron complete');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  log('quarterly property reseed starting');
  const pool = getPool();
  const errors = [];

  for (const [name, fn] of [['duval', seedDuval], ['st_johns', seedStJohns]]) {
    try {
      await fn(pool);
    } catch (err) {
      log(`ERROR in ${name}:`, err && err.stack ? err.stack : err);
      errors.push({ county: name, error: String(err && err.message ? err.message : err) });
    }
  }

  try {
    await verify(pool);
  } catch (err) {
    log('verify failed:', err && err.message ? err.message : err);
  }

  await pool.end().catch(() => {});

  if (errors.length) {
    log('reseed completed with errors:', JSON.stringify(errors));
    process.exit(1);
  }
}

main().catch((err) => {
  log('FATAL:', err && err.stack ? err.stack : err);
  process.exit(1);
});
