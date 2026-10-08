-- Slice 57 (2026-10-05): where an entity's readings come from.
--
-- Step 0 of SLICE-SERVICE-CHECKS-PLAN.md, landing alone and changing nothing.
-- Until now every entity was read from an SNMP agent, so the store told
-- sensors from interfaces with `kind <> 'if'` and that predicate silently
-- meant "a sensor an SNMP agent serves". Service checks and path tests are
-- entities RSCanvas measures itself, and each of those predicates would have
-- taken them for SNMP sensors: the sensor poller would have walked a check's
-- definition as if it were an OID, the backfill would have counted it as
-- inventory, and the threshold scan would have judged its freshness by the
-- device's SNMP interval (three polls, 90 s at the default) - stale nearly
-- always for a test that runs hourly, and never scanned at all on a device
-- with SNMP off. DIGEST section 6's lesson
-- again, one table over from reach_check: a predicate written before the
-- values it would meet fails quiet when they arrive.
--
-- So the meaning becomes a column: 'snmp' (an agent serves it - every row
-- that exists, by default) or 'probe' (RSCanvas measures it). Every
-- non-interface query in src/store/ names the source it means, and
-- tools/check-entity-source.mjs refuses one that does not.
--
-- A constant default makes the column catalogue-only to add. The CHECK
-- scans the table once, which at the 30,000-entity ceiling is milliseconds.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'snmp';

DO $$ BEGIN
    ALTER TABLE entities ADD CONSTRAINT entities_source_known CHECK (source IN ('snmp', 'probe'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
