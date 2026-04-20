'use strict';
/**
 * Data Ingest Worker — GSB Swarm
 *
 * Receives CSV payloads from the Vercel inbox watcher and ingests them
 * into the localIntel.json dataset autonomously.
 *
 * Sources handled:
 *   - FL Sunbiz bulk CSV (DOS_Sunbiz@dos.myflorida.com)
 *   - SJC BTR business licenses (publicrecords@sjctax.us)
 *   - SJC Property Appraiser (info@sjcpa.us)
 *   - Generic CSV with headers it can auto-detect
 *
 * HTTP endpoints (port 3005):
 *   POST /ingest        — receives { source, csv_text, filename, sender }
 *   GET  /ingest/log    — last 50 ingest events
 *   GET  /health
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');

const DATA_PATH  = path.join(__dirname, 'data', 'localIntel.json');
const LOG_PATH   = path.join(__dirname, 'data', 'ingestLog.json');
const PORT       = parseInt(process.env.DATA_INGEST_PORT || '3005');

// ── Known sender → source mapping ────────────────────────────────────────────
const KNOWN_SENDERS = {
  'dos_sunbiz@dos.myflorida.com':    'sunbiz',
  'sunbiz@dos.myflorida.com':        'sunbiz',
  'florida.dos@dos.myflorida.com':   'sunbiz',
  'publicrecords@sjctax.us':         'sjc_btr',
  'info@sjcpa.us':                   'sjc_pao',
  'sjcpa@sjcpa.us':                  'sjc_pao',
};

// ── SJC zip codes we care about (all St Johns County) ────────────────────────
const SJC_ZIPS = new Set([
  '32004','32033','32068','32080','32081','32082',
  '32084','32086','32092','32095','32259'
]);

function log(msg) {
  console.log(`[DataIngest] ${new Date().toISOString().slice(11,19)} ${msg}`);
}

function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

function appendLog(entry) {
  const log = loadJSON(LOG_PATH, []);
  log.unshift({ ...entry, ts: new Date().toISOString() });
  if (log.length > 200) log.splice(200);
  saveJSON(LOG_PATH, log);
}

// ── CSV parser (no deps) ──────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  
  // Parse header
  const headers = parseCSVLine(lines[0]).map(h => h.trim().toLowerCase()
    .replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, ''));
  
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const vals = parseCSVLine(lines[i]);
    const row = {};
    headers.forEach((h, idx) => { row[h] = (vals[idx] || '').trim(); });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current); current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ── Field detectors ───────────────────────────────────────────────────────────
function findField(row, candidates) {
  for (const c of candidates) {
    const key = Object.keys(row).find(k => k.includes(c));
    if (key && row[key]) return row[key];
  }
  return '';
}

function detectZip(row) {
  const raw = findField(row, ['zip', 'postal', 'postcode', 'zipcode']);
  const match = raw.match(/\b(\d{5})\b/);
  return match ? match[1] : '';
}

function detectCategory(row) {
  const type = findField(row, ['type', 'category', 'sic', 'naics', 'business_type',
                                'entity_type', 'use_code', 'dba_type']).toLowerCase();
  
  const catMap = [
    [['restaurant','food service','eating','cafe','coffee','bar','tavern','pub'], 'restaurant'],
    [['fast food','quick service','pizza','sandwich'], 'fast_food'],
    [['grocery','supermarket','food store'], 'supermarket'],
    [['retail','store','shop','boutique','clothing','apparel'], 'retail'],
    [['salon','barber','beauty','spa','nail'], 'hairdresser'],
    [['medical','doctor','physician','health','urgent care','clinic'], 'clinic'],
    [['dental','dentist'], 'dentist'],
    [['gym','fitness','crossfit','yoga','pilates'], 'fitness_centre'],
    [['bank','credit union','financial','mortgage','insurance'], 'bank'],
    [['real estate','realty','realtor'], 'estate_agent'],
    [['school','academy','learning','daycare','childcare'], 'school'],
    [['church','worship','ministry','religious'], 'place_of_worship'],
    [['gas','fuel','service station'], 'fuel'],
    [['contractor','construction','builder','plumber','electrician','hvac'], 'office'],
    [['law','attorney','legal'], 'office'],
    [['hotel','motel','lodging','inn'], 'hotel'],
    [['pharmacy','drug store'], 'chemist'],
  ];
  
  for (const [keywords, cat] of catMap) {
    if (keywords.some(k => type.includes(k))) return cat;
  }
  return 'office';
}

// ── Source-specific normalizers ───────────────────────────────────────────────

function normalizeSunbiz(rows) {
  // Sunbiz fields: entity_name, entity_type, status, principal_address, reg_date etc.
  return rows
    .filter(r => {
      const status = findField(r, ['status','entity_status']).toLowerCase();
      return status.includes('active') || status === 'a';
    })
    .map(r => {
      const name    = findField(r, ['entity_name','name','dba_name','corp_name']);
      const address = findField(r, ['principal_address','address','addr','street']);
      const city    = findField(r, ['principal_city','city']);
      const zip     = detectZip(r) || findField(r, ['zip','postal_code']);
      const phone   = findField(r, ['phone','telephone']);
      const agent   = findField(r, ['registered_agent']);
      
      if (!name || !SJC_ZIPS.has(zip)) return null;
      
      return {
        name: name.trim(),
        category: detectCategory(r),
        zip,
        lat: null, lon: null,
        address: address.trim(),
        city: city.trim() || 'Ponte Vedra Beach',
        phone: phone.trim(),
        website: '',
        hours: '',
        claimed: false,
        sources: ['FL_Sunbiz'],
        notes: agent ? `Registered agent: ${agent}` : '',
      };
    })
    .filter(Boolean);
}

function normalizeBTR(rows) {
  // SJC BTR fields: business_name, address, zip, business_type, receipt_number, owner
  return rows.map(r => {
    const name    = findField(r, ['business_name','name','dba']);
    const address = findField(r, ['business_address','address','location']);
    const zip     = detectZip(r);
    const phone   = findField(r, ['phone','telephone']);
    const owner   = findField(r, ['owner','owner_name']);
    const receipt = findField(r, ['receipt','receipt_number','btr']);
    
    if (!name || !SJC_ZIPS.has(zip)) return null;
    
    return {
      name: name.trim(),
      category: detectCategory(r),
      zip,
      lat: null, lon: null,
      address: address.trim(),
      city: '',
      phone: phone.trim(),
      website: '',
      hours: '',
      claimed: false,
      sources: ['SJC_BTR'],
      notes: [owner ? `Owner: ${owner}` : '', receipt ? `BTR: ${receipt}` : ''].filter(Boolean).join(' | '),
    };
  }).filter(Boolean);
}

function normalizePAO(rows) {
  // SJC PAO fields: parcel_id, owner_name, property_address, zip, use_code, assessed_value
  return rows
    .filter(r => {
      // Only commercial/mixed use parcels
      const useCode = findField(r, ['use_code','property_type','land_use']).toLowerCase();
      return useCode.includes('commercial') || useCode.includes('retail') ||
             useCode.includes('office') || useCode.includes('industrial') ||
             useCode.match(/^[2-9]\d/) || // use codes 20-99 typically commercial
             useCode.includes('restaurant') || useCode.includes('store');
    })
    .map(r => {
      const owner   = findField(r, ['owner_name','owner','taxpayer']);
      const address = findField(r, ['property_address','situs_address','address']);
      const zip     = detectZip(r);
      const parcel  = findField(r, ['parcel_id','parcel','folio']);
      const value   = findField(r, ['assessed_value','just_value','total_value']);
      const sqft    = findField(r, ['building_sqft','sqft','square_feet','bldg_area']);
      
      if (!owner || !SJC_ZIPS.has(zip)) return null;
      
      return {
        name: owner.trim(),
        category: detectCategory(r),
        zip,
        lat: null, lon: null,
        address: address.trim(),
        city: '',
        phone: '',
        website: '',
        hours: '',
        claimed: false,
        sources: ['SJC_PAO'],
        notes: [
          parcel ? `Parcel: ${parcel}` : '',
          value  ? `Assessed: $${parseInt(value).toLocaleString()}` : '',
          sqft   ? `SqFt: ${sqft}` : '',
        ].filter(Boolean).join(' | '),
      };
    }).filter(Boolean);
}

function normalizeGeneric(rows, source) {
  // Best-effort generic normalization for unknown CSV formats
  return rows.map(r => {
    const name    = findField(r, ['name','business_name','entity_name','company','dba']);
    const address = findField(r, ['address','street','location','addr']);
    const zip     = detectZip(r);
    const phone   = findField(r, ['phone','telephone','contact']);
    const website = findField(r, ['website','url','web']);
    
    if (!name) return null;
    if (zip && !SJC_ZIPS.has(zip)) return null; // filter non-SJC if zip present
    
    return {
      name: name.trim(),
      category: detectCategory(r),
      zip: zip || '32082',
      lat: null, lon: null,
      address: address.trim(),
      city: '',
      phone: phone.trim(),
      website: website.trim(),
      hours: '',
      claimed: false,
      sources: [source || 'csv_import'],
    };
  }).filter(Boolean);
}

// ── Confidence scorer ─────────────────────────────────────────────────────────
function scoreConfidence(b) {
  let s = 0;
  if (b.name)    s += 25;
  if (b.address) s += 20;
  if (b.lat && b.lon) s += 20;
  if (b.phone)   s += 10;
  if (b.website) s += 10;
  if (b.hours)   s += 10;
  if (b.claimed) s += 15;
  if ((b.sources||[]).length >= 2) s += 10;
  if ((b.sources||[]).length >= 3) s += 10;
  return Math.min(s, 100);
}

// ── Main ingest function ──────────────────────────────────────────────────────
async function ingest({ source, csv_text, filename, sender }) {
  log(`Ingesting: source=${source} file=${filename} sender=${sender}`);
  
  // Detect source from sender if not provided
  if (!source && sender) {
    source = KNOWN_SENDERS[sender.toLowerCase()] || 'generic';
  }
  source = source || 'generic';
  
  const rows = parseCSV(csv_text);
  log(`Parsed ${rows.length} CSV rows`);
  
  if (!rows.length) {
    return { ok: false, error: 'No rows parsed from CSV', source };
  }

  // Normalize by source
  let normalized;
  switch (source) {
    case 'sunbiz':   normalized = normalizeSunbiz(rows); break;
    case 'sjc_btr':  normalized = normalizeBTR(rows);    break;
    case 'sjc_pao':  normalized = normalizePAO(rows);    break;
    default:         normalized = normalizeGeneric(rows, source);
  }

  log(`Normalized: ${normalized.length} SJC businesses from ${rows.length} rows`);

  // Load existing dataset
  const existing = loadJSON(DATA_PATH, []);
  const existingKeys = new Set(
    existing.map(b => `${b.name.toLowerCase().trim()}|${b.zip}`)
  );

  let added = 0, merged = 0;
  
  for (const record of normalized) {
    record.confidence = scoreConfidence(record);
    const key = `${record.name.toLowerCase().trim()}|${record.zip}`;
    
    const dup = existing.find(b =>
      b.name.toLowerCase().trim() === record.name.toLowerCase().trim() &&
      b.zip === record.zip
    );
    
    if (dup) {
      // Merge — add new source, update fields if empty
      dup.sources = [...new Set([...(dup.sources||[]), ...(record.sources||[])])];
      if (!dup.address && record.address) dup.address = record.address;
      if (!dup.phone   && record.phone)   dup.phone   = record.phone;
      if (!dup.notes)                     dup.notes   = record.notes;
      dup.confidence = scoreConfidence(dup);
      merged++;
    } else {
      record.ingestedAt = new Date().toISOString();
      record.ingestedFrom = source;
      existing.push(record);
      existingKeys.add(key);
      added++;
    }
  }

  // Re-sort: owner_verified first, then by confidence
  existing.sort((a, b) => {
    if (a.claimed && !b.claimed) return -1;
    if (!a.claimed && b.claimed) return 1;
    return b.confidence - a.confidence;
  });

  saveJSON(DATA_PATH, existing);

  const result = {
    ok: true,
    source,
    filename,
    rows_parsed:    rows.length,
    records_normalized: normalized.length,
    added,
    merged,
    total_dataset:  existing.length,
    ts: new Date().toISOString(),
  };

  log(`Done: +${added} added, ${merged} merged → ${existing.length} total`);
  appendLog(result);
  return result;
}

// ── HTTP server ───────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, worker: 'DataIngestWorker', uptime: process.uptime() }));
  }

  if (req.method === 'GET' && req.url === '/ingest/log') {
    const entries = loadJSON(LOG_PATH, []);
    res.writeHead(200);
    return res.end(JSON.stringify({ ok: true, count: entries.length, log: entries.slice(0, 50) }));
  }

  if (req.method === 'POST' && req.url === '/ingest') {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        if (!payload.csv_text) {
          res.writeHead(400);
          return res.end(JSON.stringify({ ok: false, error: 'csv_text required' }));
        }
        const result = await ingest(payload);
        res.writeHead(result.ok ? 200 : 500);
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  log(`DataIngestWorker listening on port ${PORT}`);
});

module.exports = { ingest, parseCSV };
