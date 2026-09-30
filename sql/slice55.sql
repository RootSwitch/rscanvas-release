-- Slice 55 (2026-09-29, the operator's amendment of DECISIONS-2026-09-01
-- ruling 7): group alerts.
--
-- A location or application an operator opts in raises ONE alert when a
-- share of its devices is down: at least threshold_pct percent of the ones
-- whose status is known (up or down), and at least min_down of them, so a
-- two-device group cannot trip on a single failure. Transient and muted
-- devices are not counted.
--
-- The member device-down alerts still raise and still show - ruling 7's
-- "nothing hidden" stands. What changes is delivery: while the group alert
-- is open, a member's notification is held, the way a maintenance window or
-- a notify policy holds one, and the group's single notification names the
-- devices. When the group clears, a member still down is owed and sent.
--
-- One row per group, kept when the box is unticked (enabled false) so a
-- tuned threshold survives being switched off and on. Opt-in: no row, no
-- group alert, so an upgrade changes nothing until someone ticks a box.

CREATE TABLE IF NOT EXISTS group_alert_rules (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    axis          text NOT NULL CHECK (axis IN ('location', 'application')),
    value         text NOT NULL CHECK (btrim(value) <> ''),
    enabled       boolean NOT NULL DEFAULT true,
    threshold_pct integer NOT NULL DEFAULT 50 CHECK (threshold_pct BETWEEN 1 AND 100),
    min_down      integer NOT NULL DEFAULT 3 CHECK (min_down BETWEEN 1 AND 100000),
    updated_by    text,
    updated_ts    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (axis, value)
);
