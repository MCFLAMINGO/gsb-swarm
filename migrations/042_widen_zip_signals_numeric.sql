-- Migration 042: widen tight NUMERIC columns on zip_signals
-- Fixes: "numeric field overflow" every ~30 min from worldModelWorker.
-- Root cause: NUMERIC(8,3) caps at 99999.999. biz_density_per_1k = (bizCount/pop)*1000
-- can exceed this when population is very low (rural ZIPs) or business count is high.
-- job_capture_ratio = lodes_jobs / qcew_employment can also blow past 99999 when
-- denominators are tiny.

ALTER TABLE zip_signals
  ALTER COLUMN sig_biz_density_per_1k TYPE NUMERIC(15,3);

ALTER TABLE zip_signals
  ALTER COLUMN sig_job_capture_ratio  TYPE NUMERIC(15,3);
