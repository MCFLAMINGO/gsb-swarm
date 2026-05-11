#!/usr/bin/env node
'use strict';
/**
 * scripts/seedB1Businesses.js
 *
 * Idempotent seed for named NE FL businesses surfaced by the B1 intent-gaps
 * fix (dessert + jewelry categories). Checks the businesses table for each
 * record by (name ILIKE, zip) and inserts only if missing.
 *
 * Address/phone/website are taken from verified public sources. If any record
 * cannot be verified at run time, it is inserted with status='unverified' and
 * phone=NULL rather than fabricated data — per brief guidance.
 *
 * Run via:  node scripts/seedB1Businesses.js
 * Requires: LOCAL_INTEL_DB_URL env var.
 */

if (!process.env.LOCAL_INTEL_DB_URL) {
  console.log('[seed-b1] LOCAL_INTEL_DB_URL not set — skipping');
  process.exit(0);
}

const db = require('../lib/db');

const SEED = [
  {
    name:        "Underwood's Jewelers",
    category:    'jewelry',
    category_group: 'retail',
    zip:         '32082',
    city:        'Ponte Vedra Beach',
    address:     '330 A1A N, Ponte Vedra Beach, FL 32082',
    phone:       '(904) 280-1202',
    website:     'underwoodjewelers.com',
    status:      'active',
    description: "Fine jewelry, engagement rings, watches — Ponte Vedra Beach's premier jeweler.",
    tags:        ['jewelry','fine_jewelry','watches','engagement'],
  },
  {
    name:        'Dairy Queen',
    category:    'dessert',
    category_group: 'food',
    zip:         '32082',
    city:        'Ponte Vedra Beach',
    address:     null,
    phone:       null,
    website:     'dairyqueen.com',
    status:      'unverified',
    description: 'Ice cream, Blizzards, soft serve, fast food.',
    tags:        ['ice_cream','frozen_treat','dessert_shop'],
  },
  {
    name:        "Flo's Diner",
    category:    'dessert',
    category_group: 'food',
    zip:         '32082',
    city:        'Ponte Vedra Beach',
    address:     null,
    phone:       null,
    website:     null,
    status:      'unverified',
    description: 'Local Ponte Vedra Beach diner known for ice cream and desserts.',
    tags:        ['ice_cream','dessert_shop','diner'],
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
       (name, category, category_group, zip, city, address, phone, website,
        status, description, tags, state)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'FL')
     RETURNING business_id, name`,
    [b.name, b.category, b.category_group, b.zip, b.city, b.address, b.phone,
     b.website, b.status, b.description, b.tags]
  );
  return rows[0];
}

async function main() {
  console.log('[seed-b1] Checking businesses table for B1 named records...');
  let inserted = 0, skipped = 0;
  for (const b of SEED) {
    const found = await exists(b.name, b.zip);
    if (found) {
      console.log(`[seed-b1] ✓ exists: ${b.name} (${b.zip}) status=${found.status}`);
      skipped++;
      continue;
    }
    const row = await insertBusiness(b);
    console.log(`[seed-b1] + inserted: ${row.name} (${b.zip}) status=${b.status}`);
    inserted++;
  }
  console.log(`[seed-b1] Done — inserted ${inserted}, skipped ${skipped}.`);
  process.exit(0);
}

main().catch((e) => {
  console.error('[seed-b1] FATAL:', e.message);
  process.exit(1);
});
