-- Slice 49 (DECISIONS-2026-09-01 ruling 1): an escalation is a DEBT,
-- exactly as a raise is.
--
-- The machine emits `escalate` exactly once, on the warn-to-crit
-- transition, and severity is sticky - so an escalate whose dispatch was
-- skipped (maintenance window, notify policy, a channel down mid-pass) was
-- LOST: the owed-raise queue requires NOT notified_raise and the warn raise
-- had already been delivered. An incident could exit a window as a crit
-- nobody was paged about at any severity (CODE-REVIEW-2026-09-01 finding 3).
--
-- escalated_ts is the FACT, written by the scan's batch update from the
-- machine's row - an incident timestamp in the same family as raised_ts and
-- cleared_ts, and provenance the alert detail can show ("warn at 10:02,
-- crit at 10:14"). notified_escalate is the SETTLEMENT, owned by dispatch
-- like its two siblings. The batch update opens the debt (flips this false)
-- in the same statement that writes a NEW escalated_ts, so a crash between
-- scan and dispatch loses nothing - the queue is the database.
--
-- The default is false and means nothing until escalated_ts is non-null:
-- the owed-escalate predicate requires both, so the fleet's never-escalated
-- alerts are not a queue.

ALTER TABLE alerts ADD COLUMN IF NOT EXISTS escalated_ts timestamptz;
ALTER TABLE alerts ADD COLUMN IF NOT EXISTS notified_escalate boolean NOT NULL DEFAULT false;
