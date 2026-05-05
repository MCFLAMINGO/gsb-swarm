/**
 * descriptionTemplateWorker.js
 * ─────────────────────────────
 * Builds richer deterministic descriptions for records that have no real website
 * to fetch from but still have weak/template descriptions.
 *
 * Template: "[Name] is [a/an category label] in [City], FL [ZIP][. Call PHONE][. Hours: HOURS]."
 *
 * Worker contract:
 * - Only touches records with weak descriptions (< 80 chars or our template text)
 * - Skips records that have a real fetchable website (websiteEnricher handles those)
 * - Never shortens a good existing description
 *
 * Run: node workers/descriptionTemplateWorker.js
 */
'use strict';

const db = require('../lib/db');
const { CATEGORY_LABELS } = require('./reclassifyWorker');

const TARGET_ZIPS = [
  '32082','32081','32250','32266','32233','32259',
  '32034','32092','32080','32084','32205','32207',
  '32210','32216','32224','32225','32256',
];

// Normalize raw OSM/YP hour strings into human-readable
function formatHours(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length < 5) return null;
  // Already human-readable?
  if (/open|mon|tue|wed|thu|fri|sat|sun/i.test(s)) return null; // let it be
  // OSM format: "Mo-Fr 09:00-17:00; Sa 09:00-13:00"
  const match = s.match(/^Mo-Fr\s+(\d{2}:\d{2})-(\d{2}:\d{2})/i);
  if (match) return `Weekdays ${match[1]}–${match[2]}`;
  return null;
}

function buildRichDescription(biz) {
  const label = CATEGORY_LABELS[biz.category] || CATEGORY_LABELS['LocalBusiness'];
  const city  = biz.city || null;
  const loc   = city ? `${city}, FL ${biz.zip}` : `FL ${biz.zip}`;

  let desc = `${biz.name} is ${label} in ${loc}.`;

  // Append phone if available
  if (biz.phone) {
    const clean = biz.phone.replace(/\D/g,'');
    if (clean.length === 10) {
      desc += ` Call (${clean.slice(0,3)}) ${clean.slice(3,6)}-${clean.slice(6)}.`;
    } else if (clean.length === 11 && clean[0] === '1') {
      desc += ` Call (${clean.slice(1,4)}) ${clean.slice(4,7)}-${clean.slice(7)}.`;
    }
  }

  // Append hours signal if parseable
  const hrs = formatHours(biz.hours);
  if (hrs) desc += ` Open ${hrs}.`;

  return desc;
}

function isWeak(description) {
  if (!description || description.trim().length < 80) return true;
  if (/is a local business|is a local \w+ serving|serving the \d{5} area/i.test(description)) return true;
  // Our own short template from previous cleaner pass
  if (/^.+ is (a|an) .+ in (FL \d{5}|.+, FL \d{5})\.$/.test(description.trim()) && description.length < 80) return true;
  return false;
}

if (require.main === module) {
  (async () => {
    const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
    console.log(`[desc-template] Starting — FULL_REFRESH=${FULL_REFRESH}`);

    const rows = await db.query(`
      SELECT business_id, name, category, city, zip, phone, hours, description, website
      FROM businesses
      WHERE status != 'inactive'
        AND category != 'LocalBusiness'
        AND zip = ANY($1)
        AND (
          description IS NULL OR LENGTH(description) < 80
          OR description ILIKE '%is a local business%'
          OR description ILIKE '%is a local % serving%'
          OR description ILIKE '%serving the % area%'
        )
    `, [TARGET_ZIPS]);

    console.log(`[desc-template] ${rows.length} records to evaluate`);

    // Skip records that have a real website — websiteEnricher handles those
    const toUpdate = rows.filter(r => {
      if (!r.website) return true;
      const skip = ['yellowpages','yelp.com','facebook','google.com','instagram','twitter'];
      return skip.some(s => r.website.includes(s)) || !/^https?:\/\//.test(r.website);
    }).filter(r => FULL_REFRESH || isWeak(r.description));

    console.log(`[desc-template] ${toUpdate.length} to update (${rows.length - toUpdate.length} skipped — have real websites or good descriptions)`);

    // Bulk update in chunks
    let count = 0;
    const CHUNK = 200;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      const chunk = toUpdate.slice(i, i + CHUNK);
      const placeholders = chunk.map((_, j) => `($${j*2+1}::uuid, $${j*2+2})`).join(',');
      const params = [];
      chunk.forEach(r => {
        params.push(r.business_id, buildRichDescription(r));
      });
      await db.query(
        `UPDATE businesses SET description = v.clean_text, updated_at = NOW()
         FROM (VALUES ${placeholders}) AS v(bid, clean_text)
         WHERE businesses.business_id = v.bid`,
        params
      );
      count += chunk.length;
      process.stdout.write(`\r[desc-template] ${count}/${toUpdate.length} updated...`);
    }

    console.log(`\n[desc-template] Done — ${count} descriptions rebuilt`);
    process.exit(0);
  })().catch(e => { console.error('[desc-template] FATAL:', e.message); process.exit(1); });
}
