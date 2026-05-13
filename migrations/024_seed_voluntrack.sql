-- Migration 024: seed voluntrackapp.com as a LocalIntel business
INSERT INTO businesses (
  business_id,
  name,
  zip,
  city,
  category,
  category_group,
  claimed,
  claimed_by_email,
  claimed_at,
  enrichment_source,
  description,
  created_at
)
VALUES (
  gen_random_uuid(),
  'VolunTrack',
  '32082',
  'Ponte Vedra Beach',
  'Technology',
  'Technology',
  true,
  'erik@mcflamingo.com',
  NOW(),
  'manual_seed',
  'Volunteer tracking and management platform by MCFL Restaurant Holdings LLC. Website: https://voluntrackapp.com',
  NOW()
)
ON CONFLICT DO NOTHING;
