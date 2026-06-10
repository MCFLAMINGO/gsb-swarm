'use strict';
/**
 * lib/categoryMap.js — SINGLE SOURCE OF TRUTH for category resolution.
 *
 * CANONICAL_MAP: query keyword/phrase → DB category (or array of DB categories)
 * CAT_EXPAND:    DB category key → array of real DB category strings to match
 *
 * All paths (web search, voice/SMS, MCP, intentRouter) import from here.
 * Never patch _SVC_MAP, intentMap.js, and intentRouter.js separately again.
 */

// ── Real DB categories (top 150 by count, minus junk like 'business','yes','car') ──
// Use these strings in CAT_EXPAND values — they must exist in the DB.
const DB_CATS = [
  'restaurant','fast_food','hotel','cafe','bank','real_estate','grocery','retail','bar',
  'plumber','landscaping','dental','electrician','beauty_salon','pharmacy','fuel',
  'convenience','beauty','auto_repair','gas_station','clothes','law_firm','general_contractor',
  'dry_cleaning','insurance','insurance_agency','hairdresser','pizza','childcare','supermarket',
  'upscale_hotel','department_store','car_repair','legal','gym','dentist','variety_store',
  'veterinary','coffee_chain','accounting','casual_dining','urgent_care','healthcare',
  'fitness_centre','sports_centre','bakery','doctors','finance','ice_cream','gym_chain',
  'budget_hotel','sports_bar','furniture','mexican','car_parts','jewelry','seafood',
  'barbershop','pub','alcohol','car_rental','museum','shoes','pet','hospital','fitness',
  'estate_agent','chemist','optician','auto_dealer','sandwich','hair_chain','bbq',
  'steakhouse','deli','storage_rental','big_box','real_estate_agency','car_wash','tax_advisor',
  'massage','doityourself','financial_advisor','credit_union','swimming_pool',
  'nutrition_supplements','electronics','hardware','fast_casual_mexican','handyman',
  'florist','laundry','spa_massage','pest_control','locksmith','painting','roofing',
  'hvac','moving','pool_service','concrete','flooring','tattoo','atm','bank_branch',
  'fine_dining','brewery','bar_dining','cosmetics','pet_grooming','medical_spa',
  'aesthetics','plastic_surgery','dermatology','towing','liquor_store','wine',
];

// ── CAT_EXPAND: resolvedCat → exact DB category strings for SQL ANY() match ──
const CAT_EXPAND = {
  // Food & drink
  restaurant:     ['restaurant','fast_food','casual_dining','fine_dining','deli','seafood','mexican','italian','asian','bbq','steakhouse','sandwich','bar_dining','fast_casual_mexican'],
  pizza:          ['pizza','restaurant','fast_food'],
  bar:            ['bar','pub','sports_bar','brewery','bar_dining','alcohol'],
  cafe:           ['cafe','coffee_chain','bakery','deli','ice_cream'],
  seafood:        ['seafood','restaurant'],
  // Medical / health
  healthcare:     ['clinic','hospital','doctors','dentist','dental','pharmacy','urgent_care','veterinary','healthcare','optician','fitness_centre'],
  clinic:         ['clinic','doctors','urgent_care','hospital','healthcare'],
  dentist:        ['dentist','dental'],
  pharmacy:       ['pharmacy','chemist'],
  plastic_surgery:['plastic_surgery','dermatology','medical_spa','aesthetics','doctors','clinic'],
  dermatology:    ['dermatology','medical_spa','aesthetics'],
  // Beauty
  beauty:         ['beauty_salon','hairdresser','barbershop','hair_chain','beauty','cosmetics'],
  beauty_salon:   ['beauty_salon','hairdresser','hair_chain','beauty'],
  spa:            ['spa_massage','massage','beauty_salon'],
  massage:        ['spa_massage','massage'],
  barbershop:     ['barbershop','beauty_salon','hairdresser'],
  // Home services
  plumber:        ['plumber'],
  electrician:    ['electrician'],
  hvac:           ['hvac'],
  handyman:       ['handyman','doityourself','general_contractor'],
  roofing:        ['roofing','general_contractor'],
  landscaping:    ['landscaping'],
  painting:       ['painting'],
  cleaning:       ['dry_cleaning','laundry'],
  dry_cleaning:   ['dry_cleaning','laundry'],
  pest_control:   ['pest_control'],
  locksmith:      ['locksmith'],
  flooring:       ['flooring'],
  pool_service:   ['pool_service','swimming_pool'],
  moving:         ['moving'],
  general_contractor: ['general_contractor','contractor'],
  // Auto
  auto_repair:    ['auto_repair','car_repair','auto_body'],
  auto_dealer:    ['auto_dealer'],
  car_wash:       ['car_wash'],
  car_rental:     ['car_rental'],
  towing:         ['towing'],
  gas_station:    ['gas_station','fuel'],
  // Retail
  retail:         ['retail','clothes','shoes','department_store','furniture','jewelry','variety_store','big_box','cosmetics','nutrition_supplements','electronics','hardware'],
  clothes:        ['clothes','shoes','department_store','variety_store'],
  grocery:        ['grocery','supermarket','convenience'],
  convenience:    ['convenience','grocery','supermarket'],
  hardware:       ['hardware','doityourself'],
  furniture:      ['furniture','big_box'],
  jewelry:        ['jewelry'],
  electronics:    ['electronics'],
  alcohol:        ['alcohol','liquor_store','wine','bar','pub'],
  // Professional
  law_firm:       ['law_firm','legal','lawyer'],
  accounting:     ['accounting'],
  insurance:      ['insurance','insurance_agency'],
  tax_advisor:    ['tax_advisor','accounting'],
  financial_advisor: ['financial_advisor','finance','accounting'],
  // Finance
  bank:           ['bank','bank_branch','credit_union','atm'],
  finance:        ['financial_advisor','finance','bank','accounting'],
  // Real estate
  real_estate:    ['real_estate','real_estate_agency','estate_agent'],
  // Fitness
  gym:            ['gym','gym_chain','fitness_centre','sports_centre','fitness'],
  // Hospitality
  hotel:          ['hotel','upscale_hotel','budget_hotel'],
  // Pet
  veterinary:     ['veterinary','pet','pet_grooming'],
  // Other services
  florist:        ['florist'],
  tattoo:         ['tattoo'],
  storage:        ['storage_rental'],
  childcare:      ['childcare'],
  optician:       ['optician'],
  museum:         ['museum'],
};

// ── KEYWORD_MAP: any query substring → resolvedCat key ──
// Order matters — first match wins. Add the most specific patterns first.
// All lowercase. These cover voice, web, SMS, MCP paths.
const KEYWORD_MAP = [

  // ── Food & drink ────────────────────────────────────────────────────────────
  ['pizza','pizza'],['calzone','pizza'],['slice of pizza','pizza'],
  ['seafood','seafood'],['fish market','seafood'],['fresh fish','seafood'],['sushi','seafood'],
  ['ramen','restaurant'],['pho','restaurant'],['dim sum','restaurant'],
  ['chinese food','restaurant'],['italian food','restaurant'],['thai food','restaurant'],
  ['indian food','restaurant'],['mexican food','restaurant'],['ethiopian food','restaurant'],
  ['korean food','restaurant'],['japanese food','restaurant'],['greek food','restaurant'],
  ['mediterranean food','restaurant'],['vietnamese food','restaurant'],
  ['burger','restaurant'],['wings','restaurant'],['steak','restaurant'],
  ['fine dining','restaurant'],['brunch','restaurant'],['breakfast spot','restaurant'],
  ['happy hour','bar'],['cocktails','bar'],['nightlife','bar'],
  ['craft beer','bar'],['brewery','bar'],['pregame','bar'],['turn up','bar'],
  ['coffee','cafe'],['espresso','cafe'],['latte','cafe'],['cappuccino','cafe'],
  ['bakery','cafe'],['pastries','cafe'],['bagels','cafe'],['donuts','cafe'],
  ['ice cream','cafe'],['froyo','cafe'],['smoothie','cafe'],
  ['vodka','alcohol'],['whiskey','alcohol'],['tequila','alcohol'],['bourbon','alcohol'],
  ['rum','alcohol'],['gin','alcohol'],['liquor','alcohol'],['booze','alcohol'],
  ['beer run','alcohol'],['six pack','alcohol'],['case of beer','alcohol'],
  ['bottle of wine','alcohol'],['wine shop','alcohol'],['liquor store','alcohol'],

  // ── Pharmacy / convenience products ─────────────────────────────────────────
  ['toothbrush','pharmacy'],['tothbrush','pharmacy'],['tooth brush','pharmacy'],
  ['toothpaste','pharmacy'],['tooth paste','pharmacy'],['tothpaste','pharmacy'],
  ['deodorant','pharmacy'],['deodarant','pharmacy'],['deodrant','pharmacy'],['deodoran','pharmacy'],
  ['body spray','pharmacy'],['antiperspirant','pharmacy'],
  ['shampoo','pharmacy'],['conditioner','pharmacy'],['body wash','pharmacy'],
  ['face wash','pharmacy'],['lotion','pharmacy'],['moisturizer','pharmacy'],
  ['razor','pharmacy'],['band aid','pharmacy'],['bandage','pharmacy'],['first aid','pharmacy'],
  ['q tip','pharmacy'],['nail clippers','pharmacy'],
  ['tylenol','pharmacy'],['advil','pharmacy'],['ibuprofen','pharmacy'],['aspirin','pharmacy'],
  ['nyquil','pharmacy'],['dayquil','pharmacy'],['cough syrup','pharmacy'],
  ['cough drops','pharmacy'],['cold meds','pharmacy'],['allergy meds','pharmacy'],
  ['antacid','pharmacy'],['tums','pharmacy'],['pepto','pharmacy'],
  ['toilet paper','convenience'],['tp','convenience'],['paper towel','convenience'],
  ['tissues','convenience'],['kleenex','convenience'],['trash bags','convenience'],
  ['doritos','convenience'],['chips','convenience'],['snacks','convenience'],
  ['candy','convenience'],['gum','convenience'],['soda','convenience'],
  ['phone charger','convenience'],['batteries','convenience'],['light bulb','convenience'],
  ['extension cord','convenience'],['tape','convenience'],['super glue','convenience'],

  // ── Beauty ──────────────────────────────────────────────────────────────────
  ['hair done','beauty'],['hair did','beauty'],['hair styled','beauty'],
  ['get my hair','beauty'],['hair appointment','beauty'],['blowout','beauty'],
  ['highlights','beauty'],['color my hair','beauty'],['haircut','beauty'],
  ['fade','beauty'],['lineup','beauty'],['fresh cut','beauty'],['shape up','beauty'],
  ['nails done','beauty'],['nails did','beauty'],['manicure','beauty'],['pedicure','beauty'],
  ['wax','beauty'],['threading','beauty'],['eyebrows','beauty'],
  ['barber','barbershop'],['barbershop','barbershop'],['barber shop','barbershop'],
  ['massage','massage'],['deep tissue','massage'],['swedish massage','massage'],
  ['spa','spa'],['facial','spa'],['skin treatment','spa'],

  // ── Home services ────────────────────────────────────────────────────────────
  ['plumber','plumber'],['plumbing','plumber'],['pipe burst','plumber'],
  ['leak','plumber'],['drain clogged','plumber'],['toilet','plumber'],
  ['water heater','plumber'],['faucet','plumber'],['pipes','plumber'],
  ['electrician','electrician'],['electrical','electrician'],['wiring','electrician'],
  ['outlet','electrician'],['breaker','electrician'],['no power','electrician'],
  ['hvac','hvac'],['air conditioning','hvac'],['heat pump','hvac'],['furnace','hvac'],
  ['ac broken','hvac'],['heater','hvac'],
  ['landscaping','landscaping'],['lawn','landscaping'],['mow','landscaping'],
  ['yard work','landscaping'],['tree trimming','landscaping'],['mulch','landscaping'],
  ['irrigation','landscaping'],['sprinkler','landscaping'],
  ['handyman','handyman'],['fix','handyman'],['repair','handyman'],['install','handyman'],
  ['roofing','roofing'],['roof','roofing'],['shingles','roofing'],['gutter','roofing'],
  ['pest control','pest_control'],['exterminator','pest_control'],
  ['roaches','pest_control'],['cockroach','pest_control'],['termites','pest_control'],
  ['bed bugs','pest_control'],['rodent','pest_control'],['mice','pest_control'],
  ['locked out','locksmith'],['locksmith','locksmith'],['lock change','locksmith'],
  ['lost keys','locksmith'],['rekey','locksmith'],['cant get in','locksmith'],
  ['house painter','painting'],['painting','painting'],['interior paint','painting'],
  ['dry cleaning','dry_cleaning'],['dry cleaner','dry_cleaning'],['dry clean','dry_cleaning'],
  ['laundry','dry_cleaning'],

  // ── Auto ─────────────────────────────────────────────────────────────────────
  ['mechanic','auto_repair'],['auto repair','auto_repair'],['car repair','auto_repair'],
  ['oil change','auto_repair'],['brake','auto_repair'],['tire','auto_repair'],
  ['transmission','auto_repair'],['body work','auto_repair'],['car detail','auto_repair'],
  ['whip broke','auto_repair'],['ride broke','auto_repair'],['car broke','auto_repair'],
  ['buy a car','auto_dealer'],['buy car','auto_dealer'],['used car','auto_dealer'],
  ['new car','auto_dealer'],['car dealership','auto_dealer'],['auto dealer','auto_dealer'],
  ['car lot','auto_dealer'],['car dealer','auto_dealer'],
  ['tow truck','towing'],['towing','towing'],['stranded','towing'],['roadside','towing'],
  ['gas station','gas_station'],['gas up','gas_station'],['fill up','gas_station'],
  ['running on e','gas_station'],['fuel','gas_station'],
  ['car wash','car_wash'],['car rental','car_rental'],['rent a car','car_rental'],

  // ── Medical / health ─────────────────────────────────────────────────────────
  ['doctor','clinic'],['physician','clinic'],['urgent care','clinic'],
  ['sick','clinic'],['feel sick','clinic'],['not feeling well','clinic'],
  ['dentist','dentist'],['dental','dentist'],['tooth hurts','dentist'],['toothache','dentist'],
  ['vet','veterinary'],['veterinarian','veterinary'],['pet sick','veterinary'],
  ['dog sick','veterinary'],['cat sick','veterinary'],
  ['pharmacy','pharmacy'],['prescription','pharmacy'],['meds','pharmacy'],
  ['plastic surgeon','plastic_surgery'],['breast augmentation','plastic_surgery'],
  ['rhinoplasty','plastic_surgery'],['botox','plastic_surgery'],['filler','plastic_surgery'],
  ['dermatologist','dermatology'],['skin care','dermatology'],['medspa','dermatology'],

  // ── Professional services ────────────────────────────────────────────────────
  ['lawyer','law_firm'],['attorney','law_firm'],['legal help','law_firm'],
  ['lawsuit','law_firm'],['court date','law_firm'],['got a case','law_firm'],
  ['accountant','accounting'],['tax prep','accounting'],['bookkeeping','accounting'],
  ['taxes','tax_advisor'],['tax return','tax_advisor'],['file taxes','tax_advisor'],
  ['insurance','insurance'],['insure','insurance'],
  ['financial advisor','financial_advisor'],['retirement','financial_advisor'],
  ['invest','financial_advisor'],

  // ── Finance ──────────────────────────────────────────────────────────────────
  ['atm','bank'],['nearest atm','bank'],['cash machine','bank'],['need cash','bank'],
  ['bank','bank'],['credit union','bank'],

  // ── Real estate ──────────────────────────────────────────────────────────────
  ['realtor','real_estate'],['real estate','real_estate'],['home buying','real_estate'],
  ['sell my home','real_estate'],['properties for rent','real_estate'],
  ['apartment for rent','real_estate'],['rental property','real_estate'],

  // ── Fitness ──────────────────────────────────────────────────────────────────
  ['gym','gym'],['fitness','gym'],['workout','gym'],['lift weights','gym'],
  ['crossfit','gym'],['yoga','gym'],['pilates','gym'],['personal trainer','gym'],

  // ── Hotel / stay ─────────────────────────────────────────────────────────────
  ['hotel','hotel'],['motel','hotel'],['place to stay','hotel'],['place to crash','hotel'],
  ['somewhere to stay','hotel'],['airbnb','hotel'],['vacation rental','hotel'],

  // ── Retail ───────────────────────────────────────────────────────────────────
  ['clothing store','clothes'],['clothes','clothes'],['apparel','clothes'],
  ['shoes','clothes'],['sneakers','clothes'],['boots','clothes'],
  ['suit','clothes'],['tailor','clothes'],['tuxedo','clothes'],['alterations','clothes'],
  ['chef shoes','clothes'],['work shoes','clothes'],['chef uniform','clothes'],
  ['furniture','furniture'],['mattress','furniture'],['sofa','furniture'],
  ['jewelry','jewelry'],['jeweler','jewelry'],['diamond','jewelry'],
  ['necklace','jewelry'],['engagement ring','jewelry'],['bracelet','jewelry'],
  ['electronics','electronics'],['phone repair','electronics'],['laptop','electronics'],
  ['hardware store','hardware'],['home depot','hardware'],['tools','hardware'],
  ['grocery store','grocery'],['grocery','grocery'],['groceries','grocery'],
  ['supermarket','grocery'],['publix','grocery'],['walmart','grocery'],['target','grocery'],
  ['convenience store','convenience'],['7 eleven','convenience'],['corner store','convenience'],

  // ── Childcare ────────────────────────────────────────────────────────────────
  ['daycare','childcare'],['day care','childcare'],['babysitter','childcare'],
  ['nanny','childcare'],['preschool','childcare'],

  // ── Other ────────────────────────────────────────────────────────────────────
  ['florist','florist'],['flowers','florist'],['flower shop','florist'],
  ['tattoo','tattoo'],['tattoo shop','tattoo'],
  ['storage unit','storage'],['self storage','storage'],
  ['museum','museum'],['eye doctor','optician'],['glasses','optician'],

  // ── Slang / dialect ──────────────────────────────────────────────────────────
  ['grub','restaurant'],['eats','restaurant'],['chow','restaurant'],['bussin','restaurant'],
  ['finna eat','restaurant'],['tryna eat','restaurant'],['spot to eat','restaurant'],
  ['get lit','bar'],['turn up','bar'],['bar hop','bar'],['vibes tonight','bar'],
  ['pull up to the bar','bar'],['hit the bar','bar'],
  ['fresh cut','beauty'],['jit needs a cut','beauty'],['get lined up','beauty'],
  ['whip fixed','auto_repair'],['get my ride fixed','auto_repair'],
  ['running on E','gas_station'],['tank is empty','gas_station'],
  ['pipes messed up','plumber'],['toilet wont flush','plumber'],
  ['my dog is sick','veterinary'],['my cat is sick','veterinary'],
  ['need a fade','beauty'],['get swole','gym'],['hit the gym','gym'],
  ['crash for the night','hotel'],['lay my head','hotel'],
];

// ── REQUEST_PHRASES: signals the user wants a service (not a name search) ──
const REQUEST_PHRASES = [
  'i need','i want','i have a','fix my','fix the','repair my','repair the',
  'find me a','find me an','get me a','get me an','looking for a','looking for an',
  'need a','need an','need some','need someone','need help','help me','can someone',
  'who can','who does','where can i','where do i','where is a','where is the',
  'how do i','can i get','can i find','can i buy',
  'looking to get','trying to find','tryna find','tryna get','gotta get',
  'my .+ is broken','my .+ is leaking','my .+ is not working',
  'broken','not working','clogged','flooded',
];

// ── resolve(query) → { cat, expanded } or null ──
function resolve(query) {
  const lower = (query || '').toLowerCase().trim();
  if (!lower) return null;

  // 1. Keyword map — longest match wins (sort by length desc at load time)
  for (const [kw, cat] of KEYWORD_MAP) {
    if (lower.includes(kw)) {
      return { cat, expanded: CAT_EXPAND[cat] || [cat] };
    }
  }
  return null;
}

// ── isServiceRequest(query) → boolean ──
const _REQ_RE = new RegExp(REQUEST_PHRASES.join('|'), 'i');
function isServiceRequest(query) {
  return _REQ_RE.test((query || '').toLowerCase());
}

// ── expandCat(cat) → string[] of real DB categories ──
function expandCat(cat) {
  return CAT_EXPAND[cat] || [cat];
}

module.exports = { resolve, isServiceRequest, expandCat, CAT_EXPAND, KEYWORD_MAP, DB_CATS };
