-- Slice 53: the duplicate message trigram index goes (2026-09-24).
--
-- bootstrap.sql used to create messages_msg_trgm_idx on the partitioned
-- parent. PostgreSQL gives every partition a child of a partitioned index
-- (messages_<day>_msg_idx), and the trigram sync (slice 19) builds its own
-- messages_<day>_msg_trgm beside it on recent partitions - so every recent
-- message was trigram-indexed twice, and old partitions kept a message-text
-- GIN forever, which the sync's window exists to prevent. src/workers/jobs.ts
-- recorded this as KNOWN, DECIDED, DEFERRED on 2026-07-28; the lab-5 ingest
-- run (RESULTS-INGEST-2026-09-24.md) measured the cost at about a fifth of
-- the ingest write ceiling (syslog at 10,000/s: 2% lost with it, none
-- without) and 108 bytes a message. The operator approved the drop the
-- same day.
--
-- WHY A RETENTION FILE. Ordinary slices are additive and apply-schema
-- refuses any DROP in them; destructive statements ride with --with-retention,
-- the explicit act the installer and the documented upgrade already pass.
-- Nothing here removes data - only an index whose work the sync already does
-- on the days that matter - but the rule is about statements, and it holds.
--
-- WHAT SEARCH SEES: nothing new. Admission counts a day as trigram-covered
-- only when BOTH msg and host carry a valid GIN (TRGM_COVERAGE_SQL in
-- src/store/ops.ts), and host has only ever been indexed inside the window.
-- So unfiltered free text outside the window was already refused; what goes
-- away is an index the planner could combine with a device filter on old
-- days, where the device filter's btree already bounds the scan.
--
-- THE LOCK. Dropping a partitioned index takes ACCESS EXCLUSIVE on the parent
-- and each partition. The upgrade order applies schema while the old build is
-- still ingesting, so the wait is bounded: after 10 s behind a long search
-- this fails loudly and nothing changes - apply again - rather than holding
-- every COPY behind it. Idempotent: IF EXISTS, so every later apply is a
-- no-op.

BEGIN;
SET LOCAL lock_timeout = '10s';
DROP INDEX IF EXISTS messages_msg_trgm_idx;
COMMIT;
