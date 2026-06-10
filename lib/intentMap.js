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
  { re: /\b(call\s+.{2,40}\s+for\s+me|text\s+.{2,40}\s+for\s+me|email\s+.{2,40}\s+for\s+me|contact\s+them\s+for\s+me|tell\s+them\s+(i|that|we)|send\s+(a\s+)?message\s+to|make\s+(a\s+)?call|dial\s+|leave\s+(a\s+)?message|write\s+.{2,30}\s+for\s+me|remind\s+me\s+(to|about)|set\s+(a\s+)?reminder|add\s+.{2,30}\s+to\s+my\s+(calendar|list|cart)|schedule\s+(a\s+)?meeting|book\s+(a\s+)?(flight|hotel)\b)\b/i, deflect: true },

  // ── Out-of-scope deflects (home automation, personal assistant, weather) ──
  { re: /\b(turn\s+(on|off|up|down)\s+the|set\s+the\s+(thermostat|lights?|fan|blinds?)|lock\s+the\s+(door|front|back)|garage\s+door|play\s+(music|playlist|song|relaxing)|remind\s+me\s+to|what'?s?\s+the\s+weather|book\s+a\s+flight|recipe\s+using|how\s+to\s+cook|track\s+my\s+steps|meditation\s+session|meal\s+plan\s+for|steps\s+today)\b/i, deflect: true },

  // ── Food subcategories (specific first) ───────────────────────────────────
  // ── Dessert / ice cream / frozen treats — must precede broader food rules ─
  { re: /\b(ice[\s-]?cream|gelato|frozen\s+yogurt|frozen\s+custard|soft[\s-]?serve|sundae|milk[\s-]?shake|custard|sorbet|sweet\s+treat|dessert\s+shop|Dairy\s+Queen|DQ\b|Flo'?s|Culver'?s|Kilwin'?s|Bruster'?s|Marble\s+Slab|Cold\s+Stone|Baskin[- ]Robbins|Carvel|Rita'?s\s+Ice)\b/i,
    cat: 'dessert', tags: ['ice_cream','frozen_treat','dessert_shop'] },
  { re: /\b(pizza|pizzeria)\b/i,                                                    cat: 'pizza' },
  { re: /\b(coffee|cafe|espresso|latte|cappuccino|cold\s+brew|morning\s+drink)\b/i, cat: 'cafe' },
  { re: /\b(bar|pub|brewery|craft\s+beer|happy\s+hour|cocktail|wine\s+bar)\b/i,    cat: 'bar' },
  { re: /\b(bbq|barbecue|smoked\s+meat|brisket|ribs)\b/i,                          cat: 'restaurant', tags: ['bbq','barbecue_restaurant'] },
  { re: /\b(seafood|fish\s+camp|oyster|shrimp|crab|lobster)\b/i,                   cat: 'restaurant', tags: ['seafood'] },
  // ── Sandwich / sub / deli (must precede sporting-goods 'jersey' rule) ────
  { re: /\b(hoagie|sub\s+sandwich|sandwich\s+shop|hero\s+sandwich|delicatessen|jersey\s+mikes?|jimmy\s+johns?|firehouse\s+subs?)\b/i, cat: 'restaurant', tags: ['sandwich','sub','deli'] },
  { re: /where\s+can\s+i\s+get\s+a\s+(hoagie|sub|sandwich|hero)/i,                 cat: 'restaurant', tags: ['sandwich','sub','deli'] },

  // ── Healthy / dietary — restaurant but with tag hints ─────────────────────
  { re: /\b(vegetarian|vegan|organic|healthy\s+(food|eat|option)|gluten[\s-]?free|salad\s+bar|smoothie|juice\s+bar|clean\s+eat)\b/i, cat: 'restaurant', tags: ['healthy','vegan','vegetarian','organic','gluten_free'] },

  // ── Liquor / alcohol ──────────────────────────────────────────────────────
  { re: /\b(vodka|whiskey|whisky|bourbon|rum|tequila|gin|brandy|cognac|scotch|liquor|spirits|hard\s+seltzer|white\s+claw|beer\s+run|wine\s+shop|bottle\s+shop|package\s+store|liquor\s+store|alcohol|booze|six[\s-]?pack|case\s+of\s+beer|buy\s+(wine|beer|alcohol|spirits)|pick\s+up\s+(wine|beer|alcohol))\b/i, cat: 'alcohol' },
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
  { re: /\b(breast\s+(implant|augmentation|lift|reduction)|rhinoplasty|nose\s+job|botox|filler|lip\s+filler|juvederm|restylane|dysport|cosmetic\s+(surgery|procedure)|plastic\s+(surgery|surgeon)|facelift|face\s+lift|brow\s+lift|eyelid\s+surgery|blepharoplasty|liposuction|tummy\s+tuck|abdominoplasty|mommy\s+makeover|body\s+contouring|CoolSculpting|laser\s+(resurfacing|treatment|hair\s+removal)|med\s+spa|medspa|aesthetic\s+(clinic|center)|dermatology|dermatologist|skin\s+(clinic|care\s+center))\b/i, cat: 'plastic_surgery', tags: ['cosmetic','plastic_surgery','med_spa','dermatology'] },
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
  // ── Jewelry / fine jewelry / watches ──────────────────────────────────────
  // Named FL jeweler "Underwood's" (Ponte Vedra) baked in.
  { re: /\b(jewelry|jewell?er[sy]?|jewellers?|engagement\s+ring|wedding\s+band|diamond\s+ring|necklace|bracelet|earrings|pendant|fine\s+jewelry|custom\s+jewelry|Underwood'?s?|jewelry\s+store|watch\s+repair|jewel)\b/i,
    cat: 'jewelry', tags: ['jewelry','fine_jewelry','watches','engagement'] },
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

  // ── Conversational NL intent rules (I need/want, emergency phrasing, where-can-I) ──
  { re: /i\s+(need|want|gotta\s+have)\s+(a\s+|an\s+)?(good\s+|great\s+|local\s+|nearby\s+)?(lawyer|attorney)/i,        cat: 'legal' },
  { re: /i\s+(need|want)\s+(a\s+|an\s+)?(doctor|physician|urgent\s+care|medical)/i,                                    cat: 'clinic' },
  { re: /i\s+(need|want)\s+(a\s+|an\s+)?(plumber|plumbing)/i,                                                          cat: 'plumber' },
  { re: /i\s+(need|want)\s+(a\s+|an\s+)?(electrician|electrical)/i,                                                    cat: 'electrician' },
  { re: /(crashed|accident|collision|fender\s+bender)/i,                                                               cat: 'legal' },
  { re: /(broke\s+down|tow\s+truck|stranded|roadside)/i,                                                               cat: 'towing' },
  { re: /(pipe\s+burst|water\s+leak|flooding\s+inside)/i,                                                              cat: 'plumber' },
  { re: /(power\s+out|no\s+electricity|circuit\s+breaker)/i,                                                           cat: 'electrician' },
  { re: /(tooth|toothache|dental\s+pain|broken\s+tooth)/i,                                                             cat: 'dental' },
  { re: /my\s+(dog|cat|pet|animal)\s+is\s+(sick|hurt|injured|not\s+eating)/i,                                          cat: 'veterinary' },
  { re: /can\s+you\s+(get|buy|order|pick\s+up|find)\s+(me|us)\s+/i,                                                    cat: 'task' },
  { re: /i\s+(need|want)\s+(a\s+|an\s+)?(mechanic|auto\s+repair|car\s+repair)/i,                                       cat: 'auto_repair' },
  { re: /i\s+(need|want)\s+(a\s+|an\s+)?(vet|veterinarian)/i,                                                          cat: 'veterinary' },
  { re: /where\s+(can\s+i|is\s+(a|the))\s+(good\s+)?(restaurant|place\s+to\s+eat|food)/i,                              cat: 'restaurant' },
  { re: /where\s+(can\s+i\s+get|is\s+(a|the))\s+(good\s+)?bar/i,                                                       cat: 'bar' },

  // ── Slang / dialect / colloquial — FL + Southern + GenZ + AAV ─────────────────────────────
  // Food / grub
  { re: /\b(where\s+(can\s+i\s+)?get\s+some\s+grub|grab\s+(some\s+)?(grub|eats?|chow|a\s+bite)|spot\s+(for\s+)?(some\s+)?(grub|food|eats?)|good\s+grub|some\s+good\s+eats?|looking\s+for\s+(some\s+)?grub|need\s+(some\s+)?grub|hit\s+up\s+(a\s+)?spot|eat\s+good|tryna\s+eat|finna\s+eat|bout\s+to\s+eat|bussin\s+(food|spot|restaurant)|where\'?s\s+(the\s+)?food\s+at|where\s+y\'?all\s+eat(ing)?|where\s+(we|they)\s+eat(ing)?)\b/i, cat: 'restaurant' },
  // Bar / going out
  { re: /\b(pull\s+up\s+(to\s+)?(the\s+)?bar|hit\s+the\s+bar|link\s+up\s+at\s+the\s+bar|pre[-\s]?game|turn\s+up|turn\s+it\s+up|get\s+(lit|faded|turnt)|bar\s+hop(ping)?|nightlife|the\s+scene|where'?s\s+the\s+party|live\s+music\s+tonight|vibes?\s+tonight|what'?s\s+poppin|what'?s\s+crackin)\b/i, cat: 'bar' },
  // Car / whip
  { re: /\b(my\s+(whip|ride|whip|benzo|beamer|whip)\s+(is\s+)?(broke|messed|acting)|fix\s+(my\s+)?(whip|ride)|get\s+(my\s+)?(whip|ride)\s+fixed|take\s+(my\s+)?(whip|ride)\s+in|(whip|ride|vehicle)\s+(needs?|got)\s+(work|fixed|looked\s+at|checked))\b/i, cat: 'auto_repair' },
  // Hair / cuts
  { re: /\b(get\s+(my\s+)?(hair\s+did|hair\s+done|nails\s+did|nails\s+done|cut|lined\s+up|fresh\s+cut|shape[-\s]?up)|fresh\s+(cut|fade|line[-\s]?up|trim)|jit\s+needs?\s+a\s+(cut|haircut|fade)|where\s+can\s+i\s+get\s+(lined\s+up|a\s+fade|a\s+fresh\s+cut)|need\s+(a\s+)?(fade|line[-\s]?up|shape[-\s]?up))\b/i, cat: 'beauty_salon' },
  // Groceries colloquial
  { re: /\b(gotta\s+(make\s+a\s+)?run\s+to\s+the\s+(store|market|publix|winn.?dixie)|store\s+run|hit\s+(up\s+)?(the\s+)?(store|publix|walmart|target|market)|need\s+to\s+grab\s+(some\s+)?(groceries|food\s+items?|stuff\s+from\s+the\s+store))\b/i, cat: 'grocery' },
  // Gas colloquial
  { re: /\b(need\s+(to\s+)?(gas\s+up|put\s+gas|fill\s+up|get\s+some\s+gas)|running\s+on\s+E\b|tank\s+is\s+(empty|on\s+E)|fumes\b|gassing\s+up|hit\s+(a\s+)?gas\s+station)\b/i, cat: 'gas_station' },
  // Pharmacy colloquial
  { re: /\b(pick\s+up\s+(my\s+)?(meds?|script|prescription)|grab\s+(my\s+)?(meds?|script|pills?)|need\s+(my\s+)?(meds?|script|refill))\b/i, cat: 'pharmacy' },
  // Plumber colloquial
  { re: /\b(pipes?\s+(is\s+)?messed\s+up|toilet\s+(won'?t|is\s+)?(flush|work|stop\s+running)|sink\s+(won'?t|is\s+)?(drain|work)|water\s+(is\s+)?(leaking|flooding|coming\s+through)|something\s+leaking\s+in\s+my\s+(house|place|crib|apartment))\b/i, cat: 'plumber' },
  // Lawyer colloquial
  { re: /\b(need\s+(to\s+)?(talk\s+to|see|call|get)\s+a\s+(lawyer|attorney|legal\s+help|counsel)|in\s+some\s+legal\s+(trouble|mess)|got\s+(a\s+)?(case|ticket|charge|summons)|fighting\s+(a\s+)?ticket|court\s+date)\b/i, cat: 'law_firm' },
  // Gym / fitness colloquial
  { re: /\b(hit\s+(the\s+)?gym|get\s+(a\s+)?workout\s+in|lift\s+(some\s+)?weights|get\s+(swole|jacked|gains|in\s+shape)|need\s+(to\s+)?work\s+out|find\s+(a\s+)?(gym|fitness\s+spot)|where\s+(can\s+i|do\s+i)\s+(work\s+out|lift|train))\b/i, cat: 'gym' },
  // Hotel / stay colloquial
  { re: /\b(need\s+(a\s+)?place\s+to\s+crash|somewhere\s+to\s+stay|crash\s+(for\s+the\s+night|tonight)|lay\s+(my\s+)?head|looking\s+for\s+a\s+spot\s+to\s+stay)\b/i, cat: 'hotel' },
];

// ── Keyword map (voice-style — single words / short phrases, substring match) ─
// Used as fallback after regex rules. Covers terse spoken phrases like "lawn" or "eat".
// Order matters: first match wins.
const KEYWORD_MAP = [

  // Locksmith / pest / painting / delivery
  ['locked out',    'locksmith'],  ['locksmith',    'locksmith'],  ['lock change',   'locksmith'],
  ['lost keys',     'locksmith'],  ['rekey',        'locksmith'],
  ['roaches',       'pest_control'],['cockroach',   'pest_control'],['exterminator', 'pest_control'],
  ['pest control',  'pest_control'],['termites',    'pest_control'],['bed bugs',     'pest_control'],
  ['house painter', 'painting'],   ['painter',      'painting'],   ['house painting','painting'],
  ['interior paint','painting'],   ['exterior paint','painting'],
  ['delivery service','task'],     ['errand',       'task'],       ['pick up my wife','task'],
  ['airport pickup','task'],       ['need a ride',  'task'],
  // ATM / bank
  ['nearest atm',   'bank'],       ['atm near',     'bank'],       ['cash machine',  'bank'],
  ['need cash',     'bank'],       ['atm',          'bank'],
  // Jewelry
  ['diamond',       'jewelry'],    ['necklace',     'jewelry'],    ['bracelet',      'jewelry'],
  ['engagement ring','jewelry'],   ['jeweler',      'jewelry'],    ['jewelry store', 'jewelry'],
  // Clothes / apparel
  ['chef shoes',    'clothes'],    ['work shoes',   'clothes'],    ['chef uniform',  'clothes'],
  ['suit',          'clothes'],    ['tailor',       'clothes'],    ['tuxedo',        'clothes'],
  ['alterations',   'clothes'],
  // Alcohol / liquor
  ['vodka',         'alcohol'],    ['whiskey',      'alcohol'],    ['tequila',       'alcohol'],
  ['bourbon',       'alcohol'],    ['rum',          'alcohol'],    ['liquor store',  'alcohol'],
  ['liquor',        'alcohol'],    ['beer store',   'alcohol'],
  // Concert / venue
  ['concert hall',  'bar'],        ['live music',   'bar'],        ['music venue',   'bar'],
  ['event venue',   'bar'],        ['comedy club',  'bar'],
  // Properties
  ['properties for rent','real_estate'],['rental property','real_estate'],['homes for rent','real_estate'],
  ['condo for rent','real_estate'],['apartment for rent','real_estate'],
  // Dry cleaning
  ['dry cleaning',  'dry_cleaning'],['dry cleaner',  'dry_cleaning'],['dry clean',   'dry_cleaning'],
  // Bakery
  ['bakery',        'cafe'],       ['fresh bread',  'cafe'],       ['pastries',     'cafe'],
  ['bagels',        'cafe'],       ['donuts',       'cafe'],
  // Seafood / fish
  ['fish market',   'restaurant'], ['seafood market','restaurant'], ['fresh fish',  'restaurant'],
  // Ethnic food
  ['ethiopian food','restaurant'], ['indian food',  'restaurant'], ['thai food',    'restaurant'],
  ['sushi',         'restaurant'], ['ramen',        'restaurant'], ['pho',          'restaurant'],
  ['chinese food',  'restaurant'], ['italian food', 'restaurant'], ['mexican food', 'restaurant'],
  ['korean food',   'restaurant'], ['greek food',   'restaurant'], ['mediterranean food','restaurant'],
  // Coffee delivery
  ['coffee delivered','cafe'],     ['deliver coffee','cafe'],

  // Hygiene / pharmacy products
  ['toothbrush',    'pharmacy'],  ['tothbrush',     'pharmacy'],  ['tooth brush',   'pharmacy'],
  ['toothpaste',    'pharmacy'],  ['tothpaste',     'pharmacy'],  ['tooth paste',   'pharmacy'],
  ['deodorant',     'pharmacy'],  ['deodarant',     'pharmacy'],  ['deodrant',      'pharmacy'],
  ['body spray',    'pharmacy'],  ['antiperspirant','pharmacy'],
  ['shampoo',       'pharmacy'],  ['conditioner',   'pharmacy'],  ['body wash',     'pharmacy'],
  ['face wash',     'pharmacy'],  ['lotion',        'pharmacy'],  ['moisturizer',   'pharmacy'],
  ['razor',         'pharmacy'],  ['shaving cream', 'pharmacy'],  ['band aid',      'pharmacy'],
  ['bandage',       'pharmacy'],  ['first aid',     'pharmacy'],  ['q tip',         'pharmacy'],
  ['nail clippers', 'pharmacy'],  ['tweezers',      'pharmacy'],
  ['tylenol',       'pharmacy'],  ['advil',         'pharmacy'],  ['ibuprofen',     'pharmacy'],
  ['aspirin',       'pharmacy'],  ['nyquil',        'pharmacy'],  ['dayquil',       'pharmacy'],
  ['cough syrup',   'pharmacy'],  ['cough drops',   'pharmacy'],  ['cold meds',     'pharmacy'],
  ['allergy meds',  'pharmacy'],  ['antacid',       'pharmacy'],  ['tums',          'pharmacy'],
  // Convenience / household
  ['toilet paper',  'convenience'], ['tp',          'convenience'], ['paper towel', 'convenience'],
  ['tissues',       'convenience'], ['kleenex',     'convenience'], ['trash bags',  'convenience'],
  ['laundry',       'convenience'], ['dish soap',   'convenience'], ['cleaning supplies','convenience'],
  ['snacks',        'convenience'], ['chips',       'convenience'], ['candy',       'convenience'],
  ['gum',           'convenience'], ['granola bar', 'convenience'], ['energy bar',  'convenience'],
  ['phone charger', 'convenience'], ['batteries',   'convenience'], ['light bulb',  'convenience'],
  ['extension cord','convenience'], ['super glue',  'convenience'], ['tape',        'convenience'],

  // Food
  ['pizza',         'pizza'],
  ['cafe',          'cafe'],     ['coffee',      'cafe'],     ['espresso',    'cafe'],
  ['bar',           'bar'],      ['pub',          'bar'],     ['brewery',     'bar'],
  // Liquor / alcohol
  ['liquor',        'alcohol'], ['spirits',      'alcohol'], ['alcohol',    'alcohol'],
  ['vodka',         'alcohol'], ['whiskey',      'alcohol'], ['bourbon',    'alcohol'],
  ['rum',           'alcohol'], ['tequila',      'alcohol'], ['gin',        'alcohol'],
  ['scotch',        'alcohol'], ['beer run',     'alcohol'], ['bottle shop','alcohol'],
  ['package store', 'alcohol'], ['wine shop',    'alcohol'], ['buy wine',   'alcohol'],
  ['buy beer',      'alcohol'], ['pick up beer', 'alcohol'],
  ['bbq',           'restaurant', ['bbq']],
  ['seafood',       'restaurant', ['seafood']],
  ['catering',      'catering'],  ['cater',       'catering'], ['food truck',  'catering'],
  ['deliver',       'restaurant'],['delivery',    'restaurant'],['bring me',   'restaurant'],
  ['order food',    'restaurant'],['takeout',     'restaurant'],['take out',   'restaurant'],
  // Reservations — restaurant is the right category, handler in localIntelAgent
  // re-routes via intentRegistry resolvesVia='reservation'.
  ['make a reservation','restaurant'],['book a table','restaurant'],
  ['reserve a table',   'restaurant'],['reservation at','restaurant'],
  ['table for',         'restaurant'],['reservations', 'restaurant'],
  ['reservation',       'restaurant'],
  ['restaurant',    'restaurant'],['food',        'restaurant'],['eat',        'restaurant'],
  ['hungry',        'restaurant'],['lunch',       'restaurant'],['dinner',     'restaurant'],
  ['breakfast',     'restaurant'],['meal',        'restaurant'],['order',      'restaurant'],
  ['mcflaming',     'restaurant'],['flamingo',    'restaurant'],
  // Slang — food
  ['grub',          'restaurant'], ['eats',        'restaurant'], ['chow',        'restaurant'],
  ['bussin',        'restaurant'], ['fire food',   'restaurant'], ['spot to eat', 'restaurant'],
  ['good spot',     'restaurant'], ['hit a spot',  'restaurant'], ['where we eating','restaurant'],
  ['tryna eat',     'restaurant'], ['finna eat',   'restaurant'],
  // Sandwich / sub / deli
  ['hoagie',        'restaurant'],['sub sandwich','restaurant'],['sandwich shop','restaurant'],
  ['jimmy johns',   'restaurant'],['jersey mikes','restaurant'],['jersey mike','restaurant'],
  ['subway',        'restaurant'],['hero sandwich','restaurant'],['deli',       'restaurant'],
  ['delicatessen',  'restaurant'],
  // Dessert / ice cream / frozen treats
  ['ice cream',     'dessert'],   ['frozen yogurt', 'dessert'],  ['dairy queen',  'dessert'],
  ["flo's",         'dessert'],   ['gelato',        'dessert'],  ['custard',      'dessert'],
  ['sundae',        'dessert'],   ['milkshake',     'dessert'],  ['milk shake',   'dessert'],
  ['frozen custard','dessert'],   ['soft serve',    'dessert'],  ['sorbet',       'dessert'],
  ['kilwins',       'dessert'],   ["kilwin's",      'dessert'],  ['marble slab',  'dessert'],
  ['cold stone',    'dessert'],   ['carvel',        'dessert'],  ['baskin',       'dessert'],
  ['culvers',       'dessert'],   ["culver's",      'dessert'],  ["bruster's",    'dessert'],
  ['dessert',       'dessert'],
  // Jewelry / fine jewelry
  ['jewelry store', 'jewelry'],   ['jeweler',       'jewelry'],  ['jewellery',    'jewelry'],
  ["underwood's",   'jewelry'],   ['underwood',     'jewelry'],  ['engagement ring','jewelry'],
  ['wedding band',  'jewelry'],   ['diamond ring',  'jewelry'],  ['necklace',     'jewelry'],
  ['bracelet',      'jewelry'],   ['earrings',      'jewelry'],  ['fine jewelry', 'jewelry'],
  ['custom jewelry','jewelry'],   ['pendant',       'jewelry'],  ['jewelry',      'jewelry'],
  // Slang — beauty / hair
  ['fresh cut',     'beauty_salon'],['fade',        'beauty_salon'],['lineup',  'beauty_salon'],
  ['line up',       'beauty_salon'],['shape up',    'beauty_salon'],['shape-up','beauty_salon'],
  ['get lined',     'beauty_salon'],['get a cut',   'beauty_salon'],['barbershop','beauty_salon'],
  ['hair did',      'beauty_salon'],['nails did',   'beauty_salon'],['lashes',  'beauty_salon'],
  // Slang — auto
  ['whip',          'auto_repair'], ['my ride',     'auto_repair'],
  // Slang — bar / nightlife
  ['turn up',       'bar'],        ['get lit',      'bar'],        ['going out',  'bar'],
  ['pregame',       'bar'],        ['pre-game',     'bar'],        ['nightlife',  'bar'],
  ['bar scene',     'bar'],        ['what\'s poppin','bar'],      ['what\'s crackin','bar'],
  // Slang — gym
  ['hit the gym',   'gym'],        ['get gains',    'gym'],        ['swole',       'gym'],
  ['lift',          'gym'],        ['work out',     'gym'],
  // Slang — lawyer
  ['got a case',    'law_firm'],   ['fighting a ticket','law_firm'],['court date','law_firm'],
  ['legal trouble', 'law_firm'],
  // Slang — hotel
  ['place to crash','hotel'],      ['somewhere to crash','hotel'],
  // Slang — gas
  ['gas up',        'gas_station'],['fill up',      'gas_station'],['running on e','gas_station'],
  // Slang — meds
  ['my meds',       'pharmacy'],   ['my script',    'pharmacy'],   ['pick up script','pharmacy'],
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
  // Cosmetic / plastic surgery — map to specific DB category keys, not generic 'healthcare'
  ['botox',           'plastic_surgery'], ['filler',         'plastic_surgery'], ['lip filler',    'plastic_surgery'],
  ['rhinoplasty',     'plastic_surgery'], ['nose job',       'plastic_surgery'], ['breast implant','plastic_surgery'],
  ['liposuction',     'plastic_surgery'], ['tummy tuck',     'plastic_surgery'], ['facelift',      'plastic_surgery'],
  ['cosmetic surgery','plastic_surgery'], ['plastic surgery','plastic_surgery'], ['plastic surgeon','plastic_surgery'],
  ['medspa',          'plastic_surgery'], ['med spa',        'plastic_surgery'], ['dermatologist', 'plastic_surgery'],
  ['dermatology',     'plastic_surgery'], ['skin clinic',    'plastic_surgery'], ['coolsculpting',  'plastic_surgery'],
  ['laser hair',      'plastic_surgery'], ['laser treatment','plastic_surgery'],
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
  ['lawyer',        'legal'],['attorney',  'legal'],
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

  // ── Conversational NL trigger phrases ──────────────────────────────────────
  // Legal
  ['i need a lawyer',           'legal'],
  ['i want a lawyer',           'legal'],
  ['find me a lawyer',          'legal'],
  ['get me a lawyer',           'legal'],
  ['i need an attorney',        'legal'],
  ['i got in an accident',      'legal'],
  ['car accident',              'legal'],
  ['i was injured',             'legal'],
  ['i need bail',               'legal'],
  ['i got a ticket',            'legal'],
  ['can you get me a lawyer',   'legal'],
  // Plumber
  ['i need a plumber',          'plumber'],
  ['i want a plumber',          'plumber'],
  ['my pipe burst',             'plumber'],
  ['water leak',                'plumber'],
  ['can you get me a plumber',  'plumber'],
  // Electrician
  ['i need an electrician',     'electrician'],
  ['no power',                  'electrician'],
  ['power is out',              'electrician'],
  // Clinic / doctor
  ['i need a doctor',           'clinic'],
  ['i want a doctor',           'clinic'],
  ['get me a doctor',           'clinic'],
  ['can you get me a doctor',   'clinic'],
  ['i feel sick',               'clinic'],
  ['where is the nearest hospital', 'clinic'],
  // Dental
  ['i need a dentist',          'dental'],
  ['tooth hurts',               'dental'],
  ['toothache',                 'dental'],
  ['where can i get my teeth cleaned', 'dental'],
  // Auto repair
  ['i need a mechanic',         'auto_repair'],
  ['i crashed my car',          'auto_repair'],
  ['fix my car',                'auto_repair'],
  ['where can i get my car fixed', 'auto_repair'],
  // Towing
  ['i need a tow',              'towing'],
  ['i need a tow truck',        'towing'],
  ['my car broke down',         'towing'],
  ['can you get me a tow',      'towing'],
  ['car is stranded',           'towing'],
  // General contractor
  ['i need a contractor',       'general_contractor'],
  ['find me a contractor',      'general_contractor'],
  // Handyman
  ['i need a handyman',         'handyman'],
  ['locked out',                'handyman'],
  ['locked out of my house',    'handyman'],
  // Roofing
  ['i need a roofer',           'roofing'],
  ['my roof is leaking',        'roofing'],
  // Landscaping
  ['i need a landscaper',       'landscaping'],
  // Pest control
  ['i need pest control',       'pest_control'],
  ['i have bugs',               'pest_control'],
  ['i have roaches',            'pest_control'],
  ['i have termites',           'pest_control'],
  // Financial advisor
  ['i need a financial advisor','financial_advisor'],
  // Insurance
  ['i need insurance',          'insurance_agency'],
  // Veterinary
  ['i need a vet',              'veterinary'],
  ['my dog is sick',            'veterinary'],
  ['my cat is sick',            'veterinary'],
  ['pet emergency',             'veterinary'],
  // Fitness
  ['i need a gym',              'fitness_centre'],
  ['where is a gym',            'fitness_centre'],
  // Hotel
  ['i need a hotel',            'hotel'],
  ['where can i stay',          'hotel'],
  ['where is a hotel',          'hotel'],
  ['place to stay',             'hotel'],
  // Restaurant
  ['i need a restaurant',       'restaurant'],
  ['i want food',               'restaurant'],
  ['get me food',               'restaurant'],
  ['i want sushi',              'restaurant'],
  ['where can i get food',      'restaurant'],
  ['where is a good place to eat','restaurant'],
  ['can you get me food',       'restaurant'],
  // Pizza
  ['i want pizza',              'pizza'],
  ['can you get me a pizza',    'pizza'],
  ['where can i get pizza',     'pizza'],
  // Cafe
  ['i need coffee',             'cafe'],
  ['get me coffee',             'cafe'],
  ['where can i get coffee',    'cafe'],
  ['can you get me coffee',     'cafe'],
  // Grocery
  ['i need groceries',          'grocery'],
  ['i want groceries',          'grocery'],
  ['where can i get groceries', 'grocery'],
  // Beauty salon
  ['where can i get a haircut',     'beauty_salon'],
  ['where can i get my nails done', 'beauty_salon'],
  ['where can i get my hair done',  'beauty_salon'],
  // Gas station
  ['where can i get gas',       'gas_station'],
  // Bar
  ['where can i get a drink',   'bar'],
  ['where can i get beer',      'bar'],
  ['where is a good bar',       'bar'],
  // Pharmacy
  ['i need a prescription',     'pharmacy'],
  ['where can i get my prescription', 'pharmacy'],
  ['where is a pharmacy',       'pharmacy'],
  // Dry cleaning
  ['where can i get my clothes cleaned', 'dry_cleaning'],
  // Bank
  ['where is a bank',           'bank'],
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
  // Sort by keyword length descending so longer/more specific phrases win
  // over shorter ones (e.g. "i need a lawyer" beats "lawyer").
  const lower = raw.toLowerCase();
  const sortedKeywords = [...KEYWORD_MAP].sort((a, b) => b[0].length - a[0].length);
  for (const entry of sortedKeywords) {
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

const { detectTaskIntent, getTaskFollowUp, setTaskFollowUp, clearTaskFollowUp } = require('./taskIntent');
module.exports = { resolveIntent, detectOpenIntent, detectTaskIntent, getTaskFollowUp, setTaskFollowUp, clearTaskFollowUp };
