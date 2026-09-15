-- Slice 10: event-driven alerting. The rules table - and only the rules
-- table, because the decided design needs nothing else: event alerts are
-- ordinary rows in `alerts` (kind 'event', born active, one open row per key
-- via the existing partial unique index), and the rule id travels inside the
-- alert_key the design defined (event|<ruleId>|<host>), so `alerts` is not
-- altered at all.
--
-- A rule is a STRING MATCH, deliberately (operator scope decision,
-- 2026-08-02, SLICE-6-PLAN): substring or regex against the message text,
-- which covers traps too because the trap renderer flattens varbinds into
-- that text - matching "1.3.6.1.6.3.1.1.5.3" catches linkDown with zero MIB
-- support. The later era's definitions database is a PATTERN GENERATOR
-- emitting these same rows, so nothing here is throwaway.

CREATE TABLE IF NOT EXISTS event_rules (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Named by a human, unique so the UI and the audit log can say which one.
    name          text NOT NULL UNIQUE,
    pattern       text NOT NULL,
    -- Substring by default. A regex runs ON THE INGEST THREAD - the latency
    -- thesis's ground zero - so the risk posture is recorded in
    -- SLICE-10-PLAN item 4: compile-tested and length-capped at create,
    -- residual ReDoS risk on operator-authored patterns accepted and
    -- written down rather than mitigated with machinery.
    is_regex      boolean NOT NULL DEFAULT false,
    -- Which feed the rule listens to. 'any' is the default because most
    -- operators think in patterns, not transports.
    source        text NOT NULL DEFAULT 'any' CHECK (source IN ('any', 'syslog', 'trap')),
    severity      text NOT NULL CHECK (severity IN ('warn', 'crit')),
    -- The TTL clear: "this pattern has fired recently" is a standing
    -- condition needing no inverse pattern. Floor of 60 because a TTL
    -- shorter than the scan interval would flap by construction.
    clear_after_s int NOT NULL DEFAULT 300 CHECK (clear_after_s >= 60),
    enabled       boolean NOT NULL DEFAULT true,
    created_ts    timestamptz NOT NULL DEFAULT now(),
    created_by    text
);
