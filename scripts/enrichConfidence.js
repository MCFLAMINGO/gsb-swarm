#!/usr/bin/env node
'use strict';
/**
 * enrichConfidence.js
 *
 * One-time (and safe-to-re-run) enrichment pass.
 * Rescores every business record in:
 *   - data/zips/*.json          (flat-array format)
 *   - data/gap_fill_*.json      (standalone gap-fill source files)
 *   - data/localIntel.json      (global flat file)
 *
 * Uses computeConfidence() — no LLM, no network, deterministic.
 * Writes are atomic (write to tmp, then rename).
 */

const fs   = require('fs');
const path = require('path');
const { computeConfidence } = require('../lib/computeConfidence');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ZIPS_DIR = path.join(DATA_DIR, 'zips');

function atomicWrite(filePath, data) {
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function rescoreArray(bizs) {
  let changed = 0;
  for (const b of bizs) {
    const newConf = computeConfidence(b);
    if (b.confidence !== newConf) {
      b.confidence = newConf;
      changed++;
    }
  }
  return changed;
}

let totalFiles = 0, totalChanged = 0, totalBiz = 0;

// ── 1. data/zips/*.json ──────────────────────────────────────────────────────
if (fs.existsSync(ZIPS_DIR)) {
  const files = fs.readdirSync(ZIPS_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const fp = path.join(ZIPS_DIR, f);
    try {
      const raw  = fs.readFileSync(fp, 'utf8');
      const data = JSON.parse(raw);
      const bizs = Array.isArray(data) ? data : (data.businesses || []);
      if (!bizs.length) continue;
      const changed = rescoreArray(bizs);
      totalBiz += bizs.length;
      if (changed > 0) {
        atomicWrite(fp, Array.isArray(data) ? bizs : { ...data, businesses: bizs });
        totalChanged += changed;
        totalFiles++;
      }
    } catch (e) {
      console.warn(`[enrichConfidence] skip ${f}: ${e.message}`);
    }
  }
  console.log(`[enrichConfidence] zips/: ${totalFiles} files updated, ${totalChanged} records rescored`);
}

// ── 2. data/gap_fill_*.json ──────────────────────────────────────────────────
let gapChanged = 0, gapFiles = 0;
const dataFiles = fs.readdirSync(DATA_DIR).filter(f => f.startsWith('gap_fill_') && f.endsWith('.json'));
for (const f of dataFiles) {
  const fp = path.join(DATA_DIR, f);
  try {
    const data = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (!Array.isArray(data) || !data.length) continue;
    const changed = rescoreArray(data);
    totalBiz += data.length;
    if (changed > 0) {
      atomicWrite(fp, data);
      gapChanged += changed;
      gapFiles++;
    }
  } catch (e) {
    console.warn(`[enrichConfidence] skip ${f}: ${e.message}`);
  }
}
console.log(`[enrichConfidence] gap_fill: ${gapFiles} files updated, ${gapChanged} records rescored`);

// ── 3. data/localIntel.json ──────────────────────────────────────────────────
const liPath = path.join(DATA_DIR, 'localIntel.json');
let liChanged = 0;
if (fs.existsSync(liPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(liPath, 'utf8'));
    if (Array.isArray(data) && data.length) {
      liChanged = rescoreArray(data);
      totalBiz += data.length;
      if (liChanged > 0) atomicWrite(liPath, data);
    }
  } catch (e) {
    console.warn(`[enrichConfidence] localIntel.json skip: ${e.message}`);
  }
}
console.log(`[enrichConfidence] localIntel.json: ${liChanged} records rescored`);

console.log(`\n[enrichConfidence] DONE — ${totalBiz} records evaluated, ${totalChanged + gapChanged + liChanged} rescored`);
