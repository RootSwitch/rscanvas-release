-- Slice 22: maintenance windows - suppress the NOTIFICATION, never the alert.
--
-- SLICE-MAINTENANCE-WINDOWS-PLAN, and the deciding rule is worth restating
-- where the table lives: during a window the alert raises normally, is
-- stored normally, and appears everywhere marked as in-window - it is simply
-- not DELIVERED. All-quiet and not-looking must never look the same, so the
-- wall stays honest while the pager stays silent.
--
-- The drain's own predicate (state = 'active' AND NOT notified_raise) closes
-- the hard edge for free: an alert that raised during a window and is still
-- active when the window expires is still OWED, and the next pass delivers
-- it with no catch-up code. The suppression is one predicate on the owed
-- queries (src/store/ops.ts ALERT_IN_MAINTENANCE); nothing else changes.
--
-- Both ends are REQUIRED. A window with no end is device.disable with extra
-- steps, and it fails the same way - forgotten. Expiry needs no job: after
-- ends_ts the row simply stops matching. Expired rows are kept for the
-- clear-settlement lookback and pruned with alert retention.
--
-- scope 'all' has a NULL target, and only it does - the CHECK makes the
-- pair unrepresentable rather than trusting the route to validate it.

CREATE TABLE IF NOT EXISTS maintenance_windows (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope      text NOT NULL CHECK (scope IN ('device', 'location', 'application', 'all')),
    target     text,
    starts_ts  timestamptz NOT NULL,
    ends_ts    timestamptz NOT NULL CHECK (ends_ts > starts_ts),
    note       text,
    created_by text,
    created_ts timestamptz NOT NULL DEFAULT now(),
    CHECK ((scope = 'all') = (target IS NULL))
);

-- The plan sketched a partial index ON (ends_ts) WHERE ends_ts > now() and
-- then rejected it in the same breath: now() is not immutable and Postgres
-- refuses it. Plain (ends_ts, starts_ts) and the predicate does the rest;
-- the table is small by construction (windows are shift work, not data).
CREATE INDEX IF NOT EXISTS maintenance_windows_span_idx
    ON maintenance_windows (ends_ts, starts_ts);
