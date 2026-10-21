-- Slice 66 (2026-10-19): what a device is, and when that changes.
--
-- The operator, after upgrading a RouterOS switch: the Devices page's OS
-- column is the agent's raw sysDescr and its hardware column the processor
-- model, so a MikroTik showed "RouterOS CRS354-48G-4S+2Q+" as its OS (the model,
-- and no version - RouterOS put the version there only from 7.2x) and no
-- hardware at all; and nothing recorded, let alone said, that the upgrade
-- had happened. SNMPCanvas read the vendor's own tree for both.
--
-- The identity columns, read with the daily inventory, after a restart, and
-- once when this slice lands (identity_ts NULL) - src/collector/identity.ts
-- and the inventory in src/collector/poll.ts:
--
--   sys_object_id  the agent's sysObjectID: which rules apply
--   os_version     a vendor's own version where sysDescr lacks one
--                  (MIKROTIK-MIB mtxrLicVersion)
--   hw_model       a DEVICE model (a vendor tree, else ENTITY-MIB); the
--                  processor stays in cpu_model
--   fw_version     a MikroTik's RouterBOOT, installed ...
--   fw_upgrade     ... and the one its RouterOS offers
--   identity_ts    the last ATTEMPT at the identity read; NULL = never
--   os_summary     the OS in words, from the poll's own sysDescr every poll
--
-- device_changes: one row each time os_summary, hw_model or fw_version moves
-- from one known value to another, written by the poll that saw it, in the
-- statement that stores the new value. A first value is not a change - this
-- slice's own backfill writes none. PLANNED, as for a restart: whether a
-- maintenance window covered the device at that moment.
--
-- change_seen_ts and change_planned carry the latest one on the device row
-- for the scan, the way reboot_seen_ts carries a restart: the change alert
-- (off by default, src/alerts/changes.ts) needs no join.
--
-- ON DELETE CASCADE: a device that goes takes its record.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS sys_object_id  text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS os_version     text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS hw_model       text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fw_version     text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fw_upgrade     text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS identity_ts    timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS os_summary     text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS change_seen_ts timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS change_planned boolean;

CREATE TABLE IF NOT EXISTS device_changes (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    device_id bigint NOT NULL REFERENCES devices (id) ON DELETE CASCADE,
    ts        timestamptz NOT NULL DEFAULT now(),
    field     text NOT NULL CHECK (field IN ('os', 'hardware', 'firmware')),
    old_value text NOT NULL,
    new_value text NOT NULL,
    planned   boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS device_changes_device_ts_idx
    ON device_changes (device_id, ts DESC);
