-- Slice 28: the 32-bit counter fallback flag.
--
-- Found by the operator's iperf drill: their Windows Server DCs answer 40
-- rows of 32-bit ifInOctets and ZERO rows of ifHCInOctets, and the fork
-- polls HC exclusively - so the busiest machines in the test never showed
-- a byte, on either instance, ever. RSAlly splits the difference on one
-- agent: HC on the wired NIC, nothing on the Wi-Fi. So the fallback is
-- PER INTERFACE, and this column is its persistent memory: which source
-- this entity's counters come from. Persistent rather than per-poll
-- because a delta computed across a source flip is garbage - the poll
-- detects the flip through this flag, skips one delta, and moves on.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS hc_missing boolean NOT NULL DEFAULT false;
