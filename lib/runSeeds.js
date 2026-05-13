'use strict';
/**
 * lib/runSeeds.js — Idempotent seed runner invoked on server startup.
 *
 * Consolidates rows from scripts/seedB19.js (V Pizza 32082) and
 * scripts/seedB21.js (V's Barbershop / Great Clips / Luxury Hair Studio 32081).
 *
 * Contract: for each row, checks (name ILIKE, zip). Skip if present, insert
 * if missing. Never throws — server boot must succeed even if seeding fails.
 */

const db = require('./db');

const SEED_ROWS = [
  // ── B19: V Pizza (Ponte Vedra Beach 32082) ─────────────────────────────────
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
    state:          'FL',
    source:         null,
  },
  // ── B21: Nocatee 32081 hair/barber ─────────────────────────────────────────
  {
    name:     "V's Barbershop Nocatee",
    category: 'barbershop',
    zip:      '32081',
    city:     'Nocatee',
    address:  'Nocatee Town Center, Ponte Vedra, FL 32081',
    phone:    null,
    website:  'https://vsbarbershop.com',
    status:   'active',
    source:   'manual_seed',
  },
  {
    name:     'Great Clips Nocatee',
    category: 'hair_chain',
    zip:      '32081',
    city:     'Nocatee',
    address:  'Nocatee Town Center, Ponte Vedra, FL 32081',
    phone:    null,
    website:  'https://greatclips.com',
    status:   'active',
    source:   'manual_seed',
  },
  {
    name:     'Luxury Hair Studio For Men Nocatee',
    category: 'barbershop',
    zip:      '32081',
    city:     'Nocatee',
    address:  'Nocatee, Ponte Vedra, FL 32081',
    phone:    null,
    website:  null,
    status:   'active',
    source:   'manual_seed',
  },
];

async function existsByNameZip(name, zip) {
  const rows = await db.query(
    `SELECT business_id FROM businesses WHERE name ILIKE $1 AND zip = $2 LIMIT 1`,
    [name, zip]
  );
  return rows.length > 0;
}

async function insertRow(b) {
  // B19 row has category_group/cuisine/description/tags/state. B21 rows have source.
  // Build flexible INSERT — only include columns whose values are not undefined.
  const cols = ['name', 'category', 'zip', 'city', 'address', 'phone', 'website', 'status'];
  const vals = [b.name, b.category, b.zip, b.city, b.address, b.phone, b.website, b.status];
  if (b.category_group !== undefined) { cols.push('category_group'); vals.push(b.category_group); }
  if (b.cuisine        !== undefined) { cols.push('cuisine');        vals.push(b.cuisine); }
  if (b.description    !== undefined) { cols.push('description');    vals.push(b.description); }
  if (b.tags           !== undefined) { cols.push('tags');           vals.push(b.tags); }
  if (b.state          !== undefined) { cols.push('state');          vals.push(b.state); }
  if (b.source         !== undefined && b.source !== null) { cols.push('source'); vals.push(b.source); }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(',');
  await db.query(
    `INSERT INTO businesses (${cols.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
    vals
  );
}

async function runSeeds() {
  if (!process.env.LOCAL_INTEL_DB_URL) {
    console.log('[seed] LOCAL_INTEL_DB_URL not set — skipping startup seeds');
    return;
  }
  let inserted = 0, skipped = 0, failed = 0;
  for (const b of SEED_ROWS) {
    try {
      if (await existsByNameZip(b.name, b.zip)) {
        console.log(`[seed] skipped ${b.name} (${b.zip})`);
        skipped++;
        continue;
      }
      await insertRow(b);
      console.log(`[seed] inserted ${b.name} (${b.zip})`);
      inserted++;
    } catch (e) {
      console.error(`[seed] error on ${b.name} (${b.zip}):`, e.message);
      failed++;
    }
  }
  console.log(`[seed] done — inserted ${inserted}, skipped ${skipped}, failed ${failed}`);
}

module.exports = { runSeeds };
