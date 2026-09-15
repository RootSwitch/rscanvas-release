-- Slice 19: the trigram sync becomes a pure reporter.
--
-- WHAT THE SOAK FOUND, 2026-08-22. needs-drop failed on lab-stresstest with
-- "must be owner of index messages_20260818_msg_trgm", and the census showed
-- why: every trigram index the function had built INLINE (on empty future
-- partitions, as a SECURITY DEFINER function does, as its owner) belonged to
-- rscanvas_owner, while the jobs worker drops as the app role. Dropping needs
-- ownership, not a grant. The one partition that did shed its pair (0817)
-- had been indexed before the inline path existed. minipc was the control:
-- never hardened, so the app role owns everything there, and its drops work.
--
-- The second half of the finding is the one that decides the design: on a
-- hardened database the app role cannot CREATE an index at all ("must be
-- owner of table"), so the worker's CONCURRENTLY build path had never worked
-- there either - masked because the inline path pre-indexed every partition
-- while it was still empty. CREATE/DROP INDEX CONCURRENTLY cannot run inside
-- a function, so neither half can move INTO this function; both must run in
-- a session as a role that owns the tables. That is the jobs worker's new
-- maintenance lane (src/store/lanes.ts), connecting as rscanvas_admin with
-- the credential the installer already writes for apply-schema.
--
-- So this function no longer creates or drops anything. It reports: which
-- partition:column pairs inside the window lack an index (needs-index) and
-- which outside it still carry one (needs-drop). One owner for every trgm
-- index - the role that will drop it - and no SHARE lock on a partition the
-- ingest writer may be using, ever, because nothing is built here.
--
-- Still SECURITY DEFINER with a pinned search_path: the attribute set is
-- enforced by apply-schema on every hardened database, and a reporter that
-- reads pg_inherits needs nothing more. Ownership of the function itself is
-- reasserted by tools/harden-roles.sh - a schema applied as the superuser
-- leaves it owned by postgres, and a definer function owned by postgres runs
-- as the superuser.

DROP FUNCTION IF EXISTS sync_recent_trgm_indexes(text, int);

CREATE OR REPLACE FUNCTION sync_recent_trgm_indexes(tbl text, keep_days int)
RETURNS TABLE(action text, partition_name text) LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    cutoff    date;
    part      record;
    idx_name  text;
    part_date date;
    col       text;
    suffix    text;
BEGIN
    SET LOCAL TimeZone = 'UTC';
    -- Assigned HERE, not in DECLARE: plpgsql evaluates DECLARE initializers
    -- on block entry, BEFORE the SET LOCAL above runs, so an initializer
    -- reading current_date would take LOCAL midnight from whatever zone the
    -- session connected in - the exact one-day drift against UTC-bounded
    -- partition names the SET exists to prevent.
    cutoff := current_date - keep_days;

    FOR part IN
        SELECT c.relname, c.oid
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = tbl::regclass
           AND c.relname ~ ('^' || tbl || '_[0-9]{8}$')
         ORDER BY c.relname
    LOOP
        part_date := to_date(right(part.relname, 8), 'YYYYMMDD');

        FOREACH col IN ARRAY ARRAY['msg', 'host'] LOOP
            suffix   := CASE col WHEN 'msg' THEN '_msg_trgm' ELSE '_host_trgm' END;
            idx_name := part.relname || suffix;

            IF part_date >= cutoff THEN
                IF to_regclass(idx_name) IS NULL THEN
                    action := 'needs-index'; partition_name := part.relname || ':' || col;
                    RETURN NEXT;
                END IF;
            ELSE
                IF to_regclass(idx_name) IS NOT NULL THEN
                    action := 'needs-drop'; partition_name := part.relname || ':' || col;
                    RETURN NEXT;
                END IF;
            END IF;
        END LOOP;
    END LOOP;
END $$;

COMMENT ON FUNCTION sync_recent_trgm_indexes(text, int) IS
    'Trigram index maintenance, REPORT ONLY: needs-index for partition:column '
    'pairs inside the window without an index, needs-drop for pairs outside it '
    'that still carry one. The caller builds and drops CONCURRENTLY on the '
    'maintenance lane as an owning role; nothing is created or dropped here, '
    'so no partition the ingest writer uses is ever locked and every trgm '
    'index is owned by the role that will drop it (slice 19).';
