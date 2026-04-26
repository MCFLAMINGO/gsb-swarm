'use strict';
/**
 * btrWorker.js — SJC Business Tax Receipt (BTR) Importer
 *
 * Pulls live from St. Johns County Tax Collector (stjohnstax.us).
 * Searches by ZIP code, extracts all active BTR records (name, address,
 * license type, account#), and merges into data/zips/{zip}.json.
 *
 * BTR records are government-verified active businesses — highest confidence
 * source we have (county issued and renewed annually).
 *
 * Strategy:
 *   - Run Python extractor via child_process (handles VIEWSTATE pagination)
 *   - Parse JSON output
 *   - Map BTR license_type → our category schema
 *   - Merge into zip files (adds net-new, enriches existing with btr_verified flag)
 *
 * Schedule: runs on start, then every 24 hours (BTR data is updated quarterly)
 * Writes:   data/zips/{zip}.json (merged in place)
 *           data/btr/raw_{zip}.json (raw BTR records for audit)
 *           data/btr/_index.json (summary of all BTR imports)
 */

const fs            = require('fs');
const path          = require('path');
const { spawn }     = require('child_process');
const express       = require('express');

const DATA_DIR  = path.join(__dirname, '..', 'data');
const ZIPS_DIR  = path.join(DATA_DIR, 'zips');
const BTR_DIR   = path.join(DATA_DIR, 'btr');
const INDEX_FILE = path.join(BTR_DIR, '_index.json');

// SJC ZIPs to pull BTR for — all active SJC coverage
const BTR_ZIPS = [
  { zip: '32081', name: 'Nocatee',              queries: ['32081', 'Nocatee'] },
  { zip: '32082', name: 'Ponte Vedra Beach',     queries: ['32082', 'Ponte Vedra Beach'] },
  { zip: '32092', name: 'World Golf Village',    queries: ['32092', 'Saint Johns'] },
  { zip: '32084', name: 'St. Augustine',         queries: ['32084'] },
  { zip: '32086', name: 'St. Augustine South',   queries: ['32086'] },
  { zip: '32095', name: 'Palm Valley',           queries: ['32095'] },
  { zip: '32259', name: 'Fruit Cove',            queries: ['32259', 'Fruit Cove'] },
  { zip: '32065', name: 'Orange Park',           queries: ['32065', 'Orange Park'] },
  { zip: '32073', name: 'Orange Park',           queries: ['32073'] },
  { zip: '32068', name: 'Middleburg',            queries: ['32068', 'Middleburg'] },
  { zip: '32003', name: 'Fleming Island',        queries: ['32003', 'Fleming Island'] },
];

// ── BTR license_type → our category schema ─────────────────────────────────
function mapLicenseType(licenseType) {
  if (!licenseType) return 'business';
  const lt = licenseType.toLowerCase();

  // Food & drink
  if (lt.includes('restaurant') || lt.includes('dining') || lt.includes('eatery')) return 'restaurant';
  if (lt.includes('fast food') || lt.includes('counter serv') || lt.includes('carry out')) return 'fast_food';
  if (lt.includes('bar') || lt.includes('tavern') || lt.includes('pub') || lt.includes('lounge') || lt.includes('nightclub')) return 'bar';
  if (lt.includes('cafe') || lt.includes('coffee') || lt.includes('bakery') || lt.includes('donut')) return 'cafe';
  if (lt.includes('pizza')) return 'fast_food';
  if (lt.includes('food') || lt.includes('catering') || lt.includes('deli') || lt.includes('sandwich')) return 'restaurant';
  if (lt.includes('ice cream') || lt.includes('yogurt') || lt.includes('dessert')) return 'cafe';
  if (lt.includes('grocery') || lt.includes('supermarket') || lt.includes('market')) return 'supermarket';
  if (lt.includes('liquor') || lt.includes('beer') || lt.includes('wine store')) return 'alcohol';

  // Retail
  if (lt.includes('clothing') || lt.includes('apparel') || lt.includes('boutique') || lt.includes('fashion')) return 'clothes';
  if (lt.includes('shoe') || lt.includes('footwear')) return 'shoes';
  if (lt.includes('jewelry') || lt.includes('jewellery')) return 'jewelry';
  if (lt.includes('furniture') || lt.includes('home furnish')) return 'furniture';
  if (lt.includes('hardware') || lt.includes('building supply') || lt.includes('lumber')) return 'hardware';
  if (lt.includes('electronics') || lt.includes('computer') || lt.includes('tech store')) return 'electronics';
  if (lt.includes('pharmacy') || lt.includes('drug store') || lt.includes('compounding')) return 'pharmacy';
  if (lt.includes('pet') || lt.includes('animal supply') || lt.includes('grooming')) return 'pet';
  if (lt.includes('florist') || lt.includes('flower')) return 'florist';
  if (lt.includes('gift') || lt.includes('souvenir') || lt.includes('novelty')) return 'clothes';
  if (lt.includes('sporting goods') || lt.includes('sports equip')) return 'sports';
  if (lt.includes('book') || lt.includes('stationary') || lt.includes('stationery')) return 'books';
  if (lt.includes('convenience store') || lt.includes('convenience')) return 'convenience';
  if (lt.includes('retail') || lt.includes('store') || lt.includes('shop')) return 'clothes'; // generic retail

  // Health & medical
  if (lt.includes('dentist') || lt.includes('dental') || lt.includes('orthodont')) return 'dentist';
  if (lt.includes('physician') || lt.includes('doctor') || lt.includes('medical office') || lt.includes('family medicine') || lt.includes('internal med')) return 'clinic';
  if (lt.includes('chiropractic') || lt.includes('chiropractor')) return 'clinic';
  if (lt.includes('optometrist') || lt.includes('optician') || lt.includes('eye care') || lt.includes('vision')) return 'optician';
  if (lt.includes('veterinarian') || lt.includes('veterinary') || lt.includes('animal hospital')) return 'veterinary';
  if (lt.includes('physical therapy') || lt.includes('pt ') || lt.includes('rehab')) return 'clinic';
  if (lt.includes('mental health') || lt.includes('psychologist') || lt.includes('counseling') || lt.includes('therapist')) return 'clinic';
  if (lt.includes('spa') || lt.includes('massage') || lt.includes('wellness')) return 'hairdresser';
  if (lt.includes('gym') || lt.includes('fitness') || lt.includes('yoga') || lt.includes('pilates') || lt.includes('crossfit')) return 'gym';
  if (lt.includes('nail') || lt.includes('manicure') || lt.includes('pedicure')) return 'hairdresser';
  if (lt.includes('salon') || lt.includes('barber') || lt.includes('hair') || lt.includes('cosmetol')) return 'hairdresser';
  if (lt.includes('health') || lt.includes('medical') || lt.includes('clinic') || lt.includes('urgent care')) return 'clinic';

  // Finance & professional
  if (lt.includes('bank') || lt.includes('credit union') || lt.includes('savings')) return 'bank';
  if (lt.includes('insurance') || lt.includes('insurer')) return 'insurance';
  if (lt.includes('real estate') || lt.includes('realtor') || lt.includes('realty')) return 'estate_agent';
  if (lt.includes('mortgage') || lt.includes('lending') || lt.includes('loan')) return 'bank';
  if (lt.includes('attorney') || lt.includes('lawyer') || lt.includes('law office') || lt.includes('legal')) return 'financial';
  if (lt.includes('accountant') || lt.includes('accounting') || lt.includes('cpa') || lt.includes('bookkeeping')) return 'financial';
  if (lt.includes('financial') || lt.includes('investment') || lt.includes('wealth')) return 'financial';
  if (lt.includes('tax prep') || lt.includes('tax service')) return 'financial';

  // Services
  if (lt.includes('hotel') || lt.includes('motel') || lt.includes('inn') || lt.includes('resort')) return 'hotel';
  if (lt.includes('auto') || lt.includes('car repair') || lt.includes('mechanic') || lt.includes('oil change') || lt.includes('tire')) return 'car_repair';
  if (lt.includes('car wash') || lt.includes('detailing')) return 'car_wash';
  if (lt.includes('gas') || lt.includes('fuel') || lt.includes('service station')) return 'fuel';
  if (lt.includes('daycare') || lt.includes('child care') || lt.includes('preschool') || lt.includes('after school')) return 'school';
  if (lt.includes('school') || lt.includes('tutoring') || lt.includes('learning center') || lt.includes('academy')) return 'school';
  if (lt.includes('church') || lt.includes('ministry') || lt.includes('religious') || lt.includes('temple') || lt.includes('mosque')) return 'place_of_worship';
  if (lt.includes('contractor') || lt.includes('construction') || lt.includes('builder') || lt.includes('plumb') || lt.includes('electric') || lt.includes('hvac') || lt.includes('roofing') || lt.includes('paint')) return 'office';
  if (lt.includes('landscap') || lt.includes('lawn') || lt.includes('irrigation') || lt.includes('tree service')) return 'office';
  if (lt.includes('cleaning') || lt.includes('janitorial') || lt.includes('maid')) return 'laundry';
  if (lt.includes('dry clean') || lt.includes('laundry') || lt.includes('alterations')) return 'laundry';
  if (lt.includes('moving') || lt.includes('storage') || lt.includes('warehouse')) return 'office';
  if (lt.includes('printing') || lt.includes('sign') || lt.includes('graphics') || lt.includes('marketing')) return 'copyshop';
  if (lt.includes('photography') || lt.includes('video') || lt.includes('studio')) return 'office';

  // Fallback
  return 'office';
}

// ── Python extractor runner ───────────────────────────────────────────────────
// Runs the Python extractor for a specific set of search queries
// Returns parsed records array or empty array on failure

function runPythonExtractor(queries, zipCode) {
  return new Promise((resolve) => {
    const outFile = path.join(BTR_DIR, `_tmp_${zipCode}.json`);

    // Build a minimal inline Python script that reuses extractor logic
    // but writes to our temp file and only searches for these queries
    const pyScript = `
import sys, json, time, re
import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.stjohnstax.us/AccountSearch?s=br"

session = requests.Session()
session.headers.update({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Content-Type": "application/x-www-form-urlencoded",
})

def get_form_fields(soup):
    vs  = soup.find("input", {"id": "__VIEWSTATE"})
    vsg = soup.find("input", {"id": "__VIEWSTATEGENERATOR"})
    ev  = soup.find("input", {"id": "__EVENTVALIDATION"})
    return {
        "__VIEWSTATE":          vs["value"]  if vs  else "",
        "__VIEWSTATEGENERATOR": vsg["value"] if vsg else "",
        "__EVENTVALIDATION":    ev["value"]  if ev  else "",
    }

def parse_records(soup):
    records = []
    for table in soup.find_all("table", id=re.compile(r"BusinessRevenueResults_\\d+")):
        rec = {}
        name_link = table.find("a", href=re.compile(r"BusinessTaxReceiptDetail"))
        if name_link:
            rec["name"] = name_link.get_text(strip=True)
            m = re.search(r"p=(\\d+)&y=(\\d+)&b=(\\d+)", name_link["href"])
            if m:
                rec["_account"] = m.group(1)
                rec["_year"]    = m.group(2)
        for row in table.find_all("tr")[1:]:
            for td in row.find_all("td"):
                td_html = str(td)
                if "Business Address" in td_html:
                    parts = td.get_text(separator="|", strip=True).split("|")
                    collecting, addr_parts = False, []
                    for part in parts:
                        p = part.strip()
                        if p == "Business Address": collecting = True; continue
                        if collecting:
                            if p.startswith("Account:"): break
                            if p: addr_parts.append(p)
                    full_addr = " ".join(addr_parts)
                    zm = re.search(r"\\b(\\d{5}(?:-\\d{4})?)\\b", full_addr)
                    rec["zip"] = zm.group(1) if zm else ""
                    if len(addr_parts) >= 2:
                        city_zip = addr_parts[-1]
                        rec["address"] = " ".join(addr_parts[:-1])
                        rec["city"] = re.sub(r"\\s*\\d{5}(?:-\\d{4})?\\s*$", "", city_zip).strip()
                    elif addr_parts:
                        rec["city"] = re.sub(r"\\s*\\d{5}(?:-\\d{4})?\\s*$", "", addr_parts[0]).strip()
                        rec["address"] = ""
                elif "Occupation" in td_html:
                    parts = td.get_text(separator="|", strip=True).split("|")
                    for i, p in enumerate(parts):
                        if p.strip() == "Occupation" and i+1 < len(parts):
                            rec["license_type"] = parts[i+1].strip()
                elif "Amount Due" in td_html:
                    parts = td.get_text(separator="|", strip=True).split("|")
                    for i, p in enumerate(parts):
                        if p.strip() == "Amount Due" and i+1 < len(parts):
                            rec["amount_due"] = parts[i+1].strip()
        if rec.get("name"):
            records.append(rec)
    return records

def search_query(query):
    try:
        resp0 = session.get(BASE_URL, timeout=30)
        soup0 = BeautifulSoup(resp0.text, "html.parser")
        form0 = get_form_fields(soup0)
        post = {**form0, "__EVENTTARGET": "ctl00$MainContent$btnSearch",
                "__EVENTARGUMENT": "", "ctl00$MainContent$txtSearchCriteria": query}
        resp = session.post(BASE_URL, data=post, timeout=30)
        all_recs, page = [], 1
        current_html = resp.text
        while True:
            soup = BeautifulSoup(current_html, "html.parser")
            recs = parse_records(soup)
            all_recs.extend(recs)
            next_link = None
            for link in soup.find_all("a", href=re.compile(r"__doPostBack")):
                if link.get_text(strip=True).lower() in ["next", ">"]:
                    next_link = link; break
            if not next_link or page > 20: break
            m = re.search(r"__doPostBack\\('([^']+)','([^']*)'\\)", next_link.get("href",""))
            if not m: break
            form2 = get_form_fields(soup)
            post2 = {**form2, "__EVENTTARGET": m.group(1), "__EVENTARGUMENT": m.group(2),
                     "ctl00$MainContent$txtSearchCriteria": query}
            time.sleep(0.3)
            resp2 = session.post(BASE_URL, data=post2, timeout=30)
            current_html = resp2.text
            page += 1
        return all_recs
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        return []

queries = ${JSON.stringify(queries)}
all_recs = []
seen = set()
for q in queries:
    recs = search_query(q)
    for r in recs:
        k = r.get("_account","") or r.get("name","")
        if k and k not in seen:
            seen.add(k)
            all_recs.append(r)
    time.sleep(0.5)

with open(${JSON.stringify(outFile)}, "w") as f:
    json.dump(all_recs, f)
print(f"BTR {${JSON.stringify(zipCode)}}: {len(all_recs)} records", file=sys.stderr)
`;

    const tmpPy = path.join(BTR_DIR, `_run_${zipCode}.py`);
    fs.writeFileSync(tmpPy, pyScript);

    const timeout = setTimeout(() => {
      proc.kill();
      console.warn(`[BTRWorker] Timeout on ${zipCode}`);
      cleanup(tmpPy, outFile);
      resolve([]);
    }, 120_000); // 2 min timeout per ZIP

    const proc = spawn('python3', [tmpPy], { env: process.env });
    proc.stderr.on('data', d => console.log(`[BTR ${zipCode}] ${d.toString().trim()}`));

    proc.on('close', (code) => {
      clearTimeout(timeout);
      cleanup(tmpPy);
      if (code !== 0 || !fs.existsSync(outFile)) {
        console.error(`[BTRWorker] ${zipCode} exited code ${code}`);
        return resolve([]);
      }
      try {
        const records = JSON.parse(fs.readFileSync(outFile, 'utf8'));
        fs.unlinkSync(outFile);
        resolve(Array.isArray(records) ? records : []);
      } catch(e) {
        console.error(`[BTRWorker] Parse error ${zipCode}:`, e.message);
        resolve([]);
      }
    });

    proc.on('error', (e) => {
      clearTimeout(timeout);
      console.error(`[BTRWorker] Spawn error:`, e.message);
      cleanup(tmpPy, outFile);
      resolve([]);
    });
  });
}

function cleanup(...files) {
  for (const f of files) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch(_) {} }
}

// ── Merge BTR records into ZIP file ──────────────────────────────────────────

function mergeIntoZip(zipCode, btrRecords) {
  const filePath = path.join(ZIPS_DIR, `${zipCode}.json`);
  let existing = [];
  if (fs.existsSync(filePath)) {
    try { existing = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch(_) {}
    if (!Array.isArray(existing)) existing = [];
  }

  let added = 0, enriched = 0;
  const now = new Date().toISOString();

  for (const rec of btrRecords) {
    if (!rec.name) continue;

    // Only use records that actually belong to this ZIP
    const recZip = (rec.zip || '').replace(/[^0-9]/g, '').slice(0, 5);
    if (recZip && recZip !== zipCode) continue;

    const nameLower = rec.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    const match = existing.find(b => {
      const bLower = (b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      return bLower === nameLower ||
        (nameLower.length > 4 && (bLower.includes(nameLower) || nameLower.includes(bLower)));
    });

    if (match) {
      let changed = false;
      if (!match.address && rec.address) { match.address = rec.address; changed = true; }
      if (!match.btr_account)            { match.btr_account = rec._account; changed = true; }
      if (changed) {
        match.btr_verified  = true;
        match.confidence    = Math.min(95, (match.confidence || 60) + 12);
        match.last_enriched = now;
        enriched++;
      }
    } else {
      // Net-new business from BTR — government verified
      existing.push({
        name:         rec.name,
        phone:        null,
        website:      null,
        address:      rec.address || null,
        city:         rec.city || null,
        hours:        null,
        category:     mapLicenseType(rec.license_type),
        license_type: rec.license_type || null,
        zip:          zipCode,
        lat:          null,
        lon:          null,
        confidence:   80,        // government record = high base confidence
        source:       'btr',
        btr_verified: true,
        btr_account:  rec._account || null,
        added_at:     now,
        last_enriched: now,
      });
      added++;
    }
  }

  if (added > 0 || enriched > 0) {
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
  }

  return { added, enriched, total: existing.length };
}

// ── Run full BTR import ────────────────────────────────────────────────────────

let btrStatus = { running: false, lastRun: null, stats: {} };

async function runBTR(targetZip = null) {
  if (btrStatus.running) {
    console.log('[BTRWorker] Already running — skipping');
    return;
  }
  btrStatus.running = true;

  [DATA_DIR, ZIPS_DIR, BTR_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  const zips = targetZip
    ? BTR_ZIPS.filter(z => z.zip === targetZip)
    : BTR_ZIPS;

  console.log(`[BTRWorker] Starting — ${zips.length} ZIPs`);
  const index = { generated_at: new Date().toISOString(), zips: {} };

  for (const zipEntry of zips) {
    try {
      console.log(`[BTRWorker] Processing ${zipEntry.zip} (${zipEntry.name})...`);

      const records = await runPythonExtractor(zipEntry.queries, zipEntry.zip);
      console.log(`[BTRWorker] ${zipEntry.zip}: ${records.length} raw BTR records`);

      // Save raw for audit
      const rawFile = path.join(BTR_DIR, `raw_${zipEntry.zip}.json`);
      fs.writeFileSync(rawFile, JSON.stringify(records, null, 2));

      // Merge into zip file
      const stats = mergeIntoZip(zipEntry.zip, records);
      console.log(`[BTRWorker] ${zipEntry.zip}: +${stats.added} new, ${stats.enriched} enriched, ${stats.total} total`);

      index.zips[zipEntry.zip] = {
        name:          zipEntry.name,
        btr_records:   records.length,
        added:         stats.added,
        enriched:      stats.enriched,
        total_in_file: stats.total,
        processed_at:  new Date().toISOString(),
      };
      btrStatus.stats[zipEntry.zip] = index.zips[zipEntry.zip];

    } catch(e) {
      console.error(`[BTRWorker] Error on ${zipEntry.zip}:`, e.message);
      index.zips[zipEntry.zip] = { error: e.message };
    }

    // Polite delay between ZIPs
    await new Promise(r => setTimeout(r, 3000));
  }

  fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  btrStatus.running = false;
  btrStatus.lastRun = new Date().toISOString();
  console.log('[BTRWorker] Done.');
}

// ── Express router ─────────────────────────────────────────────────────────────

const router = express.Router();

router.post('/run', async (req, res) => {
  if (btrStatus.running) return res.json({ status: 'already_running', ...btrStatus });
  const { zip } = req.body || {};
  res.json({ status: 'started', zip: zip || 'all', message: 'BTR import running in background' });
  runBTR(zip || null).catch(e => console.error('[BTRWorker] Run error:', e.message));
});

router.get('/status', (req, res) => res.json(btrStatus));

router.get('/raw/:zip', (req, res) => {
  const zip = req.params.zip.replace(/\D/g, '').slice(0, 5);
  const f = path.join(BTR_DIR, `raw_${zip}.json`);
  if (!fs.existsSync(f)) return res.status(404).json({ error: 'No BTR data for this ZIP yet' });
  res.json(JSON.parse(fs.readFileSync(f, 'utf8')));
});

// ── Schedule: run on start, then every 24h ─────────────────────────────────────

if (require.main === module) {
  // CLI: node btrWorker.js [zip]
  const zipArg = process.argv.find(a => /^\d{5}$/.test(a));
  runBTR(zipArg || null)
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
} else {
  // Forked by dashboard-server — ensure Python deps, then run every 24h
  const { execSync } = require('child_process');
  try {
    execSync('python3 -c "import requests, bs4"', { stdio: 'ignore' });
    console.log('[BTRWorker] Python deps OK');
  } catch (_) {
    console.log('[BTRWorker] Installing Python deps (requests, beautifulsoup4)...');
    try {
      execSync('pip3 install --quiet --break-system-packages requests beautifulsoup4', { stdio: 'inherit' });
      console.log('[BTRWorker] Python deps installed');
    } catch (e) {
      console.error('[BTRWorker] pip install failed — BTR disabled, worker will idle:', e.message);
      // Do NOT exit — just let the worker idle so the server stays up
      return;
    }
  }
  const BTR_INTERVAL = 24 * 60 * 60 * 1000;
  const hb = require('../lib/workerHeartbeat');
  console.log('[BTRWorker] Starting BTR import...');
  if (await hb.isFresh('btrWorker', BTR_INTERVAL)) {
    console.log('[BTRWorker] Fresh — skipping startup run');
  } else {
    await runBTR().catch(e => console.error('[BTRWorker] Initial run error:', e.message));
    await hb.ping('btrWorker');
  }
  setInterval(async () => {
    await runBTR().catch(e => console.error('[BTRWorker] Scheduled run error:', e.message));
    await hb.ping('btrWorker');
  }, BTR_INTERVAL);
}

module.exports = { runBTR, mergeIntoZip, router };
