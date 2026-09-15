-- Slice 36: ping latency history.
--
-- Ping has always been stored as TRANSITIONS - state changes only - because
-- a row per device per ten-second sweep is the write amplification this
-- codebase has stripped out three times. That was right for state and wrong
-- for latency: "is the internet up" is a transition, "is the internet slow
-- today" is a series, and the operator's External row wants both.
--
-- THE CADENCE IS THE WHOLE DESIGN. One row per device per MINUTE, not per
-- sweep: the sweep stays every ten seconds so state changes are still
-- caught fast, and only every sixth one is written down. At the stated
-- ceiling of ~600 devices that is 864k rows a day of three small columns,
-- against the samples table's millions - and at the operator's scale it is
-- fifty thousand.
--
-- A PLAIN TABLE, not a partitioned one. samples is partitioned because it
-- is the biggest thing in the database and retention has to DROP rather
-- than DELETE; this is two orders of magnitude smaller, so an indexed
-- delete by age is honest and the partition machinery would be ceremony.
-- If that ever stops being true the fix is a partition, and this comment is
-- the note that says why it was not one to begin with.

CREATE TABLE IF NOT EXISTS ping_samples (
    device_id bigint NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ts        timestamptz NOT NULL DEFAULT now(),
    -- NULL is a REAL READING: the device was probed this minute and did not
    -- answer. A gap in the series means the collector was not looking, and
    -- the two must not be confusable - the same distinction the samples
    -- table draws between a null rate and an absent row.
    rtt_ms    real
);

-- (device_id, ts) because every read is one device over a window.
CREATE INDEX IF NOT EXISTS ping_samples_device_ts_idx ON ping_samples (device_id, ts DESC);
