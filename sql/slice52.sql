-- Slice 52 (ruling 10, from the 2026-09-01 afternoon audit's finding 10):
-- when a device was added, so a promise can have an expiry.
--
-- Force Add creates rows that have never been contacted, and the one
-- status definition reads them as 'pending' rather than 'down' - down is a
-- verdict about a device we have seen. But pending had no terminal state:
-- a forced host with the wrong community string wore the pill for as long
-- as the row existed and raised nothing. The horizon (PENDING_CONTACT_H,
-- 24h default) is measured from this column; past it a never-seen row falls
-- through to the ordinary arms, reads down, and pages once.
--
-- DEFAULT now() backfills every existing row with the migration moment,
-- which is exactly right: every row that predates this column has either
-- been seen (the arm never consults added_ts) or was never seen and now
-- gets a day's grace from the upgrade before it reads down - honest, and
-- the only one-time behaviour change this slice makes.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS added_ts timestamptz NOT NULL DEFAULT now();
