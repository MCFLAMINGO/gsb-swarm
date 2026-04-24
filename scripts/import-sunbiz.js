#!/usr/bin/env node
/**
 * scripts/import-sunbiz.js
 * Parses FL Sunbiz quarterly cordata.zip → PostgreSQL sunbiz_raw + businesses tables.
 *
 * Sunbiz cordata is a fixed-width ASCII .txt file inside cordata.zip.
 * Field definitions from: https://dos.fl.gov/sunbiz/other-services/data-downloads/
 *
 * Run: LOCAL_INTEL_DB_URL=... node scripts/import-sunbiz.js
 *      or it reads from process.env automatically on Railway.
 */

'use strict';

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const readline = require('readline');
const { execSync } = require('child_process');
const db     = require('../lib/db');

const ZIP_FILE   = path.join(__dirname, '../../sunbiz/cordata.zip');
const EXTRACT_DIR = path.join(__dirname, '../../sunbiz/extracted');
const FL_ZIPS    = new Set(); // populated from flZipRegistry

// ── Sunbiz fixed-width field layout (Corporate filings) ──────────────────────
// From FL DOS Corporate File Definitions doc
// Each record is one line; fields are pipe-delimited in the quarterly export
// Format: CORP_NUM|CORP_NAME|STATUS|FILE_DATE|STATE|FEI_EIN|HOME_STATE|
//         TITLE|FIRST_NAME|MID_NAME|LAST_NAME|SUFFIX|ADDR1|ADDR2|CITY|STATE|ZIP
// (The quarterly cordata uses pipe '|' delimited format, not fixed-width)

function parseRecord(line) {
  // Pipe-delimited: split and map to fields
  const fields = line.split('|');
  if (fields.length < 5) return null;

  // Corp quarterly format has variable columns — extract what we can
  const [
    docNumber,      // 0 - Document number (e.g. P21000012345)
    corpName,       // 1 - Entity name
    status,         // 2 - ACTIVE | INACTIVE | etc.
    filedDate,      // 3 - Filing date YYYYMMDD
    stateOfFormation, // 4 - State
    feiEin,         // 5 - FEI/EIN
    homeState,      // 6 - Home state
    // Officers follow in groups of fields
    ...rest
  ] = fields;

  if (!docNumber || !corpName) return null;

  return {
    doc_number:        docNumber.trim(),
    entity_name:       corpName.trim(),
    status:            status?.trim() || 'UNKNOWN',
    filed_date:        parseDate(filedDate?.trim()),
    state_of_formation: stateOfFormation?.trim(),
    fei_ein:           feiEin?.trim(),
    // Address fields come from officer/RA records — parsed separately
    principal_address: null,
    principal_city:    null,
    principal_state:   null,
    principal_zip:     null,
    registered_agent:  null,
  };
}

function parseDate(s) {
  if (!s || s.length < 8) return null;
  try {
    const y = s.slice(0,4), m = s.slice(4,6), d = s.slice(6,8);
    const dt = new Date(`${y}-${m}-${d}`);
    return isNaN(dt) ? null : dt.toISOString().slice(0,10);
  } catch { return null; }
}

// Category inference from entity name keywords
const NAME_CATEGORY_MAP = [
  { patterns: [/restaurant|grill|cafe|coffee|pizza|sushi|burger|taco|diner|bistro|eatery|bakery|deli|bbq|seafood/i], category: 'restaurant', group: 'food' },
  { patterns: [/dental|dentist/i],        category: 'dentist',   group: 'health' },
  { patterns: [/medical|clinic|health|urgent care|therapy|chiro|optom|pharma/i], category: 'clinic', group: 'health' },
  { patterns: [/law|legal|attorney|counsel/i], category: 'legal', group: 'legal' },
  { patterns: [/realt|proper|homes|invest|mortgage|title/i], category: 'real_estate', group: 'finance' },
  { patterns: [/bank|financial|insurance|capital|wealth|advisor/i], category: 'finance', group: 'finance' },
  { patterns: [/salon|spa|beauty|barber/i], category: 'salon', group: 'retail' },
  { patterns: [/gym|fitness|yoga|crossfit/i], category: 'gym', group: 'retail' },
  { patterns: [/school|academy|tutor|learning/i], category: 'school', group: 'civic' },
  { patterns: [/church|ministry|chapel/i], category: 'church', group: 'civic' },
];

function inferCategory(name) {
  for (const rule of NAME_CATEGORY_MAP) {
    if (rule.patterns.some(p => p.test(name))) {
      return { category: rule.category, group: rule.group };
    }
  }
  return { category: 'LocalBusiness', group: 'services' };
}

async function run() {
  if (!db.isReady()) {
    console.error('[sunbiz] LOCAL_INTEL_DB_URL not set');
    process.exit(1);
  }

  console.log('[sunbiz] Connected to PostgreSQL');

  // Check zip file exists
  if (!fs.existsSync(ZIP_FILE)) {
    console.error(`[sunbiz] cordata.zip not found at ${ZIP_FILE}`);
    console.error('  Download is still in progress — check /home/user/workspace/sunbiz/');
    process.exit(1);
  }

  const sizeMB = fs.statSync(ZIP_FILE).size / 1024 / 1024;
  console.log(`[sunbiz] cordata.zip: ${sizeMB.toFixed(0)} MB`);

  if (sizeMB < 100) {
    console.error('[sunbiz] File too small — download may still be in progress');
    process.exit(1);
  }

  // Extract zip
  console.log('[sunbiz] Extracting...');
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });
  execSync(`unzip -o "${ZIP_FILE}" -d "${EXTRACT_DIR}"`, { stdio: 'pipe' });

  const txtFiles = fs.readdirSync(EXTRACT_DIR).filter(f => f.endsWith('.txt'));
  console.log(`[sunbiz] Found files: ${txtFiles.join(', ')}`);

  if (txtFiles.length === 0) {
    console.error('[sunbiz] No .txt files found in zip');
    process.exit(1);
  }

  // Load FL registry ZIPs for filtering
  try {
    const { getAllZips } = require('../workers/flZipRegistry');
    getAllZips().forEach(z => FL_ZIPS.add(z.zip));
    console.log(`[sunbiz] FL ZIP registry: ${FL_ZIPS.size} ZIPs loaded`);
  } catch (e) {
    console.warn('[sunbiz] Could not load FL ZIP registry — importing all records');
  }

  let total = 0, inserted = 0, skipped = 0, errors = 0;
  const BATCH_SIZE = 500;
  let batch = [];

  async function flushBatch() {
    if (batch.length === 0) return;

    // Build bulk insert for sunbiz_raw
    const values = [];
    const params = [];
    let pIdx = 1;

    for (const rec of batch) {
      values.push(`($${pIdx},$${pIdx+1},$${pIdx+2},$${pIdx+3},$${pIdx+4},$${pIdx+5},$${pIdx+6},$${pIdx+7},$${pIdx+8})`);
      params.push(
        rec.doc_number, rec.entity_name, rec.status,
        rec.filed_date, rec.state_of_formation,
        rec.principal_address, rec.principal_city,
        rec.principal_state, rec.principal_zip
      );
      pIdx += 9;
    }

    try {
      await db.query(
        `INSERT INTO sunbiz_raw
          (doc_number, entity_name, status, filed_date, principal_state,
           principal_address, principal_city, principal_state, principal_zip)
         VALUES ${values.join(',')}
         ON CONFLICT (doc_number) DO UPDATE SET
           status = EXCLUDED.status,
           imported_at = NOW()`,
        params
      );
      inserted += batch.length;
    } catch (e) {
      // Fall back to individual inserts on batch error
      for (const rec of batch) {
        try {
          await db.query(
            `INSERT INTO sunbiz_raw
              (doc_number, entity_name, status, filed_date,
               principal_address, principal_city, principal_state, principal_zip)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (doc_number) DO UPDATE SET status = $3`,
            [rec.doc_number, rec.entity_name, rec.status, rec.filed_date,
             rec.principal_address, rec.principal_city, rec.principal_state, rec.principal_zip]
          );
          inserted++;
        } catch { errors++; }
      }
    }
    batch = [];
  }

  // Process each txt file
  for (const txtFile of txtFiles) {
    const filePath = path.join(EXTRACT_DIR, txtFile);
    console.log(`[sunbiz] Processing ${txtFile}...`);

    const rl = readline.createInterface({
      input: fs.createReadStream(filePath, { encoding: 'latin1' }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim() || line.startsWith('#')) continue;
      total++;

      const rec = parseRecord(line);
      if (!rec) { skipped++; continue; }

      // Skip inactive if we want only active — include all for now
      // Only skip non-FL entities if we have ZIP data
      // (many Sunbiz records lack ZIP — include all for now, resolve later)
      batch.push(rec);

      if (batch.length >= BATCH_SIZE) {
        await flushBatch();
        if (total % 50000 === 0) {
          process.stdout.write(`\r[sunbiz] ${total.toLocaleString()} processed, ${inserted.toLocaleString()} inserted, ${errors} errors`);
        }
      }
    }

    await flushBatch();
    console.log(`\n[sunbiz] ${txtFile} done — ${total.toLocaleString()} records`);
  }

  // Final counts
  const rawCount = await db.queryOne('SELECT COUNT(*) FROM sunbiz_raw');
  console.log('\n[sunbiz] ✓ Import complete');
  console.log(`  Total lines:     ${total.toLocaleString()}`);
  console.log(`  Inserted:        ${inserted.toLocaleString()}`);
  console.log(`  Skipped:         ${skipped.toLocaleString()}`);
  console.log(`  Errors:          ${errors}`);
  console.log(`  sunbiz_raw rows: ${rawCount?.count}`);

  process.exit(0);
}

run().catch(e => { console.error('[sunbiz] Fatal:', e); process.exit(1); });
