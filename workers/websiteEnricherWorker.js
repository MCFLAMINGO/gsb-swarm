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

const TARGET_ZIPS = [
  '32082','32081','32250','32266','32233','32259',
  '32034','32092','32080','32084','32205','32207',
  '32210','32216','32224','32225','32256',
];

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

if (require.main === module) {
  (async () => {
    const FULL_REFRESH = process.env.FULL_REFRESH === 'true';
    const CONCURRENCY  = parseInt(process.env.CONCURRENCY || '8', 10);
    console.log(`[web-enricher] Starting — FULL_REFRESH=${FULL_REFRESH}, CONCURRENCY=${CONCURRENCY}`);

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

    console.log(`\n[web-enricher] Done — ${updated} updated, ${skipped} skipped, ${failed} failed`);
    console.log(`[web-enricher] Emails found: ${emailsFound} / ${processed} processed`);
    process.exit(0);
  })().catch(e => { console.error('[web-enricher] FATAL:', e.message); process.exit(1); });
}
