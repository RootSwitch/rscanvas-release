-- Slice 63 (2026-10-16): the availability report's history.
-- IDEAS-2026-10-15.md item 8.
--
-- The report answers "how available was it this month", by ping alone (the
-- operator's ruling, 2026-10-16: a host that answers ping with its agent
-- dead is not an outage for its users). Two inputs already exist:
--
--   ping_samples        one probe a minute per device (slice 36), NULL rtt a
--                       real miss, an absent row "nobody was looking" - kept
--                       PING_HISTORY_DAYS (30), so a calendar month is out of
--                       reach on most days of the next one.
--   reachability_events every up/down/degraded transition at the sweep's ten
--                       seconds, kept for good - the outages, exactly.
--
-- So the minute probes are rolled up by the hour and kept, the way samples
-- are: a share of probes answered over any period, and how many hours of it
-- RSCanvas was looking at all. The outages stay where they are.
--
-- PLANNED is decided at roll-up, per probe, against the maintenance in force
-- at that probe's minute (one-shot windows and each occurrence of a
-- repeating one - maintenance_active()'s rule, sql/slice61.sql). The report
-- leaves planned probes out of the share and says how many there were.
--
-- ON DELETE CASCADE, because the rows are per DEVICE, not per entity: a
-- deleted device takes its hours, as it takes its ping samples and its
-- transitions. (samples_hourly has no such key, which is what slice 60 had
-- to repair.)

CREATE TABLE IF NOT EXISTS ping_hourly (
    device_id      bigint NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    hour_ts        timestamptz NOT NULL,
    probes         int NOT NULL,
    misses         int NOT NULL,
    planned_probes int NOT NULL,
    planned_misses int NOT NULL,
    PRIMARY KEY (device_id, hour_ts)
);

-- The report reads every device over a period: by the hour, not the device.
CREATE INDEX IF NOT EXISTS ping_hourly_hour_idx ON ping_hourly (hour_ts);

/*
 * One bounded chunk of the ping roll-up, advancing its frontier atomically
 * with it - roll_up_chunk's shape (sql/slice5.sql), and for its reasons:
 *
 *   BOUNDED: after a gap the window is days; each call covers at most
 *   max_hours and the caller loops, so a long gap heals in steps.
 *   ATOMIC: the rows and the frontier commit together, and an hour is
 *   rewritten whole (ON CONFLICT ... DO UPDATE), so a crash or a second
 *   instance redoes work and never double-counts.
 *   SETTLED: the ceiling trails now by settle_minutes, because a probe's ts
 *   is the sweep's and its commit can land in the next hour.
 *
 * The first run starts at the oldest probe on disk, so an upgrade rolls up
 * the month of history already there.
 *
 * THE MAINTENANCE IN FORCE is expanded ONCE per chunk into its intervals -
 * windows and occurrences that overlap the chunk - and each probe is tested
 * against those few rows, rather than calling maintenance_active() a probe
 * at a time: a day of a 1,550-device fleet is 2.2 million probes.
 */
CREATE OR REPLACE FUNCTION roll_up_ping_chunk(max_hours int DEFAULT 24, settle_minutes int DEFAULT 5)
RETURNS TABLE(hours_written bigint, rows_written bigint, from_ts timestamptz, to_ts timestamptz,
              caught_up boolean, locked boolean)
LANGUAGE plpgsql AS $$
DECLARE
    frontier timestamptz;
    lo timestamptz;
    hi timestamptz;
    ceiling timestamptz;
    n bigint;
    -- 0x52530000 spells "RS"; 1 is the samples roll-up, 2 retention, 3 the
    -- checks' back-fill, 4 the purge census.
    LOCK_NS          constant int := 1381253120;
    LOCK_PING_ROLLUP constant int := 5;
BEGIN
    SET LOCAL TimeZone = 'UTC';

    IF NOT pg_try_advisory_xact_lock(LOCK_NS, LOCK_PING_ROLLUP) THEN
        hours_written := 0; rows_written := 0; from_ts := NULL; to_ts := NULL;
        caught_up := true; locked := true;
        RETURN NEXT; RETURN;
    END IF;

    SELECT through_ts INTO frontier FROM job_state WHERE job = 'rollup:ping';
    IF frontier IS NULL THEN
        SELECT date_trunc('hour', min(ts)) INTO frontier FROM ping_samples;
        IF frontier IS NULL THEN
            hours_written := 0; rows_written := 0; from_ts := NULL; to_ts := NULL;
            caught_up := true; locked := false;
            RETURN NEXT; RETURN;
        END IF;
    END IF;

    lo := date_trunc('hour', frontier);
    ceiling := date_trunc('hour', now() - make_interval(mins => settle_minutes));
    hi := least(lo + make_interval(hours => max_hours), ceiling);

    IF hi <= lo THEN
        hours_written := 0; rows_written := 0; from_ts := lo; to_ts := lo;
        caught_up := true; locked := false;
        RETURN NEXT; RETURN;
    END IF;

    WITH mw AS (
        SELECT w.scope, w.target, w.starts_ts AS starts, w.ends_ts AS ends
          FROM maintenance_windows w
         WHERE w.ends_ts > lo AND w.starts_ts < hi
        UNION ALL
        SELECT s.scope, s.target, o.starts, o.starts + make_interval(mins => s.minutes)
          FROM maintenance_schedules s
          CROSS JOIN LATERAL generate_series((lo AT TIME ZONE s.tz)::date - 1,
                                             (hi AT TIME ZONE s.tz)::date, interval '1 day') AS g(day)
          CROSS JOIN LATERAL (SELECT (g.day::date + s.start_time) AT TIME ZONE s.tz AS starts) o
         WHERE extract(isodow FROM g.day)::smallint = ANY (s.days)
           AND o.starts < hi AND o.starts + make_interval(mins => s.minutes) > lo
    )
    -- sent/lost (sql/slice68.sql): an outside target's pings, summed; NULL
    -- for a device whose rows carry none.
    INSERT INTO ping_hourly (device_id, hour_ts, probes, misses, planned_probes, planned_misses, sent, lost)
    SELECT p.device_id, date_trunc('hour', p.ts),
           count(*), count(*) FILTER (WHERE p.rtt_ms IS NULL),
           count(*) FILTER (WHERE m.planned), count(*) FILTER (WHERE m.planned AND p.rtt_ms IS NULL),
           sum(p.sent), sum(p.lost)
      FROM ping_samples p
      JOIN devices d ON d.id = p.device_id
      CROSS JOIN LATERAL (
          SELECT EXISTS (SELECT 1 FROM mw
                          WHERE p.ts >= mw.starts AND p.ts < mw.ends
                            AND (mw.scope = 'all'
                                 OR (mw.scope = 'device' AND mw.target = d.name)
                                 OR (mw.scope = 'location' AND mw.target = d.location)
                                 OR (mw.scope = 'application' AND mw.target = d.application))) AS planned
      ) m
     WHERE p.ts >= lo AND p.ts < hi
     GROUP BY 1, 2
    ON CONFLICT (device_id, hour_ts) DO UPDATE
       SET probes = excluded.probes, misses = excluded.misses,
           planned_probes = excluded.planned_probes, planned_misses = excluded.planned_misses,
           sent = excluded.sent, lost = excluded.lost;
    GET DIAGNOSTICS n = ROW_COUNT;

    INSERT INTO job_state (job, through_ts, last_run_ts, last_ok_ts, runs)
    VALUES ('rollup:ping', hi, now(), now(), 1)
    ON CONFLICT (job) DO UPDATE
       SET through_ts  = excluded.through_ts,
           last_run_ts = excluded.last_run_ts,
           last_ok_ts  = excluded.last_ok_ts,
           runs        = job_state.runs + 1;

    hours_written := (extract(epoch FROM hi - lo) / 3600)::bigint;
    rows_written := n;
    from_ts := lo;
    to_ts := hi;
    caught_up := (hi >= ceiling);
    locked := false;
    RETURN NEXT;
END $$;
