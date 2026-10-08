-- Slice 58 (2026-10-05): service checks, step 1 of SLICE-SERVICE-CHECKS-PLAN.md.
--
-- A check is an entity with source = 'probe' (slice 57): its definition in
-- extra, its readings in samples and the lv_* columns like any sensor's. Two
-- things it needs that a sensor did not:
--
-- lv_peer: the address the last run connected to. A check by NAME resolves on
-- every run, and when a SaaS front end moves, "which address answered" is the
-- first question - so the card shows it. One value, overwritten each run, and
-- deliberately not history: samples hold numbers, and an address per run per
-- check is a corpus nobody asked for.
--
-- entities_probe_idx: the collector loads the checks every minute and the
-- alert scan reads them every scan, both by source. On a 30,000-entity fleet
-- with a handful of checks, the partial index is a few rows instead of a
-- sequential pass over every interface the fleet has.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_peer text;

CREATE INDEX IF NOT EXISTS entities_probe_idx ON entities (device_id) WHERE source = 'probe';
