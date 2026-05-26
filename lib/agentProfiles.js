'use strict';
/**
 * agentProfiles.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Manages business_agent_profiles — the structured who/what/where/when/why/how
 * profile that makes a business deterministically findable by agents.
 *
 * Also exposes the flat agent_json field used for agent discovery.
 */

const db = require('./db');

let migrated = false;

async function migrate() {
  if (migrated) return;
  const pool = db.getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS business_agent_profiles (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id      UUID NOT NULL UNIQUE REFERENCES businesses(business_id) ON DELETE CASCADE,
      industry_type    TEXT CHECK (industry_type IN ('restaurant','service','professional','retail','other')),
      profile_summary  TEXT,
      services_json    JSONB,
      service_area     TEXT[],
      availability     TEXT,
      response_time    TEXT,
      specialties      TEXT[],
      settlement_tier  TEXT NOT NULL DEFAULT 'none'
                       CHECK (settlement_tier IN ('surge_catalog','acp_wallet','stripe','none')),
      surge_wallet     TEXT,
      acp_wallet       TEXT,
      stripe_account   TEXT,
      proof_text       TEXT,
      proof_source     TEXT,
      agent_json       JSONB,
      wallet_funded    BOOLEAN NOT NULL DEFAULT FALSE,
      mcp_endpoint     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Add mcp_endpoint column if not already present (idempotent)
  await pool.query(`ALTER TABLE business_agent_profiles ADD COLUMN IF NOT EXISTS mcp_endpoint TEXT`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bap_business   ON business_agent_profiles(business_id)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bap_industry   ON business_agent_profiles(industry_type)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_bap_settlement ON business_agent_profiles(settlement_tier)`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_bap_funded ON business_agent_profiles(wallet_funded)
    WHERE wallet_funded = TRUE
  `);

  await pool.query(`
    CREATE OR REPLACE FUNCTION bap_touch()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$
  `);
  await pool.query(`DROP TRIGGER IF EXISTS bap_touch_trg ON business_agent_profiles`);
  await pool.query(`
    CREATE TRIGGER bap_touch_trg
      BEFORE UPDATE ON business_agent_profiles
      FOR EACH ROW EXECUTE FUNCTION bap_touch()
  `);

  migrated = true;
}

// ── buildAgentJson ────────────────────────────────────────────────────────────
/**
 * Builds the flat JSON object that agents consume for discovery.
 * Deterministic — no LLM calls.
 */
function buildAgentJson({ biz, profile }) {
  return {
    id:               biz.business_id,
    name:             biz.name,
    category:         biz.category,
    zip:              biz.zip,
    address:          biz.address,
    phone:            biz.phone,
    industry_type:    profile.industry_type,
    summary:          profile.profile_summary,
    services:         profile.services_json || [],
    specialties:      profile.specialties   || [],
    service_area:     profile.service_area  || [biz.zip].filter(Boolean),
    availability:     profile.availability,
    response_time:    profile.response_time,
    settlement_tier:  profile.settlement_tier,
    wallet_funded:    profile.wallet_funded,
    rfq_enabled:      true,  // any business with a profile can receive RFQ broadcasts
    mcp_endpoint:     profile.mcp_endpoint || null,
    updated_at:       new Date().toISOString(),
  };
}

// ── upsertProfile ─────────────────────────────────────────────────────────────
/**
 * Create or update a business agent profile. Regenerates agent_json on save.
 */
async function upsertProfile(business_id, fields) {
  await migrate();
  const pool = db.getPool();

  // Load the business row so we can build agent_json
  const { rows: [biz] } = await pool.query(
    `SELECT business_id, name, category, zip, address, phone FROM businesses
      WHERE business_id = $1`,
    [business_id]
  );
  if (!biz) throw new Error(`business ${business_id} not found`);

  // Merge with any existing profile
  const { rows: [existing] } = await pool.query(
    `SELECT * FROM business_agent_profiles WHERE business_id = $1`,
    [business_id]
  );

  const merged = { ...(existing || {}), ...fields };
  const agent_json = buildAgentJson({ biz, profile: merged });

  const { rows: [saved] } = await pool.query(
    `INSERT INTO business_agent_profiles (
       business_id, industry_type, profile_summary,
       services_json, service_area, availability, response_time, specialties,
       settlement_tier, surge_wallet, acp_wallet, stripe_account,
       proof_text, proof_source, agent_json, wallet_funded, mcp_endpoint
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (business_id) DO UPDATE SET
       industry_type   = EXCLUDED.industry_type,
       profile_summary = EXCLUDED.profile_summary,
       services_json   = EXCLUDED.services_json,
       service_area    = EXCLUDED.service_area,
       availability    = EXCLUDED.availability,
       response_time   = EXCLUDED.response_time,
       specialties     = EXCLUDED.specialties,
       settlement_tier = EXCLUDED.settlement_tier,
       surge_wallet    = EXCLUDED.surge_wallet,
       acp_wallet      = EXCLUDED.acp_wallet,
       stripe_account  = EXCLUDED.stripe_account,
       proof_text      = COALESCE(EXCLUDED.proof_text, business_agent_profiles.proof_text),
       proof_source    = COALESCE(EXCLUDED.proof_source, business_agent_profiles.proof_source),
       agent_json      = EXCLUDED.agent_json,
       wallet_funded   = EXCLUDED.wallet_funded,
       mcp_endpoint    = COALESCE(EXCLUDED.mcp_endpoint, business_agent_profiles.mcp_endpoint),
       updated_at      = NOW()
     RETURNING *`,
    [
      business_id,
      merged.industry_type    || null,
      merged.profile_summary  || null,
      merged.services_json    ? JSON.stringify(merged.services_json) : null,
      merged.service_area     || null,
      merged.availability     || null,
      merged.response_time    || null,
      merged.specialties      || null,
      merged.settlement_tier  || 'none',
      merged.surge_wallet     || null,
      merged.acp_wallet       || null,
      merged.stripe_account   || null,
      merged.proof_text       || null,
      merged.proof_source     || null,
      JSON.stringify(agent_json),
      merged.wallet_funded    || false,
      merged.mcp_endpoint     || null,
    ]
  );

  console.log(`[agentProfiles] upserted profile for ${business_id} tier=${saved.settlement_tier}`);
  return saved;
}

// ── getProfile ────────────────────────────────────────────────────────────────
async function getProfile(business_id) {
  await migrate();
  const pool = db.getPool();
  const { rows: [profile] } = await pool.query(
    `SELECT * FROM business_agent_profiles WHERE business_id = $1`,
    [business_id]
  );
  return profile || null;
}

module.exports = { migrate, upsertProfile, getProfile, buildAgentJson };
