/**
 * reclassify_categories.js
 * Deterministic name-pattern reclassification for all businesses.
 * Zero LLM calls. Pure string matching.
 * Run: node scripts/reclassify_categories.js
 */

const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.LOCAL_INTEL_DB_URL || 'postgresql://postgres:myufFnkSigImGnSylwyIjYmLCvkthQUr@turntable.proxy.rlwy.net:25739/railway' });

// ─── RULES ────────────────────────────────────────────────────────────────────
// Each rule: { pattern (regex on name, case-insensitive), category, category_group }
// Rules are applied IN ORDER — first match wins per business.
// More specific rules must come before general ones.

const RULES = [

  // ── FOOD: Fine Dining ──
  { p: /inn\s*&\s*club|country\s*club|yacht\s*club|city\s*club|supper\s*club/i,       category: 'fine_dining',        group: 'food' },
  { p: /ruth'?s\s*chris|capital\s*grille|ocean\s*prime|flemings|eddie\s*v'?s|truluck|bonefish\s*grill/i, category: 'fine_dining', group: 'food' },
  { p: /medure|black\s*pearl|st\.?\s*tropez\s*bistro|estiatorio\s*milos|timo\s*italian/i, category: 'fine_dining',   group: 'food' },
  { p: /steakhouse|steak\s*house|chophouse|chop\s*house/i,                              category: 'steakhouse',        group: 'food' },

  // ── FOOD: Fast Food chains ──
  { p: /mcdonald'?s|burger\s*king|wendy'?s|taco\s*bell|chick-?fil-?a|popeyes|kfc|sonic\s*drive|jack\s*in\s*the\s*box|five\s*guys|whataburger|checkers|rallys|hardee'?s|carl'?s\s*jr/i, category: 'fast_food', group: 'food' },
  { p: /domino'?s|pizza\s*hut|papa\s*john'?s|little\s*caesars|papa\s*murphy/i,          category: 'pizza',             group: 'food' },
  { p: /subway|jimmy\s*john'?s|jersey\s*mike|firehouse\s*subs|quiznos|potbelly/i,       category: 'sandwich',          group: 'food' },
  { p: /chipotle|moe'?s\s*south|qdoba|willy'?s\s*mex|tijuana\s*flats/i,                category: 'fast_casual_mexican',group: 'food' },

  // ── FOOD: Casual Dining chains ──
  { p: /applebee'?s|chili'?s|t\.?g\.?i\.?\s*friday|olive\s*garden|outback|longhorn|red\s*lobster|cracker\s*barrel|denny'?s|ihop|waffle\s*house|bob\s*evans/i, category: 'casual_dining', group: 'food' },
  { p: /bahama\s*breeze|yard\s*house|buffalo\s*wild\s*wings|bj'?s\s*restaurant|red\s*robin|hooters|twin\s*peaks/i, category: 'casual_dining', group: 'food' },

  // ── FOOD: Subcategories ──
  { p: /sushi|hibachi|ramen|pho\b|dim\s*sum|boba|bubble\s*tea/i,                        category: 'asian',             group: 'food' },
  { p: /thai\b|chinese\b|vietnamese|korean\s*bbq|indian\s*cuisine|curry\s*house/i,      category: 'asian',             group: 'food' },
  { p: /seafood|fish\s*camp|fish\s*house|crab\s*shack|oyster\s*bar|lobster/i,           category: 'seafood',           group: 'food' },
  { p: /bbq|barbecue|bar-?b-?q|smoke\s*house|smokehouse|brisket/i,                     category: 'bbq',               group: 'food' },
  { p: /pizza|pizzeria|pizzaria/i,                                                       category: 'pizza',             group: 'food' },
  { p: /taco|burrito|mexican|cantina|tex-?mex|mariachi|hacienda/i,                      category: 'mexican',           group: 'food' },
  { p: /italian|ristorante|trattoria|osteria|pasta|lasagna/i,                           category: 'italian',           group: 'food' },
  { p: /cuban\s*cuisine|cuban\s*cafe|cubano/i,                                          category: 'cuban',             group: 'food' },
  { p: /wine\s*bar|tapas|gastropub|bistro/i,                                            category: 'bar_dining',        group: 'food' },
  { p: /sports?\s*bar|grill\s*&\s*bar|bar\s*&\s*grill|tavern/i,                        category: 'sports_bar',        group: 'food' },
  { p: /starbucks|dunkin|tim\s*hortons|peet'?s\s*coffee|coffee\s*bean|caribou/i,        category: 'coffee_chain',      group: 'food' },
  { p: /cafe|coffee|espresso|roaster/i,                                                 category: 'cafe',              group: 'food' },
  { p: /ice\s*cream|gelato|frozen\s*yogurt|fro-?yo|yogurt|dairy\s*queen|baskin|culver/i,category: 'dessert',          group: 'food' },
  { p: /bakery|pastry|donut|krispy\s*kreme|panera/i,                                    category: 'bakery',            group: 'food' },
  { p: /juice|smoothie|acai|tropical\s*smoothie/i,                                      category: 'health_food',       group: 'food' },
  { p: /wingstop|wing\s*stop|wing\s*house|wing\s*zone/i,                               category: 'fast_food',         group: 'food' },
  { p: /deli\b|delicatessen|sandwich|sub\s*shop/i,                                     category: 'deli',              group: 'food' },
  { p: /brewery|brew\s*pub|brewhouse|craft\s*beer|taproom/i,                           category: 'brewery',           group: 'food' },
  { p: /bar\b|lounge|nightclub|night\s*club|saloon/i,                                  category: 'bar',               group: 'food' },

  // ── HEALTH: Subcategories ──
  { p: /urgent\s*care|emergi|fastcare|minuteclinic|cvs\s*minute\s*clinic/i,             category: 'urgent_care',       group: 'health' },
  { p: /emergency\s*room|er\b|emergency\s*dept|emergency\s*center/i,                   category: 'emergency',         group: 'health' },
  { p: /pediatric|children'?s\s*(?:hospital|clinic|health)/i,                          category: 'pediatrics',        group: 'health' },
  { p: /cardiol|heart\s*(?:center|clinic|specialist)/i,                                category: 'cardiology',        group: 'health' },
  { p: /orthoped|sports\s*medicine|spine\s*center|joint\s*(?:center|clinic)/i,         category: 'orthopedics',       group: 'health' },
  { p: /dermatol|skin\s*(?:care|clinic|center)/i,                                      category: 'dermatology',       group: 'health' },
  { p: /mental\s*health|psychiatr|psycholog|counseling|therapist|behavioral\s*health/i,category: 'mental_health',     group: 'health' },
  { p: /physical\s*therap|pt\s*clinic|rehab(?:ilitation)?\s*center/i,                 category: 'physical_therapy',  group: 'health' },
  { p: /chiropractic|chiropractor/i,                                                   category: 'chiropractic',      group: 'health' },
  { p: /optometr|vision\s*care|eye\s*care|eye\s*doctor|optician/i,                    category: 'optometry',         group: 'health' },
  { p: /oncolog|cancer\s*center|cancer\s*care/i,                                      category: 'oncology',          group: 'health' },
  { p: /obgyn|ob\/gyn|obstetric|gynecolog|women'?s\s*health/i,                        category: 'obgyn',             group: 'health' },
  { p: /medical\s*spa|medspa|med\s*spa|aesthetic|botox|laser\s*(?:hair|skin)/i,       category: 'medical_spa',       group: 'health' },
  { p: /assisted\s*living|memory\s*care|senior\s*living|skilled\s*nursing|nursing\s*home/i, category: 'senior_care',  group: 'health' },
  { p: /home\s*health|home\s*care|in-?home\s*care/i,                                  category: 'home_health',       group: 'health' },
  { p: /imaging|radiol|mri\b|x-?ray|diagnostic/i,                                     category: 'diagnostic_imaging',group: 'health' },
  { p: /pharmacy|drug\s*store|walgreen|cvs|rite\s*aid|publix\s*pharmacy/i,            category: 'pharmacy',          group: 'health' },
  { p: /lab(?:oratory)?\b|quest\s*diagnostic|labcorp|blood\s*draw/i,                  category: 'lab',               group: 'health' },
  { p: /dentist|dental|orthodont|endodont|periodont|oral\s*surgery|dmd|dds/i,         category: 'dental',            group: 'health' },

  // ── LEGAL: Subcategories ──
  { p: /personal\s*injury|accident\s*(?:attorney|lawyer)|car\s*accident\s*(?:attorney|lawyer)/i, category: 'personal_injury', group: 'legal' },
  { p: /criminal\s*(?:defense|attorney|lawyer)|dui\s*(?:attorney|lawyer)/i,           category: 'criminal_defense',  group: 'legal' },
  { p: /family\s*law|divorce|custody|adoption/i,                                      category: 'family_law',        group: 'legal' },
  { p: /real\s*estate\s*(?:attorney|law)|title\s*company|closing\s*(?:attorney|agent)/i, category: 'real_estate_law', group: 'legal' },
  { p: /immigration\s*(?:attorney|law)|visa\s*attorney/i,                             category: 'immigration_law',   group: 'legal' },
  { p: /estate\s*planning|probate|trust\s*(?:attorney|law)|will\s*attorney/i,        category: 'estate_planning',   group: 'legal' },
  { p: /business\s*(?:attorney|law)|corporate\s*(?:attorney|law)/i,                  category: 'business_law',      group: 'legal' },
  { p: /bankruptcy|debt\s*relief/i,                                                   category: 'bankruptcy',        group: 'legal' },
  { p: /cpa\b|certified\s*public\s*accountant|tax\s*(?:firm|accountant|service|prep)|accounting\s*firm/i, category: 'accounting', group: 'legal' },
  { p: /notary/i,                                                                      category: 'notary',            group: 'legal' },

  // ── HOSPITALITY: Subcategories ──
  { p: /marriott|hilton|hyatt|wyndham|ihg|intercontinental|westin|sheraton|ritz.?carlton|four\s*seasons|st\.?\s*regis/i, category: 'luxury_hotel', group: 'hospitality' },
  { p: /hampton\s*inn|courtyard|fairfield|residence\s*inn|springhill|towneplace|homewood|embassy\s*suites|doubletree/i, category: 'upscale_hotel', group: 'hospitality' },
  { p: /holiday\s*inn|best\s*western|comfort\s*inn|quality\s*inn|sleep\s*inn|days\s*inn|super\s*8|motel\s*6|econo|la\s*quinta|red\s*roof|budget/i, category: 'midscale_hotel', group: 'hospitality' },
  { p: /extended\s*stay|woodspring|candlewood|staybridge|homegate|value\s*place/i,    category: 'extended_stay',     group: 'hospitality' },
  { p: /resort\b|spa\s*resort|beach\s*resort|golf\s*resort|island\s*resort/i,        category: 'resort',            group: 'hospitality' },
  { p: /airbnb|vacation\s*rental|vrbo/i,                                              category: 'vacation_rental',   group: 'hospitality' },
  { p: /bed\s*&?\s*breakfast|b&b\b|inn\b/i,                                           category: 'inn_bnb',           group: 'hospitality' },

  // ── FITNESS: Subcategories ──
  { p: /planet\s*fitness|la\s*fitness|anytime\s*fitness|crunch\s*fitness|snap\s*fitness|24\s*hour\s*fitness|equinox|lifetime\s*fitness/i, category: 'gym_chain', group: 'fitness' },
  { p: /crossfit/i,                                                                    category: 'crossfit',          group: 'fitness' },
  { p: /pilates/i,                                                                     category: 'pilates',           group: 'fitness' },
  { p: /yoga/i,                                                                        category: 'yoga',              group: 'fitness' },
  { p: /orangetheory|f45|barry'?s\s*bootcamp|9round/i,                               category: 'boutique_fitness',  group: 'fitness' },
  { p: /martial\s*arts|karate|taekwondo|jiu.?jitsu|mma\b|boxing\s*gym|kickboxing/i,  category: 'martial_arts',      group: 'fitness' },
  { p: /cycling|spin\s*(?:class|studio)|solidcore/i,                                  category: 'cycling_studio',    group: 'fitness' },
  { p: /personal\s*train|personal\s*trainer/i,                                        category: 'personal_training', group: 'fitness' },

  // ── RETAIL: Subcategories ──
  { p: /home\s*depot|lowe'?s|ace\s*hardware|true\s*value|menards/i,                  category: 'home_improvement',  group: 'retail' },
  { p: /furniture|ashley\s*home|rooms?\s*to\s*go|havertys|bob'?s\s*furniture|ikea|pottery\s*barn/i, category: 'furniture', group: 'retail' },
  { p: /best\s*buy|apple\s*store|microsoft\s*store|gamestop|electronics/i,           category: 'electronics',       group: 'retail' },
  { p: /target|walmart|kmart|costco|sam'?s\s*club|bj'?s\s*wholesale/i,               category: 'mass_retail',       group: 'retail' },
  { p: /dick'?s\s*sporting|bass\s*pro|cabela'?s|academy\s*sports/i,                  category: 'sporting_goods',    group: 'retail' },
  { p: /pet(?:co|smart|\s*supplies|\s*store)\b/i,                                     category: 'pet_store',         group: 'retail' },
  { p: /auto\s*zone|o'?reilly\s*auto|advance\s*auto|napa\s*auto/i,                   category: 'auto_parts',        group: 'auto' },
  { p: /bookstore|book\s*shop|barnes\s*&?\s*noble/i,                                 category: 'bookstore',         group: 'retail' },
  { p: /boutique|women'?s\s*(?:clothing|fashion|apparel)|men'?s\s*(?:clothing|fashion|apparel)/i, category: 'clothing_boutique', group: 'retail' },
  { p: /victoria'?s\s*secret|bath\s*&\s*body|lush|sephora|ulta/i,                   category: 'beauty_retail',     group: 'retail' },
  { p: /thrift|goodwill|salvation\s*army|consignment/i,                               category: 'thrift',            group: 'retail' },
  { p: /vape|smoke\s*shop|tobacco/i,                                                  category: 'tobacco',           group: 'retail' },
  { p: /liquor\s*store|wine\s*shop|beer\s*store|total\s*wine/i,                      category: 'liquor_store',      group: 'retail' },

  // ── BANKING: Subcategories ──
  { p: /wells\s*fargo|bank\s*of\s*america|chase\s*bank|jpmorgan|citibank|suntrust|truist|regions\s*bank|td\s*bank|pnc\s*bank|us\s*bank|fifth\s*third|bb&t|boa\b/i, category: 'national_bank', group: 'banking' },
  { p: /credit\s*union|federal\s*credit/i,                                            category: 'credit_union',      group: 'banking' },
  { p: /community\s*bank|local\s*bank|savings\s*bank|savings\s*&\s*loan/i,           category: 'community_bank',    group: 'banking' },
  { p: /state\s*farm|allstate|geico|progressive|farmers\s*insurance|nationwide|usaa|liberty\s*mutual/i, category: 'insurance_national', group: 'banking' },
  { p: /insurance\s*agency|insurance\s*group|insurance\s*broker/i,                   category: 'insurance_agency',  group: 'banking' },
  { p: /financial\s*advisor|wealth\s*management|merrill\s*lynch|edward\s*jones|raymond\s*james|fidelity\s*investment|vanguard\s*advisor/i, category: 'financial_advisor', group: 'banking' },
  { p: /mortgage|home\s*loan|refinanc/i,                                              category: 'mortgage',          group: 'banking' },
  { p: /payday\s*loan|title\s*loan|cash\s*advance|check\s*cashing/i,                category: 'payday_lending',    group: 'banking' },
  { p: /atm\b/i,                                                                      category: 'atm',               group: 'banking' },

  // ── AUTO: Fix the healthcare/childcare misclassification ──
  { p: /hospital|medical\s*center|health\s*system|health\s*network|clinic|urgent\s*care|physician|doctor\s*office/i, category: 'clinic', group: 'health' },
  { p: /childcare|child\s*care|daycare|day\s*care|preschool|pre-?school|head\s*start|kiddie|kinder\s*care/i, category: 'childcare', group: 'civic' },
  { p: /car\s*(?:wash|detail)|auto\s*(?:wash|detail)|wash\s*(?:&|and)\s*detail/i,   category: 'car_wash',          group: 'auto' },
  { p: /auto\s*(?:repair|service|shop)|car\s*(?:repair|service)|mechanic|tire\s*(?:center|shop|store)|midas|jiffy\s*lube|pep\s*boys|firestone|goodyear|mavis/i, category: 'auto_repair', group: 'auto' },
  { p: /car\s*dealer|auto\s*dealer|ford\s*dealer|toyota\s*dealer|honda\s*dealer|chevrolet|nissan\s*dealer|used\s*car/i, category: 'car_dealer', group: 'auto' },
  { p: /towing|tow\s*truck|roadside\s*assist/i,                                      category: 'towing',            group: 'auto' },

  // ── BEAUTY: Subcategories ──
  { p: /salon|hair\s*salon|hair\s*studio|beauty\s*salon|great\s*clips|sport\s*clips|fantastic\s*sams|supercuts|ulta\s*beauty\s*salon/i, category: 'hair_salon', group: 'beauty' },
  { p: /barber|barbershop|barber\s*shop/i,                                            category: 'barbershop',        group: 'beauty' },
  { p: /nail\s*(?:salon|bar|studio)|manicure|pedicure/i,                             category: 'nail_salon',        group: 'beauty' },
  { p: /spa\b|day\s*spa|massage|massage\s*envy|hand\s*&\s*stone/i,                  category: 'spa_massage',       group: 'beauty' },
  { p: /wax|threading|eyebrow|lash\s*(?:studio|bar)|european\s*wax/i,               category: 'waxing_threading',  group: 'beauty' },
  { p: /dry\s*clean|laundry|laundromat|cleaners/i,                                   category: 'dry_cleaning',      group: 'beauty' },
  { p: /tattoo|piercing|ink\s*studio/i,                                               category: 'tattoo',            group: 'beauty' },
  { p: /tanning|spray\s*tan/i,                                                        category: 'tanning',           group: 'beauty' },

  // ── REAL ESTATE: Subcategories ──
  { p: /keller\s*williams|re\s*max|coldwell\s*banker|century\s*21|compass\s*real|exp\s*realty|berkshire\s*hathaway\s*home/i, category: 'real_estate_brokerage', group: 'real_estate' },
  { p: /property\s*management|hoa\s*management|community\s*management/i,             category: 'property_management',group: 'real_estate' },
  { p: /apartment|apartments\b|luxury\s*apt|flats\b/i,                               category: 'apartments',        group: 'real_estate' },
  { p: /self\s*storage|storage\s*unit|public\s*storage|extra\s*space|life\s*storage|cubesmart/i, category: 'self_storage', group: 'real_estate' },

  // ── PROFESSIONAL SERVICES: Rescue from LocalBusiness black hole ──
  { p: /cpa\b|accountant|bookkeeping|tax\s*(?:prep|service|advisor)/i,               category: 'accounting',        group: 'legal' },
  { p: /staffing|recruiting|headhunter|talent\s*agency/i,                            category: 'staffing',          group: 'professional' },
  { p: /marketing\s*agency|digital\s*marketing|seo\s*agency|ad\s*agency|media\s*agency/i, category: 'marketing_agency', group: 'professional' },
  { p: /it\s*(?:support|services|consulting)|managed\s*service|tech\s*support|computer\s*repair/i, category: 'it_services', group: 'professional' },
  { p: /insurance\b/i,                                                                category: 'insurance_agency',  group: 'banking' },
  { p: /printing|print\s*shop|signs?\s*(?:&|and)|signage|fedex\s*office|ups\s*store/i, category: 'printing_signs', group: 'services' },
  { p: /moving\s*company|movers?\b|moving\s*&\s*storage|relocation/i,               category: 'moving',            group: 'services' },
  { p: /cleaning\s*service|maid\s*service|janitorial|commercial\s*cleaning|molly\s*maid|merry\s*maids/i, category: 'cleaning_service', group: 'services' },
  { p: /security\s*(?:company|service|systems)|alarm\s*(?:company|systems)|adt\b/i, category: 'security',          group: 'services' },
  { p: /funeral\s*home|mortuary|cremation/i,                                          category: 'funeral_home',      group: 'services' },
  { p: /church\b|chapel\b|cathedral\b|ministry\b|gospel\b|baptist\b|methodist\b|lutheran\b|presbyterian\b|catholic\b|synagogue\b|mosque\b|temple\b/i, category: 'place_of_worship', group: 'civic' },
  { p: /school\b|academy\b|elementary\b|middle\s*school\b|high\s*school\b|k-?12\b/i,  category: 'school',           group: 'civic' },
  { p: /university\b|college\b|community\s*college\b/i,                               category: 'college',           group: 'civic' },
  { p: /gas\s*station|fuel\s*station|shell\b|chevron\b|exxon\b|bp\b|marathon\s*gas|circle\s*k|wawa\b|speedway\b|racetrac\b|murphy\s*usa/i, category: 'gas_station', group: 'fuel' },
  { p: /cvs\b|walgreen|rite\s*aid/i,                                                  category: 'pharmacy',          group: 'health' },
  { p: /grocery|supermarket|publix|winn.?dixie|aldi|trader\s*joe|whole\s*foods|sprouts|fresh\s*market|food\s*lion/i, category: 'grocery', group: 'grocery' },
  { p: /convenience\s*store|7-?eleven|circle\s*k|quicktrip|qt\b|wawa\b|buc-?ee/i,   category: 'convenience',       group: 'grocery' },
  { p: /veterinar|animal\s*hospital|animal\s*clinic|pet\s*(?:hospital|clinic|care)|banfield|vca\s*animal/i, category: 'veterinary', group: 'pets' },
  { p: /pet\s*(?:grooming|groomers?)\b|grooming\s*salon/i,                           category: 'pet_grooming',      group: 'pets' },
  { p: /construction|builder|general\s*contractor|home\s*builder|development\s*corp/i, category: 'general_contractor', group: 'construction' },
  { p: /electrician|electrical\s*(?:services|contractor)|wiring/i,                   category: 'electrician',       group: 'construction' },
  { p: /plumb|plumbing/i,                                                              category: 'plumber',           group: 'construction' },
  { p: /hvac|air\s*condition|heating\s*&\s*cooling|ac\s*repair|furnace/i,            category: 'hvac',              group: 'construction' },
  { p: /landscap|lawn\s*(?:care|service|mowing)|tree\s*(?:service|trim|removal)|sod\b/i, category: 'landscaping', group: 'construction' },
  { p: /pest\s*control|termite|exterminator|orkin|rollins|massey/i,                 category: 'pest_control',      group: 'construction' },
  { p: /painting\s*(?:company|contractor)|house\s*painter|interior\s*paint/i,       category: 'painting',          group: 'construction' },
  { p: /pool\s*(?:service|cleaning|repair|installation)|swimming\s*pool\s*company/i, category: 'pool_service',     group: 'construction' },
  { p: /flooring|tile\s*(?:installation|contractor)|hardwood\s*floor/i,             category: 'flooring',          group: 'construction' },
  { p: /fence\s*(?:company|contractor|installation)|fencing\b/i,                    category: 'fencing',           group: 'construction' },
  { p: /solar\s*(?:panel|energy|installation|company)/i,                             category: 'solar',             group: 'construction' },
];

async function reclassify() {
  // Pull all active businesses
  const { rows: businesses } = await pool.query(
    `SELECT business_id, name, category, category_group FROM businesses WHERE status='active'`
  );

  console.log(`Total businesses to classify: ${businesses.length}`);

  let updates = [];
  let matched = 0;

  for (const biz of businesses) {
    const name = biz.name || '';
    for (const rule of RULES) {
      if (rule.p.test(name)) {
        // Only update if something actually changes
        if (biz.category !== rule.category || biz.category_group !== rule.group) {
          updates.push({ business_id: biz.business_id, category: rule.category, group: rule.group });
          matched++;
        }
        break; // first match wins
      }
    }
  }

  console.log(`Matched and need update: ${matched}`);
  console.log(`Unmatched (staying as-is): ${businesses.length - matched}`);

  // Batch update in chunks of 500
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    // Build bulk update using unnest
    const ids     = chunk.map(u => u.business_id);
    const cats    = chunk.map(u => u.category);
    const groups  = chunk.map(u => u.group);
    await pool.query(
      `UPDATE businesses SET category = vals.cat, category_group = vals.grp
       FROM (SELECT unnest($1::uuid[]) as business_id, unnest($2::text[]) as cat, unnest($3::text[]) as grp) vals
       WHERE businesses.business_id = vals.business_id`,
      [ids, cats, groups]
    );
    updated += chunk.length;
    process.stdout.write(`\rUpdated: ${updated}/${updates.length}`);
  }
  console.log('\nDone.');

  // Show before/after breakdown
  const after = await pool.query(
    `SELECT category_group, category, COUNT(*) as cnt
     FROM businesses WHERE status='active'
     GROUP BY category_group, category
     ORDER BY category_group, cnt DESC`
  );

  let cur = '';
  after.rows.forEach(r => {
    if (r.category_group !== cur) { cur = r.category_group; console.log('\n=== ' + cur.toUpperCase() + ' ==='); }
    console.log('  ' + (r.category || 'NULL') + ': ' + r.cnt);
  });

  // Collapse risk after
  const collapse = await pool.query(`
    WITH top AS (
      SELECT category_group, MAX(cnt) as top_cnt, SUM(cnt) as total_cnt
      FROM (SELECT category_group, category, COUNT(*) as cnt FROM businesses WHERE status='active' GROUP BY category_group, category) sub
      GROUP BY category_group
    )
    SELECT category_group, ROUND(top_cnt::numeric/total_cnt*100,1) as pct_in_top, top_cnt, total_cnt
    FROM top ORDER BY pct_in_top DESC
  `);
  console.log('\n=== COLLAPSE RISK AFTER ===');
  collapse.rows.forEach(r => console.log(r.category_group + ': ' + r.pct_in_top + '% (' + r.top_cnt + '/' + r.total_cnt + ')'));

  await pool.end();
}

reclassify().catch(e => { console.error(e.message); process.exit(1); });
