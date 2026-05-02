'use strict';
/**
 * promptEvolutionWorker.js
 * ─────────────────────────────────────────────────────────────────────────────
 * The inference engine's self-improvement loop.
 *
 * What it does (daily):
 *   1. AUDIT     — reads all oracle history files, classifies each ZIP by
 *                  signal quality: RICH | THIN | BLIND | CONTRADICTED
 *   2. DIAGNOSE  — for each gap type, identifies WHICH data layer is missing
 *                  (no demo data, no bedrock, low business count, stale data)
 *   3. DISPATCH  — calls gapDataFetcher.js to go fill the missing layer from
 *                  public sources (Census ACS, county appraiser, school
 *                  enrollment, chamber directories, library card data)
 *   4. EVOLVE    — rewrites oracle_prompts_v2.json: increases question weight
 *                  on contradicted/thin signals, adds gap-targeted prompts,
 *                  retires prompts that return null every cycle
 *   5. REPORT    — writes data/evolution/_report.json for dashboard visibility
 *
 * The machine writes its own questions. We fill our own holes.
 *
 * Schedule: daily at 2am (runs immediately on start, then 24h interval)
 */

const http = require('http');
const pgStore = require('../lib/pgStore');

// ── ZIP registry (all known ZIPs across the platform) ─────────────────────────
// SJC_FALLBACK — used only when Postgres is unavailable (local dev)
const SJC_FALLBACK_ZIPS = [
  { zip: '32081', name: 'Nocatee',                  county: 'St. Johns' },
  { zip: '32082', name: 'Ponte Vedra Beach',         county: 'St. Johns' },
  { zip: '32092', name: 'World Golf Village',        county: 'St. Johns' },
  { zip: '32084', name: 'St. Augustine',             county: 'St. Johns' },
  { zip: '32086', name: 'St. Augustine South',       county: 'St. Johns' },
  { zip: '32095', name: 'Palm Valley',               county: 'St. Johns' },
  { zip: '32080', name: 'St. Augustine Beach',       county: 'St. Johns' },
  { zip: '32259', name: 'Fruit Cove / Saint Johns',  county: 'St. Johns' },
  { zip: '32250', name: 'Jacksonville Beach',        county: 'Duval'     },
  { zip: '32266', name: 'Neptune Beach',             county: 'Duval'     },
  { zip: '32258', name: 'Bartram Park',              county: 'Duval'     },
  { zip: '32073', name: 'Orange Park',               county: 'Clay'      },
];

// getAuditZips — Postgres first, fallback to SJC_FALLBACK_ZIPS
// Returns [{zip, name, county}] for every ZIP that has business data
async function getAuditZips() {
  if (process.env.LOCAL_INTEL_DB_URL) {
    try {
      const { getDistinctZips } = require('../lib/pgStore');
      const db2 = require('../lib/db');
      const pgZips = await getDistinctZips();
      if (pgZips.length > 0) {
        // Enrich with name/county from zip_intelligence where available
        const metaRows = await db2.query(
          'SELECT zip, name FROM zip_intelligence WHERE zip = ANY($1)', [pgZips]
        ).catch(() => []);
        const metaIndex = Object.fromEntries(metaRows.map(r => [r.zip, r.name]));
        // Also pull from SJC_FALLBACK for known names
        const sjcIndex  = Object.fromEntries(SJC_FALLBACK_ZIPS.map(z => [z.zip, z]));
        const result = pgZips.map(zip => ({
          zip,
          name:   metaIndex[zip] || sjcIndex[zip]?.name   || zip,
          county: sjcIndex[zip]?.county || 'Unknown',
        }));
        console.log(`[promptEvolution] Audit scope: ${result.length} ZIPs from Postgres`);
        return result;
      }
    } catch (e) {
      console.warn('[promptEvolution] Postgres ZIP discovery failed, using fallback:', e.message);
    }
  }
  return SJC_FALLBACK_ZIPS;
}

// ── Signal quality thresholds ──────────────────────────────────────────────────
const RICH_CYCLES        = 10;   // 10+ cycles with demo data = RICH
const THIN_CYCLES        = 3;    // 3-9 cycles = THIN
const CONTRADICTION_DELTA = 20;  // capture_rate swings >20% across cycles = CONTRADICTED

// ── Prompt weight config ───────────────────────────────────────────────────────
// How many prompts per vertical per quality tier
const PROMPT_TARGETS = {
  RICH:         20,   // well-covered ZIPs: 20 questions each
  THIN:         10,   // thin coverage: 10 targeted questions
  BLIND:         5,   // no history yet: 5 bootstrap questions
  CONTRADICTED: 15,   // contradicted signals: 15 contradiction-resolving questions
};

// ── Utilities ──────────────────────────────────────────────────────────────────


// ── Step 1: AUDIT — classify every known ZIP by signal quality ─────────────────

async function auditZips() {
  const audit = {};
  const auditList = await getAuditZips();

  for (const { zip, name, county } of auditList) {
    // Oracle row from Postgres — history is no longer per-ZIP file, just empty
    let oracle = null;
    try {
      oracle = await pgStore.getZipIntelligenceRow(zip);
    } catch (_) {}
    const history = []; // history table not yet ported; treat as empty (worst case: BLIND)

    // Data layer availability
    const hasDemoData  = oracle?.data_sources?.has_spending_zone || oracle?.data_sources?.has_ocean_floor || false;
    const hasBedrock   = oracle?.data_sources?.has_bedrock       || false;
    const bizCount     = oracle?.restaurant_capacity?.total_businesses || 0;
    const population   = oracle?.demographics?.population        || 0;

    // Signal quality classification
    let quality;
    let contradicted = false;

    if (history.length === 0) {
      quality = 'BLIND';
    } else {
      // Check for contradiction: capture rate swings >CONTRADICTION_DELTA across cycles
      const rates = history.map(h => h.capture_rate).filter(r => typeof r === 'number');
      if (rates.length >= 3) {
        const min = Math.min(...rates);
        const max = Math.max(...rates);
        if (max - min > CONTRADICTION_DELTA) contradicted = true;
      }
      quality = contradicted ? 'CONTRADICTED'
        : history.length >= RICH_CYCLES  ? 'RICH'
        : history.length >= THIN_CYCLES  ? 'THIN'
        : 'BLIND';
    }

    // Gap diagnosis: what data is missing?
    const gaps = [];
    if (!hasDemoData)        gaps.push('no_demographics');
    if (!hasBedrock)         gaps.push('no_infrastructure');
    if (bizCount < 20)       gaps.push('thin_business_index');
    if (population === 0)    gaps.push('no_population');
    if (history.length === 0) gaps.push('never_computed');

    // Trend: is the signal improving or decaying?
    let trend = 'unknown';
    if (history.length >= 2) {
      const recent     = history.slice(-3).map(h => h.capture_rate).filter(r => typeof r === 'number');
      const older      = history.slice(0, 3).map(h => h.capture_rate).filter(r => typeof r === 'number');
      const recentAvg  = recent.reduce((a, b) => a + b, 0) / (recent.length || 1);
      const olderAvg   = older.reduce((a, b) => a + b, 0)  / (older.length  || 1);
      trend = recentAvg > olderAvg + 2 ? 'improving'
            : recentAvg < olderAvg - 2 ? 'declining'
            : 'stable';
    }

    // Saturation streak — is the ZIP locked in one state too long?
    const lastSaturation = history.length > 0 ? history[history.length - 1]?.saturation : null;
    let saturationStreak = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].saturation === lastSaturation) saturationStreak++;
      else break;
    }

    audit[zip] = {
      zip, name, county,
      quality,
      gaps,
      contradicted,
      trend,
      cycles:           history.length,
      population,
      biz_count:        bizCount,
      has_demo_data:    hasDemoData,
      has_bedrock:      hasBedrock,
      saturation:       lastSaturation,
      saturation_streak: saturationStreak,
      last_capture_rate: history.length > 0 ? history[history.length - 1]?.capture_rate : null,
    };
  }

  console.log(`[promptEvolution] AUDIT — ${Object.keys(audit).length} ZIPs classified`);
  const counts = { RICH: 0, THIN: 0, BLIND: 0, CONTRADICTED: 0 };
  Object.values(audit).forEach(a => counts[a.quality]++);
  console.log('[promptEvolution] Quality breakdown:', counts);
  return audit;
}

// ── Step 2: DIAGNOSE — identify which public sources can fill each gap ─────────

const GAP_SOURCES = {
  no_demographics:     ['census_acs', 'county_appraiser', 'school_enrollment', 'library_data'],
  no_population:       ['census_acs', 'county_appraiser'],
  no_infrastructure:   ['county_permits', 'fdot_projects', 'fl_dept_education'],
  thin_business_index: ['chamber_directory', 'yellowpages', 'bbb_directory'],
  never_computed:      ['census_acs', 'chamber_directory'],
};

function diagnosGaps(audit) {
  const dispatchQueue = [];

  for (const [zip, data] of Object.entries(audit)) {
    for (const gap of data.gaps) {
      const sources = GAP_SOURCES[gap] || [];
      for (const source of sources) {
        // Don't queue duplicates for the same zip+source
        const alreadyQueued = dispatchQueue.some(d => d.zip === zip && d.source === source);
        if (!alreadyQueued) {
          dispatchQueue.push({
            zip,
            name:     data.name,
            county:   data.county,
            gap,
            source,
            priority: data.quality === 'BLIND' ? 'high'
                     : data.quality === 'CONTRADICTED' ? 'high'
                     : 'normal',
          });
        }
      }
    }
  }

  dispatchQueue.sort((a, b) => (a.priority === 'high' ? 0 : 1) - (b.priority === 'high' ? 0 : 1));
  console.log(`[promptEvolution] DIAGNOSE — ${dispatchQueue.length} gap fills queued`);
  return dispatchQueue;
}

// ── Step 3: DISPATCH — call gapDataFetcher for each gap ───────────────────────

async function dispatchGapFetches(dispatchQueue) {
  const results = { dispatched: 0, filled: 0, failed: 0, sources: {} };
  const { fetchGap } = require('./gapDataFetcher');

  // Process in batches of 3 (public rate limits)
  const BATCH = 3;
  for (let i = 0; i < dispatchQueue.length; i += BATCH) {
    const batch = dispatchQueue.slice(i, i + BATCH);
    await Promise.allSettled(batch.map(async task => {
      results.dispatched++;
      results.sources[task.source] = (results.sources[task.source] || 0) + 1;
      try {
        const filled = await fetchGap(task);
        if (filled) {
          results.filled++;
          console.log(`[promptEvolution] FILLED ${task.zip} gap=${task.gap} source=${task.source}`);
        }
      } catch (err) {
        results.failed++;
        console.warn(`[promptEvolution] FAILED ${task.zip} gap=${task.gap} source=${task.source}: ${err.message}`);
      }
    }));
    // Small delay between batches — respectful of public sources
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log(`[promptEvolution] DISPATCH — ${results.filled}/${results.dispatched} gaps filled`);
  return results;
}

// ── Step 4: EVOLVE — rewrite oracle_prompts_v2.json targeting real gaps ────────

// Prompt template library — keyed by gap type and vertical
// These are injected for ZIPs where specific data is missing or contradicted
const TARGETED_PROMPTS = {
  // Demographic gap prompts — what can we infer without Census data?
  no_demographics: {
    restaurant: [
      'Based solely on the businesses indexed in {zip}, what income tier do the food options suggest this neighborhood is targeting?',
      'If I had to guess the median household income of {name} from the restaurant mix alone — fast food vs sit-down vs fine dining — what would that number be?',
      'What does the ratio of chain restaurants to independents in {zip} tell us about whether this is a captured market or an opportunity zone?',
    ],
    retail: [
      'What types of retail are conspicuously absent from {zip} given the businesses we do have indexed?',
      'Is {name} a destination ZIP or a pass-through ZIP based on the business categories present?',
    ],
    healthcare: [
      'Based on what businesses exist in {zip}, what is the likely age profile of the resident base?',
      'Are the healthcare providers in {name} serving the existing population or are they drawing patients from neighboring ZIPs?',
    ],
    construction: [
      'What does the ratio of contractors to finished-product businesses in {zip} tell us about development stage — early build-out or mature infill?',
      'Are the construction businesses in {name} local firms or branch offices of regional players?',
    ],
    realtor: [
      'Without population data, what does the business density of {zip} suggest about how many rooftops are actually occupied?',
      'Is {name} a primary residence ZIP or a second-home / seasonal market based on the service business mix?',
    ],
  },

  // Contradiction prompts — capture rate is swinging, why?
  contradicted: {
    restaurant: [
      'The restaurant capture rate for {zip} has been inconsistent across oracle cycles — is the underlying population estimate wrong, or is the restaurant count actually volatile?',
      'Which restaurants in {name} opened or closed in the last 12 months — and does turnover explain the signal instability?',
      'If {zip} shows both undersupply and oversupply in different cycles, is this a seasonality effect or a data collection artifact?',
    ],
    retail: [
      'Retail signals for {zip} have contradicted themselves — are we indexing seasonal businesses that inflate counts in some cycles?',
    ],
    healthcare: [
      'If {name} shows contradictory healthcare saturation signals, are we counting urgent care chains differently across cycles?',
    ],
    construction: [
      'Construction permit data for {zip} is volatile — is this project completion cycles or actual stop-and-go development?',
    ],
    realtor: [
      'If {name} swings between growing and transitioning across cycles, what seasonal or life-event pattern could explain it?',
    ],
  },

  // Thin business index — need more data before signals are meaningful
  thin_business_index: {
    restaurant: [
      'With fewer than 20 indexed businesses in {zip}, which single restaurant opening would have the highest impact on the market?',
      'Is {name} genuinely sparse or are we under-indexed — what categories should we check for missing entries?',
    ],
    retail: [
      'A ZIP with thin business coverage like {zip} — is this a greenfield opportunity or a market that has already been tried and failed?',
    ],
    healthcare: [
      'In a thin-indexed ZIP like {name}, are the healthcare providers that exist there independent or part of a health system that knows something the market does not?',
    ],
    construction: [
      'With few businesses in {zip}, is the construction presence there building the first wave of an emerging market or maintaining existing infrastructure?',
    ],
    realtor: [
      'What is the realistic addressable housing market in {zip} if we only have {biz_count} businesses indexed — is this a small ZIP or a coverage gap?',
    ],
  },

  // Infrastructure gap — no bedrock data yet
  no_infrastructure: {
    restaurant: [
      'Without infrastructure data for {zip}, what does the presence or absence of national chains tell us about whether the roads and traffic are in place?',
      'National chains do their own site selection research — what does their presence or absence in {name} signal about the underlying infrastructure?',
    ],
    construction: [
      'What permits would be public record at {county} County that could tell us about active development in {zip}?',
      'Are there utility extension projects in {name} that would signal incoming rooftops before the construction actually starts?',
    ],
    realtor: [
      'In {zip}, without road/infrastructure data, what business categories serve as leading indicators of residential growth — storage facilities, schools, pediatricians?',
    ],
    retail: [
      'What retail categories enter a market first — dollar stores, gas stations, QSRs — and are those present in {zip} yet?',
    ],
    healthcare: [
      'In {name}, are the healthcare businesses clustered near known road corridors or scattered — and what does that tell us about whether infrastructure is mature?',
    ],
  },
};

// Core 20 prompts per vertical that run on all ZIPs regardless of quality
const EVERGREEN_PROMPTS = {
  restaurant: [
    'Is {zip} oversaturated with casual dining restaurants?',
    'What cuisine types are missing from the {name} restaurant market?',
    'I\'m thinking about opening a ramen shop in {name} — is there any demand for Japanese noodle concepts in {zip} and how many direct competitors are already there?',
    'How many restaurants in {zip} have been there longer than 5 years versus newcomers?',
    'What is the realistic capture rate for a new upscale casual restaurant opening in {name} today?',
    'Are food trucks or ghost kitchens filling gaps in {zip} that brick-and-mortar hasn\'t addressed yet?',
    'Which restaurant category in {name} has the highest churn — fast food, midrange, or fine dining?',
    'Is there a breakfast-specific gap in {zip}?',
    'What does the ratio of alcohol-serving establishments to non-alcohol tell us about the nightlife index of {name}?',
    'Would a Mediterranean concept work in {zip} or is the income profile better suited to something else?',
    'How does the restaurant density of {zip} compare to adjacent ZIPs?',
    'What income-tier restaurant is most likely to succeed as the first mover in {name}?',
    'Are there any micro-neighborhoods within {zip} that appear significantly more restaurant-dense than others?',
    'What does the school count in {name} tell us about family dining demand?',
    'Is {zip} a lunch market, a dinner market, or both?',
    'How seasonal is the restaurant demand in {name} and what should an operator plan for?',
    'What is the highest-margin restaurant format that would work in {zip} today?',
    'Are there healthcare workers in {name} who need fast, quality lunch options near their facilities?',
    'If {zip} is primarily owner-occupied, what does that suggest about predictability of dining demand?',
    'What would need to change in {name} for a fine dining establishment to succeed?',
  ],
  retail: [
    'What retail categories are completely absent from {zip}?',
    'Is {name} a destination retail market or a convenience retail market?',
    'What is the closest big-box retail to {zip} and does its proximity suppress or stimulate local retail?',
    'Are there any artisan or boutique retail gaps in {name} at the current income level?',
    'What does the owner-occupancy rate of {zip} tell us about retail loyalty versus transient spending?',
    'Is there a fitness and wellness gap in {name}?',
    'What is the pet services opportunity in {zip} based on the demographic profile?',
    'Are there children\'s services gaps in {name} relative to the school-age population?',
    'What retail category in {zip} would benefit most from the construction worker population during build-out phase?',
    'Is {name} ready for a specialty grocery concept or is it still a commodity grocery market?',
    'What retail businesses in {zip} appear to be serving adjacent ZIPs rather than the local population?',
    'Is there an outdoor recreation retail opportunity in {name} based on local geography?',
    'What convenience categories in {zip} are currently only served by gas stations?',
    'Are there enough households in {name} to support a hardware or home improvement local retailer?',
    'What does the income distribution of {zip} suggest about price sensitivity in retail?',
    'Is {name} underserved for back-to-school retail given the school count?',
    'What service retail is missing from {zip} that adjacent higher-income ZIPs have?',
    'Are there enough restaurants in {name} to support a restaurant supply or specialty food wholesale concept?',
    'What does the renter percentage of {zip} suggest about furniture and home goods demand?',
    'Is {name} in a stage where national retail chains would consider entering?',
  ],
  healthcare: [
    'What healthcare specialties are missing from {zip}?',
    'Is {name} underserved for mental health providers relative to population?',
    'What is the ratio of primary care to specialty care providers in {zip}?',
    'Are pediatric services adequately covering the school-age population in {name}?',
    'Is {zip} an aging-in-place market that needs more geriatric care options?',
    'What dental care gaps exist in {name} at the current income level?',
    'Is there a physical therapy and rehabilitation gap in {zip}?',
    'Are there enough urgent care facilities in {name} to absorb ER overflow?',
    'What does the income level of {zip} suggest about elective procedure demand?',
    'Is {name} underserved for women\'s health relative to the demographic profile?',
    'What mental health and addiction recovery services are missing from {zip}?',
    'Is there a veterinary care gap in {name} relative to estimated pet ownership?',
    'What does the construction worker population in {zip} suggest about occupational health demand?',
    'Are there enough optometry and vision care providers in {name}?',
    'What alternative medicine categories — chiropractic, acupuncture, functional medicine — are underrepresented in {zip}?',
    'Is {name} a market for a standalone imaging or diagnostics center?',
    'What is the realistic patient draw radius for a new specialist opening in {zip}?',
    'Are the healthcare providers in {name} clustered or distributed, and what does that tell us about access gaps?',
    'Is there an opportunity for a concierge or direct primary care model in {zip} at current income levels?',
    'What healthcare business in {name} appears to be missing most given the age profile of residents?',
  ],
  construction: [
    'What construction trades are underrepresented in {zip} relative to active permits?',
    'Is {name} in early-phase development, mid-build, or infill/renovation stage?',
    'What does the ratio of residential to commercial contractors in {zip} tell us about the development mix?',
    'Are there enough electricians and plumbers in {name} to service new construction demand?',
    'What specialty trades are missing from {zip} that large GCs would need to import from outside?',
    'Is {name} experiencing enough construction activity to support a local building materials supplier?',
    'What does the presence of national homebuilders in {zip} versus local custom builders tell us?',
    'Are there landscaping and hardscaping businesses in {name} appropriate for the home value level?',
    'What is the ratio of construction businesses to active permits in {zip} — is there capacity?',
    'Is there a pool and outdoor living construction gap in {name} given median home values?',
    'What roofing and exterior service capacity exists in {zip} after storm season?',
    'Are HVAC and mechanical contractors keeping pace with new construction in {name}?',
    'What does the mix of commercial versus residential construction in {zip} suggest about near-term office or retail development?',
    'Is {name} positioned for a luxury renovation wave as the original construction ages?',
    'Are there engineering and architectural firms in {zip} or are those being imported from Jacksonville?',
    'What infrastructure construction — utilities, roads, drainage — is active in {name}?',
    'Is there an opportunity for a construction staffing or labor supply business in {zip}?',
    'What does the average age of construction businesses in {name} tell us about succession risk in the trade?',
    'Are there enough property management businesses in {zip} to handle the rental housing stock?',
    'What does the flood zone percentage of {name} tell us about the long-term construction opportunity horizon?',
  ],
  realtor: [
    'Is {zip} a buyer\'s or seller\'s market right now?',
    'What is the realistic price-per-square-foot range for new construction in {name}?',
    'What percentage of {zip} residents are likely to move within the next 3 years based on the demographic profile?',
    'Is {name} a move-up market, a move-down market, or a first-time buyer market?',
    'What does the school quality in {zip} do to home values relative to adjacent ZIPs?',
    'Are there enough property management companies in {name} to service the rental stock?',
    'What is the investor interest level in {zip} based on the renter-to-owner ratio?',
    'Is {name} seeing more new construction or resale activity?',
    'What lifestyle amenities in {zip} are missing that would improve residential demand?',
    'Are there enough real estate attorneys and title companies in {name} to handle transaction volume?',
    'What does the infrastructure momentum score of {zip} suggest about price appreciation trajectory?',
    'Is {name} likely to see downsizing activity as the population ages?',
    'What is the vacation rental potential of {zip} given proximity to beaches or amenities?',
    'Is there a gap in senior housing or active adult communities in {name}?',
    'What does the median home value of {zip} suggest about which price tier of new construction would succeed?',
    'Are commercial real estate opportunities available in {name} or is it primarily residential?',
    'What does the renter concentration of {zip} say about the opportunity for build-to-rent development?',
    'Is {name} attracting remote workers and if so what residential features matter most to them?',
    'What is the realistic absorption rate for new residential units in {zip}?',
    'Is {name} underbuilt or overbuilt relative to population growth trajectory?',
  ],
};

function evolvePrompts(audit) {
  const verticals = ['restaurant', 'retail', 'healthcare', 'construction', 'realtor'];
  const evolved   = {};

  for (const vertical of verticals) {
    const prompts = new Set();

    // Always include evergreen prompts (expanded with ZIP context)
    for (const p of (EVERGREEN_PROMPTS[vertical] || [])) {
      prompts.add(p);
    }

    // Add gap-targeted prompts for ZIPs with known issues
    for (const [zip, data] of Object.entries(audit)) {
      const { name, biz_count, county } = data;

      // Contradiction prompts
      if (data.contradicted && TARGETED_PROMPTS.contradicted?.[vertical]) {
        for (const p of TARGETED_PROMPTS.contradicted[vertical]) {
          prompts.add(p.replace(/\{zip\}/g, zip).replace(/\{name\}/g, name).replace(/\{county\}/g, county));
        }
      }

      // Gap prompts — add 1-2 per gap type per vertical per ZIP
      for (const gap of data.gaps) {
        const gapPrompts = TARGETED_PROMPTS[gap]?.[vertical] || [];
        for (const p of gapPrompts.slice(0, 2)) {
          prompts.add(
            p.replace(/\{zip\}/g, zip)
             .replace(/\{name\}/g, name)
             .replace(/\{county\}/g, county)
             .replace(/\{biz_count\}/g, biz_count || 0)
          );
        }
      }

      // Thin ZIPs get bootstrap questions — prioritize filling the unknown
      if (data.quality === 'BLIND' || data.quality === 'THIN') {
        prompts.add(`What is the single most important piece of information missing from the ${name} (${zip}) market picture?`);
        prompts.add(`If ${name} only has ${biz_count || 'few'} businesses indexed, what categories should we verify are actually absent versus just uncollected?`);
      }

      // Improving ZIPs get forward-looking prompts
      if (data.trend === 'improving') {
        prompts.add(`${name} (${zip}) is showing improving signals — what is the next category to enter as this market matures?`);
      }

      // Long saturation streaks get stress-test prompts
      if (data.saturation_streak >= 5 && data.saturation) {
        const state = data.saturation.replace(/_/g, ' ');
        prompts.add(`${name} has been consistently "${state}" for ${data.saturation_streak} oracle cycles — is this signal reliable or a measurement artifact?`);
      }
    }

    evolved[vertical] = [...prompts];
    console.log(`[promptEvolution] ${vertical}: ${evolved[vertical].length} prompts (was ${(readJson(PROMPTS_FILE)||{})[vertical]?.length || 0})`);
  }

  return evolved;
}

// ── Step 5: REPORT — write visibility artifact for dashboard ───────────────────

async function writeReport(audit, dispatchResults, promptCounts, startedAt) {
  const qualityCounts = { RICH: 0, THIN: 0, BLIND: 0, CONTRADICTED: 0 };
  const gapCounts     = {};
  const trending      = { improving: [], declining: [], stable: [] };

  for (const data of Object.values(audit)) {
    qualityCounts[data.quality]++;
    for (const gap of data.gaps) gapCounts[gap] = (gapCounts[gap] || 0) + 1;
    if (trending[data.trend]) trending[data.trend].push(data.zip);
  }

  const report = {
    generated_at:    new Date().toISOString(),
    started_at:      startedAt,
    duration_ms:     Date.now() - new Date(startedAt).getTime(),
    zips_audited:    Object.keys(audit).length,
    signal_quality:  qualityCounts,
    gap_summary:     gapCounts,
    trending,
    dispatch_results: dispatchResults,
    prompt_counts:   promptCounts,
    // Top priority ZIPs — BLIND or CONTRADICTED with high business count
    priority_zips:   Object.values(audit)
      .filter(a => (a.quality === 'BLIND' || a.quality === 'CONTRADICTED') && a.biz_count > 10)
      .sort((a, b) => b.biz_count - a.biz_count)
      .slice(0, 10)
      .map(a => ({ zip: a.zip, name: a.name, quality: a.quality, biz_count: a.biz_count, gaps: a.gaps })),
  };

  await pgStore.upsertEvolutionReport({ ...report, audit });
  console.log('[promptEvolution] REPORT written to evolution_report');
  return report;
}

// ── Main evolution loop ────────────────────────────────────────────────────────

async function runEvolution() {
  const startedAt = new Date().toISOString();
  console.log('[promptEvolution] Starting evolution cycle...');

  // Step 1: Audit
  const audit = await auditZips();

  // Step 2: Diagnose gaps
  const dispatchQueue = diagnosGaps(audit);

  // Step 3: Dispatch gap fetches (catches its own errors)
  let dispatchResults = { dispatched: 0, filled: 0, failed: 0, sources: {} };
  try {
    dispatchResults = await dispatchGapFetches(dispatchQueue);
  } catch (err) {
    console.warn('[promptEvolution] Gap dispatch error (non-fatal):', err.message);
  }

  // Step 4: Evolve prompts (in-memory only — persisted into evolution_report)
  const evolved = evolvePrompts(audit);

  // Step 5: Report
  const promptCounts = Object.fromEntries(Object.entries(evolved).map(([k, v]) => [k, v.length]));
  const report = await writeReport(audit, dispatchResults, promptCounts, startedAt);

  const totalPrompts = Object.values(evolved).reduce((a, b) => a + b.length, 0);
  console.log(`[promptEvolution] Done. ${totalPrompts} total prompts. ${report.signal_quality.RICH} RICH / ${report.signal_quality.BLIND} BLIND ZIPs.`);
  return report;
}

// ── Schedule: immediate + daily at 2am ───────────────────────────────────────

function msUntil2am() {
  const now   = new Date();
  const next  = new Date(now);
  next.setHours(2, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// Run immediately on start, then daily at 2am
runEvolution().catch(err => console.error('[promptEvolution] Fatal on startup:', err.message));

setTimeout(function scheduleDaily() {
  runEvolution().catch(err => console.error('[promptEvolution] Fatal on scheduled run:', err.message));
  setTimeout(scheduleDaily, 24 * 60 * 60 * 1000);
}, msUntil2am());

console.log(`[promptEvolution] Worker started. Next scheduled run at 2am (in ${Math.round(msUntil2am()/1000/60)} min).`);

process.on('uncaughtException',  err => console.error('[promptEvolution] Uncaught:', err.message));
process.on('unhandledRejection', r   => console.error('[promptEvolution] Rejection:', r));

// Export for manual trigger via /api/evolution/run
module.exports = { runEvolution };
