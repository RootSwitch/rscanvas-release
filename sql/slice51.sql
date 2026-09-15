-- Slice 51 (review easy-win E12): the open-alert host index.
--
-- boardProjection resolves each shape's open-alert count through a lateral
-- on alerts(host), uiDevices joins the same way for the roster's alarm
-- column, and renameDevice's blanket `SET host = $2 WHERE host = $1` walks
-- the whole table on the 2s interactive lane. All three rode a sequential
-- scan: fine at 5,389 rows (the live fixture's measure), a per-shape cost
-- multiplied by board size at the ceiling. Partial over the open set,
-- because that is the working set every 5s reader means - the scan reads
-- open alerts whole by design, and cleared history is pruned by age, not
-- searched by host.
--
-- (Not named alerts_open_key's sibling by accident: that partial unique
-- index IS the identity model; this one is only a read path.)

CREATE INDEX IF NOT EXISTS alerts_host_open_idx ON alerts (host)
    WHERE state != 'cleared';
