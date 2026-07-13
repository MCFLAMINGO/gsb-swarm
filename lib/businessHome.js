'use strict';
/**
 * lib/businessHome.js — Trust-first business home composition.
 * Single payload for landing Business Home: score, dimensions, jobs, pay, next action.
 */

const db = require('./db');

let _migrated = false;
async function ensureColumns() {
  if (_migrated) return;
  try {
    await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS claim_stage TEXT`);
    await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS onboarding_pack_sent_at TIMESTAMPTZ`);
    await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS accepts_jobs BOOLEAN DEFAULT TRUE`);
  } catch (e) {
    console.warn('[businessHome] ensureColumns:', e.message);
  }
  _migrated = true;
}

const DIMENSIONS = {
  who:  ['name', 'phone', 'owner_name'],
  what: ['category', 'services_text', 'specialties_text', 'tagline'],
  where:['address', 'zip', 'service_radius_miles'],
  when: ['hours_json', 'same_day_available'],
  why:  ['why_choose_us', 'tagline'],
  how:  ['accepts_rfq', 'accepts_appointments', 'payment_methods', 'wallet', 'pos_type'],
};

function filled(val) {
  if (val == null) return false;
  if (typeof val === 'boolean') return val === true;
  if (Array.isArray(val)) return val.length > 0;
  if (typeof val === 'object') return Object.keys(val).length > 0;
  return String(val).trim().length > 0;
}

function scoreDimensions(biz) {
  const dims = {};
  let earned = 0;
  let total = 0;
  for (const [dim, keys] of Object.entries(DIMENSIONS)) {
    const hits = keys.filter((k) => filled(biz[k]));
    const ratio = keys.length ? hits.length / keys.length : 0;
    dims[dim] = {
      score: Math.round(ratio * 100),
      filled: hits,
      missing: keys.filter((k) => !filled(biz[k])),
    };
    earned += hits.length;
    total += keys.length;
  }
  return {
    presence_score: total ? Math.round((earned / total) * 100) : 0,
    dimensions: dims,
  };
}

function payStatus(biz) {
  const pos = (biz.pos_type || '').toLowerCase();
  if (pos === 'surge' || pos === 'other') return 'surge';
  if (biz.wallet) return 'wallet';
  if (Array.isArray(biz.payment_methods) && biz.payment_methods.length) return 'methods';
  return 'none';
}

function claimStage(biz) {
  if (!biz.claimed_at) return 'unclaimed';
  const { presence_score } = scoreDimensions(biz);
  if (payStatus(biz) !== 'none' && presence_score >= 50) return 'pay_ready';
  if (presence_score >= 40 || filled(biz.specialties_text) || filled(biz.services_text)) return 'live';
  if (biz.claimed_at) return 'presence_draft';
  return 'contact_verified';
}

function nextActions(biz, { pending_jobs = 0 } = {}) {
  const actions = [];
  const { dimensions, presence_score } = scoreDimensions(biz);

  if (pending_jobs > 0) {
    actions.push({
      id: 'review_jobs',
      label: `Review ${pending_jobs} open job${pending_jobs === 1 ? '' : 's'}`,
      api: 'GET /api/local-intel/inbox/requests',
      tab: 'jobs',
      priority: 1,
    });
  }

  if (!filled(biz.specialties_text) && !filled(biz.services_text) && !filled(biz.tagline)) {
    actions.push({
      id: 'add_specialty',
      label: 'Add one sentence: what do you do specially?',
      api: 'PATCH /api/local-intel/inbox/w5h',
      fields: ['specialties_text', 'tagline'],
      tab: 'broadcast',
      priority: 2,
    });
  }

  if (!filled(biz.hours_json) && !biz.has_hours) {
    actions.push({
      id: 'set_hours',
      label: 'Confirm when you are open',
      api: 'POST /api/local-intel/inbox/hours',
      tab: 'broadcast',
      priority: 3,
    });
  }

  if (pending_jobs > 0 && payStatus(biz) === 'none') {
    actions.push({
      id: 'connect_pay',
      label: 'Choose how you get paid (Surge, wallet, or invoice/cash)',
      api: 'POST /api/local-intel/inbox/pos | /inbox/wallet | PATCH /inbox/w5h',
      tab: 'pay',
      priority: 4,
    });
  }

  if (!biz.onboarding_pack_sent_at) {
    actions.push({
      id: 'send_pack',
      label: 'Email yourself your LocalIntel pack (link + QR + how jobs work)',
      api: 'POST /api/local-intel/inbox/send-pack',
      tab: 'share',
      priority: 5,
    });
  }

  if (presence_score >= 40 && !biz.accepts_rfq) {
    actions.push({
      id: 'open_for_work',
      label: 'Turn on: open for jobs',
      api: 'PATCH /api/local-intel/inbox/w5h',
      fields: { accepts_rfq: true },
      tab: 'jobs',
      priority: 6,
    });
  }

  actions.sort((a, b) => a.priority - b.priority);
  return {
    primary: actions[0] || {
      id: 'all_set',
      label: 'You are live — share your pack or wait for jobs',
      tab: 'share',
      priority: 99,
    },
    all: actions,
    dimensions,
    presence_score,
  };
}

async function loadBizByToken(token) {
  await ensureColumns();
  const [biz] = await db.query(
    `SELECT business_id, name, address, city, zip, phone, website, category, category_group,
            wallet, notification_email, notification_phone,
            notify_push, notify_sms, notify_email, claimed_at, dispatch_token,
            COALESCE(has_hours, false) AS has_hours,
            hours_json, services_text, menu_url, services_json,
            CASE WHEN pos_config IS NOT NULL THEN (pos_config->>'pos_type') ELSE NULL END AS pos_type,
            owner_name, owner_email, owner_phone, year_established, license_number,
            tagline, why_choose_us, specialties_text, photo_url,
            booking_url, booking_system, accepts_walkins, lead_time_hours, same_day_available,
            accepts_rfq, accepts_appointments, accepts_reservations, accepts_walkin_orders,
            payment_methods, service_radius_miles, service_zip_list, service_area_notes,
            tech_stack, presence_score, onboarding_pack_sent_at, claim_stage, lat, lon
       FROM businesses
      WHERE dispatch_token = $1
        AND status != 'inactive'
      LIMIT 1`,
    [token]
  );
  return biz || null;
}

async function loadBizById(businessId) {
  await ensureColumns();
  const [biz] = await db.query(
    `SELECT business_id, name, address, city, zip, phone, website, category, category_group,
            wallet, notification_email, notification_phone,
            claimed_at, dispatch_token,
            COALESCE(has_hours, false) AS has_hours,
            hours_json, services_text, services_json,
            CASE WHEN pos_config IS NOT NULL THEN (pos_config->>'pos_type') ELSE NULL END AS pos_type,
            owner_name, tagline, why_choose_us, specialties_text, photo_url,
            accepts_rfq, accepts_appointments, payment_methods,
            presence_score, onboarding_pack_sent_at, claim_stage, lat, lon
       FROM businesses
      WHERE business_id = $1
        AND status != 'inactive'
      LIMIT 1`,
    [businessId]
  );
  return biz || null;
}

async function countPendingJobs(businessId) {
  try {
    const rows = await db.query(
      `SELECT COUNT(*)::int AS n
         FROM rfq_requests r
         JOIN rfq_broadcast_log bl ON bl.rfq_id = r.id
        WHERE bl.business_id = $1
          AND r.status = 'open'
          AND r.created_at > NOW() - INTERVAL '1 day'
          AND (r.deadline_at IS NULL OR r.deadline_at > NOW())`,
      [businessId]
    );
    return rows[0]?.n || 0;
  } catch (_) {
    return 0;
  }
}

async function buildHome(token) {
  const biz = await loadBizByToken(token);
  if (!biz) return null;

  const pending_jobs = await countPendingJobs(biz.business_id);
  const nav = nextActions(biz, { pending_jobs });
  const stage = claimStage(biz);
  const pay = payStatus(biz);

  db.query(
    `UPDATE businesses SET claim_stage = $2 WHERE business_id = $1 AND (claim_stage IS DISTINCT FROM $2)`,
    [biz.business_id, stage]
  ).catch(() => {});

  return {
    business_id: biz.business_id,
    name: biz.name,
    zip: biz.zip,
    category: biz.category,
    claim_stage: stage,
    presence_score: nav.presence_score,
    dimensions: nav.dimensions,
    pending_jobs,
    open_for_work: !!biz.accepts_rfq,
    pay_status: pay,
    pay_rails: {
      surge: pay === 'surge',
      wallet: !!biz.wallet,
      methods: biz.payment_methods || [],
      agent_prepaid: true,
      x402_note: 'Agents may pay via x402 or prepaid cards; you confirm Done in Jobs.',
    },
    next_action: nav.primary,
    next_actions: nav.all,
    links: {
      inbox: `https://www.thelocalintel.com/inbox.html?token=${token}`,
      presence: `https://gsb-swarm-production.up.railway.app/api/local-intel/presence/${biz.business_id}`,
      pack: `https://gsb-swarm-production.up.railway.app/api/local-intel/business/${biz.business_id}/onboarding-pack?format=html`,
      pack_json: `https://gsb-swarm-production.up.railway.app/api/local-intel/business/${biz.business_id}/onboarding-pack`,
    },
    prompts: {
      who: 'Confirm your name and phone',
      what: 'What do you do specially? (one sentence)',
      where: 'Where do customers find you?',
      when: 'When are you open / how fast can you respond?',
      why: 'Why should someone pick you?',
      how: 'How should work arrive? (order, RFQ, appointment, walk-in)',
    },
  };
}

module.exports = {
  ensureColumns,
  buildHome,
  loadBizByToken,
  loadBizById,
  scoreDimensions,
  nextActions,
  payStatus,
  claimStage,
  countPendingJobs,
};
