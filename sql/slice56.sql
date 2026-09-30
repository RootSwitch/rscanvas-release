-- Slice 56 (2026-09-30): the poll schedule's own anchor.
--
-- last_poll_ts is when a poll FINISHED, and the scheduler made the next poll
-- due one interval after it, so every cycle added the poll's own duration
-- and the wait for the next dispatch tick. Measured on the operator's
-- network: 31.01 s between polls of a 30 s device, over 1,973 polls in a day -
-- 3% fewer samples than configured, and a perfectly polled interface reading
-- 97% coverage in a traffic report.
--
-- poll_anchor_ts is when the last poll was DUE, stepped by exactly the
-- interval (src/collector/schedule.ts), so the schedule holds however long a
-- poll takes. last_poll_ts keeps meaning when the device was last polled,
-- which the roster, the scan's staleness and the page all read.
--
-- NULL on upgrade: each device's first poll after it anchors on
-- last_poll_ts, as before, and holds the grid from then on.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS poll_anchor_ts timestamptz;
