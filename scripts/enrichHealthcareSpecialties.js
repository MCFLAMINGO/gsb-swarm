'use strict';
/**
 * scripts/enrichHealthcareSpecialties.js
 * 
 * Deterministic specialty detection for healthcare businesses.
 * Matches name + description against keyword map → writes to tags array in Postgres.
 * Zero LLM calls. Run once, safe to re-run (idempotent via FULL_REFRESH=true).
 * 
 * Usage: node scripts/enrichHealthcareSpecialties.js
 *        FULL_REFRESH=true node scripts/enrichHealthcareSpecialties.js
 */

const db = require('../lib/db');

// ── Specialty taxonomy ────────────────────────────────────────────────────────
// Each entry: [specialty_tag, [...keywords_to_match_in_name_or_description]]
// Keywords are matched case-insensitively, word-boundary aware.
const SPECIALTY_MAP = [
  // Dental
  ['dentist',         ['dent','dental','dmd','dds','orthodont','endodont','periodont','oral surgery','oral surgeon','teeth whitening','implant']],
  ['orthodontist',    ['orthodont','braces','invisalign','aligner']],

  // Vision
  ['optometrist',     ['optom','opthal','ophtha','eye','vision','eyecare','glasses','contact lens','lasik','retina']],

  // Mental health
  ['mental_health',   ['behav','psychiatr','psycholog','counseling','counselor','therapist','therapy','mental health','addiction','substance','rehab','neuropsychol']],

  // Pediatrics
  ['pediatrics',      ['pediatr','children','kids health','child health']],

  // Women's health
  ['womens_health',   ['ob/gyn','obgyn','ob-gyn','gynecolog','obstetric','fertility','reproductive','ivf','midwife','midwifery','womens health','breast']],

  // Dermatology
  ['dermatology',     ['dermatol','skin','derm','cosmetic dermatol','melanoma','acne','rosacea']],

  // Cardiology
  ['cardiology',      ['cardiol','heart','cardiovascular','cardiac','vascular']],

  // Orthopedics
  ['orthopedics',     ['orthoped','orthopaed','bone','joint','spine','spinal','sports med','sports medicine','physical therapy','physiother','rehab']],

  // Physical therapy
  ['physical_therapy',['physical therap','physio','pt clinic','rehabilitation','occupational therap']],

  // Chiropractic
  ['chiropractic',    ['chiropract','chiro','spinal adjust','back pain clinic']],

  // Neurology
  ['neurology',       ['neurolog','neurosurg','brain','nerve','headache','migraine','epilep','stroke']],

  // Urology
  ['urology',         ['urol','bladder','kidney stone','prostate']],

  // ENT
  ['ent',             ['ear nose','otolaryngol','\\bent\\b clinic','sinus clinic','hearing aid','audiolog','cochlear']],

  // Gastroenterology
  ['gastroenterology',['gastro','digestive','colon','gi clinic','endoscopy','colonoscopy','hepat']],

  // Oncology
  ['oncology',        ['oncol','cancer','tumor','radiat oncol','chemo']],

  // Endocrinology
  ['endocrinology',   ['endocrin','diabetes','thyroid','hormone','metabolic']],

  // Primary care / family medicine
  ['primary_care',    ['family med','family practice','family doctor','primary care','internal med','general practice','general practitioner','urgent care','walk-in','walkin','med center','medical center','health center','clinic']],

  // Pharmacy
  ['pharmacy',        ['pharm','rx','drug store','compounding']],

  // Podiatry
  ['podiatry',        ['podiat','foot','ankle','dpm']],

  // Plastic surgery / aesthetics
  ['plastic_surgery', ['plastic surg','cosmetic surg','aesthetic','med spa','medspa','botox','filler','rhinoplasty','liposuc','tummy tuck']],

  // Dialysis / nephrology
  ['nephrology',      ['dialysis','nephrol','kidney care','renal']],

  // Home health
  ['home_health',     ['home health','home care','hospice','palliative','visiting nurse']],

  // Lab / imaging
  ['lab_imaging',     ['laborator','imaging','radiol','mri','x-ray','xray','ultrasound','scan center','diagnostic']],

  // Urgent / emergency
  ['urgent_care',     ['urgent care','emergency room','emergency dept','\\ber\\b clinic','walk-in clinic','after hours clinic']],

  // Medical billing / admin (not a patient-facing specialty)
  ['medical_admin',   ['billing','medical claims','insurance claims','medical coding','ehr','emr']],

  // Acupuncture / holistic
  ['holistic',        ['acupunct','holistic','naturopath','homeopath','ayurved','wellness center','integrative']],
];

// ── Build regex map ───────────────────────────────────────────────────────────
const SPECIALTY_REGEX = SPECIALTY_MAP.map(([tag, keywords]) => ({
  tag,
  re: new RegExp(keywords.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i'),
}));

function detectSpecialties(name, description) {
  const haystack = `${name || ''} ${description || ''}`;
  return SPECIALTY_REGEX.filter(({ re }) => re.test(haystack)).map(({ tag }) => tag);
}

// ── Main ──────────────────────────────────────────────────────────────────────
const SERVED_ZIPS = ['32082','32081','32250','32266','32233','32206','32080','32084','32086','32092','32095','32259','32258','32223'];

async function run() {
  const fullRefresh = process.env.FULL_REFRESH === 'true';

  console.log('[healthcareEnrich] Starting specialty enrichment…');
  console.log('[healthcareEnrich] FULL_REFRESH =', fullRefresh);

  const rows = await db.query(`
    SELECT business_id, name, description, tags, category_intel
    FROM businesses
    WHERE zip = ANY($1)
      AND (category = 'healthcare' OR tags && ARRAY['healthcare'])
      ${fullRefresh ? '' : "AND NOT (tags && ARRAY['dentist','pediatrics','dermatology','primary_care','mental_health','pharmacy','optometrist','womens_health','orthopedics','cardiology','neurology','urgent_care'])"}
    ORDER BY name
  `, [SERVED_ZIPS]);

  console.log(`[healthcareEnrich] Processing ${rows.length} businesses…\n`);

  let updated = 0, skipped = 0;

  for (const biz of rows) {
    const specialties = detectSpecialties(biz.name, biz.description);
    if (!specialties.length) {
      console.log(`  SKIP  ${biz.name} — no specialty detected`);
      skipped++;
      continue;
    }

    // Merge with existing tags (keep non-specialty tags)
    const existing = Array.isArray(biz.tags) ? biz.tags : [];
    const merged   = [...new Set([...existing, 'healthcare', ...specialties])];

    await db.query(
      `UPDATE businesses SET tags = $2, updated_at = NOW() WHERE business_id = $1`,
      [biz.business_id, merged]
    );
    console.log(`  ✓  ${biz.name} → [${specialties.join(', ')}]`);
    updated++;
  }

  console.log(`\n[healthcareEnrich] Done — ${updated} updated, ${skipped} skipped (no match)`);
  process.exit(0);
}

run().catch(e => { console.error('[healthcareEnrich] FATAL:', e.message); process.exit(1); });
