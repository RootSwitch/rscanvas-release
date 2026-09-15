-- Slice 48 (from the 2026-09-01 review): ping_samples gets the index its own
-- design note promised.
--
-- slice36 justified a plain table because "an indexed delete by age is
-- honest" - and then indexed only (device_id, ts), which cannot serve the
-- hourly prune's bare `ts <` predicate (prunePingSamples in ops.ts). At the
-- 30-day default and the slice's own ceiling arithmetic that is an hourly
-- full-table scan of tens of millions of rows, on the jobs lane, which has
-- no statement timeout - delaying the same job that prunes alerts,
-- notifications and windows.
--
-- A btree rather than BRIN, deliberately. BRIN looks made for an
-- insert-ordered timestamp, but it needs the physical order to STAY
-- physical: the hourly DELETE frees old pages, new inserts refill them with
-- new timestamps, and every block range widens until the index scans
-- everything while reporting itself used. A churning table is the one shape
-- BRIN quietly degrades on, and quiet degradation in the prune path is the
-- failure this index exists to remove.

CREATE INDEX IF NOT EXISTS ping_samples_ts_idx ON ping_samples (ts);
