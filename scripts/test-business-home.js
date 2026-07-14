#!/usr/bin/env node
'use strict';
/**
 * Unit checks for business home scoring + onboarding pack (no DB).
 * Run: node scripts/test-business-home.js
 */

const { scoreDimensions, nextActions, payStatus, claimStage } = require('../lib/businessHome');
const { buildPackJson, buildPackHtml } = require('../lib/onboardingPack');

let failed = 0;
function assert(cond, msg) {
  if (!cond) { failed += 1; console.error('FAIL', msg); }
  else console.log('PASS', msg);
}

const emptyBiz = {
  name: 'Test Florist',
  category: 'florist',
  zip: '32082',
  claimed_at: new Date().toISOString(),
  accepts_rfq: true,
};
const scored = scoreDimensions(emptyBiz);
assert(scored.presence_score > 0 && scored.presence_score < 100, `partial score got ${scored.presence_score}`);
assert(scored.dimensions.what.missing.includes('specialties_text'), 'missing specialty');

const nav = nextActions(emptyBiz, { pending_jobs: 0 });
assert(nav.primary.id === 'add_specialty', `primary should be specialty got ${nav.primary.id}`);

const withJob = nextActions(emptyBiz, { pending_jobs: 2 });
assert(withJob.primary.id === 'review_jobs', 'jobs take priority');

assert(payStatus({ wallet: '0xabc' }) === 'wallet', 'wallet pay status');
assert(payStatus({ pos_type: 'surge' }) === 'surge', 'surge pay status');
assert(claimStage(emptyBiz) === 'presence_draft', 'claim stage draft');

const pack = buildPackJson({
  business_id: 'biz-1',
  name: 'Test Florist',
  category: 'florist',
  zip: '32082',
  specialties_text: 'Dozen roses & wedding bouquets',
  dispatch_token: 'tok-1',
});
assert(pack.links.inbox.includes('tok-1'), 'pack inbox link');
assert(pack.fear_reducers.length >= 3, 'fear reducers present');
assert(pack.how_it_works.some((s) => /prepaid|x402|Surge/i.test(s)), 'mentions pay rails');

const html = buildPackHtml({
  business_id: 'biz-1',
  name: 'Test Florist',
  zip: '32082',
  dispatch_token: 'tok-1',
});
assert(html.includes('Business Home') && html.includes('Test Florist'), 'html pack renders');

if (failed) {
  console.error(`RESULT: FAILED (${failed})`);
  process.exit(1);
}
console.log('RESULT: OK');
process.exit(0);
