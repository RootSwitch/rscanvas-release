-- Retention. Kept OUT of slice5.sql on purpose.
--
-- `src/db/apply-schema.ts` refuses any slice file containing DROP, and this
-- file necessarily contains one - the whole point of the function below is to
-- drop a partition. That guard is not weakened to accommodate it. Instead this
-- file is excluded from the default `slice<N>.sql` glob and installed only by
-- `node src/db/apply-schema.ts --with-retention`.
--
-- ALL THE GUARDS ARE INSIDE THE FUNCTION, not in the caller. The caller is
-- exactly what was careful last time and still lost 158GB: spike/src/locktest.ts
-- called this function's ancestor with keep_days = 0 to guarantee it had
-- something to drop, and it dropped all fourteen partitions.
--
-- By that same doctrine the LOCK_TIMEOUT belongs inside too. Rule 7 is not a
-- property of whoever happens to call this.

-- Adding the lock_timeout parameter creates an OVERLOAD rather than replacing,
-- and then every call with the old arity resolves to the old body while
-- `COMMENT ON FUNCTION` becomes ambiguous and aborts the whole file. Removing
-- the previous signature explicitly is what makes this a replacement.
--
-- This is a function, not data. It is also why this file is the one excluded
-- from the additive-only guard.
DROP FUNCTION IF EXISTS drop_partitions_guarded(text, int, int, int, int, int, boolean);

-- THE UNGUARDED ANCESTORS, REMOVED. This is the file that installs the guarded
-- retention function, so it is the file that takes away the ways around it.
--
-- Both were defined in spike/sql/schema.sql and were therefore still installed
-- on the lab, long after the guarded function existed. Five guards on one
-- function mean nothing while two unguarded doors stand open beside it:
--
--   drop_partitions_older_than(tbl, keep_days)
--       Target discovered by scan. No floor, so keep_days = 0 drops the entire
--       history - the literal call that destroyed 158GB. No max_drop, no
--       min_keep, no dry_run, no lock_timeout. And it still had a live caller:
--       spike/src/run.ts ran it mid-measurement with DROP_PARTITION defaulting
--       ON, finding nothing only because the fixture was younger than its own
--       retention horizon. From about 2026-08-01 that stops being true.
--
--   drop_oldest_partition(tbl)
--       Worse, because there is nothing to relax: it DISCOVERS its victim (the
--       first child by name sort, not even filtered to date-named children) and
--       drops it. One psql call, one partition gone, zero parameters between an
--       operator and the corpus.
--
-- Dropping them is not housekeeping. It is what makes the five guards actually
-- the retention path rather than merely the recommended one.
DROP FUNCTION IF EXISTS drop_partitions_older_than(text, int);
DROP FUNCTION IF EXISTS drop_oldest_partition(text);

CREATE OR REPLACE FUNCTION drop_partitions_guarded(
    tbl           text,
    keep_days     int,
    min_keep_days int     DEFAULT 7,
    max_drop      int     DEFAULT 3,
    min_keep      int     DEFAULT 2,
    max_span_days int     DEFAULT 31,
    dry_run       boolean DEFAULT false,
    lock_timeout  text    DEFAULT '2s'
) RETURNS TABLE(action text, partition_name text, span_days int) LANGUAGE plpgsql
  -- SECURITY DEFINER, and here this is the load-bearing line of the whole file.
  --
  -- tools/harden-roles.sh takes DROP away from the role the application and the
  -- tools connect as, by giving ownership of every table to a role nothing logs
  -- in as. That is what makes the five guards below unavoidable rather than
  -- merely recommended: with the privilege withheld, this function is not the
  -- best path to dropping a partition, it is the ONLY one.
  --
  -- Which means this attribute is what keeps retention working at all. Declared
  -- in the definition, because applying it with ALTER FUNCTION lasted exactly
  -- one `apply-schema --with-retention` - CREATE OR REPLACE silently resets
  -- every attribute the new definition does not restate.
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    cutoff      timestamptz;
    victim      record;
    total       int;
    names       text[] := '{}';
    los         timestamptz[] := '{}';
    his         timestamptz[] := '{}';
    eligible    int;
    dropping    int;
    i           int;
    span        numeric;
    frontier    timestamptz;

    -- Databases whose partitions are a MEASUREMENT CORPUS rather than data a
    -- deployment depends on. Losing one costs days of reseeding and invalidates
    -- every recorded figure that was measured against it.
    --
    -- Named here rather than detected, because there is no property of a
    -- database that distinguishes "fixture" from "production" - only the
    -- intention of whoever built it.
    protected   text[] := ARRAY['rscanvas_spike'];

    -- Advisory lock identity. Postgres advisory locks are a single global
    -- namespace shared with anything else using this database, so the first
    -- number scopes them to this application and the second names the job.
    -- 0x52530000 spells "RS". Keep these in step with sql/slice5.sql.
    RSCANVAS_LOCK_NS constant int := 1381253120;   -- 0x52530000
    LOCK_RETENTION   constant int := 2;
BEGIN
    -- Finding 10, inside the function because an operator running this from
    -- psql does not come through the pool that pins UTC. `current_date` below
    -- is LOCAL midnight, and against UTC-bounded partitions that shifts
    -- eligibility by up to a day - so "keep 14 days" silently becomes 13 to 15
    -- depending on where the job connects from.
    SET LOCAL TimeZone = 'UTC';

    -- Assigned HERE, not in DECLARE: plpgsql evaluates DECLARE initializers on
    -- block entry, BEFORE the SET LOCAL above runs. For the whole time cutoff
    -- was a DECLARE initializer, the finding-10 guard guarded nothing - the
    -- one value it exists to pin was computed a line too early, in the
    -- session's own zone (found by the 2026-09-01 review).
    cutoff := (current_date - keep_days)::timestamptz;

    -- GUARD 0, FIXTURE-GUARD LAYER 3: an environmental interlock.
    --
    -- BUILD-PLAN has claimed this layer existed since before slice 5 and it did
    -- not. Its absence is not merely that one check was missing: the 22GB
    -- post-mortem counted four layers present, concluded the guards were
    -- adequate and the caller was at fault, and therefore fixed a call site
    -- rather than the class - leaving a second identical call in the same file.
    -- A false premise about what protection exists produces a fix scoped to the
    -- instance.
    --
    -- WHAT MAKES THIS DIFFERENT FROM GUARDS 1 TO 5. Those reason about the
    -- REQUEST: is the horizon sane, is the partition too wide, has the rollup
    -- consumed it. Every one of them can be satisfied by a request that is
    -- entirely legitimate and still catastrophic, which is exactly what
    -- happened - `drop_partitions_guarded('samples', 7, ...)` passed all five
    -- and destroyed 172.8 million rows, because the request was correct and the
    -- TARGET was the measurement corpus.
    --
    -- So this one reasons about the target instead, and it is the only guard
    -- that does. Deliberately a DENY-list: this is product code whose job is to
    -- drop, so an unrecognised database - a real deployment - must work
    -- normally. The mirror check in src/safety.ts is an ALLOW-list for exactly
    -- the opposite reason, and the asymmetry is the point rather than an
    -- oversight.
    --
    -- The flag is a session GUC, set from ALLOW_FIXTURE_DROPS by the pool
    -- (src/store/pool.ts) or typed by an operator in psql. Absent reads as
    -- REFUSE, per the fail-closed rule: a guard whose absent input is
    -- permission is not a guard.
    IF NOT dry_run AND current_database() = ANY (protected)
       AND coalesce(current_setting('rscanvas.allow_fixture_drops', true), '') <> '1' THEN
        RAISE EXCEPTION 'refusing: % is a protected fixture database and this is not a dry run', current_database()
            USING HINT = 'set ALLOW_FIXTURE_DROPS=1 (or SET rscanvas.allow_fixture_drops = ''1'') '
                         'if destroying corpus partitions is genuinely the intent';
    END IF;

    -- GUARD 0b: ONE RETENTION RUN AT A TIME, ACROSS PROCESSES.
    --
    -- ARCHITECTURE.md claimed this existed for months and it did not; the drift
    -- audit found the claim and this is the thing being made true. Single-flight
    -- was `runOnce`, an in-process Set, which does not survive the normal way a
    -- shared org deployment is updated: a ROLLING DEPLOY runs two instances at
    -- once by design.
    --
    -- Two retention runs racing against one database is precisely the case
    -- guards 1 to 5 cannot cover, because each instance passes all five
    -- individually - they reason about the REQUEST, and both requests are
    -- correct. Only something that reasons about the whole database can see
    -- that there are two of them.
    --
    -- TRANSACTION-scoped rather than session-scoped, which is a deliberate
    -- difference from "held for the run, released on exit". A session lock has
    -- to be held on ONE connection for the worker's lifetime, and the jobs lane
    -- has max 2 - so it would permanently consume half the lane and serialise
    -- rollup against retention, which are independent by design. An xact lock
    -- is held exactly as long as this function runs, needs no dedicated
    -- connection, and protects against ANY caller including an operator in
    -- psql, which a worker-level lock would not.
    --
    -- Its own key, not shared with the rollup: those two are meant to run
    -- concurrently, and their ordering constraint is guard 5, not a lock.
    --
    -- Skip-and-report, like guards 4 and 5. Losing this race is retention
    -- working correctly, so it must not read as a failure - `isJobsHealthy`
    -- alarms on three consecutive failures and a routine skip would trip it.
    IF NOT pg_try_advisory_xact_lock(RSCANVAS_LOCK_NS, LOCK_RETENTION) THEN
        action := 'skipped-locked';
        partition_name := tbl;
        span_days := 0;
        RETURN NEXT;
        RETURN;
    END IF;

    -- GUARD 1: a horizon below the floor. keep_days = 0 asks for everything.
    -- The only guard that RAISES, because it is the only one describing a
    -- misconfiguration rather than a condition to work through gradually.
    IF keep_days < min_keep_days THEN
        RAISE EXCEPTION 'refusing: keep_days % is below the floor of % for %',
            keep_days, min_keep_days, tbl
            USING HINT = 'keep_days = 0 asks to drop the entire history';
    END IF;

    -- GUARD 3'S DENOMINATOR: partitions that hold HISTORY, not all children.
    --
    -- This counted every child, and that made guard 3 dead code. Both writers
    -- keep PARTITION_LOOKAHEAD_DAYS=7 of EMPTY FUTURE partitions plus today's,
    -- so `total` is permanently inflated by about eight. The check below is
    -- `total - dropping < min_keep`, and with min_keep 2 against a total that
    -- can never fall under 8, it cannot fire in production - while its comment
    -- promises "there is always a history".
    --
    -- What that permitted: MESSAGE_RETENTION_DAYS fat-fingered from 30 to 8
    -- passes guard 1 (the floor is 7), roughly 22 partitions become eligible,
    -- guard 2 drains three per hourly run, and eight hours later 30 days of
    -- syslog is 8 days - with guard 3, the last-ditch floor, never once
    -- engaging because empty future partitions kept the count comfortable.
    -- Worse in the ingest-outage variant: all history aged out, only lookahead
    -- partitions left, and it approves dropping the final data-bearing ones.
    --
    -- `hi <= now()` is the whole fix. A partition whose upper bound is in the
    -- future holds at most a few minutes of the present and is not history.
    SELECT count(*) INTO total
      FROM pg_inherits inh JOIN pg_class c ON c.oid = inh.inhrelid
     WHERE inh.inhparent = tbl::regclass
       AND coalesce(
             ((regexp_match(pg_get_expr(c.relpartbound, c.oid),
                            'FROM \(''([^'']+)''\) TO \(''([^'']+)''\)'))[2])::timestamptz,
             'infinity'::timestamptz) <= now();

    -- GUARD 5's input: how far the rollup has consumed raw samples.
    --
    -- Only `samples` has a downstream consumer whose progress can lag. NULL
    -- means the rollup has never run, which guard 5 treats as "nothing is
    -- consumed" rather than as "no constraint" - absent input is not
    -- permission.
    IF tbl = 'samples' THEN
        SELECT through_ts INTO frontier FROM job_state WHERE job = 'rollup';
    END IF;

    -- Collect the expired partitions, OLDEST FIRST.
    --
    -- Ordering matters now that guard 2 drops a prefix rather than refusing:
    -- when only some can go this run, the oldest are the ones to take.
    FOR victim IN
        SELECT c.relname AS name,
               (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                             'FROM \(''([^'']+)''\) TO \(''([^'']+)''\)'))[1] AS lo,
               (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                             'FROM \(''([^'']+)''\) TO \(''([^'']+)''\)'))[2] AS hi
          FROM pg_inherits inh JOIN pg_class c ON c.oid = inh.inhrelid
         WHERE inh.inhparent = tbl::regclass
         ORDER BY 2
    LOOP
        CONTINUE WHEN victim.lo IS NULL OR victim.hi IS NULL;
        CONTINUE WHEN victim.hi::timestamptz > cutoff;

        -- GUARD 4, applied HERE rather than after guards 2 and 3.
        --
        -- A too-wide partition is excluded from the eligible set entirely, not
        -- counted and then skipped. Counting it first was a real bug: the
        -- 122-day pre-cutover rollup partition would permanently occupy one of
        -- guard 2's three slots and inflate guard 3's arithmetic, so the rollup
        -- table would wedge after two missed monthly runs instead of three -
        -- and the wide partition can never be dropped to relieve it.
        --
        -- What it protects: the pre-cutover partition holds the only copy of
        -- everything from before raw retention begins. It generalises past that
        -- one migration to any wide partition however it came to exist.
        span := EXTRACT(epoch FROM (victim.hi::timestamptz - victim.lo::timestamptz)) / 86400;
        IF span > max_span_days THEN
            action := 'skipped-too-wide';
            partition_name := victim.name;
            span_days := round(span)::int;
            RETURN NEXT;
            CONTINUE;
        END IF;

        -- GUARD 5: never drop raw samples the rollup has not consumed.
        --
        -- THE FAILURE THIS PREVENTS IS INVISIBLE TO BOTH JOBS SEPARATELY, which
        -- is exactly why the check has to live here. The rollup wedges - a
        -- lock_timeout losing streak, the jobs worker down, a bad deploy.
        -- Retention is a DIFFERENT job on a DIFFERENT schedule and keeps
        -- running happily. Day 15 arrives and it drops the oldest raw
        -- partition. Those hours are now gone from raw AND absent from hourly,
        -- permanently, and every guard did exactly what it was told.
        --
        -- Charts then show a hole that nothing in either job's log explains.
        -- The rollup is the ONLY copy past raw retention, so this is a one-way
        -- door in section 0b's sense.
        --
        -- Skip-and-report, the same shape as guard 4, because that is what
        -- makes the two jobs safe to schedule INDEPENDENTLY - which is the only
        -- way they will actually be scheduled. Retention simply waits for the
        -- rollup to catch up, and says it is waiting.
        IF tbl = 'samples' THEN
            IF frontier IS NULL OR victim.hi::timestamptz > frontier THEN
                action := 'deferred-unrolled';
                partition_name := victim.name;
                span_days := round(span)::int;
                RETURN NEXT;
                CONTINUE;
            END IF;
        END IF;

        names := names || victim.name;
        los   := los   || victim.lo::timestamptz;
        his   := his   || victim.hi::timestamptz;
    END LOOP;

    eligible := coalesce(array_length(names, 1), 0);
    IF eligible = 0 THEN
        RETURN;
    END IF;

    -- GUARD 2: at most max_drop per run - by DROPPING A PREFIX, not refusing.
    --
    -- This raised, and raising made the condition permanent. Refusing drops
    -- nothing, so the eligible count never decreased: miss four daily runs and
    -- 4 > 3 raises, tomorrow it is 5, and retention is wedged forever while
    -- disk grows 11GB a day - resolvable only by the manual DROP these guards
    -- exist to make unnecessary. Its own hint said "expire gradually over
    -- several runs", which is precisely what refusing prevents.
    --
    -- Now it takes the oldest max_drop and reports the rest as deferred, so
    -- each run makes progress and a backlog drains over several runs.
    dropping := least(eligible, max_drop);

    -- GUARD 3: never leave fewer than min_keep. There is always a history.
    -- Applied against what will ACTUALLY be dropped this run.
    IF total - dropping < min_keep THEN
        RAISE EXCEPTION 'refusing: dropping % of % partitions of % would leave %, below min_keep %',
            dropping, total, tbl, total - dropping, min_keep;
    END IF;

    -- RULE 7, inside the function. Retention is never urgent, so it gives up
    -- and retries later rather than queueing the application behind itself.
    --
    -- The measured collision it prevents: DROP TABLE takes ACCESS EXCLUSIVE on
    -- the partition AND its parent, and a waiting exclusive request sits at the
    -- HEAD of the lock queue, so every query arriving afterwards waits behind
    -- it even though it would never have conflicted with the reader already
    -- running. A 3.7s reader made a drop wait 1.3s and blocked an unrelated
    -- dashboard query for 609ms against a 1.7ms norm - and it scales with the
    -- reader, so a permitted 456-second export would stall every dashboard for
    -- minutes. This runs on the jobs lane, which has NO statement timeout, so
    -- without this the wait is unbounded.
    EXECUTE format('SET LOCAL lock_timeout = %L', lock_timeout);

    FOR i IN 1 .. dropping LOOP
        action         := CASE WHEN dry_run THEN 'would-drop' ELSE 'dropped' END;
        partition_name := names[i];
        span_days      := round(EXTRACT(epoch FROM (his[i] - los[i])) / 86400)::int;
        IF NOT dry_run THEN
            EXECUTE format('DROP TABLE %I', names[i]);
        END IF;
        RETURN NEXT;
    END LOOP;

    -- What is left for next time, named rather than silent. A caller that sees
    -- 'deferred' rows knows a backlog exists and that progress is being made.
    FOR i IN dropping + 1 .. eligible LOOP
        action         := 'deferred';
        partition_name := names[i];
        span_days      := round(EXTRACT(epoch FROM (his[i] - los[i])) / 86400)::int;
        RETURN NEXT;
    END LOOP;
END $$;

-- --- trigram index maintenance -------------------------------------------------
--
-- NO LONGER DEFINED IN THIS FILE. sync_recent_trgm_indexes lives in
-- sql/slice19.sql as a pure reporter - it creates and drops nothing, so the
-- reason it once had to live here (a body containing DROP INDEX, which
-- apply-schema refuses in additive slice files) no longer applies. Slice 19
-- moved BOTH halves of the work to the jobs worker's maintenance lane,
-- CONCURRENTLY, as an owning role, after the 2026-08-22 soak found inline
-- definer-built indexes the app role could never drop.
--
-- WHY THE DEFINITION HAD TO LEAVE THIS FILE ENTIRELY (2026-09-01 review):
-- apply-schema applies slice files FIRST and retention files SECOND, so for
-- as long as both files defined this function, every `apply-schema
-- --with-retention` run quietly reinstalled this file's OLDER, index-building
-- body over slice 19's reporter. Same signature, so checkForOverloads saw one
-- function and refused nothing; the installed behaviour flapped with a
-- command-line flag. Two live definitions of one function is the drift this
-- schema's own tooling exists to refuse - one definition, in the file that
-- applies on every path, is the fix.

-- A caller that wants one transaction PER partition, so the parent's ACCESS
-- EXCLUSIVE lock is released between drops rather than accumulating until the
-- whole run commits.
--
-- The function above is one transaction by nature - a plpgsql function cannot
-- commit - so with max_drop = 3 the parent stays locked across all three drops.
-- Each is milliseconds, so this matters less than the lock_timeout, but a
-- caller draining a backlog should prefer several one-partition calls to one
-- three-partition call. Recorded here rather than left to be rediscovered.
COMMENT ON FUNCTION drop_partitions_guarded(text, int, int, int, int, int, boolean, text) IS
    'Guarded partition retention. All guards are internal; lock_timeout is set inside. '
    'One call is one transaction, so the parent lock is held across every drop in that '
    'call - prefer max_drop=1 in a loop when draining a backlog.';
