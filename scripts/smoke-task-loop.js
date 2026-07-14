#!/usr/bin/env node
'use strict';
/**
 * smoke-task-loop.js — Prove intent → HOW for PRODUCT.md stories.
 * No DB required. Exit 1 if classification drifts from the contract.
 *
 * Run: npm run test:task-loop
 */

const { normalizeQueryIntent, howLabel } = require('../lib/intentUnified');

const CASES = [
  {
    name: 'McFlamingo chicken & broccoli (order)',
    q: 'get me chicken and broccoli at McFlamingo',
    expectVia: ['surge', 'search'], // surge preferred; search acceptable if brand not in registry yet
    expectHow: ['place_order', 'discover'],
  },
  {
    name: 'Landscaper RFQ',
    q: 'I need a landscaper tomorrow before noon',
    expectVia: ['rfq'],
    expectHow: ['rfq_bid'],
    expectCategoryIncludes: ['landscap'],
  },
  {
    name: 'Dentures',
    q: 'where can I get my dentures replaced',
    expectVia: ['search'],
    expectHow: ['discover'],
  },
  {
    name: 'Prescriptions',
    q: 'I need my prescriptions',
    expectVia: ['search'],
    expectHow: ['discover'],
  },
  {
    name: 'Dog food',
    q: 'the dog needs food',
    expectVia: ['search', 'rfq'],
    expectHow: ['discover', 'rfq_bid'],
  },
  {
    name: 'Plumber RFQ',
    q: 'I need a plumber in 32082',
    expectVia: ['rfq'],
    expectHow: ['rfq_bid'],
  },
  {
    name: 'Delivery-style task',
    q: 'can you pick up my dry cleaning and drop it off',
    expectVia: ['rfq'],
    expectHow: ['rfq_bid'],
  },
];

let failed = 0;
console.log('=== smoke-task-loop (intent → HOW) ===\n');

for (const c of CASES) {
  const intent = normalizeQueryIntent(c.q, { channel: 'smoke' });
  const how = howLabel(intent);
  const viaOk = c.expectVia.includes(intent.resolvesVia);
  const howOk = c.expectHow.includes(how);
  let catOk = true;
  if (c.expectCategoryIncludes) {
    const cat = (intent.category || '').toLowerCase();
    catOk = c.expectCategoryIncludes.some((p) => cat.includes(p));
  }
  const ok = viaOk && howOk && catOk;
  if (!ok) failed += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
  console.log(`       q="${c.q}"`);
  console.log(`       resolvesVia=${intent.resolvesVia} how=${how} category=${intent.category} sources=${intent.sources.join('+')}`);
  if (!ok) {
    console.log(`       expected via∈${JSON.stringify(c.expectVia)} how∈${JSON.stringify(c.expectHow)}`);
  }
  console.log('');
}

if (failed) {
  console.error(`RESULT: FAILED (${failed}/${CASES.length}) — fix intentUnified / registry before claiming the loop works.`);
  process.exit(1);
}

console.log(`RESULT: OK (${CASES.length}/${CASES.length}) — intent contract matches PRODUCT.md stories.`);
process.exit(0);
