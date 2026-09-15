-- Slice 4: the SNMP collector.
--
-- Additive, like every slice file. No DROP; src/db/apply-schema.ts refuses one.
--
-- The spike already created devices, entities, samples and samples_hourly and
-- filled them with 600 synthetic devices, 30,000 entities and 92GB of samples.
-- This extends those tables rather than replacing them, for the same reason
-- slice 1 extended messages: the measurements that matter were taken against
-- that corpus, and a different one makes them unfalsifiable.

-- --- id allocation ------------------------------------------------------------
-- The spike inserted explicit ids (devices 1..600, entities 1..30000) because
-- it seeded a fixed inventory. A collector discovers things and needs to
-- allocate.
--
-- The sequences START AT 10000 and 100000, well past the seeded range, which
-- buys a property worth having: an id below the start is fixture, at or above
-- is real. Fixture and collector rows stay separable in every later query
-- without a flag column, and a measurement can be scoped to one or the other.
CREATE SEQUENCE IF NOT EXISTS devices_id_seq AS bigint START WITH 10000;
CREATE SEQUENCE IF NOT EXISTS entities_id_seq AS bigint START WITH 100000;
ALTER TABLE devices  ALTER COLUMN id SET DEFAULT nextval('devices_id_seq');
ALTER TABLE entities ALTER COLUMN id SET DEFAULT nextval('entities_id_seq');

-- --- devices -------------------------------------------------------------------
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_version   text NOT NULL DEFAULT '2c';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS snmp_port      int  NOT NULL DEFAULT 161;
-- Community strings and v3 keys are secrets. ARCHITECTURE.md section 4 says
-- they come from the environment or from a column encrypted at rest, never
-- from a file the web tier can read. Slice 4 stores a REFERENCE to an
-- environment key rather than the secret itself, which keeps the invariant
-- without pulling a key-management decision into a collector slice.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS credential_ref text NOT NULL DEFAULT 'SNMP_COMMUNITY';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sys_name       text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sys_location   text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS sys_descr      text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS uptime_code    text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_seen_ts   timestamptz;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS last_poll_ts   timestamptz;
-- The 30s floor is enforced in three places in the parent, deliberately. This
-- is one of them, and it is the one that cannot be bypassed by a code path.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS poll_interval_s int NOT NULL DEFAULT 30;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS enabled        boolean NOT NULL DEFAULT true;
-- Drives the separate cap on concurrent DOWN devices. A dead device costs
-- about 10s of slot time against about 50ms for a responder, roughly 200x, so
-- a handful of them starves the loop unless they are counted apart.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS consecutive_failures int NOT NULL DEFAULT 0;

DO $$ BEGIN
    ALTER TABLE devices ADD CONSTRAINT devices_poll_floor CHECK (poll_interval_s >= 30);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- THE SEEDED FIXTURE DEVICES ARE NOT POLLABLE, and saying so is load bearing.
--
-- The spike seeded 600 devices at invented addresses (10.20.x.y) to own its
-- 30,000 entities and 92GB of samples. They are data, not equipment. But
-- `enabled` defaults to true, so the moment the collector started it treated
-- all 600 as real and began polling addresses that answer nothing.
--
-- The effect was not subtle and it is worth recording, because the arithmetic
-- is the same one that motivates the down-device cap. Each costs a full 10s
-- timeout (5s x 1 retry), so 600 of them is 6,000 slot-seconds of demand per
-- cycle against a capacity of 24 x 60 = 1,440 per minute. The 100 real devices
-- were polled exactly once and then starved for the rest of the run: measured
-- at a poll lag p50 of 159 SECONDS against a 30 second interval.
--
-- Scoped by the same id boundary the sequences establish: below the start is
-- fixture, at or above is real.
UPDATE devices SET enabled = false WHERE id < 10000 AND enabled = true;

CREATE UNIQUE INDEX IF NOT EXISTS devices_uptime_code_idx ON devices (uptime_code)
    WHERE uptime_code IS NOT NULL;

-- Finding 13: devices.name had no unique constraint, so upsertDevice's
-- ON CONFLICT (id) could never fire - id is sequence-assigned and never
-- supplied, making the conflict target unreachable. The only caller did a racy
-- find-then-insert, so two concurrent registrations produced duplicate devices
-- with the same name, both polled: double samples per entity name, and codes
-- minted twice for the same logical interface.
--
-- Harness-only today, but the operation's NAME promises an idempotency it did
-- not have, and it will be reached for when device registration gets a UI.
CREATE UNIQUE INDEX IF NOT EXISTS devices_name_idx ON devices (name);

-- --- entities --------------------------------------------------------------------
ALTER TABLE entities ADD COLUMN IF NOT EXISTS snmp_index   text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS descr        text;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS admin_status smallint;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS oper_status  smallint;
-- exported was RENAMED to tracked by slice 23 (2026-08-25), and a bare
-- ADD COLUMN IF NOT EXISTS here re-created the old column on every full
-- re-apply after the rename - the column was "missing", after all - and
-- slice 23 then collided renaming it onto the survivor. Found 2026-08-27
-- by a production re-deploy, not by any drill, because the drills applied
-- slices with psql -f instead of the installer's own apply-schema series.
-- The guard adds the column only while the rename has not happened yet,
-- which is what IF NOT EXISTS was standing in for all along.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'entities'
                      AND column_name IN ('exported', 'tracked')) THEN
        ALTER TABLE entities ADD COLUMN exported boolean NOT NULL DEFAULT true;
    END IF;
END $$;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS first_seen_ts timestamptz DEFAULT now();

-- Codes share ONE namespace with device uptime codes and must be unique across
-- it. Enforced here as well as checked at mint time, because mint-time
-- checking is a read followed by a write and two discoveries running at once
-- can both pass it.
--
-- SCOPED TO COLLECTOR-MINTED ROWS (id >= 100000), and the reason is worth
-- stating rather than looking like timidity. The seeded fixture holds 30,000
-- entities with 29,728 distinct codes - 272 duplicates - because the spike's
-- seeder generated placeholder strings rather than calling the real minting.
-- The tell is that some of them contain characters the real alphabet excludes:
-- 'XSH0' has a zero, and 0/O/1/I are precisely what the alphabet drops.
--
-- So the fixture's codes were never real codes, and an unscoped unique index
-- would fail against 272 rows of synthetic data while proving nothing about
-- the invariant that matters. Scoping it to the range the collector allocates
-- from enforces uniqueness on every code this system actually mints, which is
-- the property that has to hold, without rewriting a 92GB fixture to satisfy a
-- constraint about data it does not contain.
CREATE UNIQUE INDEX IF NOT EXISTS entities_code_idx ON entities (code)
    WHERE code IS NOT NULL AND id >= 100000;
CREATE UNIQUE INDEX IF NOT EXISTS entities_device_kind_index_idx
    ON entities (device_id, kind, snmp_index)
    WHERE snmp_index IS NOT NULL;

-- --- denormalised last-value columns, for measurement ---------------------------
--
-- ARCHITECTURE.md section 7 defers this with "needs its own measured session",
-- and section 6 of the handoff records the parent's verdict: rejected for the
-- Pi because it trades write amplification for read speed.
--
-- THAT VERDICT WAS REACHED ON A DIFFERENT ENGINE and should not be inherited.
-- It was measured against better-sqlite3, where every write was synchronous,
-- serialised behind one writer, and on the same thread as everything else. On
-- Postgres with an async driver and per-lane pools the trade may invert: the
-- collector is already writing a sample, and an UPDATE of a last-value row
-- rides the same transaction on the same connection in the same lane.
--
-- The columns exist so BOTH shapes can be measured against the same fixture.
-- Adding them is free - no default, so catalogue-only - and the decision is
-- which READ path to serve and whether the write is worth paying for. See
-- tools/lastvalue-bench.ts and RESULTS-SLICE-4.md.
--
-- Semantics carried from snmp-status.json, which are one-way doors of their own:
--   * stale is PRESENT-WHEN-TRUE, so a consumer can tell "0 bps" from "we have
--     not heard about this port lately". Represented as a nullable timestamp
--     rather than a boolean: null means fresh, a value means stale since then.
--   * Error and discard rates stay FRACTIONAL. One CRC error a minute is
--     0.0167/s, and rounding it to an integer reports a failing port as clean.
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_ts      timestamptz;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_status  smallint;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_rtt_ms  real;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_v0 double precision;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_v1 double precision;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_v2 double precision;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_v3 double precision;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_v4 double precision;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_v5 double precision;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS lv_stale_since timestamptz;

-- --- raw counters, so rates can be computed across polls -------------------------
-- A gauge can be stored as read; a COUNTER cannot. Throughput is the delta
-- between two reads divided by the elapsed time, so the previous raw value and
-- its timestamp have to live somewhere. In the collector's memory would be
-- lost on restart, producing one bogus sample per entity per restart.
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_ts timestamptz;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_c0 numeric;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_c1 numeric;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_c2 numeric;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_c3 numeric;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_c4 numeric;
ALTER TABLE entities ADD COLUMN IF NOT EXISTS prev_c5 numeric;

-- The flag column's index, aware of the same rename as the ADD above: a
-- database where slice 23 has already run recreates it against tracked.
-- Found by the full-series drill on its FIRST outing - a renamed database
-- missing this index hit the old exported predicate - after two
-- production failures taught that psql -f drills prove nothing about the
-- installer's own apply path.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_indexes
                    WHERE schemaname = 'public' AND indexname = 'entities_pollable_idx') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'entities'
                      AND column_name = 'tracked') THEN
            CREATE INDEX entities_pollable_idx ON entities (device_id) WHERE tracked = true;
        ELSE
            CREATE INDEX entities_pollable_idx ON entities (device_id) WHERE exported = true;
        END IF;
    END IF;
END $$;
