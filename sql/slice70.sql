-- Slice 70 (2026-10-30, PATH-TO-BETA's beta list, N3): a log rule's scope.
--
-- A syslog/trap rule matched message text from ANY sender. The operator's
-- uplink rule (2026-10-29) reads "uplink-LAG link down" - any device
-- logging those words raises it - and an outside operator meets the same
-- the first time two switches share a port name ("ether1 link down").
--
-- event_rules.scope_kind   NULL: every sender, as every rule did before;
--                          'device', 'location' or 'application'.
-- event_rules.scope_value  the device's name, or the location's or
--                          application's value; set exactly when the kind
--                          is.
--
-- The ingest worker resolves a scope to device names when it reloads its
-- rules (every 30 s) and matches a message by its sender: the devices at
-- the source address, or a device named by the message's host.
--
-- Additive and NULL-able: no existing rule changes.

ALTER TABLE event_rules ADD COLUMN IF NOT EXISTS scope_kind text;
ALTER TABLE event_rules ADD COLUMN IF NOT EXISTS scope_value text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'event_rules_scope_ck') THEN
        ALTER TABLE event_rules ADD CONSTRAINT event_rules_scope_ck CHECK (
            (scope_kind IS NULL AND scope_value IS NULL)
            OR (scope_kind IN ('device', 'location', 'application')
                AND scope_value IS NOT NULL AND scope_value <> ''));
    END IF;
END $$;
