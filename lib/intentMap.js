'use strict';

/**
 * lib/intentMap.js — Single source of truth for NL intent resolution.
 *
 * Used by BOTH:
 *   - localIntelAgent.js  (GET /api/local-intel/search)
 *   - voiceIntake.js      (Twilio speech → category)
 *
 * resolveIntent(text) → { cat, tags, deflect, confidence }
 *
 *   cat        — CAT_EXPAND key (e.g. 'restaurant', 'landscaping')
 *   tags       — optional tag hints for DB filter (e.g. ['healthy','vegan'])
 *   deflect    — true if query is out of scope (home automation, weather, etc.)
 *   confidence — 'high' (regex match) | 'keyword' (SERVICE_MAP hit) | null
 *
 * Design rules:
 *   - Zero LLM. Fully deterministic.
 *   - Regex rules run first (NL phrases, questions).
 *   - Keyword map runs second (voice-style single-word/phrase hits).
 *   - More specific patterns before general ones (pizza before restaurant).
 *   - Adding new intent = add one entry here. Voice + web both benefit instantly.
 */

// ── Regex rules (NL phrases — questions, sentences, conversational) ──────────
// Order matters: first match wins. More specific → less specific.
const NL_RULES = [
  // ── Action requests — LocalIntel can't act on behalf of user, deflect cleanly ──
  { re: /\b(call\s+.{2,40}\s+for\s+me|text\s+.{2,40}\s+for\s+me|email\s+.{2,40}\s+for\s+me|contact\s+them\s+for\s+me|tell\s+them\s+(i|that|we)|send\s+(a\s+)?message\s+to|make\s+(a\s+)?call|dial\s+|leave\s+(a\s+)?message|write\s+.{2,30}\s+for\s+me|remind\s+me\s+(to|about)|set\s+(a\s+)?reminder|add\s+.{2,30}\s+to\s+my\s+(calendar|list|cart)|schedule\s+(a\s+)?meeting|book\s+(a\s+)?(flight|hotel|table\s+at|reservation|appointment\s+at)\b)\b/i, deflect: true },

  // ── Out-of-scope deflects (home automation, personal assistant, weather) ──
  { re: /\b(turn\s+(on|off|up|down)\s+the|set\s+the\s+(thermostat|lights?|fan|blinds?)|lock\s+the\s+(door|front|back)|garage\s+door|play\s+(music|playlist|song|relaxing)|remind\s+me\s+to|what'?s?\s+the\s+weather|book\s+a\s+flight|recipe\s+using|how\s+to\s+cook|track\s+my\s+steps|meditation\s+session|meal\s+plan\s+for|steps\s+today)\b/i, deflect: true },

  // ── Food subcategories (specific first) ───────────────────────────────────
  { re: /\b(pizza|pizzeria)\b/i,                                                    cat: 'pizza' },
  { re: /\b(coffee|cafe|espresso|latte|cappuccino|cold\s+brew|morning\s+drink)\b/i, cat: 'cafe' },
  { re: /\b(bar|pub|brewery|craft\s+beer|happy\s+hour|cocktail|wine\s+bar)\b/i,    cat: 'bar' },
  { re: /\b(bbq|barbecue|smoked\s+meat|brisket|ribs)\b/i,                          cat: 'restaurant', tags: ['bbq','barbecue_restaurant'] },
  { re: /\b(seafood|fish\s+camp|oyster|shrimp|crab|lobster)\b/i,                   cat: 'restaurant', tags: ['seafood'] },

  // ── Healthy / dietary — restaurant but with tag hints ─────────────────────
  { re: /\b(vegetarian|vegan|organic|healthy\s+(food|eat|option)|gluten[\s-]?free|salad\s+bar|smoothie|juice\s+bar|clean\s+eat)\b/i, cat: 'restaurant', tags: ['healthy','vegan','vegetarian','organic','gluten_free'] },

  // ── Liquor / alcohol ──────────────────────────────────────────────────────
  { re: /\b(vodka|whiskey|whisky|bourbon|rum|tequila|gin|brandy|cognac|scotch|liquor|spirits|hard\s+seltzer|white\s+claw|beer\s+run|wine\s+shop|bottle\s+shop|package\s+store|liquor\s+store|alcohol|booze|six[\s-]?pack|case\s+of\s+beer|buy\s+(wine|beer|alcohol|spirits)|pick\s+up\s+(wine|beer|alcohol))\b/i, cat: 'liquor_store' },
  // ── Grocery items ─────────────────────────────────────────────────────────
  { re: /\b(milk|eggs?|bread|butter|cream|cheese|yogurt|produce|fresh\s+fruit|fresh\s+veg|buy\s+(milk|eggs|bread|groceries|ingredients)|pick\s+up\s+(groceries|some\s+food)|need\s+to\s+buy\s+(food|groceries|ingredients))\b/i, cat: 'retail', tags: ['grocery','supermarket'] },
  // ── Beverage / water delivery ─────────────────────────────────────────────
  { re: /\b(case\s+of\s+water|water\s+delivery|water\s+cooler|bottled\s+water|gallon\s+of\s+water|bulk\s+water|sports\s+drinks?|gatorade|powerade|energy\s+drinks?|soda\s+delivery|beverage\s+delivery|drink\s+delivery|drinks?\s+for\s+(the\s+)?(team|group|office|event|party))\b/i, cat: 'retail', tags: ['grocery','beverage','delivery'] },
  // ── Retail goods / outdoor / sporting ────────────────────────────────────
  { re: /\b(beach\s+(chair|umbrella|towel|tent|gear|bag|supply)|camping\s+(gear|supply|equipment)|outdoor\s+(furniture|gear|supply)|sporting\s+goods|patio\s+(furniture|chair|table)|lawn\s+chair|folding\s+chair|kayak|paddleboard|surf(board)?|snorkel|fishing\s+(gear|rod|tackle)|bike\s+(shop|rental)|bicycle|drill|power\s+tool|hardware\s+store|lumber|scooter\s+rental|swimsuit|flip[\s-]?flops|sunscreen|sunblock|beach\s+supply|pool\s+(float|toy|supply))\b/i, cat: 'retail', tags: ['outdoor','sporting_goods','hardware'] },
  // ── Sporting goods / athletic equipment ──────────────────────────────────
  { re: /\b(cleats?|soccer\s+(cleats?|ball|jersey|shin\s+guards?|equipment)|football\s+(cleats?|helmet|pads?|equipment)|baseball\s+(glove|bat|cleats?|equipment)|basketball\s+(shoes?|equipment)|tennis\s+(racket|shoes?|equipment)|golf\s+(clubs?|equipment|balls?)|athletic\s+(shoes?|gear|equipment)|sports?\s+(equipment|gear|apparel|uniform)|jersey|shin\s+guard|shoulder\s+pad|batting\s+glove|compression\s+(shorts?|sleeves?)|running\s+shoes?|track\s+spikes?|swimming\s+(goggles?|cap)|lacrosse\s+(stick|equipment)|hockey\s+(stick|equipment|puck)|volleyball\s+equipment|wrestling\s+shoes?|boxing\s+gloves?|workout\s+(gloves?|gear|equipment)|weight\s+(lifting\s+)?belt|resistance\s+band)\b/i, cat: 'retail', tags: ['sporting_goods','athletic','equipment'] },
  // ── Rentals / real estate ─────────────────────────────────────────────────
  { re: /\b(for\s+rent|to\s+rent|rental|apartment|condo\s+for\s+(rent|lease)|house\s+for\s+rent|townhome\s+for\s+rent|lease|leasing|month[\s-]?to[\s-]?month|short[\s-]?term\s+rental|long[\s-]?term\s+rental|property\s+for\s+rent|find\s+(me\s+)?a\s+(place|apartment|condo|home)\s+to\s+rent)\b/i, cat: 'real_estate', tags: ['rental','for_rent','leasing'] },

  // ── Food general ──────────────────────────────────────────────────────────
  { re: /\b(eat|food|hungry|restaurant|dining|dinner|lunch|brunch|breakfast|meal|bite|craving|dine|takeout|take[\s-]out|delivery|grab\s+a\s+bite|feed\s+me|late[\s-]?night\s+food|quick\s+(food|bite)|place\s+to\s+eat|where\s+to\s+eat|something\s+to\s+eat|good\s+eats|order\s+food)\b/i, cat: 'restaurant' },

  // ── Navigation / local services ───────────────────────────────────────────
  { re: /\b(gas\s+station|fill\s+up\s+gas|petrol\s+station|fuel|petrol|cheapest\s+gas)\b/i, cat: 'gas_station' },
  { re: /\b(pharmacy|drug\s+store|prescription|24[\s-]?hour\s+pharmacy)\b/i,       cat: 'pharmacy' },
  // ── Veterinary ────────────────────────────────────────────────────────────
  { re: /\b(vet|veterinarian|animal\s+hospital|pet\s+clinic)\b/i,                  cat: 'veterinary' },
  // ── Towing / roadside ─────────────────────────────────────────────────────
  { re: /\b(tow\s+truck|roadside\s+assistance|towing)\b/i,                         cat: 'towing' },
  // ── Cosmetic / plastic surgery ────────────────────────────────────────────
  { re: /\b(breast\s+(implant|augmentation|lift|reduction)|rhinoplasty|nose\s+job|botox|filler|lip\s+filler|juvederm|restylane|dysport|cosmetic\s+(surgery|procedure)|plastic\s+(surgery|surgeon)|facelift|face\s+lift|brow\s+lift|eyelid\s+surgery|blepharoplasty|liposuction|tummy\s+tuck|abdominoplasty|mommy\s+makeover|body\s+contouring|CoolSculpting|laser\s+(resurfacing|treatment|hair\s+removal)|med\s+spa|medspa|aesthetic\s+(clinic|center)|dermatology|dermatologist|skin\s+(clinic|care\s+center))\b/i, cat: 'healthcare', tags: ['cosmetic','plastic_surgery','med_spa','dermatology'] },
  // ── Entertainment / venues ─────────────────────────────────────────────
  { re: /\b(concert\s+hall|concert\s+venue|music\s+hall|music\s+venue|live\s+music|amphitheat(re|er)|performing\s+arts|event\s+venue|entertainment\s+venue|theater|theatre|playhouse|auditorium|arena|stadium|show\s+venue|shows?\s+near|events?\s+near|night\s+life|nightlife|things\s+to\s+do|what.{0,10}(do|see|watch|happening)\s+near|comedy\s+club|open\s+(mic|stage))\b/i, cat: 'entertainment' },
  { re: /\b(library|public\s+library|libraries)\b/i, cat: 'library' },
  { re: /\b(gym|fitness\s+(center|studio)|workout|crossfit|yoga|pilates|swim\s+lap|lap\s+pool|exercise\s+class)\b/i, cat: 'gym' },
  { re: /\b(atm|cash\s+machine|withdraw\s+cash)\b/i,                               cat: 'finance' },
  { re: /\b(grocery\s+store|grocery|groceries|supermarket|fresh\s+produce|food\s+store)\b/i, cat: 'grocery' },
  { re: /\b(running\s+shoes|sneakers|buy\s+(a\s+)?gift|birthday\s+gift|gift\s+shop)\b/i, cat: 'retail' },
  { re: /\b(urgent\s+care|family\s+doctor|primary\s+care|doctor|physician|medical\s+clinic)\b/i, cat: 'clinic' },
  { re: /\b(hospital|feel\s+sick|i\s+(feel|am)\s+(sick|hurt)|emergency\s+(room|care))\b/i, cat: 'healthcare' },
  { re: /\b(dentist|dental|teeth|tooth|orthodontist|braces)\b/i,                   cat: 'healthcare' },
  { re: /\b(hair\s+salon|haircut|barber\s+shop|nail\s+salon|hair\s+(cut|stylist)|barbershop|nail\s+spa|massage|beauty\s+salon|blowout)\b/i, cat: 'beauty_salon' },
  // ── Hotel / accommodations ────────────────────────────────────────────────
  { re: /\b(hotel|motel|place\s+to\s+stay|where\s+to\s+stay|accommodations?)\b/i,  cat: 'hotel' },
  // ── Clothing / apparel retail ─────────────────────────────────────────────
  { re: /\b(clothes|clothing|apparel|fashion|shop\s+for\s+clothes|buy\s+clothes)\b/i, cat: 'clothes' },
  // ── Dry cleaning / laundry (direct) ───────────────────────────────────────
  { re: /\b(dry\s+cleaning|dry\s+cleaner|laundry|drop\s+off\s+laundry)\b/i,        cat: 'dry_cleaning' },
  // ── Auto repair / mechanic ────────────────────────────────────────────────
  { re: /\b(car\s+repair|mechanic|auto\s+repair|fix\s+my\s+car|car\s+mechanic)\b/i, cat: 'auto_repair' },
  // ── Financial advisor / wealth ────────────────────────────────────────────
  { re: /\b(financial\s+advisor|wealth\s+management|investment\s+advisor|financial\s+planner)\b/i, cat: 'financial_advisor' },
  // ── Insurance ─────────────────────────────────────────────────────────────
  { re: /\b(insurance\s+(agent|broker)|home\s+insurance|auto\s+insurance|life\s+insurance)\b/i, cat: 'insurance_agency' },

  // ── Trades / home services ────────────────────────────────────────────────
  { re: /\b(landscap|lawn\s+(care|service|mow)|yard\s+(work|service)|tree\s+(service|trim)|garden|mow(ing)?|irrigation|sprinkler)\b/i, cat: 'landscaping' },
  { re: /\b(clean(ing)?|maid\s+service|house\s+clean|janitorial|carpet\s+clean|pressure\s+wash)\b/i,                                   cat: 'cleaning' },
  { re: /\b(hvac|air\s+condition(ing|er)|heating\s+(unit|system)|furnace|ac\s+unit|duct\s+work|cool(ing\s+system)?)\b/i,               cat: 'hvac' },
  { re: /\b(plumb(er|ing)|pipe\s+(leak|burst)|toilet\s+(clog|fix)|faucet|water\s+heater|drain\s+clog)\b/i,                            cat: 'plumber' },
  { re: /\b(electric(ian|al)|wiring|outlet\s+(fix|install)|breaker\s+panel|light\s+(fix|install))\b/i,                                cat: 'electrician' },
  { re: /\b(real\s+estate|house\s+for\s+sale|home\s+for\s+sale|realtor|property\s+(management|listing))\b/i,                          cat: 'real_estate' },
];

// ── Keyword map (voice-style — single words / short phrases, substring match) ─
// Used as fallback after regex rules. Covers terse spoken phrases like "lawn" or "eat".
// Order matters: first match wins.
const KEYWORD_MAP = [
  // Food
  ['pizza',         'pizza'],
  ['cafe',          'cafe'],     ['coffee',      'cafe'],     ['espresso',    'cafe'],
  ['bar',           'bar'],      ['pub',          'bar'],     ['brewery',     'bar'],
  // Liquor / alcohol
  ['liquor',        'liquor_store'], ['spirits',      'liquor_store'], ['alcohol',    'liquor_store'],
  ['vodka',         'liquor_store'], ['whiskey',      'liquor_store'], ['bourbon',    'liquor_store'],
  ['rum',           'liquor_store'], ['tequila',      'liquor_store'], ['gin',        'liquor_store'],
  ['scotch',        'liquor_store'], ['beer run',     'liquor_store'], ['bottle shop','liquor_store'],
  ['package store', 'liquor_store'], ['wine shop',    'liquor_store'], ['buy wine',   'liquor_store'],
  ['buy beer',      'liquor_store'], ['pick up beer', 'liquor_store'],
  ['bbq',           'restaurant', ['bbq']],
  ['seafood',       'restaurant', ['seafood']],
  ['catering',      'catering'],  ['cater',       'catering'], ['food truck',  'catering'],
  ['deliver',       'restaurant'],['delivery',    'restaurant'],['bring me',   'restaurant'],
  ['order food',    'restaurant'],['takeout',     'restaurant'],['take out',   'restaurant'],
  ['restaurant',    'restaurant'],['food',        'restaurant'],['eat',        'restaurant'],
  ['hungry',        'restaurant'],['lunch',       'restaurant'],['dinner',     'restaurant'],
  ['breakfast',     'restaurant'],['meal',        'restaurant'],['order',      'restaurant'],
  ['mcflaming',     'restaurant'],['flamingo',    'restaurant'],
  // Trades
  ['lawn',          'landscaping'],['mow',         'landscaping'],['mowing',   'landscaping'],
  ['landscap',      'landscaping'],['grass',       'landscaping'],['yard',     'landscaping'],
  ['tree',          'landscaping'],['hedge',       'landscaping'],['trim',     'landscaping'],
  ['mulch',         'landscaping'],['irrigation',  'landscaping'],['sprinkler','landscaping'],
  ['clean',         'cleaning'],  ['maid',         'cleaning'],  ['janitorial','cleaning'],
  ['pressure wash', 'cleaning'],
  ['plumb',         'plumbing'],  ['pipe',         'plumbing'],  ['leak',      'plumbing'],
  ['drain',         'plumbing'],  ['water heater', 'plumbing'],  ['toilet',    'plumbing'],
  ['faucet',        'plumbing'],
  ['electric',      'electrical'],['wiring',       'electrical'],['outlet',    'electrical'],
  ['breaker',       'electrical'],['panel',        'electrical'],
  ['hvac',          'hvac'],      ['ac ',          'hvac'],      ['air condition','hvac'],
  ['heat',          'hvac'],      ['furnace',      'hvac'],      ['duct',      'hvac'],
  ['roof',          'roofing'],   ['shingle',      'roofing'],   ['gutter',    'roofing'],
  ['paint',         'painting'],  ['stain',        'painting'],  ['drywall',   'painting'],
  ['mov',           'moving'],    ['haul',         'moving'],    ['junk',      'moving'],
  ['removal',       'moving'],
  ['handyman',      'handyman'],  ['fix',          'handyman'],  ['repair',    'handyman'],
  ['install',       'handyman'],  ['odd jobs',     'handyman'],  ['home repair','handyman'],
  ['fix something in my house','handyman'],
  ['pest',          'pest_control'],['bug',        'pest_control'],['termite', 'pest_control'],
  ['mosquito',      'pest_control'],
  ['floor',         'flooring'],  ['tile',         'flooring'],  ['carpet',    'flooring'],
  ['hardwood',      'flooring'],
  ['fence',         'carpentry'], ['deck',         'carpentry'], ['cabinet',   'carpentry'],
  ['pool',          'pool_service'],
  ['concrete',      'concrete'],  ['driveway',     'concrete'],
  ['remodel',       'contractor'],['renovate',     'contractor'],['construction','contractor'],
  // Healthcare / pharmacy
  ['pharmacy',      'pharmacy'],  ['drugstore',    'pharmacy'],  ['drug store','pharmacy'],
  ['prescription',  'pharmacy'],
  ['doctor',        'clinic'],    ['physician',    'clinic'],    ['primary care','clinic'],
  ['urgent care',   'clinic'],    ['medical clinic','clinic'],   ['family doctor','clinic'],
  ['dentist',       'healthcare'],['dental',       'healthcare'],['clinic',    'healthcare'],
  ['hospital',      'healthcare'],
  // Veterinary
  ['vet',           'veterinary'],['veterinarian', 'veterinary'],['animal hospital','veterinary'],
  ['pet clinic',    'veterinary'],['dog vet',      'veterinary'],['cat vet',   'veterinary'],
  // Fitness
  ['gym',           'gym'],       ['fitness',      'gym'],       ['yoga',      'gym'],
  ['crossfit',      'gym'],       ['workout',      'gym'],
  // Beauty
  ['hair salon',    'beauty_salon'], ['nail salon',  'beauty_salon'], ['hair stylist','beauty_salon'],
  ['barber',        'beauty_salon'], ['blowout',     'beauty_salon'], ['haircut',     'beauty_salon'],
  ['salon',         'beauty'],    ['barbershop',   'beauty'],    ['nail',      'beauty'],
  ['spa',           'beauty'],    ['massage',      'beauty'],
  // Cosmetic / plastic surgery
  ['botox',           'healthcare'], ['filler',         'healthcare'], ['lip filler',    'healthcare'],
  ['rhinoplasty',     'healthcare'], ['nose job',       'healthcare'], ['breast implant','healthcare'],
  ['liposuction',     'healthcare'], ['tummy tuck',     'healthcare'], ['facelift',      'healthcare'],
  ['cosmetic surgery','healthcare'], ['plastic surgery','healthcare'], ['plastic surgeon','healthcare'],
  ['medspa',          'healthcare'], ['med spa',        'healthcare'], ['dermatologist', 'healthcare'],
  ['dermatology',     'healthcare'], ['skin clinic',    'healthcare'], ['coolsculpting',  'healthcare'],
  ['laser hair',      'healthcare'], ['laser treatment','healthcare'],
  // Finance
  ['atm',           'finance'],   ['bank',         'finance'],
  // Grocery
  ['grocery store', 'grocery'],   ['grocery',      'grocery'],   ['supermarket','grocery'],
  ['food store',    'grocery'],   ['market',       'grocery'],   ['groceries',  'grocery'],
  // Retail / hardware / outdoor
  ['milk',          'retail'],    ['eggs',         'retail'],    ['bread',      'retail'],
  ['butter',        'retail'],    ['produce',      'retail'],
  ['convenience',   'retail'],    ['dollar store', 'retail'],
  // Clothes / apparel
  ['shop for clothes','clothes'], ['buy clothes',  'clothes'],   ['clothes',    'clothes'],
  ['clothing',      'clothes'],   ['apparel',      'clothes'],   ['fashion',    'clothes'],
  // Dry cleaning / laundry
  ['dry cleaning',  'dry_cleaning'],['dry cleaner','dry_cleaning'],['laundry',  'dry_cleaning'],
  ['drop off laundry','dry_cleaning'],
  // Hotel / lodging
  ['hotel',         'hotel'],     ['motel',        'hotel'],     ['place to stay','hotel'],
  ['where to stay', 'hotel'],     ['accommodations','hotel'],
  // Financial advisor
  ['financial advisor','financial_advisor'],['wealth management','financial_advisor'],
  ['investment advisor','financial_advisor'],['financial planner','financial_advisor'],
  // Insurance agency
  ['insurance agent','insurance_agency'],['insurance broker','insurance_agency'],
  ['home insurance','insurance_agency'],['auto insurance','insurance_agency'],
  ['life insurance','insurance_agency'],
  // Beverage / water delivery
  ['case of water',   'retail'],    ['water delivery', 'retail'],    ['bottled water',  'retail'],
  ['bulk water',      'retail'],    ['sports drink',   'retail'],    ['gatorade',       'retail'],
  ['beverage delivery','retail'],   ['drinks for team','retail'],    ['drinks for group','retail'],
  ['beach chair',   'retail'],    ['beach umbrella','retail'],   ['beach gear', 'retail'],
  ['beach supply',  'retail'],    ['outdoor gear', 'retail'],    ['sporting goods','retail'],
  ['camping gear',  'retail'],    ['kayak',        'retail'],    ['paddleboard','retail'],
  ['surfboard',     'retail'],    ['fishing gear', 'retail'],    ['bike shop',  'retail'],
  ['lawn chair',    'retail'],    ['patio furniture','retail'],  ['pool float', 'retail'],
  ['drill',         'retail'],    ['electric drill','retail'],   ['power tool', 'retail'],
  ['hardware store','retail'],    ['hardware',     'retail'],    ['lumber',     'retail'],
  ['shoes',         'retail'],    ['gift',         'retail'],
  ['office supply', 'retail'],    ['furniture',    'retail'],    ['mattress',   'retail'],
  ['phone case',    'retail'],    ['charger',      'retail'],
  // Sporting goods / athletic
  ['cleats',          'retail'],    ['soccer cleats',  'retail'],    ['football cleats','retail'],
  ['baseball glove',  'retail'],    ['tennis racket',  'retail'],    ['golf clubs',     'retail'],
  ['athletic shoes',  'retail'],    ['running shoes',  'retail'],    ['sports equipment','retail'],
  ['sporting goods',  'retail'],    ['jersey',         'retail'],    ['shin guards',    'retail'],
  ['shoulder pads',   'retail'],    ['batting glove',  'retail'],    ['swim goggles',   'retail'],
  ['boxing gloves',   'retail'],    ['resistance band','retail'],    ['yoga mat',       'retail'],
  ['workout gear',    'retail'],    ['sports uniform', 'retail'],    ['athletic gear',  'retail'],
  // Auto repair / mechanic
  ['car wash',      'auto_repair'],['oil change',  'auto_repair'],['tire',    'auto_repair'],
  ['mechanic',      'auto_repair'],['auto repair', 'auto_repair'],['car repair','auto_repair'],
  ['fix my car',    'auto_repair'],['car mechanic','auto_repair'],
  // Towing / roadside
  ['tow truck',     'towing'],    ['towing',       'towing'],    ['tow my car','towing'],
  ['car is stranded','towing'],   ['need a tow',   'towing'],    ['roadside assistance','towing'],
  ['tow',           'towing'],
  // Gas / fuel
  ['gas station',   'gas_station'],['gas',          'gas_station'],['fuel',     'gas_station'],
  ['fill up',       'gas_station'],['petrol',       'gas_station'],
  // Real estate / rentals
  ['realtor',       'real_estate'], ['real estate',  'real_estate'], ['property',   'real_estate'],
  ['rent',          'real_estate'], ['rental',       'real_estate'], ['apartment',  'real_estate'],
  ['lease',         'real_estate'], ['for rent',     'real_estate'], ['townhome',   'real_estate'],
  ['condo',         'real_estate'], ['house for rent','real_estate'],['leasing office','real_estate'],
  ['property management','real_estate'],
  // Professional
  ['lawyer',        'professional_services'],['attorney',  'professional_services'],
  ['accountant',    'professional_services'],['insurance', 'professional_services'],
  // IT
  ['computer',      'it_support'], ['laptop',      'it_support'], ['wifi',    'it_support'],
  ['tech support',  'it_support'],
  // Childcare / pets
  ['babysit',       'childcare'],  ['daycare',     'childcare'],
  ['pet sit',       'pet_services'],['dog walk',   'pet_services'],['grooming','pet_services'],
  // Entertainment / venues
  ['concert hall',    'entertainment'], ['concert venue', 'entertainment'], ['music hall',      'entertainment'],
  ['live music',      'entertainment'], ['amphitheater',  'entertainment'], ['performing arts', 'entertainment'],
  ['event venue',     'entertainment'], ['theater',       'entertainment'], ['theatre',         'entertainment'],
  ['nightlife',       'entertainment'], ['comedy club',   'entertainment'], ['things to do',    'entertainment'],
  ['auditorium',      'entertainment'], ['arena',         'entertainment'], ['stadium',         'entertainment'],
  ['ticket',          'entertainment'], ['buy a ticket',  'entertainment'], ['get tickets',     'entertainment'],
  ['purchase ticket', 'entertainment'],
  // Library
  ['library',         'library'],       ['public library','library'],
  // Photography / events
  ['photo',         'photography'],['headshot',    'photography'],
  // Tutoring
  ['tutor',         'tutoring'],   ['lesson',      'tutoring'],  ['coach',    'tutoring'],
];

/**
 * resolveIntent(text)
 *
 * @param {string} text — raw user input (web query or voice transcript)
 * @returns {{ cat: string|null, tags: string[]|null, deflect: boolean, confidence: string|null }}
 */
function resolveIntent(text) {
  if (!text || typeof text !== 'string') return { cat: null, tags: null, deflect: false, confidence: null };

  const raw = text.trim();

  // 1. Regex rules (NL phrases — highest fidelity)
  for (const rule of NL_RULES) {
    if (rule.re.test(raw)) {
      if (rule.deflect) return { cat: null, tags: null, deflect: true, confidence: 'high' };
      return { cat: rule.cat, tags: rule.tags || null, deflect: false, confidence: 'high' };
    }
  }

  // 2. Keyword map (voice-style substring match)
  const lower = raw.toLowerCase();
  for (const entry of KEYWORD_MAP) {
    const [keyword, cat, tags] = entry;
    if (lower.includes(keyword)) {
      return { cat, tags: tags || null, deflect: false, confidence: 'keyword' };
    }
  }

  return { cat: null, tags: null, deflect: false, confidence: null };
}

// ── Open-now / hours intent detection ──────────────────────────────
// Returns: 'now' | 'late' | 'early' | 'weekend' | null
const OPEN_NOW_RE   = /\b(open\s+now|open\s+today|currently\s+open|open\s+right\s+now|what'?s\s+open|who'?s\s+open)\b/i;
const OPEN_LATE_RE  = /\b(open\s+late|late\s+night|late-?night|still\s+open|open\s+after\s+\d|past\s+\d{1,2}\s*(?:pm|o'clock))\b/i;
const OPEN_EARLY_RE = /\b(open\s+early|open\s+in\s+the\s+morning|early\s+morning|first\s+thing)\b/i;
const OPEN_WKND_RE  = /\b(open\s+(?:this\s+)?(?:weekend|saturday|sunday|sat|sun))\b/i;

function detectOpenIntent(text) {
  if (!text) return null;
  if (OPEN_NOW_RE.test(text))   return 'now';
  if (OPEN_LATE_RE.test(text))  return 'late';
  if (OPEN_EARLY_RE.test(text)) return 'early';
  if (OPEN_WKND_RE.test(text))  return 'weekend';
  return null;
}

module.exports = { resolveIntent, detectOpenIntent };
