-- Migration 062: W5+H Presence — Business-side full presence profile
-- Adds structured W5+H columns, tech_stack JSONB, appointments table,
-- and presence_score computed column.
-- Erik — 2026-06-10

-- ── WHO ───────────────────────────────────────────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS owner_name        TEXT,              -- WHO: business owner name
  ADD COLUMN IF NOT EXISTS owner_email       TEXT,              -- WHO: owner direct email
  ADD COLUMN IF NOT EXISTS owner_phone       TEXT,              -- WHO: owner direct phone
  ADD COLUMN IF NOT EXISTS license_number    TEXT,              -- WHO: state/local license #
  ADD COLUMN IF NOT EXISTS year_established  INT;               -- WHO: year opened

-- ── WHAT ─────────────────────────────────────────────────────────────────────
-- services_text, services_json, category, tags already exist
-- menu_url already exists
-- no new columns needed for WHAT

-- ── WHERE ────────────────────────────────────────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS service_radius_miles   INT,           -- WHERE: come-to-me radius
  ADD COLUMN IF NOT EXISTS service_zip_list       TEXT[],        -- WHERE: explicit ZIP coverage
  ADD COLUMN IF NOT EXISTS service_area_notes     TEXT;          -- WHERE: free-form area desc

-- ── WHEN ─────────────────────────────────────────────────────────────────────
-- hours, hours_json already exist
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS booking_url            TEXT,          -- WHEN: external booking link (OpenTable, Acuity, etc.)
  ADD COLUMN IF NOT EXISTS accepts_walkins        BOOLEAN DEFAULT TRUE,   -- WHEN
  ADD COLUMN IF NOT EXISTS lead_time_hours        INT,           -- WHEN: typical lead time for appointments
  ADD COLUMN IF NOT EXISTS same_day_available     BOOLEAN DEFAULT FALSE;  -- WHEN

-- ── WHY ──────────────────────────────────────────────────────────────────────
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS tagline               TEXT,           -- WHY: one-line value prop
  ADD COLUMN IF NOT EXISTS why_choose_us         TEXT,           -- WHY: longer value prop
  ADD COLUMN IF NOT EXISTS specialties_text      TEXT,           -- WHY: specialty keywords
  ADD COLUMN IF NOT EXISTS awards_text           TEXT,           -- WHY: notable awards/press
  ADD COLUMN IF NOT EXISTS photo_url             TEXT;           -- WHY: primary photo

-- ── HOW ──────────────────────────────────────────────────────────────────────
-- wallet, pos_type, menu_url, dispatch_token already exist
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS accepts_rfq            BOOLEAN DEFAULT FALSE,  -- HOW
  ADD COLUMN IF NOT EXISTS accepts_appointments   BOOLEAN DEFAULT FALSE,  -- HOW
  ADD COLUMN IF NOT EXISTS accepts_reservations   BOOLEAN DEFAULT FALSE,  -- HOW
  ADD COLUMN IF NOT EXISTS accepts_walkin_orders  BOOLEAN DEFAULT TRUE,   -- HOW
  ADD COLUMN IF NOT EXISTS payment_methods        TEXT[],        -- HOW: ['cash','card','crypto','invoice']
  ADD COLUMN IF NOT EXISTS stripe_account_id      TEXT,          -- HOW: Stripe Connect acct
  ADD COLUMN IF NOT EXISTS booking_system         TEXT;          -- HOW: 'opentable'|'acuity'|'calendly'|'custom'|null

-- ── TECH STACK ────────────────────────────────────────────────────────────────
-- Stores connected 3rd-party integrations — no credentials stored here.
-- Each entry: { id, name, category, status, url, connected_at }
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS tech_stack             JSONB DEFAULT '[]'::jsonb;

COMMENT ON COLUMN businesses.tech_stack IS '062: Array of {id,name,category,status,url,connected_at}. Categories: pos, reservations, scheduling, email, tasks, accounting, hr, payments, marketing, other';

-- ── PRESENCE SCORE ────────────────────────────────────────────────────────────
-- Computed integer 0-100. Updated by PATCH /inbox/w5h and presence score worker.
-- Formula: each W5+H dimension worth up to ~17 pts. Fields checked per dimension.
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS presence_score        SMALLINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS presence_updated_at   TIMESTAMPTZ;

-- ── APPOINTMENTS TABLE ────────────────────────────────────────────────────────
-- Both sides of any confirmed interaction: rfq_confirmed | appointment | reservation
CREATE TABLE IF NOT EXISTS appointments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_code          TEXT,                                        -- links back to rfq_jobs if rfq
  business_id       UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  -- WHO
  customer_name     TEXT,
  customer_email    TEXT,
  customer_phone    TEXT,
  -- WHAT
  category          TEXT NOT NULL,
  description       TEXT,
  items_agreed      TEXT,                                        -- specific items/services confirmed
  -- WHERE
  location_address  TEXT,                                        -- business address OR customer address (for rfq)
  location_notes    TEXT,
  -- WHEN
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  confirmed_at      TIMESTAMPTZ,
  scheduled_for     TIMESTAMPTZ,                                 -- the actual appointment time
  duration_minutes  INT,
  -- WHY
  request_context   TEXT,                                        -- original query / reason
  -- HOW
  transaction_type  TEXT NOT NULL DEFAULT 'appointment',         -- rfq_confirmed|appointment|reservation|walkin
  status            TEXT NOT NULL DEFAULT 'pending',             -- pending|confirmed|cancelled|completed|no_show
  payment_method    TEXT,
  amount_usd        NUMERIC(10,2),
  notes             TEXT,
  -- Metadata
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appointments_business    ON appointments(business_id);
CREATE INDEX IF NOT EXISTS idx_appointments_status      ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_scheduled   ON appointments(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_appointments_job_code    ON appointments(job_code);
CREATE INDEX IF NOT EXISTS idx_appointments_customer    ON appointments(customer_email, customer_phone);

-- ── APPOINTMENT REQUESTS TABLE ────────────────────────────────────────────────
-- Inbound requests from customers before business confirms — the pre-appointment state
CREATE TABLE IF NOT EXISTS appointment_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  request_type      TEXT NOT NULL DEFAULT 'appointment',         -- appointment|reservation
  customer_name     TEXT,
  customer_email    TEXT,
  customer_phone    TEXT,
  category          TEXT,
  description       TEXT,                                        -- what they want
  preferred_time    TEXT,                                        -- free-text: "Saturday afternoon"
  party_size        INT,                                         -- for reservations
  zip               TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',             -- pending|notified|confirmed|declined|expired
  notified_at       TIMESTAMPTZ,                                 -- when business was emailed
  response_text     TEXT,                                        -- business reply text
  responded_at      TIMESTAMPTZ,
  appointment_id    UUID REFERENCES appointments(id),            -- set when confirmed → creates appointment
  source            TEXT DEFAULT 'web',                          -- web|sms|voice|agent
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_appt_req_business  ON appointment_requests(business_id);
CREATE INDEX IF NOT EXISTS idx_appt_req_status    ON appointment_requests(status);
CREATE INDEX IF NOT EXISTS idx_appt_req_created   ON appointment_requests(created_at DESC);

-- ── NOTIFICATION QUEUE: ensure email column exists ────────────────────────────
-- notification_queue already exists but ensure channel enum covers 'appointment'
-- (no structural change needed — channel is TEXT, not an enum)
