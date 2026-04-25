'use strict';
/**
 * scripts/backfillOracle.js
 *
 * One-time script: reads every data/oracle/{zip}.json flat file and upserts
 * all fields into zip_intelligence. Fixes the null ACS fields in PG.
 *
 * Run: node scripts/backfillOracle.js
 * Also called from index.js boot sequence.
 */

const fs   = require('fs');
const path = require('path');

const ORACLE_DIR = path.join(__dirname, '..', 'data', 'oracle');

async function backfillOracle() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.log('[backfillOracle] No DB URL — skipping');
    return;
  }
  const db = require('../lib/db');

  const files = fs.readdirSync(ORACLE_DIR)
    .filter(f => /^\d{5}\.json$/.test(f));

  console.log(`[backfillOracle] Upserting ${files.length} oracle ZIPs into zip_intelligence...`);
  let ok = 0, fail = 0;

  for (const file of files) {
    const zip = file.replace('.json', '');
    try {
      const result = JSON.parse(fs.readFileSync(path.join(ORACLE_DIR, file), 'utf8'));
      if (!result || result.skip) continue;

      const d  = result.demographics            || {};
      const rc = result.restaurant_capacity      || {};
      const gt = result.growth_trajectory        || {};

      await db.query(
        `INSERT INTO zip_intelligence (
           zip, name, state,
           population, median_household_income, median_home_value,
           owner_occupied_pct, total_households,
           wfh_pct, affluence_pct, ultra_affluence_pct,
           retiree_index, new_build_pct,
           age_25_34_pct, age_35_54_pct, age_55_plus_pct,
           vacancy_rate_pct, family_hh_pct,
           restaurant_count, total_businesses, gap_count,
           saturation_status, growth_state, consumer_profile,
           oracle_json, computed_at, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,NOW(),NOW())
         ON CONFLICT (zip) DO UPDATE SET
           name                    = EXCLUDED.name,
           state                   = COALESCE(EXCLUDED.state, zip_intelligence.state),
           population              = COALESCE(EXCLUDED.population, zip_intelligence.population),
           median_household_income = COALESCE(EXCLUDED.median_household_income, zip_intelligence.median_household_income),
           median_home_value       = COALESCE(EXCLUDED.median_home_value, zip_intelligence.median_home_value),
           owner_occupied_pct      = COALESCE(EXCLUDED.owner_occupied_pct, zip_intelligence.owner_occupied_pct),
           total_households        = COALESCE(EXCLUDED.total_households, zip_intelligence.total_households),
           wfh_pct                 = COALESCE(EXCLUDED.wfh_pct, zip_intelligence.wfh_pct),
           affluence_pct           = COALESCE(EXCLUDED.affluence_pct, zip_intelligence.affluence_pct),
           ultra_affluence_pct     = COALESCE(EXCLUDED.ultra_affluence_pct, zip_intelligence.ultra_affluence_pct),
           retiree_index           = COALESCE(EXCLUDED.retiree_index, zip_intelligence.retiree_index),
           new_build_pct           = COALESCE(EXCLUDED.new_build_pct, zip_intelligence.new_build_pct),
           vacancy_rate_pct        = COALESCE(EXCLUDED.vacancy_rate_pct, zip_intelligence.vacancy_rate_pct),
           family_hh_pct           = COALESCE(EXCLUDED.family_hh_pct, zip_intelligence.family_hh_pct),
           restaurant_count        = COALESCE(EXCLUDED.restaurant_count, zip_intelligence.restaurant_count),
           total_businesses        = COALESCE(EXCLUDED.total_businesses, zip_intelligence.total_businesses),
           gap_count               = COALESCE(EXCLUDED.gap_count, zip_intelligence.gap_count),
           saturation_status       = COALESCE(EXCLUDED.saturation_status, zip_intelligence.saturation_status),
           growth_state            = COALESCE(EXCLUDED.growth_state, zip_intelligence.growth_state),
           consumer_profile        = COALESCE(EXCLUDED.consumer_profile, zip_intelligence.consumer_profile),
           oracle_json             = EXCLUDED.oracle_json,
           computed_at             = NOW(),
           updated_at              = NOW()`,
        [
          zip,
          result.name || zip,
          result.state || 'FL',
          d.population                  || null,
          d.median_household_income     || null,
          d.median_home_value           || null,
          d.owner_occupied_pct          || null,
          d.total_households            || null,
          d.wfh_pct                     || null,
          d.affluence_pct               || null,
          d.ultra_affluence_pct         || null,
          d.retiree_index               || null,
          d.new_build_pct               || null,
          d.age_25_34_pct               || null,
          d.age_35_54_pct               || null,
          d.age_55_plus_pct             || null,
          d.vacancy_rate_pct            || null,
          d.family_hh_pct               || null,
          rc.restaurant_count           || null,
          rc.total_businesses           || null,
          rc.gap_count                  || null,
          rc.saturation_status          || null,
          gt.state                      || null,
          d.consumer_profile            || null,
          JSON.stringify(result),
        ]
      );
      ok++;
    } catch (e) {
      console.error(`[backfillOracle] ${zip} failed:`, e.message);
      fail++;
    }
  }

  console.log(`[backfillOracle] Done — ${ok} upserted, ${fail} failed`);
}

// Run directly
if (require.main === module) {
  backfillOracle().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { backfillOracle };
