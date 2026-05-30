/**
 * websiteEnricherWorker.js
 * ────────────────────────
 * Fetches homepage <title> + <meta description> for businesses with real websites,
 * extracts a clean description, and optionally corrects category from page content.
 *
 * Rules:
 * - Only fetches non-YP, non-social, non-gov websites
 * - 5s timeout per fetch — skip on failure, never crash
 * - Uses meta description if >= 60 chars, otherwise title-derived
 * - Runs keyword classifier on title+meta to correct category if current = LocalBusiness
 * - Skips records that already have a good description (>= 120 chars)
 * - Worker contract: read Postgres → work only new → upsert → FULL_REFRESH=true to redo all
 *
 * Run: node workers/websiteEnricherWorker.js
 */
'use strict';

const https = require('https');
const http  = require('http');
const db    = require('../lib/db');
const { RULES, CATEGORY_LABELS } = require('./reclassifyWorker');

// FL-wide: no ZIP filter — query covers all FL businesses with websites

const SKIP_DOMAINS = [
  'yellowpages.com','yelp.com','facebook.com','google.com','instagram.com',
  'twitter.com','linkedin.com','tripadvisor.com','bbb.org','mapquest.com',
  'whitepages.com','angi.com','thumbtack.com','homeadvisor.com',
  '.gov','centralparknyc.org', // known bad mappings
];

function shouldSkip(url) {
  if (!url) return true;
  return SKIP_DOMAINS.some(d => url.includes(d));
}

function fetchPage(url, timeoutMs = 5000) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(url);
      const lib = parsed.protocol === 'https:' ? https : http;
      const req = lib.get(url, {
        timeout: timeoutMs,
        headers: { 'User-Agent': 'LocalIntel-Enricher/1.0 (+https://thelocalintel.com)' },
      }, (res) => {
        // Follow one redirect
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          return fetchPage(res.headers.location, timeoutMs).then(resolve);
        }
        if (res.statusCode !== 200) return resolve(null);
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => {
          body += chunk;
          if (body.length > 50000) { req.destroy(); resolve(body); } // cap at 50k
        });
        res.on('end', () => resolve(body));
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.setTimeout(timeoutMs);
    } catch(e) { resolve(null); }
  });
}

function extractMeta(html) {
  if (!html) return { title: null, description: null };
  const titleMatch = html.match(/<title[^>]*>([^<]{3,200})<\/title>/i);
  const descMatch  = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,500})["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']{10,500})["'][^>]+name=["']description["']/i);
  const ogMatch    = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,500})["']/i)
                  || html.match(/<meta[^>]+content=["']([^"']{10,500})["'][^>]+property=["']og:description["']/i);

  const title = titleMatch ? titleMatch[1].replace(/\s+/g,' ').trim() : null;
  const description = (descMatch?.[1] || ogMatch?.[1] || '').replace(/\s+/g,' ').trim();
  return { title, description };
}

// B66: Filter out junk emails (privacy@, noreply@, sentry@, vendor boilerplate)
function isValidBusinessEmail(email) {
  if (!email || !email.includes('@')) return false;
  const SKIP_PREFIXES = ['noreply','no-reply','donotreply','privacy','legal','dmca',
    'abuse','postmaster','webmaster','sentry','support@sentry','admin@wp','bounce'];
  const SKIP_DOMAINS  = ['sentry.io','wix.com','squarespace.com','godaddy.com',
    'wordpress.com','amazonaws.com','example.com','test.com'];
  const [local, domain] = email.split('@');
  if (!local || !domain) return false;
  if (SKIP_PREFIXES.some(p => local.startsWith(p))) return false;
  if (SKIP_DOMAINS.some(d => domain.includes(d))) return false;
  if (email.length > 100) return false;
  return true;
}

// B66: Extract a contact email from raw HTML — mailto links first, then any
// plain email pattern. Returns null when nothing usable is found.
function extractEmail(html /*, url */) {
  if (!html) return null;

  // 1. mailto: links
  const mailtoMatches = html.match(/href=["']mailto:([^"'?]+)["']/gi) || [];
  for (const m of mailtoMatches) {
    const email = m.match(/mailto:([^"'?]+)/i)?.[1]?.toLowerCase().trim();
    if (email && isValidBusinessEmail(email)) return { email, source: 'homepage_mailto' };
  }

  // 2. Plain email patterns in text
  const emailPattern = /\b([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})\b/g;
  const textMatches = html.match(emailPattern) || [];
  for (const email of textMatches) {
    const lower = email.toLowerCase();
    if (isValidBusinessEmail(lower)) return { email: lower, source: 'homepage_mailto' };
  }

  return null;
}

// B66: Try /contact, /contact-us, /about, /about-us when the homepage has no email.
async function fetchContactPageEmail(baseUrl) {
  const contactUrls = ['/contact', '/contact-us', '/about', '/about-us'];
  for (const p of contactUrls) {
    try {
      const url = new URL(p, baseUrl).href;
      const html = await fetchPage(url, 4000);
      if (!html) continue;
      const result = extractEmail(html, url);
      if (result) return { email: result.email, source: 'contact_page' };
    } catch (_) { /* swallow per-path errors */ }
  }
  return null;
}

function classifyFromText(text) {
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const rule of RULES) {
    if (rule.patterns.some(p => lower.includes(p.toLowerCase()))) {
      return { category: rule.category, group: rule.group };
    }
  }
  return null;
}

// B77: Keyword tag extractor — scans description/title text for known dietary,
// dining-style, service, and wellness keywords and returns a deduped tag list.
// Used to enrich businesses.tags before the description UPDATE.
function extractTagsFromText(text) {
  if (!text) return [];
  const t = text.toLowerCase();
  const tags = [];

  // Food & dietary
  if (/\bhealthy\b|\bhealth.conscious\b/.test(t)) tags.push('healthy');
  if (/\borganic\b/.test(t)) tags.push('organic');
  if (/\bgluten.free\b|\bgluten free\b/.test(t)) tags.push('gluten_free');
  if (/\bvegan\b/.test(t)) tags.push('vegan');
  if (/\bvegetarian\b/.test(t)) tags.push('vegetarian');
  if (/\bkosher\b/.test(t)) tags.push('kosher');
  if (/\bhalal\b/.test(t)) tags.push('halal');
  if (/\bfarm.to.table\b|\bfarm to table\b/.test(t)) tags.push('farm_to_table');
  if (/\bplant.based\b|\bplant based\b/.test(t)) tags.push('plant_based');

  // Dining style
  if (/\bfine dining\b|\bupscale\b|\bwhite tablecloth\b/.test(t)) tags.push('fine_dining');
  if (/\bwine\b/.test(t)) tags.push('wine');
  if (/\bcocktail|\bcraft beer\b|\bcraftbeer\b/.test(t)) tags.push('cocktails');
  if (/\broof(top)?\b|\brooftop\b/.test(t)) tags.push('rooftop');
  if (/\boutdoor seating\b|\bpatio\b|\bal fresco\b/.test(t)) tags.push('outdoor_seating');
  if (/\blive music\b/.test(t)) tags.push('live_music');
  if (/\bhappy hour\b/.test(t)) tags.push('happy_hour');
  if (/\bbuffet\b/.test(t)) tags.push('buffet');
  if (/\bbrunch\b/.test(t)) tags.push('brunch');
  if (/\btakeout\b|\btake.out\b|\bto.go\b/.test(t)) tags.push('takeout');
  if (/\bdelivery\b/.test(t)) tags.push('delivery');

  // Services
  if (/\b24.hour\b|\b24\/7\b/.test(t)) tags.push('24_hour');
  if (/\bwheelchair\b|\baccessible\b|\bada\b/.test(t)) tags.push('accessible');
  if (/\bpet.friendly\b|\bdogs? welcome\b/.test(t)) tags.push('pet_friendly');
  if (/\bkid.friendly\b|\bfamily.friendly\b/.test(t)) tags.push('family_friendly');
  if (/\bwifi\b|\bfree wifi\b/.test(t)) tags.push('wifi');
  if (/\bparking\b/.test(t)) tags.push('parking');
  if (/\breservation\b|\bbook (a )?table\b/.test(t)) tags.push('reservations');

  // Wellness/fitness
  if (/\byoga\b/.test(t)) tags.push('yoga');
  if (/\bpilates\b/.test(t)) tags.push('pilates');
  if (/\bpersonal training\b/.test(t)) tags.push('personal_training');
  if (/\bmedical spa\b|\bmedspa\b|\bmed spa\b/.test(t)) tags.push('med_spa');
  if (/\bbotox\b|\bfiller\b/.test(t)) tags.push('aesthetics');

  return [...new Set(tags)];
}

function buildDescription(name, meta, category, city, zip) {
  // Prefer meta description if it's meaningful and not generic chain copy
  const genericPhrases = ['find a location','store locator','locations near','click here','learn more','our website','page not found','404'];
  const isGeneric = !meta.description || meta.description.length < 60
    || genericPhrases.some(p => meta.description.toLowerCase().includes(p));

  if (!isGeneric) return meta.description;

  // Fall back to title-derived if title looks useful
  if (meta.title && meta.title.length > 10 && !meta.title.toLowerCase().includes('page not found')) {
    const label = CATEGORY_LABELS[category] || 'a local business';
    const loc = city ? `${city}, FL ${zip}` : `FL ${zip}`;
    return `${name} is ${label} in ${loc}. ${meta.title.split('|')[0].split('-')[0].trim()}.`;
  }

  return null; // nothing useful — leave existing
}

// ── Daemon loop ─────────────────────────────────────────────────────────────
// Runs as a continuous worker under LOCAL_INTEL_WORKERS.
// FRESH_MS = 7 days — re-enriches newly added businesses weekly.
// SLEEP_MS = 24h — avoids Node.js setTimeout overflow (max ~24.8d).
const WORKER_NAME = 'websiteEnricherWorker';
const FRESH_MS    = 7 * 24 * 3600 * 1000;  // 7 days freshness
const SLEEP_MS    = 24 * 3600 * 1000;       // 24h sleep (safe for Node)

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runPass() {
    const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
    const CONCURRENCY  = parseInt(process.env.CONCURRENCY || '5', 10);  // 5 concurrent — gentle on DB pool
    console.log(`[web-enricher] Starting pass — FULL_REFRESH=${FULL_REFRESH}, CONCURRENCY=${CONCURRENCY}`);

    // B66: Statewide scope for email harvest — drop ZIP filter, add contact_email
    // IS NULL so we only fetch businesses we haven't already harvested. Still
    // re-fetches when description is thin so existing enrichment behavior is
    // preserved for newly-added businesses.
    const rows = await db.query(`
      SELECT business_id, name, category, category_group, city, zip, website, description, contact_email
      FROM businesses
      WHERE status != 'inactive'
        AND website IS NOT NULL
        AND website ~ '^https?://'
        AND website NOT ILIKE '%yellowpages%'
        AND website NOT ILIKE '%yelp.com%'
        AND website NOT ILIKE '%facebook.com%'
        AND website NOT ILIKE '%google.com%'
        AND (
          contact_email IS NULL
          OR category = 'LocalBusiness'
          OR LENGTH(COALESCE(description,'')) < 80
          OR description ILIKE '%is a local %'
          OR description ILIKE '%is a % serving the % area%'
        )
    `);

    const toProcess = FULL_REFRESH ? rows : rows.filter(r => !shouldSkip(r.website));
    console.log(`[web-enricher] ${toProcess.length} records to enrich`);

    let updated = 0, skipped = 0, failed = 0, emailsFound = 0, processed = 0;

    // Process in concurrent batches
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      const batch = toProcess.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map(async (biz) => {
        if (shouldSkip(biz.website)) { skipped++; return; }
        try {
          const html = await fetchPage(biz.website);
          processed++;
          if (!html) { skipped++; return; }

          const meta = extractMeta(html);
          const newDesc = buildDescription(biz.name, meta, biz.category, biz.city, biz.zip);

          // Classify from page text if currently LocalBusiness
          let newCat = null, newGroup = null;
          if (biz.category === 'LocalBusiness') {
            const combined = `${meta.title || ''} ${meta.description || ''}`;
            const classified = classifyFromText(combined);
            if (classified) { newCat = classified.category; newGroup = classified.group; }
          }

          // B66: harvest contact_email when we don't already have one
          if (!biz.contact_email) {
            let emailResult = extractEmail(html, biz.website);
            if (!emailResult) {
              emailResult = await fetchContactPageEmail(biz.website);
            }
            if (emailResult) {
              await db.query(
                `UPDATE businesses
                    SET contact_email = $1,
                        contact_email_source = $2,
                        updated_at = NOW()
                  WHERE business_id = $3
                    AND contact_email IS NULL`,
                [emailResult.email, emailResult.source, biz.business_id]
              );
              emailsFound++;
            }
          }

          // B77: Extract keyword tags from title + meta description + new
          // description text. Union-merge with existing tags so we never
          // remove anything operators or other workers have already attached.
          const tagSource = `${meta.title || ''} ${meta.description || ''} ${newDesc || ''}`.trim();
          const newTags = extractTagsFromText(tagSource);
          if (newTags.length > 0) {
            await db.query(
              `UPDATE businesses
                  SET tags = (
                        SELECT ARRAY(
                          SELECT DISTINCT unnest(COALESCE(tags, ARRAY[]::text[]) || $1::text[])
                        )
                      ),
                      updated_at = NOW()
                WHERE business_id = $2`,
              [newTags, biz.business_id]
            );
          }

          if (!newDesc && !newCat) { skipped++; return; }

          await db.query(
            `UPDATE businesses SET
               description   = COALESCE($1, description),
               category      = COALESCE($2, category),
               category_group= COALESCE($3, category_group),
               updated_at    = NOW()
             WHERE business_id = $4`,
            [newDesc || null, newCat || null, newGroup || null, biz.business_id]
          );
          updated++;
        } catch(e) {
          failed++;
        }
      }));
      process.stdout.write(`\r[web-enricher] ${i + Math.min(CONCURRENCY, toProcess.length - i)}/${toProcess.length} processed (${updated} updated, ${skipped} skipped, ${failed} failed)...`);
    }

    console.log(`\n[web-enricher] Pass done — ${updated} updated, ${skipped} skipped, ${failed} failed`);
    console.log(`[web-enricher] Emails found: ${emailsFound} / ${processed} processed`);
    return updated;
}

(async function main() {
  const hb = require('../lib/workerHeartbeat');
  console.log('[web-enricher] Worker started');

  // Wait for DB to be ready
  for (let i = 0; i < 10; i++) {
    try { await db.query('SELECT 1'); break; }
    catch (e) {
      console.warn(`[web-enricher] DB not ready (${i+1}/10)`);
      await sleep(5000);
      if (i === 9) { console.error('[web-enricher] DB never ready — exiting'); process.exit(1); }
    }
  }

  while (true) {
    try {
      if (await hb.isFresh(WORKER_NAME, FRESH_MS)) {
        console.log(`[web-enricher] Fresh — sleeping ${SLEEP_MS / 3600000}h`);
      } else {
        const updated = await runPass();
        await hb.ping(WORKER_NAME, updated);
      }
    } catch (err) {
      console.error('[web-enricher] Cycle error:', err.message);
      try { await (require('../lib/workerHeartbeat')).pingError(WORKER_NAME, err.message); } catch(_) {}
    }
    await sleep(SLEEP_MS);
  }
})();
