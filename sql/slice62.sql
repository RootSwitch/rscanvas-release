-- Slice 62 (2026-10-15): restarts, and acknowledging an alert.
-- IDEAS-2026-10-15.md items 1 and 2, both found half-built.
--
-- RESTARTS. sysUpTime has been read on every successful poll since slice 21
-- and stored as devices.uptime_s, and rules.ts has carried the parent's
-- reboot detector since slice 6 with nothing calling it. The collector now
-- judges each poll's uptime against the last one plus the time between them
-- (src/collector/restart.ts) and, when the device came back from zero, the
-- poll's own write records it - here, in the same statement that stores the
-- new uptime, so the reading and the verdict cannot drift apart.
--
-- "RESTART", NOT "REBOOT", IN EVERY WORD A PERSON READS. sysUpTime is the
-- AGENT's uptime: net-snmp restarted by a package upgrade reads exactly like
-- a power cycle. The table keeps the parent's word because the alert kind
-- and its template already carried it; the pages and the email say "the
-- device or its SNMP agent restarted", which is what is known.
--
-- The devices columns are the LAST restart, for the scan (one more column
-- on a row it already reads every five seconds) and the device page. The
-- table is the history, shaped like reachability_events: volume bounded by
-- how often things restart, not by cadence, so a plain table with the
-- device's cascade - deleting a device takes its restarts, and the removal
-- preview needs no new clause.
--
-- PLANNED is decided when the restart is RECORDED, not when the alert is
-- delivered: a restart inside a maintenance window for the device (one-shot
-- or repeating, through maintenance_active) is expected, and the restart
-- alert never raises for it. Gating at delivery, as every other alert is
-- gated, would page it the moment the window closed if the alert was still
-- open - a restart at 04:02 inside a 04:00-04:10 window would email at
-- 04:10 for a reboot the operator scheduled.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_seen_ts     timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_boot_ts     timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_up_before_s double precision;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reboot_planned     boolean;

CREATE TABLE IF NOT EXISTS reboot_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id   bigint NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    -- When the poll that noticed it was written.
    ts          timestamptz NOT NULL DEFAULT now(),
    -- When the device (or its agent) came back: the write's now() less the
    -- new uptime. Approximate by a poll's length, which is fine for a time
    -- a person reads.
    boot_ts     timestamptz NOT NULL,
    -- How long it had been up at the last poll before it restarted - the
    -- least it was up; it ran for some part of the gap as well.
    up_before_s double precision NOT NULL,
    planned     boolean NOT NULL DEFAULT false
);

-- The device page reads one device's restarts newest-first.
CREATE INDEX IF NOT EXISTS reboot_events_device_ts_idx
    ON reboot_events (device_id, ts DESC);

-- ACKNOWLEDGEMENT. acked_ts has existed since slice 6 with no writer, and
-- renotify has excluded acknowledged alerts since DECISIONS-2026-09-01
-- ruling 2, waiting for the U3 ack action. These are the who and the note.
-- An acknowledgement belongs to the incident (the row): the next incident
-- under the same key is a new row and starts unacknowledged.
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS acked_by text;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS ack_note text;
