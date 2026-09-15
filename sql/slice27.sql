-- Slice 27: team boards - a board declares a LIST of groups
--
-- The operator's scenario is the spec: a Network Team and a Server Team
-- sharing one instance, each wanting one dashboard sectioned by ITS OWN
-- groups (applications for one team, physical sites for the other). The
-- single source_value generalizes to source_values, a jsonb array:
--
--   one entry     = today's board, unchanged in behavior
--   several       = the team board (sections in DECLARED order)
--   NULL + axis   = the all-fleet board (every value; no creation path
--                   yet - the schema and renderer accept it so the later
--                   trigger is a route, not a migration)
--
-- The old column stays and keeps carrying the FIRST value, because slice
-- files are applied-in-order history and a reader of old exports should
-- keep working; source_values is the truth the code reads. The backfill
-- is idempotent by its own WHERE.

ALTER TABLE boards ADD COLUMN IF NOT EXISTS source_values jsonb;

UPDATE boards
   SET source_values = jsonb_build_array(source_value)
 WHERE source_value IS NOT NULL AND source_values IS NULL;
