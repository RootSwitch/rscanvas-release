-- Threshold overrides: the defaults are a starting point, overrides are the
-- product. See SLICE-THRESHOLDS-PLAN.md.
--
-- The rules engine (src/alerts/rules.ts) has carried per-code and per-host-kind
-- overrides, mute-by-disable and a source label since it was ported, fed from
-- one env var parsed at module load. This table persists them, and the jobs
-- worker re-reads it every scan. ALERT_RULES_JSON keeps working and is merged
-- UNDER this table: env first, a row here wins on the same target.
--
-- Three tiers, by which of host/code are NULL:
--   host NULL, code NULL   kind-global: a DEFAULT expressed as data
--   host set,  code NULL   every entity of this kind on this device
--   code set               one entity, by its stable code (host ignored)
-- Precedence code > host-kind > kind > DEFAULT_RULES.
--
-- enabled=false is MUTE. The entity keeps polling, keeps its history and its
-- card; only its threshold rule is suspended, and the card says so. Deleting
-- the row restores whatever the next tier says. No separate mute table.
--
-- UNIQUE with NULLS NOT DISTINCT (Postgres 15+) so there is exactly one row
-- per target per tier - a second "temp everywhere" row is a conflict, not a
-- silent shadow.

CREATE TABLE IF NOT EXISTS threshold_overrides (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind       text NOT NULL,
    host       text,
    code       text,
    warn       double precision,
    crit       double precision,
    enabled    boolean NOT NULL DEFAULT true,
    note       text,
    created_ts timestamptz NOT NULL DEFAULT now(),
    updated_ts timestamptz NOT NULL DEFAULT now(),
    UNIQUE NULLS NOT DISTINCT (kind, host, code)
);

-- TEMPERATURE ALERTS OFF BY DEFAULT, as a row. Every monitoring product the
-- operator has run ships this way, because no single number is right across
-- forty degrees of spread between a spinning disk and a CPU package. The code
-- default (45/55) is left in DEFAULT_RULES untouched, so the engine's tests do
-- not change and so DELETING this row means something: it restores the old
-- behaviour for an operator who wants it. Visible on the thresholds page like
-- any other override, with its note saying why it exists.
INSERT INTO threshold_overrides (kind, host, code, enabled, note)
VALUES ('temp', NULL, NULL, false,
        'Shipped default: temperature alerts are OFF. No single threshold fits a disk, a CPU and an NVMe. Delete this row to restore warn 45 / crit 55 everywhere, or add per-device overrides above it.')
ON CONFLICT (kind, host, code) DO NOTHING;
