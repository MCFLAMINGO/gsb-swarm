#!/usr/bin/env node
'use strict';
/**
 * Unit checks for RFQ match/notify guards (no DB).
 * Run: node scripts/test-rfq-notify-dedupe.js
 */

const {
  inferCategoryFromText,
  dedupeMatchedByNotifyEmail,
} = require('../lib/rfqService');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    failed += 1;
    console.error('FAIL', msg);
  } else {
    console.log('PASS', msg);
  }
}

assert(inferCategoryFromText('dozen roses from a florist', 'general') === 'florist', 'roses+general → florist');
assert(inferCategoryFromText('dozen roses from a florist', null) === 'florist', 'roses+null → florist');
assert(inferCategoryFromText('I need a landscaper tomorrow', 'service') === 'landscaper', 'landscaper from text');
assert(inferCategoryFromText('random stuff', 'general') === null, 'generic stays null');
assert(inferCategoryFromText('get a plumber', 'plumber') === 'plumber', 'explicit category kept');

const matched = [
  { business_id: 'a', name: 'Biz A', notification_email: 'erik@mcflamingo.com', verified: false },
  { business_id: 'b', name: 'Biz B', notification_email: 'erik@mcflamingo.com', verified: true },
  { business_id: 'c', name: 'Biz C', notification_email: 'erik@mcflamingo.com', verified: false },
  { business_id: 'd', name: 'Other', notification_email: 'other@example.com', verified: false },
  { business_id: 'e', name: 'NoMail', notification_email: null, verified: false },
];
const deduped = dedupeMatchedByNotifyEmail(matched);
assert(deduped.length === 3, `dedupe 5→3 got ${deduped.length}`);
assert(deduped.find((b) => b.notification_email === 'erik@mcflamingo.com')?.business_id === 'b', 'prefer verified for shared email');

if (failed) {
  console.error(`RESULT: FAILED (${failed})`);
  process.exit(1);
}
console.log('RESULT: OK');
process.exit(0);
