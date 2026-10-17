-- Slice 64 (2026-10-16): notes on a device.
--
-- The operator's ask: a free-text field per device for what the poll can
-- never know - who owns it, who to call, its asset tag, the warranty, where
-- in the room it sits. Free text rather than named fields, on purpose: the
-- operator is building a CMDB elsewhere, and RSCanvas holding a second,
-- half-structured copy of it would be the copy that drifts. These are notes
-- for the person looking at the device page at 3am.
--
-- It is operator content, not device content, but it is rendered as text
-- like everything else, and it never reaches a board or a wall: they select
-- their own columns (BOARD-EXPOSURE.md), and a note can name a person.
-- The length is bounded at the route (2,000 characters), not here.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS notes text;
