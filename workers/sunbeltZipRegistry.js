'use strict';
/**
 * sunbeltZipRegistry.js
 * ─────────────────────────────────────────────────────────────────────────────
 * Authoritative multi-state ZIP registry for the full Southern Sunbelt + SoCal.
 *
 * PHASE LOGIC:
 *   Phase 1 — Florida first (handled by flZipRegistry.js — must hit 95% before Phase 2 unlocks)
 *   Phase 2 — Gulf Coast adjacency: TX, AL, MS, LA  (highest commercial density near FL)
 *   Phase 3 — Atlantic + Deep South corridor: GA, SC, NC, TN
 *   Phase 4 — Interior South + Desert: KY, NM, AZ
 *   Phase 5 — Pacific: Southern California (SoCal)
 *
 * Phase gate: coordinator only unlocks Phase N+1 when Phase N is ≥ 95% covered.
 * FL ZIP management lives in flZipRegistry.js — this file is all non-FL states.
 *
 * COVERAGE TARGETS (highest-income / highest-commercial ZIPs per metro):
 *   TX  ~48 ZIPs  · AL ~22 · MS ~14 · LA ~20
 *   GA  ~20 ZIPs  · SC ~16 · NC ~20 · TN ~20
 *   KY  ~15 ZIPs  · NM ~12 · AZ ~23
 *   SoCal ~35 ZIPs
 *   TOTAL: ~265 non-FL priority ZIPs
 */

// ── PHASE 2 — Texas ───────────────────────────────────────────────────────────
const TX_ZIPS = [
  // Houston metro
  { zip: '77494', state: 'TX', region: 'HOU', name: 'Katy',              lat: 29.7854, lon: -95.8245, priority: 84, phase: 2 },
  { zip: '77479', state: 'TX', region: 'HOU', name: 'Sugar Land',         lat: 29.6197, lon: -95.6349, priority: 82, phase: 2 },
  { zip: '77459', state: 'TX', region: 'HOU', name: 'Missouri City',      lat: 29.5654, lon: -95.5363, priority: 80, phase: 2 },
  { zip: '77584', state: 'TX', region: 'HOU', name: 'Pearland',           lat: 29.5635, lon: -95.3863, priority: 79, phase: 2 },
  { zip: '77450', state: 'TX', region: 'HOU', name: 'Katy West',          lat: 29.7654, lon: -95.7545, priority: 77, phase: 2 },
  { zip: '77382', state: 'TX', region: 'HOU', name: 'The Woodlands',      lat: 30.1654, lon: -95.5063, priority: 76, phase: 2 },
  { zip: '77380', state: 'TX', region: 'HOU', name: 'Spring',             lat: 30.0954, lon: -95.4163, priority: 74, phase: 2 },
  { zip: '77573', state: 'TX', region: 'HOU', name: 'League City',        lat: 29.4754, lon: -95.1063, priority: 73, phase: 2 },
  { zip: '77546', state: 'TX', region: 'HOU', name: 'Friendswood',        lat: 29.5354, lon: -95.2063, priority: 71, phase: 2 },
  { zip: '77377', state: 'TX', region: 'HOU', name: 'Tomball',            lat: 30.0954, lon: -95.6163, priority: 70, phase: 2 },
  { zip: '77407', state: 'TX', region: 'HOU', name: 'Richmond',           lat: 29.6554, lon: -95.7263, priority: 69, phase: 2 },
  { zip: '77005', state: 'TX', region: 'HOU', name: 'Rice Village',       lat: 29.7154, lon: -95.4263, priority: 68, phase: 2 },
  { zip: '77030', state: 'TX', region: 'HOU', name: 'Medical Center',     lat: 29.7054, lon: -95.3963, priority: 67, phase: 2 },
  // Dallas metro
  { zip: '75034', state: 'TX', region: 'DAL', name: 'Frisco N',           lat: 33.1754, lon: -96.8263, priority: 82, phase: 2 },
  { zip: '75035', state: 'TX', region: 'DAL', name: 'Frisco E',           lat: 33.1554, lon: -96.7763, priority: 81, phase: 2 },
  { zip: '75024', state: 'TX', region: 'DAL', name: 'Plano N',            lat: 33.0754, lon: -96.8163, priority: 80, phase: 2 },
  { zip: '75025', state: 'TX', region: 'DAL', name: 'Plano NE',           lat: 33.0954, lon: -96.7463, priority: 79, phase: 2 },
  { zip: '75093', state: 'TX', region: 'DAL', name: 'Plano W',            lat: 33.0454, lon: -96.8463, priority: 78, phase: 2 },
  { zip: '76092', state: 'TX', region: 'DAL', name: 'Southlake',          lat: 32.9454, lon: -97.1363, priority: 77, phase: 2 },
  { zip: '75022', state: 'TX', region: 'DAL', name: 'Flower Mound',       lat: 33.0154, lon: -97.0963, priority: 76, phase: 2 },
  { zip: '75013', state: 'TX', region: 'DAL', name: 'Allen',              lat: 33.1054, lon: -96.6763, priority: 75, phase: 2 },
  { zip: '75056', state: 'TX', region: 'DAL', name: 'The Colony',         lat: 33.0854, lon: -96.8963, priority: 74, phase: 2 },
  // Austin metro
  { zip: '78750', state: 'TX', region: 'AUS', name: 'Austin NW',          lat: 30.4454, lon: -97.7963, priority: 81, phase: 2 },
  { zip: '78746', state: 'TX', region: 'AUS', name: 'West Lake Hills',    lat: 30.2954, lon: -97.8163, priority: 80, phase: 2 },
  { zip: '78738', state: 'TX', region: 'AUS', name: 'Bee Cave',           lat: 30.3054, lon: -97.9363, priority: 79, phase: 2 },
  { zip: '78613', state: 'TX', region: 'AUS', name: 'Cedar Park',         lat: 30.5254, lon: -97.8263, priority: 78, phase: 2 },
  { zip: '78681', state: 'TX', region: 'AUS', name: 'Round Rock N',       lat: 30.5654, lon: -97.7163, priority: 77, phase: 2 },
  { zip: '78726', state: 'TX', region: 'AUS', name: 'NW Hills',           lat: 30.4354, lon: -97.8263, priority: 76, phase: 2 },
  // San Antonio metro
  { zip: '78257', state: 'TX', region: 'SAT', name: 'Shavano Park',       lat: 29.5954, lon: -98.5663, priority: 76, phase: 2 },
  { zip: '78259', state: 'TX', region: 'SAT', name: 'Stone Oak',          lat: 29.6354, lon: -98.4463, priority: 75, phase: 2 },
  { zip: '78260', state: 'TX', region: 'SAT', name: 'Stone Oak N',        lat: 29.6654, lon: -98.4763, priority: 74, phase: 2 },
  { zip: '78248', state: 'TX', region: 'SAT', name: 'Blanco Area',        lat: 29.5954, lon: -98.5263, priority: 73, phase: 2 },
  // Corpus Christi (Gulf Coast)
  { zip: '78412', state: 'TX', region: 'CRP', name: 'CC South',           lat: 27.7088, lon: -97.3948, priority: 65, phase: 2 },
  { zip: '78413', state: 'TX', region: 'CRP', name: 'CC Southwest',       lat: 27.6788, lon: -97.4148, priority: 63, phase: 2 },
  { zip: '78418', state: 'TX', region: 'CRP', name: 'Padre Island',       lat: 27.6288, lon: -97.2248, priority: 61, phase: 2 },
  { zip: '78411', state: 'TX', region: 'CRP', name: 'CC Central',         lat: 27.7588, lon: -97.4048, priority: 60, phase: 2 },
];

// ── PHASE 2 — Alabama ─────────────────────────────────────────────────────────
const AL_ZIPS = [
  // Mobile metro (Gulf Coast)
  { zip: '36695', state: 'AL', region: 'MOB', name: 'Mobile West',        lat: 30.6354, lon: -88.1581, priority: 76, phase: 2 },
  { zip: '36608', state: 'AL', region: 'MOB', name: 'Mobile Midtown',     lat: 30.6887, lon: -88.1462, priority: 74, phase: 2 },
  { zip: '36609', state: 'AL', region: 'MOB', name: 'Mobile SW',          lat: 30.6624, lon: -88.1741, priority: 72, phase: 2 },
  { zip: '36526', state: 'AL', region: 'MOB', name: 'Daphne',             lat: 30.6021, lon: -87.9168, priority: 71, phase: 2 },
  { zip: '36532', state: 'AL', region: 'MOB', name: 'Fairhope',           lat: 30.5077, lon: -87.8928, priority: 70, phase: 2 },
  { zip: '36542', state: 'AL', region: 'MOB', name: 'Gulf Shores',        lat: 30.2593, lon: -87.7008, priority: 68, phase: 2 },
  { zip: '36561', state: 'AL', region: 'MOB', name: 'Orange Beach',       lat: 30.2961, lon: -87.6003, priority: 67, phase: 2 },
  // Birmingham metro
  { zip: '35242', state: 'AL', region: 'BHM', name: 'Shelby County',      lat: 33.3954, lon: -86.6763, priority: 73, phase: 2 },
  { zip: '35244', state: 'AL', region: 'BHM', name: 'Hoover S',           lat: 33.3454, lon: -86.7463, priority: 72, phase: 2 },
  { zip: '35226', state: 'AL', region: 'BHM', name: 'Hoover N',           lat: 33.4054, lon: -86.7563, priority: 71, phase: 2 },
  { zip: '35223', state: 'AL', region: 'BHM', name: 'Mountain Brook',     lat: 33.4954, lon: -86.7363, priority: 70, phase: 2 },
  { zip: '35209', state: 'AL', region: 'BHM', name: 'Homewood',           lat: 33.4754, lon: -86.7863, priority: 69, phase: 2 },
  // Huntsville (fastest-growing AL metro)
  { zip: '35758', state: 'AL', region: 'HSV', name: 'Madison',            lat: 34.6954, lon: -86.7563, priority: 75, phase: 2 },
  { zip: '35759', state: 'AL', region: 'HSV', name: 'Madison N',          lat: 34.7554, lon: -86.7863, priority: 74, phase: 2 },
  { zip: '35803', state: 'AL', region: 'HSV', name: 'Huntsville S',       lat: 34.6454, lon: -86.5663, priority: 73, phase: 2 },
  { zip: '35802', state: 'AL', region: 'HSV', name: 'Huntsville SE',      lat: 34.6754, lon: -86.5263, priority: 72, phase: 2 },
  { zip: '35801', state: 'AL', region: 'HSV', name: 'Huntsville',         lat: 34.7354, lon: -86.5863, priority: 71, phase: 2 },
];

// ── PHASE 2 — Mississippi ─────────────────────────────────────────────────────
const MS_ZIPS = [
  // Gulf Coast (closest to FL)
  { zip: '39560', state: 'MS', region: 'GSL', name: 'Long Beach',         lat: 30.3754, lon: -89.1563, priority: 68, phase: 2 },
  { zip: '39564', state: 'MS', region: 'GSL', name: 'Ocean Springs',      lat: 30.4054, lon: -88.8263, priority: 67, phase: 2 },
  { zip: '39567', state: 'MS', region: 'GSL', name: 'Pascagoula',         lat: 30.3554, lon: -88.5563, priority: 66, phase: 2 },
  { zip: '39532', state: 'MS', region: 'GSL', name: 'Biloxi N',           lat: 30.4454, lon: -89.0163, priority: 65, phase: 2 },
  { zip: '39503', state: 'MS', region: 'GSL', name: 'Gulfport N',         lat: 30.4554, lon: -89.0963, priority: 64, phase: 2 },
  { zip: '39501', state: 'MS', region: 'GSL', name: 'Gulfport',           lat: 30.3654, lon: -89.0963, priority: 63, phase: 2 },
  { zip: '39576', state: 'MS', region: 'GSL', name: 'Waveland',           lat: 30.2954, lon: -89.3963, priority: 61, phase: 2 },
  { zip: '39520', state: 'MS', region: 'GSL', name: 'Bay St. Louis',      lat: 30.3254, lon: -89.3363, priority: 60, phase: 2 },
  // Jackson metro
  { zip: '39157', state: 'MS', region: 'JAN', name: 'Ridgeland',          lat: 32.4254, lon: -90.1363, priority: 65, phase: 2 },
  { zip: '39047', state: 'MS', region: 'JAN', name: 'Brandon',            lat: 32.2854, lon: -89.9963, priority: 64, phase: 2 },
  { zip: '39110', state: 'MS', region: 'JAN', name: 'Madison',            lat: 32.4654, lon: -90.1163, priority: 63, phase: 2 },
  { zip: '39211', state: 'MS', region: 'JAN', name: 'Jackson NE',         lat: 32.3954, lon: -90.1363, priority: 62, phase: 2 },
];

// ── PHASE 2 — Louisiana ───────────────────────────────────────────────────────
const LA_ZIPS = [
  // New Orleans metro
  { zip: '70131', state: 'LA', region: 'MSY', name: 'Algiers',            lat: 29.9054, lon: -90.0663, priority: 72, phase: 2 },
  { zip: '70056', state: 'LA', region: 'MSY', name: 'Gretna',             lat: 29.9154, lon: -90.0563, priority: 71, phase: 2 },
  { zip: '70005', state: 'LA', region: 'MSY', name: 'Metairie N',         lat: 29.9954, lon: -90.1563, priority: 70, phase: 2 },
  { zip: '70002', state: 'LA', region: 'MSY', name: 'Metairie',           lat: 29.9854, lon: -90.1763, priority: 69, phase: 2 },
  { zip: '70003', state: 'LA', region: 'MSY', name: 'Metairie W',         lat: 29.9754, lon: -90.2063, priority: 68, phase: 2 },
  { zip: '70065', state: 'LA', region: 'MSY', name: 'Kenner',             lat: 29.9954, lon: -90.2663, priority: 67, phase: 2 },
  { zip: '70433', state: 'LA', region: 'MSY', name: 'Covington',          lat: 30.4754, lon: -90.1063, priority: 73, phase: 2 },
  { zip: '70461', state: 'LA', region: 'MSY', name: 'Slidell',            lat: 30.2954, lon: -89.7963, priority: 71, phase: 2 },
  { zip: '70448', state: 'LA', region: 'MSY', name: 'Mandeville',         lat: 30.3654, lon: -90.0763, priority: 70, phase: 2 },
  // Baton Rouge metro
  { zip: '70810', state: 'LA', region: 'BTR', name: 'BR SE',              lat: 30.3654, lon: -91.0363, priority: 72, phase: 2 },
  { zip: '70808', state: 'LA', region: 'BTR', name: 'BR Garden District', lat: 30.4054, lon: -91.1463, priority: 71, phase: 2 },
  { zip: '70809', state: 'LA', region: 'BTR', name: 'BR E',               lat: 30.3954, lon: -91.0863, priority: 70, phase: 2 },
  { zip: '70817', state: 'LA', region: 'BTR', name: 'BR SE2',             lat: 30.3354, lon: -91.0063, priority: 69, phase: 2 },
  { zip: '70737', state: 'LA', region: 'BTR', name: 'Gonzales',           lat: 30.2254, lon: -90.9263, priority: 68, phase: 2 },
  // Lafayette (oil country — high business density)
  { zip: '70508', state: 'LA', region: 'LFT', name: 'Lafayette S',        lat: 30.1554, lon: -92.0563, priority: 70, phase: 2 },
  { zip: '70503', state: 'LA', region: 'LFT', name: 'Lafayette',          lat: 30.2154, lon: -92.0763, priority: 69, phase: 2 },
  { zip: '70506', state: 'LA', region: 'LFT', name: 'Lafayette W',        lat: 30.2354, lon: -92.1163, priority: 68, phase: 2 },
  { zip: '70433', state: 'LA', region: 'LFT', name: 'Broussard',          lat: 30.1354, lon: -92.0163, priority: 67, phase: 2 },
  // Shreveport
  { zip: '71106', state: 'LA', region: 'SHV', name: 'Shreveport S',       lat: 32.4254, lon: -93.7863, priority: 65, phase: 2 },
  { zip: '71115', state: 'LA', region: 'SHV', name: 'Shreveport SE',      lat: 32.3954, lon: -93.6963, priority: 64, phase: 2 },
];

// ── PHASE 3 — Georgia ─────────────────────────────────────────────────────────
const GA_ZIPS = [
  // Atlanta suburbs (high income)
  { zip: '30097', state: 'GA', region: 'ATL', name: 'Johns Creek',        lat: 34.0488, lon: -84.1576, priority: 82, phase: 3 },
  { zip: '30022', state: 'GA', region: 'ATL', name: 'Alpharetta',         lat: 34.0188, lon: -84.2176, priority: 81, phase: 3 },
  { zip: '30005', state: 'GA', region: 'ATL', name: 'Alpharetta N',       lat: 34.0688, lon: -84.1976, priority: 80, phase: 3 },
  { zip: '30024', state: 'GA', region: 'ATL', name: 'Suwanee',            lat: 34.0588, lon: -84.0776, priority: 79, phase: 3 },
  { zip: '30075', state: 'GA', region: 'ATL', name: 'Roswell',            lat: 34.0254, lon: -84.3563, priority: 78, phase: 3 },
  { zip: '30041', state: 'GA', region: 'ATL', name: 'Cumming',            lat: 34.2054, lon: -84.1363, priority: 77, phase: 3 },
  { zip: '30009', state: 'GA', region: 'ATL', name: 'Alpharetta City',    lat: 34.0788, lon: -84.2876, priority: 76, phase: 3 },
  { zip: '30068', state: 'GA', region: 'ATL', name: 'Marietta E',         lat: 33.9688, lon: -84.3676, priority: 75, phase: 3 },
  { zip: '30062', state: 'GA', region: 'ATL', name: 'Marietta W',         lat: 34.0088, lon: -84.4576, priority: 74, phase: 3 },
  { zip: '30188', state: 'GA', region: 'ATL', name: 'Woodstock',          lat: 34.1054, lon: -84.5263, priority: 73, phase: 3 },
  { zip: '30101', state: 'GA', region: 'ATL', name: 'Acworth',            lat: 34.0654, lon: -84.6763, priority: 72, phase: 3 },
  // Savannah metro
  { zip: '31405', state: 'GA', region: 'SAV', name: 'Savannah Midtown',   lat: 32.0468, lon: -81.1276, priority: 78, phase: 3 },
  { zip: '31406', state: 'GA', region: 'SAV', name: 'Savannah South',     lat: 31.9938, lon: -81.0996, priority: 76, phase: 3 },
  { zip: '31419', state: 'GA', region: 'SAV', name: 'Savannah SW',        lat: 31.9488, lon: -81.1876, priority: 74, phase: 3 },
  { zip: '31407', state: 'GA', region: 'SAV', name: 'Port Wentworth',     lat: 32.1288, lon: -81.2176, priority: 73, phase: 3 },
  { zip: '31322', state: 'GA', region: 'SAV', name: 'Pooler',             lat: 32.0788, lon: -81.2576, priority: 72, phase: 3 },
  { zip: '31326', state: 'GA', region: 'SAV', name: 'Rincon',             lat: 32.1488, lon: -81.0476, priority: 71, phase: 3 },
  // Augusta / Columbus
  { zip: '30909', state: 'GA', region: 'AGS', name: 'Augusta NW',         lat: 33.4954, lon: -82.0663, priority: 67, phase: 3 },
  { zip: '30907', state: 'GA', region: 'AGS', name: 'Augusta N',          lat: 33.5154, lon: -82.0463, priority: 66, phase: 3 },
  { zip: '31909', state: 'GA', region: 'CSG', name: 'Columbus N',         lat: 32.5554, lon: -84.9563, priority: 65, phase: 3 },
];

// ── PHASE 3 — South Carolina ──────────────────────────────────────────────────
const SC_ZIPS = [
  // Charleston metro
  { zip: '29466', state: 'SC', region: 'CHS', name: 'Mt. Pleasant N',     lat: 32.8954, lon: -79.8263, priority: 78, phase: 3 },
  { zip: '29464', state: 'SC', region: 'CHS', name: 'Mt. Pleasant',       lat: 32.8254, lon: -79.8363, priority: 77, phase: 3 },
  { zip: '29492', state: 'SC', region: 'CHS', name: 'Daniel Island',      lat: 32.8754, lon: -79.9163, priority: 76, phase: 3 },
  { zip: '29403', state: 'SC', region: 'CHS', name: 'Charleston',         lat: 32.7754, lon: -79.9363, priority: 75, phase: 3 },
  { zip: '29418', state: 'SC', region: 'CHS', name: 'N. Charleston',      lat: 32.8754, lon: -80.0263, priority: 74, phase: 3 },
  { zip: '29414', state: 'SC', region: 'CHS', name: 'West Ashley',        lat: 32.7754, lon: -80.0363, priority: 73, phase: 3 },
  { zip: '29455', state: 'SC', region: 'CHS', name: 'Johns Island',       lat: 32.6954, lon: -80.0763, priority: 72, phase: 3 },
  // Myrtle Beach
  { zip: '29579', state: 'SC', region: 'MYR', name: 'Carolina Forest',    lat: 33.7654, lon: -78.9763, priority: 72, phase: 3 },
  { zip: '29576', state: 'SC', region: 'MYR', name: 'Murrells Inlet',     lat: 33.5454, lon: -79.0563, priority: 71, phase: 3 },
  { zip: '29572', state: 'SC', region: 'MYR', name: 'Myrtle Beach N',     lat: 33.7954, lon: -78.7963, priority: 70, phase: 3 },
  { zip: '29575', state: 'SC', region: 'MYR', name: 'Surfside Beach',     lat: 33.6154, lon: -78.9763, priority: 69, phase: 3 },
  // Columbia
  { zip: '29212', state: 'SC', region: 'COL', name: 'Irmo',               lat: 34.0854, lon: -81.1963, priority: 70, phase: 3 },
  { zip: '29229', state: 'SC', region: 'COL', name: 'Columbia NE',        lat: 34.1354, lon: -80.9263, priority: 69, phase: 3 },
  { zip: '29223', state: 'SC', region: 'COL', name: 'Columbia N',         lat: 34.0654, lon: -80.9963, priority: 68, phase: 3 },
  // Greenville / Spartanburg (upstate — manufacturing + BMW corridor)
  { zip: '29650', state: 'SC', region: 'GSP', name: 'Greer',              lat: 34.9354, lon: -82.2263, priority: 71, phase: 3 },
  { zip: '29615', state: 'SC', region: 'GSP', name: 'Greenville E',       lat: 34.8554, lon: -82.3263, priority: 70, phase: 3 },
  { zip: '29607', state: 'SC', region: 'GSP', name: 'Greenville S',       lat: 34.8054, lon: -82.3963, priority: 69, phase: 3 },
];

// ── PHASE 3 — North Carolina ──────────────────────────────────────────────────
const NC_ZIPS = [
  // Charlotte metro
  { zip: '28277', state: 'NC', region: 'CLT', name: 'Ballantyne',         lat: 35.0254, lon: -80.8463, priority: 82, phase: 3 },
  { zip: '28270', state: 'NC', region: 'CLT', name: 'Arboretum',          lat: 35.1054, lon: -80.8163, priority: 81, phase: 3 },
  { zip: '28105', state: 'NC', region: 'CLT', name: 'Matthews',           lat: 35.1254, lon: -80.7263, priority: 80, phase: 3 },
  { zip: '28078', state: 'NC', region: 'CLT', name: 'Huntersville',       lat: 35.4054, lon: -80.8463, priority: 79, phase: 3 },
  { zip: '28031', state: 'NC', region: 'CLT', name: 'Cornelius',          lat: 35.4854, lon: -80.8863, priority: 78, phase: 3 },
  { zip: '28027', state: 'NC', region: 'CLT', name: 'Concord',            lat: 35.3754, lon: -80.6063, priority: 77, phase: 3 },
  { zip: '28226', state: 'NC', region: 'CLT', name: 'South Charlotte',    lat: 35.1054, lon: -80.8263, priority: 76, phase: 3 },
  // Raleigh-Durham / Research Triangle
  { zip: '27560', state: 'NC', region: 'RDU', name: 'Morrisville',        lat: 35.8254, lon: -78.8363, priority: 80, phase: 3 },
  { zip: '27519', state: 'NC', region: 'RDU', name: 'Cary W',             lat: 35.7954, lon: -78.9463, priority: 79, phase: 3 },
  { zip: '27513', state: 'NC', region: 'RDU', name: 'Cary',               lat: 35.7854, lon: -78.7963, priority: 78, phase: 3 },
  { zip: '27615', state: 'NC', region: 'RDU', name: 'Raleigh N',          lat: 35.9154, lon: -78.6663, priority: 77, phase: 3 },
  { zip: '27703', state: 'NC', region: 'RDU', name: 'Durham E',           lat: 35.9754, lon: -78.8563, priority: 76, phase: 3 },
  { zip: '27705', state: 'NC', region: 'RDU', name: 'Durham W',           lat: 36.0254, lon: -79.0163, priority: 75, phase: 3 },
  // Wilmington (coastal)
  { zip: '28411', state: 'NC', region: 'ILM', name: 'Ogden',              lat: 34.2954, lon: -77.8163, priority: 71, phase: 3 },
  { zip: '28405', state: 'NC', region: 'ILM', name: 'Wilmington N',       lat: 34.2654, lon: -77.8763, priority: 70, phase: 3 },
  { zip: '28403', state: 'NC', region: 'ILM', name: 'Wilmington',         lat: 34.2254, lon: -77.9463, priority: 69, phase: 3 },
  // Asheville (mountain high-income market)
  { zip: '28803', state: 'NC', region: 'AVL', name: 'Asheville SE',       lat: 35.5454, lon: -82.5363, priority: 70, phase: 3 },
  { zip: '28804', state: 'NC', region: 'AVL', name: 'Asheville N',        lat: 35.6254, lon: -82.5663, priority: 69, phase: 3 },
  { zip: '28806', state: 'NC', region: 'AVL', name: 'Asheville W',        lat: 35.5854, lon: -82.6163, priority: 68, phase: 3 },
];

// ── PHASE 3 — Tennessee ───────────────────────────────────────────────────────
const TN_ZIPS = [
  // Nashville metro (fastest-growing metro in the south)
  { zip: '37027', state: 'TN', region: 'BNA', name: 'Brentwood',          lat: 36.0354, lon: -86.7863, priority: 84, phase: 3 },
  { zip: '37067', state: 'TN', region: 'BNA', name: 'Franklin N',         lat: 35.9754, lon: -86.8663, priority: 83, phase: 3 },
  { zip: '37064', state: 'TN', region: 'BNA', name: 'Franklin',           lat: 35.9254, lon: -86.8763, priority: 82, phase: 3 },
  { zip: '37069', state: 'TN', region: 'BNA', name: 'Franklin W',         lat: 35.9454, lon: -86.9263, priority: 81, phase: 3 },
  { zip: '37135', state: 'TN', region: 'BNA', name: 'Nolensville',        lat: 35.9554, lon: -86.6763, priority: 80, phase: 3 },
  { zip: '37174', state: 'TN', region: 'BNA', name: 'Spring Hill',        lat: 35.7454, lon: -86.9263, priority: 79, phase: 3 },
  { zip: '37221', state: 'TN', region: 'BNA', name: 'Bellevue',           lat: 36.0754, lon: -86.9363, priority: 78, phase: 3 },
  { zip: '37215', state: 'TN', region: 'BNA', name: 'Green Hills',        lat: 36.0854, lon: -86.8363, priority: 77, phase: 3 },
  { zip: '37211', state: 'TN', region: 'BNA', name: 'Antioch',            lat: 36.0354, lon: -86.7163, priority: 76, phase: 3 },
  // Memphis metro
  { zip: '38018', state: 'TN', region: 'MEM', name: 'Cordova',            lat: 35.1754, lon: -89.7563, priority: 73, phase: 3 },
  { zip: '38016', state: 'TN', region: 'MEM', name: 'Germantown',         lat: 35.0954, lon: -89.8163, priority: 72, phase: 3 },
  { zip: '38138', state: 'TN', region: 'MEM', name: 'Germantown S',       lat: 35.0654, lon: -89.7963, priority: 71, phase: 3 },
  // Chattanooga
  { zip: '37421', state: 'TN', region: 'CHA', name: 'Chattanooga E',      lat: 35.0354, lon: -85.1463, priority: 71, phase: 3 },
  { zip: '37415', state: 'TN', region: 'CHA', name: 'Red Bank',           lat: 35.1354, lon: -85.2563, priority: 70, phase: 3 },
  // Knoxville
  { zip: '37922', state: 'TN', region: 'TYS', name: 'Farragut',           lat: 35.8954, lon: -84.1963, priority: 72, phase: 3 },
  { zip: '37934', state: 'TN', region: 'TYS', name: 'Farragut S',         lat: 35.8654, lon: -84.2163, priority: 71, phase: 3 },
  { zip: '37923', state: 'TN', region: 'TYS', name: 'West Knoxville',     lat: 35.9354, lon: -84.1363, priority: 70, phase: 3 },
];

// ── PHASE 4 — Kentucky ────────────────────────────────────────────────────────
const KY_ZIPS = [
  // Louisville metro
  { zip: '40222', state: 'KY', region: 'SDF', name: 'Louisville E',       lat: 38.2654, lon: -85.6163, priority: 74, phase: 4 },
  { zip: '40223', state: 'KY', region: 'SDF', name: 'Louisville NE',      lat: 38.2754, lon: -85.5463, priority: 73, phase: 4 },
  { zip: '40241', state: 'KY', region: 'SDF', name: 'Middletown',         lat: 38.2954, lon: -85.5163, priority: 72, phase: 4 },
  { zip: '40245', state: 'KY', region: 'SDF', name: 'Anchorage',          lat: 38.2754, lon: -85.4963, priority: 71, phase: 4 },
  { zip: '40242', state: 'KY', region: 'SDF', name: 'St. Matthews E',     lat: 38.2554, lon: -85.5663, priority: 70, phase: 4 },
  // Lexington metro
  { zip: '40515', state: 'KY', region: 'LEX', name: 'Lexington SE',       lat: 37.9654, lon: -84.4463, priority: 73, phase: 4 },
  { zip: '40513', state: 'KY', region: 'LEX', name: 'Lexington W',        lat: 38.0054, lon: -84.5863, priority: 72, phase: 4 },
  { zip: '40514', state: 'KY', region: 'LEX', name: 'Lexington SW',       lat: 37.9854, lon: -84.5263, priority: 71, phase: 4 },
  { zip: '40509', state: 'KY', region: 'LEX', name: 'Lexington E',        lat: 38.0154, lon: -84.4063, priority: 70, phase: 4 },
  // Northern KY (Cincinnati metro spillover — high commercial activity)
  { zip: '41017', state: 'KY', region: 'CVG', name: 'Edgewood',           lat: 39.0254, lon: -84.5663, priority: 74, phase: 4 },
  { zip: '41042', state: 'KY', region: 'CVG', name: 'Florence',           lat: 38.9854, lon: -84.6263, priority: 73, phase: 4 },
  { zip: '41011', state: 'KY', region: 'CVG', name: 'Covington',          lat: 39.0654, lon: -84.5163, priority: 72, phase: 4 },
  { zip: '41018', state: 'KY', region: 'CVG', name: 'Erlanger',           lat: 39.0154, lon: -84.5963, priority: 71, phase: 4 },
  { zip: '41005', state: 'KY', region: 'CVG', name: 'Burlington',         lat: 38.9454, lon: -84.7163, priority: 70, phase: 4 },
];

// ── PHASE 4 — New Mexico ──────────────────────────────────────────────────────
const NM_ZIPS = [
  // Albuquerque metro (largest NM city)
  { zip: '87122', state: 'NM', region: 'ABQ', name: 'Albuquerque NE',     lat: 35.1854, lon: -106.5063, priority: 73, phase: 4 },
  { zip: '87111', state: 'NM', region: 'ABQ', name: 'Albuquerque E',      lat: 35.1354, lon: -106.5363, priority: 72, phase: 4 },
  { zip: '87114', state: 'NM', region: 'ABQ', name: 'Albuquerque NW',     lat: 35.1954, lon: -106.7063, priority: 71, phase: 4 },
  { zip: '87120', state: 'NM', region: 'ABQ', name: 'Albuquerque W',      lat: 35.1454, lon: -106.7263, priority: 70, phase: 4 },
  { zip: '87112', state: 'NM', region: 'ABQ', name: 'Albuquerque Foothills', lat: 35.1254, lon: -106.5163, priority: 69, phase: 4 },
  { zip: '87048', state: 'NM', region: 'ABQ', name: 'Corrales',           lat: 35.2354, lon: -106.6063, priority: 68, phase: 4 },
  // Rio Rancho (fastest-growing NM city)
  { zip: '87144', state: 'NM', region: 'ABQ', name: 'Rio Rancho N',       lat: 35.3454, lon: -106.6663, priority: 71, phase: 4 },
  { zip: '87124', state: 'NM', region: 'ABQ', name: 'Rio Rancho',         lat: 35.2954, lon: -106.6963, priority: 70, phase: 4 },
  // Santa Fe
  { zip: '87505', state: 'NM', region: 'SAF', name: 'Santa Fe SE',        lat: 35.6454, lon: -105.9463, priority: 70, phase: 4 },
  { zip: '87506', state: 'NM', region: 'SAF', name: 'Santa Fe N',         lat: 35.7054, lon: -106.0063, priority: 69, phase: 4 },
  { zip: '87501', state: 'NM', region: 'SAF', name: 'Santa Fe',           lat: 35.6854, lon: -105.9363, priority: 68, phase: 4 },
  // Las Cruces (border market — high commercial growth)
  { zip: '88011', state: 'NM', region: 'LCR', name: 'Las Cruces E',       lat: 32.3454, lon: -106.7063, priority: 68, phase: 4 },
  { zip: '88007', state: 'NM', region: 'LCR', name: 'Las Cruces W',       lat: 32.3254, lon: -106.8463, priority: 67, phase: 4 },
];

// ── PHASE 4 — Arizona ─────────────────────────────────────────────────────────
const AZ_ZIPS = [
  // North Scottsdale / Paradise Valley (highest income in AZ)
  { zip: '85255', state: 'AZ', region: 'PHX', name: 'N. Scottsdale',      lat: 33.6854, lon: -111.8963, priority: 84, phase: 4 },
  { zip: '85266', state: 'AZ', region: 'PHX', name: 'Scottsdale NW',      lat: 33.7354, lon: -111.9363, priority: 83, phase: 4 },
  { zip: '85254', state: 'AZ', region: 'PHX', name: 'Scottsdale N',       lat: 33.6254, lon: -111.9763, priority: 82, phase: 4 },
  { zip: '85259', state: 'AZ', region: 'PHX', name: 'Scottsdale NE',      lat: 33.6054, lon: -111.8363, priority: 81, phase: 4 },
  { zip: '85253', state: 'AZ', region: 'PHX', name: 'Paradise Valley',    lat: 33.5354, lon: -111.9763, priority: 80, phase: 4 },
  { zip: '85250', state: 'AZ', region: 'PHX', name: 'Scottsdale Central', lat: 33.4954, lon: -111.9263, priority: 79, phase: 4 },
  // Gilbert / Chandler (East Valley growth corridor)
  { zip: '85234', state: 'AZ', region: 'PHX', name: 'Gilbert',            lat: 33.3654, lon: -111.8163, priority: 76, phase: 4 },
  { zip: '85296', state: 'AZ', region: 'PHX', name: 'Gilbert E',          lat: 33.3254, lon: -111.7463, priority: 75, phase: 4 },
  { zip: '85249', state: 'AZ', region: 'PHX', name: 'Chandler E',         lat: 33.2954, lon: -111.8163, priority: 74, phase: 4 },
  { zip: '85286', state: 'AZ', region: 'PHX', name: 'Chandler',           lat: 33.2654, lon: -111.9263, priority: 73, phase: 4 },
  // Tempe / Mesa
  { zip: '85281', state: 'AZ', region: 'PHX', name: 'Tempe',              lat: 33.4154, lon: -111.9763, priority: 72, phase: 4 },
  { zip: '85204', state: 'AZ', region: 'PHX', name: 'Mesa',               lat: 33.3954, lon: -111.7963, priority: 71, phase: 4 },
  // Peoria / Surprise / Goodyear (West Valley — massive growth)
  { zip: '85383', state: 'AZ', region: 'PHX', name: 'Peoria N',           lat: 33.6654, lon: -112.2263, priority: 74, phase: 4 },
  { zip: '85374', state: 'AZ', region: 'PHX', name: 'Surprise',           lat: 33.6554, lon: -112.3463, priority: 73, phase: 4 },
  { zip: '85338', state: 'AZ', region: 'PHX', name: 'Goodyear',           lat: 33.4354, lon: -112.3763, priority: 72, phase: 4 },
  // Tucson
  { zip: '85718', state: 'AZ', region: 'TUS', name: 'Foothills',          lat: 32.3454, lon: -110.9363, priority: 70, phase: 4 },
  { zip: '85750', state: 'AZ', region: 'TUS', name: 'Tucson NE',          lat: 32.2954, lon: -110.8063, priority: 69, phase: 4 },
  { zip: '85749', state: 'AZ', region: 'TUS', name: 'Tucson E',           lat: 32.2554, lon: -110.7763, priority: 68, phase: 4 },
  { zip: '85741', state: 'AZ', region: 'TUS', name: 'Tucson NW',          lat: 32.3354, lon: -111.0363, priority: 67, phase: 4 },
  // Flagstaff (mountain market — high tourism/retail)
  { zip: '86004', state: 'AZ', region: 'FLG', name: 'Flagstaff E',        lat: 35.2154, lon: -111.5863, priority: 65, phase: 4 },
  { zip: '86001', state: 'AZ', region: 'FLG', name: 'Flagstaff',          lat: 35.1954, lon: -111.6563, priority: 64, phase: 4 },
];

// ── PHASE 5 — Southern California ────────────────────────────────────────────
const SoCal_ZIPS = [
  // San Diego metro (highest income coastal SoCal)
  { zip: '92130', state: 'CA', region: 'SAN', name: 'Carmel Valley',      lat: 32.9254, lon: -117.2263, priority: 86, phase: 5 },
  { zip: '92127', state: 'CA', region: 'SAN', name: 'Rancho Bernardo',    lat: 33.0354, lon: -117.0763, priority: 85, phase: 5 },
  { zip: '92128', state: 'CA', region: 'SAN', name: 'Rancho Bernardo E',  lat: 33.0254, lon: -117.0563, priority: 84, phase: 5 },
  { zip: '92131', state: 'CA', region: 'SAN', name: 'Scripps Ranch',      lat: 32.9154, lon: -117.1063, priority: 83, phase: 5 },
  { zip: '92037', state: 'CA', region: 'SAN', name: 'La Jolla',           lat: 32.8454, lon: -117.2763, priority: 82, phase: 5 },
  { zip: '92129', state: 'CA', region: 'SAN', name: 'Penasquitos',        lat: 32.9654, lon: -117.1163, priority: 81, phase: 5 },
  { zip: '92009', state: 'CA', region: 'SAN', name: 'Carlsbad S',         lat: 33.0754, lon: -117.2763, priority: 80, phase: 5 },
  { zip: '92011', state: 'CA', region: 'SAN', name: 'Carlsbad W',         lat: 33.1154, lon: -117.3063, priority: 79, phase: 5 },
  { zip: '92024', state: 'CA', region: 'SAN', name: 'Encinitas',          lat: 33.0454, lon: -117.2763, priority: 78, phase: 5 },
  { zip: '92014', state: 'CA', region: 'SAN', name: 'Del Mar',            lat: 32.9554, lon: -117.2663, priority: 77, phase: 5 },
  // Orange County (highest business density in SoCal after LA proper)
  { zip: '92620', state: 'CA', region: 'SNA', name: 'Irvine NE',          lat: 33.7354, lon: -117.7263, priority: 85, phase: 5 },
  { zip: '92618', state: 'CA', region: 'SNA', name: 'Irvine S',           lat: 33.6654, lon: -117.7463, priority: 84, phase: 5 },
  { zip: '92612', state: 'CA', region: 'SNA', name: 'Irvine',             lat: 33.6854, lon: -117.8063, priority: 83, phase: 5 },
  { zip: '92630', state: 'CA', region: 'SNA', name: 'Lake Forest',        lat: 33.6454, lon: -117.6963, priority: 82, phase: 5 },
  { zip: '92657', state: 'CA', region: 'SNA', name: 'Newport Coast',      lat: 33.6054, lon: -117.8263, priority: 81, phase: 5 },
  { zip: '92651', state: 'CA', region: 'SNA', name: 'Laguna Beach',       lat: 33.5454, lon: -117.7763, priority: 80, phase: 5 },
  { zip: '92660', state: 'CA', region: 'SNA', name: 'Newport Beach',      lat: 33.6354, lon: -117.8763, priority: 79, phase: 5 },
  { zip: '92663', state: 'CA', region: 'SNA', name: 'Newport Beach W',    lat: 33.6254, lon: -117.9363, priority: 78, phase: 5 },
  { zip: '92625', state: 'CA', region: 'SNA', name: 'Corona del Mar',     lat: 33.5954, lon: -117.8663, priority: 77, phase: 5 },
  // LA metro — beach cities + affluent suburbs
  { zip: '90266', state: 'CA', region: 'LAX', name: 'Manhattan Beach',    lat: 33.8854, lon: -118.4063, priority: 84, phase: 5 },
  { zip: '90274', state: 'CA', region: 'LAX', name: 'Palos Verdes',       lat: 33.7654, lon: -118.3563, priority: 83, phase: 5 },
  { zip: '90277', state: 'CA', region: 'LAX', name: 'Redondo Beach',      lat: 33.8454, lon: -118.3863, priority: 82, phase: 5 },
  { zip: '90254', state: 'CA', region: 'LAX', name: 'Hermosa Beach',      lat: 33.8654, lon: -118.3963, priority: 81, phase: 5 },
  { zip: '90272', state: 'CA', region: 'LAX', name: 'Pacific Palisades',  lat: 34.0454, lon: -118.5263, priority: 80, phase: 5 },
  { zip: '90402', state: 'CA', region: 'LAX', name: 'Santa Monica N',     lat: 34.0354, lon: -118.4763, priority: 79, phase: 5 },
  { zip: '90049', state: 'CA', region: 'LAX', name: 'Brentwood',          lat: 34.0554, lon: -118.4763, priority: 78, phase: 5 },
  { zip: '91011', state: 'CA', region: 'LAX', name: 'La Cañada',          lat: 34.2054, lon: -118.2063, priority: 77, phase: 5 },
  // Inland Empire (massive logistics + population growth)
  { zip: '92506', state: 'CA', region: 'RIV', name: 'Riverside W',        lat: 33.9554, lon: -117.4263, priority: 73, phase: 5 },
  { zip: '92562', state: 'CA', region: 'RIV', name: 'Murrieta',           lat: 33.5754, lon: -117.2063, priority: 72, phase: 5 },
  { zip: '92563', state: 'CA', region: 'RIV', name: 'Murrieta E',         lat: 33.5554, lon: -117.1563, priority: 71, phase: 5 },
  { zip: '92596', state: 'CA', region: 'RIV', name: 'Winchester',         lat: 33.7054, lon: -117.0963, priority: 70, phase: 5 },
  { zip: '92354', state: 'CA', region: 'SBD', name: 'Loma Linda',         lat: 34.0454, lon: -117.2663, priority: 70, phase: 5 },
  // Palm Springs / Coachella Valley (resort + retirement market)
  { zip: '92262', state: 'CA', region: 'PSP', name: 'Palm Springs N',     lat: 33.8354, lon: -116.5463, priority: 72, phase: 5 },
  { zip: '92264', state: 'CA', region: 'PSP', name: 'Palm Springs S',     lat: 33.7954, lon: -116.5263, priority: 71, phase: 5 },
  { zip: '92270', state: 'CA', region: 'PSP', name: 'Rancho Mirage',      lat: 33.7354, lon: -116.4263, priority: 70, phase: 5 },
  { zip: '92210', state: 'CA', region: 'PSP', name: 'Indian Wells',       lat: 33.7154, lon: -116.3463, priority: 69, phase: 5 },
];


// ── PHASE 3 — Oklahoma ────────────────────────────────────────────────────────
const OK_ZIPS = [
  // Oklahoma City metro
  { zip: '73120', state: 'OK', region: 'OKC', name: 'NW OKC',             lat: 35.5754, lon: -97.6063, priority: 76, phase: 3 },
  { zip: '73118', state: 'OK', region: 'OKC', name: 'Nichols Hills',      lat: 35.5454, lon: -97.5563, priority: 75, phase: 3 },
  { zip: '73116', state: 'OK', region: 'OKC', name: 'OKC NW 2',           lat: 35.5554, lon: -97.5863, priority: 74, phase: 3 },
  { zip: '73034', state: 'OK', region: 'OKC', name: 'Edmond N',           lat: 35.6854, lon: -97.4963, priority: 73, phase: 3 },
  { zip: '73025', state: 'OK', region: 'OKC', name: 'Edmond W',           lat: 35.6554, lon: -97.5763, priority: 72, phase: 3 },
  { zip: '73012', state: 'OK', region: 'OKC', name: 'Deer Creek',         lat: 35.6154, lon: -97.5763, priority: 71, phase: 3 },
  { zip: '73170', state: 'OK', region: 'OKC', name: 'Moore',              lat: 35.3354, lon: -97.5163, priority: 70, phase: 3 },
  { zip: '73160', state: 'OK', region: 'OKC', name: 'Moore S',            lat: 35.3154, lon: -97.4963, priority: 69, phase: 3 },
  { zip: '73069', state: 'OK', region: 'OKC', name: 'Norman N',           lat: 35.2554, lon: -97.4463, priority: 68, phase: 3 },
  { zip: '73072', state: 'OK', region: 'OKC', name: 'Norman W',           lat: 35.2254, lon: -97.5063, priority: 67, phase: 3 },
  // Tulsa metro
  { zip: '74137', state: 'OK', region: 'TUL', name: 'S. Tulsa',           lat: 36.0254, lon: -95.9463, priority: 75, phase: 3 },
  { zip: '74133', state: 'OK', region: 'TUL', name: 'SE Tulsa',           lat: 36.0454, lon: -95.8963, priority: 74, phase: 3 },
  { zip: '74136', state: 'OK', region: 'TUL', name: 'Tulsa Midtown',      lat: 36.0754, lon: -95.9663, priority: 73, phase: 3 },
  { zip: '74114', state: 'OK', region: 'TUL', name: 'Midtown Tulsa',      lat: 36.1254, lon: -95.9563, priority: 72, phase: 3 },
  { zip: '74063', state: 'OK', region: 'TUL', name: 'Sand Springs',       lat: 36.1454, lon: -96.1063, priority: 70, phase: 3 },
  { zip: '74055', state: 'OK', region: 'TUL', name: 'Owasso',             lat: 36.2754, lon: -95.8463, priority: 72, phase: 3 },
  { zip: '74012', state: 'OK', region: 'TUL', name: 'Broken Arrow',       lat: 36.0554, lon: -95.7963, priority: 71, phase: 3 },
];

// ── PHASE 3 — Arkansas ────────────────────────────────────────────────────────
const AR_ZIPS = [
  // Bentonville / NW Arkansas (Walmart HQ — fastest-growing AR market)
  { zip: '72712', state: 'AR', region: 'XNA', name: 'Bentonville',        lat: 36.3754, lon: -94.2063, priority: 82, phase: 3 },
  { zip: '72713', state: 'AR', region: 'XNA', name: 'Bentonville E',      lat: 36.3554, lon: -94.1463, priority: 81, phase: 3 },
  { zip: '72758', state: 'AR', region: 'XNA', name: 'Rogers',             lat: 36.3354, lon: -94.1863, priority: 80, phase: 3 },
  { zip: '72756', state: 'AR', region: 'XNA', name: 'Rogers N',           lat: 36.3654, lon: -94.2363, priority: 79, phase: 3 },
  { zip: '72701', state: 'AR', region: 'XNA', name: 'Fayetteville',       lat: 36.0754, lon: -94.2063, priority: 78, phase: 3 },
  { zip: '72703', state: 'AR', region: 'XNA', name: 'Fayetteville N',     lat: 36.1154, lon: -94.1663, priority: 77, phase: 3 },
  { zip: '72762', state: 'AR', region: 'XNA', name: 'Springdale',         lat: 36.1854, lon: -94.1363, priority: 76, phase: 3 },
  { zip: '72764', state: 'AR', region: 'XNA', name: 'Springdale E',       lat: 36.1654, lon: -94.1063, priority: 75, phase: 3 },
  // Little Rock metro
  { zip: '72223', state: 'AR', region: 'LIT', name: 'West Little Rock',   lat: 34.7654, lon: -92.4763, priority: 73, phase: 3 },
  { zip: '72211', state: 'AR', region: 'LIT', name: 'LR W',               lat: 34.7554, lon: -92.4263, priority: 72, phase: 3 },
  { zip: '72227', state: 'AR', region: 'LIT', name: 'LR Heights',         lat: 34.7854, lon: -92.4063, priority: 71, phase: 3 },
  { zip: '72034', state: 'AR', region: 'LIT', name: 'Conway',             lat: 35.0954, lon: -92.4663, priority: 70, phase: 3 },
  { zip: '72032', state: 'AR', region: 'LIT', name: 'Conway S',           lat: 35.0654, lon: -92.4463, priority: 69, phase: 3 },
  // Fort Smith (border market — OK/AR crossover)
  { zip: '72908', state: 'AR', region: 'FSM', name: 'Fort Smith SW',      lat: 35.3354, lon: -94.4163, priority: 67, phase: 3 },
  { zip: '72903', state: 'AR', region: 'FSM', name: 'Fort Smith',         lat: 35.3754, lon: -94.3963, priority: 66, phase: 3 },
];

// ── Exports ───────────────────────────────────────────────────────────────────

const ALL_SUNBELT_ZIPS = [
  ...TX_ZIPS, ...AL_ZIPS, ...MS_ZIPS, ...LA_ZIPS,
  ...GA_ZIPS, ...SC_ZIPS, ...NC_ZIPS, ...TN_ZIPS,
  ...OK_ZIPS, ...AR_ZIPS,
  ...KY_ZIPS, ...NM_ZIPS, ...AZ_ZIPS,
  ...SoCal_ZIPS,
];

// Remove any accidental duplicates by ZIP code
const _seen = new Set();
const DEDUPLICATED_SUNBELT_ZIPS = ALL_SUNBELT_ZIPS.filter(z => {
  if (_seen.has(z.zip)) return false;
  _seen.add(z.zip);
  return true;
});

function getZipsByPhase(phase) {
  return DEDUPLICATED_SUNBELT_ZIPS.filter(z => z.phase === phase);
}

function getZipsByState(state) {
  return DEDUPLICATED_SUNBELT_ZIPS.filter(z => z.state === state.toUpperCase());
}

function getSummary() {
  const byState = {};
  DEDUPLICATED_SUNBELT_ZIPS.forEach(z => {
    if (!byState[z.state]) byState[z.state] = { total: 0, phase: z.phase };
    byState[z.state].total++;
  });
  const byPhase = {};
  DEDUPLICATED_SUNBELT_ZIPS.forEach(z => {
    byPhase[z.phase] = (byPhase[z.phase] || 0) + 1;
  });
  return {
    total: DEDUPLICATED_SUNBELT_ZIPS.length,
    byState,
    byPhase,
  };
}

module.exports = {
  ALL_SUNBELT_ZIPS: DEDUPLICATED_SUNBELT_ZIPS,
  TX_ZIPS, AL_ZIPS, MS_ZIPS, LA_ZIPS,
  GA_ZIPS, SC_ZIPS, NC_ZIPS, TN_ZIPS,
  OK_ZIPS, AR_ZIPS,
  KY_ZIPS, NM_ZIPS, AZ_ZIPS,
  SoCal_ZIPS,
  getZipsByPhase, getZipsByState, getSummary,
};
