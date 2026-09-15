-- Slice 26: the glance grid (SLICE-GLANCE-GRID-PLAN).
--
-- Three additive columns, no new tables. The grid is RENDERING, not layout:
-- a board with grid_cols set is drawn as tiles wrapped at that count, in
-- label order, ignoring stored coordinates entirely - wrapping is not
-- placement, and the no-layout-engine bet survives intact.
--
-- grid_fields is the per-board field declaration, the show_addresses
-- pattern widened: a jsonb array of registry keys (the registry lives in
-- code, GRID_FIELDS in ops.ts). BOARD-EXPOSURE clause 1 unchanged - the
-- projection emits ONLY declared keys, resolved server-side, so a display
-- token can never see a field the board did not opt into. Identity fields
-- (address, interface name, filesystem name, hardware) are individual
-- opt-ins apart from their values, because "top usage without top
-- interface" is the difference between a shareable screenshot and a port
-- map.

ALTER TABLE boards ADD COLUMN IF NOT EXISTS grid_cols int;
ALTER TABLE boards ADD COLUMN IF NOT EXISTS grid_fields jsonb;

-- The SNMP round-trip, stamped at poll time beside ping_rtt_ms - the
-- latency number the tile registry offers. The poll always computed it
-- (samples carry it per row); this is the one-row-per-device copy the
-- projection can read without touching samples.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_rtt_ms real;
