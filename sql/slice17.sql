-- Responsiveness: two numbers the collector already measures and threw away.
--
-- poll_lag_ms   how late this device's poll STARTED against when it was due.
--               The collector has computed this per device since slice 4 and
--               kept only a fleet-wide percentile. It is the truest "is this
--               device hurting the scheduler" figure and the one the parent
--               suite could never answer: slow agents were a hidden killer
--               there precisely because nothing said WHICH ones. Written on
--               every poll, since it changes on every poll.
--
-- ping_rtt_ms   the most recent ICMP round trip. reach_rtt_ms is the value AT
--               THE LAST TRANSITION and stays put for days; this is the live
--               reading. Written by its own change-only batch, not by the
--               transition path, so a quiet fleet still costs no writes.
--
-- SNMP round-trip is not here because it already is: samples.rtt_ms per row,
-- entities.lv_rtt_ms per entity, since slice 4. The device page simply never
-- rendered it.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS poll_lag_ms real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ping_rtt_ms real;
