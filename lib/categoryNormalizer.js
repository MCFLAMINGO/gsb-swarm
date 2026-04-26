'use strict';
/**
 * lib/categoryNormalizer.js
 *
 * Single source of truth for category → category_group mapping.
 * Used by every worker that writes to data/zips/{zip}.json.
 *
 * Groups:
 *   food        — restaurants, bars, cafes, food retail
 *   health      — all medical/dental/wellness
 *   construction— contractors, trades, home services
 *   retail      — shops, boutiques, consumer goods
 *   finance     — banks, insurance, accounting, real estate
 *   legal       — attorneys, law firms
 *   automotive  — repair, wash, fuel
 *   hospitality — hotels, lodging
 *   fitness     — gyms, sports, spas, wellness studios
 *   civic       — schools, churches, government, nonprofits
 *   services    — everything else (catch-all)
 */

// ── category string → group ───────────────────────────────────────────────────
// Keys are lowercase, spaces replaced with underscores (matches normalizeKey below)
const CATEGORY_MAP = {
  // food
  restaurant:       'food',
  fast_food:        'food',
  cafe:             'food',
  coffee:           'food',
  bar:              'food',
  pub:              'food',
  brewery:          'food',
  bakery:           'food',
  food:             'food',
  grocery:          'food',
  supermarket:      'food',
  convenience:      'food',
  alcohol:          'food',
  ice_cream:        'food',
  nutrition_supplements: 'food',

  // health
  doctor:           'health',
  dentist:          'health',
  dental:           'health',
  clinic:           'health',
  hospital:         'health',
  pharmacy:         'health',
  chemist:          'health',
  chiropractor:     'health',
  physical_therapy: 'health',
  optometrist:      'health',
  veterinary:       'health',
  veterinarian:     'health',
  urgent_care:      'health',
  primary_care:     'health',
  cardiologist:     'health',
  dermatologist:    'health',
  orthopedic:       'health',
  pediatrician:     'health',
  ob_gyn:           'health',
  'ob/gyn':         'health',
  mental_health:    'health',
  audiologist:      'health',
  lab:              'health',
  diagnostic_imaging: 'health',
  home_health:      'health',
  assisted_living:  'health',
  nursing_home:     'health',
  medical_spa:      'health',

  // construction / home services
  contractor:       'construction',
  general_contractor: 'construction',
  construction:     'construction',
  electrician:      'construction',
  plumber:          'construction',
  plumbing:         'construction',
  hvac:             'construction',
  roofing:          'construction',
  landscaping:      'construction',
  painting:         'construction',
  flooring:         'construction',
  handyman:         'construction',
  home_inspection:  'construction',
  pool_service:     'construction',
  solar:            'construction',
  fence:            'construction',
  concrete:         'construction',
  drywall:          'construction',
  window_door:      'construction',
  pest_control:     'construction',
  hardware:         'construction',

  // retail
  retail:           'retail',
  boutique:         'retail',
  clothes:          'retail',
  electronics:      'retail',
  furniture:        'retail',
  mobile_phone:     'retail',
  copyshop:         'retail',
  florist:          'retail',

  // finance / real estate
  bank:             'finance',
  finance:          'finance',
  insurance:        'finance',
  accounting:       'finance',
  mortgage:         'finance',
  financial:        'finance',
  estate_agent:     'finance',
  real_estate:      'finance',

  // legal
  legal:            'legal',
  attorney:         'legal',

  // automotive
  car_repair:       'automotive',
  auto_repair:      'automotive',
  car_wash:         'automotive',
  fuel:             'automotive',
  gas_station:      'automotive',
  atm:              'automotive',

  // hospitality
  hotel:            'hospitality',
  motel:            'hospitality',

  // fitness / wellness
  gym:              'fitness',
  fitness:          'fitness',
  fitness_centre:   'fitness',
  salon:            'fitness',
  spa:              'fitness',
  beauty:           'fitness',
  hairdresser:      'fitness',
  wellness:         'fitness',
  dry_cleaning:     'fitness',
  sports_centre:    'fitness',
  swimming_pool:    'fitness',
  water_park:       'fitness',

  // civic
  school:           'civic',
  childcare:        'civic',
  church:           'civic',
  place_of_worship: 'civic',
  government:       'civic',
  library:          'civic',
  social_centre:    'civic',
  storage:          'services',
};

// ── Name-based inference (for LocalBusiness / blank category) ─────────────────
const NAME_RULES = [
  // food
  [/pizza|sushi|grill|restaurant|bistro|diner|kitchen|steakhouse|seafood|barbecue|bbq|taco|burger|eatery|tavern|grille|cantina|trattoria|chophouse|sandwich|wings|noodle|ramen|pho|thai|chinese|japanese|mexican|italian|greek/i, 'food'],
  [/\bbar\b|pub |brewery|taproom|cocktail|lounge|nightclub/i, 'food'],
  [/\bcoffee\b|espresso|roastery|boba|smoothie|juice bar/i, 'food'],
  [/bakery|pastry|donut|bagel|ice cream|gelato|creamery/i, 'food'],
  [/grocery|market|supermarket|whole foods|publix|aldi|trader joe/i, 'food'],
  // health
  [/dental|dentist|dds|dmg|smile|orthodont|endodont|periodon|oral surgeon/i, 'health'],
  [/pharmacy|drug store|rx |apothecary|walgreens|cvs|rite aid/i, 'health'],
  [/urgent care|walk.?in|\bclinic\b|physician|\bmd\b|\bdo\b|medical group|health center|cardio|ortho|derma|pediatric|ob.gyn|cardiology|neurology|radiology/i, 'health'],
  [/veterinar|animal hospital|pet clinic/i, 'health'],
  [/assisted living|memory care|senior living|nursing home|home health/i, 'health'],
  [/mental health|counseling|therapy|psychiatr|psycholog/i, 'health'],
  [/chiropractic|physical therapy|rehab center|occupational therapy/i, 'health'],
  // construction
  [/roofing|roofer/i, 'construction'],
  [/plumb/i, 'construction'],
  [/electri/i, 'construction'],
  [/contractor|construction|builder|renovate|remodel|general contracting/i, 'construction'],
  [/hvac|air condition|heating|cooling|ac repair/i, 'construction'],
  [/landscap|lawn care|lawn service|tree service|irrigation/i, 'construction'],
  [/painting|painter/i, 'construction'],
  [/flooring|tile|hardwood|carpet/i, 'construction'],
  [/handyman|home repair|home improvement|home inspect/i, 'construction'],
  [/pool service|pool cleaning|pool repair/i, 'construction'],
  [/solar panel|solar install/i, 'construction'],
  [/pest control|exterminator/i, 'construction'],
  [/fence|fencing/i, 'construction'],
  // finance / real estate
  [/\bbank\b|credit union|fcu|federal savings|suntrust|truist|regions|ameris|hancock/i, 'finance'],
  [/realt|real estate|properties|homes |remax|keller williams|coldwell|century 21|compass realty|exp realty|berkshire/i, 'finance'],
  [/mortgage|wealth management|financial advisor|investment advisor/i, 'finance'],
  [/insurance|allstate|state farm|nationwide|farmers ins/i, 'finance'],
  [/accounting|cpa |bookkeep/i, 'finance'],
  // legal
  [/attorney|law firm|\blegal\b|litigation|\bllp\b| esq\b/i, 'legal'],
  // automotive
  [/auto repair|tire |car wash|mechanic|oil change|transmiss|auto body|collision repair/i, 'automotive'],
  [/gas station|fuel station/i, 'automotive'],
  // hospitality
  [/hotel|inn |\bresort\b|\blodge\b|marriott|hilton|hyatt|westin|sheraton|airbnb/i, 'hospitality'],
  // fitness / wellness
  [/fitness|crossfit|yoga|pilates|hiit|boot.?camp|orangetheory|anytime fitness|planet fitness/i, 'fitness'],
  [/massage|medspa|med spa|aesthetics|wellness center|day spa/i, 'fitness'],
  [/hair salon|hair studio|barber|nail |lash |blow dry|beauty salon/i, 'fitness'],
  [/gym\b|sport.*club/i, 'fitness'],
  [/dry.?clean|laundry/i, 'fitness'],
  // civic
  [/\bchurch\b|lutheran|baptist|presbyterian|methodist|catholic|episcopal|worship|mosque|synagogue/i, 'civic'],
  [/child care|childcare|daycare|day care|preschool|montessori|learning center|academy/i, 'civic'],
  [/school|college|university|tutoring/i, 'civic'],
];

function normalizeKey(cat) {
  return (cat || '').toLowerCase().replace(/[\s\-\/]/g, '_').replace(/[^a-z0-9_]/g, '');
}

/**
 * Resolve category_group from category string.
 * Returns one of the group strings above, never null.
 */
function groupFromCategory(category) {
  if (!category) return null;
  const key = normalizeKey(category);
  return CATEGORY_MAP[key] || null;
}

/**
 * Infer category_group from business name when category is missing or 'LocalBusiness'.
 * Returns null if no rule matches.
 */
function groupFromName(name) {
  if (!name) return null;
  for (const [re, group] of NAME_RULES) {
    if (re.test(name)) return group;
  }
  return null;
}

/**
 * Stamp category_group onto a business object in-place.
 * Priority:
 *   1. Already set and not 'services' → keep it
 *   2. category string → CATEGORY_MAP
 *   3. business name → NAME_RULES
 *   4. 'services' (catch-all)
 *
 * Also normalises category: replaces 'LocalBusiness'/'business'/'office' with
 * the inferred category when we can do better.
 *
 * Returns true if the object was modified.
 */
function stamp(biz) {
  let changed = false;

  // If already stamped with something meaningful, leave it alone
  if (biz.category_group && biz.category_group !== 'services') return false;

  const fromCat  = groupFromCategory(biz.category);
  const fromName = groupFromName(biz.name);

  const group = fromCat || fromName || 'services';
  if (biz.category_group !== group) {
    biz.category_group = group;
    changed = true;
  }

  // Upgrade vague category strings so downstream consumers get real values
  const vague = ['localbusiness', 'business', 'office', ''];
  if (vague.includes(normalizeKey(biz.category || ''))) {
    // Derive a better category from name if possible
    if (fromName) {
      // Use the first NAME_RULE that matched to pick a representative category string
      for (const [re, g] of NAME_RULES) {
        if (g === fromName && re.test(biz.name)) {
          // Map group back to a representative category string
          const GROUP_DEFAULT_CAT = {
            food: 'restaurant', health: 'clinic', construction: 'contractor',
            retail: 'retail', finance: 'finance', legal: 'legal',
            automotive: 'car_repair', hospitality: 'hotel', fitness: 'fitness',
            civic: 'civic', services: 'services',
          };
          const betterCat = GROUP_DEFAULT_CAT[g];
          if (betterCat && biz.category !== betterCat) {
            biz.category = betterCat;
            changed = true;
          }
          break;
        }
      }
    }
  }

  return changed;
}

module.exports = { stamp, groupFromCategory, groupFromName };
