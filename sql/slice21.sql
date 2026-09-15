-- Slice 21: the three roster values nothing collected - uptime, cores, RAM.
--
-- SLICE-ROSTER-COLUMNS-PLAN Group C. All three were one read away:
--
--   uptime_s   sysUpTime, which oids.ts defined and nothing ever read. One
--              OID added to the GET the poll already sends for sysName/
--              sysDescr/sysLocation - no extra round trip - written on every
--              successful poll. Blanked by the roster when the device is not
--              up, because the last uptime a dead agent reported is not its
--              uptime now. Independent of the reboot detector in
--              alerts/rules.ts, which watches the 'uptime' metric kind where
--              a sensor provides one.
--   cpu_cores  the inventory pass (slice 11) walks hrProcessorLoad for its
--              indices and kept only the first one's description; the count
--              of rows IS the core count. Same daily cadence, same
--              attempt-stamping rule: inventory_ts records the attempt, the
--              value stays null on an agent without HOST-RESOURCES and is
--              asked again tomorrow.
--   ram_kb     hrMemorySize (1.3.6.1.2.1.25.2.2.0), one GET in that same
--              inventory pass. KB because that is the unit the MIB defines.
--
-- cores and RAM are inventory facts and survive a down poll like cpu_model
-- does (coalesce); uptime is a reading and is written as read.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS uptime_s  double precision;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS cpu_cores int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS ram_kb    bigint;
