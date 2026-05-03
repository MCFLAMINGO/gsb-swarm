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

  // ── Food general ──────────────────────────────────────────────────────────
  { re: /\b(eat|food|hungry|restaurant|dining|dinner|lunch|brunch|breakfast|meal|bite|craving|dine|takeout|take[\s-]out|delivery|grab\s+a\s+bite|feed\s+me|late[\s-]?night\s+food|quick\s+(food|bite)|place\s+to\s+eat|where\s+to\s+eat|something\s+to\s+eat|good\s+eats|order\s+food)\b/i, cat: 'restaurant' },

  // ── Navigation / local services ───────────────────────────────────────────
  { re: /\b(gas\s+station|fuel|petrol|cheapest\s+gas)\b/i,                         cat: 'auto_repair' },
  { re: /\b(pharmacy|drug\s+store|prescription|24[\s-]?hour\s+pharmacy)\b/i,       cat: 'healthcare' },
  { re: /\b(gym|fitness\s+(center|studio)|workout|crossfit|yoga|pilates|swim\s+lap|lap\s+pool|exercise\s+class)\b/i, cat: 'gym' },
  { re: /\b(atm|cash\s+machine|withdraw\s+cash)\b/i,                               cat: 'finance' },
  { re: /\b(grocery|groceries|supermarket|fresh\s+produce|food\s+store)\b/i,       cat: 'retail' },
  { re: /\b(running\s+shoes|sneakers|buy\s+(a\s+)?gift|birthday\s+gift|gift\s+shop|clothing\s+store|apparel)\b/i, cat: 'retail' },
  { re: /\b(doctor|urgent\s+care|hospital|feel\s+sick|i\s+(feel|am)\s+(sick|hurt)|emergency\s+(room|care))\b/i, cat: 'healthcare' },
  { re: /\b(dentist|dental|teeth|tooth|orthodontist|braces)\b/i,                   cat: 'healthcare' },
  { re: /\b(hair\s+(cut|salon|stylist)|barbershop|nail\s+(salon|spa)|massage|beauty\s+salon|haircut)\b/i, cat: 'beauty' },

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
  ['install',       'handyman'],
  ['pest',          'pest_control'],['bug',        'pest_control'],['termite', 'pest_control'],
  ['mosquito',      'pest_control'],
  ['floor',         'flooring'],  ['tile',         'flooring'],  ['carpet',    'flooring'],
  ['hardwood',      'flooring'],
  ['fence',         'carpentry'], ['deck',         'carpentry'], ['cabinet',   'carpentry'],
  ['pool',          'pool_service'],
  ['concrete',      'concrete'],  ['driveway',     'concrete'],
  ['remodel',       'contractor'],['renovate',     'contractor'],['construction','contractor'],
  // Healthcare / pharmacy
  ['pharmacy',      'healthcare'],['prescription', 'healthcare'],['doctor',    'healthcare'],
  ['dentist',       'healthcare'],['dental',       'healthcare'],['clinic',    'healthcare'],
  ['urgent care',   'healthcare'],['hospital',     'healthcare'],
  // Fitness
  ['gym',           'gym'],       ['fitness',      'gym'],       ['yoga',      'gym'],
  ['crossfit',      'gym'],       ['workout',      'gym'],
  // Beauty
  ['salon',         'beauty'],    ['barbershop',   'beauty'],    ['nail',      'beauty'],
  ['spa',           'beauty'],    ['haircut',      'beauty'],    ['massage',   'beauty'],
  // Finance
  ['atm',           'finance'],   ['bank',         'finance'],
  // Retail / errands
  ['grocery',       'retail'],    ['groceries',    'retail'],    ['supermarket','retail'],
  ['shoes',         'retail'],    ['clothing',     'retail'],    ['gift',      'retail'],
  // Auto
  ['car wash',      'auto_repair'],['oil change',  'auto_repair'],['tire',    'auto_repair'],
  ['mechanic',      'auto_repair'],['auto repair', 'auto_repair'],['tow',     'auto_repair'],
  ['gas station',   'auto_repair'],['fuel',        'auto_repair'],
  // Real estate
  ['realtor',       'real_estate'],['real estate', 'real_estate'],['property','real_estate'],
  // Professional
  ['lawyer',        'professional_services'],['attorney',  'professional_services'],
  ['accountant',    'professional_services'],['insurance', 'professional_services'],
  // IT
  ['computer',      'it_support'], ['laptop',      'it_support'], ['wifi',    'it_support'],
  ['tech support',  'it_support'],
  // Childcare / pets
  ['babysit',       'childcare'],  ['daycare',     'childcare'],
  ['pet sit',       'pet_services'],['dog walk',   'pet_services'],['grooming','pet_services'],
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

module.exports = { resolveIntent };
