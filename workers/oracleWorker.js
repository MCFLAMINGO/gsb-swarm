'use strict';
/**
 * oracleWorker.js — LocalIntel Oracle Layer
 *
 * Synthesizes all tidal layers + business data into pre-baked economic
 * narratives. Answers the question before the user knows to ask it.
 *
 * Computes per ZIP:
 *   - restaurant_capacity   : is there room for another? based on pop + income + calorie math
 *   - market_gaps           : what price tier / category is undersupplied?
 *   - growth_trajectory     : growing, stable, or emptying? (school + ownership signals)
 *   - top_questions         : 3 pre-formed questions with answers baked in
 *   - oracle_narrative      : one-paragraph plain-English brief
 *
 * Writes: data/oracle/{zip}.json + data/oracle/_index.json
 * Schedule: runs on start, then every 6 hours
 */

const path = require('path');
const fs   = require('fs');

// flZipRegistry — Census ACS population + income fallback when no zone/ocean data
let _flRegistry = null;
function getFlRegistry() {
  if (_flRegistry) return _flRegistry;
  try {
    const { getAllZips } = require('./flZipRegistry');
    _flRegistry = {};
    getAllZips().forEach(z => { _flRegistry[z.zip] = z; });
  } catch (e) {
    _flRegistry = {};
  }
  return _flRegistry;
}

const DATA_DIR    = path.join(__dirname, '..', 'data');
const ORACLE_DIR  = path.join(DATA_DIR, 'oracle');
const INDEX_FILE  = path.join(ORACLE_DIR, '_index.json');
const HISTORY_DIR = path.join(ORACLE_DIR, 'history'); // time-series per ZIP
const MAX_HISTORY = 180; // keep 90 days @ 2x/day headroom

// ── Postgres (optional — fire-and-forget, never blocks oracle) ────────────────
let _db = null;
function getDb() {
  if (!_db && process.env.LOCAL_INTEL_DB_URL) {
    try { _db = require('../lib/db'); } catch (_) {}
  }
  return _db;
}
async function upsertZipIntelligence(zip, result) {
  const db = getDb();
  if (!db) return;
  try {
    await db.query(
      `INSERT INTO zip_intelligence (
         zip, name, state,
         population, median_household_income, median_home_value,
         owner_occupied_pct, total_households,
         wfh_pct, affluence_pct, ultra_affluence_pct,
         retiree_index, new_build_pct,
         age_25_34_pct, age_35_54_pct, age_55_plus_pct,
         vacancy_rate_pct, family_hh_pct,
         restaurant_count, total_businesses, gap_count,
         saturation_status, growth_state, consumer_profile,
         oracle_json, computed_at, updated_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25::jsonb,NOW(),NOW())
       ON CONFLICT (zip) DO UPDATE SET
         name                    = EXCLUDED.name,
         state                   = EXCLUDED.state,
         population              = EXCLUDED.population,
         median_household_income = EXCLUDED.median_household_income,
         median_home_value       = EXCLUDED.median_home_value,
         owner_occupied_pct      = EXCLUDED.owner_occupied_pct,
         total_households        = EXCLUDED.total_households,
         wfh_pct                 = EXCLUDED.wfh_pct,
         affluence_pct           = EXCLUDED.affluence_pct,
         ultra_affluence_pct     = EXCLUDED.ultra_affluence_pct,
         retiree_index           = EXCLUDED.retiree_index,
         new_build_pct           = EXCLUDED.new_build_pct,
         age_25_34_pct           = EXCLUDED.age_25_34_pct,
         age_35_54_pct           = EXCLUDED.age_35_54_pct,
         age_55_plus_pct         = EXCLUDED.age_55_plus_pct,
         vacancy_rate_pct        = EXCLUDED.vacancy_rate_pct,
         family_hh_pct           = EXCLUDED.family_hh_pct,
         restaurant_count        = EXCLUDED.restaurant_count,
         total_businesses        = EXCLUDED.total_businesses,
         gap_count               = EXCLUDED.gap_count,
         saturation_status       = EXCLUDED.saturation_status,
         growth_state            = EXCLUDED.growth_state,
         consumer_profile        = EXCLUDED.consumer_profile,
         oracle_json             = EXCLUDED.oracle_json,
         computed_at             = NOW(),
         updated_at              = NOW()`,
      [
        zip,
        result.name || zip,
        result.state || 'FL',
        result.demographics?.population              || null,
        result.demographics?.median_household_income || result.demographics?.median_hhi || null,
        result.demographics?.median_home_value       || null,
        result.demographics?.owner_occupied_pct      || null,
        result.demographics?.total_households        || null,
        result.demographics?.wfh_pct                || null,
        result.demographics?.affluence_pct           || null,
        result.demographics?.ultra_affluence_pct     || null,
        result.demographics?.retiree_index           || null,
        result.demographics?.new_build_pct           || null,
        result.demographics?.age_25_34_pct           || null,
        result.demographics?.age_35_54_pct           || null,
        result.demographics?.age_55_plus_pct         || null,
        result.demographics?.vacancy_rate_pct        || null,
        result.demographics?.family_hh_pct           || null,
        result.restaurant_capacity?.restaurant_count || null,
        result.total_businesses                      || null,
        result.market_gaps?.tier_gaps?.filter(g => g.gap > 0).length || null,
        result.restaurant_capacity?.saturation_status || null,
        result.growth_trajectory?.state              || null,
        result.demographics?.consumer_profile        || null,
        JSON.stringify(result),
      ]
    );
  } catch (e) {
    console.error(`[oracleWorker] PG upsert failed for ${zip}:`, e.message);
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

// Average US restaurant serves ~100-150 covers/day, ~350 meals/day
// FDA daily caloric rec: 2000 cal. Average restaurant meal: ~850 cal.
// So each person eats out ~0.4x per day on average in US.
// In affluent suburbs (income >$100k): ~0.6x per day.
const MEALS_OUT_PER_DAY_BASE    = 0.40; // US average
const MEALS_OUT_PER_DAY_AFFLUENT = 0.62; // income >$100k
const AVG_RESTAURANT_COVERS_DAY  = 280; // covers/day avg full-service restaurant
const AVG_FASTFOOD_COVERS_DAY    = 520; // covers/day fast food

// Menu price tiers (avg check per person)
const PRICE_TIERS = [
  { label: 'budget',    min: 0,   max: 12,  description: 'Under $12 — fast casual / counter service' },
  { label: 'midrange',  min: 12,  max: 25,  description: '$12–$25 — casual dining' },
  { label: 'upscale',   min: 25,  max: 60,  description: '$25–$60 — full service, bar' },
  { label: 'fine',      min: 60,  max: 999, description: '$60+ — fine dining / tasting menu' },
];

// Income → expected price tier demand distribution
// e.g. at $130k HHI: 15% budget, 45% midrange, 30% upscale, 10% fine
function priceTierDemand(medianHHI) {
  if (medianHHI >= 150_000) return { budget: 0.10, midrange: 0.35, upscale: 0.40, fine: 0.15 };
  if (medianHHI >= 100_000) return { budget: 0.15, midrange: 0.45, upscale: 0.30, fine: 0.10 };
  if (medianHHI >= 65_000)  return { budget: 0.25, midrange: 0.50, upscale: 0.20, fine: 0.05 };
  return                           { budget: 0.45, midrange: 0.40, upscale: 0.13, fine: 0.02 };
}

// Category → price tier mapping from OSM/data categories
const CATEGORY_TIER = {
  'fast_food':    'budget',
  'cafe':         'budget',
  'food_court':   'budget',
  'restaurant':   'midrange',  // default — refined below by name signals
  'bar':          'midrange',
  'pub':          'midrange',
  'steakhouse':   'upscale',
  'seafood':      'upscale',
  'sushi':        'upscale',
  'fine_dining':  'fine',
};

// Growth signals: what ownership rate + school count implies
function growthTrajectory({ ownerPct, schoolCount, medianHomeValue, population }) {
  // Owner-occupied >80% + schools present = family formation zone (growing)
  // Owner-occupied >80% + no schools + high home value = empty nest transition
  // Renter-heavy + low home value = transient / working class
  if (ownerPct >= 80 && schoolCount >= 2 && population > 10_000) {
    return { state: 'growing', label: 'Active Family Formation', confidence: 'high' };
  }
  if (ownerPct >= 75 && schoolCount <= 1 && medianHomeValue > 500_000) {
    return { state: 'transitioning', label: 'Empty Nest Transition', confidence: 'medium' };
  }
  if (ownerPct >= 70 && schoolCount >= 1) {
    return { state: 'stable', label: 'Established Suburban', confidence: 'medium' };
  }
  if (ownerPct < 50) {
    return { state: 'transient', label: 'High Renter Turnover', confidence: 'medium' };
  }
  return { state: 'stable', label: 'Stable Mixed', confidence: 'low' };
}

// ── Data readers ──────────────────────────────────────────────────────────────

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function loadBusinesses(zip) {
  // Try per-ZIP file first, fall back to main index
  const zipFile = path.join(DATA_DIR, 'zips', `${zip}.json`);
  if (fs.existsSync(zipFile)) {
    const d = readJson(zipFile);
    return Array.isArray(d) ? d : (d?.businesses || []);
  }
  // Fall back to scanning localIntel.json
  const main = path.join(DATA_DIR, 'localIntel.json');
  if (fs.existsSync(main)) {
    const all = readJson(main);
    const arr = Array.isArray(all) ? all : (all?.businesses || []);
    return arr.filter(b => b.zip === zip || b.zip === String(zip));
  }
  return [];
}

function loadSpendingZone(zip) {
  const zones = readJson(path.join(DATA_DIR, 'spendingZones.json'));
  return zones?.zones?.[zip] || zones?.zones?.[String(zip)] || null;
}

function loadBedrock(zip) {
  return readJson(path.join(DATA_DIR, 'bedrock', `${zip}.json`));
}

function loadOceanFloor(zip) {
  return readJson(path.join(DATA_DIR, 'ocean_floor', `${zip}.json`));
}

function loadCensusLayer(zip) {
  return readJson(path.join(DATA_DIR, 'census_layer', `${zip}.json`));
}

function loadAcs(zip) {
  return readJson(path.join(DATA_DIR, 'acs', `${zip}.json`));
}

// Load all vertical gap entries for this ZIP from data/gaps/{vertical}.json
function loadGapsForZip(zip) {
  const GAPS_DIR = path.join(DATA_DIR, 'gaps');
  if (!fs.existsSync(GAPS_DIR)) return [];
  const results = [];
  const files = fs.readdirSync(GAPS_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));
  for (const file of files) {
    try {
      const entries = JSON.parse(fs.readFileSync(path.join(GAPS_DIR, file), 'utf8'));
      if (!Array.isArray(entries)) continue;
      const vertical = file.replace('.json', '');
      for (const entry of entries) {
        if (String(entry.zip) === String(zip)) {
          results.push({ vertical, ...entry });
        }
      }
    } catch { /* skip bad file */ }
  }
  return results;
}

// ── Core oracle computation ───────────────────────────────────────────────────

function computeOracle(zip, name) {
  const businesses  = loadBusinesses(zip);
  const zone        = loadSpendingZone(zip);
  const bedrock     = loadBedrock(zip);
  const ocean       = loadOceanFloor(zip);
  const censusLayer = loadCensusLayer(zip);
  const acs         = loadAcs(zip);
  const verticalGaps = loadGapsForZip(zip);

  // ── Data quality gate ─────────────────────────────────────────────────────
  // Reject ZIPs with no demographic data AND insufficient business coverage.
  // These produce population=0 → 0% capture → false "opportunity high" signals.
  const hasZoneData  = !!zone;
  const hasOceanData = !!ocean;
  const hasDemoData  = hasZoneData || hasOceanData;
  if (!hasDemoData && businesses.length < 5) {
    return { skip: true, reason: 'insufficient_data', zip, businesses: businesses.length };
  }

  // ── Demographics ──────────────────────────────────────────────────────────
  // Priority: ACS worker (fresh Census B-series) > spending zone > ocean floor > flZipRegistry
  const reg = getFlRegistry()[zip] || {};
  const population   = acs?.population              || zone?.population              || ocean?.population                    || reg.population || 0;
  const medianHHI    = acs?.median_household_income || zone?.median_household_income || zone?.median_income                  || ocean?.median_household_income || reg.median_hhi || 0;
  const medianHome   = acs?.median_home_value       || zone?.median_home_value       || ocean?.median_home_value             || 0;
  const ownerOccPct  = acs?.owner_occupied_pct      || zone?.ownership_rate_pct      || zone?.ownership_rate                 || ocean?.owner_pct || 60;
  const ownerUnits   = acs?.owner_occupied_units    || zone?.owner_occupied_units    || 0;
  const renterUnits  = acs?.renter_occupied_units   || zone?.renter_occupied_units   || 0;
  const totalHH      = acs?.total_households        || (ownerUnits + renterUnits)    || Math.round(population / 2.5);

  // ── Extended Census signals — prefer ACS worker output, fall back to zone ──
  const wfhPct              = acs?.wfh_pct               || zone?.wfh_pct               || 0;
  const daytimeMultiplier   = acs?.daytime_pop_multiplier || zone?.daytime_pop_multiplier || 1.0;
  const retireeIndex        = acs?.retiree_index          || zone?.retiree_index          || 0;
  const vacancyRatePct      = zone?.vacancy_rate_pct      || 8;
  const familyHHPct         = zone?.family_hh_pct         || 60;
  const affluencePct        = acs?.affluence_pct          || zone?.affluence_pct          || 0;
  const ultraAffluencePct   = acs?.ultra_affluence_pct    || zone?.ultra_affluence_pct    || 0;
  const renovationWave      = zone?.renovation_wave       || 'low';
  const housingAgeProfile   = zone?.housing_age_profile   || 'mixed_vintage';
  const newBuildPct         = zone?.new_build_pct         || 0;

  // ── Business inventory ────────────────────────────────────────────────────
  const foodBiz = businesses.filter(b => {
    const cat = (b.category || '').toLowerCase();
    return cat.includes('restaurant') || cat.includes('food') ||
           cat.includes('cafe') || cat.includes('fast_food') ||
           cat.includes('bar') || cat.includes('pub') ||
           cat.includes('bakery') || cat.includes('pizza') ||
           cat.includes('sushi') || cat.includes('diner');
  });

  const totalBiz       = businesses.length;
  const restaurantCount = foodBiz.length;

  // Categorize by tier
  const tierCounts = { budget: 0, midrange: 0, upscale: 0, fine: 0, unknown: 0 };
  for (const b of foodBiz) {
    const cat = (b.category || '').toLowerCase();
    const tier = CATEGORY_TIER[cat] || 'unknown';
    tierCounts[tier]++;
  }

  // Count schools
  const schoolCount = businesses.filter(b => {
    const cat = (b.category || '').toLowerCase();
    return cat.includes('school') || cat.includes('college') ||
           cat.includes('university') || cat.includes('academy') ||
           cat.includes('kindergarten');
  }).length;

  // ── Restaurant capacity model ─────────────────────────────────────────────
  const isAffluent = medianHHI >= 100_000;
  const mealsOutPerDay = isAffluent ? MEALS_OUT_PER_DAY_AFFLUENT : MEALS_OUT_PER_DAY_BASE;
  // Daytime multiplier: WFH workers stay in the ZIP during business hours, inflating lunch demand.
  // Retiree index adds a breakfast/lunch premium (retirees eat out more during the day).
  // We apply to population before multiplying by meals rate — effective demand is higher than resident count alone.
  const daytimeDemandPop = Math.round(population * daytimeMultiplier * (1 + retireeIndex * 0.002));
  const totalMealsOutPerDay = daytimeDemandPop * mealsOutPerDay;

  // Weighted avg covers/day (mix of fast food and sit-down)
  const fastFoodShare = (tierCounts.budget / Math.max(1, restaurantCount));
  const avgCoversPerRestaurant = Math.round(
    fastFoodShare * AVG_FASTFOOD_COVERS_DAY +
    (1 - fastFoodShare) * AVG_RESTAURANT_COVERS_DAY
  );

  const marketCapacityMeals = restaurantCount * avgCoversPerRestaurant;
  const captureRate = totalMealsOutPerDay > 0
    ? Math.round((marketCapacityMeals / totalMealsOutPerDay) * 100)
    : 0;

  // Saturation: >100% = oversupplied, <60% = room for more, 60-100% = balanced
  let restaurantSaturation;
  if (captureRate >= 120)     restaurantSaturation = 'oversaturated';
  else if (captureRate >= 90) restaurantSaturation = 'balanced';
  else if (captureRate >= 60) restaurantSaturation = 'room_for_niche';
  else                        restaurantSaturation = 'undersupplied';

  const restaurantsToSupport = population > 0
    ? Math.round(totalMealsOutPerDay / avgCoversPerRestaurant)
    : 0;

  const gapCount = Math.max(0, restaurantsToSupport - restaurantCount);

  // ── Price tier gap analysis ───────────────────────────────────────────────
  const demandDist = priceTierDemand(medianHHI);
  const tierGaps = [];

  for (const [tier, demandPct] of Object.entries(demandDist)) {
    const expectedCount = Math.round(restaurantsToSupport * demandPct);
    const actualCount   = tierCounts[tier] || 0;
    const gap           = expectedCount - actualCount;
    const tierInfo      = PRICE_TIERS.find(t => t.label === tier);
    tierGaps.push({
      tier,
      demand_pct:      Math.round(demandPct * 100),
      expected_count:  expectedCount,
      actual_count:    actualCount,
      gap,
      status:          gap > 0 ? 'undersupplied' : gap < -2 ? 'oversupplied' : 'balanced',
      description:     tierInfo?.description || tier,
    });
  }

  tierGaps.sort((a, b) => b.gap - a.gap); // biggest gap first

  // ── Growth trajectory ─────────────────────────────────────────────────────
  const growth = growthTrajectory({ ownerPct: ownerOccPct, schoolCount, medianHomeValue: medianHome, population });

  // ── Infrastructure momentum ───────────────────────────────────────────────
  const infraScore = bedrock?.infrastructure_momentum_score || 0;
  const activeRoad = bedrock?.inputs?.active_road_projects  || 0;
  const newConst   = bedrock?.inputs?.new_construction_count || 0;
  const floodPct   = bedrock?.inputs?.flood_zone_pct        || 0;

  // ── Top 3 pre-formed questions with answers ───────────────────────────────
  const questions = [];

  // Q1: Restaurant opportunity
  if (restaurantCount > 0) {
    const biggestGap = tierGaps[0];
    questions.push({
      question: `Is there room for another restaurant in ${name || zip}?`,
      answer: restaurantSaturation === 'oversaturated'
        ? `Probably not — ${restaurantCount} restaurants already serve ~${captureRate}% of the estimated daily meal demand for ${population.toLocaleString()} residents. The market looks saturated. If you open, differentiate hard.`
        : restaurantSaturation === 'room_for_niche'
        ? `Yes, but only for the right concept. The market is ${captureRate}% covered — room exists for a ${biggestGap.tier} option (${biggestGap.description}). There are ${biggestGap.actual_count} now vs. ${biggestGap.expected_count} expected at this income level.`
        : `Yes — ${name || zip} is undersupplied. ${restaurantCount} restaurants cover only ~${captureRate}% of daily meal demand. Biggest gap: ${biggestGap.tier} dining (${biggestGap.description}).`,
      signal_strength: restaurantSaturation === 'undersupplied' ? 'strong' : 'moderate',
      category: 'restaurant_gap',
    });
  }

  // Q2: Growth or decline
  questions.push({
    question: `Is ${name || zip} growing, stable, or becoming empty nest?`,
    answer: growth.state === 'growing'
      ? `Growing. ${ownerOccPct}% owner-occupied with ${schoolCount} school${schoolCount !== 1 ? 's' : ''} nearby signals active family formation. New businesses targeting families, children's services, and convenience will have a natural customer base being built for them.`
      : growth.state === 'transitioning'
      ? `Transitioning to empty nest. ${ownerOccPct}% owner-occupied but only ${schoolCount} school nearby, with median home value $${medianHome.toLocaleString()}. Residents are aging in place. Think healthcare, leisure, higher-end casual dining over family chains.`
      : growth.state === 'transient'
      ? `High renter turnover — ${100 - ownerOccPct}% renter-occupied. Customer acquisition cost is higher here; businesses that capture the local market fast win.`
      : `Stable established suburb. Predictable demand, lower risk, but also slower upside. Proven concepts outperform experimental ones here.`,
    signal_strength: growth.confidence,
    category: 'growth_trajectory',
  });

  // Q3: Where is construction happening / what can it support?
  if (infraScore > 0 || newConst > 0 || activeRoad > 0) {
    questions.push({
      question: `Where is building happening and what does that support?`,
      answer: `Infrastructure momentum score: ${infraScore}/100. ${newConst > 0 ? `${newConst} new construction permits. ` : ''}${activeRoad > 0 ? `${activeRoad} active road projects. ` : ''}${floodPct > 30 ? `${floodPct}% flood zone — limits buildable area. ` : ''}At median income $${medianHHI.toLocaleString()}, new households moving in can support ${demandDist.midrange > 0.4 ? 'midrange dining, boutique fitness, and professional services' : 'budget retail and convenience services'}.`,
      signal_strength: infraScore >= 50 ? 'strong' : 'moderate',
      category: 'infrastructure_demand',
    });
  } else {
    // Q3 fallback: caloric/category gap
    const caloricGap = tierGaps.find(t => t.gap > 0);
    questions.push({
      question: `What category is most missing in ${name || zip}?`,
      answer: caloricGap
        ? `${caloricGap.tier.charAt(0).toUpperCase() + caloricGap.tier.slice(1)} dining is the biggest gap — income distribution suggests ${caloricGap.demand_pct}% of meals should be in that tier, but only ${caloricGap.actual_count} of the expected ${caloricGap.expected_count} spots exist. ${caloricGap.description}.`
        : `The food category mix looks balanced for income level. Gaps exist in non-food: ${totalBiz < 50 ? 'professional services, healthcare, and retail are all thin' : 'niche specialty retail and experiential venues'}.`,
      signal_strength: 'moderate',
      category: 'category_gap',
    });
  }

  // ── Oracle narrative (one paragraph) ─────────────────────────────────────
  const dominantGap = tierGaps[0];
  const narrative = [
    `${name || zip} (pop. ${population.toLocaleString()}, median HHI $${medianHHI.toLocaleString()}) is ${growth.label.toLowerCase()}.`,
    restaurantCount > 0
      ? `With ${restaurantCount} food businesses serving an estimated ${totalMealsOutPerDay.toFixed(0)} meals/day demand, the market is ${restaurantSaturation.replace(/_/g,' ')} (${captureRate}% capture rate).`
      : `The food sector has minimal coverage — significant white space.`,
    dominantGap && dominantGap.gap > 0
      ? `Biggest price-tier gap: ${dominantGap.tier} dining — ${dominantGap.actual_count} exist vs. ${dominantGap.expected_count} expected at this income level.`
      : '',
    growth.state === 'growing'
      ? `Owner-occupied rate of ${ownerOccPct}% with ${schoolCount} school${schoolCount !== 1 ? 's' : ''} signals household formation — demand is being built.`
      : growth.state === 'transitioning'
      ? `Aging-in-place dynamics mean the customer profile is shifting toward healthcare and leisure over family services.`
      : '',
    infraScore >= 40
      ? `Infrastructure momentum of ${infraScore}/100 indicates active development — new rooftops coming.`
      : '',
  ].filter(Boolean).join(' ');

  // ── Assemble output ───────────────────────────────────────────────────────
  return {
    zip,
    name:    name || zip,
    computed_at: new Date().toISOString(),

    demographics: {
      population,
      median_household_income:  medianHHI,
      median_home_value:        medianHome,
      owner_occupied_pct:       ownerOccPct,
      total_households:         totalHH,
      consumer_profile:         isAffluent ? 'affluent_established' : 'mixed',
      // Extended Census signals
      wfh_pct:                  wfhPct,
      daytime_pop_multiplier:   daytimeMultiplier,
      daytime_demand_population: daytimeDemandPop,
      retiree_index:            retireeIndex,
      vacancy_rate_pct:         vacancyRatePct,
      family_hh_pct:            familyHHPct,
      affluence_pct:            affluencePct,
      ultra_affluence_pct:      ultraAffluencePct,
      renovation_wave:          renovationWave,
      housing_age_profile:      housingAgeProfile,
      new_build_pct:            newBuildPct,
    },

    restaurant_capacity: {
      restaurant_count:          restaurantCount,
      total_businesses:          totalBiz,
      estimated_daily_meal_demand: Math.round(totalMealsOutPerDay),
      market_capacity_meals_day:   marketCapacityMeals,
      capture_rate_pct:            captureRate,
      saturation_status:           restaurantSaturation,
      restaurants_market_can_support: restaurantsToSupport,
      gap_count:                   gapCount,
      tier_breakdown:              tierCounts,
      meals_out_per_person_per_day: mealsOutPerDay,
    },

    market_gaps: {
      price_tier_gaps: tierGaps,
      school_count:    schoolCount,
      top_gap:         dominantGap || null,
    },

    growth_trajectory: {
      ...growth,
      school_count:      schoolCount,
      owner_occupied_pct: ownerOccPct,
      infrastructure_momentum: infraScore,
      active_construction: newConst,
      active_road_projects: activeRoad,
      flood_zone_pct: floodPct,
    },

    top_questions: questions,
    oracle_narrative: narrative,

    vertical_gaps: verticalGaps,

    data_sources: {
      businesses_indexed:  totalBiz,
      has_spending_zone:   !!zone,
      has_bedrock:         !!bedrock,
      has_ocean_floor:     !!ocean,
      has_census_layer:    !!censusLayer,
      has_acs:             !!acs,
      has_zbp:             !!censusLayer?.zbp,
      has_cbp:             !!censusLayer?.cbp,
      vertical_gap_count:  verticalGaps.length,
    },

    // ── Census economic layer ───────────────────────────────────────────────
    // Economic fingerprint from ZBP/CBP + data confidence from PDB
    economic_layer: censusLayer ? {
      employment_density:    censusLayer.zbp?.employment_density    || 0,
      total_employees:       censusLayer.zbp?.total_employees       || 0,
      total_establishments:  censusLayer.zbp?.total_establishments  || 0,
      dominant_sector:       censusLayer.zbp?.dominant_sector       || null,
      sector_gaps:           (censusLayer.sector_gaps || []).slice(0, 5),
      data_confidence:       censusLayer.confidence || null,
      zbp_vintage:           censusLayer.zbp?.zbp_vintage           || null,
    } : null,
  };
}

// ── Run & schedule ─────────────────────────────────────────────────────────────

function ensureDirs() {
  [DATA_DIR, ORACLE_DIR, HISTORY_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
}

// ── Time-series append ────────────────────────────────────────────────────────
// Appends a trimmed snapshot to data/oracle/history/{zip}.json (array, newest last)
// Keeps MAX_HISTORY entries. Used to compute trend direction on next run.
function appendHistory(zip, result) {
  const file = path.join(HISTORY_DIR, `${zip}.json`);
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!Array.isArray(history)) history = [];

  // Snapshot — only what we need to detect trends (keep it small)
  const snap = {
    t:               result.computed_at,
    capture_rate:    result.restaurant_capacity.capture_rate_pct,
    saturation:      result.restaurant_capacity.saturation_status,
    restaurant_count: result.restaurant_capacity.restaurant_count,
    total_businesses: result.restaurant_capacity.total_businesses,
    growth_state:    result.growth_trajectory.state,
    infra_score:     result.growth_trajectory.infrastructure_momentum,
    top_gap:         result.market_gaps.top_gap?.tier || null,
    owner_occ_pct:   result.growth_trajectory.owner_occupied_pct,
    school_count:    result.market_gaps.school_count,
  };

  history.push(snap);
  if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
  atomicWrite(file, history);
}

// Compute trend direction comparing last two snapshots
// Returns { capture_rate: 'up'|'down'|'flat', growth_state: 'improving'|'declining'|'stable', cycles: N }
function computeTrend(zip) {
  const file = path.join(HISTORY_DIR, `${zip}.json`);
  let history = [];
  try { history = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  if (!Array.isArray(history) || history.length < 2) return { cycles: history.length, capture_rate: 'new', growth_state: 'new' };

  const prev = history[history.length - 2];
  const curr = history[history.length - 1];
  const delta = curr.capture_rate - prev.capture_rate;

  // Consecutive saturation status — how many cycles in current state
  const currentStatus = curr.saturation;
  let streak = 1;
  for (let i = history.length - 2; i >= 0; i--) {
    if (history[i].saturation === currentStatus) streak++;
    else break;
  }

  return {
    cycles:          history.length,
    capture_rate:    delta > 1 ? 'up' : delta < -1 ? 'down' : 'flat',
    capture_delta:   parseFloat(delta.toFixed(2)),
    growth_state:    curr.growth_state === prev.growth_state ? 'stable' : 'shifted',
    saturation_streak: streak,  // how many consecutive cycles in same saturation state
    biz_delta:       curr.total_businesses - prev.total_businesses,
    restaurant_delta: curr.restaurant_count - prev.restaurant_count,
    infra_delta:     curr.infra_score - prev.infra_score,
  };
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

async function runOracle() {
  ensureDirs();
  console.log('[oracleWorker] Starting oracle computation...');

  // Discover all ZIPs from business data
  const zones = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'spendingZones.json'), 'utf8')); } catch { return {}; }
  })();
  const zoneZips = Object.keys(zones?.zones || {});

  // Also discover from zips/ directory — include all ZIPs with sufficient business data
  const zipDir = path.join(DATA_DIR, 'zips');
  const fileZips = fs.existsSync(zipDir)
    ? fs.readdirSync(zipDir)
        .filter(f => f.endsWith('.json') && /^\d{5}\.json$/.test(f))
        .map(f => f.replace('.json', ''))
    : [];

  // Merge: zone-backed ZIPs + file ZIPs with >=10 businesses (enough for meaningful signals)
  // flZipRegistry fallback handles demographics for file ZIPs without zone data
  const registry = getFlRegistry();
  const qualifiedFileZips = fileZips.filter(zip => {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(zipDir, `${zip}.json`), 'utf8'));
      const count = Array.isArray(d) ? d.length : (d?.businesses?.length || 0);
      // Must have >=10 businesses AND either zone data OR a registry entry with population
      return count >= 10 && (zoneZips.includes(zip) || (registry[zip]?.population || 0) > 0);
    } catch { return false; }
  });

  const allZips = [...new Set([...zoneZips, ...qualifiedFileZips])];

  // Top 30 known ZIPs — always included even if file data is still building
  const KNOWN_ZIPS = [
    { zip: '32082', name: 'Ponte Vedra Beach' },
    { zip: '32250', name: 'Jacksonville Beach' },
    { zip: '32084', name: 'St. Augustine' },
    { zip: '32086', name: 'St. Augustine South' },
    { zip: '32081', name: 'Nocatee' },
    { zip: '32246', name: 'Jacksonville East' },
    { zip: '32224', name: 'Jacksonville SE' },
    { zip: '32233', name: 'Atlantic Beach' },
    { zip: '32080', name: 'St. Augustine Beach' },
    { zip: '32092', name: 'World Golf Village' },
    { zip: '32256', name: 'Jacksonville SW' },
    { zip: '32225', name: 'Jacksonville NE' },
    { zip: '32216', name: 'Jacksonville Southside' },
    { zip: '32266', name: 'Neptune Beach' },
    { zip: '32177', name: 'Palatka' },
    { zip: '32257', name: 'Jacksonville S' },
    { zip: '32211', name: 'Arlington' },
    { zip: '32258', name: 'Mandarin South' },
    { zip: '32217', name: 'San Jose' },
    { zip: '32207', name: 'San Marco' },
    { zip: '32259', name: 'Switzerland' },
    { zip: '32131', name: 'East Palatka' },
    { zip: '32095', name: 'Palm Valley' },
    { zip: '32223', name: 'Mandarin' },
    { zip: '32033', name: 'Elkton' },
    { zip: '32073', name: 'Orange Park' },
    { zip: '32277', name: 'Jacksonville N' },
    { zip: '32065', name: 'Orange Park West' },
    { zip: '32043', name: 'Green Cove Springs' },
    { zip: '32068', name: 'Middleburg' },
  ];
  for (const k of KNOWN_ZIPS) {
    if (!allZips.includes(k.zip)) allZips.push(k.zip);
  }

  const nameMap = Object.fromEntries(KNOWN_ZIPS.map(z => [z.zip, z.name]));

  const index = { generated_at: new Date().toISOString(), zips: {} };

  for (const zip of allZips) {
    try {
      const result = computeOracle(zip, nameMap[zip]);

      // Skip ZIPs that failed the data quality gate
      if (result.skip) {
        console.log(`[oracleWorker] SKIP ${zip}: ${result.reason} (${result.businesses} businesses, no demo data)`);
        continue;
      }

      // Append to time-series BEFORE writing current (so computeTrend reads previous run)
      const trend = computeTrend(zip);
      appendHistory(zip, result);

      // Attach trend to the result file so API callers get it inline
      result.trend = trend;

      atomicWrite(path.join(ORACLE_DIR, `${zip}.json`), result);
      // Persist to Postgres — survives Railway deploys
      upsertZipIntelligence(zip, result).catch(() => {});
      index.zips[zip] = {
        name:               result.name,
        saturation_status:  result.restaurant_capacity.saturation_status,
        capture_rate_pct:   result.restaurant_capacity.capture_rate_pct,
        growth_state:       result.growth_trajectory.state,
        consumer_profile:   result.demographics.consumer_profile,
        top_gap:            result.market_gaps.top_gap?.tier || null,
        computed_at:        result.computed_at,
        // trend summary in index for signal layer to use without extra fetch
        trend_capture:      trend?.capture_rate || 'new',
        trend_streak:       trend?.saturation_streak || 1,
        trend_biz_delta:    trend?.biz_delta || 0,
        trend_cycles:       trend?.cycles || 1,
      };
      console.log(`[oracleWorker] ${zip} (${result.name}): ${result.restaurant_capacity.saturation_status}, ${result.growth_trajectory.state}, gap: ${result.market_gaps.top_gap?.tier || 'none'}, trend: ${trend?.capture_rate || 'new'} (${trend?.saturation_streak || 1} cycles)`);
    } catch (err) {
      console.error(`[oracleWorker] Error on ${zip}:`, err.message);
    }
  }

  atomicWrite(INDEX_FILE, index);
  console.log(`[oracleWorker] Done — ${allZips.length} ZIPs computed.`);
}

// Run immediately, then every 6 hours
runOracle().catch(err => console.error('[oracleWorker] Fatal:', err.message));
setInterval(() => runOracle().catch(err => console.error('[oracleWorker] Scheduled error:', err.message)), 6 * 60 * 60 * 1000);

process.on('uncaughtException',  err => console.error('[oracleWorker] Uncaught:', err.message));
process.on('unhandledRejection', r   => console.error('[oracleWorker] Rejection:', r));
