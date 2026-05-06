/**
 * refreshOracleSectors.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Worker: refresh oracle_json.market_intelligence.sector_breakdown for every
 * ZIP in zip_intelligence using live business counts from Postgres.
 *
 * Safe to re-run at any time. Only patches sector_breakdown + total_businesses
 * inside the existing oracle_json blob — leaves all other oracle fields intact.
 *
 * Also seeds market_maturity for known ZIP classifications.
 *
 * Run standalone: node workers/refreshOracleSectors.js
 * Called by oracleWorker after each cycle: require('./refreshOracleSectors').run({ silent: true })
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const db = require('../lib/db');

const SECTORS = ['food','health','retail','construction','automotive',
                 'finance','fitness','hospitality','legal','civic','services',
                 'real_estate','education','beauty','community','pets','fuel','grocery'];

// ── Market maturity seed map ───────────────────────────────────────────────
// growth      = active build-out, greenfield demand, low commercial saturation
// established = typical suburban market, moderate vacancy, standard benchmarks
// mature      = built-out, low commercial vacancy, structural space constraints
//
// Add new ZIPs here as we expand. Unseeded ZIPs default to 'established' in code.
const MATURITY_SEED = {
  // Northeast FL
  '32082': 'mature',      // Ponte Vedra Beach — built-out coastal, low vacancy
  '32081': 'growth',      // Nocatee — active master-planned build-out
  '32003': 'growth',      // Fleming Island — growing suburban
  '32250': 'established', // Jacksonville Beach — coastal established
  '32084': 'established', // St Augustine — historic, mixed
  '32086': 'established', // St Augustine South
  '32073': 'established', // Orange Park
  '32216': 'established', // Southside Jacksonville
  '32207': 'established', // San Marco Jacksonville
  '32224': 'established', // Jacksonville Beach adjacent
  '32256': 'established', // Deerwood/Southside
  '32246': 'established', // Arlington Jacksonville
  '32204': 'established', // Riverside Jacksonville
  '32202': 'established', // Downtown Jacksonville

  // South FL — Miami / Miami Beach (tourist-dense, mature)
  '33132': 'mature',      // Brickell/Downtown Miami
  '33139': 'mature',      // South Beach
  '33140': 'mature',      // Mid-Beach
  '33141': 'mature',      // North Beach
  '33128': 'mature',      // Overtown/Wynwood
  '33127': 'mature',      // Little Haiti/Wynwood
  '33109': 'mature',      // Fisher Island
  '33431': 'established', // Boca Raton
  '33458': 'established', // Jupiter
  '33629': 'mature',      // South Tampa

  // Central FL
  '34711': 'established', // Clermont
  '32819': 'established', // Orlando/Dr Phillips
};

async function run({ silent = false } = {}) {
  const log = silent ? () => {} : console.log;

  log('[refreshOracleSectors] Starting…');

  // Step 1: Get all business counts per ZIP and sector in one query
  log('[refreshOracleSectors] Loading sector counts from businesses table…');
  const countRows = await db.query(`
    SELECT zip, category_group, COUNT(*) as cnt
    FROM businesses
    WHERE status != 'inactive' AND zip IS NOT NULL AND zip != ''
    GROUP BY zip, category_group
  `);

  // Build map: zip → { sector: count }
  const zipSectors = {};
  for (const r of countRows) {
    if (!zipSectors[r.zip]) zipSectors[r.zip] = {};
    zipSectors[r.zip][r.category_group] = parseInt(r.cnt);
  }
  log(`[refreshOracleSectors] Sector counts for ${Object.keys(zipSectors).length} ZIPs`);

  // Step 2: Load all zip_intelligence rows that have oracle_json
  const ziRows = await db.query(
    `SELECT zip, oracle_json FROM zip_intelligence WHERE oracle_json IS NOT NULL`
  );
  log(`[refreshOracleSectors] ${ziRows.length} ZIPs with oracle_json`);

  // Step 3: Seed market_maturity (only updates rows where value differs)
  for (const [zip, maturity] of Object.entries(MATURITY_SEED)) {
    await db.query(`
      UPDATE zip_intelligence SET market_maturity = $1
      WHERE zip = $2 AND (market_maturity IS NULL OR market_maturity != $1)
    `, [maturity, zip]);
  }
  log(`[refreshOracleSectors] market_maturity seeded for ${Object.keys(MATURITY_SEED).length} known ZIPs`);

  // Step 4: Bulk-patch oracle_json for each ZIP
  let updated = 0, skipped = 0;
  for (const row of ziRows) {
    const zip   = row.zip;
    const sectors = zipSectors[zip] || {};

    const freshBreakdown = {};
    for (const s of SECTORS) freshBreakdown[s] = sectors[s] || 0;
    const totalBiz = Object.values(sectors).reduce((a, b) => a + b, 0);

    const oracle = row.oracle_json;
    if (!oracle.market_intelligence) { skipped++; continue; }

    oracle.market_intelligence.sector_breakdown = freshBreakdown;
    oracle.market_intelligence.total_businesses = totalBiz;

    await db.query(
      `UPDATE zip_intelligence SET oracle_json = $1, updated_at = NOW() WHERE zip = $2`,
      [JSON.stringify(oracle), zip]
    );
    updated++;
    if (!silent && updated % 50 === 0) process.stdout.write(`\r[refreshOracleSectors] ${updated}/${ziRows.length}…`);
  }

  log(`\n[refreshOracleSectors] Done — ${updated} updated, ${skipped} skipped`);
}

// Standalone execution
if (require.main === module) {
  run({ silent: false })
    .then(() => process.exit(0))
    .catch(e => { console.error('[refreshOracleSectors] FATAL:', e.message); process.exit(1); });
}

module.exports = { run };
