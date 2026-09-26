-- Slice 54 (2026-09-25, operator request): mute a whole device's alerts.
--
-- One boolean, operator-declared, audited - the same posture as `transient`
-- (slice 25), and deliberately a different fact. Transient says the device's
-- ABSENCE is not a fault, so device-down never raises while its readings
-- still alert when it is present. Muted says nothing about this device
-- should raise at all: device-down, its interfaces, its sensors. It is the
-- per-interface mute (a disabled threshold override) applied to every rule
-- of one device at once, which is what a guest PC or a lab box wants.
--
-- Muting is not unwatching: the device is still polled, charted, shown on
-- the wall and in the roster. Only the alert scan skips it, so its open
-- alerts go missing and retire as source-removed, as a muted interface's do.
-- Event rules (syslog and trap patterns) are governed by their own rules and
-- are not covered.
--
-- DEFAULT false backfills every existing device as unmuted: no behaviour
-- change on upgrade.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS alerts_muted boolean NOT NULL DEFAULT false;
