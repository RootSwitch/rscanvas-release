// Every knob in one place, all overridable by environment, so a run can be
// described by its command line.

import { downCap } from './collector/lanes.ts';

const num = (name: string, dflt: number): number => {
    const raw = process.env[name];
    if (raw === undefined || raw === '') return dflt;
    const v = Number(raw);
    if (!Number.isFinite(v)) throw new Error(`${name} must be a number, got ${JSON.stringify(raw)}`);
    return v;
};

// An env var set to the empty string is not a configured value. `??` disagrees,
// which cost the spike a seed run: an empty DATABASE_URL survived as an empty
// connection string and failed deep inside the driver as a SASL error about
// passwords, far from the actual mistake.
const str = (name: string, dflt: string): string => {
    const raw = process.env[name];
    return raw === undefined || raw === '' ? dflt : raw;
};

// Resolved ahead of the literal because the down lane's cap is derived from
// the pool (C6): an explicit POLL_DOWN_CONCURRENCY wins, an absent one means
// half the pool, and either is checked against the pool once, here.
const pollConcurrency = num('POLL_CONCURRENCY', 24);
const pollDownExplicit = process.env.POLL_DOWN_CONCURRENCY === undefined
    || process.env.POLL_DOWN_CONCURRENCY === ''
    ? null : num('POLL_DOWN_CONCURRENCY', 0);

export const CONFIG = {
    // THE DEFAULT NAMES NO REAL DATABASE, AND THAT IS THE POINT.
    //
    // It used to be rscanvas_spike, which turned an unset DATABASE_URL into a
    // silent connection to a PROTECTED corpus. That is the str() helper above
    // solving its own problem and creating a worse one: the confusing SASL
    // error it was written to prevent was at least LOUD, and pointing at a real
    // database instead is quiet and wrong.
    //
    // Measured on 2026-08-15, when an empty DATABASE_URL sent apply-schema at
    // rscanvas_spike on minipc. Harmless only by luck - spike is empty on that
    // box, so it failed instantly on a missing `messages`. On lab-stresstest
    // and lab-supersoak the same command would have found 82GB and 71GB of
    // protected corpus and begun building indexes on it, additively and
    // therefore un-refused, for hours, during a soak.
    //
    // Throwing here instead would be the obvious fix and is the wrong one: this
    // object is built at IMPORT time, so it would take down every offline test
    // that imports CONFIG without needing a database. A non-existent name fails
    // at CONNECT time instead, immediately.
    //
    // THE CREDENTIAL STAYS IN THE STRING ON PURPOSE, and this was measured
    // rather than assumed - the first version dropped it, and the first version
    // was wrong. All three forms are safe, but only one of them names the
    // actual mistake:
    //
    //   no password            fe_sendauth: no password supplied   (and psql PROMPTS)
    //   wrong password         password authentication failed for user "rscanvas"
    //   valid credential       database "DATABASE_URL_IS_NOT_SET" does not exist
    //
    // Keeping the conventional dev credential means a dev box gets the third
    // one, which says the variable's name back to you, and anywhere else gets
    // the second - still loud, still not a real database. Never the first,
    // because a prompt in a script is a hang.
    databaseUrl: str('DATABASE_URL', 'postgres://rscanvas:rscanvas@localhost:5432/DATABASE_URL_IS_NOT_SET'),

    httpPort: num('HTTP_PORT', 8080),

    // TLS, TERMINATED HERE, ON THE SAME PORT. Paths to a PEM certificate and
    // key; both set means https on HTTP_PORT, neither means plain http, and
    // ONE set is a boot failure (src/http/tls.ts) - a half-configured TLS
    // must not fall back to plaintext and look like it worked. The suite ran
    // one nginx per app with one self-signed cert each, which is one browser
    // warning per app; this is one port, one cert, one warning. The installer's
    // --tls mints the pair. A plain http request on the TLS port is answered
    // with a redirect to https, not a handshake error (src/http/tls.ts).
    tlsCert: str('TLS_CERT', ''),
    tlsKey: str('TLS_KEY', ''),

    // THE MAINTENANCE CREDENTIAL. CREATE/DROP INDEX CONCURRENTLY cannot run
    // inside a function, and on a hardened database the app role owns no
    // index and cannot create one ("must be owner of table") - so the jobs
    // thread's trigram maintenance runs on its own one-connection lane as the
    // role that does own them: rscanvas_admin, whose password the installer
    // already writes to the env file for apply-schema. Empty means the lane
    // falls back to the app credential, which works only on a database that
    // was never hardened (the app role owns everything there - minipc is the
    // lab's standing example). On a hardened one every drop then fails with
    // "must be owner of index", which the jobs health surfaces by name.
    // Measured on lab-stresstest and the sandbox, 2026-08-22 (slice 19).
    adminDbRole: str('RSCANVAS_ADMIN_DB_ROLE', 'rscanvas_admin'),
    adminDbPassword: str('RSCANVAS_ADMIN_DB_PASSWORD', ''),

    // 5514 and 5162 rather than 514 and 162, which is suite convention rather
    // than a new decision: the container runs unprivileged and the host maps
    // the privileged ports (syslogcanvas/server/syslog.js:12, traps.js:12).
    // Same env var names so packaging stays familiar.
    syslogPort: num('SYSLOG_PORT', 5514),
    trapPort: num('TRAP_PORT', 5162),
    bindAddress: str('BIND_ADDRESS', '0.0.0.0'),

    // Requested socket receive buffer. The kernel returns DOUBLE this from
    // getsockopt, reserving half for bookkeeping, so the ingest worker reports
    // requested and actual separately. Without that, the next person files a
    // bug against a working kernel.
    rcvbufBytes: num('RCVBUF_BYTES', 8 * 1024 * 1024),

    // Cap on a stored datagram. RFC 5424's minimum maximum is 480 bytes; 8192
    // is what the parent collector used and it has held.
    maxDatagramBytes: num('MAX_DATAGRAM_BYTES', 8192),

    // How many days of syslog carry a trigram index.
    //
    // Two separate things turn on this number, which is why it is a setting
    // rather than a constant.
    //
    // 1. Free-text search WITHOUT a device filter is only offered inside this
    //    window, because outside it the query is measured to breach the heavy
    //    lane's 30s timeout. A product rule derived from a measurement,
    //    enforced in the store so no handler can route around it.
    //
    // 2. A FILTERED search (with a device filter, which is permitted across
    //    full retention) costs about 190ms of cold time per day that falls
    //    OUTSIDE this window. On un-indexed partitions the plan falls back to
    //    host_ts_idx plus a heap fetch and filter per candidate row.
    //
    // Measured on the 30k-entity corpus, 2026-07-26, both directions:
    //
    //   TRGM_RECENT_DAYS=3   973MB of index,   2,343ms cold for a 14 day
    //                                          filtered search
    //   TRGM_RECENT_DAYS=14  5,783MB of index,   245ms cold, flat
    //
    // Nothing here can choose between 4.8GB of disk and two seconds on a rare
    // query: it depends on how often anyone searches past three days on a
    // deployment this repo cannot see. Default to recent-only, and see
    // ARCHITECTURE.md section 3b before changing it.
    //
    // Raising it is not instant. sync_recent_trgm_indexes() builds the index on
    // partitions that have aged in, and those are populated, so that run pays a
    // real index build per partition rather than creating an empty one.
    trgmRecentDays: num('TRGM_RECENT_DAYS', 3),

    // The hard ceiling on a search window, whatever the UI asks for.
    maxSearchWindowHours: num('MAX_SEARCH_WINDOW_HOURS', 24 * 14),

    // --- the free-text ceiling, which is a POLICY and not a cost model -------
    //
    // A SEPARATE, MUCH TIGHTER ceiling for free text with no device filter,
    // because that shape has no bounded cost and no way to estimate one.
    // `msg ILIKE '%sub%'` has no selectivity statistics in Postgres at all, so
    // the planner guesses; with ORDER BY ts DESC LIMIT n over an OR of two such
    // predicates it abandons both trigram indexes and walks the ts index
    // backwards, betting the limit fills early. MEASURED on lab-stresstest and
    // minipc 2026-08-15: that bet is correct for a common term and unbounded
    // for a rare one, and the same query is milliseconds or thirty seconds
    // depending only on what the operator typed.
    //
    //   <= 24h  ->  Bitmap Index Scan on the trgm indexes    (bounded)
    //   >= 48h  ->  Index Scan using messages_*_ts_idx       (a gamble)
    //
    // minipc ran the 240h form ~10x/minute for eleven hours against a term with
    // ZERO matches in 8.6M rows, so the limit could never fill: a full scan of
    // the window, every time, until it saturated the heavy lane and took the
    // coverage probe down with it.
    //
    // 24 IS THE MEASURED CROSSOVER ON A 4-CORE BOX WITH ~360k msg/hour, and
    // that is exactly why it is a policy rather than a prediction - the flip
    // point moves with row estimates, so a deployment that raises this is
    // choosing to accept an unbounded query, not calibrating one. Coverage was
    // the previous proxy for this and INVERTED: complete coverage is what let
    // the slow query in. See SOAK-CRITERIA section 5b.
    //
    // Named device filters are exempt because they bound the scan themselves,
    // which is what the refusal text tells the operator to add.
    freeTextMaxHours: num('FREE_TEXT_MAX_HOURS', 24),
    defaultSearchLimit: num('DEFAULT_SEARCH_LIMIT', 500),
    maxSearchLimit: num('MAX_SEARCH_LIMIT', 5000),

    // --- export queue admission (BUILD-PLAN, settled before slice 3) --------
    //
    // The lane has 2 connections and no statement timeout, and the permitted
    // worst case holds one for 456.9s. A queued-job model fixes the caller's
    // experience and moves the admission problem up a level, so the queue is
    // bounded too - by WAIT rather than by depth, because measured job
    // durations span 0.3s to 456.9s and a depth of ten expresses no policy.

    exportSpoolDir: str('EXPORT_SPOOL_DIR', './data/exports'),
    /** Must match the export lane's pool size, or the projection is wrong. */
    exportConcurrency: num('EXPORT_CONCURRENCY', 2),

    // connectionTimeoutMillis at the job layer. A caller told "about 22
    // minutes" can narrow their window; one handed a job id cannot.
    exportMaxQueueWaitMs: num('EXPORT_MAX_QUEUE_WAIT_MS', 10 * 60_000),

    // Fairness. Without it one caller fills the queue and a second operator's
    // 2,465 row export waits behind 46 million.
    exportMaxPerUser: num('EXPORT_MAX_PER_USER', 3),

    // A confirmation, not a refusal. 46.6M rows is 10.9GB of CSV, which is not
    // a usable deliverable, but it is not the tool's business to forbid.
    exportConfirmRows: num('EXPORT_CONFIRM_ROWS', 1_000_000),

    // Disk is a real limit. Checked against the estimate rather than
    // discovered at byte 10,900,000,000.
    exportMaxBytes: num('EXPORT_MAX_BYTES', 20 * 1024 ** 3),

    exportRetentionMs: num('EXPORT_RETENTION_MS', 24 * 3600_000),

    // --- SNMP collector -------------------------------------------------------
    //
    // Poll scheduling is SLOT-SECONDS: capacity is CONCURRENCY x 60 seconds per
    // minute. These two numbers are therefore capacity decisions rather than
    // politeness. 5s with 1 retry is where "a dead device costs about 10s
    // against about 50ms for a responder, roughly 200x" comes from, which is
    // why down devices get their own concurrency cap.
    snmpTimeoutMs: num('SNMP_TIMEOUT_MS', 5000),
    snmpRetries: num('SNMP_RETRIES', 1),
    snmpWalkMaxRows: num('SNMP_WALK_MAX_ROWS', 5000),
    /**
     * The hard ceiling on ONE subtree walk's wall time (AUDIT-2026-09-01
     * finding 1). The row cap bounds MEMORY and, since the stop signal,
     * time-to-the-end-of-a-big-table - but an agent whose OIDs cycle
     * without advancing re-delivers suffixes the walk's map already holds,
     * so the size never grows and the cap never trips; and the probe once
     * measured a walk that hangs with NO callbacks at all (an unserved
     * subtree on the lab's own mock agent). The progress guard in walk()
     * kills the first mode at the first repeated batch; this deadline is
     * the backstop for the second, where there is no batch to judge.
     * Generous on purpose - a legitimate 48-row column walk is seconds at
     * worst even on a RouterOS under load - because the cost of firing
     * late is one slow poll, and the cost it exists to remove is a poll
     * slot leaked until restart.
     */
    snmpWalkDeadlineMs: num('SNMP_WALK_DEADLINE_MS', 15_000),
    // How many subtree walks one poll fires at one agent AT ONCE. RouterOS
    // silently drops requests past ~8-10 in flight, turning every poll into
    // timeout-plus-retry - see walkMany in snmp.ts for the measurements. 6
    // sits under the observed cliff; raise it only with a fleet that has no
    // shallow-queue agents, and expect nothing in return for raising it.
    snmpWalkConcurrency: num('SNMP_WALK_CONCURRENCY', 6),
    // Slice 36: how long ping latency history is kept. Longer than raw
    // samples because the rows are three small columns and the question
    // ("was the internet slow last Tuesday") is asked about last week, not
    // the last hour.
    pingHistoryDays: num('PING_HISTORY_DAYS', 30),

    /** Total in-flight polls. Raise this for slow agents; a bigger box does not help. */
    pollConcurrency,
    /**
     * Concurrent polls of devices currently considered DOWN, counted
     * separately. Without this a handful of dead devices starves the loop,
     * because each holds a slot for 200x as long as a responder.
     *
     * HALF THE POOL BY DEFAULT since C6 (2026-09-06), where it was a fixed 4:
     * the cap sets how fast a recovered device is noticed (a dead population
     * cycles every N x timeout / cap seconds), and 4 of a pool of 64 left a
     * 400-device outage taking ~17 minutes to clear. Set POLL_DOWN_CONCURRENCY
     * to pin it; a value covering the whole pool is refused at startup. The
     * arithmetic and the 30k measurements behind the fraction are in
     * collector/lanes.ts.
     */
    pollDownConcurrency: downCap(pollConcurrency, pollDownExplicit),
    /** Whether the cap above was pinned by the operator or derived from the pool. */
    pollDownConcurrencySource: (pollDownExplicit === null ? 'default' : 'env') as 'default' | 'env',
    /** Failures before a device is treated as down for scheduling purposes. */
    pollDownAfter: num('POLL_DOWN_AFTER', 2),
    /**
     * The 30s floor, enforced here as well as by a CHECK constraint on
     * devices.poll_interval_s. The parent enforced it in three places
     * deliberately; a floor that one code path can bypass is not a floor.
     */
    pollIntervalFloorS: num('POLL_INTERVAL_FLOOR_S', 30),
    /** How often the scheduler looks for due devices. */
    pollTickMs: num('POLL_TICK_MS', 1000),
    /**
     * When /api/health/work starts reporting the collector as not keeping up.
     * A MEDIAN poll later than one whole interval means half the fleet has
     * missed a cycle, which is not a spike.
     *
     * MEDIAN, AND NOT p95. The full reasoning, including the wrong version I
     * wrote first, is in src/health/work.ts - the short form is that the
     * collector's percentiles are over POLL EVENTS, where a standing dead
     * tier is under 1% and cannot reach p95 (measured: p50 920ms, p95
     * 1,093ms with 78 devices dead), while the same fleet percentiled over
     * DEVICES gives p95 83,115ms and would alarm forever.
     *
     * So: p50, and do not "fix" this to p95 later.
     */
    pollLagAlarmMs: num('POLL_LAG_ALARM_MS', 30_000),
    // How long the database may refuse work before /api/health/work answers
    // 503 (health/work.ts databaseVerdict). A minute: two alert scans at the
    // default 30 s, so one unlucky query cannot trip it, and well inside the
    // three-minute outage the 2026-09-28 drill ran without a single red.
    dbOutageAlarmMs: num('DB_OUTAGE_ALARM_MS', 60_000),
    collectorEnabled: num('COLLECTOR_ENABLED', 0) === 1,

    /**
     * Reachability (slice 9). The interval floor is 5s - a FRESH derivation,
     * not the SNMP 30s inherited: ping exists for down-detection latency and
     * time-to-page is raiseScans x scan interval + probe interval. Enforced by
     * validatePingInterval in src/collector/reach.ts, which the worker calls
     * at startup - asked-for-2s fails loudly rather than silently becoming 5.
     */
    pingEnabled: num('PING_ENABLED', 1) === 1,
    pingIntervalS: num('PING_INTERVAL_S', 10),
    pingTimeoutMs: num('PING_TIMEOUT_MS', 800),
    /** Answering at or over this rtt is `degraded`; exit is 80% of it. */
    pingDegradedMs: num('PING_DEGRADED_MS', 150),
    /**
     * The TCP reach lane (ruling 6, rung 1). Timeout is per connect and
     * looser than ICMP's on purpose: a lost SYN retransmits at ~1s, so 2s
     * gives one retransmission its chance where 800ms would call a lossy
     * path dead. Spacing is the lane's whole concurrency model - sockets
     * outstanding never exceed ceil(timeout / spacing) + 1 regardless of
     * fleet size (tcpcheck.ts derives it), so at these defaults a sweep
     * holds at most 101 sockets and an all-dead fleet costs one timeout
     * tail, not one timeout per device.
     */
    tcpCheckTimeoutMs: num('TCP_CHECK_TIMEOUT_MS', 2000),
    tcpCheckSpacingMs: num('TCP_CHECK_SPACING_MS', 20),

    /**
     * Whether the collector maintains the denormalised last-value columns.
     *
     * A switch rather than a decision, because slice 4e measures BOTH shapes
     * against the same fixture. The parent rejected denormalising on
     * better-sqlite3, where writes were synchronous and serialised behind one
     * writer; on Postgres with an async driver and per-lane pools that trade
     * may invert, and the answer is a measurement rather than an inheritance.
     * See RESULTS-SLICE-4.md.
     */
    lastValueWrites: num('LAST_VALUE_WRITES', 1) === 1,

    // --- the scheduled jobs (slice 5) -----------------------------------------
    jobsEnabled: num('JOBS_ENABLED', 0) === 1,

    // Rollup. The window comes from the persisted frontier, not the clock, so
    // the interval controls how OFTEN it catches up rather than how much it
    // covers - a missed run is covered by the next one.
    rollupIntervalMs: num('ROLLUP_INTERVAL_MS', 5 * 60_000),
    /** One transaction covers at most this, so a long gap heals in bounded steps. */
    rollupChunkHours: num('ROLLUP_CHUNK_HOURS', 24),
    /**
     * And one tick does at most this many, so catching up cannot hog the lane.
     *
     * MEASURED, 2026-07-27, 30,000 entities on the lab: one 24-hour chunk takes
     * 58.5s and 60.4s on two consecutive runs, writing 720,000 hourly rows each
     * (30,000 entities x 24 hours). So a chunk is a MINUTE, not a moment.
     *
     * That measurement is why this is 4 rather than 8. At 8 a catch-up tick
     * runs for about eight minutes against a five-minute interval, so every
     * intervening tick is a single-flight skip - harmless, counted, and exactly
     * what runOnce is for, but it makes "skipping" the permanent normal state
     * and therefore useless as a signal that something is wedged. Four chunks
     * is about four minutes and fits inside its own interval.
     *
     * Catch-up rate: 4 chunks x 24 hours per 5-minute tick, so roughly 19 hours
     * of backlog cleared per real minute. A 90-day cold start is about 90
     * minutes of work, during which the frontier is legitimately far behind and
     * rollupLagAlarmHours will report it - which is true rather than a false
     * alarm, and clears itself.
     */
    rollupChunksPerRun: num('ROLLUP_CHUNKS_PER_RUN', 4),
    /**
     * How far behind `now` the rollup's ceiling is held. THE WATERMARK MARGIN.
     *
     * A sample's `ts` is poll time; its COMMIT is one to ten seconds later
     * (collector flush timer plus collector-lane wait). Without this margin the
     * frontier can pass an hour while rows belonging to it are still in flight,
     * and because the frontier only moves forward those rows are never rolled -
     * then guard 5 sees the partition as consumed and retention drops them on
     * day 14. Gone from both tables, invisibly.
     *
     * Five minutes is thirty times the worst measured commit lag. It must be
     * larger than the deepest queue any writer can build in front of `samples`.
     * See roll_up_chunk in sql/slice5.sql for the full sequence.
     */
    rollupSettleMinutes: num('ROLLUP_SETTLE_MINUTES', 5),
    /**
     * How far the rollup may fall behind before health reports it.
     *
     * The failure this catches is silent by construction. If the rollup wedges,
     * guard 5 does exactly what it should - retention defers every raw samples
     * partition rather than destroying unrolled hours - and the consequence is
     * that nothing is ever expired. Disk then grows about 11GB a day at the
     * 30,000-entity ceiling until ENOSPC, which lands on INGEST and takes the
     * never-drop invariant with it. Roughly 30 days of green dashboards on the
     * lab's volume.
     *
     * 25 hours, not the retention horizon. In steady state the rollup has about
     * an hour of work per tick and finishes in seconds, so 25 hours is a wide
     * margin around normal rather than a tight bound.
     *
     * It is NOT a bound on catch-up. A measured chunk is a minute (see
     * rollupChunksPerRun), so a 90-day cold start runs about 90 minutes and
     * this alarm is on for most of it. That is a true statement about the
     * system - the rollup really is days behind, and retention really is
     * deferring everything meanwhile - so it is reported rather than suppressed,
     * and it clears itself without anyone acting on it.
     */
    rollupLagAlarmHours: num('ROLLUP_LAG_ALARM_HOURS', 25),

    // Retention. Defaults to DRY RUN, because the first time this runs against
    // a real deployment it should say what it would do.
    retentionIntervalMs: num('RETENTION_INTERVAL_MS', 3600_000),
    retentionDryRun: num('RETENTION_DRY_RUN', 1) === 1,
    retentionMinKeepDays: num('RETENTION_MIN_KEEP_DAYS', 7),
    retentionMaxDropPerRun: num('RETENTION_MAX_DROP_PER_RUN', 3),
    retentionMinPartitions: num('RETENTION_MIN_PARTITIONS', 2),
    retentionMaxSpanDays: num('RETENTION_MAX_SPAN_DAYS', 31),
    retentionLockTimeout: str('RETENTION_LOCK_TIMEOUT', '2s'),
    /**
     * Raw sample retention. 14 days is the decided default (SESSION-NOTES,
     * "raw retention: configurable, 14 day default"), and it sets the disk
     * sizing: about 158GB at the 30,000-entity ceiling.
     *
     * Past this the hourly rollup is the ONLY copy, which is why guard 5
     * refuses to drop a partition the rollup has not consumed.
     */
    rawRetentionDays: num('RAW_RETENTION_DAYS', 14),
    /** Syslog keeps longer than raw samples: it is 1/4 the volume and the only copy. */
    messageRetentionDays: num('MESSAGE_RETENTION_DAYS', 30),

    trgmSyncIntervalMs: num('TRGM_SYNC_INTERVAL_MS', 6 * 3600_000),

    // --- alerts (slice 6) ------------------------------------------------------
    //
    // The counters are SCANS, not seconds - the machine's behaviour is
    // independent of wall-clock jitter, and the parent's defaults carry over:
    // two breaching scans to raise, two normal scans to clear, twenty absent
    // scans before an alert whose source vanished ages out as source-removed.
    alertScanIntervalMs: num('ALERT_SCAN_INTERVAL_MS', 30_000),
    alertRaiseScans: num('ALERT_RAISE_SCANS', 2),
    alertClearScans: num('ALERT_CLEAR_SCANS', 2),
    alertMissingScans: num('ALERT_MISSING_SCANS', 20),
    /**
     * How long an interface may wear the collector's went-quiet stamp
     * (lv_stale_since) before the alert scan stops reading it at all - at
     * which point its alerts leave the doc and age out source-removed
     * through the missing-scans counter above (remedy 3 of
     * INVESTIGATION-DUP-INTERFACES-2026-09-01). The stamp only exists when
     * the DEVICE answers while this index is gone from its table, so a
     * device outage never starts this clock - freezing through outages is
     * unchanged. An hour is far above any index flap (one returning walk
     * clears the stamp) and far below the days a generation corpse wears it.
     */
    alertStaleHorizonMin: num('ALERT_STALE_HORIZON_MIN', 60),
    /**
     * How long a never-contacted device (a Force Add awaiting first
     * contact) reads 'pending' before it reads 'down' and pages once
     * (ruling 10). A day: long enough to power the guest machine up
     * tomorrow, short enough that a forced host with the wrong community
     * string does not wear a pending pill for a month.
     */
    pendingContactH: num('PENDING_CONTACT_H', 24),
    /** Cleared-alert history retention. */
    alertRetentionDays: num('ALERT_RETENTION_DAYS', 90),
    /**
     * How long an untracked, superseded generation corpse (see
     * pruneCorpseInterfaces) survives before the retention job removes it.
     * A week keeps the row visible long enough to be noticed and reclaimed
     * - the rekey planner rebinds by name right up until deletion.
     */
    corpseRetentionDays: num('CORPSE_RETENTION_DAYS', 7),
    /**
     * Re-page a still-active CRIT after this many hours of silence, and
     * again each interval until it clears or somebody acks it. ZERO IS OFF
     * and is the shipped default (DECISIONS-2026-09-01 ruling 2): a default
     * that re-pages would change behaviour on a live fleet unasked - the
     * same reason temperature defaults ship off. Crit only, deliberately;
     * the clock restarts on any communication (raise, escalate, or a
     * previous renotify).
     */
    alertRenotifyH: num('ALERT_RENOTIFY_H', 0),
    /**
     * Bearer token for GET /metrics (easy-win E2). Empty - the default -
     * means the endpoint does not exist: metrics are DETAIL, the
     * architecture's rule is that no detail is served without a credential,
     * and a scraper's credential is a bearer token, not a session
     * (Prometheus carries one natively via `authorization` in the scrape
     * config). Env-only like every other secret; mint it with
     * `openssl rand -hex 24`.
     */
    metricsToken: str('METRICS_TOKEN', ''),
    /**
     * Threshold overrides, merged over the defaults in src/alerts/scan.ts.
     * JSON with the RulesConfig shape; invalid JSON fails startup loudly
     * rather than silently alerting on defaults someone believes they changed.
     */
    alertRulesJson: str('ALERT_RULES_JSON', ''),

    /**
     * How often the slow-changing inventory attributes are re-read.
     *
     * 24 hours because the value it fetches - the CPU model - changes when
     * somebody swaps hardware. Set it to 0 to disable the read entirely,
     * which is the honest escape hatch for a fleet where the extra PDU is
     * unwelcome or where no agent exposes HOST-RESOURCES anyway.
     */
    inventoryRefreshMs: num('INVENTORY_REFRESH_MS', 24 * 3600_000),

    // Notification channels. A channel is enabled by giving it a target; the
    // empty defaults mean a bare deployment owes nobody anything. Pointing
    // the syslog channel at THIS process's own SYSLOG_PORT makes every raise
    // a searchable message row - alerting observable with zero external infra.
    alertSyslogHost: str('ALERT_SYSLOG_HOST', ''),
    alertSyslogPort: num('ALERT_SYSLOG_PORT', 514),
    alertSyslogFacility: num('ALERT_SYSLOG_FACILITY', 16),
    alertNtfyServer: str('ALERT_NTFY_SERVER', ''),
    alertNtfyTopic: str('ALERT_NTFY_TOPIC', ''),
    /** Bearer token, from the environment like every credential here. */
    alertNtfyToken: str('ALERT_NTFY_TOKEN', ''),

    // Email. Enabled by having a host, a from and at least one recipient -
    // any of the three missing means the channel is off rather than broken,
    // so a half-configured deployment owes nobody anything.
    alertSmtpHost: str('ALERT_SMTP_HOST', ''),
    alertSmtpPort: num('ALERT_SMTP_PORT', 587),
    /**
     * 'starttls' upgrades or FAILS - never silently plaintext, which is the
     * whole reason this is a mode rather than a boolean. 'tls' is implicit
     * TLS from byte one (port 465). 'none' is a dumb LAN relay and says so.
     */
    alertSmtpMode: str('ALERT_SMTP_MODE', 'starttls'),
    alertSmtpUser: str('ALERT_SMTP_USER', ''),
    /**
     * ARCHITECTURE section 4: secrets come from the environment or a column
     * encrypted at rest, never a file the web tier can read. The parent kept
     * this in its settings table; here it is env only, like SNMP_COMMUNITY.
     */
    alertSmtpPassword: str('ALERT_SMTP_PASSWORD', ''),
    alertSmtpFrom: str('ALERT_SMTP_FROM', ''),
    /** Comma-separated. */
    alertSmtpTo: str('ALERT_SMTP_TO', ''),
    /**
     * Off by default, and it must stay that way: accepting a self-signed
     * certificate is accepting an unauthenticated relay, which is a decision
     * an operator makes for a LAN box on purpose - never a default.
     */
    alertSmtpAllowSelfSigned: num('ALERT_SMTP_ALLOW_SELF_SIGNED', 0) === 1,

    // --- shutdown, and the ONE ORDERING THAT MUST HOLD -------------------------
    //
    // MAIN MUST OUTWAIT THE WORKER. These two values are a pair, they are used
    // in different files, and if the ordering ever inverts, main gives up while
    // the ingest worker is still writing and then calls process.exit - killing
    // it mid-flush and destroying accepted rows. That is a never-drop violation
    // produced entirely by two numbers being wrong relative to each other.
    //
    // They were both 15,000, which is not "ordered", it is a RACE decided by
    // scheduling luck. It never fired because drain measures ~2s at 22,000
    // queued rows - but drain time scales with queue depth, so a shutdown at
    // the 50,000 row cap pushes it toward its deadline and the race becomes
    // live exactly when there is most to lose.
    //
    // So main's wait is DERIVED rather than written down twice. Tuning the
    // drain deadline cannot invert the relationship, and there is no second
    // number to remember.

    /**
     * How long the ingest worker keeps flushing on shutdown before abandoning
     * what is left - loudly, naming the count.
     *
     * PAIRED WITH shutdownWaitMarginMs: main waits this PLUS that margin.
     */
    ingestDrainDeadlineMs: num('INGEST_DRAIN_DEADLINE_MS', 15_000),

    /**
     * How long the collector keeps waiting on shutdown for in-flight polls to
     * settle and the pending sample batch to flush, before abandoning what is
     * left - loudly, naming the counts. Sized for the slowest thing it waits
     * on: a down-lane poll holds its slot for the full SNMP conversation, so
     * the default covers one of those plus a flush.
     *
     * PAIRED WITH shutdownWaitMarginMs exactly as the ingest deadline is:
     * main derives its wait from this plus the margin, so the relationship
     * cannot invert - the note above records what two independently-written
     * shutdown numbers cost.
     */
    collectorDrainDeadlineMs: num('COLLECTOR_DRAIN_DEADLINE_MS', 15_000),

    /**
     * How long the jobs worker lets an in-flight job finish on shutdown
     * before exiting with it still running. Lives HERE rather than as the
     * literal it used to be inside jobs.ts, because main derives its own
     * wait from this value plus the margin - same pairing, same reason.
     */
    jobsStopDeadlineMs: num('JOBS_STOP_DEADLINE_MS', 20_000),

    /**
     * How much longer main waits than the worker's drain deadline.
     *
     * Must be > 0, checked at startup rather than trusted. With a real margin,
     * `wait-ended by=main-timeout` becomes unambiguous: it means the worker
     * genuinely blew its own budget, which is worth alarming on - rather than
     * "the two timers expired together and main happened to win".
     */
    shutdownWaitMarginMs: num('SHUTDOWN_WAIT_MARGIN_MS', 5_000),

    heartbeatMs: num('HEARTBEAT_MS', 10),
    // ARCHITECTURE.md section 8: above this in the collector or ingest threads
    // under the 30k fixture, the isolation model gets revisited.
    heartbeatThresholdMs: num('HEARTBEAT_THRESHOLD_MS', 50),

    // Whether to bind the SNMP trap socket at all. The socket is slice 1's
    // (the ingest worker owns both), but a box without net-snmp installed
    // should still be able to run the syslog path.
    trapsEnabled: num('TRAPS_ENABLED', 1) === 1,

    /**
     * The hand-placed board layout controls on the System tab's Boards
     * panel (2026-09-30, the operator: "focus on its built in Auto-Layout
     * functionality ... the manual layout controls are making the Boards and
     * displays section a bit confusing", and "hold onto the code because
     * manual layout might be something I want to revisit"). Off: boards are
     * generated from a group and lay themselves out to fit the screen, and
     * the panel shows only that. 1: the CrossCanvas round trip comes back -
     * the layout CSV export and import, empty boards, and the grid editor's
     * "drawn from coordinates" choice. The server keeps all of it either
     * way, so a board already drawn by hand still renders.
     */
    boardsManualLayout: num('BOARDS_MANUAL_LAYOUT', 0) === 1,
} as const;

export type Config = typeof CONFIG;
