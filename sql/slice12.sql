-- Slice 9 (file numbered 12 - see slice11.sql's numbering note; 9, 10 and 11
-- were spoken for or taken, and the loader orders by filename number):
-- reachability. ICMP state on the device row, transitions as events.
--
-- THE STORAGE DECISION IS THE SLICE (SLICE-9-PLAN.md). Per-probe rows at the
-- ping cadence would be 3.9-7.8M rows/day of a boolean that rarely changes -
-- a second syslog corpus. So: probes live in worker memory, TRANSITIONS are
-- written here, current state is denormalised onto the device row the same
-- way lv_* columns are, and rtt TRENDING is deliberately absent because
-- samples.rtt_ms already carries it at the SNMP cadence. Two questions, two
-- instruments, no duplicate storage.

-- Current state, on the row the roster and the alert scan already read.
--
--   reach_state     up | degraded | down | unknown. 'unknown' is honest and
--                   distinct from 'down': never probed, probing disabled, or
--                   the address did not resolve. Absence of data is not an
--                   outage - the same rule the wall's staleness follows.
--   reach_since_ts  when the CURRENT state began. Resets only on state
--                   CHANGE, and survives restarts because it lives here
--                   rather than in worker memory - the parent poller reads
--                   its prior status file back for exactly this reason.
--   reach_rtt_ms    the rtt at the last TRANSITION, not the last probe. A
--                   per-probe update would rewrite 450 rows every 10 seconds
--                   to keep a number samples.rtt_ms already tracks better.
--   reach_check     which probe this device gets: 'icmp' today. The parent
--                   grew per-device TCP-connect checks for hosts where ICMP
--                   is filtered but a service answers; when that follow-on
--                   lands it is a value here ('tcp'), not a migration.
--                   'none' opts a device out of probing entirely.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_state    text NOT NULL DEFAULT 'unknown';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_since_ts timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_rtt_ms   real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_check    text NOT NULL DEFAULT 'icmp';

-- Transitions. Volume is bounded by FLAPPING, not cadence - a healthy fleet
-- writes almost nothing, the same shape as alerts - and the state machine
-- carries hysteresis on the degraded threshold precisely so rtt jitter
-- around the line cannot turn this table into a per-probe log (see
-- src/collector/reach.ts).
--
-- Plain table, no partitions: at flap-bounded volume even years fit in what
-- one day of samples costs. If a broken fleet ever proves that wrong, the
-- fix is partitioning by ts and retention by drop - the machinery exists.
-- ON DELETE CASCADE mirrors entities: deleting a device takes its events,
-- and the U6 removal gate's preview does not need a new clause.
CREATE TABLE IF NOT EXISTS reachability_events (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id  bigint NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    ts         timestamptz NOT NULL DEFAULT now(),
    from_state text NOT NULL,
    to_state   text NOT NULL,
    rtt_ms     real
);

-- The U3 events lane reads newest-first across the fleet; the device
-- drill-down reads newest-first for one device. Two reads, two indexes.
CREATE INDEX IF NOT EXISTS reachability_events_ts_idx
    ON reachability_events (ts DESC);
CREATE INDEX IF NOT EXISTS reachability_events_device_ts_idx
    ON reachability_events (device_id, ts DESC);
