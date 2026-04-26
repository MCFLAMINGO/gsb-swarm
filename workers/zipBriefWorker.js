'use strict';
/**
 * zipBriefWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Builds deterministic market intelligence briefs for every enriched ZIP.
 * Zero API calls. Zero cost. Pure math from the data we already have.
 *
 * Output: data/briefs/{zip}.json — one file per ZIP, structured summary:
 *   - Market narrative (plain English, LLM-ready)
 *   - Business count by group + top categories
 *   - Market gaps (categories present at state level, absent locally)
 *   - Data quality grade
 *   - Notable / anchor businesses
 *   - Signals (density scores, saturation, opportunity flags)
 *
 * When an LLM calls local_intel_ask("tell me about 32082") it reads this brief
 * instead of scanning 557 raw records. Answer quality goes from a list to a story.
 *
 * Cycle: runs once at startup, then every 4 hours (after enrichment runs).
 * Rebuilt when the zip file is newer than the brief.
 */

const fs   = require('fs');
const path = require('path');

const BASE_DIR    = path.join(__dirname, '..');
const ZIPS_DIR    = path.join(BASE_DIR, 'data', 'zips');
const BRIEFS_DIR  = path.join(BASE_DIR, 'data', 'briefs');
const OSM_DIR     = path.join(BASE_DIR, 'data', 'osm');

const { validateAll, getFailedZips } = require('./briefValidator');

const CYCLE_MS   = 4 * 60 * 60 * 1000; // 4 hours
const STAGGER_MS = 3 * 60 * 1000;       // 3 min after startup

// ── Category → group mapping (mirrors localIntelMCP.js CAT_GROUPS) ────────────
const CAT_GROUPS = {
  food:     ['restaurant','fast_food','cafe','bar','pub','ice_cream','alcohol'],
  retail:   ['supermarket','convenience','clothes','hairdresser','beauty','chemist',
             'mobile_phone','copyshop','dry_cleaning','nutrition_supplements'],
  health:   ['dentist','clinic','hospital','doctor','veterinary','fitness_centre',
             'sports_centre','swimming_pool','pharmacy','optician','physiotherapist'],
  finance:  ['bank','atm','estate_agent','insurance','accountant'],
  civic:    ['school','place_of_worship','church','library','post_office',
             'police','fire_station','community_centre','social_centre'],
  services: ['fuel','car_wash','car_repair','hotel','office','coworking',
             'contractor','plumber','electrician','hvac'],
  legal:    ['legal','attorney','notary'],
};

function getGroup(cat) {
  if (!cat) return 'other';
  const c = cat.toLowerCase();
  for (const [g, cats] of Object.entries(CAT_GROUPS)) {
    if (cats.includes(c)) return g;
  }
  // Fuzzy fallback for generic YP categories
  if (/restaurant|dining|cafe|food|eatery|diner|pizza|sushi|bbq|seafood/i.test(c)) return 'food';
  if (/clinic|dental|doctor|physician|health|therapy|pharmacy|medical/i.test(c)) return 'health';
  if (/retail|store|shop|boutique|apparel|fashion|grocery/i.test(c)) return 'retail';
  if (/bank|finance|insurance|accountant|invest/i.test(c)) return 'finance';
  if (/legal|attorney|lawyer|law/i.test(c)) return 'legal';
  if (/contractor|builder|plumb|electr|hvac|roofi|construct/i.test(c)) return 'services';
  if (/school|church|worship|civic|librar/i.test(c)) return 'civic';
  return 'other';
}

// ── ZIP label map ─────────────────────────────────────────────────────────────
const ZIP_LABELS = {
  '32082': 'Ponte Vedra Beach', '32081': 'Nocatee', '32084': 'St. Augustine',
  '32086': 'St. Augustine South', '32092': 'World Golf Village', '32080': 'St. Augustine Beach',
  '32095': 'Palm Valley', '32259': 'Fruit Cove / Saint Johns', '32250': 'Jacksonville Beach',
  '32266': 'Neptune Beach', '32233': 'Atlantic Beach', '32034': 'Fernandina Beach',
  '32097': 'Yulee', '32073': 'Orange Park', '32003': 'Fleming Island',
  '32256': 'Baymeadows', '32257': 'Mandarin', '32216': 'Southside Jacksonville',
  '32217': 'San Jose', '32207': 'Jacksonville Southbank', '32225': 'Arlington',
  '32246': 'Regency', '32258': 'Bartram Park', '32224': 'Southside',
};

// ── Saturation thresholds (businesses per 10k residents, estimated) ────────────
// Based on national averages for suburban Florida markets
const SATURATION = {
  food:     { saturated: 40, healthy: 20, sparse: 8 },
  health:   { saturated: 30, healthy: 15, sparse: 5 },
  retail:   { saturated: 50, healthy: 25, sparse: 10 },
  finance:  { saturated: 20, healthy: 10, sparse: 3 },
  services: { saturated: 40, healthy: 20, sparse: 8 },
  legal:    { saturated: 25, healthy: 12, sparse: 4 },
};

// Estimated population per ZIP (rough — will be replaced by census layer when available)
const POP_ESTIMATES = {
  '32082': 22000, '32081': 35000, '32084': 28000, '32086': 32000,
  '32092': 30000, '32080': 8000,  '32095': 12000, '32259': 45000,
  '32250': 22000, '32266': 8000,  '32233': 13000, '32034': 16000,
  '32097': 18000, '32073': 32000, '32003': 28000, '32256': 38000,
  '32257': 42000, '32216': 35000, '32217': 28000, '32207': 18000,
  '32225': 45000, '32246': 52000, '32258': 38000, '32224': 35000,
};

// ── Brief builder ─────────────────────────────────────────────────────────────
function buildBrief(zip, businesses) {
  const label   = ZIP_LABELS[zip] || `ZIP ${zip}`;
  const pop     = POP_ESTIMATES[zip] || 25000;
  const total   = businesses.length;

  if (total === 0) {
    return {
      zip, label, total: 0,
      narrative: `No business data available for ${label} (${zip}) yet.`,
      generated_at: new Date().toISOString(),
      data_grade: 'F',
    };
  }

  // ── Group counts ──────────────────────────────────────────────────────────
  const byCat   = {};
  const byGroup = {};
  const anchors = []; // high-confidence, claimed, or well-known businesses

  for (const b of businesses) {
    const cat = (b.category || 'other').toLowerCase();
    const grp = getGroup(cat);
    byCat[cat]   = (byCat[cat]   || 0) + 1;
    byGroup[grp] = (byGroup[grp] || 0) + 1;
    if ((b.confidence || 0) >= 90 || b.claimed) anchors.push(b);
  }

  // Top categories sorted by count
  const topCats = Object.entries(byCat)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([cat, count]) => ({ cat, count }));

  // ── Quality metrics ───────────────────────────────────────────────────────
  const avgConf     = Math.round(businesses.reduce((s, b) => s + (b.confidence || 0), 0) / total);
  const withPhone   = businesses.filter(b => b.phone).length;
  const withHours   = businesses.filter(b => b.hours).length;
  const withCoords  = businesses.filter(b => b.lat && b.lon).length;
  const claimed     = businesses.filter(b => b.claimed).length;
  const maybeClosed = businesses.filter(b => b.possibly_closed).length;

  const coveragePct = Math.round((withPhone / total) * 100);
  const dataGrade   = avgConf >= 80 && coveragePct >= 80 ? 'A'
                    : avgConf >= 70 && coveragePct >= 60 ? 'B'
                    : avgConf >= 60 ? 'C' : 'D';

  // ── Saturation signals ────────────────────────────────────────────────────
  const per10k = (count) => Math.round((count / pop) * 10000);
  const signals = [];
  const gaps    = [];

  for (const [grp, sat] of Object.entries(SATURATION)) {
    const count = byGroup[grp] || 0;
    const density = per10k(count);
    if (density >= sat.saturated) {
      signals.push({ type: 'saturated', group: grp, count, density, per10k: density });
    } else if (density <= sat.sparse && count > 0) {
      gaps.push({ type: 'gap', group: grp, count, density, signal: `Only ${count} ${grp} businesses for ${pop.toLocaleString()} residents — potential opportunity` });
    } else if (count === 0) {
      gaps.push({ type: 'absent', group: grp, count: 0, density: 0, signal: `No ${grp} businesses mapped yet — may be missing data or genuine gap` });
    }
  }

  // ── Notable businesses (anchors) ──────────────────────────────────────────
  const notables = anchors
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, 5)
    .map(b => ({ name: b.name, category: b.category, address: b.address, phone: b.phone, claimed: !!b.claimed }));

  // ── Plain-English narrative ───────────────────────────────────────────────
  const dominantGroup = Object.entries(byGroup).sort((a, b) => b[1] - a[1])[0];
  const topCatName    = topCats[0]?.cat || 'mixed';
  const satList       = signals.map(s => s.group).join(', ') || 'none identified';
  const gapList       = gaps.filter(g => g.type === 'gap').map(g => g.group).join(', ') || 'none identified';

  const narrative = [
    `${label} (${zip}) has ${total.toLocaleString()} mapped businesses across ${Object.keys(byGroup).length} market segments.`,
    dominantGroup
      ? `The dominant segment is ${dominantGroup[0]} with ${dominantGroup[1]} businesses (${Math.round(dominantGroup[1]/total*100)}% of the market).`
      : '',
    topCats.length > 1
      ? `Top categories: ${topCats.slice(0,4).map(c => `${c.cat} (${c.count})`).join(', ')}.`
      : '',
    signals.length > 0
      ? `Saturation signals: ${satList} — these segments are well-covered relative to population.`
      : 'No segments appear oversaturated relative to population.',
    gaps.filter(g => g.type === 'gap').length > 0
      ? `Opportunity gaps: ${gapList} — undersupplied relative to estimated population of ${pop.toLocaleString()}.`
      : '',
    maybeClosed > 0
      ? `${maybeClosed} businesses flagged as possibly closed — re-verification queued.`
      : '',
    `Data quality: grade ${dataGrade} — avg confidence ${avgConf}%, ${coveragePct}% have phone numbers, ${Math.round(withHours/total*100)}% have hours.`,
  ].filter(Boolean).join(' ');

  return {
    zip,
    label,
    total,
    population_estimate: pop,
    by_group:   byGroup,
    by_category: topCats,
    avg_confidence:  avgConf,
    data_grade:      dataGrade,
    coverage: {
      with_phone:  withPhone,
      with_hours:  withHours,
      with_coords: withCoords,
      claimed,
      possibly_closed: maybeClosed,
      phone_pct:   coveragePct,
    },
    saturation_signals: signals,
    gaps,
    notable_businesses: notables,
    narrative,
    generated_at: new Date().toISOString(),
    source: 'zipBriefWorker_deterministic',
  };
}

// ── File helpers ──────────────────────────────────────────────────────────────
function briefPath(zip) {
  return path.join(BRIEFS_DIR, `${zip}.json`);
}

async function needsRebuild(zip) {
  // Check Postgres first: if no brief row exists, always rebuild
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getZipBrief } = require('../lib/pgStore');
      const existing = await getZipBrief(zip);
      // If no brief in Postgres, rebuild
      if (!existing) return true;
      // If brief exists but is older than 4 hours, rebuild
      const age = Date.now() - new Date(existing._stored_at || 0).getTime();
      return age > 4 * 60 * 60 * 1000;
    } catch (_) {}
  }
  // Flat-file fallback (local dev without DB)
  const zipFile   = path.join(ZIPS_DIR, `${zip}.json`);
  const briefFile = briefPath(zip);
  if (!fs.existsSync(briefFile)) return true;
  try {
    const zipMtime   = fs.statSync(zipFile).mtimeMs;
    const briefMtime = fs.statSync(briefFile).mtimeMs;
    return zipMtime > briefMtime;
  } catch { return true; }
}

// ── Run one pass — build/rebuild all stale briefs ─────────────────────────────
async function runBriefPass() {
  fs.mkdirSync(BRIEFS_DIR, { recursive: true });

  // ZIP discovery: Postgres first, flat file fallback
  let allZips = [];
  let usePostgres = false;
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      allZips = await getDistinctZips();
      if (allZips.length > 0) {
        usePostgres = true;
        console.log(`[zip-brief] ZIP discovery: ${allZips.length} ZIPs from Postgres`);
      }
    } catch (e) {
      console.warn('[zip-brief] Postgres ZIP discovery failed, falling back:', e.message);
    }
  }
  if (!usePostgres) {
    if (!fs.existsSync(ZIPS_DIR)) {
      console.log('[zip-brief] data/zips/ not found — skipping');
      return;
    }
    allZips = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
  }
  let built = 0, skipped = 0, errors = 0;

  console.log(`[zip-brief] Checking ${allZips.length} ZIPs for stale briefs`);

  for (const zip of allZips) {
    if (!(await needsRebuild(zip))) { skipped++; continue; }

    try {
      let businesses;
      if (usePostgres) {
        const { getBusinessesByZip } = require('../lib/pgStore');
        businesses = await getBusinessesByZip(zip);
      } else {
        businesses = JSON.parse(fs.readFileSync(path.join(ZIPS_DIR, `${zip}.json`), 'utf8'));
      }
      if (!Array.isArray(businesses)) { errors++; continue; }

      const brief = buildBrief(zip, businesses);
      fs.writeFileSync(briefPath(zip), JSON.stringify(brief, null, 2));
      // Mirror to Postgres so briefValidator + any agent can read without flat files
      if (process.env.LOCAL_INTEL_DB_URL) {
        try {
          const { upsertZipBrief } = require('../lib/pgStore');
          await upsertZipBrief(zip, brief);
        } catch (pgErr) {
          console.warn(`[zip-brief] Postgres brief write failed for ${zip}:`, pgErr.message);
        }
      }
      built++;

      if (built % 20 === 0) {
        console.log(`[zip-brief] Built ${built}/${allZips.length} briefs`);
      }
    } catch (err) {
      console.warn(`[zip-brief] Error building brief for ${zip}:`, err.message);
      errors++;
    }

    // Small yield to avoid blocking the event loop
    if (built % 10 === 0) await new Promise(r => setImmediate(r));
  }

  console.log(`[zip-brief] Pass complete — built:${built} skipped:${skipped} errors:${errors}`);
  return { built, skipped, errors, total: allZips.length };
}

// ── Daemon ────────────────────────────────────────────────────────────────────
(async function main() {
  console.log('[zip-brief] ZIP brief worker started — builds deterministic market summaries');
  await new Promise(r => setTimeout(r, STAGGER_MS));

  while (true) {
    try {
      // Build/rebuild all stale briefs
      const passResult = await runBriefPass();

      // Validate every built brief — flag failures before next cycle
      if (passResult && passResult.built > 0) {
        console.log('[zip-brief] Running validation pass on all briefs');
        const report = await validateAll();
        if (report) {
          const failedZips = report.failed_zips || [];
          if (failedZips.length > 0) {
            console.warn(`[zip-brief] ${failedZips.length} briefs failed validation: ${failedZips.join(', ')}`)
            console.warn('[zip-brief] These ZIPs will be force-rebuilt next cycle');
            // Touch the zip files to force rebuild on next pass
            failedZips.forEach(zip => {
              try {
                const zipFile = path.join(ZIPS_DIR, `${zip}.json`);
                if (fs.existsSync(zipFile)) {
                  const now = new Date();
                  fs.utimesSync(zipFile, now, now);
                }
              } catch (_) {}
            });
          } else {
            console.log(`[zip-brief] All ${report.total_checked} briefs passed validation ✓`);
          }
        }
      }
    } catch (err) {
      console.error('[zip-brief] Pass error:', err.message);
    }
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
})();
