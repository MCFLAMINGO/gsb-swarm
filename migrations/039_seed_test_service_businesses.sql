-- Migration 039: seed 3 test service businesses in 32082 for live RFQ testing
-- Phone: +19175741483 (McFlamingo / Erik Osol)
-- Email: erik@mcflamingo.com
-- Idempotent — skips if name already exists in 32082

INSERT INTO businesses
  (name, zip, phone, city, state, address,
   category, category_group, description, tags,
   status, confidence_score, sources, primary_source, last_confirmed)
SELECT
  'Ponte Vedra Lawn & Landscape',
  '32082',
  '+19175741483',
  'Ponte Vedra Beach', 'FL',
  '880 A1A N Suite 12, Ponte Vedra Beach FL 32082',
  'landscaping',
  'services',
  'Full-service lawn care, landscaping, irrigation, and yard maintenance for residential and HOA properties in Ponte Vedra and St. Johns County.',
  ARRAY['landscaping','lawn care','irrigation','yard maintenance','hoa'],
  'active', 0.85,
  ARRAY['test_seed'], 'test_seed', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM businesses WHERE name = 'Ponte Vedra Lawn & Landscape' AND zip = '32082'
);

INSERT INTO businesses
  (name, zip, phone, city, state, address,
   category, category_group, description, tags,
   status, confidence_score, sources, primary_source, last_confirmed)
SELECT
  'Coastal Clean Home Services',
  '32082',
  '+19175741483',
  'Ponte Vedra Beach', 'FL',
  '880 A1A N Suite 12, Ponte Vedra Beach FL 32082',
  'house cleaning',
  'services',
  'Residential house cleaning, deep cleaning, move-in/move-out cleaning, and recurring maid service for homes and vacation rentals in 32082 and 32081.',
  ARRAY['house cleaning','maid service','deep clean','move-in cleaning','vacation rental cleaning'],
  'active', 0.85,
  ARRAY['test_seed'], 'test_seed', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM businesses WHERE name = 'Coastal Clean Home Services' AND zip = '32082'
);

INSERT INTO businesses
  (name, zip, phone, city, state, address,
   category, category_group, description, tags,
   status, confidence_score, sources, primary_source, last_confirmed)
SELECT
  'First Coast Handyman',
  '32082',
  '+19175741483',
  'Ponte Vedra Beach', 'FL',
  '880 A1A N Suite 12, Ponte Vedra Beach FL 32082',
  'handyman',
  'services',
  'General handyman services: drywall repair, fixture installation, door/window repair, pressure washing, minor plumbing, and honey-do lists for homes in Ponte Vedra Beach and St. Johns County.',
  ARRAY['handyman','drywall','fixture installation','pressure washing','repairs','honey-do'],
  'active', 0.85,
  ARRAY['test_seed'], 'test_seed', NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM businesses WHERE name = 'First Coast Handyman' AND zip = '32082'
);
