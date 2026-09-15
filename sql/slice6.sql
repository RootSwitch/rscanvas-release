-- Slice 6: alerts.
--
-- Additive, like every slice file: CREATE only, no DROP, no TRUNCATE. Applied
-- by src/db/apply-schema.ts in slice order.
--
-- Ported from alertcanvas's SQLite schema with three deliberate changes:
--
--   * timestamptz instead of epoch-second integers. The parent stored
--     Math.floor(Date.now()/1000) everywhere; the fork's store already speaks
--     Date both ways, and mixing epoch integers into a schema whose every
--     other table uses timestamptz is how off-by-1000 bugs get written.
--   * bigserial id, matching the fork's other tables.
--   * severity and state as CHECK constraints rather than free text, so a
--     typo'd state is an insert error rather than an alert the scan loop can
--     never find again.

-- One row per incident, from first breach to cleared - cleared rows ARE the
-- history, which is why a pending alert that never raised is deleted rather
-- than cleared (tools/test-machine.ts asserts it: it never happened).
CREATE TABLE IF NOT EXISTS alerts (
    id              bigserial PRIMARY KEY,
    -- The identity the state machine folds conditions onto: 'cpu:host1',
    -- 'if:SW1A2', 'watchdog:collector'. One OPEN row per key, enforced below.
    alert_key       text NOT NULL,
    state           text NOT NULL CHECK (state IN ('pending', 'active', 'clearing', 'cleared')),
    severity        text NOT NULL CHECK (severity IN ('warn', 'crit')),
    kind            text NOT NULL,
    host            text,
    code            text,
    label           text NOT NULL,
    value           double precision,
    -- The incident's true worst, direction depending on the kind (max for
    -- cpu, min for battery). What history should show, and what the sticky
    -- severity rule preserves the meaning of.
    peak_value      double precision,
    threshold       double precision,
    unit            text NOT NULL DEFAULT '',
    breach_count    int NOT NULL DEFAULT 0,
    clear_count     int NOT NULL DEFAULT 0,
    missing_count   int NOT NULL DEFAULT 0,
    first_breach_ts timestamptz NOT NULL,
    raised_ts       timestamptz,
    cleared_ts      timestamptz,
    last_seen_ts    timestamptz NOT NULL,
    renotified_ts   timestamptz,
    acked_ts        timestamptz,
    acked_by        text,
    clear_reason    text,
    -- Notification bookkeeping, owned by dispatch rather than the machine.
    -- notified_* false with state active is the retry pass's queue.
    notified_raise  boolean NOT NULL DEFAULT false,
    notified_clear  boolean NOT NULL DEFAULT false,
    notify_attempts int NOT NULL DEFAULT 0,
    last_attempt_ts timestamptz
);

-- THE invariant: one OPEN alert per key. Partial, so history keeps every
-- cleared incident under the same key forever. The parent learned the hard
-- way that two conditions sharing a key roll back the whole scan transaction
-- against this index - which is why dedupeConditions() runs BEFORE the write
-- loop, and why it is the machine's job rather than a hope about the feed.
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_key
    ON alerts (alert_key) WHERE state != 'cleared';

-- The scan reads exactly the open set every tick.
CREATE INDEX IF NOT EXISTS alerts_open
    ON alerts (state) WHERE state != 'cleared';

-- History reads: newest incidents first, and the retention prune by age.
CREATE INDEX IF NOT EXISTS alerts_cleared_ts
    ON alerts (cleared_ts DESC) WHERE state = 'cleared';

-- Every notification attempt, delivered or failed. The parent kept this and
-- it earned its place: "did anyone get told about this incident" is the first
-- question asked after one, and the alerts row only holds the latest state.
--
-- Retention is the jobs worker's pruneNotifications, BY AGE, alongside the
-- ON DELETE CASCADE below - the cascade alone left rows against never-
-- clearing alerts growing forever, the one unbounded table in the system.
-- Plain DELETE rather than partitioning, deliberately: at ~96 rows/day per
-- broken channel per alert this never reaches the volume that justified
-- partitioning messages and samples.
CREATE TABLE IF NOT EXISTS notifications (
    id        bigserial PRIMARY KEY,
    ts        timestamptz NOT NULL DEFAULT now(),
    alert_id  bigint REFERENCES alerts (id) ON DELETE CASCADE,
    -- raise | escalate | clear | renotify
    event     text NOT NULL,
    channel   text NOT NULL,
    ok        boolean NOT NULL,
    detail    text
);

CREATE INDEX IF NOT EXISTS notifications_alert ON notifications (alert_id);
CREATE INDEX IF NOT EXISTS notifications_ts ON notifications (ts);
