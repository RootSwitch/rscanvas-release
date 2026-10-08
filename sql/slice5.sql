-- Slice 5: the scheduled jobs.
--
-- Additive. No DROP of anything holding data - the retention FUNCTIONS below
-- can drop partitions when called, which is their job, but this file creates
-- and replaces only. src/db/apply-schema.ts scans it for DROP and refuses,
-- which is why the functions spell it as EXECUTE format(...) rather than
-- literal DDL.
--
-- Three jobs: rollup, retention, and trigram index maintenance. Rule 7 governs
-- all of them: short lock_timeout, willing to lose, retry later.

-- --- samples_hourly, partitioned monthly ---------------------------------------
--
-- Fresh deployments get this. An EXISTING unpartitioned samples_hourly is
-- migrated by tools/partition-rollup.ts, which renames and ATTACHes rather than
-- copying; this statement is a no-op there because the table already exists.
--
-- Monthly rather than daily: the rollup is 1/120th the volume of raw, so daily
-- would give 90 partitions averaging 110MB. Measured monthly grain at the
-- 30,000-entity ceiling is about 21.6M rows and 3.3GB.
CREATE TABLE IF NOT EXISTS samples_hourly (
    entity_id int NOT NULL,
    hour_ts   timestamptz NOT NULL,
    -- n is not decoration. Re-bucketing needs the weighted mean
    -- sum(a0*n)/sum(n), because averaging the averages mis-weights exactly the
    -- hours when the poller was struggling - the hours the chart matters most.
    n         int NOT NULL,
    a0 double precision, a1 double precision, a2 double precision,
    a3 double precision, a4 double precision, a5 double precision,
    m0 double precision, m1 double precision,
    st smallint,
    -- PER-COLUMN counts, because avg() skips NULLs and n does not.
    -- Re-bucketing must weight by the count of values that CONTRIBUTED to each
    -- average, not by the number of samples in the hour. See roll_up_samples.
    n0 int, n1 int, n2 int, n3 int, n4 int, n5 int,
    PRIMARY KEY (entity_id, hour_ts)
) PARTITION BY RANGE (hour_ts);

-- Additive for a database that already has the table.
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS n0 int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS n1 int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS n2 int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS n3 int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS n4 int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS n5 int;

-- THE EXTREMES AND THE SPREAD (2026-10-07, SLICE-SERVICE-VIEWS-PLAN step 2).
-- An hour kept its averages and the MAXIMA of v0 and v1 - the right extreme
-- for a traffic rate and the wrong one for nearly everything a service check
-- measures: a voice test's worst is its LOWEST MOS (v4) and highest jitter
-- (v2, v3), a throughput test's its LOWEST rate (v0, v1). And with no sum
-- of squares there was no standard deviation past raw retention, which is
-- the operator's tool for an oversubscribed or intermittently failing link.
--
-- All of them for SERVICE CHECKS ONLY, NULL for every other entity, and
-- written by a second, small statement in the rollup (it says why):
--
--   lo0..lo4  minimum of v0..v4             m2..m4  maximum of v2..v4
--   q0..q4    sum of squares of v0..v4, so  sd = sqrt((q - n a^2) / (n - 1))
--             with n the column's own count (n0..n4) - exact enough in
--             doubles for a check's milliseconds, MOS and Mbps.
--   nok       runs that came back ok (v5 = 0).
--   mos36,    a VOICE test's runs under MOS 3.6 and 3.1 - the ITU-T G.109
--   mos31     bands behind the alert defaults, fixed by the standard rather
--             than by a threshold, so a count kept now does not go stale
--             when a threshold changes. NULL for other checks too.
--
-- Filled from the upgrade on; the rollup job back-fills checks' hours still
-- in raw retention once (roll_up_samples' probes_only, src/workers/jobs.ts).
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS lo0 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS lo1 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS lo2 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS lo3 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS lo4 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS m2 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS m3 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS m4 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS q0 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS q1 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS q2 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS q3 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS q4 double precision;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS nok int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS mos36 int;
ALTER TABLE samples_hourly ADD COLUMN IF NOT EXISTS mos31 int;

-- --- job state, and the rollup frontier -------------------------------------------
--
-- WITHOUT A PERSISTED FRONTIER, "a missed run self-heals" IS FALSE.
--
-- A scheduled job that computes its window from the clock - "the last N hours,
-- every N hours" - loses any hours it misses, permanently. The next run covers
-- the last N hours and never looks back, and nothing detects the gap, because
-- a hole in samples_hourly is indistinguishable from an entity that was not
-- polled.
--
-- SNMPCanvas solved this with a rollup_through_ts setting and the answer did
-- not get ported. The window is [through_ts, now) rather than a clock offset,
-- and the frontier advances ONLY after a chunk commits - so a missed run heals
-- by covering a wider window next time, which is what roll_up_samples' header
-- already claims and could not deliver without a caller that remembered
-- anything.
CREATE TABLE IF NOT EXISTS job_state (
    job          text PRIMARY KEY,
    -- How far this job has consumed its input. The frontier.
    through_ts   timestamptz,
    last_run_ts  timestamptz,
    last_ok_ts   timestamptz,
    runs         bigint NOT NULL DEFAULT 0,
    failures     bigint NOT NULL DEFAULT 0,
    detail       jsonb
);

/*
 * One bounded chunk of rollup, advancing the frontier atomically with it.
 *
 * BOUNDED, because after a long gap [through_ts, now) could be a week - one
 * statement, one transaction, on the jobs lane where statement_timeout is null.
 * An unbounded transaction also pins vacuum for its whole duration. So a call
 * covers at most max_hours and the caller loops until caught up: a long gap
 * heals in bounded steps, and a partial catch-up still makes progress instead
 * of timing out and losing all of it. Same "gradually over several runs"
 * principle as guard 2.
 *
 * ATOMIC, because the frontier and the rows it describes must not disagree.
 * Both happen in this function's single transaction, so a crash mid-chunk
 * leaves the frontier where it was and the next run redoes that chunk - which
 * is safe precisely because roll_up_samples is idempotent over whole hours.
 */
-- Adding settle_minutes changes the arity, and CREATE OR REPLACE only replaces
-- on an EXACT signature match - so without this the old one-argument version
-- survives beside the new one and every existing `roll_up_chunk(24)` call
-- silently resolves to the OLD body, with no settling margin and no error.
-- That trap has gone off in this project once already; apply-schema's
-- checkForOverloads exists because of it and would catch this one, but the
-- explicit drop is what makes it a replacement.
DROP FUNCTION IF EXISTS roll_up_chunk(int);
DROP FUNCTION IF EXISTS roll_up_chunk(int, int);

CREATE OR REPLACE FUNCTION roll_up_chunk(
    max_hours int DEFAULT 24,
    -- DO NOT REMOVE THIS LAG. It looks like a pointless delay and it is the
    -- difference between a rollup that is complete and one that is quietly
    -- missing its last flush of every hour. The reasoning is at `ceiling` below.
    settle_minutes int DEFAULT 5
)
-- `locked` is a RETURN COLUMN rather than an error, because losing this race is
-- the design working. The jobs worker counts consecutive failures and health
-- alarms at three, so a routine skip reported as a failure would trip an alarm
-- every time two instances overlapped during a deploy.
RETURNS TABLE(hours_written bigint, from_ts timestamptz, to_ts timestamptz,
              caught_up boolean, locked boolean)
LANGUAGE plpgsql AS $$
DECLARE
    frontier timestamptz;
    lo timestamptz;
    hi timestamptz;
    ceiling timestamptz;
    written bigint;

    -- Keep in step with sql/slice5-retention.sql. 0x52530000 spells "RS"; the
    -- second number names the job, and the rollup's differs from retention's
    -- because those two are MEANT to run concurrently - their ordering
    -- constraint is guard 5, not a lock.
    RSCANVAS_LOCK_NS constant int := 1381253120;
    LOCK_ROLLUP      constant int := 1;
BEGIN
    SET LOCAL TimeZone = 'UTC';

    -- NO TWO CONCURRENT CHUNKS. Read that literally: it is narrower than
    -- "one rollup run at a time", and the narrower statement is the true one.
    --
    -- The lock is TRANSACTION-scoped and each call to this function is its own
    -- transaction, so it is released between chunks. The worker loops up to
    -- ROLLUP_CHUNKS_PER_RUN times, which means two instances can INTERLEAVE at
    -- chunk granularity - A takes chunk 1, B takes chunk 2 - rather than one
    -- being excluded for the whole run.
    --
    -- That is harmless, and the reason it is harmless is worth stating because
    -- it is the thing that would stop being true if either changed:
    -- roll_up_samples is idempotent over whole hours, and both instances read
    -- and advance the SAME persisted frontier, so interleaving costs a little
    -- duplicated work and cannot produce a wrong aggregate or a gap.
    --
    -- What it does NOT give you is a per-run budget that means what it says:
    -- with two instances, ROLLUP_CHUNKS_PER_RUN bounds each one separately.
    --
    -- Retention is different and stronger - one call is one transaction, so
    -- there the lock covers the entire run. See slice5-retention.sql.
    IF NOT pg_try_advisory_xact_lock(RSCANVAS_LOCK_NS, LOCK_ROLLUP) THEN
        hours_written := 0; from_ts := NULL; to_ts := NULL;
        caught_up := true; locked := true;
        RETURN NEXT; RETURN;
    END IF;

    SELECT through_ts INTO frontier FROM job_state WHERE job = 'rollup';

    -- First ever run: start at the oldest raw sample rather than at now, or the
    -- history already on disk would never be rolled up at all.
    IF frontier IS NULL THEN
        SELECT date_trunc('hour', min(ts)) INTO frontier FROM samples;
        IF frontier IS NULL THEN
            hours_written := 0; from_ts := NULL; to_ts := NULL;
            caught_up := true; locked := false;
            RETURN NEXT; RETURN;
        END IF;
    END IF;

    lo := date_trunc('hour', frontier);

    -- THE SETTLING MARGIN, and the reason it exists, because a future reader
    -- will see an unexplained five-minute lag and delete it.
    --
    -- Never rolling the CURRENT hour is necessary and NOT sufficient. It
    -- assumes a sample's `ts` and its COMMIT happen at the same instant. They
    -- do not: `ts` is assigned at POLL time, then the row waits in the
    -- collector's `pending` array for up to a second (collector.ts, 1s flush
    -- timer) and the COPY itself can wait up to 10s for a collector-lane
    -- connection. Rows whose `ts` falls in hour H routinely commit one to ten
    -- seconds INTO hour H+1.
    --
    -- Without the margin: a poll completes at 09:59:59.4. The jobs tick happens
    -- to fire at 10:00:00.3, rolls [09:00, 10:00), and advances the frontier to
    -- 10:00. The collector's flush commits at 10:00:00.9 into raw hour 09. The
    -- frontier only ever moves forward, so those rows are never rolled - and on
    -- day 14 guard 5 sees the partition is behind the frontier and lets
    -- retention drop it. The rows then exist in neither table, and every
    -- component behaved exactly as specified.
    --
    -- IT WOULD NEVER BE NOTICED. The hourly row for 09:00 simply has a smaller
    -- n and a slightly wrong average; once raw expires nothing disagrees with
    -- it. The slice 5 done-when test cannot see it either, because both sides
    -- of its comparison read the same truncated rollup. The size is roughly
    -- 0.5% of hours losing their final flush (the tick lands uniformly in a
    -- 300s interval against a 1-2s commit lag), rising with collector-lane
    -- contention, and about 1,000 rows per event at the 30k ceiling.
    -- Systematic, permanent, invisible.
    --
    -- This is the standard watermark problem and this is the standard answer:
    -- hold the ceiling back by more than the worst commit lag. Five minutes
    -- against a worst case of ten seconds is thirty times the margin, and it
    -- costs nothing visible - the rollup already trails live by up to a tick,
    -- and charts serve the recent window from raw per ARCHITECTURE section 5a.
    --
    -- What would make this wrong: a writer whose commit lag can exceed
    -- settle_minutes. If the collector ever gains a queue deeper than five
    -- minutes, this number has to grow with it.
    ceiling := date_trunc('hour', now() - (settle_minutes || ' minutes')::interval);
    hi := least(lo + (max_hours || ' hours')::interval, ceiling);

    IF hi <= lo THEN
        hours_written := 0; from_ts := lo; to_ts := lo;
        caught_up := true; locked := false;
        RETURN NEXT; RETURN;
    END IF;

    SELECT r.hours_written INTO written FROM roll_up_samples(lo, hi) r;

    INSERT INTO job_state (job, through_ts, last_run_ts, last_ok_ts, runs)
    VALUES ('rollup', hi, now(), now(), 1)
    ON CONFLICT (job) DO UPDATE
       SET through_ts  = excluded.through_ts,
           last_run_ts = excluded.last_run_ts,
           last_ok_ts  = excluded.last_ok_ts,
           runs        = job_state.runs + 1;

    hours_written := written;
    from_ts := lo;
    to_ts := hi;
    caught_up := (hi >= ceiling);
    locked := false;
    RETURN NEXT;
END $$;

-- --- monthly partition creation --------------------------------------------------
-- SECURITY DEFINER for the same reason as ensure_daily_partitions, and
-- declared here rather than ALTERed on afterwards for the same reason too: a
-- CREATE OR REPLACE resets any attribute the definition does not restate, so an
-- attribute added out of band survives only until the next schema apply.
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(
    tbl text, first_month date, last_month date
) RETURNS int LANGUAGE plpgsql
  SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    m date := date_trunc('month', first_month)::date;
    stop date := date_trunc('month', last_month)::date;
    made int := 0;
    part text;
BEGIN
    -- Partition bounds are built from date literals, and for a timestamptz
    -- column '2026-07-27' means midnight in the CREATING SESSION's zone.
    -- Sessions with different zones produce overlapping bounds (the CREATE
    -- fails, the day's partition never appears) or gapped ones (a COPY for a
    -- row in the gap fails) - and both feed the discard path this review
    -- already closed once.
    SET LOCAL TimeZone = 'UTC';
    WHILE m <= stop LOOP
        part := format('%s_%s', tbl, to_char(m, 'YYYYMM'));
        IF to_regclass(part) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                part, tbl, m, (m + interval '1 month')::date);
            made := made + 1;
        END IF;
        m := (m + interval '1 month')::date;
    END LOOP;
    RETURN made;
END $$;

-- Retention lives in sql/slice5-retention.sql, not here.
--
-- apply-schema.ts refuses any slice file containing DROP, and a retention
-- function necessarily contains one. That guard is not weakened to accommodate
-- it: the function is installed by `node src/db/apply-schema.ts
-- --with-retention` instead, so the default path stays additive-only and the
-- destructive definition takes a deliberate act.

-- --- the rollup ------------------------------------------------------------------
--
-- Aggregates raw samples into hourly buckets. n carries the sample count so a
-- later re-bucketing can weight correctly.
--
-- ON CONFLICT so a re-run of the same hour is idempotent and a missed run
-- self-heals by simply covering a wider window next time.
-- THE WINDOW IS CLAMPED TO WHOLE HOURS, INSIDE THE FUNCTION.
--
-- The old header claimed "a missed run self-heals by simply covering a wider
-- window next time". That was true only on hour boundaries, and false
-- everywhere else, because ON CONFLICT DO UPDATE REPLACES the row rather than
-- merging into it.
--
-- Roll [00:00, 01:30) and hour 01:00 is written from its first half alone.
-- Roll [01:30, 02:00) afterwards and that row is REPLACED by its second half -
-- with n claiming to describe the whole hour. The data that was already
-- correctly rolled up is destroyed by a later, narrower run.
--
-- It is invisible for fourteen days. The raw samples still exist, so nothing
-- disagrees; a chart reading raw looks fine. Then raw retention expires the
-- underlying partition and the chart silently loses part of an hour, with
-- nothing pointing at the rollup as the cause.
--
-- Clamped here rather than in the caller, by the same doctrine that puts the
-- retention guards inside their function: the caller is exactly what was
-- careful last time. A caller may pass any window it likes; this function
-- rounds the lower bound UP and the upper bound DOWN to hour boundaries, so it
-- only ever writes hours it has seen in full, and re-running any window that
-- covers an hour reproduces that hour exactly.
--
-- SET LOCAL TimeZone = 'UTC' is finding 10. date_trunc('hour', ts) on a
-- timestamptz truncates in the SESSION's time zone: in a fractional-offset zone
-- (IST +5:30, Nepal +5:45) buckets land on :30 or :45 UTC boundaries, and two
-- runs under different TimeZone settings write MISALIGNED keys for the same
-- hours. The (entity_id, hour_ts) conflict key treats them as distinct rows, so
-- history is double-counted and the weighted mean then averages it plausibly.
-- The return type changed from bigint to a row, and CREATE OR REPLACE cannot
-- change a return type - it errors outright rather than overloading. This is
-- the DROP FUNCTION escape hatch apply-schema now permits: the additive guard
-- protects data, and a function is code.
DROP FUNCTION IF EXISTS roll_up_samples(timestamptz, timestamptz);

-- probes_only (2026-10-07): the checks' extremes and spread over hours the
-- rollup has already written - the one-off back-fill over what raw
-- retention still holds - and nothing else. Defaulted, so every existing
-- two-argument call means what it meant.
CREATE OR REPLACE FUNCTION roll_up_samples(
    from_ts timestamptz, to_ts timestamptz, probes_only boolean DEFAULT false
) RETURNS TABLE(hours_written bigint, from_clamped timestamptz, to_clamped timestamptz)
LANGUAGE plpgsql AS $$
DECLARE
    lo timestamptz;
    hi timestamptz;
    written bigint := 0;
BEGIN
    SET LOCAL TimeZone = 'UTC';

    -- Lower bound UP, upper bound DOWN: only whole hours.
    lo := date_trunc('hour', from_ts);
    IF lo < from_ts THEN lo := lo + interval '1 hour'; END IF;
    hi := date_trunc('hour', to_ts);

    IF hi <= lo THEN
        hours_written := 0; from_clamped := lo; to_clamped := hi;
        RETURN NEXT;
        RETURN;
    END IF;

    IF NOT probes_only THEN
    INSERT INTO samples_hourly (entity_id, hour_ts, n, a0, a1, a2, a3, a4, a5, m0, m1, st,
                                n0, n1, n2, n3, n4, n5)
    SELECT entity_id,
           date_trunc('hour', ts) AS hour_ts,
           -- FINDING 11: n must count what avg() actually averaged.
           --
           -- It was count(*), but avg() SKIPS NULLs - and rates are NULL by
           -- design after a counter reset, an agent restart or a first poll,
           -- which is to say exactly during trouble. An hour with 120 samples
           -- of which 6 carry rates got a0 = avg of 6 and n = 120, so
           -- re-bucketing by sum(a0*n)/sum(n) weighted that struggling hour at
           -- twenty times its evidence.
           --
           -- That is the same failure the schema comment warns about -
           -- "mis-weights exactly the hours when the poller was struggling" -
           -- reproduced one level down. And the done-when test comparing
           -- weighted against naive means would have PASSED, because both use
           -- the same wrong n.
           --
           -- n stays as the sample count for the row, because a consumer wants
           -- to know how many polls an hour had. The per-column counts are what
           -- re-bucketing must weight by.
           count(*)::int AS n,
           avg(v0), avg(v1), avg(v2), avg(v3), avg(v4), avg(v5),
           max(v0), max(v1),
           -- max(status) ranks testing(3) above down(2), which is not "worst".
           -- IF-MIB oper status: 1 up, 2 down, 3 testing, 4 unknown, 5 dormant,
           -- 6 notPresent, 7 lowerLayerDown. The worst state an hour reached is
           -- the one an operator wants, and down is worse than testing.
           (CASE
                WHEN bool_or(status = 2) THEN 2
                WHEN bool_or(status = 7) THEN 7
                WHEN bool_or(status <> 1) THEN max(status)
                ELSE 1
            END)::smallint,
           count(v0)::int, count(v1)::int, count(v2)::int,
           count(v3)::int, count(v4)::int, count(v5)::int
      FROM samples
     WHERE ts >= lo AND ts < hi
     GROUP BY entity_id, date_trunc('hour', ts)
    ON CONFLICT (entity_id, hour_ts) DO UPDATE
       SET n  = excluded.n,
           a0 = excluded.a0, a1 = excluded.a1, a2 = excluded.a2,
           a3 = excluded.a3, a4 = excluded.a4, a5 = excluded.a5,
           m0 = excluded.m0, m1 = excluded.m1,
           st = excluded.st,
           n0 = excluded.n0, n1 = excluded.n1, n2 = excluded.n2,
           n3 = excluded.n3, n4 = excluded.n4, n5 = excluded.n5;
    GET DIAGNOSTICS written = ROW_COUNT;
    END IF;

    -- THE CHECKS' EXTREMES AND SPREAD, a second, small statement over the
    -- rows just written (see the columns' comment above). Small because it
    -- starts from the checks - a few hundred entities - and reaches their
    -- samples through the samples' own key, instead of carrying 30,000
    -- entities' worth through a join to find them. Measured on the 30k lab
    -- 2026-10-07: folding these into the statement above, with a join to
    -- pick the checks out, took an hour's rollup from 4.3 s to 6.3 s, for
    -- columns nothing but checks fill.
    UPDATE samples_hourly h
       SET lo0 = x.lo0, lo1 = x.lo1, lo2 = x.lo2, lo3 = x.lo3, lo4 = x.lo4,
           m2 = x.m2, m3 = x.m3, m4 = x.m4,
           q0 = x.q0, q1 = x.q1, q2 = x.q2, q3 = x.q3, q4 = x.q4,
           nok = x.nok, mos36 = x.mos36, mos31 = x.mos31
      FROM (
          SELECT s.entity_id, date_trunc('hour', s.ts) AS hour_ts,
                 min(s.v0) AS lo0, min(s.v1) AS lo1, min(s.v2) AS lo2, min(s.v3) AS lo3, min(s.v4) AS lo4,
                 max(s.v2) AS m2, max(s.v3) AS m3, max(s.v4) AS m4,
                 sum(s.v0 * s.v0) AS q0, sum(s.v1 * s.v1) AS q1, sum(s.v2 * s.v2) AS q2,
                 sum(s.v3 * s.v3) AS q3, sum(s.v4 * s.v4) AS q4,
                 count(*) FILTER (WHERE s.v5 = 0)::int AS nok,
                 -- A voice test's own counts; NULL for other checks, whose v4
                 -- is something else.
                 (CASE WHEN max(p.kind) = 'path-voice' THEN count(*) FILTER (WHERE s.v4 < 3.6) END)::int AS mos36,
                 (CASE WHEN max(p.kind) = 'path-voice' THEN count(*) FILTER (WHERE s.v4 < 3.1) END)::int AS mos31
            FROM entities p
            JOIN samples s ON s.entity_id = p.id AND s.ts >= lo AND s.ts < hi
           WHERE p.source = 'probe'
           GROUP BY s.entity_id, date_trunc('hour', s.ts)
      ) x
     WHERE h.entity_id = x.entity_id AND h.hour_ts = x.hour_ts;
    IF probes_only THEN GET DIAGNOSTICS written = ROW_COUNT; END IF;

    hours_written := written;
    from_clamped  := lo;
    to_clamped    := hi;
    RETURN NEXT;
END $$;

/*
 * THE CHECKS' BACK-FILL (2026-10-07, SLICE-SERVICE-VIEWS-PLAN step 2): once
 * per database, the hours service checks still have in raw samples are
 * rolled again, so the extremes and the spread reach back as far as raw
 * retention did on the day of the upgrade, not just from it. Checks only
 * (roll_up_samples' probes_only): re-rolling every entity's fortnight to
 * refresh a few hundred checks' would be most of a day's work at 30,000.
 *
 * Bounded and resumable, the rollup's own shape: each call covers at most
 * max_hours from where the last one stopped, and the progress is a job_state
 * row ('rollup:checks-backfill') written in the same transaction as the hours
 * it describes - through_ts the next hour to do, detail.until where it ends:
 * the rollup frontier as it stood when the back-fill began, since everything
 * from there on the rollup itself writes with the new columns. Starts at the
 * oldest raw sample any check has, found through the samples' own key (a
 * min(ts) over all of raw would scan it). Its own advisory lock, so two jobs
 * workers in a rolling deploy cannot write the same hours at once.
 */
CREATE OR REPLACE FUNCTION roll_up_checks_backfill(max_hours int DEFAULT 168)
RETURNS TABLE(hours_written bigint, done boolean, through timestamptz, until timestamptz, locked boolean)
LANGUAGE plpgsql AS $$
DECLARE
    st   job_state%ROWTYPE;
    lo   timestamptz;
    hi   timestamptz;
    stop timestamptz;
    wrote bigint := 0;
    -- The rollup's namespace (roll_up_chunk), its own job number: the
    -- back-fill writes only hours below the frontier, which the rollup has
    -- left, so the two run side by side; two back-fills do not.
    RSCANVAS_LOCK_NS       constant int := 1381253120;
    LOCK_CHECKS_BACKFILL   constant int := 3;
BEGIN
    SET LOCAL TimeZone = 'UTC';
    IF NOT pg_try_advisory_xact_lock(RSCANVAS_LOCK_NS, LOCK_CHECKS_BACKFILL) THEN
        hours_written := 0; done := false; through := NULL; until := NULL; locked := true;
        RETURN NEXT;
        RETURN;
    END IF;
    locked := false;

    SELECT * INTO st FROM job_state WHERE job = 'rollup:checks-backfill';
    IF NOT FOUND THEN
        stop := (SELECT j.through_ts FROM job_state j WHERE j.job = 'rollup');
        lo := (SELECT date_trunc('hour', min(s.ts))
                 FROM entities e
                 JOIN LATERAL (SELECT s.ts FROM samples s WHERE s.entity_id = e.id ORDER BY s.ts LIMIT 1) s ON true
                WHERE e.source = 'probe');
        -- No rollup yet, or no check has a sample: nothing to back-fill.
        IF stop IS NULL OR lo IS NULL OR lo >= stop THEN lo := coalesce(stop, now()); stop := lo; END IF;
        INSERT INTO job_state (job, through_ts, last_run_ts, last_ok_ts, runs, detail)
        VALUES ('rollup:checks-backfill', lo, now(), now(), 0, jsonb_build_object('until', stop, 'from', lo));
        SELECT * INTO st FROM job_state WHERE job = 'rollup:checks-backfill';
    END IF;

    lo := st.through_ts;
    stop := (st.detail->>'until')::timestamptz;
    IF lo < stop THEN
        hi := least(lo + make_interval(hours => max_hours), stop);
        SELECT r.hours_written INTO wrote FROM roll_up_samples(lo, hi, true) r;
        lo := hi;
    END IF;
    UPDATE job_state
       SET through_ts = lo, last_run_ts = now(), last_ok_ts = now(), runs = runs + 1,
           detail = detail || jsonb_build_object('done', lo >= stop)
     WHERE job = 'rollup:checks-backfill';

    hours_written := wrote; done := lo >= stop; through := lo; until := stop;
    RETURN NEXT;
END $$;
