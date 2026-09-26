-- The tables every slice file assumes, so a database can be born from this
-- repo instead of inherited from the spike.
--
-- WHY THIS DID NOT EXIST UNTIL 2026-08-14, which is the part worth reading.
--
-- The lab evolved continuously from the measurement spike: `messages`,
-- `samples`, `devices` and `entities` were created by `spike/sql/schema.sql`
-- in July and every slice since has been ADDITIVE on top of them. So
-- `sql/slice1.sql` opens by adding INDEXES to `messages`, and nothing in
-- `sql/` ever created it. No database has ever been born from this directory,
-- and building the sandbox on 2026-08-14 was the first attempt anyone made.
-- It failed immediately: "relation messages does not exist".
--
-- Three breaks had accumulated invisibly, and only a fresh install could show
-- any of them:
--
--   1. no base DDL in sql/ at all - this file
--   2. harden-roles.sh needs functions the slice files create, and the slice
--      files need the admin role harden-roles.sh creates. Circular, and
--      invisible on a database that was hardened after it was already built.
--      Documented in RUNBOOK-INSTALL.md rather than papered over here.
--   3. samples_hourly came out UNPARTITIONED, because the spike left it that
--      way ("its volume is ~1/120th of raw") and production has since
--      partitioned it monthly. apply-schema's declared-shape check caught it.
--
-- The third is why this file exists rather than a copy of the spike's schema.
-- samples_hourly is the exact table the 2026-08-13 restore drill lost
-- 4,031,240 rows of, because `--exclude-table-data='public.samples*'` matched
-- it as well as `samples_*`. A sandbox built to rehearse that drill, with that
-- table in a different shape, rehearses a different bug.
--
-- ADDITIVE AND IDEMPOTENT, like every other file here: no DROP, no TRUNCATE,
-- no DELETE, so apply-schema.ts will run it and running it twice is running it
-- once. On a database that already has these tables it is a no-op, which is
-- what makes it safe to add to a path the lab hosts already use.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- --- the roster --------------------------------------------------------------
--
-- Columns beyond these arrive by slice: enabled, poll_interval_s and the SNMP
-- fields from slice 2, location/application/sys_* from slice 11. This file
-- deliberately carries only what the spike carried, so the slices keep owning
-- their own additions and there is one place per column rather than two.

CREATE TABLE IF NOT EXISTS devices (
    id         int PRIMARY KEY,
    name       text NOT NULL,
    host       inet NOT NULL,
    status     text NOT NULL DEFAULT 'up'
);

CREATE TABLE IF NOT EXISTS entities (
    id         int PRIMARY KEY,
    device_id  int NOT NULL REFERENCES devices (id),
    kind       text NOT NULL,
    name       text,
    alias      text,
    speed_bps  bigint,
    -- Opaque short code, minted from md5(device:entity), persisted and NEVER
    -- regenerated: it ends up in .xcanvas files on other people's disks, so a
    -- code that changes silently breaks a board somebody drew months ago.
    code       text
);
CREATE INDEX IF NOT EXISTS entities_device_idx ON entities (device_id);

-- --- raw samples, partitioned daily ------------------------------------------
--
-- Retention here is a partition DROP rather than a DELETE, which is the claim
-- ARCHITECTURE section 2 rests on: reclaiming a day costs one catalogue
-- operation instead of a 79 GB scan with no pruning.

CREATE TABLE IF NOT EXISTS samples (
    entity_id int NOT NULL,
    ts        timestamptz NOT NULL,
    status    smallint,
    -- Per-poll response time. Recorded because it cannot be backfilled, and
    -- slow agents are the measured cause of throughput loss.
    rtt_ms    real,
    v0 double precision, v1 double precision, v2 double precision,
    v3 double precision, v4 double precision, v5 double precision,
    PRIMARY KEY (entity_id, ts)
) PARTITION BY RANGE (ts);

-- --- the hourly rollup -------------------------------------------------------
--
-- PARTITIONED BY MONTH, and that is the one place this file deliberately
-- disagrees with spike/sql/schema.sql, which left it a plain table because at
-- spike scale it was ~1/120th of raw. Production partitions it (see
-- ensure_monthly_partitions in slice5), so a fresh install that made a plain
-- table would differ from every existing database in exactly the table the
-- backup exclusion globs are most dangerous around.
--
-- `n` is the sample count behind each row and is not decoration: re-bucketing
-- needs the weighted mean sum(a0*n)/sum(n), because averaging the averages
-- mis-weights precisely the hours when the poller was struggling.
--
-- A partitioned table's primary key must contain the partition key, which
-- (entity_id, hour_ts) does.

CREATE TABLE IF NOT EXISTS samples_hourly (
    entity_id int NOT NULL,
    hour_ts   timestamptz NOT NULL,
    n         int NOT NULL,
    a0 double precision, a1 double precision, a2 double precision,
    a3 double precision, a4 double precision, a5 double precision,
    m0 double precision, m1 double precision,
    st smallint,
    PRIMARY KEY (entity_id, hour_ts)
) PARTITION BY RANGE (hour_ts);

-- --- syslog ------------------------------------------------------------------
--
-- `raw` is the whole datagram, always kept whatever the parser made of it:
-- anything unparseable is stored with whatever fields did parse. That
-- invariant is why the parent collector survives dialects that break stricter
-- tools, and it is the only thing that makes a better parser RETROACTIVE.

CREATE TABLE IF NOT EXISTS messages (
    id        bigint GENERATED ALWAYS AS IDENTITY,
    ts        timestamptz NOT NULL,
    msg_ts    timestamptz,
    source_ip inet,
    facility  smallint,
    severity  smallint,
    host      text,
    app       text,
    msg       text,
    raw       text,
    PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);

CREATE INDEX IF NOT EXISTS messages_ts_idx ON messages (ts DESC);
-- NO TRIGRAM INDEX ON THE PARENT (removed 2026-09-24). Partial addresses and
-- interface names are what people type into a syslog search, and a trigram
-- GIN serves them - but only on RECENT partitions, which the trigram sync
-- builds and drops per partition (TRGM_RECENT_DAYS, slice 19). A partitioned
-- index here gave EVERY partition a second, permanent msg GIN beside the
-- sync's own, so the window never bounded message-text index storage and
-- recent partitions paid two GIN inserts per row. Measured on the lab-5 ingest
-- run: about a fifth of the write ceiling and 108 bytes a message
-- (RESULTS-INGEST-2026-09-24.md). Existing databases lose it through
-- slice53-retention.sql; search admission never counted it, because a day is
-- covered only when host is indexed too, and host was always windowed.

-- ensure_daily_partitions is NOT defined here. slice1.sql owns it, with the
-- timezone pinning and SECURITY DEFINER that the spike's version lacks, and
-- two definitions of one function is the drift this project keeps finding.
