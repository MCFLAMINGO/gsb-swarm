-- Migration 059: Retention cleanup — trim unbounded log tables
-- Runs once on deploy to clear old data. Ongoing cleanup via cleanupWorker.

-- usage_ledger: keep 90 days (billing audit window)
DELETE FROM usage_ledger
WHERE created_at < NOW() - INTERVAL '90 days';

-- sms_query_log: keep 30 days
DELETE FROM sms_query_log
WHERE created_at < NOW() - INTERVAL '30 days';

-- chat_log: keep 60 days
DELETE FROM chat_log
WHERE created_at < NOW() - INTERVAL '60 days';

-- resolution_history: keep 180 days (alias learning needs history)
DELETE FROM resolution_history
WHERE created_at < NOW() - INTERVAL '180 days';

-- Reclaim freed space immediately
VACUUM (ANALYZE) usage_ledger;
VACUUM (ANALYZE) sms_query_log;
VACUUM (ANALYZE) chat_log;
VACUUM (ANALYZE) resolution_history;

-- Also reclaim bloat from lock-contention dead tuples on businesses
VACUUM (ANALYZE) businesses;
