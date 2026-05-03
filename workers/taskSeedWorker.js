'use strict';
/**
 * taskSeedWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Seeds business_tasks rows for every business in the target ZIPs based on
 * deterministic per-vertical task templates. Zero LLM.
 *
 * Contract:
 *   START → SELECT DISTINCT business_id FROM business_tasks (skip set)
 *           FULL_REFRESH=true → skip nothing
 *   WORK  → for each business in TARGET_ZIPS not in skip set, look up
 *           TASK_TEMPLATES[category] || TASK_TEMPLATES.LocalBusiness
 *   END   → bulk INSERT business_tasks (status='pending')
 *   LOG   → worker_events
 *
 * Run-once (no loop) — tasks are set-and-forget until the business edits them.
 */

const db = require('../lib/db');
const { logWorker } = require('../lib/telemetry');

const TARGET_ZIPS = ['32082', '32081', '32250', '32266', '32233', '32259', '32034'];
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
const STAGGER_MS = 90 * 1000;

const TASK_TEMPLATES = {
  restaurant:        ['Connect POS System', 'Add menu categories', 'Set dietary tags', 'Connect wallet for routing', 'Verify hours', 'Add exterior photo', 'Enable SMS order alerts'],
  bar:               ['Connect POS System', 'Add drink menu', 'Set happy hour times', 'Connect wallet for routing', 'Verify hours', 'Add exterior photo'],
  fast_food:         ['Connect POS System', 'Confirm menu categories', 'Set dietary tags', 'Connect wallet for routing', 'Verify hours'],
  cafe:              ['Connect POS System', 'Add menu categories', 'Set dietary tags', 'Connect wallet for routing', 'Verify hours', 'Add interior photo'],
  pizza:             ['Connect POS System', 'Add menu', 'Enable delivery flag', 'Connect wallet for routing', 'Verify hours'],
  bakery:            ['Add product categories', 'Set daily specials', 'Enable pre-order', 'Connect wallet for routing', 'Verify hours'],
  landscaping:       ['Confirm service area (miles)', 'List services offered', 'Set residential/commercial flag', 'Upload license/insurance doc', 'Connect wallet for routing', 'Set seasonal schedule', 'Add crew size'],
  dental:            ['List specialties', 'List insurance accepted', 'Set new-patient status', 'Connect wallet for routing', 'Verify hours', 'Add payment plan info'],
  orthodontics:      ['List specialties', 'List insurance accepted', 'Set new-patient status', 'Connect wallet for routing', 'Verify hours'],
  oral_surgery:      ['List specialties', 'List insurance accepted', 'Connect wallet for routing', 'Verify hours'],
  law_firm:          ['List practice areas', 'Set consultation type', 'Set fee structure', 'Add attorney count', 'Connect wallet for routing', 'Add languages served'],
  clinic:            ['List specialties', 'List insurance networks', 'Set telehealth flag', 'Set walk-in flag', 'Connect wallet for routing', 'Verify hours'],
  urgent_care:       ['Set walk-in status', 'List insurance networks', 'Set wait time avg', 'Connect wallet for routing', 'Verify hours'],
  physical_therapy:  ['List specialties', 'List insurance networks', 'Set new-patient status', 'Connect wallet for routing', 'Verify hours'],
  chiropractor:      ['List specialties', 'List insurance networks', 'Set new-patient status', 'Connect wallet for routing', 'Verify hours'],
  dermatology:       ['List specialties', 'List insurance networks', 'Set telehealth flag', 'Connect wallet for routing', 'Verify hours'],
  psychiatry:        ['List specialties', 'List insurance networks', 'Set telehealth flag', 'Connect wallet for routing', 'Verify hours'],
  pediatrics:        ['List specialties', 'List insurance networks', 'Set new-patient status', 'Connect wallet for routing', 'Verify hours'],
  gym:               ['List class types', 'Set membership tiers', 'Set drop-in price', 'Connect wallet for routing', 'Verify hours', 'Add personal training flag'],
  yoga:              ['List class types', 'Set drop-in price', 'Connect wallet for routing', 'Verify hours', 'Add schedule URL'],
  pilates:           ['List class types', 'Set drop-in price', 'Connect wallet for routing', 'Verify hours', 'Add schedule URL'],
  hair_salon:        ['List services offered', 'Set walk-in vs appointment', 'List products carried', 'Connect wallet for routing', 'Verify hours'],
  nail_salon:        ['List services offered', 'Set walk-in vs appointment', 'Connect wallet for routing', 'Verify hours'],
  spa:               ['List services offered', 'Set by-appointment flag', 'Add membership info', 'Connect wallet for routing', 'Verify hours'],
  massage:           ['List services offered', 'Set by-appointment flag', 'Connect wallet for routing', 'Verify hours'],
  tattoo:            ['List styles', 'Set walk-in flag', 'Set piercing flag', 'Connect wallet for routing', 'Verify hours'],
  plumber:           ['List services offered', 'Set emergency service flag', 'Set service area miles', 'Upload license doc', 'Connect wallet for routing'],
  electrician:       ['List services offered', 'Set emergency service flag', 'Set service area miles', 'Upload license doc', 'Connect wallet for routing'],
  general_contractor:['List services offered', 'Set residential/commercial flag', 'Upload license doc', 'Connect wallet for routing', 'Add portfolio photos'],
  auto_repair:       ['List services offered', 'List makes serviced', 'Set walk-in flag', 'Connect wallet for routing', 'Verify hours'],
  car_wash:          ['List service tiers', 'Set walk-in flag', 'Connect wallet for routing', 'Verify hours'],
  tire_shop:         ['List services offered', 'Set walk-in flag', 'Connect wallet for routing', 'Verify hours'],
  real_estate:       ['List specialties', 'List areas served', 'Set luxury certified flag', 'Connect wallet for routing', 'Add broker/brokerage name'],
  insurance_agency:  ['List lines offered', 'List carriers represented', 'Set independent flag', 'Connect wallet for routing', 'Verify hours'],
  insurance:         ['List lines offered', 'Connect wallet for routing', 'Verify hours'],
  bank:              ['List services offered', 'Set ATM flag', 'Set drive-through flag', 'Connect wallet for routing', 'Verify hours'],
  pharmacy:          ['Set drive-through flag', 'Set compounding flag', 'Set delivery flag', 'Connect wallet for routing', 'Verify hours'],
  hotel:             ['Set room count', 'Set pet-friendly flag', 'Set pool flag', 'Connect wallet for routing', 'Add booking URL'],
  veterinarian:      ['List species served', 'Set emergency flag', 'Set boarding flag', 'Set grooming flag', 'Connect wallet for routing', 'Verify hours'],
  accountant:        ['List services offered', 'Set CPA flag', 'List industries served', 'Set virtual flag', 'Connect wallet for routing'],
  dry_cleaning:      ['List services offered', 'Set pickup/delivery flag', 'Set same-day flag', 'Connect wallet for routing', 'Verify hours'],
  photographer:      ['List specialties', 'Add portfolio URL', 'Set events flag', 'Connect wallet for routing'],
  florist:           ['List product categories', 'Set delivery flag', 'Set events flag', 'Connect wallet for routing', 'Verify hours'],
  grocery:           ['List product categories', 'Set delivery flag', 'Set loyalty program flag', 'Connect wallet for routing', 'Verify hours'],
  place_of_worship:  ['Set denomination', 'Add service times', 'Set live stream flag', 'Set food ministry flag', 'Connect wallet for routing'],
  school:            ['Set type', 'List programs', 'Set public/private', 'Connect wallet for routing'],
  LocalBusiness:     ['Verify business name', 'Confirm address', 'Connect wallet for routing', 'Verify hours', 'Add description', 'Add photo'],
};

function pickTemplate(category) {
  if (category && TASK_TEMPLATES[category]) {
    return { key: category, tasks: TASK_TEMPLATES[category] };
  }
  return { key: 'LocalBusiness', tasks: TASK_TEMPLATES.LocalBusiness };
}

async function ensureSchema() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS business_tasks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      task_type TEXT NOT NULL DEFAULT 'setup',
      template_key TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`CREATE INDEX IF NOT EXISTS business_tasks_business_id_idx ON business_tasks(business_id)`);
  await db.query(`CREATE INDEX IF NOT EXISTS business_tasks_status_idx ON business_tasks(status)`);
}

async function runOnce() {
  const t0 = Date.now();
  console.log(`[task-seed] Starting — target ZIPs: ${TARGET_ZIPS.join(',')}`);

  let skipFilter = '';
  if (!FULL_REFRESH) {
    skipFilter = ` AND b.business_id NOT IN (SELECT DISTINCT business_id FROM business_tasks)`;
  }

  const rows = await db.query(
    `SELECT b.business_id, b.category
       FROM businesses b
      WHERE b.zip = ANY($1::text[])
        ${skipFilter}`,
    [TARGET_ZIPS]
  );

  console.log(`[task-seed] ${rows.length} businesses needing tasks (FULL_REFRESH=${FULL_REFRESH})`);

  let inserted = 0;
  let bizCount = 0;
  let failed = 0;

  for (const biz of rows) {
    const { key, tasks } = pickTemplate(biz.category);
    if (!tasks || !tasks.length) continue;

    const values = [];
    const placeholders = [];
    let p = 1;
    for (const title of tasks) {
      placeholders.push(`($${p++}, $${p++}, 'pending', 'setup', $${p++})`);
      values.push(biz.business_id, title, key);
    }

    try {
      const sql = `INSERT INTO business_tasks (business_id, title, status, task_type, template_key)
                   VALUES ${placeholders.join(',')}`;
      await db.query(sql, values);
      inserted += tasks.length;
      bizCount++;
    } catch (e) {
      failed++;
      console.error(`[task-seed] biz ${biz.business_id} failed:`, e.message);
    }
  }

  const duration = Date.now() - t0;
  console.log(`[task-seed] Done — businesses_seeded=${bizCount} tasks_inserted=${inserted} failed=${failed} in ${duration}ms`);

  await logWorker({
    worker_name: 'taskSeedWorker',
    event_type: 'complete',
    input_summary: `target_zips=${TARGET_ZIPS.length} candidates=${rows.length}`,
    output_summary: `businesses_seeded=${bizCount} tasks_inserted=${inserted} failed=${failed}`,
    duration_ms: duration,
    records_in: rows.length,
    records_out: bizCount,
    success_rate: rows.length ? Math.round((bizCount / rows.length) * 100) : 100,
    meta: { full_refresh: FULL_REFRESH, target_zips: TARGET_ZIPS, tasks_inserted: inserted },
  });
}

(async function main() {
  console.log('[task-seed] Worker started — deterministic task seed, zero LLM, run-once');
  try { await ensureSchema(); }
  catch (e) { console.error('[task-seed] schema init failed:', e.message); }

  await new Promise(r => setTimeout(r, STAGGER_MS));

  try {
    await runOnce();
  } catch (err) {
    console.error('[task-seed] Run error:', err.message);
    try {
      await logWorker({
        worker_name: 'taskSeedWorker',
        event_type: 'fail',
        error_message: err.message,
      });
    } catch (_) {}
  }

  console.log('[task-seed] Run-once complete — staying alive idle (no loop)');
  // Stay alive so dashboard-server fork supervisor doesn't restart in a loop.
  setInterval(() => {}, 1 << 30);
})();
