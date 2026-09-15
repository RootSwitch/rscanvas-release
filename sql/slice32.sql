-- Slice 32: device-type icons on wall tiles.
--
-- Two columns, and the pair is the point. `stencil` is what the MACHINE
-- decided from sysDescr (guessStencil, which has answered this question for
-- the CSV export since the wizard slice); `stencil_override` is what the
-- OPERATOR decided when the machine was wrong. Same shape as
-- speed_override_bps: the guess is written every poll and the override is
-- never second-guessed - and the reader always takes the override when it
-- exists.
--
-- Why an override is not optional here: guessStencil reads a DEVICE-REPORTED
-- string, and a device that renames itself changes its own icon. That is
-- acceptable because an icon is presentation rather than control flow (the
-- provenance note in stencil.ts makes the argument), but it does mean a
-- fleet will contain wrong icons, and a wrong icon nobody can correct is a
-- small permanent lie on a wall somebody stares at all day.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS stencil text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS stencil_override text;
