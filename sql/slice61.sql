-- Slice 61 (2026-10-10): maintenance windows that repeat.
--
-- SLICE-MAINTENANCE-WINDOWS-PLAN decision 7 said "no recurrence in v1 ...
-- recurrence when somebody asks twice". Asked, with the case that proves
-- it: a production domain controller is backed up every night at 03:00, a ~100 GB VM on
-- a mini PC whose snapshot stun takes it off the network for one and a half
-- to two and a half minutes. It raised device-down at 03:00 on seven of
-- eight nights and sent fourteen emails (raise and clear) for an outage the
-- operator scheduled. A one-shot window would have to be made every day.
--
-- A SCHEDULE is a set of weekdays, a local start time, a length and the
-- time zone the operator meant: "every day at 03:00 for 10 minutes,
-- America/Chicago". It does exactly what a window does while an occurrence
-- is open - withholds notification, never the alert, marks it "in
-- maintenance" everywhere, and delivers what is still active after it
-- closes - because it is matched by the SAME readers through
-- maintenance_active(), below.
--
-- ITS OWN TABLE, NOT COLUMNS ON maintenance_windows. A repeating row has no
-- single span, and any span it carried (say, created .. infinity) would read
-- as "in maintenance forever" to a reader that still matched on starts_ts
-- and ends_ts - one missed reader would silence a device for good. In a
-- table of its own, a reader that was missed simply does not see the
-- schedule: notifications go out as if it did not exist. That is the failure
-- worth having.
--
-- No end date, unlike a window (decision 2: a window with no end is a
-- disable that gets forgotten). Each OCCURRENCE has an end, and the drain's
-- own predicate delivers whatever is still active when it closes, so a
-- forgotten schedule costs at most its length of delay each time - the real
-- outage that starts at 03:00 and stays is paged at 03:10. Bounded instead:
-- at most 12 hours an occurrence (longer, every day, is a notify policy,
-- which already exists) and never scope 'all' (a standing quiet hour over
-- everything is a different feature, and not this one).
--
-- DAYLIGHT SAVING, measured 2026-10-10 rather than assumed. An occurrence
-- starts at its local wall-clock time and lasts its minutes of real time.
-- A start inside the hour that spring skips (02:30 on 2026-03-08 in
-- America/Chicago) begins an hour later on the clock, 03:30; a start inside
-- the hour that autumn repeats (01:30 on 2026-11-01) is the second, standard-
-- time one. That is how PostgreSQL resolves a local time in a zone, and it
-- is the same answer every night it applies.

CREATE TABLE IF NOT EXISTS maintenance_schedules (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope      text NOT NULL CHECK (scope IN ('device', 'location', 'application')),
    target     text NOT NULL,
    -- ISO weekdays, Monday 1 .. Sunday 7.
    days       smallint[] NOT NULL
               CHECK (cardinality(days) BETWEEN 1 AND 7 AND days <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
    start_time time NOT NULL,
    minutes    int NOT NULL CHECK (minutes BETWEEN 1 AND 720),
    -- An IANA zone, checked against pg_timezone_names when the row is made
    -- (OPS.createMaintenanceSchedule): a zone PostgreSQL did not know would
    -- make every reader below fail, and with them the notify drain.
    tz         text NOT NULL,
    note       text,
    created_by text,
    created_ts timestamptz NOT NULL DEFAULT now()
);

/*
 * The maintenance in force at a moment: (scope, target) of every one-shot
 * window spanning it and every schedule with an occurrence open at it.
 *
 * EVERY "is this in maintenance" question goes through here - the owed
 * queries and the alert pages (ALERT_IN_MAINTENANCE), the clear settlement
 * (at the alert's cleared_ts), and the wall's marker - so a schedule is
 * honoured by each of them without any of them knowing it exists.
 *
 * An occurrence is found from the local date in the schedule's zone: the
 * one that began today, or yesterday's still running past midnight (12
 * hours at most, so never anything older). Its start is that date at the
 * local start time, converted from the zone; it is open for its minutes.
 */
CREATE OR REPLACE FUNCTION maintenance_active(at_ts timestamptz)
RETURNS TABLE(scope text, target text)
LANGUAGE sql STABLE AS $$
    SELECT w.scope, w.target
      FROM maintenance_windows w
     WHERE at_ts >= w.starts_ts AND at_ts < w.ends_ts
    UNION ALL
    SELECT s.scope, s.target
      FROM maintenance_schedules s
      CROSS JOIN LATERAL (
          SELECT (at_ts AT TIME ZONE s.tz)::date - b.back AS day
            FROM (VALUES (0), (1)) AS b(back)
      ) d
      CROSS JOIN LATERAL (
          SELECT (d.day + s.start_time) AT TIME ZONE s.tz AS starts
      ) o
     WHERE extract(isodow FROM d.day)::smallint = ANY (s.days)
       AND at_ts >= o.starts
       AND at_ts < o.starts + make_interval(mins => s.minutes)
$$;
