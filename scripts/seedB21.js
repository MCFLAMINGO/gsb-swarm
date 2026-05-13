#!/usr/bin/env node
'use strict';
/**
 * seedB21.js — Seed V's Barbershop Nocatee (32081) missing from Postgres
 * Run once: node scripts/seedB21.js
 */
const db = require('../lib/db');

async function main() {
  const businesses = [
    {
      name: "V's Barbershop Nocatee",
      category: 'barbershop',
      zip: '32081',
      city: 'Nocatee',
      address: 'Nocatee Town Center, Ponte Vedra, FL 32081',
      phone: null,
      website: 'https://vsbarbershop.com',
      status: 'active',
    },
    {
      name: "Great Clips Nocatee",
      category: 'hair_chain',
      zip: '32081',
      city: 'Nocatee',
      address: 'Nocatee Town Center, Ponte Vedra, FL 32081',
      phone: null,
      website: 'https://greatclips.com',
      status: 'active',
    },
    {
      name: "Luxury Hair Studio For Men Nocatee",
      category: 'barbershop',
      zip: '32081',
      city: 'Nocatee',
      address: 'Nocatee, Ponte Vedra, FL 32081',
      phone: null,
      website: null,
      status: 'active',
    },
  ];

  for (const b of businesses) {
    const existing = await db.query(
      `SELECT business_id FROM businesses WHERE name ILIKE $1 AND zip = $2 LIMIT 1`,
      [b.name, b.zip]
    );
    if (existing.length > 0) {
      console.log(`[seedB21] SKIP (exists): ${b.name}`);
      continue;
    }
    await db.query(
      `INSERT INTO businesses (name, category, zip, city, address, phone, website, status, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual_seed')`,
      [b.name, b.category, b.zip, b.city, b.address, b.phone, b.website, b.status]
    );
    console.log(`[seedB21] INSERTED: ${b.name} (${b.zip})`);
  }
  console.log('[seedB21] done');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
