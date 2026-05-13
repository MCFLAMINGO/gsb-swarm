#!/usr/bin/env node
'use strict';
/**
 * scripts/seedB19.js
 *
 * B19 seed — adds V Pizza (Ponte Vedra Beach) to the businesses table so the
 * SHORT_NAME_FOOD_RE name-search path has something to find for "V pizza"
 * queries instead of falling through to the generic pizza-category search.
 *
 * Idempotent: checks (name ILIKE, zip) and inserts only if missing. Status is
 * 'unverified' because phone/hours weren't manually confirmed at seed time.
 *
 * Run via:  node scripts/seedB19.js
 * Requires: LOCAL_INTEL_DB_URL env var.
 */

if (!process.env.LOCAL_INTEL_DB_URL) {
  console.log('[seed-b19] LOCAL_INTEL_DB_URL not set — skipping');
  process.exit(0);
}

const db = require('../lib/db');

const SEED = [
  {
    name:           'V Pizza',
    category:       'restaurant',
    category_group: 'food',
    cuisine:        'pizza',
    zip:            '32082',
    city:           'Ponte Vedra Beach',
    address:        '105 Solana Rd, Ponte Vedra Beach, FL 32082',
    phone:          null,
    website:        'https://www.vpizza.com',
    status:         'unverified',
    description:    'Authentic Neapolitan-style pizza chain. Ponte Vedra Beach location.',
    tags:           ['pizza','italian','neapolitan','restaurant'],
  },
];

async function exists(name, zip) {
  const rows = await db.query(
    `SELECT business_id, name, status FROM businesses
     WHERE name ILIKE $1 AND zip = $2 LIMIT 1`,
    [name, zip]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function insertBusiness(b) {
  const rows = await db.query(
    `INSERT INTO businesses
       (name, category, category_group, cuisine, zip, city, address, phone, website,
        status, description, tags, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'FL')
     ON CONFLICT DO NOTHING
     RETURNING business_id, name`,
    [b.name, b.category, b.category_group, b.cuisine, b.zip, b.city, b.address,
     b.phone, b.website, b.status, b.description, b.tags]
  );
  return rows[0];
}

async function main() {
  console.log('[seed-b19] Checking businesses table for B19 named records...');
  let inserted = 0, skipped = 0;
  for (const b of SEED) {
    const found = await exists(b.name, b.zip);
    if (found) {
      console.log(`[seed-b19] ✓ exists: ${b.name} (${b.zip}) status=${found.status}`);
      skipped++;
      continue;
    }
    const row = await insertBusiness(b);
    if (row) {
      console.log(`[seed-b19] + inserted: ${row.name} (${b.zip}) status=${b.status}`);
      inserted++;
    } else {
      console.log(`[seed-b19] ✓ conflict-skipped: ${b.name} (${b.zip})`);
      skipped++;
    }
  }
  console.log(`[seed-b19] Done — inserted ${inserted}, skipped ${skipped}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed-b19] FATAL:', e.message);
  process.exit(1);
});
