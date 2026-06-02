-- Migration 061: Add contact_email + contact_phone to rfq_jobs
-- Allows web search users to leave their contact info for async provider callbacks.
ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE rfq_jobs ADD COLUMN IF NOT EXISTS contact_phone TEXT;
