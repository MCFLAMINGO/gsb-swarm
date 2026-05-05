/**
 * reclassifyWorker.js
 * ───────────────────
 * Deterministic name-signal reclassifier for businesses with category = 'LocalBusiness'
 * or any other catch-all value that produces poor search/gap results.
 *
 * Worker contract:
 *   START  → read Postgres for what's already reclassified (skip)
 *   WORK   → match name against rules, derive category + category_group
 *   END    → upsert to Postgres
 *   SAFE   → never overwrites a record that already has a real category
 *            unless FULL_REFRESH=true env var is set
 *
 * Run: node workers/reclassifyWorker.js
 * Full refresh: FULL_REFRESH=true node workers/reclassifyWorker.js
 */

'use strict';

const db = require('../lib/db');

// ── Rule table ────────────────────────────────────────────────────────────────
// Each rule: { patterns: [...strings], category, group }
// Patterns are matched case-insensitively against the business name.
// First match wins — order matters (most specific first).
const RULES = [
  // ── Food / Dining ─────────────────────────────────────────────────────────
  { patterns: ['fine dining','chophouse','chop house'],                                       category: 'fine_dining',        group: 'food' },
  { patterns: ['steakhouse','steak house'],                                                   category: 'steakhouse',         group: 'food' },
  { patterns: ['sushi','ramen','pho',' thai ','chinese','japanese','korean','vietnamese','asian','hibachi','dim sum','boba'], category: 'asian', group: 'food' },
  { patterns: ['mexican','taco','burrito','cantina','cocina','tamale','enchilada','quesadilla'], category: 'mexican',          group: 'food' },
  { patterns: ['italian','trattoria','osteria','ristorante'],                                  category: 'italian',           group: 'food' },
  { patterns: ['pizza','pizzeria'],                                                            category: 'pizza',             group: 'food' },
  { patterns: ['bbq','barbecue','smokehouse','smoke house'],                                   category: 'bbq',               group: 'food' },
  { patterns: ['deli ','delicatessen',' sub ',' subs',' hoagie','sandwich','sandwiches'],      category: 'sandwich',          group: 'food' },
  { patterns: ['seafood','fish camp','oyster','crab shack','lobster','fish house','fishery'],   category: 'seafood',           group: 'food' },
  { patterns: ['donut','doughnut','bagel','pastry shop','patisserie'],                          category: 'bakery',            group: 'food' },
  { patterns: ['bakery','bake shop'],                                                           category: 'bakery',            group: 'food' },
  { patterns: ['coffee','espresso','roaster','brew bar','java','percolat'],                     category: 'cafe',              group: 'food' },
  { patterns: ['cafe','café'],                                                                  category: 'cafe',              group: 'food' },
  { patterns: ['brewery','taproom','tap room','wine bar','gastropub','tavern','pub ','pub,'],   category: 'bar',               group: 'food' },
  { patterns: ['bar & grill','bar and grill'],                                                  category: 'restaurant',        group: 'food' },
  { patterns: ['grill','grille','bistro',' kitchen',' eatery','restaurant','cantina'],          category: 'restaurant',        group: 'food' },

  // ── Healthcare ────────────────────────────────────────────────────────────
  { patterns: ['dental','dentist',' dds','orthodont','endodont','periodont','oral surgery','denture'], category: 'dental',          group: 'health' },
  { patterns: ['chiropractic','chiropract'],                                                    category: 'chiropractic',      group: 'health' },
  { patterns: ['optometr','optician','eye care','vision center','eyewear'],                     category: 'optometry',         group: 'health' },
  { patterns: ['physical therapy','pt clinic','sports rehab','rehabilitation','occupational therapy'], category: 'physical_therapy', group: 'health' },
  { patterns: ['veterinar','animal hospital','pet clinic','animal care','pet hospital'],         category: 'veterinary',        group: 'health' },
  { patterns: ['urgent care','walk-in clinic','walk in clinic','med first','minute clinic'],     category: 'urgent_care',       group: 'health' },
  { patterns: ['pharmacy','drug store',' rx ','apothecary'],                                    category: 'pharmacy',          group: 'health' },
  { patterns: ['dr.',' md ','physician','medical center','health center','pediatric','cardio','dermatol','oncol','orthoped','neurol','gastro','obgyn','ob/gyn'], category: 'healthcare', group: 'health' },
  { patterns: ['clinic','medical'],                                                              category: 'healthcare',        group: 'health' },

  // ── Professional Services ─────────────────────────────────────────────────
  { patterns: ['law firm','law office','attorney','lawyer',' esq','esquire',' llp',' llc law'], category: 'legal',             group: 'professional_services' },
  { patterns: ['accounting','accountant','bookkeeping','bookkeeper',' cpa',' tax preparation','tax service'], category: 'accounting', group: 'professional_services' },
  { patterns: ['financial advisor','wealth management','investment advisor','financial planning','mortgage','loan officer'], category: 'finance', group: 'professional_services' },
  { patterns: ['insurance','allstate','state farm','farmers insurance','geico','usaa agent'],   category: 'insurance',         group: 'professional_services' },
  { patterns: ['real estate','realty','realtor','homes for sale','realtors','properties llc','property management'], category: 'real_estate', group: 'professional_services' },
  { patterns: ['architect','architecture'],                                                      category: 'architecture',      group: 'professional_services' },
  { patterns: ['marketing agency','advertising agency','digital agency','media agency','seo agency'], category: 'marketing',   group: 'professional_services' },
  { patterns: ['staffing','recruiting','headhunter','human resources','hr consulting'],          category: 'staffing',          group: 'professional_services' },
  { patterns: ['title company','title & escrow','closing company'],                              category: 'title_company',     group: 'professional_services' },
  { patterns: ['it services','managed services','tech support','computer repair','it consulting'], category: 'it_services',    group: 'professional_services' },

  // ── Construction / Trades ─────────────────────────────────────────────────
  { patterns: ['plumbing','plumber'],                                                            category: 'plumbing',          group: 'construction' },
  { patterns: ['electric','electrician'],                                                        category: 'electrical',        group: 'construction' },
  { patterns: ['hvac','air conditioning','air conditioner','heating & cooling','heating and cooling','ac repair','ac service'], category: 'hvac', group: 'construction' },
  { patterns: ['roofing','roofer'],                                                              category: 'roofing',           group: 'construction' },
  { patterns: ['landscap','lawn care','lawn service','irrigation','sod install','tree service','tree trimm'], category: 'landscaping', group: 'construction' },
  { patterns: ['pool service','pool repair','pool cleaning','swimming pool'],                    category: 'pool_service',      group: 'construction' },
  { patterns: ['painting','painter','paint co'],                                                 category: 'painting',          group: 'construction' },
  { patterns: ['flooring','hardwood floor','tile install','carpet install'],                     category: 'flooring',          group: 'construction' },
  { patterns: ['pest control','exterminator','termite'],                                         category: 'pest_control',      group: 'construction' },
  { patterns: ['cleaning service','janitorial','maid service','housekeeping','pressure wash','power wash'], category: 'cleaning', group: 'construction' },
  { patterns: ['solar','solar panel','solar install'],                                           category: 'solar',             group: 'construction' },
  { patterns: ['general contractor','builder','home builder','remodel','renovation','construction co','construction llc'], category: 'general_contractor', group: 'construction' },

  // ── Retail / Consumer ─────────────────────────────────────────────────────
  { patterns: ['hair salon','nail salon','nail spa','barber','lash','brow bar','beauty salon'], category: 'beauty_salon',      group: 'retail' },
  { patterns: ['day spa','med spa','medspa','massage therapy','spa & wellness'],                category: 'spa',               group: 'retail' },
  { patterns: ['gym','fitness','yoga','pilates','crossfit','martial arts','boxing gym','jiu-jitsu','karate','cycling studio'], category: 'fitness', group: 'retail' },
  { patterns: ['boutique','clothing','apparel','shoes','fashion','swimwear','accessories'],     category: 'clothing',          group: 'retail' },
  { patterns: ['grocery','supermarket','food store','natural market','organic market'],         category: 'grocery',           group: 'retail' },
  { patterns: ['liquor store','wine shop','spirits','beer store','wine & spirits'],             category: 'liquor_store',      group: 'retail' },
  { patterns: ['florist','flower shop','flowers'],                                              category: 'florist',           group: 'retail' },
  { patterns: ['jewel','jeweler','jewelry'],                                                    category: 'jewelry',           group: 'retail' },
  { patterns: ['pet store','pet supply','pet shop','petco','petsmart'],                         category: 'pet_store',         group: 'retail' },
  { patterns: ['furniture','home decor','home goods','mattress'],                               category: 'furniture',         group: 'retail' },
  { patterns: ['art gallery','gallery'],                                                        category: 'art_gallery',       group: 'retail' },

  // ── Automotive ────────────────────────────────────────────────────────────
  { patterns: ['auto repair','auto service','mechanic','garage','tire shop','tire kingdom','alignment','oil change','jiffy lube','midas','meineke'], category: 'auto_repair', group: 'automotive' },
  { patterns: ['car wash','auto detail','auto spa','detailing'],                                category: 'car_wash',          group: 'automotive' },
  { patterns: ['car dealer','auto dealer','auto sales','motors','ford','chevrolet','toyota','honda dealer','nissan','hyundai'], category: 'car_dealer', group: 'automotive' },
  { patterns: ['towing','roadside','wrecker'],                                                  category: 'towing',            group: 'automotive' },
  { patterns: ['gas station','fuel station','shell station','bp station','chevron','sunoco'],   category: 'gas_station',       group: 'automotive' },

  // ── Hospitality ───────────────────────────────────────────────────────────
  { patterns: ['hotel','inn ','inn,','resort','suites','motel','lodge','marriott','hilton','hyatt','holiday inn','courtyard'], category: 'hotel', group: 'hospitality' },
  { patterns: ['vacation rental','short term rental','airbnb management','vrbo management'],    category: 'vacation_rental',   group: 'hospitality' },
  { patterns: ['event venue','wedding venue','banquet hall','event space'],                     category: 'event_venue',       group: 'hospitality' },

  // ── Education ─────────────────────────────────────────────────────────────
  { patterns: ['preschool','daycare','day care','childcare','child care','early learning','montessori'], category: 'childcare', group: 'education' },
  { patterns: ['tutoring','learning center','kumon','sylvan','after school'],                   category: 'tutoring',          group: 'education' },
  { patterns: ['school','academy','college','university','vocational'],                         category: 'education',         group: 'education' },

  // ── Community / Other ─────────────────────────────────────────────────────
  { patterns: ['church','baptist','methodist','catholic','evangelical','mosque','synagogue','temple','parish'], category: 'religious', group: 'community' },
  { patterns: ['storage','self-storage','self storage','u-haul','public storage'],              category: 'storage',           group: 'services' },
  { patterns: ['shipping','ups store','fedex','print shop','copy center','office depot','staples'], category: 'shipping',      group: 'services' },
  { patterns: ['nonprofit','non-profit','foundation','charity','food bank','soup kitchen'],     category: 'nonprofit',         group: 'community' },
  { patterns: ['photography','photographer','photo studio'],                                    category: 'photography',       group: 'services' },
  { patterns: ['funeral','cremation','mortuary'],                                               category: 'funeral',           group: 'services' },
];

// Human-readable labels for description cleaner (used by descriptionWorker)
const CATEGORY_LABELS = {
  // Food
  fine_dining: 'a fine dining restaurant', steakhouse: 'a steakhouse', asian: 'an Asian restaurant',
  mexican: 'a Mexican restaurant', italian: 'an Italian restaurant', pizza: 'a pizza restaurant',
  bbq: 'a BBQ & smokehouse restaurant', sandwich: 'a sandwich & deli', seafood: 'a seafood restaurant',
  bakery: 'a bakery', cafe: 'a café', bar: 'a bar & lounge', restaurant: 'a restaurant',
  fast_food: 'a quick-service restaurant', casual_dining: 'a casual dining restaurant',
  cuban: 'a Cuban restaurant', dessert: 'a dessert shop', coffee_chain: 'a coffee shop',
  // Health
  dental: 'a dental practice', chiropractic: 'a chiropractic clinic', optometry: 'an optometry practice',
  physical_therapy: 'a physical therapy clinic', veterinary: 'a veterinary clinic',
  urgent_care: 'an urgent care center', pharmacy: 'a pharmacy', healthcare: 'a medical practice',
  clinic: 'a medical clinic', spa: 'a day spa & wellness center',
  // Professional Services
  legal: 'a law firm', accounting: 'an accounting firm', finance: 'a financial services firm',
  insurance: 'an insurance agency', real_estate: 'a real estate company',
  architecture: 'an architecture firm', marketing: 'a marketing agency', staffing: 'a staffing firm',
  title_company: 'a title company', it_services: 'an IT services company',
  professional_services: 'a professional services firm',
  // Construction
  plumbing: 'a plumbing contractor', electrical: 'an electrical contractor',
  hvac: 'an HVAC contractor', roofing: 'a roofing contractor',
  landscaping: 'a landscaping company', pool_service: 'a pool service company',
  painting: 'a painting contractor', flooring: 'a flooring contractor',
  pest_control: 'a pest control company', cleaning: 'a cleaning service',
  solar: 'a solar installation company', general_contractor: 'a general contractor',
  // Retail
  beauty_salon: 'a beauty salon', hair_salon: 'a beauty salon', fitness: 'a fitness studio',
  clothing: 'a clothing boutique', grocery: 'a grocery store', liquor_store: 'a wine & spirits shop',
  florist: 'a florist', jewelry: 'a jewelry store', pet_store: 'a pet supply store',
  furniture: 'a furniture & home goods store', art_gallery: 'an art gallery',
  // Automotive
  auto_repair: 'an auto repair shop', car_wash: 'a car wash & detailing service',
  car_dealer: 'a car dealership', towing: 'a towing service', gas_station: 'a gas station',
  // Hospitality
  hotel: 'a hotel', vacation_rental: 'a vacation rental management company',
  event_venue: 'an event venue',
  // Education
  childcare: 'a childcare center', tutoring: 'a tutoring center',
  education: 'an educational institution',
  // Community / Other
  religious: 'a place of worship', nonprofit: 'a nonprofit organization',
  storage: 'a self-storage facility', shipping: 'a shipping & print center',
  photography: 'a photography studio', funeral: 'a funeral home',
  // Catch-all
  LocalBusiness: 'a local business',
};

module.exports = { RULES, CATEGORY_LABELS };

// ── Runner ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
    console.log(`[reclassify] Starting — FULL_REFRESH=${FULL_REFRESH}`);

    // Only target LocalBusiness OR unknown if FULL_REFRESH
    const whereClause = FULL_REFRESH
      ? `status != 'inactive'`
      : `status != 'inactive' AND (category = 'LocalBusiness' OR category IS NULL OR category = '')`;

    const businesses = await db.query(`
      SELECT business_id, name, category, category_group, zip
      FROM businesses
      WHERE ${whereClause}
    `);

    console.log(`[reclassify] Loaded ${businesses.length} records to evaluate`);

    let updated = 0;
    let skipped = 0;
    const batch = [];

    for (const biz of businesses) {
      const name = (biz.name || '').toLowerCase();
      let matched = null;

      for (const rule of RULES) {
        if (rule.patterns.some(p => name.includes(p.toLowerCase()))) {
          matched = rule;
          break;
        }
      }

      if (!matched) { skipped++; continue; }

      // Skip if already correct (unless FULL_REFRESH)
      if (!FULL_REFRESH && biz.category === matched.category) { skipped++; continue; }

      batch.push({ id: biz.business_id, category: matched.category, group: matched.group, name: biz.name });
    }

    console.log(`[reclassify] ${batch.length} to update, ${skipped} skipped`);

    // Upsert in chunks of 100
    let count = 0;
    for (let i = 0; i < batch.length; i += 100) {
      const chunk = batch.slice(i, i + 100);
      await Promise.all(chunk.map(b =>
        db.query(
          `UPDATE businesses SET category = $1, category_group = $2, updated_at = NOW()
           WHERE business_id = $3`,
          [b.category, b.group, b.id]
        )
      ));
      count += chunk.length;
      process.stdout.write(`\r[reclassify] ${count}/${batch.length} updated…`);
    }

    console.log(`\n[reclassify] Done — ${count} records reclassified`);
    process.exit(0);
  })().catch(e => { console.error('[reclassify] FATAL:', e.message); process.exit(1); });
}
