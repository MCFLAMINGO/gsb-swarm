'use strict';
/**
 * scripts/backfillOracle.js
 *
 * Emergency PG sync: reads oracle_json from zip_intelligence and re-extracts
 * all ACS/demographic columns from it, then updates the individual columns.
 *
 * This fixes the case where oracle_json has good data but the extracted columns
 * (wfh_pct, affluence_pct, etc.) are null or zero from a prior bad upsert.
 *
 * Run manually: node scripts/backfillOracle.js
 * NOT called from boot — oracleWorker.js handles this on every cycle.
 */

async function backfillOracle() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.log('[backfillOracle] No DB URL — skipping');
    return;
  }
  const db = require('../lib/db');

  // Pull all rows that have oracle_json but null ACS fields
  const rows = await db.query(`
    SELECT zip, oracle_json
    FROM zip_intelligence
    WHERE oracle_json IS NOT NULL
      AND (wfh_pct IS NULL OR wfh_pct = 0)
  `);

  console.log(`[backfillOracle] Re-extracting columns for ${rows.rows.length} ZIPs with null/zero ACS fields...`);
  let ok = 0, fail = 0;

  for (const row of rows.rows) {
    try {
      let result;
      try { result = typeof row.oracle_json === 'string' ? JSON.parse(row.oracle_json) : row.oracle_json; }
      catch { fail++; continue; }

      const d  = result?.demographics            || {};
      const rc = result?.restaurant_capacity      || {};
      const gt = result?.growth_trajectory        || {};

      // Only update if the JSON actually has the values
      if (!d.wfh_pct && !d.affluence_pct) { fail++; continue; }

      await db.query(`
        UPDATE zip_intelligence SET
          wfh_pct             = COALESCE($1::numeric, wfh_pct),
          affluence_pct       = COALESCE($2::numeric, affluence_pct),
          ultra_affluence_pct = COALESCE($3::numeric, ultra_affluence_pct),
          retiree_index       = COALESCE($4::numeric, retiree_index),
          new_build_pct       = COALESCE($5::numeric, new_build_pct),
          vacancy_rate_pct    = COALESCE($6::numeric, vacancy_rate_pct),
          median_home_value   = COALESCE($7::numeric, median_home_value),
          total_businesses    = COALESCE($8::int,     total_businesses),
          gap_count           = COALESCE($9::int,     gap_count),
          growth_state        = COALESCE($10,         growth_state),
          saturation_status   = COALESCE($11,         saturation_status),
          updated_at          = NOW()
        WHERE zip = $12`,
        [
          d.wfh_pct           || null,
          d.affluence_pct     || null,
          d.ultra_affluence_pct || null,
          d.retiree_index     || null,
          d.new_build_pct     || null,
          d.vacancy_rate_pct  || null,
          d.median_home_value || null,
          rc.total_businesses || null,
          rc.gap_count        || null,
          gt.state            || null,
          rc.saturation_status|| null,
          row.zip,
        ]
      );
      ok++;
    } catch (e) {
      console.error(`[backfillOracle] ${row.zip} failed:`, e.message);
      fail++;
    }
  }
  console.log(`[backfillOracle] Done — ${ok} updated, ${fail} skipped/failed`);
}

if (require.main === module) {
  backfillOracle().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

module.exports = { backfillOracle };
