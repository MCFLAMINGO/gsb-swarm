-- Migration 060: Consolidate all inline ALTER TABLE businesses ADD COLUMN calls
-- These were scattered across workers/handlers, running every boot and causing
-- ACCESS EXCLUSIVE lock contention against the 614k-row businesses table.
-- Running once here — workers will have their inline ALTER TABLE calls removed.

ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category_intel JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS enrichment_source TEXT DEFAULT 'system';
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS enrichment_updated_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS services_json JSONB;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS menu_fetched_at TIMESTAMPTZ;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS agent_endpoint TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS agent_key TEXT;
ALTER TABLE businesses ADD COLUMN IF NOT EXISTS notify_push BOOLEAN DEFAULT false;
