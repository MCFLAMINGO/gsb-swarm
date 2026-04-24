#!/usr/bin/env node
/**
 * scripts/migrate-json-to-pg.js
 * Migrates existing flat JSON zip files → PostgreSQL businesses table.
 * Run once after schema is deployed: node scripts/migrate-json-to-pg.js
 *
 * Reads from: data/zips/*.json + data/oracle/*.json
 * Writes to:  businesses, source_evidence, zip_intelligence tables
 */

'use strict';

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const db   = require('../lib/db');

const ZIPS_DIR   = path.join(__dirname, '../data/zips');
const ORACLE_DIR = path.join(__dirname, '../data/oracle');

// Category → group mapping (mirrors localIntelAgent.js)
const GROUP_MAP = {
  restaurant: 'food', fast_food: 'food', cafe: 'food', bar: 'food',
  pub: 'food', ice_cream: 'food', food_court: 'food',
  doctor: 'health', dentist: 'health', clinic: 'health',
  hospital: 'health', pharmacy: 'health', optometrist: 'health',
  chiropractor: 'health', physical_therapy: 'health',
  bank: 'finance', insurance: 'finance', finance: 'finance',
  investment: 'finance', mortgage: 'finance', accounting: 'finance',
  legal: 'legal', attorney: 'legal', law_firm: 'legal',
  retail: 'retail', boutique: 'retail', salon: 'retail',
  spa: 'retail', gym: 'retail', fitness: 'retail',
  school: 'civic', church: 'civic', government: 'civic', library: 'civic',
};

function getGroup(cat) {
  if (!cat) return 'services';
  const c = cat.toLowerCase().replace(/[^a-z_]/g, '_');
  return GROUP_MAP[c] || 'services';
}

// Confidence weights by source
const SOURCE_WEIGHTS = {
  yellowpages:  0.25,
  osm:          0.20,
  sunbiz:       0.30,
  sjc_btr:      0.25,
  manual:       0.35,
};

async function run() {
  if (!db.isReady()) {
    console.error('LOCAL_INTEL_DB_URL not set. Add it to Railway env vars first.');
    process.exit(1);
  }

  console.log('[migrate] Connected to PostgreSQL');

  // 1. Run schema if tables don't exist yet
  const schemaSQL = fs.readFileSync(path.join(__dirname, '../db/schema.sql'), 'utf8');
  try {
    await db.query(schemaSQL);
    console.log('[migrate] Schema applied');
  } catch (e) {
    // Likely already exists — continue
    console.log('[migrate] Schema already applied:', e.message.slice(0, 80));
  }

  // 2. Migrate zip JSON files
  const zipFiles = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json'));
  console.log(`[migrate] Found ${zipFiles.length} ZIP files`);

  let created = 0, merged = 0, errors = 0;

  for (const file of zipFiles) {
    const zip = file.replace('.json', '');
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(ZIPS_DIR, file), 'utf8'));
    } catch { continue; }

    const businesses = Array.isArray(data) ? data : (data.businesses || data.results || []);

    for (const biz of businesses) {
      try {
        const source = biz.source || biz.yp_source ? 'yellowpages' : 'osm';
        const weight = SOURCE_WEIGHTS[source] || 0.20;

        const result = await db.upsertBusiness({
          name:             biz.name,
          zip:              biz.zip || zip,
          address:          biz.address,
          phone:            biz.phone,
          website:          biz.website,
          hours:            biz.hours,
          category:         biz.category,
          category_group:   getGroup(biz.category),
          lat:              biz.lat || null,
          lon:              biz.lon || null,
          confidence_score: (biz.confidence || 50) / 100,
          tags:             biz.tags || [],
          description:      biz.description || null,
          source_id:        source,
          source_weight:    weight,
          source_raw:       biz,
        });

        if (result.created) created++;
        else merged++;

      } catch (e) {
        errors++;
        if (errors <= 5) console.warn(`[migrate] Error on ${biz.name}:`, e.message.slice(0, 100));
      }
    }
    process.stdout.write(`\r[migrate] ${zip}: ${businesses.length} records`);
  }

  console.log(`\n[migrate] Businesses: ${created} created, ${merged} merged, ${errors} errors`);

  // 3. Migrate oracle JSON files into zip_intelligence
  let oracleCount = 0;
  if (fs.existsSync(ORACLE_DIR)) {
    const oracleFiles = fs.readdirSync(ORACLE_DIR).filter(f => f.endsWith('.json'));
    for (const file of oracleFiles) {
      const zip = file.replace('.json', '');
      let oracle;
      try {
        oracle = JSON.parse(fs.readFileSync(path.join(ORACLE_DIR, file), 'utf8'));
      } catch { continue; }

      const dem = oracle.demographics || {};
      const rc  = oracle.restaurant_capacity || {};
      const gt  = oracle.growth_trajectory || {};

      try {
        await db.query(
          `INSERT INTO zip_intelligence (
            zip, name, population, median_household_income, median_home_value,
            owner_occupied_pct, total_households, wfh_pct, retiree_index,
            affluence_pct, ultra_affluence_pct, vacancy_rate_pct, family_hh_pct,
            new_build_pct, restaurant_count, total_businesses, gap_count,
            saturation_status, growth_state, consumer_profile, oracle_json, computed_at
          ) VALUES (
            $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22
          )
          ON CONFLICT (zip) DO UPDATE SET
            oracle_json   = $21,
            computed_at   = $22,
            updated_at    = NOW()`,
          [
            zip, oracle.name,
            dem.population, dem.median_household_income, dem.median_home_value,
            dem.owner_occupied_pct, dem.total_households, dem.wfh_pct, dem.retiree_index,
            dem.affluence_pct, dem.ultra_affluence_pct, dem.vacancy_rate_pct, dem.family_hh_pct,
            dem.new_build_pct,
            rc.restaurant_count, rc.total_businesses, rc.gap_count,
            rc.saturation_status, gt.state, dem.consumer_profile,
            JSON.stringify(oracle), oracle.computed_at || new Date().toISOString(),
          ]
        );
        oracleCount++;
      } catch (e) {
        if (oracleCount < 3) console.warn(`[migrate] Oracle error ${zip}:`, e.message.slice(0, 80));
      }
    }
  }
  console.log(`[migrate] Oracle: ${oracleCount} ZIPs written to zip_intelligence`);

  // 4. Final counts
  const bizCount  = await db.queryOne('SELECT COUNT(*) FROM businesses');
  const zipCount  = await db.queryOne('SELECT COUNT(*) FROM zip_intelligence');
  const evCount   = await db.queryOne('SELECT COUNT(*) FROM source_evidence');

  console.log('\n[migrate] ✓ Complete');
  console.log(`  businesses:      ${bizCount.count}`);
  console.log(`  zip_intelligence:${zipCount.count}`);
  console.log(`  source_evidence: ${evCount.count}`);

  if (require.main === module) process.exit(0);
}

if (require.main === module) {
  run().catch(e => { console.error('[migrate] Fatal:', e); process.exit(1); });
}

module.exports = { migrateJsonToPg: run };
