-- Slice 50 (DECISIONS-2026-09-01 ruling 6, second half): the TCP check's
-- port.
--
-- sql/slice12.sql promised that when the TCP follow-on landed it would be "a
-- value here ('tcp'), not a migration" - and for reach_check itself that
-- promise held. The PORT is the one thing the column could not carry: rung 1
-- is one port per device STANDING IN for host reachability where ICMP is
-- filtered but a service answers, and which port answers is the operator's
-- fact about their device, not a constant.
--
-- Nullable, and null is meaningful: only reach_check='tcp' reads it, the
-- write route requires it exactly then, and a tcp row that somehow lacks one
-- (direct SQL, history) is REFUSED a probe and counted by the sweep's
-- partition - 'tcp (no port)' - rather than probed against a guess or
-- silently frozen. No CHECK constraint ties it to reach_check, for the
-- recorded reason the check column itself has none: the partition catches
-- the inconsistency and names it, where a constraint would only have refused
-- the write that caused it.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS reach_port int;
