'use strict';
/**
 * inferenceCache.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Prompt → answer cache for the LocalIntel inference engine.
 *
 * Every time a vertical tool, oracle, or ask tool returns a result, the
 * answer is stored here keyed by a normalized prompt fingerprint. Next caller
 * with the same (or similar) intent gets an instant cache hit instead of
 * re-running the full tool chain.
 *
 * Cache structure per ZIP (stored in Postgres inference_cache table):
 *   {
 *     entries: [
 *       {
 *         fingerprint: "restaurant|gap|32082",
 *         query:       "what cuisine gaps exist in 32082",
 *         tool:        "local_intel_restaurant",
 *         zip:         "32082",
 *         vertical:    "restaurant",
 *         answer:      { ...full tool result },
 *         confidence:  82,
 *         hits:        4,
 *         created_at:  "2026-04-21T...",
 *         updated_at:  "2026-04-21T...",
 *         expires_at:  "2026-04-28T..."
 *       }
 *     ],
 *     meta: { total_entries: 1, avg_confidence: 82, last_sweep: "..." }
 *   }
 *
 * TTL by confidence tier:
 *   HIGH  (≥70): 7 days  — solid data, stable
 *   MED   (40-69): 3 days — usable but watch for drift
 *   LOW   (<40):  6 hours — force refresh soon
 *
 * Similarity matching: fingerprint is built from vertical + top keywords,
 * so "where should I open a clinic" and "healthcare gaps in 32082" both
 * resolve to the same cache entry.
 */

// TTL in ms
const TTL = {
  HIGH: 7  * 24 * 60 * 60 * 1000,
  MED:  3  * 24 * 60 * 60 * 1000,
  LOW:  6  * 60 * 60 * 1000,
};

// ── Learned signal hot-reload (from Postgres router_patches) ─────────────────
const LEARNED_RELOAD_MS = 5 * 60 * 1000;
let _learnedSignals  = {};
let _lastLearnedLoad = 0;

async function loadLearnedSignalsFromPostgres() {
  try {
    const pgStore = require('../lib/pgStore');
    const patches = await pgStore.getRouterPatches();
    const next = {};
    for (const [vertical, terms] of Object.entries(patches)) {
      if (!Array.isArray(terms)) continue;
      next[vertical] = new Set(terms.map(t => t.toLowerCase()));
    }
    if (Object.keys(next).length) {
      _learnedSignals = next;
      console.log('[inferenceCache] Loaded', Object.values(next).reduce((s,v) => s + v.size, 0), 'learned terms from Postgres');
    }
  } catch (_) {}
}

function loadLearnedSignals() {
  const now = Date.now();
  if (now - _lastLearnedLoad < LEARNED_RELOAD_MS) return;
  _lastLearnedLoad = now;
  // Always reload from Postgres (flat file is gone)
  loadLearnedSignalsFromPostgres().catch(() => {});
}

// Kick off first load immediately
loadLearnedSignalsFromPostgres().catch(() => {});
// Refresh on interval
setInterval(loadLearnedSignals, LEARNED_RELOAD_MS).unref();

// ── Stop words for fingerprint normalization ──────────────────────────────────
const STOP = new Set([
  'a','an','the','in','on','at','for','of','to','is','are','do','does',
  'what','where','how','many','much','there','i','my','me','we','our',
  'should','would','could','will','can','want','looking','thinking','about',
  'open','start','launch','business','market','area','town','city','region',
  'northeast','florida','fl','county','zip','code',
]);

// ── Vertical vocabulary — full job/role/trade/business-type coverage ─────────
// Every term maps to a vertical. detectVertical() SCORES all verticals and
// returns the highest-scoring one — not first-match regex.
// Agents just ask in plain English; they never need to know vertical names.
const VERTICAL_VOCAB = {

  restaurant: [
    // business types
    'restaurant','dining','cafe','eatery','diner','bistro','brasserie','gastropub',
    'food truck','ghost kitchen','cloud kitchen','dark kitchen','commissary',
    'bar','pub','tavern','brewery','brewpub','winery','distillery','cocktail bar',
    'wine bar','sports bar','nightclub','lounge','speakeasy',
    'coffee shop','coffeehouse','coffee bar','espresso bar','tea room',
    'bakery','pastry','bagel','donut','ice cream','frozen yogurt','dessert',
    'pizza','pizzeria','sushi','ramen','pho','thai','chinese','japanese',
    'indian','mexican','taco','burrito','bbq','barbecue','seafood','steakhouse',
    'burger','sandwich','deli','sub','hoagie','wrap','salad bar',
    'fast casual','fast food','quick service','drive through','counter service',
    'fine dining','upscale dining','white tablecloth','prix fixe',
    'breakfast','brunch','lunch','dinner','late night','daypart',
    'franchise food','food hall','pop up food',
    // job titles
    'line cook','line chef','prep cook','prep chef','fry cook','grill cook',
    'pastry chef','executive chef','head chef','sous chef','chef de partie',
    'saucier','garde manger','expeditor','expo','runner','food runner',
    'dishwasher','steward','kitchen manager','kitchen supervisor',
    'bartender','barback','bar manager','head bartender','mixologist',
    'server','waiter','waitress','waitstaff',
    'host','hostess','maitre d',
    'busser','food and beverage manager','f&b manager',
    'dining room manager','floor manager','front of house','foh','foh manager',
    'back of house','boh','restaurant manager','general manager restaurant',
    'sommelier','wine director','beverage director',
    'catering manager','event chef','banquet chef','banquet server',
    'barista','coffee roaster',
    // market terms
    'cuisine','daypart gap','food cost','covers','table turns',
    'food saturation','restaurant density','dining saturation',
  ],

  healthcare: [
    // practice types
    'clinic','hospital','urgent care','walk-in','walk in','emergency room',
    'primary care','family medicine','internal medicine','general practice',
    'doctor','physician',
    'dentist','dental','orthodontist','periodontist','endodontist','oral surgeon',
    'optometrist','ophthalmologist','vision care','eye doctor','eye care',
    'pharmacy','pharmacist','compounding pharmacy',
    'physical therapy','physical therapist','physiotherapy',
    'occupational therapy','occupational therapist',
    'speech therapy','speech therapist','speech language',
    'chiropractic','chiropractor','chiro','spinal adjustment',
    'mental health','psychiatrist','psychiatry','psychologist','psychology',
    'therapist','counselor','counseling','behavioral health',
    'acupuncture','acupuncturist','integrative medicine','functional medicine',
    'naturopath','naturopathic','holistic',
    'dermatologist','dermatology','skin care clinic',
    'cardiologist','cardiology','heart specialist',
    'orthopedic','orthopedist','sports medicine','joint replacement',
    'neurologist','neurology',
    'urologist','urology',
    'gastroenterologist','gastroenterology','gi doctor',
    'endocrinologist','endocrinology','thyroid',
    'rheumatologist','rheumatology','arthritis specialist',
    'oncologist','oncology','cancer center',
    'pediatrician','pediatric','children doctor',
    'obgyn','ob-gyn','gynecologist','gynecology','womens health',
    'fertility clinic','reproductive medicine','ivf','infertility',
    'midwife','midwifery','birth center',
    'audiologist','audiology','hearing specialist','hearing aid',
    'podiatrist','podiatry','foot doctor','foot specialist',
    'pain management','pain clinic','spine clinic',
    'med spa','medical spa','aesthetic clinic','aesthetics','medspa',
    'cosmetic surgery','plastic surgery','plastic surgeon',
    'weight loss clinic','weight management','bariatric',
    'hormone therapy','hormone clinic','trt','testosterone','hrt',
    'iv therapy','iv clinic','infusion clinic','infusion center',
    'imaging center','mri','x-ray','xray','radiology','ct scan','ultrasound',
    'sleep center','sleep medicine','sleep study',
    'wound care','dialysis',
    'home health','home care','hospice','palliative care',
    'rehab','rehabilitation','outpatient rehab',
    // job titles
    'nurse','registered nurse','nurse practitioner','physician assistant',
    'medical assistant','care coordinator','patient coordinator',
    'medical biller','medical coder','billing specialist',
    'lab technician','phlebotomist','radiology tech',
    'pharmacy technician','pharmacy tech',
    'dental hygienist','dental assistant',
    'health coach','wellness coach','nutritionist','dietitian',
    'fitness trainer','personal trainer','strength coach',
    // market terms
    'patient demand','provider ratio','physician shortage','healthcare gap',
    'healthcare saturation','medical desert','specialist gap',
  ],

  retail: [
    // store types
    'retail store','boutique','specialty store','concept store',
    'grocery','supermarket','food market','natural foods','organic market',
    'convenience store','corner store',
    'clothing store','apparel','fashion boutique','menswear','womenswear',
    'shoe store','footwear','sneaker shop',
    'jewelry store','jeweler','watch store',
    'home goods','furniture store','home decor',
    'electronics store','tech store','computer store',
    'sporting goods','outdoor gear','fitness equipment','golf shop',
    'bike shop','surf shop','dive shop',
    'pet store','pet supply','pet boutique',
    'hardware store','home improvement','lumber yard',
    'garden center','nursery','plant shop',
    'bookstore','stationary','office supply',
    'toy store','game store','hobby shop',
    'music store','instrument shop',
    'wine shop','liquor store','bottle shop','beer store',
    'florist','flower shop','gift shop',
    'salon','hair salon','nail salon','barbershop','spa',
    'dry cleaner','laundry','alterations','tailor',
    'art gallery','frame shop',
    'thrift store','consignment','second hand','resale',
    'dollar store','discount store','outlet',
    'vape shop','smoke shop',
    'cell phone store','mobile store','wireless store',
    'optical store','glasses','eyewear store',
    // job titles
    'retail associate','sales associate','store associate','retail clerk',
    'cashier','checker',
    'store manager','retail manager','assistant store manager',
    'department manager','floor manager retail','shift supervisor retail',
    'visual merchandiser','display specialist','store planner',
    'inventory manager','stock associate','stocker','receiving associate',
    'loss prevention','asset protection',
    'buyer','purchasing agent','merchandise planner',
    'district manager retail','regional manager retail',
    'customer service rep','service desk',
    // market terms
    'retail gap','spending capture','retail saturation','consumer spending',
    'retail density','shopping corridor','anchor tenant',
  ],

  construction: [
    // trades / business types
    'general contractor','home builder','custom builder',
    'roofing','roofer','roof repair','roof replacement',
    'plumber','plumbing','pipe repair','drain cleaning','water heater',
    'electrician','electrical contractor','wiring',
    'hvac','air conditioning','ac repair','heating','ventilation',
    'landscaping','landscaper','lawn care','lawn service','yard maintenance',
    'tree service','tree trimming','arborist',
    'pool builder','pool installer','pool service','pool repair','pool contractor',
    'masonry','mason','bricklayer','brick work','stone work',
    'concrete','concrete contractor','stamped concrete',
    'foundation','foundation repair','slab','crawl space',
    'framing','framer',
    'drywall','sheetrock','plastering',
    'tile','tile setter','tile installer',
    'flooring','hardwood floors','carpet installer','luxury vinyl',
    'painting','painter','exterior painting','interior painting',
    'pressure washing','power washing','soft washing',
    'gutter','gutter installation','gutter cleaning','gutter guard',
    'fence','fencing','fence installer','privacy fence',
    'irrigation','sprinkler system','irrigation contractor',
    'solar','solar installer','solar panels',
    'generator','standby generator','whole home generator',
    'pavers','paving','hardscape','paver installation',
    'stucco','stucco contractor','stucco repair',
    'siding','hardie board','vinyl siding',
    'insulation','spray foam','blown in insulation',
    'waterproofing','basement waterproof',
    'septic','septic tank','septic system','drain field',
    'excavation','grading','land clearing',
    'demolition','demo contractor',
    'junk removal','hauling','debris removal',
    'deck','deck builder','composite deck',
    'patio','patio builder',
    'pergola','gazebo','shade structure',
    'screen room','screen enclosure','florida room',
    'sunroom','four season room','home addition',
    'kitchen remodel','kitchen renovation',
    'bathroom remodel','bath renovation',
    'cabinet','cabinet maker','cabinetry',
    'countertop','granite','quartz',
    'handyman','home repair',
    'window replacement','window installer','impact windows',
    'door installer','impact doors','garage door',
    'pest control','termite','exterminator','fumigation',
    'mold remediation','water damage','fire damage','restoration',
    'home inspection','inspection service',
    'locksmith','security system','alarm system',
    // job titles
    'superintendent','project superintendent',
    'project manager construction','construction pm',
    'estimator','cost estimator','takeoff specialist',
    'foreman','crew leader','site foreman',
    'laborer','construction laborer',
    'carpenter','finish carpenter','trim carpenter','rough carpenter',
    'welder','ironworker',
    'crane operator','heavy equipment operator',
    'concrete finisher',
    'plumbing apprentice','journeyman plumber','master plumber',
    'electrical apprentice','journeyman electrician','master electrician',
    'hvac technician','hvac installer','hvac apprentice',
    'construction manager',
    // market terms
    'permit velocity','permit pull','construction pipeline',
    'housing starts','new construction','spec home',
    'infrastructure momentum','development activity',
    'construction saturation','trade shortage','subcontractor gap',
  ],

  realtor: [
    // business types
    'real estate','realtor','realty','real estate office','brokerage',
    'property management','property manager',
    'title company','title insurance','closing company',
    'mortgage','mortgage broker','lender','loan officer','underwriter',
    'home inspector','appraisal company','real estate appraiser',
    'escrow company','home stager','staging company',
    // job titles
    'real estate agent','listing agent','buyers agent',
    'real estate broker','managing broker',
    'real estate investor','flipper','wholesaler',
    'leasing agent','leasing consultant',
    'commercial broker','commercial real estate',
    'real estate developer','land developer',
    'real estate attorney','closing attorney',
    // property / market terms
    'single family','townhouse','townhome','condo','condominium',
    'multifamily','duplex','apartment complex',
    'commercial property','office building','retail space',
    'industrial','warehouse','self storage',
    'vacant land','raw land','acreage',
    'home value','median price','list price','sale price','price per sqft',
    'days on market','inventory','months of supply','absorption rate',
    'buyer market','seller market','hot market','cooling market',
    'appreciation','cap rate','noi','roi','cash on cash',
    'rental income','rental yield','rent roll','vacancy rate',
    'owner occupied','investment property',
    'fix and flip','buy and hold',
    'flood zone','flood insurance','flood risk',
    'hoa','homeowners association','deed restriction','covenant',
    'zoning','rezoning','land use','entitlement',
    'foreclosure','short sale','distressed property',
    'school district','school rating','school zone',
    'gated community','master planned','subdivision',
  ],
};

// Build reverse index: term → vertical (used by scorer)
const _termIndex = new Map();
for (const [vertical, terms] of Object.entries(VERTICAL_VOCAB)) {
  for (const term of terms) {
    if (!_termIndex.has(term)) _termIndex.set(term, vertical);
  }
}

// Regex fast-path for strong single-keyword signals
const VERTICAL_SIGNALS = {
  restaurant:   /\brestaurant\b|\bdining\b|bartend|barback|\bbusser\b|line cook|sous chef|prep cook|pastry chef|sommelier|\bbarista\b|\bfoh\b|\bboh\b|dishwasher|expeditor|\bbrewery\b|gastropub/i,
  healthcare:   /urgent care|walk.in clinic|\bpharmacy\b|physical therap|occupational therap|speech therap|chiropract|dermatolog|cardiolog|orthoped|neurolog|psychiatr|psycholog|acupunctur|med spa|medspa|aestheti|\bimaging\b|\bmri\b|\binfusion\b|\bhospice\b|podiatr|pain manag|hormone clinic|iv therap|\bobgyn\b|gynecolog|fertility clinic|audiolog|naturopath/i,
  retail:       /\bboutique\b|supermarket|convenience store|sporting goods|\bpet store\b|hardware store|visual merchand|loss prevention|\bcashier\b|sales associate|retail manager|merchandise planner/i,
  construction: /\bplumber\b|\belectrician\b|\bhvac\b|\broofer\b|\bmasonry\b|\bconcrete\b|\bframing\b|\bdrywall\b|\bpavers\b|\bhardscape\b|\bstucco\b|\bsiding\b|\binsulation\b|\bseptic\b|excavat|\bhandyman\b|screen room|\bcarpenter\b|\bwelder\b|\bforeman\b|superintendent|\bestimator\b|pool builder|solar panel|irrigation system/i,
  realtor:      /real estate|\brealtor\b|mortgage broker|loan officer|title company|home stager|days on market|cap rate|\bforeclosure\b|homeowners assoc|\bzoning\b|single family|multifamily|listing agent|buyers agent/i,
};

// Geographic signals for ZIP resolution
const GEO_SIGNALS = [
  { pattern: /ponte.vedra/i,           zip: '32082' },
  { pattern: /nocatee/i,               zip: '32081' },
  { pattern: /world.golf|wgv/i,        zip: '32092' },
  { pattern: /st\.?augustine.beach/i,  zip: '32080' },
  { pattern: /st\.?augustine.south/i,  zip: '32086' },
  { pattern: /st\.?augustine/i,        zip: '32084' },
  { pattern: /palm.valley/i,           zip: '32095' },
  { pattern: /fruit.cove|saint.johns/i,zip: '32259' },
  { pattern: /jax.?beach|jacksonville.beach/i, zip: '32250' },
  { pattern: /neptune.beach/i,         zip: '32266' },
  { pattern: /bartram/i,               zip: '32258' },
  { pattern: /atlantic.beach/i,        zip: '32233' },
  { pattern: /fernandina/i,            zip: '32034' },
  { pattern: /yulee/i,                 zip: '32097' },
  { pattern: /orange.park/i,           zip: '32073' },
  { pattern: /fleming.island/i,        zip: '32003' },
  { pattern: /baymeadows|tinseltown/i, zip: '32256' },
  { pattern: /mandarin/i,              zip: '32257' },
  { pattern: /southside/i,             zip: '32216' },
  { pattern: /san.jose/i,              zip: '32217' },
  { pattern: /southbank/i,             zip: '32207' },
  { pattern: /arlington/i,             zip: '32225' },
  { pattern: /regency/i,               zip: '32246' },
  { pattern: /\b(\d{5})\b/,           zip: null },
];

const DEFAULT_ZIP = '32082';

// ── Default cache structure ───────────────────────────────────────────────────
function emptyCacheObj() {
  return { entries: [], meta: { total_entries: 0, avg_confidence: 0, last_sweep: null } };
}

// ── Postgres-backed load/save ─────────────────────────────────────────────────
async function loadCache(zip) {
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const pgStore = require('../lib/pgStore');
      const cached  = await pgStore.getInferenceCache(zip);
      if (cached) return cached;
    }
  } catch (_) {}
  return emptyCacheObj();
}

async function saveCache(zip, data) {
  try {
    if (process.env.LOCAL_INTEL_DB_URL) {
      const pgStore = require('../lib/pgStore');
      await pgStore.upsertInferenceCache(zip, data);
    }
  } catch (_) {}
}

// ── Pure utility (sync, no IO) ────────────────────────────────────────────────

function confidenceTier(score) {
  if (score >= 70) return 'HIGH';
  if (score >= 40) return 'MED';
  return 'LOW';
}

function ttlMs(score) {
  return TTL[confidenceTier(score)];
}

function buildFingerprint(query, vertical, zip) {
  const tokens = query.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP.has(t))
    .slice(0, 6);
  return [vertical, ...tokens, zip].join('|');
}

function fingerprintSimilarity(fpA, fpB) {
  const tokA = new Set(fpA.split('|'));
  const tokB = new Set(fpB.split('|'));
  const intersection = [...tokA].filter(t => tokB.has(t)).length;
  const union = new Set([...tokA, ...tokB]).size;
  return union === 0 ? 0 : intersection / union;
}

function detectVertical(query) {
  loadLearnedSignals();
  const lower = query.toLowerCase();

  // ── Pass 1: score every vertical by vocabulary term hits ─────────────────
  // Tokenise into unigrams AND bigrams so "line cook" scores as one hit
  // not two partial hits against unrelated terms.
  const words  = lower.replace(/[^a-z0-9& ]/g, ' ').split(/\s+/).filter(Boolean);
  const scores = { restaurant: 0, healthcare: 0, retail: 0, construction: 0, realtor: 0 };

  // Unigrams
  for (const w of words) {
    const v = _termIndex.get(w);
    if (v) scores[v] += 1;
  }
  // Bigrams (e.g. "line cook", "sous chef", "urgent care", "real estate")
  for (let i = 0; i < words.length - 1; i++) {
    const bigram = words[i] + ' ' + words[i + 1];
    const v = _termIndex.get(bigram);
    if (v) scores[v] += 2; // bigrams worth more — more specific
  }
  // Trigrams (e.g. "physical therapy clinic", "master planned community")
  for (let i = 0; i < words.length - 2; i++) {
    const trigram = words[i] + ' ' + words[i + 1] + ' ' + words[i + 2];
    const v = _termIndex.get(trigram);
    if (v) scores[v] += 3;
  }

  // ── Pass 2: apply learned signals from Postgres (router_patches) ──────────
  for (const [vertical, termSet] of Object.entries(_learnedSignals)) {
    for (const term of termSet) {
      if (lower.includes(term)) scores[vertical] = (scores[vertical] || 0) + 2;
    }
  }

  // ── Pick winner if any vertical scored ────────────────────────────────────
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (best && best[1] > 0) return best[0];

  // ── Pass 3: regex fast-path for strong single keywords ────────────────────
  for (const [v, pattern] of Object.entries(VERTICAL_SIGNALS)) {
    if (pattern.test(query)) return v;
  }

  return null;
}

function detectZip(query) {
  const literalMatch = query.match(/\b(\d{5})\b/);
  if (literalMatch) return literalMatch[1];
  for (const sig of GEO_SIGNALS) {
    if (sig.zip && sig.pattern.test(query)) return sig.zip;
  }
  return null;
}

// ── Public API (async) ────────────────────────────────────────────────────────

/**
 * get(query, vertical, zip) → cache entry or null
 * Returns a valid (non-expired) cache hit if similarity >= threshold.
 */
async function get(query, vertical, zip) {
  if (!zip) return null;
  const cache = await loadCache(zip);
  const fp    = buildFingerprint(query, vertical, zip);
  const now   = Date.now();

  let best    = null;
  let bestSim = 0;

  for (const entry of cache.entries) {
    if (new Date(entry.expires_at).getTime() < now) continue;
    if (entry.vertical !== vertical) continue;

    const sim = fingerprintSimilarity(fp, entry.fingerprint);
    if (sim > bestSim) { bestSim = sim; best = entry; }
  }

  if (bestSim >= 0.5 && best) {
    best.hits    = (best.hits || 0) + 1;
    best.last_hit = new Date().toISOString();
    await saveCache(zip, cache);
    return { ...best, cache_hit: true, similarity: bestSim };
  }

  return null;
}

/**
 * set(query, vertical, zip, tool, answer, confidence)
 * Stores a prompt→answer pair. Upserts if fingerprint already exists.
 */
async function set(query, vertical, zip, tool, answer, confidence) {
  if (!zip) return;

  const cache = await loadCache(zip);
  const fp    = buildFingerprint(query, vertical, zip);
  const now   = new Date();
  const exp   = new Date(now.getTime() + ttlMs(confidence));

  const idx = cache.entries.findIndex(e => e.fingerprint === fp);
  const entry = {
    fingerprint: fp,
    query,
    tool,
    zip,
    vertical,
    answer,
    confidence,
    hits:       idx >= 0 ? (cache.entries[idx].hits || 0) : 0,
    created_at: idx >= 0 ? cache.entries[idx].created_at : now.toISOString(),
    updated_at: now.toISOString(),
    expires_at: exp.toISOString(),
    ttl_tier:   confidenceTier(confidence),
  };

  if (idx >= 0) {
    cache.entries[idx] = entry;
  } else {
    cache.entries.push(entry);
  }

  const valid = cache.entries.filter(e => new Date(e.expires_at).getTime() > Date.now());
  cache.meta = {
    total_entries:  valid.length,
    avg_confidence: valid.length
      ? Math.round(valid.reduce((s, e) => s + (e.confidence || 0), 0) / valid.length)
      : 0,
    last_sweep: now.toISOString(),
  };
  cache.entries = valid;

  await saveCache(zip, cache);
}

/**
 * invalidate(zip, vertical) — force-expire all entries for a ZIP+vertical.
 */
async function invalidate(zip, vertical) {
  if (!zip) return;
  const cache = await loadCache(zip);
  const past  = new Date(0).toISOString();
  cache.entries = cache.entries.map(e => {
    if (!vertical || e.vertical === vertical) return { ...e, expires_at: past };
    return e;
  });
  await saveCache(zip, cache);
}

/**
 * stats() — aggregate cache health across all ZIPs
 */
async function stats() {
  try {
    if (!process.env.LOCAL_INTEL_DB_URL) return { total_entries: 0, total_hits: 0, expired: 0, high_confidence: 0, zips_cached: 0 };
    const pgStore = require('../lib/pgStore');
    const rows    = await pgStore.getAllInferenceCacheStats();
    let total = 0, hits = 0, expired = 0, highConf = 0;
    const now = Date.now();
    for (const row of rows) {
      for (const e of ((row.cache_json || {}).entries || [])) {
        total++;
        hits    += (e.hits || 0);
        if (new Date(e.expires_at).getTime() < now) expired++;
        if ((e.confidence || 0) >= 70) highConf++;
      }
    }
    return { total_entries: total, total_hits: hits, expired, high_confidence: highConf, zips_cached: rows.length };
  } catch (_) {
    return { total_entries: 0, total_hits: 0, expired: 0, high_confidence: 0, zips_cached: 0 };
  }
}

module.exports = { get, set, invalidate, stats, detectVertical, detectZip, buildFingerprint };
