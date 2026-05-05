// lib/intentRegistry.js
// Single source of truth for natural-language intent → task taxonomy.
// Every entry is normalized through normalizeIntent so consumers never
// receive undefined fields (no silent failures).

function normalizeIntent(raw) {
  return {
    taskClass:       raw.taskClass       ?? 'DISCOVER',
    group:           raw.group           ?? 'general',
    tags:            raw.tags            ?? [],
    cuisine:         raw.cuisine         ?? null,
    category:        raw.category        ?? null,
    resolvesVia:     raw.resolvesVia     ?? 'search',
    temporalContext: raw.temporalContext ?? null,
  };
}

const registry = [
  // ── Temporal intent triggers (Step 4 — When dimension) ───────────────────
  // Carry temporalContext only — no cuisine/category — so they post-filter results.
  // Listed BEFORE cuisine/general entries to match first when a temporal phrase appears.
  { keywords: ['open now', 'open today', 'currently open', 'open right now'],
    taskClass: 'DISCOVER', group: 'general', temporalContext: 'open_now',   resolvesVia: 'search' },
  { keywords: ['happy hour', 'happy hours'],
    taskClass: 'DISCOVER', group: 'bar',     temporalContext: 'happy_hour', resolvesVia: 'search' },
  { keywords: ['late night', 'after hours', 'open late', 'midnight'],
    taskClass: 'DISCOVER', group: 'general', temporalContext: 'late_night', resolvesVia: 'search' },
  { keywords: ['breakfast', 'open for breakfast', 'morning coffee', 'early morning'],
    taskClass: 'DISCOVER', group: 'food',    temporalContext: 'morning',    resolvesVia: 'search' },
  { keywords: ['brunch', 'sunday brunch', 'weekend brunch'],
    taskClass: 'DISCOVER', group: 'food',    temporalContext: 'morning',    resolvesVia: 'search' },
  { keywords: ['lunch', 'open for lunch', 'lunchtime'],
    taskClass: 'DISCOVER', group: 'food',    temporalContext: 'midday',     resolvesVia: 'search' },
  { keywords: ['dinner', 'open for dinner', 'dinner reservation'],
    taskClass: 'DISCOVER', group: 'food',    temporalContext: 'evening',    resolvesVia: 'search' },

  // ── Cuisine (DISCOVER · food) ────────────────────────────────────────────
  { keywords: ['chinese'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'chinese',   resolvesVia: 'search' },
  { keywords: ['sushi', 'japanese', 'ramen'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'japanese',  resolvesVia: 'search' },
  { keywords: ['italian', 'pasta', 'pizza'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'italian',   resolvesVia: 'search' },
  { keywords: ['thai'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'thai',      resolvesVia: 'search' },
  { keywords: ['indian'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'indian',    resolvesVia: 'search' },
  { keywords: ['mexican', 'taco', 'burrito'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'mexican',   resolvesVia: 'search' },
  { keywords: ['bbq', 'barbecue', 'smokehouse'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'bbq',       resolvesVia: 'search' },
  { keywords: ['seafood', 'oyster', 'crab', 'lobster'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'seafood',   resolvesVia: 'search' },
  { keywords: ['burger', 'hamburger'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'american',  resolvesVia: 'search' },
  { keywords: ['steakhouse', 'steak'],
    taskClass: 'DISCOVER', group: 'food', cuisine: 'steakhouse', resolvesVia: 'search' },

  // ── Bar / drink (DISCOVER · bar) ─────────────────────────────────────────
  { keywords: ['whiskey', 'bourbon', 'scotch', 'cocktail', 'nightlife', 'happy hour'],
    taskClass: 'DISCOVER', group: 'bar', category: 'bar',      resolvesVia: 'search' },
  { keywords: ['beer', 'craft beer', 'brewery', 'tap room'],
    taskClass: 'DISCOVER', group: 'bar', category: 'brewery',  resolvesVia: 'search' },
  { keywords: ['wine', 'winery', 'wine bar'],
    taskClass: 'DISCOVER', group: 'bar', category: 'wine_bar', resolvesVia: 'search' },

  // ── Utility / errand (DISCOVER) ──────────────────────────────────────────
  { keywords: ['pharmacy', 'drugstore'],
    taskClass: 'DISCOVER', group: 'health', category: 'pharmacy',    resolvesVia: 'search' },
  { keywords: ['hardware', 'home depot', 'lumber'],
    taskClass: 'DISCOVER', group: 'home', category: 'hardware',      resolvesVia: 'search' },
  { keywords: ['grocery', 'supermarket', 'food store'],
    taskClass: 'DISCOVER', group: 'food', category: 'grocery',       resolvesVia: 'search' },
  { keywords: ['gas station', 'fuel'],
    taskClass: 'DISCOVER', group: 'auto', category: 'gas_station',   resolvesVia: 'search' },
  { keywords: ['vet ', 'veterinarian', 'pet store', 'dog ', 'cat '],
    taskClass: 'DISCOVER', group: 'pet', category: 'pet',            resolvesVia: 'search' },
  { keywords: ['laundry', 'dry cleaning', 'laundromat'],
    taskClass: 'DISCOVER', group: 'home', category: 'laundry',       resolvesVia: 'search' },
  { keywords: ['florist', 'flowers'],
    taskClass: 'DISCOVER', group: 'retail', category: 'florist',     resolvesVia: 'search' },
  { keywords: ['atm', 'bank'],
    taskClass: 'DISCOVER', group: 'finance', category: 'bank',       resolvesVia: 'search' },

  // ── Legacy broad-group fallbacks (DISCOVER) ──────────────────────────────
  { keywords: ['healthy', 'health food', 'organic', 'clean eat', 'nutritious', 'salad', 'vegan', 'vegetarian', 'juice', 'smoothie'],
    taskClass: 'DISCOVER', group: 'food', tags: ['healthy','organic','vegan','vegetarian','juice','salad'], resolvesVia: 'search' },
  { keywords: ['restaurant', 'eat', 'dining', 'food', 'lunch', 'dinner', 'breakfast', 'cafe', 'coffee'],
    taskClass: 'DISCOVER', group: 'food', resolvesVia: 'search' },
  { keywords: ['doctor', 'dentist', 'clinic', 'medical', 'urgent care', 'physic', 'therapy', 'chiro', 'optom'],
    taskClass: 'DISCOVER', group: 'health', resolvesVia: 'search' },
  { keywords: ['lawyer', 'attorney', 'legal', 'law firm'],
    taskClass: 'DISCOVER', group: 'legal', resolvesVia: 'search' },
  { keywords: ['finance', 'invest', 'insurance', 'mortgage', 'credit'],
    taskClass: 'DISCOVER', group: 'finance', resolvesVia: 'search' },
  { keywords: ['shop', 'store', 'retail', 'boutique', 'salon', 'spa', 'beauty', 'gym', 'fitness'],
    taskClass: 'DISCOVER', group: 'retail', resolvesVia: 'search' },

  // ── ORDER / STATUS hints (kept for future routing) ───────────────────────
  { keywords: ['order me', 'order a', 'order an', "i'd like", 'i would like', 'i want', 'get me', 'can i get', 'can i order'],
    taskClass: 'ORDER', group: 'general', resolvesVia: 'surge' },
  { keywords: ['order status', 'delivery status', "where's my order", 'where is my order', 'track my order', 'track order'],
    taskClass: 'STATUS', group: 'general', resolvesVia: 'status' },
];

function resolveIntent(query) {
  if (!query || typeof query !== 'string') return normalizeIntent({});
  const q = query.toLowerCase();
  for (const entry of registry) {
    if (entry.keywords.some(k => q.includes(k))) {
      return normalizeIntent(entry);
    }
  }
  return normalizeIntent({});
}

module.exports = { resolveIntent, normalizeIntent };
