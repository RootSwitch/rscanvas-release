-- Slice 69 (2026-10-24, IDEAS-2026-10-24.md items 7 and 8): what a wall
-- shows by default, and GPUs on a wall.
--
-- boards.grid_shown   the fields a board's displays show until their
--                     viewer changes it - a subset of grid_fields, which
--                     stays the board's EXPOSURE (what any display may
--                     show at all). NULL: every allowed field, as every
--                     board did before, so no existing wall changes.
-- devices.gpu_pcts    each GPU's load in percent, written with the poll's
--                     roster summary (src/collector/summary.ts), as a JSON
--                     array in the agent's order; NULL for a device with
--                     no GPU. The wall's GPU field reads it.
--
-- Both additive and NULL-able: no row is rewritten.

ALTER TABLE boards ADD COLUMN IF NOT EXISTS grid_shown jsonb;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS gpu_pcts jsonb;
