'use strict';
require('dotenv').config();
const db = require('../lib/db');

async function main() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS call_transcripts (
      id                 SERIAL PRIMARY KEY,
      call_sid           TEXT UNIQUE NOT NULL,
      caller_id          TEXT,
      recording_url      TEXT,
      transcription_text TEXT,
      duration_sec       INTEGER,
      zip                TEXT,
      channel            TEXT DEFAULT 'voice',
      status             TEXT DEFAULT 'pending',
      created_at         TIMESTAMPTZ DEFAULT NOW(),
      updated_at         TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_call_transcripts_created
      ON call_transcripts(created_at DESC)
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_call_transcripts_caller
      ON call_transcripts(caller_id)
  `);
  console.log('B11 migration complete — call_transcripts table ready');
  process.exit(0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
