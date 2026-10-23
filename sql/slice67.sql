-- Slice 67 (2026-10-23): a board's glance grid divided by the OTHER axis.
--
-- A board's sections followed the axis that picks its devices: a board of
-- applications was divided by application, a board of locations by
-- location. The operator wanted a team board - the server team's
-- applications - divided by WHERE its servers are, which that rule could
-- only draw as one section per application.
--
-- section_axis NULL is "follow the board's own groups", in their declared
-- order: every existing board's answer, unchanged. A value divides the grid
-- by that axis instead, sections alphabetical (nobody declared an order for
-- them). Naming the board's own axis says the same as NULL and is stored as
-- NULL (OPS.setBoardGrid), so there is one way to write it.

ALTER TABLE boards ADD COLUMN IF NOT EXISTS section_axis text
    CHECK (section_axis IS NULL OR section_axis IN ('location', 'application'));
