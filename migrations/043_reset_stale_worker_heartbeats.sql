-- B86: reset stale worker heartbeats so workers re-run on next deploy
-- beaWorker and lodesWorker ran once in May 2026 with process.exit dropping writes — data is empty
DELETE FROM worker_heartbeat WHERE worker_name IN ('beaWorker', 'lodesWorker');
