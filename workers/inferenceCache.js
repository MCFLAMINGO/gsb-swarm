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
    // ── Women's Product Searches & Shopping Slang (2026) ──
    // Fashion
    'wireless bra','supportive bralette','seamless bra','push-up bra','comfy bra','no-wire bra',
    'cotton underwear','bikini briefs','seamless panties','period underwear','shapewear','sculpting shorts',
    'cute top','ribbed tank','baby tee','oversized button-down','going-out top',
    'tank top','sleeveless tee',
    'leggings','flare leggings','butt-lifting leggings','activewear','athleisure','athleisure set','pilates princess',
    'wide leg pants','palazzo pants','linen pants','flowy pants','barrel jeans','effortless pants',
    'summer dress','tennis dress','casual dress','wrap dress','floral dress','little black dress','lbd',
    'coquette dress','that girl dress','that girl outfit','that girl vibe',
    'graphic tee','oversized tee','basic tee',
    'relaxed jeans','high rise jeans','mom jeans','baggy jeans','high-rise denim',
    'cozy hoodie','oversized sweatshirt','cardigan',
    'crocs','clogs','water shoes','cloud shoes','arch support sandals','ballet flats','kitten heels','cute kicks',
    'puffer coat','quilted jacket','overshirt',
    'romper','jumpsuit',
    'nipple covers','nippies',
    'pajamas','loungewear','cozy socks','silky set','pajama set','bed rot',
    'swimwear','bikini','cover up','maternity wear',
    'skirt','wrap skirt','mini skirt',
    'fit check','new fit','haul','amazon finds','amazon haul','glow-up clothes','comfy but cute',
    // Beauty products
    'moisturizer','tallow moisturizer','beef tallow moisturizer','holy grail cream','slugging',
    'lip balm','lip stain','lip gloss','lip combo','glazed donut lips','tinted balm',
    'mascara','sky high mascara','tubing mascara','lash serum','lash lift at home',
    'sunscreen','spf','tinted sunscreen','spf girly',
    'face mask','sheet mask','sheet mask moment','glass skin routine',
    'niacinamide serum','vitamin c serum','snail mucin serum','niacinamide glow','hydration bomb',
    'acne patch','pimple patch','mighty patch','zit sticker','hero patch',
    'body lotion','eos lotion',
    'makeup remover wipes','micellar water',
    'blush','highlighter','halo glow','blush dump','clean girl makeup','dewy base','no-makeup makeup',
    'foundation','tinted moisturizer','bb cream','cc cream',
    'eye cream','neck cream','retinol cream',
    'cleanser','facial wash','face wash',
    'exfoliator','chemical exfoliant',
    'dermaplaning tool','face razor',
    'shampoo','conditioner','olaplex mask','dry shampoo','olaplex girl',
    'perfume','body spray','fragrance',
    'nail polish','press on nails','gel nail kit',
    'brow gel','brow lamination kit','soap brows',
    'deodorant',
    'skincare girly','glow-up haul','shelfie','holy grail products','that girl routine','self-care goodies',
    // Hair tools
    'blow dryer','hair dryer','dyson airwrap','flat iron','curling iron','curling wand','blowout tools','heatless curls',
    'hair clips','claw clips','clip-in extensions','clip ins',
    'hair growth supplement','viviscal',
    'hair brush','wide tooth comb','detangling brush',
    'electric toothbrush','teeth whitening strips',
    // Accessories & Jewelry
    'sunglasses','sunglasses slay',
    'handbag','purse','crossbody bag','tote bag','mini bag','it bag','structured tote','woven bag','everyday carry',
    'earrings','hoop earrings','gold hoops','chunky earrings','stud earrings',
    'gold necklace','layered necklaces','bracelet','charm bracelet','stacked jewelry','statement bag',
    'watch','smart watch',
    'baseball cap','bucket hat','sun hat',
    'silk scarf','phone case',
    // Wellness & Home products
    'womens multivitamin','collagen supplement','hair skin nails gummies','wellness girl stack',
    'yoga mat','resistance band','workout set',
    'stanley cup','insulated water bottle',
    'weighted blanket','cozy blanket',
    'cozy girl candles','reed diffuser','room spray',
    'gua sha','lymphatic drainage tool','led face mask','red light therapy device',
    'journal','planner','journaling era','that girl setup',
    'smart scale','self tanner','tanning drops',
    'whitening kit','mani pedi kit','nail kit','skincare starter kit',
    // Shopping slang / combo phrases
    'tiktok made me buy it','sephora cart','full restock','monthly maintenance','glow-up kit',
    'add to cart','amazon cart','basics refresh','essentials restock',
    'high maintenance low effort','clean girl aesthetic','coquette core','preppy girly','mob wife',
    'summer slay','vacation fits','back to school haul',
    'sephora haul','ulta haul','beauty haul','skincare haul',
    // ── Men's Product Searches & Shopping Slang (2026) ──
    // Fashion & Clothing
    'boxer briefs','mens underwear','moisture wicking underwear','underwear multipack',
    'mens t-shirt','crew neck tee','pocket tee','graphic tee mens','plain tee pack',
    'polo shirt','mens button down','mens button-down',
    'chinos','cargo pants','straight fit jeans','mens jeans',
    'quarter zip','mens hoodie','mens sweatshirt',
    'athletic shorts','gym shorts','compression pants','workout pants','joggers',
    'bomber jacket','puffer jacket','flannel overshirt','carhartt','work jacket',
    'white sneakers','dad shoes','hiking boots','work boots','mens sneakers',
    'compression socks','crew socks','no-show socks','sock pack',
    'lounge pants','sweatpants','mens pajamas',
    'muscle shirt','mens tank top',
    'dress shirt','mens suit','swim trunks',
    'mens belt','mens wallet',
    // Grooming & Personal Care
    'electric trimmer','body groomer','manscaped','philips norelco','the lawnmower',
    'mens cologne','fragrance mens','dior sauvage','versace cologne','montblanc legend',
    'cologne sample','signature scent','new frag','layering scents',
    'mens deodorant','clinical strength mens','antiperspirant',
    'face moisturizer mens','post-shave balm','aftershave',
    'shaving cream','shaving gel','safety razor','mens razor','razor bump',
    'beard oil','beard balm','beard trimmer','beard kit','beard game',
    'pomade','matte clay','sea salt spray','mens hair product',
    'minoxidil','biotin hair','hair loss treatment',
    'dry shampoo mens','body wash mens','bar soap',
    'whitening toothpaste mens','electric toothbrush mens',
    // Shoes & Accessories (mens)
    'new kicks','fresh sneakers','boot season','beater shoes',
    'mens sunglasses','shades',
    'mens watch','classic watch',
    'baseball cap','trucker hat','beanie',
    'backpack','duffel bag','gym bag','laptop bag',
    'phone case mens','power bank','portable charger',
    // Wellness, Tech & Home (mens)
    'protein powder','protein supplement','supps','mens multivitamin',
    'hydro flask','mens water bottle',
    'dumbbells','resistance bands mens','fitness gear mens',
    'massage gun mens',
    'wireless earbuds','headphones','airpods',
    'multi-tool','pocket knife','tactical pants',
    'grill accessories','air fryer mens','cooler','yeti cooler',
    // Men's shopping slang / phrases
    'new fits','fresh threads','wardrobe refresh','copped some gear','daily uniform',
    'work to gym rotation','gym drip','dad fit check','business casual rotation',
    'fresh cut','lined up','grooming sesh','maintenance day mens','smell good','smelling right',
    'clean shave','beard oil game','skincare but make it manly',
    'copped new kicks','boot season','dad shoes era',
    'trim the bushes','get a lineup','manscaped run',
    'payday cop','gear up','upgrade','lowkey needed this',
    'essentials restock mens','amazon haul mens','underwear haul',
    'new hoodie drop','comfy fit','oversized for lounging',
    'new chinos','gym pants','durable work pants',
    'new cologne','this one hits different',
    'full maintenance haircut','gym clothes supplements','beard trim deodorant',
    'hoodie and joggers','basic tees','quarter-zip for the win',
    // ── Collector Cards (Trading Cards / Sports Cards / Pokémon / MTG) ──
    // Products & formats
    'trading cards','collector cards','sports cards','pokemon cards','magic the gathering','mtg cards',
    'booster box','booster pack','elite trainer box','etb','blaster box','hobby box','mega box',
    'sealed product','sealed box','card tin','collection box',
    'pokemon tcg','pokemon booster','pokemon set',
    'basketball cards','football cards','baseball cards','nba cards','nfl cards','mlb cards',
    'rookie card','rc card','rookie patch auto','rpa card','auto card','autograph card',
    'graded card','psa 10','bgs 9.5','sgc graded','cgc card','slab card','slabbed card',
    'raw card','ungraded card',
    'numbered parallel','numbered card','1 of 1','one of one',
    'vintage card','1952 topps','t206','base set pokemon','shadowless','1st edition pokemon',
    'charizard card','charizard ex','umbreon card','pikachu illustrator',
    'cooper flagg card','shohei ohtani card','paul skenes card','lebron card','jordan rookie',
    'commander deck','mtg singles','dual lands','booster draft',
    'yugioh cards','one piece cards','lorcana cards','flesh and blood tcg',
    'card sleeve','top loader','card binder','card saver','card display case',
    'grading submission','psa submission','bgs submission',
    'whatnot break','group break','live break','box break',
    // Collector slang
    'ripping packs','rip this box','ripping tonight','pack rip',
    'chase card','pulled the chase','big hit','pack hit',
    'god pack','alt art card','full art card','secret rare','holo card','reverse holo',
    'my grail','white whale card','dream card','pc card','personal collection card',
    'card is mooning','card stonks','market heating up','low pop report',
    'copped some slabs','added to the pc','ebay snipe','payday rip','sniped a deal',
    'pulled a brick','pack luck','set is mid','completed the set','psa 10 pop 1',
    'card is fire','card is clean','off-centered','beater card',
    'investment flip card','sealed investment','grail card','grail pull',
    // ── Sports Equipment (Student & Pro, 2026) ──
    'dumbbells','adjustable weights','neoprene weights','resistance bands','resistance loops','mobility bands',
    'exercise mat','yoga mat','foam roller','massage gun','hyperice','portable sauna','ice bath',
    'agility ladder','speed cones','training cones','jump rope','weighted jump rope','speed rope',
    'owala bottle','sports water bottle',
    'basketball','indoor basketball','outdoor basketball','composite basketball','leather game ball',
    'basketball shoes','high tops','ankle brace','ankle sleeve','shooting sleeve','arm band',
    'dribble goggles','weighted basketball',
    'soccer cleats','football cleats','firm ground cleats','turf cleats','molded cleats',
    'soccer ball','match ball','training ball','rugby ball',
    'mouthguard','shin guards','shoulder pads','football helmet','receiver gloves','goalkeeper gloves',
    'compression shorts','compression tights','portable goal','practice net',
    'nike mercurial','adidas predator','custom mouthguard',
    'baseball glove','softball glove','catchers mitt','fielders glove',
    'aluminum bat','composite bat','bbcor bat','youth bat',
    'baseball','softballs','batting helmet','baseball cleats','batting gloves','batting tee','pitching net',
    'tennis racket','pickleball paddle','racquetball racket','badminton racket',
    'tennis balls','pickleball balls','overgrip','tennis grip','court shoes','racket bag',
    'wilson racket','babolat racket','head racket',
    'running shoes','distance trainers','track spikes','carbon plate shoes',
    'compression socks running','compression sleeves','running headband','running visor',
    'gps watch','fitness tracker','garmin watch','parachute trainer','resistance harness',
    'golf clubs','golf irons','golf driver','golf wedge','golf putter',
    'golf balls','golf tees','golf glove','golf rangefinder','golf bag',
    'swim goggles','swim cap','swim fins','pull buoy','kickboard','swim paddles',
    'volleyball','volleyball kneepads','volleyball net','volleyball shoes',
    'hockey stick','ice skates','hockey pads','hockey helmet','hockey gloves','field hockey stick',
    'fresh cleats','cleats are gas','new trainers','broke in trainers',
    'game ball','practice rock','new stick','fresh bat','strung up my racket',
    'mouthguard game','strapped up','ankle sleeve on lock',
    'agility ladder sesh','band work','hitting the roller',
    'compression game','new dri-fit','practice uniform','fresh kit','new gear drop',
    'budget cop','for tryouts','sponsor gear','custom fit','pro model',
    'full kit refresh','gear check','team issued','these boots are cheating',
    'shadowless card','first edition card',
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

// ── Beauty & Personal Care taxonomy ─────────────────────────────────────────
// Covers hair, nails, skin, brows/lashes, body, waxing, and medspa-adjacent services.
// Each term maps to the 'beauty' vertical so searches like "I need a Brazilian blowout"
// or "gel manicure near me" route to salons/spas, not landscapers.
const BEAUTY_TERMS = [
  // ── Venues ──
  'hair salon','nail salon','beauty salon','day spa','medspa','med spa','medical spa',
  'barbershop','barber shop','blow dry bar','blowout bar','lash studio','brow bar',
  'tanning salon','spray tan studio','waxing studio','waxing center','threading salon',
  'skin care clinic','aesthetics studio','cosmetic studio',

  // ── Hair Services ──
  'haircut','women\'s haircut','men\'s haircut','kids haircut',
  'hair styling','blowout','blow dry','blowout service',
  'hair color','hair colour','root touch-up','root touch up','gray coverage','grey coverage',
  'highlights','partial highlights','full highlights',
  'balayage','ombre','sombre','color melt','babylights','foilayage',
  'keratin treatment','keratin','brazilian blowout','smoothing treatment','frizz treatment',
  'deep conditioning','olaplex','bond repair','hair mask','protein treatment',
  'scalp treatment','scalp facial','scalp massage',
  'hair extensions','tape-in extensions','tape in extensions','sew-in extensions',
  'clip-in extensions','weft extensions','halo extensions','fusion extensions',
  'perm','body wave','relaxer','hair straightening','chemical straightening',
  'updo','wedding hair','bridal hair','event styling','formal style','prom hair',
  'trim','dusting','split end treatment',

  // ── Nail Care ──
  'manicure','spa manicure','gel manicure','gel nails',
  'pedicure','spa pedicure','gel pedicure',
  'dip powder','dip nails','acrylic nails','acrylics','gel-x','gel x','hard gel',
  'nail overlay','nail overlay service','nail extensions','press-on nails',
  'nail art','nail design','chrome nails','nail embellishments',
  'paraffin treatment','paraffin wax hands','paraffin wax feet',
  'mani pedi','mani-pedi','manicure and pedicure',
  'nail fill','acrylic fill','gel fill',
  'nail removal','soak off',

  // ── Skin & Facial Treatments ──
  'facial','customized facial','hydrating facial','anti-aging facial',
  'acne facial','brightening facial','deep cleansing facial',
  'chemical peel','light peel','medium peel','glycolic peel','lactic peel','vi peel',
  'microdermabrasion','diamond microderm','crystal microderm',
  'dermaplaning','dermaplaning facial',
  'hydrafacial','hydra facial','hydrafacial treatment',
  'microneedling','rf microneedling','prp microneedling','collagen induction',
  'laser facial','laser resurfacing','laser skin treatment','ipl treatment','ipl photofacial',
  'led light therapy','red light therapy',
  'oxygen facial','collagen facial',

  // ── Brows, Lashes & Makeup ──
  'brow shaping','eyebrow waxing','eyebrow threading','brow tinting','brow lamination',
  'lash extensions','classic lashes','volume lashes','hybrid lashes','mega volume lashes',
  'lash lift','lash tint','lash lift and tint',
  'makeup application','professional makeup','event makeup','bridal makeup','prom makeup',
  'airbrush makeup','airbrush foundation',
  'microblading','ombre brows','powder brows','nano brows','permanent eyebrows',
  'permanent makeup','semi-permanent makeup','lip blushing','permanent liner',

  // ── Body & Hair Removal ──
  'waxing','brow wax','lip wax','chin wax','face wax','underarm wax','arm wax',
  'leg wax','full leg wax','half leg wax','back wax','chest wax',
  'bikini wax','brazilian wax','brazilian','full body wax',
  'laser hair removal','laser hair reduction','ipl hair removal',
  'threading','facial threading','upper lip threading',
  'spray tan','sunless tan','airbrush tan',
  'body scrub','body wrap','body exfoliation','sugar scrub',
  'massage','swedish massage','deep tissue massage','hot stone massage',
  'prenatal massage','couples massage','sports massage','reflexology',

  // ── Specialized / Medspa ──
  'teeth whitening','zoom whitening','professional whitening',
  'botox','filler','lip filler','cheek filler','dermal filler','juvederm','restylane',
  'kybella','prp','platelet rich plasma',
  'body contouring','coolsculpting','emsculpt','radiofrequency body','ultrasound body',
  'skin tightening','rf skin tightening',

  // ── Casual / Slang (TikTok, IG, group chats) ──
  // Hair slang
  'hair done','hair did','getting my hair done','getting my hair did','fresh hair',
  'salon day','blowout refresh','fresh blowout','getting a blowout','getting my blowout',
  'getting my hair blown out','blow out my hair','roots done','doing my roots','touch up my roots',
  'color done','getting my color done','balayage refresh','blonde moment','sun-kissed highlights',
  'keratin to tame','smoothing treatment','tame the frizz','hair chop','getting a chop',
  'trim my hair','layers done','extensions install','clip ins','adding length','adding volume',
  'hair mask treatment','repair session','wedding hair done','updo for the event','formal style done',
  // Nail slang
  'nails done','nails did','getting my nails done','getting my nails did','fresh mani',
  'fresh set','fresh nails','mani done','gel mani','structured gel','builder gel',
  'long lasting mani','pedi done','toes done','nails and toes','nails did toes did',
  'nails on point','maintenance on the claws','glazed donut nails','acrylics done',
  'gel x done','dips done','chrome nail','lunchtime mani','quick mani','spa mani',
  'spa pedi','with the massage and scrub',
  // Skin slang
  'face done','getting my face done','glow facial','face card','face card refresh',
  'face card never declines','skin treatment','pampering my face','exfoliation sesh',
  'skin reboot','glow up treatment','dermaplaning for the fuzz',
  // Brows & lashes slang
  'brows done','getting my brows done','brow wax done','brow tint done','lamination done',
  'fluffy brows','brows on fleek','lashes done','getting my lashes done','lash set',
  'full set lashes','volume lashes done','lash botox','lift and tint','lashes popped',
  'eyes done','full face','full glam','glam done','event makeup done','date night glam',
  // Body / wax slang
  'getting waxed','getting smooth','maintenance wax','full body refresh',
  'hollywood wax','zapping the hair','laser for smooth skin',
  'spray tan done','fake tan','glow up tan','getting a spray tan',
  // Combo / general slang
  'pamper day','girl therapy','self care day','maintenance day','salon day for the hair',
  'head to toe','everything did','hair nails and lashes','full maintenance',
  'high maintenance','pre event glow up','wedding ready','date night refresh',
  'glow up','quick touch up','touch up appointment','quick refresh',
  'everything done','all done up','got glam',
];

// Merge beauty terms into VERTICAL_VOCAB so _termIndex picks them up
VERTICAL_VOCAB.beauty = (VERTICAL_VOCAB.beauty || []).concat(BEAUTY_TERMS);

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
  retail: new RegExp(
    '\\bboutique\\b|supermarket|convenience store|sporting goods|\\bpet store\\b|hardware store|' +
    'visual merchand|loss prevention|\\bcashier\\b|sales associate|retail manager|merchandise planner|' +
    // Product searches
    'wireless bra|bralette|seamless bra|shapewear|period underwear|' +
    'leggings|athleisure|activewear|pilates princess|wide.leg pants|barrel jeans|palazzo pants|' +
    'summer dress|tennis dress|little black dress|wrap dress|' +
    'tallow moisturizer|beef tallow|glazed donut lips|glass skin|snail mucin|niacinamide|' +
    'pimple patch|acne patch|lash serum|press.on nails|gel nail kit|brow lamination|' +
    'dyson airwrap|curling iron|flat iron|claw clips|clip.in extension|' +
    'stanley cup|gua sha|led face mask|lymphatic drainage|' +
    // Shopping slang
    'tiktok made me buy|amazon haul|sephora haul|ulta haul|beauty haul|skincare haul|' +
    'add to cart|amazon cart|amazon finds|fit check|glow.up clothes|glow.up kit|' +
    'clean girl aesthetic|coquette core|mob wife|that girl outfit|that girl vibe|' +
    'basics refresh|full restock|essentials restock|' +
    'summer slay|vacation fits|back to school haul|' +
    'holy grail|\\bhaul\\b|comfy but cute|cozy hoodie|' +
    'skincare routine|skincare girly|self.care goodies|wellness girl|' +
    'it bag|structured tote|woven bag|everyday carry|stacked jewelry|gold hoops|' +
    // Men's product searches
    'boxer briefs|mens underwear|moisture wicking|athletic shorts|gym shorts|compression pants|' +
    'quarter zip|bomber jacket|flannel overshirt|carhartt|work boots|hiking boots|dad shoes|' +
    'electric trimmer|body groomer|manscaped|beard oil|beard trimmer|beard kit|' +
    'mens cologne|dior sauvage|signature scent|new frag|post.shave|aftershave|' +
    'pomade|matte clay|sea salt spray|minoxidil|' +
    'protein powder|\\bsupps\\b|wireless earbuds|massage gun|multi.tool|' +
    // Men's slang
    'fresh threads|wardrobe refresh|copped|gym drip|dad fit|business casual|' +
    'fresh cut|lined up|grooming sesh|smelling right|beard game|' +
    'payday cop|gear up|lowkey needed|new hoodie drop|hoodie and joggers|' +
    'new kicks|boot season|trim the bushes|manscaped run|new frag|' +
    // Collector cards
    'trading card|sports card|pokemon card|magic the gathering|\\bmtg\\b|booster box|booster pack|' +
    'elite trainer box|\\betb\\b|blaster box|hobby box|sealed product|' +
    'rookie card|\\brc card\\b|graded card|psa 10|bgs 9.5|\\bslab\\b|slabbed card|' +
    'charizard card|charizard ex|umbreon card|pikachu illustrator|' +
    'numbered parallel|1 of 1|vintage card|shadowless|1st edition pokemon|' +
    'yugioh card|lorcana card|one piece card|commander deck|' +
    'card sleeve|top loader|card binder|grading submission|whatnot break|group break|live break|' +
    'ripping packs|pack rip|chase card|god pack|alt art|full art card|secret rare|holo card|' +
    'copped some slabs|added to the pc|ebay snipe|payday rip|pulled a brick|pack luck|' +
    'card is mooning|card stonks|low pop report|investment flip|sealed investment|grail card|grail pull|' +
    // Sports equipment
    'dumbbells|adjustable weights|resistance bands|agility ladder|foam roller|massage gun|jump rope|' +
    'basketball shoes|high tops|ankle brace|shooting sleeve|dribble goggles|' +
    'soccer cleats|football cleats|turf cleats|shin guards|receiver gloves|goalkeeper gloves|' +
    'bbcor bat|composite bat|baseball glove|catchers mitt|batting tee|' +
    'tennis racket|pickleball paddle|overgrip|wilson racket|babolat racket|' +
    'running shoes|track spikes|carbon plate shoes|gps watch|resistance harness|' +
    'golf clubs|golf rangefinder|swim goggles|pull buoy|volleyball kneepads|hockey stick|ice skates|' +
    'fresh cleats|cleats are gas|new trainers|game ball|practice rock|new stick|fresh bat|' +
    'mouthguard game|strapped up|ankle sleeve|agility ladder sesh|band work|hitting the roller|' +
    'compression game|new dri-fit|fresh kit|new gear drop|budget cop|for tryouts|' +
    'sponsor gear|pro model|full kit refresh|gear check|these boots are cheating',
    'i'
  ),
  beauty: new RegExp(
    // Venues
    'hair salon|nail salon|beauty salon|blow.?dry bar|blowout bar|lash studio|brow bar|' +
    'tanning salon|spray tan studio|waxing (studio|center)|threading salon|skin.?care clinic|' +
    'aesthetics studio|barbershop|barber shop|day spa|' +
    // Hair
    'haircut|hair cut|blowout|blow.?dry|hair colo(r|ur)|root touch.?up|gray coverage|grey coverage|' +
    'balayage|omb.e|sombre|color melt|babylights|foilayage|' +
    'keratin( treatment)?|brazilian blowout|smoothing treatment|' +
    'deep conditioning|olaplex|bond repair|hair mask|protein treatment|' +
    'scalp treatment|scalp facial|' +
    'hair extensions|tape.in extension|sew.in extension|' +
    '\\bperm\\b|body wave|\\brelaxer\\b|hair straightening|' +
    '\\bupdo\\b|wedding hair|bridal hair|prom hair|' +
    // Nails
    '\\bnails?\\b|\\bmanicure\\b|\\bpedicure\\b|gel (nails|manicure|pedicure)|' +
    'dip powder|dip nails|acrylic nails|\\bacrylics\\b|gel.x|hard gel|' +
    'nail (art|design|fill|overlay|extensions|removal|embellishment)|' +
    'paraffin (treatment|wax)|mani.?pedi|acrylic fill|gel fill|soak off|chrome nails|' +
    // Skin
    '\\bfacial\\b|chemical peel|microdermabrasion|dermaplaning|hydrafacial|hydra facial|' +
    'microneedling|laser (facial|resurfacing|skin)|ipl (treatment|photofacial)|' +
    'led light therapy|red light therapy|collagen induction|' +
    // Brows / Lashes / Makeup
    'brow (shaping|tinting|lamination)|eyebrow (waxing|threading|tinting)|' +
    'lash (extensions|lift|tint)|eyelash extension|lash lift|' +
    'makeup application|bridal makeup|airbrush makeup|' +
    'microblading|ombre brows|powder brows|permanent makeup|lip blushing|' +
    // Body / Hair removal
    '\\bwax(ing|ed)?\\b|brow wax|lip wax|chin wax|face wax|underarm wax|leg wax|back wax|' +
    'bikini wax|brazilian wax|\\bbrazilian\\b|full body wax|' +
    'laser hair removal|laser hair reduction|' +
    '\\bthreading\\b|threaded|get threaded|eyebrows threaded|lip threaded|' +
    'spray tan|sunless tan|airbrush tan|' +
    'body scrub|body wrap|body exfoliation|' +
    '\\bmassage\\b|swedish massage|deep tissue|hot stone massage|reflexology|' +
    // Medspa
    'teeth whitening|\\bbotox\\b|\\bfiller\\b|lip filler|cheek filler|dermal filler|' +
    'juvederm|restylane|kybella|body contouring|coolsculpting|emsculpt|skin tightening|' +
    // Salon/spa catch-all
    '\\bsalon\\b|\\bbarber\\b|\\beyelash\\b|\\beyebrow\\b|\\btanning\\b|\\bspa\\b|' +
    // Casual / slang phrases
    'nails did|nails done|hair did|hair done|getting my nails|getting my hair|' +
    'fresh mani|fresh set|fresh nails|gel mani|mani done|pedi done|toes done|' +
    'brows done|lashes done|lash set|face card|glow.?up|pamper day|girl therapy|' +
    'self.?care day|maintenance day|salon day|full glam|\\bglam\\b|date night refresh|' +
    'pre.event glow|hair nails|nails and lashes|everything did|head to toe beauty|' +
    'getting waxed|getting smooth|fake tan|spray tan done|hair blown out|' +
    'lash botox|lashes popped|face done|skin reboot|face card refresh|' +
    'fresh blow|blowout refresh|roots done|color done|touch up my|' +
    'maintenance wax|full body refresh|getting a blowout',
    'i'
  ),
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
  const scores = { restaurant: 0, healthcare: 0, retail: 0, construction: 0, realtor: 0, beauty: 0 };

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
