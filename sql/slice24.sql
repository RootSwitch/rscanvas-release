-- Slice 24: threshold rows speak the ENGINE's vocabulary.
--
-- The collector names sensor kinds fs and gauge; the rules engine names
-- them disk and util (alertScanSensors makes exactly this rename in SQL,
-- with a comment saying the mismatch is silent). The sensor-card threshold
-- control posted the COLLECTOR's word, the row stored it, and the engine's
-- override lookup - keyed on the engine's word - missed it forever. A Set
-- or Mute on a filesystem or gauge sensor was a silent no-op: the operator
-- saw "muted", the scan kept alerting. Found 2026-08-27 while building
-- threshold provenance, BEFORE any such row existed in a real deployment
-- (every live override is mem or temp, identical in both vocabularies).
--
-- The write path now normalizes (main.ts, the one place rows are created);
-- this slice renames anything already stored.
--
-- SECOND LESSON, same day: the first version of this slice also removed a
-- theoretical shadow row and was REFUSED by apply-schema's additive guard
-- on a production install - which is that guard doing its job. The
-- destructive statements belong to slice 5 and the retention machinery;
-- a numbered slice does not get them. So the rename below SKIPS a row
-- whose target name is already taken by a working row (a case never
-- observed anywhere): the leftover stays under its old kind, inert to the
-- engine, visible in the fleet Thresholds table where the operator can
-- remove it with the existing control. Additive, idempotent, and honest
-- about the one row it will not touch.

UPDATE threshold_overrides o
   SET kind = CASE o.kind WHEN 'fs' THEN 'disk' ELSE 'util' END
 WHERE o.kind IN ('fs', 'gauge')
   AND NOT EXISTS (SELECT 1 FROM threshold_overrides t
                    WHERE t.kind = CASE o.kind WHEN 'fs' THEN 'disk' ELSE 'util' END
                      AND t.host IS NOT DISTINCT FROM o.host
                      AND t.code IS NOT DISTINCT FROM o.code);
