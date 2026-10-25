-- Slice 68 (2026-10-23): outside ping targets measured by loss.
--
-- Production's two outside targets, two public DNS servers, lost about one
-- ping in six while a model downloaded at 600 Mbit/s, and with one ping a
-- sweep and down on any loss each read down and up dozens of times and sent
-- twelve emails. An outside target - a public address, or one the operator
-- marks - now gets several pings a sweep: down when all are lost, degraded
-- when the last minute's lose enough (src/collector/reach.ts;
-- SLICE-OUTSIDE-LOSS-PLAN.md has the rulings).
--
--   devices.reach_outside    'auto' (by address), 'yes' or 'no'
--   devices.reach_loss_pct   the last minute's loss; NULL for every device
--                            that is not an outside target
--   reachability_events.loss_pct
--                            the loss when the state moved, for the timeline
--   ping_samples.sent/lost   an outside target's pings since the last row;
--                            NULL for one-ping devices, whose rows mean what
--                            they always did. rtt_ms stays NULL only for a
--                            silent sweep, so availability is unchanged.
--   ping_hourly.sent/lost    the same, rolled up (roll_up_ping_chunk in
--                            sql/slice63.sql), for the 30-day chart
--
-- All additive and NULL-able: no row is rewritten.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_outside text NOT NULL DEFAULT 'auto'
    CHECK (reach_outside IN ('auto', 'yes', 'no'));
ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_loss_pct real;
ALTER TABLE reachability_events ADD COLUMN IF NOT EXISTS loss_pct real;
ALTER TABLE ping_samples ADD COLUMN IF NOT EXISTS sent smallint;
ALTER TABLE ping_samples ADD COLUMN IF NOT EXISTS lost smallint;
ALTER TABLE ping_hourly ADD COLUMN IF NOT EXISTS sent int;
ALTER TABLE ping_hourly ADD COLUMN IF NOT EXISTS lost int;
