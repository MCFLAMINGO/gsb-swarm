/**
 * lib/fetchZctaBoundary.js — Census TIGER ZCTA polygon fetcher
 * ─────────────────────────────────────────────────────────────────────────────
 * Shared utility used by oracleWorker and boundaryWorker.
 * Fetches a single ZCTA polygon from Census TIGERweb REST API (free, no key).
 *
 * Usage:
 *   const { fetchZctaBoundary } = require('../lib/fetchZctaBoundary');
 *   const geom = await fetchZctaBoundary('32202');
 *   // geom = GeoJSON geometry object { type, coordinates } or null if not found
 */

'use strict';

const https = require('https');

// Layer 1 = 2020 Census ZIP Code Tabulation Areas (field: ZCTA5)
const TIGER_URL = 'https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/PUMA_TAD_TAZ_UGA_ZCTA/MapServer/1/query';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * fetchZctaBoundary(zip) → GeoJSON geometry or null
 * Returns the Polygon/MultiPolygon geometry for a given 5-digit ZIP code.
 * Returns null if the ZIP has no ZCTA (PO box, military, etc.)
 */
async function fetchZctaBoundary(zip) {
  const params = new URLSearchParams({
    where:             `ZCTA5='${zip}'`,
    outFields:         'ZCTA5',
    f:                 'geojson',
    outSR:             '4326',
    geometryPrecision: '6',
  });
  const data = await fetchJSON(`${TIGER_URL}?${params}`);
  if (!data.features || !data.features.length) return null;
  return data.features[0].geometry || null;
}

/**
 * computeCentroid(geometry) → { lat, lon, bbox } or null
 */
function computeCentroid(geometry) {
  if (!geometry) return null;
  const ring = geometry.type === 'Polygon'
    ? geometry.coordinates[0]
    : geometry.coordinates[0]?.[0];
  if (!ring?.length) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const [lon, lat] of ring) {
    if (lat < minLat) minLat = lat; if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon; if (lon > maxLon) maxLon = lon;
  }
  return {
    lat:  (minLat + maxLat) / 2,
    lon:  (minLon + maxLon) / 2,
    bbox: { south: minLat, north: maxLat, west: minLon, east: maxLon },
  };
}

module.exports = { fetchZctaBoundary, computeCentroid };
