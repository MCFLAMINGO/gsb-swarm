'use strict';
/**
 * lib/brandAliases.js
 * Tier 2 hardcoded brand alias map. Maps normalized alias → canonical brand name.
 * Used to fuzzy-resolve common misspellings and nicknames before DB lookup.
 * Keys MUST be lowercase. Values are the canonical search term to use against businesses table.
 */

const BRAND_ALIAS_MAP = {
  // Coffee
  'strabucks':       'starbucks',
  'starbux':         'starbucks',
  'sbux':            'starbucks',
  'starbs':          'starbucks',

  // Dunkin'
  'dunkans':         'dunkin',
  'dunkins':         'dunkin',
  'dunkin donuts':   'dunkin',
  'dunkin doughnuts':'dunkin',
  'dd':              'dunkin',

  // McDonald's
  'mcdonalds':       "mcdonald's",
  'mcdonald':        "mcdonald's",
  'mickey ds':       "mcdonald's",
  "mickey d's":      "mcdonald's",
  'micky ds':        "mcdonald's",
  'mcds':            "mcdonald's",
  'golden arches':   "mcdonald's",

  // Chick-fil-A
  'chick fil a':     'chick-fil-a',
  'chick fila':      'chick-fil-a',
  'chickfila':       'chick-fil-a',
  'cfa':             'chick-fil-a',

  // Applebee's
  'applebeas':       "applebee's",
  'applebees':       "applebee's",
  'applebee':        "applebee's",

  // Dairy Queen
  'dq':              'dairy queen',
  'dairy queen':     'dairy queen',

  // Subway
  'subway subs':     'subway',

  // Taco Bell
  'tbell':           'taco bell',
  't bell':          'taco bell',

  // Burger King
  'bk':              'burger king',
  'the king':        'burger king',

  // Wendy's
  'wendys':          "wendy's",

  // Domino's
  'dominos':         "domino's",

  // V Pizza (Ponte Vedra Beach)
  'v pizza':         'V Pizza',
  'vpizza':          'V Pizza',
  "v's pizza":       'V Pizza',
  'vs pizza':        'V Pizza',

  // Papa John's
  'papa johns':      "papa john's",

  // Jersey Mike's
  'jersey mikes':    "jersey mike's",

  // Winn-Dixie
  'winn dixie':      'winn-dixie',
  'winndixie':       'winn-dixie',

  // Publix
  'publix pharmacy': 'publix',

  // Walgreens
  'walgreen':         'walgreens',
  'walgreen pharmacy':'walgreens',

  // CVS
  'cvs pharmacy':    'cvs',

  // ABC Fine Wine & Spirits
  'abc liquor':      'abc fine wine',
  'abc wine':        'abc fine wine',
  'abc spirits':     'abc fine wine',

  // Total Wine
  'total wine and more': 'total wine',

  // PetSmart
  'pet smart':       'petsmart',

  // Petco
  'pet co':          'petco',

  // McFlamingo (local — claimed business)
  'mcfl':            'mcflamingo',
  'mc flamingo':     'mcflamingo',
  'the flamingo':    'mcflamingo',
  'flamingo':        'mcflamingo',

  // Restaurant Medure (local)
  'medures':         'medure',
  'restaurant medure': 'medure',

  // Aqua Grill (local)
  'aqua bar':        'aqua grill',
  'aqua bar and grill': 'aqua grill',
  'aqua':            'aqua grill',

  // Palm Valley Fish Camp (local)
  'fish camp':       'palm valley fish camp',
  'pvb fish camp':   'palm valley fish camp',
  'pvfc':            'palm valley fish camp',

  // Two Dudes Seafood (local)
  'two dudes':       'two dudes seafood',

  // Barbara Jean's (local)
  'barbara jeans':   "barbara jean's",
  'barbara jean':    "barbara jean's",

  // Valley Smoke (local)
  'valley smoke bbq':'valley smoke',

  // First Watch
  'first watch cafe':'first watch',

  // Kilwin's
  'kilwins':         "kilwin's",

  // Marble Slab
  'marble slab creamery': 'marble slab',

  // Underwood's
  'underwood':       "underwood's jewelers",
  'underwoods':      "underwood's jewelers",
  "underwood's":     "underwood's jewelers",
  'underwood jewelry':"underwood's jewelers",
};

/**
 * Resolve an alias to its canonical brand name.
 * Returns the canonical name if alias found, else returns the original input unchanged.
 */
function resolveAlias(raw) {
  if (!raw || typeof raw !== 'string') return raw;
  const key = raw.trim().toLowerCase();
  return BRAND_ALIAS_MAP[key] || raw;
}

/**
 * Check if a string matches any known alias (exact or substring).
 * Returns canonical name if matched, else null.
 */
function matchAlias(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const key = raw.trim().toLowerCase();
  if (BRAND_ALIAS_MAP[key]) return BRAND_ALIAS_MAP[key];
  for (const [alias, canonical] of Object.entries(BRAND_ALIAS_MAP)) {
    if (key.includes(alias)) return canonical;
  }
  return null;
}

module.exports = { BRAND_ALIAS_MAP, resolveAlias, matchAlias };
