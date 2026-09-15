-- Slice 1 schema, applied ADDITIVELY on top of the spike corpus in
-- rscanvas_spike.
--
-- Why additive rather than a fresh database: slice 1's done-when criteria cite
-- a measured envelope (filtered search 262 to 277ms cold, in-window free-text
-- about 109ms) and those figures only mean anything against the corpus they
-- were measured on - 50 million syslog rows across 14 daily partitions. A
-- different corpus makes the criteria unfalsifiable, which is worse than
-- having no criteria.
--
-- WHY THIS IS SAFE, stated rather than assumed. There is no DROP in this file,
-- and there is no DROP anywhere in slice 1: retention, partition expiry and
-- trigram ageing are all slice 5, which is out of scope. Slice 1 has no code
-- path that can destroy the fixture. That is the guard, and it is a structural
-- one rather than a promise to be careful. Care is not sufficient here:
-- locktest.ts destroyed 158GB of seeded corpus while being careful, by calling
-- the real retention job with keep_days = 0 to guarantee it had something to
-- drop.
--
-- Everything below is IF NOT EXISTS and safe to run repeatedly.

-- --- proto -------------------------------------------------------------------
-- The ingest worker owns two sockets, syslog and traps, writing into one table.
-- Without a discriminator a trap is indistinguishable from a syslog message
-- that happens to look like one, and "show me only traps" cannot be expressed.
--
-- The parent carried this column (syslogcanvas/server/store.js writes proto on
-- every row); the spike schema dropped it because the spike had no trap path.
-- Restoring it here keeps the parent's contract.
--
-- ADD COLUMN with no default and no NOT NULL is a catalogue-only change in
-- PostgreSQL 11 and later: no table rewrite, no scan, constant time regardless
-- of the 50 million existing rows. Existing rows read back NULL, which is
-- honest - they predate the distinction rather than being known to be syslog.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS proto text;

-- --- UTC, at the database ---------------------------------------------------
--
-- The pool passes `-c TimeZone=UTC` and the partition, rollup and retention
-- functions SET LOCAL on top. Neither covers a connection that never goes
-- through the pool: an operator in psql, the spike harness with its own
-- client, any future tool. That is finding 10's original scenario exactly - a
-- hand-created partition bound resolving to LOCAL midnight and producing an
-- overlapping boundary (the CREATE fails, the day's partition never appears)
-- or a gapped one (a COPY for a row in the gap fails). Both end at the failed
-- COPY where the never-drop invariant was already lost once.
--
-- Set on the DATABASE, so every session inherits it whatever the client. The
-- pool's option becomes reinforcement rather than the only guard, which is the
-- same doctrine that put the guards inside the retention function rather than
-- around it.
--
-- current_database() cannot be used directly in ALTER DATABASE, so the name is
-- interpolated. Idempotent, and it takes effect on new sessions.
DO $$ BEGIN
    EXECUTE format('ALTER DATABASE %I SET timezone = %L', current_database(), 'UTC');
END $$;

-- --- indexes the read path needs ---------------------------------------------
-- Both already exist on the lab corpus from the spike's phase 2 and phase 4.
-- Repeated here so a fresh database gets a working slice 1 rather than one
-- that silently falls back to sequential scans, and so this file is the whole
-- story rather than a diff against a session that is over.
--
-- messages_host_ts_idx is the index the realistic search actually uses: the
-- plan takes it and discards non-matching rows with a filter, because once the
-- device and the window have run there are only a few hundred rows left. The
-- trigram index is NOT used by that query. It exists for the case where the
-- operator does not yet know the device.
CREATE INDEX IF NOT EXISTS messages_host_ts_idx ON messages (host, ts DESC);
CREATE INDEX IF NOT EXISTS messages_source_ip_idx ON messages (source_ip, ts DESC);

-- --- partition creation ------------------------------------------------------
-- ensure_daily_partitions already exists on the lab corpus from the spike's
-- schema.sql. CREATE OR REPLACE so a fresh database gets it, and so the
-- definition lives with the code that calls it rather than only in the spike.
--
-- This CREATES and never drops. Dropping is slice 5.
--
-- SECURITY DEFINER, DECLARED HERE RATHER THAN APPLIED AFTERWARDS.
-- `CREATE TABLE ... PARTITION OF` requires ownership of the parent, and on a
-- database hardened by tools/harden-roles.sh the application role deliberately
-- does not have it - that is what stops any code path from dropping a
-- partition. This function is how the writer still creates tomorrow's.
--
-- It is in the definition because the first attempt bolted it on with
-- ALTER FUNCTION, and the very next `apply-schema --with-retention` silently
-- reverted all three functions to SECURITY INVOKER: CREATE OR REPLACE resets
-- every attribute the new definition does not restate. The hardening survived
-- eleven minutes. A property that a routine re-apply can quietly remove is not
-- a property, and it fails in the direction where partition creation stops and
-- the never-drop invariant goes with it.
--
-- search_path is pinned for the usual reason: a SECURITY DEFINER function
-- without it can be hijacked by a caller who shadows a table name from their
-- own schema. On an unhardened database the owner is the app role and both
-- clauses are no-ops.
CREATE OR REPLACE FUNCTION ensure_daily_partitions(
    tbl text, first_day date, last_day date
) RETURNS int LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    d date := first_day;
    made int := 0;
    part text;
BEGIN
    -- Finding 10. Bounds come from date literals, and for a timestamptz column
    -- '2026-07-27' means midnight in the CREATING SESSION's zone - so sessions
    -- with different zones produce overlapping bounds (the CREATE fails and the
    -- day's partition never appears) or gapped ones (a COPY for a row in the
    -- gap fails). Both end in a failed COPY, which is where the never-drop
    -- invariant was already lost once.
    SET LOCAL TimeZone = 'UTC';

    WHILE d <= last_day LOOP
        part := format('%s_%s', tbl, to_char(d, 'YYYYMMDD'));
        IF to_regclass(part) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                part, tbl, d, d + 1);
            made := made + 1;
        END IF;
        d := d + 1;
    END LOOP;
    RETURN made;
END $$;
