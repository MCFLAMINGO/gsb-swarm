'use strict';
/**
 * conceptProfiles.js — B62
 * Concept-specific weighted scoring profiles for the unified site intelligence engine.
 * Each profile lists factors with weights + normalization fn (interpreted by scoringEngine.js).
 * Sources are cited per factor for transparent factor_breakdown output.
 */

const CONCEPT_PROFILES = {

  QSR_DRIVE_BY: {
    name: 'QSR / Drive-By Fast Food',
    hardFloors: ['min_aadt_5000', 'no_residential'],
    factors: [
      { key: 'aadt',         weight: 0.30, normFn: 'sigmoid',  normParams: { midpoint: 25000, steepness: 0.0001 }, label: 'Traffic Volume (AADT)', source: "McDonald's FDD + ICSC site selection research" },
      { key: 'daytime_pop',  weight: 0.25, normFn: 'minmax',   normParams: {}, label: 'Daytime Population', source: 'LODES WAC + ACS population' },
      { key: 'hhi',          weight: 0.20, normFn: 'gaussian', normParams: { peak: 65000, sigma: 25000 }, label: 'Household Income Sweet Spot ($65k)', source: "McDonald's/Wendy's FDD target demographic" },
      { key: 'food_gap',     weight: 0.15, normFn: 'minmax',   normParams: {}, label: 'Food Service Gap (low competition)', source: 'OSM amenity density' },
      { key: 'growth',       weight: 0.10, normFn: 'minmax',   normParams: {}, label: 'Market Growth Score', source: 'worldModelWorker: QCEW + SunBiz + BPS' }
    ]
  },

  DESTINATION_DINING: {
    name: 'Destination / Fine Dining',
    hardFloors: [],
    factors: [
      { key: 'hhi',          weight: 0.35, normFn: 'minmax',     normParams: {}, label: 'Household Income (higher = better)', source: 'ACS median HHI' },
      { key: 'food_gap',     weight: 0.20, normFn: 'minmax',     normParams: {}, label: 'Fine Dining Gap', source: 'OSM amenity density' },
      { key: 'owner_occ',    weight: 0.15, normFn: 'minmax',     normParams: {}, label: 'Owner-Occupied Housing Rate', source: 'ACS owner occupancy' },
      { key: 'growth',       weight: 0.15, normFn: 'minmax',     normParams: {}, label: 'Market Growth', source: 'worldModelWorker composite' },
      { key: 'psycho_index', weight: 0.10, normFn: 'precomputed', normParams: {}, label: 'Psychographic Index (arts, golf, education, lifestyle)', source: 'OSM POI density + ACS educational attainment + ACS median age' }
    ]
  },

  RETAIL_STRIP: {
    name: 'Retail / Strip Center',
    hardFloors: [],
    factors: [
      { key: 'daytime_pop',  weight: 0.30, normFn: 'minmax',     normParams: {}, label: 'Daytime Population', source: 'LODES + ACS' },
      { key: 'aadt',         weight: 0.25, normFn: 'minmax',     normParams: {}, label: 'Traffic Volume', source: 'FDOT AADT 2025' },
      { key: 'hhi',          weight: 0.25, normFn: 'minmax',     normParams: {}, label: 'Household Income', source: 'ACS median HHI' },
      { key: 'growth',       weight: 0.10, normFn: 'minmax',     normParams: {}, label: 'Market Growth', source: 'worldModelWorker composite' },
      { key: 'psycho_index', weight: 0.10, normFn: 'precomputed', normParams: {}, label: 'Psychographic Index (arts, golf, education, lifestyle)', source: 'OSM POI density + ACS educational attainment + ACS median age' }
    ]
  },

  HEALTHCARE: {
    name: 'Healthcare / Medical Office',
    hardFloors: [],
    factors: [
      { key: 'population',   weight: 0.40, normFn: 'minmax',   normParams: {}, label: 'Residential Population', source: 'ACS total population' },
      { key: 'food_gap',     weight: 0.35, normFn: 'minmax',   normParams: {}, label: 'Healthcare Gap Proxy', source: 'OSM POI density inversion' },
      { key: 'growth',       weight: 0.25, normFn: 'minmax',   normParams: {}, label: 'Market Growth', source: 'worldModelWorker composite' }
    ]
  },

  GENERAL: {
    name: 'General Business',
    hardFloors: [],
    factors: [
      { key: 'opportunity',  weight: 0.35, normFn: 'minmax',     normParams: {}, label: 'Opportunity Score', source: 'worldModelWorker composite' },
      { key: 'hhi',          weight: 0.30, normFn: 'minmax',     normParams: {}, label: 'Household Income', source: 'ACS median HHI' },
      { key: 'growth',       weight: 0.25, normFn: 'minmax',     normParams: {}, label: 'Market Growth Score', source: 'worldModelWorker composite' },
      { key: 'psycho_index', weight: 0.10, normFn: 'precomputed', normParams: {}, label: 'Psychographic Index (arts, golf, education, lifestyle)', source: 'OSM POI density + ACS educational attainment + ACS median age' }
    ]
  }

};

module.exports = { CONCEPT_PROFILES };
