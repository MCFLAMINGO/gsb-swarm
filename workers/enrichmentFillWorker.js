'use strict';
/**
 * enrichmentFillWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Deterministic business enrichment for LocalIntel target ZIPs.
 *
 *   Zero LLM. Pure maps + templates + string ops.
 *
 * Contract:
 *   START → ensureSchema (columns + business_tasks table)
 *   START → SELECT business_id FROM businesses WHERE zip = ANY(TARGET_ZIPS)
 *           AND category_intel IS NOT NULL AND enrichment_source IS NOT NULL
 *           (FULL_REFRESH=true ignores skip)
 *   WORK  → for each business NOT in skip set, derive services_text,
 *           description, category_intel from category-keyed maps
 *   END   → UPDATE businesses SET ..., enrichment_source='system',
 *           enrichment_updated_at=NOW()
 *   LOG   → worker_events
 *
 * Cycle: once on start, then every 24h.
 */

const db = require('../lib/db');
const { logWorker } = require('../lib/telemetry');

const TARGET_ZIPS = ['32082', '32081', '32250', '32266', '32233', '32259', '32034'];
const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
const CYCLE_MS = 24 * 60 * 60 * 1000;
const STAGGER_MS = 60 * 1000;

// ── Maps ─────────────────────────────────────────────────────────────────────
const SERVICES_TEXT_MAP = {
  restaurant:        'restaurant, food, dining, eat, lunch, dinner, breakfast, takeout, delivery',
  bar:               'bar, pub, drinks, cocktails, beer, wine, happy hour, nightlife',
  fast_food:         'fast food, quick service, takeout, drive thru, lunch, dinner',
  cafe:              'cafe, coffee shop, espresso, latte, breakfast, brunch, pastry, tea',
  pizza:             'pizza, pizzeria, slice, delivery, takeout, italian, dinner',
  bakery:            'bakery, bread, pastry, cake, cookies, dessert, cupcakes, donuts',
  landscaping:       'landscaping, lawn care, mowing, trimming, yard work, grass cutting, fertilization, weed control, mulch, irrigation',
  dental:            'dentist, dental, teeth cleaning, cavity, crown, implant, orthodontics, whitening, x-ray',
  orthodontics:      'orthodontist, braces, invisalign, retainer, teeth straightening, orthodontics',
  oral_surgery:      'oral surgeon, wisdom teeth, dental implant, jaw surgery, extraction, oral surgery',
  law_firm:          'lawyer, attorney, legal, law firm, legal advice, consultation, litigation, estate, family law, criminal defense, personal injury',
  clinic:            'doctor, clinic, medical, health, physician, primary care, urgent care, walk-in, sick visit',
  urgent_care:       'urgent care, walk-in clinic, emergency, immediate care, sick visit, x-ray, lab',
  physical_therapy:  'physical therapy, PT, rehab, sports injury, back pain, recovery, stretching',
  chiropractor:      'chiropractor, chiropractic, back pain, spine, neck pain, adjustment, alignment',
  dermatology:       'dermatology, dermatologist, skin care, acne, mole, eczema, psoriasis, cosmetic',
  psychiatry:        'psychiatry, psychiatrist, mental health, therapy, anxiety, depression, counseling',
  pediatrics:        'pediatrician, pediatrics, kids doctor, child health, well-child, vaccinations, sick visit',
  gym:               'gym, fitness, workout, exercise, weights, cardio, personal trainer, membership, classes',
  yoga:              'yoga, pilates, meditation, stretch, mindfulness, vinyasa, hot yoga, barre, wellness, studio',
  pilates:           'pilates, reformer, mat, core, stretching, fitness, studio',
  hair_salon:        'hair salon, haircut, color, highlights, blowout, styling, extensions, barber, cut',
  nail_salon:        'nail salon, manicure, pedicure, gel, acrylic, nail art, waxing',
  spa:               'spa, massage, facial, body treatment, relaxation, aromatherapy, waxing, skin care',
  massage:           'massage, deep tissue, swedish, sports massage, relaxation, therapy',
  tattoo:            'tattoo, ink, body art, piercing, custom design, tattoo removal',
  plumber:           'plumber, plumbing, pipe repair, water heater, drain, leak, toilet, sewer, emergency plumber',
  electrician:       'electrician, electrical, wiring, panel upgrade, outlet, lighting, generator, emergency electrical',
  general_contractor:'general contractor, remodeling, renovation, home improvement, build, addition, kitchen, bath',
  auto_repair:       'auto repair, car repair, mechanic, oil change, brake, tire, transmission, engine, diagnostic',
  car_wash:          'car wash, auto detailing, wash, wax, vacuum, car cleaning',
  tire_shop:         'tire shop, tires, alignment, rotation, balance, tire repair, tire replacement',
  real_estate:       'real estate, realtor, homes for sale, property, buy house, sell house, listing, agent',
  insurance_agency:  'insurance, home insurance, auto insurance, life insurance, health insurance, quote, coverage',
  insurance:         'insurance, auto, home, life, health, coverage, policy, quote',
  bank:              'bank, banking, checking, savings, loans, mortgage, ATM, financial services',
  pharmacy:          'pharmacy, prescriptions, medications, refill, compounding, immunizations, vitamins',
  optometrist:       'optometrist, eye doctor, vision, glasses, contact lenses, eye exam',
  veterinarian:      'veterinarian, vet, animal hospital, pet care, dog, cat, vaccinations, surgery, grooming',
  photographer:      'photographer, photography, portraits, weddings, events, family photos, headshots',
  accountant:        'accountant, CPA, tax preparation, bookkeeping, payroll, business formation, tax planning',
  florist:           'florist, flowers, bouquet, wedding flowers, funeral flowers, plants, delivery',
  hotel:             'hotel, lodging, accommodation, stay, room, rooms, booking, vacation',
  dry_cleaning:      'dry cleaning, laundry, alterations, tailoring, pressing, same day cleaning',
  place_of_worship:  'church, place of worship, religious services, congregation, ministry, faith',
  grocery:           'grocery, supermarket, produce, food, organic, deli, bakery, meat',
  clothing:          'clothing, apparel, fashion, boutique, men, women, kids, shoes, accessories',
  jewelry:           'jewelry, rings, necklaces, watches, engagement, custom design, repair',
  furniture:         'furniture, home decor, sofas, beds, dining, mattresses, accent pieces',
  pet_store:         'pet store, pet supplies, dog food, cat food, toys, grooming, fish, reptile',
  hardware:          'hardware, tools, lumber, paint, plumbing supplies, electrical, garden, home improvement',
  bookstore:         'bookstore, books, magazines, gifts, reading, used books, new releases',
  music:             'music, instruments, lessons, recording, performance, audio',
  art:               'art gallery, art, paintings, sculpture, exhibits, classes, custom art',
  hvac:              'hvac, heating, cooling, air conditioning, ac repair, furnace, ductwork',
  roofing:           'roofing, roof repair, roof replacement, shingles, metal roof, leaks',
  office:            'office, business, professional services, consulting',
  LocalBusiness:     'local business, services, professional, community',
};

const DESCRIPTION_TEMPLATE = {
  restaurant:        '{name} is a local restaurant serving the {zip} area.',
  bar:               '{name} is a bar serving the {zip} area.',
  fast_food:         '{name} is a quick-service restaurant in the {zip} area.',
  cafe:              '{name} is a cafe serving coffee and light fare in the {zip} area.',
  pizza:             '{name} is a pizzeria serving the {zip} area.',
  bakery:            '{name} is a bakery serving the {zip} area.',
  landscaping:       '{name} provides professional landscaping and lawn care services in the {zip} area.',
  dental:            '{name} is a dental practice serving patients in the {zip} area.',
  orthodontics:      '{name} is an orthodontics practice serving patients in the {zip} area.',
  oral_surgery:      '{name} is an oral surgery practice serving patients in the {zip} area.',
  law_firm:          '{name} is a law firm providing legal services to clients in the {zip} area.',
  clinic:            '{name} is a medical clinic serving the {zip} area.',
  urgent_care:       '{name} is an urgent care clinic serving the {zip} area.',
  physical_therapy:  '{name} provides physical therapy and rehabilitation services in the {zip} area.',
  chiropractor:      '{name} is a chiropractic practice serving the {zip} area.',
  dermatology:       '{name} is a dermatology practice serving patients in the {zip} area.',
  psychiatry:        '{name} is a psychiatry practice serving patients in the {zip} area.',
  pediatrics:        '{name} is a pediatrics practice serving children in the {zip} area.',
  gym:               '{name} is a fitness facility serving the {zip} area.',
  yoga:              '{name} is a yoga studio serving the {zip} area.',
  pilates:           '{name} is a pilates studio serving the {zip} area.',
  hair_salon:        '{name} is a hair salon serving the {zip} area.',
  nail_salon:        '{name} is a nail salon serving the {zip} area.',
  spa:               '{name} is a spa serving the {zip} area.',
  massage:           '{name} is a massage therapy practice serving the {zip} area.',
  tattoo:            '{name} is a tattoo studio serving the {zip} area.',
  plumber:           '{name} provides plumbing services in the {zip} area.',
  electrician:       '{name} provides electrical services in the {zip} area.',
  general_contractor:'{name} is a general contractor serving the {zip} area.',
  auto_repair:       '{name} provides auto repair services in the {zip} area.',
  car_wash:          '{name} is a car wash serving the {zip} area.',
  tire_shop:         '{name} is a tire shop serving the {zip} area.',
  real_estate:       '{name} is a real estate practice serving the {zip} area.',
  insurance_agency:  '{name} is an insurance agency serving the {zip} area.',
  insurance:         '{name} provides insurance services in the {zip} area.',
  bank:              '{name} is a bank serving the {zip} area.',
  pharmacy:          '{name} is a pharmacy serving the {zip} area.',
  optometrist:       '{name} is an optometry practice serving the {zip} area.',
  veterinarian:      '{name} is a veterinary practice serving the {zip} area.',
  photographer:      '{name} is a photography business serving the {zip} area.',
  accountant:        '{name} provides accounting services to clients in the {zip} area.',
  florist:           '{name} is a florist serving the {zip} area.',
  hotel:             '{name} is a hotel serving guests in the {zip} area.',
  dry_cleaning:      '{name} provides dry cleaning and laundry services in the {zip} area.',
  place_of_worship:  '{name} is a place of worship serving the {zip} area.',
  grocery:           '{name} is a grocery store serving the {zip} area.',
  clothing:          '{name} is a clothing retailer serving the {zip} area.',
  jewelry:           '{name} is a jewelry store serving the {zip} area.',
  furniture:         '{name} is a furniture store serving the {zip} area.',
  pet_store:         '{name} is a pet store serving the {zip} area.',
  hardware:          '{name} is a hardware store serving the {zip} area.',
  bookstore:         '{name} is a bookstore serving the {zip} area.',
  music:             '{name} is a music business serving the {zip} area.',
  art:               '{name} is an art business serving the {zip} area.',
  hvac:              '{name} provides HVAC services in the {zip} area.',
  roofing:           '{name} provides roofing services in the {zip} area.',
  office:            '{name} is a professional office serving the {zip} area.',
  LocalBusiness:     '{name} is a local business serving the {zip} area.',
};

// Category intel templates — deterministic seed JSON shapes per vertical.
const FOOD_INTEL = () => ({
  cuisine_tags: [],
  dietary_tags: ['gluten_free_options', 'vegetarian_options'],
  avg_check_usd: null,
  pos_type: null,
  seating_capacity: null,
  reservations: false,
  delivery: false,
  takeout: true,
  catering: false,
  outdoor_seating: false,
  happy_hour: false,
  private_events: false,
});

const LANDSCAPING_INTEL = () => ({
  services_offered: ['lawn_mowing', 'trimming', 'fertilization', 'weed_control'],
  service_area_miles: 15,
  seasonal: true,
  crew_size: null,
  residential: true,
  commercial: false,
  licensed_insured: null,
  free_estimate: true,
  irrigation: false,
  hardscape: false,
  tree_service: false,
});

const DENTAL_INTEL = () => ({
  specialties: [],
  insurance_accepted: ['Delta Dental', 'Cigna', 'Aetna', 'United Healthcare'],
  new_patients: true,
  telehealth: false,
  emergency_appointments: false,
  cosmetic: false,
  pediatric: false,
  payment_plans: true,
});

const LAW_INTEL = () => ({
  practice_areas: [],
  consultation_type: 'free_initial',
  fee_structure: 'contingency_or_hourly',
  bar_state: 'FL',
  attorneys: null,
  languages: ['English'],
  virtual_consult: false,
  areas_served: [],
});

const CLINIC_INTEL = () => ({
  specialties: [],
  insurance_networks: ['Aetna', 'BCBS', 'Cigna', 'Medicare', 'Medicaid'],
  telehealth: false,
  new_patients: true,
  walk_in: false,
  languages: ['English'],
  board_certified: null,
});

const FITNESS_INTEL = () => ({
  class_types: [],
  membership_tiers: ['monthly', 'annual'],
  drop_in: true,
  drop_in_price_usd: null,
  personal_training: false,
  childcare: false,
  pool: false,
  sauna: false,
  open_24h: false,
});

const SALON_INTEL = () => ({
  services_offered: [],
  by_appointment: true,
  walk_in: true,
  products_carried: [],
  gender: 'all',
  bridal: false,
  membership: false,
});

const TRADES_INTEL = () => ({
  services_offered: [],
  licensed_insured: true,
  emergency_service: true,
  free_estimate: true,
  residential: true,
  commercial: true,
  service_area_miles: 30,
  years_in_business: null,
});

const AUTO_INTEL = () => ({
  services_offered: [],
  makes_serviced: [],
  appointments: true,
  walk_in: true,
  loaner_vehicle: false,
  financing: false,
  warranty: true,
});

const REAL_ESTATE_INTEL = () => ({
  specialties: ['residential', 'buyer_rep', 'seller_rep'],
  license_state: 'FL',
  areas_served: [],
  luxury_certified: false,
  relocation: false,
  property_management: false,
});

const INSURANCE_INTEL = () => ({
  lines_offered: ['auto', 'home', 'life', 'health'],
  carriers: [],
  independent_agent: true,
  free_quote: true,
  commercial: false,
});

const BANK_INTEL = () => ({
  services_offered: ['checking', 'savings', 'loans', 'mortgages'],
  atm: true,
  drive_through: false,
  business_banking: true,
  wealth_management: false,
});

const PHARMACY_INTEL = () => ({
  drive_through: false,
  compounding: false,
  immunizations: true,
  delivery: false,
  accepts_most_insurance: true,
});

const HOTEL_INTEL = () => ({
  room_count: null,
  pool: false,
  pet_friendly: false,
  breakfast_included: false,
  meeting_rooms: false,
  beach_access: false,
});

const VET_INTEL = () => ({
  species: ['dogs', 'cats'],
  emergency: false,
  grooming: false,
  boarding: false,
  telehealth: false,
  new_patients: true,
});

const ACCOUNTANT_INTEL = () => ({
  services_offered: ['tax_prep', 'bookkeeping', 'payroll', 'business_formation'],
  accepts_new_clients: true,
  industries_served: [],
  cpa_on_staff: null,
  virtual: false,
});

const DRY_CLEANING_INTEL = () => ({
  services_offered: ['dry_cleaning', 'laundry', 'alterations', 'tailoring'],
  pickup_delivery: false,
  same_day: false,
  wedding_gown: false,
});

const TATTOO_INTEL = () => ({
  by_appointment: true,
  walk_in: true,
  styles: [],
  piercing: false,
  removal: false,
});

const WORSHIP_INTEL = () => ({
  denomination: null,
  service_times: [],
  youth_programs: false,
  live_stream: false,
  food_ministry: false,
});

const SCHOOL_INTEL = () => ({
  type: null,
  grades_or_programs: [],
  public: true,
  enrollment_open: null,
});

const RETAIL_INTEL = () => ({
  product_categories: [],
  online_store: false,
  delivery: false,
  loyalty_program: false,
  price_tier: 'mid',
});

const CREATIVE_INTEL = () => ({
  specialties: [],
  by_appointment: true,
  portfolio_url: null,
  events: false,
  classes: false,
});

const LOCAL_INTEL = () => ({
  verified: false,
  description_source: 'system',
});

const CATEGORY_INTEL_TEMPLATES = {
  restaurant: FOOD_INTEL, bar: FOOD_INTEL, fast_food: FOOD_INTEL, cafe: FOOD_INTEL,
  pizza: FOOD_INTEL, bakery: FOOD_INTEL,
  landscaping: LANDSCAPING_INTEL,
  dental: DENTAL_INTEL, orthodontics: DENTAL_INTEL, oral_surgery: DENTAL_INTEL,
  law_firm: LAW_INTEL, attorney: LAW_INTEL,
  clinic: CLINIC_INTEL, urgent_care: CLINIC_INTEL, hospital: CLINIC_INTEL,
  pediatrics: CLINIC_INTEL, dermatology: CLINIC_INTEL, psychiatry: CLINIC_INTEL,
  physical_therapy: CLINIC_INTEL, chiropractor: CLINIC_INTEL,
  gym: FITNESS_INTEL, yoga: FITNESS_INTEL, pilates: FITNESS_INTEL, fitness: FITNESS_INTEL,
  hair_salon: SALON_INTEL, nail_salon: SALON_INTEL, spa: SALON_INTEL,
  massage: SALON_INTEL, barber: SALON_INTEL,
  plumber: TRADES_INTEL, electrician: TRADES_INTEL, general_contractor: TRADES_INTEL,
  hvac: TRADES_INTEL, roofing: TRADES_INTEL,
  auto_repair: AUTO_INTEL, car_wash: AUTO_INTEL, tire_shop: AUTO_INTEL,
  real_estate: REAL_ESTATE_INTEL,
  insurance: INSURANCE_INTEL, insurance_agency: INSURANCE_INTEL,
  bank: BANK_INTEL, finance: BANK_INTEL, financial: BANK_INTEL,
  pharmacy: PHARMACY_INTEL,
  hotel: HOTEL_INTEL, motel: HOTEL_INTEL, tourism: HOTEL_INTEL,
  veterinarian: VET_INTEL,
  accountant: ACCOUNTANT_INTEL, bookkeeper: ACCOUNTANT_INTEL, tax: ACCOUNTANT_INTEL,
  dry_cleaning: DRY_CLEANING_INTEL, laundry: DRY_CLEANING_INTEL,
  tattoo: TATTOO_INTEL,
  place_of_worship: WORSHIP_INTEL, church: WORSHIP_INTEL,
  school: SCHOOL_INTEL, education: SCHOOL_INTEL, library: SCHOOL_INTEL,
  civic: SCHOOL_INTEL, government: SCHOOL_INTEL,
  grocery: RETAIL_INTEL, retail: RETAIL_INTEL, clothing: RETAIL_INTEL,
  jewelry: RETAIL_INTEL, furniture: RETAIL_INTEL, hardware: RETAIL_INTEL,
  pet_store: RETAIL_INTEL, bookstore: RETAIL_INTEL,
  photographer: CREATIVE_INTEL, art: CREATIVE_INTEL, music: CREATIVE_INTEL,
  florist: CREATIVE_INTEL,
  optometrist: CLINIC_INTEL,
  office: LOCAL_INTEL,
  LocalBusiness: LOCAL_INTEL,
};

// ── Schema ───────────────────────────────────────────────────────────────────
async function ensureSchema() {
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS category_intel JSONB`);
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS enrichment_source TEXT DEFAULT 'system'`);
  await db.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS enrichment_updated_at TIMESTAMPTZ`);
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

// ── Derivation ───────────────────────────────────────────────────────────────
function pickCategory(biz) {
  return (biz.category && String(biz.category).trim()) || 'LocalBusiness';
}

function deriveServicesText(category) {
  return SERVICES_TEXT_MAP[category] || SERVICES_TEXT_MAP.LocalBusiness;
}

function deriveDescription(category, name, zip) {
  const tpl = DESCRIPTION_TEMPLATE[category] || DESCRIPTION_TEMPLATE.LocalBusiness;
  const safeName = (name && String(name).trim()) || 'This business';
  const safeZip = (zip && String(zip).trim()) || 'local';
  return tpl.replace('{name}', safeName).replace('{zip}', safeZip);
}

function deriveCategoryIntel(category) {
  const factory = CATEGORY_INTEL_TEMPLATES[category] || CATEGORY_INTEL_TEMPLATES.LocalBusiness;
  return factory();
}

// ── Cycle ────────────────────────────────────────────────────────────────────
async function runCycle(cycleIndex) {
  const t0 = Date.now();
  console.log(`[enrichment-fill] Cycle ${cycleIndex + 1} — target ZIPs: ${TARGET_ZIPS.join(',')}`);

  // Skip set
  let skipFilter = '';
  if (!FULL_REFRESH) {
    skipFilter = ` AND (category_intel IS NULL OR enrichment_source IS NULL OR enrichment_source = '')`;
  }

  const rows = await db.query(
    `SELECT business_id, name, zip, category
       FROM businesses
      WHERE zip = ANY($1::text[])
        ${skipFilter}`,
    [TARGET_ZIPS]
  );

  console.log(`[enrichment-fill] ${rows.length} businesses to enrich (FULL_REFRESH=${FULL_REFRESH})`);

  let updated = 0;
  let failed = 0;
  for (const biz of rows) {
    try {
      const cat = pickCategory(biz);
      const servicesText = deriveServicesText(cat);
      const description = deriveDescription(cat, biz.name, biz.zip);
      const intel = deriveCategoryIntel(cat);

      await db.query(
        `UPDATE businesses
            SET services_text = $2,
                description = COALESCE(NULLIF(description, ''), $3),
                category_intel = $4,
                enrichment_source = 'system',
                enrichment_updated_at = NOW(),
                updated_at = NOW()
          WHERE business_id = $1`,
        [biz.business_id, servicesText, description, JSON.stringify(intel)]
      );
      updated++;
    } catch (e) {
      failed++;
      console.error(`[enrichment-fill] biz ${biz.business_id} failed:`, e.message);
    }
  }

  const duration = Date.now() - t0;
  console.log(`[enrichment-fill] Cycle ${cycleIndex + 1} complete — updated=${updated} failed=${failed} in ${duration}ms`);

  await logWorker({
    worker_name: 'enrichmentFillWorker',
    event_type: failed > 0 ? 'complete' : 'complete',
    input_summary: `target_zips=${TARGET_ZIPS.length} candidates=${rows.length}`,
    output_summary: `updated=${updated} failed=${failed}`,
    duration_ms: duration,
    records_in: rows.length,
    records_out: updated,
    success_rate: rows.length ? Math.round((updated / rows.length) * 100) : 100,
    meta: { full_refresh: FULL_REFRESH, target_zips: TARGET_ZIPS },
  });
}

// ── Daemon ───────────────────────────────────────────────────────────────────
(async function main() {
  console.log('[enrichment-fill] Worker started — deterministic enrichment, zero LLM');
  try { await ensureSchema(); }
  catch (e) { console.error('[enrichment-fill] schema init failed:', e.message); }

  await new Promise(r => setTimeout(r, STAGGER_MS));

  let cycleIndex = 0;
  while (true) {
    try {
      await runCycle(cycleIndex);
    } catch (err) {
      console.error('[enrichment-fill] Cycle error:', err.message);
      try {
        await logWorker({
          worker_name: 'enrichmentFillWorker',
          event_type: 'fail',
          error_message: err.message,
        });
      } catch (_) {}
    }
    cycleIndex++;
    await new Promise(r => setTimeout(r, CYCLE_MS));
  }
})();
