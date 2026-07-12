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

const { computeBidWindow, MAX_RFQ_LIVE_MINUTES, clampDeadlineIso } = require('../lib/rfqService');
assert(computeBidWindow({}).minutes === MAX_RFQ_LIVE_MINUTES, 'default window = 1 day');
assert(computeBidWindow({ deadline_minutes: 60 * 24 * 30 }).minutes === MAX_RFQ_LIVE_MINUTES, '30-day override capped to 1 day');
assert(computeBidWindow({ budget_usd: 9000 }).minutes === MAX_RFQ_LIVE_MINUTES, 'large job capped to 1 day');
assert(computeBidWindow({ is_same_day: true }).minutes === 4 * 60, 'same-day stays 4h');
const far = clampDeadlineIso(new Date(Date.now() + 40 * 24 * 3600 * 1000).toISOString());
assert(Date.parse(far) - Date.now() <= MAX_RFQ_LIVE_MINUTES * 60 * 1000 + 5000, 'deadline_iso clamped to ≤1 day');

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
