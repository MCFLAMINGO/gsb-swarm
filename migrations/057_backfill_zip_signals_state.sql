-- Migration 057: backfill state='FL' for all zip_signals rows missing state
-- Root cause: upsertZipSignals() never writes the state column, so any ZIP
-- row created/updated by a worker after migration 017 seeded only its own
-- zip_intelligence subset ends up with state=NULL. Since this is a FL-only
-- database (all ZIPs sourced from flZipRegistry) every row should be 'FL'.
-- This fixes tradeSignalWorker's WHERE state='FL' returning zipCount=1.

UPDATE zip_signals
SET state = 'FL'
WHERE state IS NULL;
