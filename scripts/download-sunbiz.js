#!/usr/bin/env node
/**
 * scripts/download-sunbiz.js
 * Downloads cordata.zip from FL Sunbiz via SFTP (port 22, pure Node ssh2).
 * Resumes from partial file. Runs on Railway without curl/subprocess deps.
 *
 * SFTP creds are public — not secret.
 */
'use strict';

const SftpClient = require('ssh2-sftp-client');
const fs   = require('fs');
const path = require('path');

const SFTP_HOST   = 'sftp.floridados.gov';
const SFTP_USER   = 'Public';
const SFTP_PASS   = 'PubAccess1845!';
const REMOTE_PATH = 'doc/quarterly/cor/cordata.zip';  // no leading slash — sftp root is already /

const LOCAL_DIR  = process.env.DATA_DIR
  ? path.join(process.env.DATA_DIR, 'sunbiz')
  : path.join(__dirname, '../data/sunbiz');
const LOCAL_FILE = path.join(LOCAL_DIR, 'cordata.zip');

async function downloadSunbiz(onProgress) {
  fs.mkdirSync(LOCAL_DIR, { recursive: true });

  const localSize = fs.existsSync(LOCAL_FILE) ? fs.statSync(LOCAL_FILE).size : 0;
  console.log(`[sunbiz-dl] Local: ${(localSize / 1024 / 1024).toFixed(1)} MB — connecting to ${SFTP_HOST}`);

  const sftp = new SftpClient();
  await sftp.connect({
    host:     SFTP_HOST,
    port:     22,
    username: SFTP_USER,
    password: SFTP_PASS,
    readyTimeout: 30000,
    retries: 3,
    retry_minTimeout: 5000,
  });

  try {
    const stat = await sftp.stat(REMOTE_PATH);
    const remoteSize = stat.size;
    console.log(`[sunbiz-dl] Remote: ${(remoteSize / 1024 / 1024).toFixed(1)} MB`);

    if (localSize >= remoteSize) {
      console.log('[sunbiz-dl] Already complete.');
      return localSize;
    }

    const writeFlags = localSize > 0 ? 'a' : 'w';
    const outStream  = fs.createWriteStream(LOCAL_FILE, { flags: writeFlags, start: localSize });

    let downloaded = localSize;
    let lastLog    = Date.now();

    const readStream = await sftp.createReadStream(REMOTE_PATH, {
      start: localSize,
      autoClose: true,
    });

    await new Promise((resolve, reject) => {
      readStream.on('data', chunk => {
        downloaded += chunk.length;
        if (Date.now() - lastLog > 30000) {
          const pct = ((downloaded / remoteSize) * 100).toFixed(1);
          console.log(`[sunbiz-dl] ${(downloaded/1024/1024).toFixed(1)} MB / ${(remoteSize/1024/1024).toFixed(1)} MB (${pct}%)`);
          if (onProgress) onProgress(downloaded, remoteSize);
          lastLog = Date.now();
        }
      });
      readStream.on('error', reject);
      outStream.on('error', reject);
      outStream.on('close', resolve);
      readStream.pipe(outStream);
    });

    const finalSize = fs.statSync(LOCAL_FILE).size;
    console.log(`[sunbiz-dl] Done: ${(finalSize / 1024 / 1024).toFixed(1)} MB`);
    return finalSize;

  } finally {
    await sftp.end().catch(() => {});
  }
}

module.exports = { downloadSunbiz, LOCAL_FILE, LOCAL_DIR };

if (require.main === module) {
  downloadSunbiz()
    .then(size => { console.log(`Complete: ${(size/1024/1024).toFixed(1)} MB`); process.exit(0); })
    .catch(e  => { console.error('[sunbiz-dl] Fatal:', e.message); process.exit(1); });
}
