#!/usr/bin/env node
/**
 * scripts/download-sunbiz.js
 * Downloads cordata.zip from FL Sunbiz SFTP → /app/data/sunbiz/cordata.zip
 * Designed to run as a Railway one-off or triggered via POST /api/admin/download-sunbiz
 * Resumes from partial download if file already exists.
 */
'use strict';

const { execSync } = require('child_process');
const fs   = require('fs');
const path = require('path');
const net  = require('net');

// SFTP creds (public access — not secret)
const SFTP_HOST   = 'sftp.floridados.gov';
const SFTP_USER   = 'Public';
const SFTP_PASS   = 'PubAccess1845!';
const REMOTE_PATH = 'doc/quarterly/cor/cordata.zip';
const LOCAL_DIR   = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'sunbiz')
  : path.join(__dirname, '../data/sunbiz');
const LOCAL_FILE  = path.join(LOCAL_DIR, 'cordata.zip');

async function downloadSunbiz(onProgress) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  const localSize = fs.existsSync(LOCAL_FILE) ? fs.statSync(LOCAL_FILE).size : 0;
  console.log(`[sunbiz-dl] Local: ${(localSize/1024/1024).toFixed(1)} MB`);

  // Use lftp — available on Railway's Node image via apt, or use curl with sftp://
  // curl supports sftp with password and resume (-C -)
  const url = `sftp://${SFTP_USER}:${encodeURIComponent(SFTP_PASS)}@${SFTP_HOST}/${REMOTE_PATH}`;

  return new Promise((resolve, reject) => {
    const args = [
      'curl', '--silent', '--show-error',
      '--insecure',          // floridados uses basic cert
      '-C', String(localSize), // resume offset
      '--retry', '5',
      '--retry-delay', '10',
      '--retry-max-time', '7200',
      '--speed-limit', '1024',  // abort if < 1KB/s for 30s
      '--speed-time', '30',
      '--output', LOCAL_FILE,
      url,
    ];

    console.log(`[sunbiz-dl] Starting curl resume from ${(localSize/1024/1024).toFixed(1)} MB...`);

    const { spawn } = require('child_process');
    const proc = spawn(args[0], args.slice(1), { stdio: ['ignore','pipe','pipe'] });

    let lastLog = Date.now();
    proc.stderr.on('data', d => {
      const s = d.toString();
      // Log progress every 30s
      if (Date.now() - lastLog > 30000) {
        const cur = fs.existsSync(LOCAL_FILE) ? fs.statSync(LOCAL_FILE).size : 0;
        console.log(`[sunbiz-dl] ${(cur/1024/1024).toFixed(1)} MB downloaded`);
        if (onProgress) onProgress(cur);
        lastLog = Date.now();
      }
    });

    proc.on('close', code => {
      const finalSize = fs.existsSync(LOCAL_FILE) ? fs.statSync(LOCAL_FILE).size : 0;
      console.log(`[sunbiz-dl] curl exited ${code} — final size: ${(finalSize/1024/1024).toFixed(1)} MB`);
      if (code === 0 || finalSize > localSize) resolve(finalSize);
      else reject(new Error(`curl exited ${code}`));
    });
  });
}

module.exports = { downloadSunbiz, LOCAL_FILE, LOCAL_DIR };

if (require.main === module) {
  downloadSunbiz().then(size => {
    console.log(`[sunbiz-dl] Done: ${(size/1024/1024).toFixed(1)} MB`);
    process.exit(0);
  }).catch(e => {
    console.error('[sunbiz-dl] Failed:', e.message);
    process.exit(1);
  });
}
