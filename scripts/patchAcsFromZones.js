'use strict';
/**
 * scripts/patchAcsFromZones.js
 *
 * One-shot: reads spendingZones.json (source of truth for ACS fields)
 * and patches zip_intelligence with real wfh_pct, affluence_pct, etc.
 * Also patches oracle_json so it's consistent.
 *
 * Run: LOCAL_INTEL_DB_URL=... node scripts/patchAcsFromZones.js
 */

const fs   = require('fs');
const path = require('path');

async function patchAcsFromZones() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    throw new Error('LOCAL_INTEL_DB_URL required');
  }
  const db = require('../lib/db');

  const zonesRaw = JSON.parse(
    fs.readFileSync(path.join(__dirname, '..', 'data', 'spendingZones.json'), 'utf8')
  );
  const zones = zonesRaw?.zones || {};
  const zipList = Object.keys(zones);
  console.log(`[patchAcs] Patching ${zipList.length} ZIPs from spendingZones...`);

  let ok = 0, skip = 0, fail = 0;

  for (const zip of zipList) {
    const z = zones[zip];
    if (!z) { skip++; continue; }

    // Only patch if zone has meaningful ACS values
    const wfh = z.wfh_pct || null;
    const aff = z.affluence_pct || null;
    const ret = z.retiree_index || null;
    const nb  = z.new_build_pct || null;
    const vac = z.vacancy_rate_pct || null;
    const hmv = z.median_home_value || null;
    const fam = z.family_hh_pct || null;
    const uaff = z.ultra_affluence_pct || null;

    if (!wfh && !aff) { skip++; continue; }

    try {
      // 1. Update individual columns
      // Derive growth_state from zone signals if not already meaningful
      // new_build_pct > 8 = growing, 3-8 = transitioning, <3 = stable
      // retiree_index >= 3 = aging/transitioning regardless of builds
      let derivedGrowthState = null;
      if (nb !== null) {
        if (nb > 8) derivedGrowthState = 'growing';
        else if (nb >= 3 || (ret && ret >= 3)) derivedGrowthState = 'transitioning';
        else derivedGrowthState = 'stable';
      }

      await db.query(`
        UPDATE zip_intelligence SET
          wfh_pct             = COALESCE($1::numeric, wfh_pct),
          affluence_pct       = COALESCE($2::numeric, affluence_pct),
          ultra_affluence_pct = COALESCE($3::numeric, ultra_affluence_pct),
          retiree_index       = COALESCE($4::numeric, retiree_index),
          new_build_pct       = COALESCE($5::numeric, new_build_pct),
          vacancy_rate_pct    = COALESCE($6::numeric, vacancy_rate_pct),
          median_home_value   = COALESCE($7::numeric, median_home_value),
          family_hh_pct       = COALESCE($8::numeric, family_hh_pct),
          growth_state        = COALESCE($10, growth_state),
          updated_at          = NOW()
        WHERE zip = $9`,
        [wfh, aff, uaff, ret, nb, vac, hmv, fam, zip, derivedGrowthState]
      );

      // 2. Patch oracle_json.demographics in-place so it's consistent
      await db.query(`
        UPDATE zip_intelligence
        SET oracle_json = oracle_json || jsonb_build_object(
          'demographics', (oracle_json->'demographics') ||
            jsonb_strip_nulls(jsonb_build_object(
              'wfh_pct',            $1::numeric,
              'affluence_pct',      $2::numeric,
              'ultra_affluence_pct',$3::numeric,
              'retiree_index',      $4::numeric,
              'new_build_pct',      $5::numeric,
              'vacancy_rate_pct',   $6::numeric,
              'median_home_value',  $7::numeric,
              'family_hh_pct',      $8::numeric
            ))
        )
        WHERE zip = $9 AND oracle_json IS NOT NULL`,
        [wfh, aff, uaff, ret, nb, vac, hmv, fam, zip]
      );

      ok++;
    } catch (e) {
      console.error(`[patchAcs] ${zip} failed:`, e.message);
      fail++;
    }
  }

  console.log(`[patchAcs] Done — ${ok} patched, ${skip} skipped (no ACS data), ${fail} failed`);
}

if (require.main === module) {
  patchAcsFromZones()
    .then(() => process.exit(0))
    .catch(e => { console.error(e); process.exit(1); });
}

module.exports = { patchAcsFromZones };
