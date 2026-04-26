'use strict';
/**
 * scripts/backfillCategoryGroup.js
 *
 * One-time (and idempotent) backfill: stamps category_group onto every
 * business record in data/zips/*.json that is missing it.
 *
 * Safe to re-run — stamp() is a no-op if category_group is already set
 * to something meaningful.
 *
 * Usage:  node scripts/backfillCategoryGroup.js
 */

const fs   = require('fs');
const path = require('path');
const { stamp } = require('../lib/categoryNormalizer');

const ZIPS_DIR = path.join(__dirname, '..', 'data', 'zips');

if (!fs.existsSync(ZIPS_DIR)) {
  console.log('[backfill] data/zips/ not found — nothing to do');
  process.exit(0);
}

const files = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));

let totalFiles = 0, totalHealed = 0, totalRecords = 0;

for (const file of files) {
  const filePath = path.join(ZIPS_DIR, file);
  let data;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    data = JSON.parse(raw);
  } catch (e) {
    console.warn(`[backfill] Skipping ${file}: ${e.message}`);
    continue;
  }

  const arr = Array.isArray(data) ? data : (data?.businesses || []);
  if (!arr.length) continue;

  let healed = 0;
  for (const b of arr) {
    if (stamp(b)) healed++;
  }

  if (healed > 0) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(arr, null, 2));
      console.log(`[backfill] ${file}: healed ${healed}/${arr.length} records`);
    } catch (e) {
      console.error(`[backfill] Failed to write ${file}: ${e.message}`);
    }
  }

  totalFiles++;
  totalRecords += arr.length;
  totalHealed  += healed;
}

console.log(`\n[backfill] Done — ${totalHealed} records healed across ${totalFiles} ZIP files (${totalRecords} total records)`);
