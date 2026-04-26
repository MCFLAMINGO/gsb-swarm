/**
 * reclassify_categories.js
 * ─────────────────────────────────────────────────────────────────────────────
 * LocalIntel classification pipeline step 1.
 * Runs deterministically against ALL active businesses:
 *   - Matches 100+ name-pattern rules → sets category + category_group
 *   - Marks classification_attempted_at on every record touched
 *   - Downgrades records stuck as 'LocalBusiness' for >48h to 'uncategorized'
 *   - Logs run stats to pipeline_runs table
 *
 * Designed to run on a schedule (Railway cron via POST /admin/pipeline/reclassify)
 * and also on-demand: node scripts/reclassify_categories.js
 *
 * Zero LLM calls. Pure deterministic string matching.
 * ─────────────────────────────────────────────────────────────────────────────
 */

'use strict';
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.LOCAL_INTEL_DB_URL
    || 'postgresql://postgres:myufFnkSigImGnSylwyIjYmLCvkthQUr@turntable.proxy.rlwy.net:25739/railway',
  ssl: { rejectUnauthorized: false },
});

// ─── RULES ────────────────────────────────────────────────────────────────────
// Applied IN ORDER — first match wins per business.
// More specific patterns must come before general ones.
// Each rule: { p: /regex/i, category: string, group: string }

const RULES = [

  // ── FINE DINING (before generic restaurant) ──
  { p: /inn\s*&\s*club|country\s*club|yacht\s*club|city\s*club|supper\s*club/i,       category: 'fine_dining',        group: 'food' },
  { p: /ruth'?s\s*chris|capital\s*grille|ocean\s*prime|flemings|eddie\s*v'?s|truluck|bonefish\s*grill/i, category: 'fine_dining', group: 'food' },
  { p: /medure|black\s*pearl|st\.?\s*tropez\s*bistro|estiatorio\s*milos|timo\s*italian/i, category: 'fine_dining',   group: 'food' },
  { p: /steakhouse|steak\s*house|chophouse|chop\s*house/i,                              category: 'steakhouse',        group: 'food' },

  // ── FAST FOOD CHAINS ──
  { p: /mcdonald'?s|burger\s*king|wendy'?s|taco\s*bell|chick-?fil-?a|popeyes|kfc|sonic\s*drive|jack\s*in\s*the\s*box|five\s*guys|whataburger|checkers|rallys|hardee'?s|carl'?s\s*jr/i, category: 'fast_food', group: 'food' },
  { p: /domino'?s|pizza\s*hut|papa\s*john'?s|little\s*caesars|papa\s*murphy/i,          category: 'pizza',             group: 'food' },
  { p: /subway|jimmy\s*john'?s|jersey\s*mike|firehouse\s*subs|quiznos|potbelly/i,       category: 'sandwich',          group: 'food' },
  { p: /chipotle|moe'?s\s*south|qdoba|willy'?s\s*mex|tijuana\s*flats/i,                category: 'fast_casual_mexican',group: 'food' },

  // ── CASUAL / CHAIN DINING ──
  { p: /applebee'?s|chili'?s|t\.?g\.?i\.?\s*friday|olive\s*garden|outback|longhorn|red\s*lobster|cracker\s*barrel|denny'?s|ihop|waffle\s*house|bob\s*evans/i, category: 'casual_dining', group: 'food' },
  { p: /bahama\s*breeze|yard\s*house|buffalo\s*wild\s*wings|bj'?s\s*restaurant|red\s*robin|hooters|twin\s*peaks/i, category: 'casual_dining', group: 'food' },

  // ── CUISINE / SPECIALTY FOOD ──
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
  { p: /\bbar\b|lounge|nightclub|night\s*club|saloon/i,                                category: 'bar',               group: 'food' },
  { p: /restaurant|eatery|grill\b|grille\b|kitchen\b|bistro|brasserie/i,               category: 'restaurant',        group: 'food' },

  // ── GROCERY / CONVENIENCE ──
  { p: /publix|winn-?dixie|aldi|whole\s*foods|trader\s*joe|sprouts|kroger|safeway|food\s*lion|iga\b/i, category: 'grocery', group: 'grocery' },
  { p: /grocery|supermarket|food\s*mart|food\s*store|market\b/i,                       category: 'grocery',           group: 'grocery' },
  { p: /dollar\s*general|dollar\s*tree|family\s*dollar|five\s*below/i,                 category: 'discount_store',    group: 'retail' },
  { p: /7-?eleven|circle\s*k|wawa\b|kangaroo\s*express|racetrac|speedway|sunoco\s*express|convenience\s*store/i, category: 'convenience', group: 'grocery' },

  // ── FUEL / GAS ──
  { p: /texaco|shell\b|bp\b|exxon|mobil\b|chevron|sunoco|hess\b|marathon\b|speedway\b|citgo|murphy\s*usa|gate\s*petroleum|race\s*trac|gas\s*station|fuel\s*stop/i, category: 'gas_station', group: 'fuel' },

  // ── HEALTH — HOSPITALS / EMERGENCY ──
  { p: /memorial\s*hospital|baptist\s*medical|mayo\s*clinic|uf\s*health|st\.?\s*vincent|flagler\s*hospital|wolfson\s*children|ascension|hca\s*florida|advent\s*health|nemours/i, category: 'hospital', group: 'health' },
  { p: /emergency\s*room|\ber\b.*hospital|level\s*[i1]\s*trauma|trauma\s*center/i,     category: 'emergency_room',    group: 'health' },

  // ── HEALTH — URGENT CARE ──
  { p: /urgent\s*care|carespot|nextcare|medexpress|concentra|patient\s*first|fast\s*med|statcare/i, category: 'urgent_care', group: 'health' },

  // ── HEALTH — SPECIALTY CLINICS ──
  { p: /mental\s*health|behavioral\s*health|counseling|therapist|psychiatr|psycholog|addiction\s*(?:treatment|recovery)|substance\s*abuse/i, category: 'mental_health', group: 'health' },
  { p: /physical\s*therap|pt\s*clinic|rehab\s*(?:center|clinic)|sports\s*rehab/i,      category: 'physical_therapy',  group: 'health' },
  { p: /chiropractic|chiropractor/i,                                                    category: 'chiropractic',      group: 'health' },
  { p: /optometr|ophthalmolog|vision\s*center|eye\s*care|eye\s*clinic|eyeglass|lenscrafters|for\s*eyes/i, category: 'optometry', group: 'health' },
  { p: /obgyn|ob-?gyn|obstetrics|gynecolog|women'?s\s*(?:health|care)\s*(?:center|clinic)/i, category: 'obgyn', group: 'health' },
  { p: /cardiology|cardiologist|heart\s*(?:care|center|clinic)/i,                      category: 'cardiology',        group: 'health' },
  { p: /orthoped|orthopaedic|bone\s*&\s*joint|spine\s*(?:center|clinic)|joint\s*replacement/i, category: 'orthopedics', group: 'health' },
  { p: /dermatolog|skin\s*(?:care|clinic|center)/i,                                    category: 'dermatology',       group: 'health' },
  { p: /neurolog|neuroscience\s*center/i,                                              category: 'neurology',         group: 'health' },
  { p: /dentist|dental|orthodont|endodont|periodont|oral\s*surgery|smile\s*design/i,   category: 'dental',            group: 'health' },
  { p: /pharmacy|drug\s*store|walgreens|cvs\b|rite\s*aid|pill\s*pack/i,               category: 'pharmacy',          group: 'health' },
  { p: /assisted\s*living|memory\s*care|senior\s*living|nursing\s*home|skilled\s*nursing/i, category: 'senior_care', group: 'health' },
  { p: /home\s*health|home\s*care\s*(?:agency|services)|visiting\s*nurse/i,            category: 'home_health',       group: 'health' },
  { p: /medical\s*lab|clinical\s*lab|laboratory\b|quest\s*diagnostics|labcorp/i,       category: 'lab',               group: 'health' },
  { p: /pediatric|children'?s\s*(?:clinic|medical)/i,                                  category: 'pediatrics',        group: 'health' },
  { p: /plastic\s*surgery|cosmetic\s*surgery|aesthetic\s*(?:center|clinic)|med\s*spa|medspa/i, category: 'aesthetics', group: 'health' },
  { p: /veterinar|animal\s*(?:hospital|clinic|care)|pet\s*(?:clinic|hospital)/i,       category: 'veterinary',        group: 'pets' },
  { p: /physician|doctor'?s?\s*office|medical\s*(?:center|associates|group|clinic)|family\s*(?:medicine|practice|health)|primary\s*care|internal\s*medicine/i, category: 'clinic', group: 'health' },

  // ── FITNESS ──
  { p: /planet\s*fitness|anytime\s*fitness|la\s*fitness|gold'?s\s*gym|crunch\s*fitness|24\s*hour\s*fitness|lifetime\s*fitness|orangetheory|f45|solidcore/i, category: 'gym_chain', group: 'fitness' },
  { p: /crossfit\b/i,                                                                   category: 'crossfit',          group: 'fitness' },
  { p: /yoga\b|yoga\s*studio|hot\s*yoga|yoga\s*works|corepower/i,                      category: 'yoga_studio',       group: 'fitness' },
  { p: /pilates/i,                                                                      category: 'pilates',           group: 'fitness' },
  { p: /\bbarre\b(?!.*(?:barrel|barrel|cracker))/i,                                    category: 'barre_studio',      group: 'fitness' },
  { p: /martial\s*arts|karate|judo|jiu-?jitsu|taekwondo|mma\s*(?:gym|training)|boxing\s*(?:gym|club)/i, category: 'martial_arts', group: 'fitness' },
  { p: /swim\s*(?:school|lesson|club|academy)|aquatic\s*center/i,                      category: 'swim_school',       group: 'fitness' },
  { p: /dance\s*(?:studio|academy|school|center)|ballet|ballroom/i,                    category: 'dance_studio',      group: 'fitness' },
  { p: /gym\b|fitness\s*(?:center|studio|club)|athletic\s*club|health\s*club|workout/i,category: 'gym',               group: 'fitness' },
  { p: /fyzical|physical\s*fitness\s*(?:center|studio)/i,                              category: 'gym',               group: 'fitness' },

  // ── AUTO ──
  { p: /auto\s*(?:repair|service|shop|care|fix)|car\s*(?:repair|service|care)|mechanic|tire\s*(?:center|shop|store)|midas|jiffy\s*lube|pep\s*boys|firestone|goodyear|mavis|valvoline/i, category: 'auto_repair', group: 'auto' },
  { p: /auto\s*(?:sales|dealer)|car\s*dealer|used\s*cars?|new\s*cars?|toyota|honda|ford\b|chevy|chevrolet|nissan|hyundai|kia\b|bmw\b|mercedes|audi\b|volkswagen|subaru|mazda|jeep\b/i, category: 'auto_dealer', group: 'auto' },
  { p: /auto\s*glass|windshield\s*(?:repair|replacement)/i,                            category: 'auto_glass',        group: 'auto' },
  { p: /auto\s*body|collision\s*(?:center|repair)|body\s*shop/i,                       category: 'auto_body',         group: 'auto' },
  { p: /towing|roadside\s*assistance|wrecker/i,                                        category: 'towing',            group: 'auto' },
  { p: /rv\b|recreational\s*vehicle|motorhome|boat\s*(?:dealer|repair|service)|marine\b/i, category: 'rv_marine', group: 'auto' },
  { p: /automotive|automotor|autoshop/i,                                               category: 'auto_repair',       group: 'auto' },

  // ── REAL ESTATE ──
  { p: /keller\s*williams|re\/max|coldwell\s*banker|century\s*21|berkshire\s*hathaway|exp\s*realty|sotheby'?s|compass\s*real/i, category: 'real_estate_agency', group: 'real_estate' },
  { p: /pulte\s*homes|lennar|kb\s*home|dr\s*horton|meritage|toll\s*brothers|ryan\s*homes|richmond\s*american/i, category: 'home_builder', group: 'real_estate' },
  { p: /apartments?|at\s+(?:the\s+)?(?:oakleaf|nocatee|palms|landings|commons|reserve|crossing|village|pointe|lakes|springs|cove|grove|pines|oaks|villas|ridge|place|park|court|manor|terrace|gardens|heights|point)\b/i, category: 'apartment_complex', group: 'real_estate' },
  { p: /real\s*estate|realty|realtor|property\s*management|liz\s*buys|sell\s*my\s*house|sell\s*your\s*home|we\s*buy\s*houses|cash\s*for\s*homes?/i, category: 'real_estate', group: 'real_estate' },
  { p: /home\s*inspection|property\s*inspection/i,                                     category: 'home_inspection',   group: 'construction' },
  { p: /mortgage|home\s*loan|refinanc|lending\s*(?:group|corp)|loan\s*officer/i,       category: 'mortgage',          group: 'banking' },

  // ── BANKING / FINANCIAL ──
  { p: /bank\s*of\s*america|wells\s*fargo|chase\s*bank|citibank|suntrust|bb&t|regions\s*bank|truist|td\s*bank|fifth\s*third|pnc\s*bank|capital\s*one\s*bank/i, category: 'bank_branch', group: 'banking' },
  { p: /credit\s*union|federal\s*credit|community\s*bank|savings\s*bank|state\s*bank/i,category: 'credit_union',      group: 'banking' },
  { p: /aflac|blue\s*cross|united\s*health|aetna|cigna|humana|florida\s*blue|nationwide\s*insurance|allstate|state\s*farm|progressive\s*insurance|geico|liberty\s*mutual|farmers\s*insurance|travelers\s*insurance/i, category: 'insurance', group: 'banking' },
  { p: /insurance\s*(?:agency|group|company|broker)|farm\s*bureau\b/i,                 category: 'insurance',         group: 'banking' },
  { p: /financial\s*(?:planning|advisor|services|group)|wealth\s*management|investment\s*advisor|thrivent|primerica|edward\s*jones|ameriprise|vanguard\s*advisor/i, category: 'financial_advisor', group: 'banking' },
  { p: /tax\s*(?:preparation|service|relief|advisor)|h&r\s*block|jackson\s*hewitt|liberty\s*tax|cpa\s*firm|accounting\s*firm|bookkeeping/i, category: 'accounting', group: 'professional' },

  // ── LEGAL ──
  { p: /attorney|law\s*(?:firm|office|group)|lawyer|legal\s*(?:services|aid|shield)|legalshield/i, category: 'law_firm', group: 'legal' },

  // ── CONSTRUCTION — TRADES (expanded) ──
  { p: /roofing|roofer|roof\s*(?:repair|replacement|install)/i,                        category: 'roofing',           group: 'construction' },
  { p: /electrician|electrical\s*(?:services|contractor|company)|electric\s*(?:repair|install)|wiring\s*(?:service|company)/i, category: 'electrician', group: 'construction' },
  { p: /plumb(?:er|ing)|sewer\s*(?:repair|service)|drain\s*(?:cleaning|service)|water\s*heater|pipe\s*(?:repair|install)/i, category: 'plumber', group: 'construction' },
  { p: /hvac|air\s*(?:conditioning|condition|handler|cool)|heating\s*(?:&|and)\s*(?:cooling|air)|heat\s*pump|furnace\s*repair|ac\s*(?:repair|install|service)|cooling\s*(?:service|system)/i, category: 'hvac', group: 'construction' },
  // "air home services", "air services", "air systems" — catch generic "air" trade names
  { p: /\bair\s+(?:home\s+)?services?\b|\bair\s+systems?\b|\bair\s+(?:tech|solutions|pro|plus|one|works?)\b/i, category: 'hvac', group: 'construction' },
  { p: /pest\s*control|exterminator|termite|bug\s*(?:control|man)|orkin|massey\s*services/i, category: 'pest_control', group: 'construction' },
  { p: /landscap|lawn\s*(?:care|service|mowing|maintenance)|sod\s*(?:install|farm)|tree\s*(?:service|trim|removal|surgery)|arborist|treemasters?|grounds?\s*(?:keeping|maintenance)/i, category: 'landscaping', group: 'construction' },
  { p: /painting\s*(?:company|contractor|service)|house\s*painter|interior\s*(?:&|and)\s*exterior\s*paint|paint\s*(?:pro|plus|works?|masters?)/i, category: 'painting', group: 'construction' },
  { p: /pool\s*(?:service|cleaning|repair|build|install|company)|swimming\s*pool|spa\s*(?:repair|service)|pool\s*contractor/i, category: 'pool_service', group: 'construction' },
  { p: /pool\s*enclosure|screen\s*enclosure|lanai\s*(?:screen|enclosure|build|install|repair)|screen\s*room|patio\s*enclosure|florida\s*room/i, category: 'screen_enclosure', group: 'construction' },
  { p: /flooring|tile\s*(?:installation|contractor|work)|hardwood\s*floor|laminate\s*floor|carpet\s*install/i, category: 'flooring', group: 'construction' },
  { p: /fence\s*(?:company|contractor|installation|builder)|fencing\b|vinyl\s*fence|wood\s*fence|iron\s*fence/i, category: 'fencing', group: 'construction' },
  { p: /solar\s*(?:panel|energy|power|installation|company|system)|photovoltaic/i,     category: 'solar',             group: 'construction' },
  { p: /irrigation\s*(?:system|install|repair|service)|sprinkler\s*(?:system|repair|install)|lawn\s*irrigation/i, category: 'irrigation', group: 'construction' },
  { p: /masonry|brick\s*(?:work|layer|mason)|stone\s*(?:work|mason|contractor)|block\s*(?:work|mason)/i, category: 'masonry', group: 'construction' },
  { p: /concrete\s*(?:contractor|company|work|pour|repair)|above\s*average\s*concrete|stamped\s*concrete|driveway\s*(?:paving|install)/i, category: 'concrete', group: 'construction' },
  { p: /window\s*(?:repair|replacement|install)|door\s*(?:repair|replacement|install)|window\s*&\s*door|windows?\s*(?:and|&)\s*doors?/i, category: 'window_door', group: 'construction' },
  { p: /drywall|sheetrock|plaster\s*(?:repair|contractor)/i,                           category: 'drywall',           group: 'construction' },
  { p: /handyman|honey-?do|home\s*(?:repair\s*services|fix-?it)|odd\s*jobs/i,          category: 'handyman',          group: 'construction' },
  { p: /home\s*theater|home\s*theatre|home\s*cinema|av\s*installation|audio\s*video\s*install|media\s*room|custom\s*av|smart\s*home\s*install/i, category: 'home_theater', group: 'construction' },
  { p: /interior\s*design(?:er|s)?|interior\s*decorator|space\s*planning|home\s*stag/i, category: 'interior_design',  group: 'construction' },
  { p: /land\s*surveyor|surveying\s*(?:company|services)|survey\s*(?:group|associates)/i, category: 'surveying',      group: 'construction' },
  { p: /pressure\s*wash|power\s*wash|soft\s*wash/i,                                   category: 'pressure_washing',  group: 'construction' },
  { p: /septic\s*(?:tank|service|pump|install)|drain\s*field/i,                        category: 'septic',            group: 'construction' },
  { p: /gutter\s*(?:install|clean|repair|guard)|leaf\s*guard/i,                        category: 'gutters',           group: 'construction' },
  { p: /insulation\s*(?:contractor|install|company)/i,                                 category: 'insulation',        group: 'construction' },
  // Catch-all contracting patterns LAST in construction block
  { p: /cnstrctn|contracting\b|contractor\b|construction\b|remodel|renovation|home\s*improvement/i, category: 'general_contractor', group: 'construction' },

  // ── RETAIL ──
  { p: /walmart|target\b|costco|sam'?s\s*club|bjs\b|big\s*lots|ross\b|tj\s*maxx|marshalls|burlington\s*coat|tuesday\s*morning/i, category: 'big_box', group: 'retail' },
  { p: /home\s*depot|lowe'?s|ace\s*hardware|true\s*value|menards/i,                   category: 'hardware_store',    group: 'retail' },
  { p: /best\s*buy|apple\s*store|microsoft\s*store|b&h\s*photo|fry'?s\s*electronics/i, category: 'electronics_store', group: 'retail' },
  { p: /wig\s*shop|beauty\s*supply|sally\s*beauty|ulta\b|sephora/i,                   category: 'beauty_supply',     group: 'retail' },
  { p: /furniture\s*(?:store|gallery|outlet)|ashley\s*furniture|rooms?\s*to\s*go|ikea|wayfair\s*store/i, category: 'furniture', group: 'retail' },
  { p: /mattress\s*(?:firm|one|store)|sleep\s*number|tempurpedic\s*store/i,           category: 'mattress',          group: 'retail' },
  { p: /thrift\s*(?:store|shop)|goodwill|salvation\s*army|consignment/i,              category: 'thrift_store',      group: 'retail' },
  { p: /pawn\s*shop|pawnbroker/i,                                                      category: 'pawn',              group: 'retail' },
  { p: /boutique|clothing\s*(?:store|boutique)|apparel|fashion\s*(?:store|boutique)/i, category: 'clothing',          group: 'retail' },
  { p: /sporting\s*goods|dick'?s\s*sporting|bass\s*pro|cabela'?s|academy\s*sports|rei\b/i, category: 'sporting_goods', group: 'retail' },
  { p: /nursery\b|garden\s*center|plant\s*(?:nursery|shop)|greenhouse/i,              category: 'nursery',           group: 'retail' },

  // ── BEAUTY / PERSONAL CARE ──
  { p: /great\s*clips|sport\s*clips|supercuts|cost\s*cutters|fantastic\s*sams|floyd'?s\s*barbershop/i, category: 'hair_chain', group: 'beauty' },
  { p: /barber\s*(?:shop|salon)|barbershop/i,                                          category: 'barbershop',        group: 'beauty' },
  { p: /hair\s*salon|salon\b|beauty\s*salon|blow\s*dry|extensions\b|great\s*extensions/i, category: 'hair_salon',    group: 'beauty' },
  { p: /nail\s*(?:salon|studio|spa)|manicure|pedicure/i,                               category: 'nail_salon',        group: 'beauty' },
  { p: /massage\s*(?:therapy|therapist|envy|heights)|day\s*spa|full\s*service\s*spa/i, category: 'massage_spa',       group: 'beauty' },
  { p: /tattoo|piercing\s*studio/i,                                                    category: 'tattoo',            group: 'beauty' },
  { p: /tanning\s*(?:salon|bed|studio)|spray\s*tan/i,                                  category: 'tanning',           group: 'beauty' },

  // ── HOSPITALITY ──
  { p: /marriott|hilton|hyatt|sheraton|westin|four\s*seasons|ritz-?carlton|mandarin\s*oriental/i, category: 'upscale_hotel', group: 'hospitality' },
  { p: /hampton\s*inn|courtyard|fairfield|residence\s*inn|springhill|towneplace|homewood|embassy\s*suites|doubletree/i, category: 'upscale_hotel', group: 'hospitality' },
  { p: /holiday\s*inn|best\s*western|comfort\s*inn|days\s*inn|motel\s*6|super\s*8|quality\s*inn|la\s*quinta/i, category: 'budget_hotel', group: 'hospitality' },
  { p: /hotel|resort\b|inn\b|motel\b|suites\b|bed\s*&\s*breakfast|b&b\b/i,            category: 'hotel',             group: 'hospitality' },
  { p: /vacation\s*rental|airbnb\s*property|short\s*term\s*rental/i,                  category: 'vacation_rental',   group: 'hospitality' },

  // ── EDUCATION ──
  { p: /preschool|pre-?k\b|kindergarten|daycare|day\s*care|child\s*care|learning\s*center\s*(?:for\s*kids)?|little\s*gym|kumon|sylvan\s*learning/i, category: 'childcare', group: 'civic' },
  { p: /elementary\s*school|middle\s*school|high\s*school|charter\s*school|private\s*school|academy\b/i, category: 'school', group: 'civic' },
  { p: /college\b|university|community\s*college|vocational\s*school|trade\s*school/i, category: 'college',           group: 'civic' },
  { p: /tutoring|test\s*prep|sat\s*prep|learning\s*center|huntington\s*learning/i,    category: 'tutoring',          group: 'civic' },

  // ── CIVIC / GOVERNMENT / NONPROFIT ──
  { p: /church|chapel|cathedral|parish|ministry|baptist\b.*(?:church|fellowship)|methodist|presbyterian|pentecostal|evangelical|congregation/i, category: 'church', group: 'civic' },
  { p: /mosque|islamic\s*center|masjid/i,                                              category: 'mosque',            group: 'civic' },
  { p: /synagogue|jewish\s*center|temple\b(?!.*fitness)/i,                            category: 'synagogue',         group: 'civic' },
  { p: /fire\s*(?:station|department|rescue)|ems\b|emergency\s*services\s*(?:dept|station)/i, category: 'fire_station', group: 'civic' },
  { p: /police\s*(?:dept|department|station)|sheriff'?s?\s*office/i,                  category: 'police_station',    group: 'civic' },
  { p: /library\b|public\s*library/i,                                                  category: 'library',           group: 'civic' },
  { p: /post\s*office|usps\s*(?:branch|location)/i,                                   category: 'post_office',       group: 'civic' },
  { p: /community\s*center|rec(?:reation)?\s*center|ymca|ywca/i,                      category: 'community_center',  group: 'civic' },
  { p: /against\s*pedophiles|victims\s*advocacy|food\s*bank|homeless\s*shelter|habitat\s*for\s*humanity/i, category: 'nonprofit', group: 'civic' },

  // ── PETS ──
  { p: /petco|petsmart|pet\s*supermarket|pet\s*supplies/i,                             category: 'pet_store',         group: 'pets' },
  { p: /pet\s*(?:grooming|groomer)|dog\s*grooming|cat\s*grooming/i,                   category: 'pet_grooming',      group: 'pets' },
  { p: /dog\s*(?:training|trainer)|puppy\s*(?:training|class)|obedience\s*school/i,   category: 'dog_training',      group: 'pets' },
  { p: /pet\s*(?:boarding|hotel|resort)|doggy\s*day\s*care|kennel\b/i,               category: 'pet_boarding',      group: 'pets' },

  // ── PROFESSIONAL SERVICES ──
  { p: /staffing|temp\s*agency|employment\s*agency|recruiting\s*(?:firm|agency)/i,    category: 'staffing',          group: 'professional' },
  { p: /marketing\s*(?:agency|firm|group)|advertising\s*(?:agency|firm)|seo\s*(?:agency|company)|digital\s*marketing/i, category: 'marketing_agency', group: 'professional' },
  { p: /it\s*(?:support|services|consulting)|managed\s*service|tech\s*support|computer\s*repair|network\s*(?:install|support)/i, category: 'it_services', group: 'professional' },
  { p: /printing\s*(?:company|service)|print\s*shop|sign\s*(?:company|shop)|signage/i,category: 'printing',          group: 'professional' },
  { p: /funeral\s*home|mortuary|cremation\s*(?:service|center)/i,                     category: 'funeral_home',      group: 'professional' },
  { p: /moving\s*(?:company|service)|mover\b|relocation\s*service|transport\s*(?:company|inc)|moving\s*&\s*storage/i, category: 'moving', group: 'services' },
  { p: /storage\s*(?:facility|unit|center)|self\s*storage|mini\s*storage/i,           category: 'storage',           group: 'services' },
  { p: /cleaning\s*(?:service|company)|maid\s*service|janitorial|housekeeping|commercial\s*clean/i, category: 'cleaning', group: 'services' },
  { p: /security\s*(?:system|company|service|guard|patrol)|alarm\s*system/i,          category: 'security',          group: 'professional' },
  { p: /photography|photographer|photo\s*studio|videography|videographer/i,           category: 'photography',       group: 'professional' },
  { p: /telematics|fleet\s*management|gps\s*tracking|logistics\s*(?:company|tech)/i, category: 'logistics_tech',    group: 'professional' },
  { p: /charter\s*(?:boat|fishing|tour)|fishing\s*charter|boat\s*tour/i,              category: 'charter',           group: 'services' },
  { p: /land\s*(?:company|co\b)|property\s*(?:co\b|company)|land\s*(?:holdings|group)/i, category: 'land_company',  group: 'real_estate' },

  // ── SERVICES (catch-all trades) ──
  { p: /preservation\s*(?:company|services)|property\s*preservation/i,                category: 'property_services', group: 'services' },
  { p: /transport(?:ation)?\s*(?:inc|co|company|group|services?)|trucking\b|freight\b|logistics\b(?!\s*tech)/i, category: 'transport', group: 'services' },
  { p: /auction\s*(?:house|company)|auctioneer/i,                                     category: 'auction',           group: 'services' },

  // ── HIGH-FREQUENCY WORD CATCH-ALLS (run last — broad signals) ──
  // Hair: any name containing "hair" is almost always a salon
  { p: /hair/i,                                                                        category: 'hair_salon',        group: 'beauty' },
  // Pharmacy: pharm prefix covers pharmacy, pharmaceuticals, pharmD
  { p: /\bpharm/i,                                                                     category: 'pharmacy',          group: 'health' },
  // Garage: standalone garage = auto service
  { p: /\bgarage\b/i,                                                                  category: 'auto_repair',       group: 'auto' },
  // Mart: food mart, super mart, etc.
  { p: /\bmart\b/i,                                                                    category: 'grocery',           group: 'grocery' },
  // Foods: "XYZ Foods" → grocery
  { p: /\bfoods\b/i,                                                                   category: 'grocery',           group: 'grocery' },
  // Attorney abbreviation: Atty
  { p: /\batty\b/i,                                                                    category: 'law_firm',          group: 'legal' },
  // Shear / ShearMadness type names → hair salon
  { p: /shear/i,                                                                       category: 'hair_salon',        group: 'beauty' },
  // Kids care / child care variants
  { p: /\bkids?\s*care\b|\bchild\s*care\b|\bchildcare\b/i,                            category: 'childcare',         group: 'civic' },
  // Repair (generic) → handyman unless already matched above
  { p: /\brepair\b/i,                                                                  category: 'handyman',          group: 'construction' },
  // Wellness / nutrition standalone → health clinic
  { p: /\bwellness\b|\bnutrition\s*(?:center|clinic|studio)\b/i,                      category: 'clinic',            group: 'health' },
  // Energy solutions → solar/construction
  { p: /\benergy\s*(?:solutions?|services?|group|systems?)\b/i,                        category: 'solar',             group: 'construction' },
  // Auto (standalone) → auto repair
  { p: /\bauto\b/i,                                                                    category: 'auto_repair',       group: 'auto' },

  // ── NAMED ENTITY CATCH-ALLS (known chains/brands not caught above) ──
  { p: /\bmd\b|\bdo\b|\bdds\b|\brph\b|\bpa\b.*(?:medicine|medical|health)|\bm\.d\.|\bd\.o\./i, category: 'clinic', group: 'health' },
  { p: /childtime|learning\s*care\s*group|kindercare|bright\s*horizons|la\s*petite|primrose/i, category: 'childcare', group: 'civic' },
  { p: /first\s*watch|first\s*watch\s*restaurant/i,                                  category: 'restaurant',        group: 'food' },
  { p: /puppy\s*play|doggy\s*day|dog\s*day/i,                                        category: 'pet_boarding',      group: 'pets' },
  { p: /\blaw\b.*(?:group|firm|office|pllc|llp)|pllc$|\bllp\b|\bp\.c\.$|esq\b/i,    category: 'law_firm',          group: 'legal' },
  { p: /development\s*(?:corp|llc|group|co|company)|land\s*development/i,            category: 'real_estate',       group: 'real_estate' },
  { p: /organic(?:als?|s)?\s*(?:market|store|shop|cafe)|natural\s*(?:market|foods?|health)/i, category: 'health_food', group: 'food' },
  { p: /maintenance\s*(?:services?|company|group)/i,                                  category: 'handyman',          group: 'construction' },
  { p: /india\s*(?:restaurant|cuisine|kitchen|grill|bistro)|gateway\s*to\s*india|taste\s*of\s*india/i, category: 'asian', group: 'food' },
  { p: /studio\s*(?:plus|suites?|apartments?)/i,                                      category: 'apartment_complex', group: 'real_estate' },

];

// ─── PIPELINE FUNCTION ────────────────────────────────────────────────────────
/**
 * runClassificationPipeline()
 * Can be called from cron endpoint or CLI.
 * Returns a stats object for logging.
 */
async function runClassificationPipeline() {
  const startedAt = new Date();
  console.log(`[reclassify] Pipeline start: ${startedAt.toISOString()}`);

  // 1. Pull all active businesses
  const { rows: businesses } = await pool.query(
    `SELECT business_id, name, category, category_group FROM businesses WHERE status='active'`
  );
  console.log(`[reclassify] Total active businesses: ${businesses.length}`);

  let updates = [];
  let matched = 0;
  let alreadyCorrect = 0;

  for (const biz of businesses) {
    const name = biz.name || '';
    for (const rule of RULES) {
      if (rule.p.test(name)) {
        if (biz.category !== rule.category || biz.category_group !== rule.group) {
          updates.push({
            business_id: biz.business_id,
            category: rule.category,
            group: rule.group,
          });
          matched++;
        } else {
          alreadyCorrect++;
        }
        break; // first match wins
      }
    }
  }

  console.log(`[reclassify] Matched (need update): ${matched}`);
  console.log(`[reclassify] Already correct: ${alreadyCorrect}`);
  console.log(`[reclassify] Unmatched (no rule hit): ${businesses.length - matched - alreadyCorrect}`);

  // 2. Batch update matched records + stamp classification_attempted_at
  const CHUNK = 500;
  let updated = 0;
  for (let i = 0; i < updates.length; i += CHUNK) {
    const chunk = updates.slice(i, i + CHUNK);
    const ids    = chunk.map(u => u.business_id);
    const cats   = chunk.map(u => u.category);
    const groups = chunk.map(u => u.group);
    await pool.query(
      `UPDATE businesses
         SET category = vals.cat,
             category_group = vals.grp,
             classification_attempted_at = NOW()
         FROM (SELECT unnest($1::uuid[]) as business_id,
                      unnest($2::text[])  as cat,
                      unnest($3::text[])  as grp) vals
        WHERE businesses.business_id = vals.business_id`,
      [ids, cats, groups]
    );
    updated += chunk.length;
    process.stdout.write(`\r[reclassify] Updated: ${updated}/${updates.length}`);
  }
  if (updates.length > 0) console.log('');

  // 3. Stamp classification_attempted_at on ALL active businesses
  //    (even unmatched ones — so we know we tried)
  await pool.query(
    `UPDATE businesses
        SET classification_attempted_at = NOW()
      WHERE status='active' AND classification_attempted_at IS NULL`
  );

  // 4. Downgrade records stuck as 'LocalBusiness' for >48h → 'uncategorized'
  const downgrade = await pool.query(
    `UPDATE businesses
        SET category = 'uncategorized',
            category_group = 'services'
      WHERE status='active'
        AND category = 'LocalBusiness'
        AND classification_attempted_at < NOW() - INTERVAL '48 hours'
      RETURNING business_id`
  );
  const downgraded = downgrade.rows.length;
  console.log(`[reclassify] Downgraded stale LocalBusiness→uncategorized: ${downgraded}`);

  // 5. Log run to pipeline_runs
  const finishedAt = new Date();
  await pool.query(
    `INSERT INTO pipeline_runs
       (pipeline, started_at, finished_at, total_scanned, matched, unmatched, downgraded, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      'reclassify_categories',
      startedAt,
      finishedAt,
      businesses.length,
      matched,
      businesses.length - matched - alreadyCorrect,
      downgraded,
      `Rules: ${RULES.length} | Runtime: ${Math.round((finishedAt - startedAt) / 1000)}s`,
    ]
  );

  const stats = {
    total_scanned: businesses.length,
    matched,
    already_correct: alreadyCorrect,
    unmatched: businesses.length - matched - alreadyCorrect,
    downgraded,
    runtime_ms: finishedAt - startedAt,
  };
  console.log('[reclassify] Done.', stats);
  return stats;
}

// ─── CLI ENTRY POINT ─────────────────────────────────────────────────────────
if (require.main === module) {
  runClassificationPipeline()
    .then(() => process.exit(0))
    .catch(err => { console.error(err); process.exit(1); });
}

module.exports = { runClassificationPipeline, RULES };
