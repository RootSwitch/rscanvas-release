// Main thread. HTTP, routing, and nothing that scales with data.
//
// ARCHITECTURE.md puts HTTP, auth, routing and board storage on the main thread
// with one condition attached: NO UNBOUNDED WORK ON IT. That is the whole of
// the main thread's job description, and it is why the only two routes here are
// a health report and a search that the store refuses to run unbounded.
//
// Every database call leaves this thread immediately: `pg` is async, so the
// loop is never occupied by database IO, and the exhaustible resource is the
// per-lane connection pool rather than the event loop. That relocation is the
// point of the whole design, and it is also where the 20.7s failure went to
// hide, which is why the lane state is on /api/health rather than in a log.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { isIP } from 'node:net';
import { loadTlsPair, createWebServer, TlsConfigError } from './http/tls.ts';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONFIG } from './config.ts';
import { startHeartbeat, type HeartbeatStats } from './heartbeat.ts';
import { installSafetyNet } from './safety.ts';
import {
    OPS, GRID_FIELDS, GRID_DEFAULT_FIELDS, UI_PAGE_CAP, UI_DEVICE_ENTITY_CAP, allLaneStates, closeAll,
    type SearchFilters,
} from './store/index.ts';
import { currentResidency, DISKSTATS_AVAILABLE } from './residency.ts';
import * as auth from './auth/index.ts';
import { authorize, type Principal } from './auth/authorize.ts';
import { parseIpValue, parseQuery } from './search/grammar.ts';
import { generateCode } from './collector/codes.ts';
import { mintSecret, hashToken, principalForToken, tokenFromRequest } from './auth/tokens.ts';
import { channelConfig, isNotifyConfigSane } from './alerts/notify.ts';
import { csvRow, inventoryHeader, parseCsv, headerIndex } from './export/csv.ts';
import { planRemoval, gateRemoval, normalizeNames, normalizeMode } from './devices/removal.ts';
import { compileRule } from './alerts/events.ts';
import {
    suggestLocations, selectForAdd, selectForForce, locationAssignments,
    normalizeProbeRequest, probedName, addOutcome, normalizeExplicitName, probeStanding,
    standingFields,
} from './devices/onboard.ts';
import { encrypt, decrypt, credentialStoreReady, CredentialKeyMissing } from './credentials/crypto.ts';
import { validateProfile, isPermittedEnvRef, type ProfileView } from './credentials/profiles.ts';
import { loadRulesConfig } from './alerts/scan.ts';
import { mergeOverrides } from './alerts/overrides.ts';
import { GROUP_KIND, parseGroupKey } from './alerts/groups.ts';
import { buildOverrideIndex, resolveRuleInfo, IF_RULE_KINDS } from './alerts/rules.ts';
import { expandCidr } from './devices/cidr.ts';
import { guessStencil, STENCIL_NAMES } from './export/stencil.ts';
import { parseSourceDeclaration, sameCoverage } from './boards/source.ts';
import { generatedShapes, appendMissing, dropMoved } from './boards/reconcile.ts';
import { workHealth } from './health/work.ts';
import { serializeMetrics } from './health/metrics.ts';
// Pure module, zero imports of its own: the constant is the sweep's own
// vocabulary, so the reach-check route cannot drift from what the collector
// can actually probe.
import { SUPPORTED_CHECKS } from './collector/reach.ts';
import {
    sendJson, sendJsonGzip, enforce, readJsonBody, readBodyOr400, containsNul, clientIp, inetOrNull, BODY_CAP_BULK, BODY_CAP_DOC, securityHeaders,
    crossSiteRefusal,
} from './http/respond.ts';
import * as authRoutes from './http/routes-auth.ts';
import * as exportRoutes from './http/routes-export.ts';
import * as exportJobs from './export/jobs.ts';
import {
    isPartitionHealthy, isFrontierHealthy, isJobsHealthy, isHeartbeatHealthy,
    isKernelDropFree, evaluateWorkers, isDbSelfHealthy, isRetentionEnforcing, isNotifyDelivering,
    type IngestStats, type CollectorStats, type JobsStats, type DbSelfState,
} from './workers/protocol.ts';
import {
    DASHBOARD_WINDOWS, parseWindowHours, bytesFromHourlyBps, countFromHourlyRate, coverage, trend,
    reportLines, reportCsv, isDay, isTimeZone,
} from './reports/traffic.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STARTED = Date.now();

// The Dashboard's top lists (/api/dashboard) and the interface report.
// Ten rows a list, as the operator's SolarWinds widgets had. A report is
// capped at 50 interfaces and a year.
//
// ONE ANSWER PER WINDOW PER ROLLUP HOUR (2026-09-30, the operator: "the only
// thing that took any time was changing the Dashboard to different time
// scales"). The lists read the hourly rollup and end at its frontier, so
// the answer for a window cannot change until the frontier moves - once an
// hour. The cache used to expire after a minute anyway, and every switch
// after that recomputed a fleet-wide aggregate on the heavy lane: at 30,000
// entities 1.1 s for a day and 3 s for a week, every time. It is now keyed
// by the frontier hour, concurrent asks share one computation, and the
// other windows are computed in the background as soon as anyone opens the
// Dashboard, and again when the frontier moves - so a switch finds its
// answer waiting. Background work stops a day after the last visit. A
// device renamed mid-hour shows its new name at the next rollup.
const DASHBOARD_TOP_N = 10;
const DASHBOARD_WARM_IDLE_MS = 24 * 3600_000;
type DashboardAnswer = { ok: true; body: Record<string, unknown> } | { ok: false; reason: string };
const dashboardCache = new Map<number, { hi: number; body: Record<string, unknown> }>();
const dashboardInflight = new Map<string, Promise<DashboardAnswer>>();
let dashboardLastAsked = 0;
let dashboardWarming = false;
const REPORT_MAX_INTERFACES = 50;
const REPORT_MAX_DAYS = 366;

// THE ORDERING IS CHECKED, NOT TRUSTED. Main must outwait the ingest worker's
// drain deadline; if it does not, main exits while the worker is still writing
// and accepted rows die with it. The margin is the only way that can invert, so
// it is refused at startup rather than discovered during a shutdown at 50,000
// queued rows. See the pair of notes in src/config.ts.
if (CONFIG.shutdownWaitMarginMs <= 0) {
    throw new Error(
        `SHUTDOWN_WAIT_MARGIN_MS must be greater than 0, got ${CONFIG.shutdownWaitMarginMs}. `
        + 'Main has to outwait the ingest worker\'s drain deadline - equal or shorter means main '
        + 'can kill the worker mid-flush and destroy datagrams it had already accepted.',
    );
}

const hb = startHeartbeat('main', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);
installSafetyNet({ thread: 'main' });

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[main]', ...args);
}

// --- ingest worker -----------------------------------------------------------

interface WorkerReport {
    thread: string;
    heartbeat: HeartbeatStats;
    [key: string]: unknown;
}

let ingestStats: IngestStats | null = null;
let ingestStatsAt = 0;

const ingest = new Worker(path.join(HERE, 'workers', 'ingest.ts'), {
    name: 'ingest',
});

// Declared HERE, above the worker wiring, because the death handlers below
// consult it: a worker exiting non-zero is FATAL while the system is running
// and merely reportable while a coordinated shutdown is already stopping
// every worker - process.exit(1) from a death handler mid-shutdown would
// abandon the other workers' drains to make a point nobody is listening to.
let shuttingDown = false;

// Typed by the SHARED contract, not asserted independently here. A field that
// moves in the worker now breaks the build on both sides at once instead of
// going quiet on one.
ingest.on('message', (msg: { type: string; stats?: IngestStats }) => {
    if (msg.type === 'ready') { log('ingest worker ready'); return; }
    if ((msg.type === 'stats' || msg.type === 'final') && msg.stats) {
        ingestStats = msg.stats;
        ingestStatsAt = Date.now();
    }
});
ingest.on('error', (err) => {
    // Fail loud. An ingest worker that has died is not a degraded service, it
    // is a violated invariant, and a process that keeps serving health checks
    // while dropping every datagram is the worst of both.
    log('FATAL ingest worker error:', err);
    if (!shuttingDown) process.exit(1);
});
ingest.on('exit', (code) => {
    if (code !== 0) { log(`FATAL ingest worker exited with ${code}`); if (!shuttingDown) process.exit(1); }
});

// The collector, off by default. It is the only worker that reaches out to the
// network on its own initiative, so it is opt-in rather than something a bare
// `node src/main.ts` starts polling a fleet with.
let collectorStats: CollectorStats | null = null;
let collectorStatsAt = 0;
let collector: Worker | null = null;
let jobsStats: JobsStats | null = null;
let jobsStatsAt = 0;
let jobsWorker: Worker | null = null;

if (CONFIG.collectorEnabled) {
    collector = new Worker(path.join(HERE, 'workers', 'collector.ts'), { name: 'collector' });
    collector.on('message', (msg: {
        type: string; stats?: CollectorStats; id?: string; results?: unknown[];
    }) => {
        if (msg.type === 'ready') { log('collector worker ready'); return; }
        if (msg.type === 'probe-result') {
            const p = pendingProbes.get(msg.id ?? '');
            if (p === undefined) return;   // timed out already; nothing to do
            clearTimeout(p.timer);
            pendingProbes.delete(msg.id ?? '');
            p.resolve(msg.results ?? []);
            return;
        }
        if ((msg.type === 'stats' || msg.type === 'final') && msg.stats) {
            collectorStats = msg.stats;
            collectorStatsAt = Date.now();
        }
    });
    collector.on('error', (err) => { log('FATAL collector worker error:', err); if (!shuttingDown) process.exit(1); });
    collector.on('exit', (code) => {
        if (code !== 0) { log(`FATAL collector worker exited with ${code}`); if (!shuttingDown) process.exit(1); }
    });
}

// Poll the worker for stats rather than having it push on a timer: the health
// endpoint is the consumer, and a worker pushing into a dead main thread is a
// leak. 1s is frequent enough that /api/health is never stale by much.
if (CONFIG.jobsEnabled) {
    jobsWorker = new Worker(path.join(HERE, 'workers', 'jobs.ts'), { name: 'jobs' });
    jobsWorker.on('message', (msg: { type: string; stats?: JobsStats }) => {
        if (msg.type === 'ready') { log('jobs worker ready'); return; }
        if (msg.stats) { jobsStats = msg.stats; jobsStatsAt = Date.now(); }
    });
    jobsWorker.on('error', (err) => { log('FATAL jobs worker error:', err); if (!shuttingDown) process.exit(1); });
    jobsWorker.on('exit', (code) => {
        if (code !== 0) { log(`FATAL jobs worker exited with ${code}`); if (!shuttingDown) process.exit(1); }
    });
}

setInterval(() => {
    ingest.postMessage({ type: 'stats' });
    collector?.postMessage({ type: 'stats' });
    jobsWorker?.postMessage({ type: 'stats' });
    exportJobs.requestWorkerStats();
}, 1000).unref();

// --- probing, on the collector's thread --------------------------------------
//
// Main does not open SNMP sessions. It asks the collector, which is the only
// worker that reaches the network on its own initiative, and waits for a
// correlated reply.
//
// EVERY PENDING PROBE HAS A DEADLINE. Without one, a collector that died
// mid-probe leaves the HTTP request hanging forever and the operator staring
// at a spinner - the failure mode this codebase keeps naming, where absence of
// an answer reads as "still working".
/**
 * Probe results held against a token, briefly.
 *
 * In memory rather than a table, deliberately: this is a step in a wizard, not
 * a record. A restart losing it costs one re-probe and the operator is still
 * sitting there; persisting it would mean a cleanup job for rows nobody reads.
 */
const PROBE_TTL_MS = 15 * 60_000;
interface CachedProbe {
    results: Array<Record<string, unknown>>;
    port: number; version: string; credentialRef: string; pollIntervalS: number;
    expires: number;
}
const probeCache = new Map<string, CachedProbe>();
function sweepProbeCache(): void {
    const now = Date.now();
    for (const [k, v] of probeCache) if (v.expires < now) probeCache.delete(k);
}

const pendingProbes = new Map<string, {
    resolve: (r: unknown[]) => void; reject: (e: Error) => void; timer: NodeJS.Timeout;
}>();

/**
 * A subnet scan on the collector thread: fping the list, get back the
 * responders. Same correlation map and timeout as a probe - the result
 * message is the same type - so there is one piece of plumbing, not two.
 */
function scanHosts(hosts: string[]): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        if (collector === null) {
            reject(new Error('the collector worker is not running, so nothing can be scanned (COLLECTOR_ENABLED=0)'));
            return;
        }
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
            pendingProbes.delete(id);
            reject(new Error('the scan did not finish in time'));
        }, 60_000);
        pendingProbes.set(id, { resolve, reject, timer });
        collector.postMessage({ type: 'scan', id, hosts });
    });
}

/**
 * Tell the collector its credentials changed (slice 42).
 *
 * FIRE AND FORGET, deliberately: the write has already succeeded and the
 * operator's answer must not wait on, or fail because of, a worker message.
 * The 30s timer is still there underneath - this makes the reload PROMPT,
 * not reliable, and the timer is what makes it reliable. A dropped message
 * costs the old behaviour, which is the behaviour we had.
 */
/**
 * Tell the ingest worker its event rules changed (slice 43).
 *
 * Same contract as credentialsChanged: fire and forget, the 30s timer still
 * underneath making it reliable. A rule is most often written while the thing
 * it matches is still happening, so the window this closes is aimed at
 * exactly the messages the rule exists for.
 */
function eventRulesChanged(): void {
    ingest.postMessage({ type: 'event-rules' });
}

function credentialsChanged(): void {
    // Optional chaining rather than a guard-and-log: before the collector
    // exists there is nothing to tell, and the timer will pick the change up
    // when it starts. That is the degradation this is allowed to have.
    collector?.postMessage({ type: 'credentials' });
}

function probeDevices(targets: Array<Record<string, unknown>>): Promise<unknown[]> {
    return new Promise((resolve, reject) => {
        if (collector === null) {
            reject(new Error('the collector worker is not running, so nothing can be probed '
                + '(COLLECTOR_ENABLED=0)'));
            return;
        }
        const id = crypto.randomUUID();
        // Generous, because it covers every target in the batch serially in the
        // worst case: 200 unreachable hosts at the SNMP timeout each, divided
        // by probeAll's concurrency. Better too long than an operator retrying
        // a batch that was still running.
        const timer = setTimeout(() => {
            pendingProbes.delete(id);
            reject(new Error('the probe did not finish in time - the collector may be saturated'));
        }, 180_000);
        pendingProbes.set(id, { resolve, reject, timer });
        collector.postMessage({ type: 'probe', id, targets });
    });
}

// --- helpers -----------------------------------------------------------------

function parseWindow(params: URLSearchParams): { from: Date; to: Date } | { error: string } {
    const toRaw = params.get('to');
    const fromRaw = params.get('from');
    const hoursRaw = params.get('hours');

    // Relative presets are what an operator uses; absolute is what "Tuesday
    // 3am" needs. Both supported, neither optional in combination.
    if (hoursRaw !== null) {
        const hours = Number(hoursRaw);
        if (!Number.isFinite(hours) || hours <= 0) return { error: 'hours must be a positive number' };
        const to = toRaw === null ? new Date() : new Date(toRaw);
        if (Number.isNaN(to.getTime())) return { error: 'to is not a valid timestamp' };
        return { from: new Date(to.getTime() - hours * 3_600_000), to };
    }

    if (fromRaw === null || toRaw === null) {
        return { error: 'a time window is required: pass hours, or both from and to' };
    }
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        return { error: 'from and to must be valid timestamps' };
    }
    return { from, to };
}

// --- routes ------------------------------------------------------------------

// The database's own health: one interactive-lane query plus statfs on the
// paths that matter. Every failure returns null or an error entry rather
// than throwing - the verdict layer treats absence as its own named problem
// (fail closed), and health() must never die of the thing it measures.
const HEALTH_DISK_PATHS = ['/var/lib/postgresql', '/'];

async function dbSelfState(): Promise<DbSelfState | null> {
    const res = await OPS.healthDbSelf();
    if (!res.ok || res.rows.length === 0) return null;
    const row = res.rows[0]!;
    const age = Number(row.oldest_dat_age);
    const disks: DbSelfState['disks'] = [];
    for (const p of HEALTH_DISK_PATHS) {
        try {
            const st = await fs.promises.statfs(p);
            disks.push({ path: p, availPct: Math.round((st.bavail / st.blocks) * 100) });
        } catch (e) {
            disks.push({ path: p, error: e instanceof Error ? e.message : String(e) });
        }
    }
    return {
        oldestDatAge: Number.isFinite(age) ? age : null,
        bloat: row.bloat ?? null,
        disks,
    };
}

async function health(res: http.ServerResponse, deep: boolean): Promise<void> {
    const channels = channelConfig();
    const threads: HeartbeatStats[] = [hb.stats()];
    if (ingestStats) threads.push(ingestStats.heartbeat);
    // Rule 6: a heartbeat in EVERY thread. The export worker only exists once
    // an export has been submitted, so it is absent rather than zero until then
    // - a fabricated 0ms for a thread that is not running would be the same
    // class of lie as a residency figure invented on a platform that cannot
    // produce one.
    const exportHb = exportJobs.workerHeartbeat();
    if (exportHb) threads.push(exportHb);
    if (collectorStats) threads.push(collectorStats.heartbeat);
    // The jobs thread was missing from this list too, which is the same
    // omission as the missing verdicts and worth noting rather than quietly
    // fixing: rule 6 says a heartbeat in EVERY thread, and the worst gap across
    // threads was being computed over three of the four. The jobs worker is the
    // one running plpgsql that can hold a connection for minutes, so it is the
    // thread whose gaps were most worth seeing.
    if (jobsStats) threads.push(jobsStats.heartbeat);

    const worstGap = Math.max(...threads.map((t) => t.worstGapMs));
    // The verdict itself lives in protocol.ts now. Inline here, it was the one
    // health decision no control could reach - and it read `overThresholdCount`
    // while the guard beside it validated `worstGapMs`, so a payload missing
    // the field the verdict used passed both.
    const heartbeatVerdict = isHeartbeatHealthy(threads);
    const anyOver = !heartbeatVerdict.healthy;

    // FAIL CLOSED ON ABSENT DATA, and this is a sweep rather than one fix.
    //
    // The predicate here used to be `partitions !== null && healthy === false`,
    // which treats MISSING data as healthy. The ingest worker is supposed to
    // publish a runway every second, so silence means something is wrong, not
    // that everything is fine - and that is exactly how a correctly computed
    // alarm sat published-and-unread for a whole commit: the field had moved
    // and `undefined` read as "no problem".
    //
    // Same shape as the authorisation question the review asked. A guard whose
    // absent input reads as permission is not a guard. Every predicate below is
    // "unhealthy unless PROVEN healthy", and absence gets its OWN problem
    // string, because a wiring break and a genuine runway shortage need
    // different fixes and should not look the same.
    // EVERY WORKER IS EVALUATED BECAUSE THE LIST IS ENUMERATED, NOT WRITTEN OUT.
    //
    // These verdicts used to be four hand-written lines covering ingest and the
    // collector. The jobs worker - added last, and the only one with no typed
    // contract in protocol.ts - therefore had no verdict of any kind: not
    // reporting, not freshness, not frontier lag. protocol.ts exists to close
    // "computed correctly, wired to nothing", and the newest worker sat outside
    // the mechanism built to prevent exactly that.
    //
    // `Record<WorkerName, WorkerReport>` is what stops it happening to the next
    // one: this object literal does not compile with a key missing, so adding a
    // worker to WORKER_NAMES breaks the build here until it is given a report.
    // Omission stops being possible rather than being fixed once.
    const dbSelf = await dbSelfState();

    const verdicts = [
        heartbeatVerdict,
        ...evaluateWorkers({
            ingest: {
                stats: ingestStats, expected: true,
                reportAgeMs: ingestStats === null ? null : Date.now() - ingestStatsAt,
            },
            collector: {
                stats: collectorStats, expected: CONFIG.collectorEnabled,
                reportAgeMs: collectorStats === null ? null : Date.now() - collectorStatsAt,
            },
            // The export worker is spawned on demand and, once spawned, stays
            // for the life of the process - no idle exit exists (this comment
            // once claimed one; no such path was ever written). "Not
            // reporting" is its normal resting state BEFORE the first export
            // rather than a fault. Expected only while one is actually up.
            export: {
                stats: exportJobs.workerStatsSnapshot(), expected: exportJobs.workerRunning(),
                reportAgeMs: null,
            },
            jobs: {
                stats: jobsStats, expected: CONFIG.jobsEnabled,
                reportAgeMs: jobsStats === null ? null : Date.now() - jobsStatsAt,
            },
        }),
        isPartitionHealthy(ingestStats?.partitions, 'ingest'),
        // THE CENTRAL INVARIANT, and until now the one thing health could not
        // see. A kernel drop is not a symptom of a never-drop violation, it IS
        // the violation - the datagram never reached the application, so no
        // queue, requeue or drain can recover it. Absent counters are their own
        // verdict: unmonitored, not satisfied.
        isKernelDropFree(ingestStats?.kernel),
        // The collector's runway matters MORE than ingest's, not less: ingest
        // queues on a write failure, the collector discards. Only checked when
        // the collector is enabled, or a default deployment reports a fault
        // about a worker that is not running.
        ...(CONFIG.collectorEnabled
            ? [isPartitionHealthy(collectorStats?.partitions, 'collector')] : []),
        isFrontierHealthy(jobsStats?.frontier, CONFIG.jobsEnabled),
        // A wedged RETENTION reaches the same disk exhaustion as a wedged
        // rollup, with the frontier current and healthy the whole way. Nothing
        // saw it until the consumption sweep asked what job failures were for.
        isJobsHealthy(jobsStats?.jobs, CONFIG.jobsEnabled),
        // ...and a retention that succeeds every run by dropping nothing.
        isRetentionEnforcing(jobsStats?.jobs, CONFIG.retentionDryRun, CONFIG.jobsEnabled),
        // A half-configured notification channel is a TYPO standing between an
        // alert and the person who needs it, and it is invisible without this:
        // the channel is silently off, alerts settle as delivered because
        // nothing owed them, and "why was I not alerted" has no answer.
        isNotifyConfigSane(channels),
        // ...and a configured one that has stopped getting through.
        isNotifyDelivering(jobsStats?.notifyChannels),
        ...isDbSelfHealthy(dbSelf),
    ];
    const problems = verdicts.filter((v) => !v.healthy).map((v) => (v as { problem: string }).problem);

    // Residency costs a sleep, so it is opt-in via ?deep=1 rather than being
    // paid on every poll. It is still ON the health endpoint rather than in a
    // separate tool, because BUILD-PLAN requires it beside the heartbeat: both
    // exist for the same reason, that the failure mode is believing something
    // about the environment that nothing printed.
    const residency = deep ? await currentResidency(1000) : null;

    const unhealthy = problems.length > 0;
    sendJson(res, unhealthy ? 503 : 200, {
        ok: !unhealthy,
        problems,
        uptimeS: Math.round((Date.now() - STARTED) / 1000),
        // WHO WOULD BE TOLD. An empty `enabled` is a legitimate configuration
        // - somebody may just watch the page - but it is REPORTED rather than
        // inferred, because "why was I not alerted" deserves a visible answer
        // and this is the cheapest place to give one.
        notifications: channels,
        heartbeat: {
            thresholdMs: CONFIG.heartbeatThresholdMs,
            worstGapMsAcrossThreads: worstGap,
            anyThreadOverThreshold: anyOver,
            threads,
        },
        // Exposed so a large export's flat-memory claim can be checked from
        // outside the process rather than inferred from its own report.
        memory: {
            rssBytes: process.memoryUsage().rss,
            heapUsedBytes: process.memoryUsage().heapUsed,
        },
        exportQueue: exportJobs.queueState(),
        jobs: jobsStats ?? { status: CONFIG.jobsEnabled ? 'no report yet' : 'disabled' },
        collector: collectorStats ?? { status: CONFIG.collectorEnabled ? 'no report yet' : 'disabled' },
        lanes: allLaneStates(),
        db: dbSelf ?? { status: 'unmeasured - the self-check query failed' },
        ingest: ingestStats === null
            ? { status: 'no report yet' }
            : { ...ingestStats, reportAgeMs: Date.now() - ingestStatsAt },
        residency: deep
            ? (residency ?? { available: false, why: 'diskstats unavailable on this platform' })
            : { sampled: false, hint: 'add ?deep=1 to sample cache residency (costs 1s)' },
        diskstatsAvailable: DISKSTATS_AVAILABLE,
    });
}

/**
 * Build the filter set from query or body parameters.
 *
 * Shared by search and export deliberately: an export must not be able to
 * express a query the search rules would refuse, and the surest way to
 * guarantee that is for both to construct the same object and hand it to the
 * same validator in the store.
 */
function filtersFrom(window: { from: Date; to: Date }, params: URLSearchParams): SearchFilters {
    return {
        from: window.from,
        to: window.to,
        ...(params.get('host') !== null ? { host: params.get('host') as string } : {}),
        // THE SAME NORMALIZER THE ip: CLAUSE USES, not a raw pass to ::inet.
        // The fielded filter panel exists so an operator does not have to know
        // the grammar, and it would be a poor trade if the field were WEAKER
        // than the operator it replaces: `ip:10.0.0.` works in the box, so
        // `10.0.0.` has to work in the box's replacement. Raw, it reaches
        // Postgres as an invalid inet literal and comes back a 503 - the
        // database blamed for a UI that promised a format it did not accept.
        // Unparseable values are rejected up front by validateFilters below.
        ...(params.get('sourceIp') !== null
            ? { sourceIp: parseIpValue(params.get('sourceIp') as string) ?? params.get('sourceIp') as string }
            : {}),
        ...(params.get('app') !== null ? { app: params.get('app') as string } : {}),
        ...(params.get('facility') !== null ? { facility: Number(params.get('facility')) } : {}),
        ...(params.get('severityAtMost') !== null ? { severityAtMost: Number(params.get('severityAtMost')) } : {}),
        // `q` is the SEARCH BOX: it goes through the grammar, so a query can
        // express host~, ip:, sev:<=3, negation and quoted phrases. `fragment`
        // stays as the plain-substring parameter for callers that mean exactly
        // that (the export path builds filters directly, and the burst tests
        // want no parsing between them and the predicate).
        ...(params.get('q') !== null ? { clauses: parseQuery(params.get('q') as string) } : {}),
        ...(params.get('fragment') !== null ? { fragment: params.get('fragment') as string } : {}),
        ...(params.get('limit') !== null ? { limit: Number(params.get('limit')) } : {}),
    };
}

/**
 * A discrete `sourceIp` that no format accepts. Returned as a 400 with the
 * accepted forms named, because the alternative is a cast error surfacing as
 * "store refused" - a user's typo reported as a database fault, which sends
 * whoever reads it to the wrong place entirely.
 */
function ipParamError(params: URLSearchParams): string | null {
    const raw = params.get('sourceIp');
    if (raw === null || raw === '') return null;
    if (parseIpValue(raw) !== null) return null;
    return `"${raw}" is not an address, a prefix or a CIDR block. `
        + 'Accepted: 10.0.0.7, 10.0.0. (meaning 10.0.0.0/24), 10.0. , 10. , or 10.0.0.0/24';
}

/**
 * The numeric siblings of ipParamError, for the same reason: a filter typo
 * must come back as a 400 naming the field, not as NaN bound into an int
 * column and reported as a database fault. `?facility=x` was a bare 500
 * until the 2026-09-01 review - the ip parameter got this guard and the
 * numeric ones beside it did not.
 */
function numParamError(params: URLSearchParams): string | null {
    for (const name of ['facility', 'severityAtMost', 'limit']) {
        const raw = params.get(name);
        if (raw === null || raw === '') continue;
        if (!Number.isFinite(Number(raw))) {
            return `"${raw}" is not a number for ${name}`;
        }
    }
    return null;
}

async function search(res: http.ServerResponse, params: URLSearchParams): Promise<void> {
    const window = parseWindow(params);
    if ('error' in window) {
        sendJson(res, 400, { ok: false, reason: 'window-required', detail: window.error });
        return;
    }
    const ipError = ipParamError(params);
    if (ipError !== null) {
        sendJson(res, 400, { ok: false, reason: 'bad-filter', detail: ipError });
        return;
    }
    const numError = numParamError(params);
    if (numError !== null) {
        sendJson(res, 400, { ok: false, reason: 'bad-filter', detail: numError });
        return;
    }

    const filters: SearchFilters = filtersFrom(window, params);

    // Count before fetch, so the operator learns the result is 400,000 rows
    // BEFORE waiting for them. Opt-out, because during a burst test the count
    // is a second heavy query for no benefit.
    const wantCount = params.get('count') !== '0';

    const result = await OPS.searchMessages(filters);

    if (!result.ok) {
        // Three refusal shapes, three different meanings, three status codes.
        // A bare 500 for all of them is what makes an operator think the
        // database is down when in fact four searches are already running.
        if (result.reason === 'busy') {
            sendJson(res, 503, {
                ok: false,
                reason: 'busy',
                lane: result.lane,
                inFlight: result.inFlight,
                capacity: result.capacity,
                waitMs: result.waitMs,
                detail: `${result.inFlight} searches are already running, try again in a moment`,
                retriable: true,
            });
            return;
        }
        if (result.reason === 'statement-timeout') {
            sendJson(res, 503, {
                ok: false,
                reason: 'statement-timeout',
                lane: result.lane,
                limitMs: result.limitMs,
                timing: result.timing,
                detail: `the query exceeded the ${result.lane} lane's ${result.limitMs}ms limit - narrow the window or add a device filter`,
                retriable: false,
            });
            return;
        }
        // Every remaining refusal is a 400 carrying its own detail, and the
        // detail is written to say what to CHANGE: window-required,
        // window-too-wide, window-inverted, window-excludes-dates,
        // unindexed-free-text, unindexed-substring, free-text-window.
        sendJson(res, 400, { ok: false, reason: result.reason, detail: result.detail });
        return;
    }

    let total: string | null = null;
    let countTiming: unknown = null;
    if (wantCount) {
        const counted = await OPS.countMessages(filters);
        if (counted.ok) {
            total = counted.rows[0]?.n ?? null;
            countTiming = counted.timing;
        }
    }

    // ZERO ROWS IS AN ANSWER THAT CAN BE WRONG. An exact host:/app: that
    // matched nothing may be a typo or a habit from the parent's substring
    // behaviour, and "no results" reads as "no logs from that device". If a
    // near miss exists in the same window, name it and name the operator that
    // would have found it. One bounded query, only on the zero-result path.
    const hints: string[] = [];
    if (result.rowCount === 0) {
        const exact = (kind: 'host' | 'app'): string | null => {
            for (const c of filters.clauses ?? []) {
                if (c.kind === kind && c.op === 'exact' && !c.negate) return c.value;
            }
            return null;
        };
        const hostVal = exact('host') ?? filters.host ?? null;
        const appVal = exact('app') ?? filters.app ?? null;
        if (hostVal !== null || appVal !== null) {
            const near = await OPS.uiNearMisses(filters.from, filters.to, hostVal, appVal);
            if (near.ok) {
                const byKind = (k: string): string[] =>
                    near.rows.filter((r) => r.kind === k).map((r) => r.value);
                const h = byKind('host');
                const a = byKind('app');
                if (h.length > 0) {
                    hints.push(`no host is exactly "${hostVal}", but ${h.length} in this window `
                        + `contain it (${h.slice(0, 3).join(', ')}) - try host~${hostVal}`);
                }
                if (a.length > 0) {
                    hints.push(`no app is exactly "${appVal}", but ${a.length} in this window `
                        + `contain it (${a.slice(0, 3).join(', ')}) - try app~${appVal} with a `
                        + 'host: or ip: filter, which app~ always requires');
                }
            }
        }
    }

    sendJson(res, 200, {
        ok: true,
        window: { from: window.from.toISOString(), to: window.to.toISOString() },
        returned: result.rowCount,
        total,
        ...(hints.length > 0 ? { hints } : {}),
        // Wait and execution, always apart. A lane whose wait time is not
        // reported will hide the 20.7s failure again.
        timing: result.timing,
        countTiming,
        rows: result.rows,
    });
}

// --- server ------------------------------------------------------------------

// --- the static shell --------------------------------------------------------
//
// Three files, whitelisted BY NAME - no directory walk, so there is no path
// to traverse. Served without a session, which needs saying against
// ARCHITECTURE.md section 3's "nothing is served unauthenticated": the shell
// contains NO DATA, only markup and the code that asks the APIs for data, and
// the login form has to render before a session can exist. Every byte of
// actual content still arrives through the authenticated /api routes.
//
// Read per request rather than cached: this page changes while the server
// does not, and at UI-development cadence a stale cache costs more than a
// 4KB read costs.
const STATIC_FILES: Record<string, { file: string; type: string }> = {
    '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
    '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
    '/dom.js': { file: 'dom.js', type: 'text/javascript; charset=utf-8' },
    '/parse.js': { file: 'parse.js', type: 'text/javascript; charset=utf-8' },
    '/charts.js': { file: 'charts.js', type: 'text/javascript; charset=utf-8' },
    '/themes.js': { file: 'themes.js', type: 'text/javascript; charset=utf-8' },
    // Slice 32: the device-type artwork. Served like themes.js and for the
    // same reason - the wall needs it before it has a token, and it contains
    // no data. The allowlist is why adding a file is a decision: shipping
    // the icons without this line rendered every tile iconless with nothing
    // in the log, which is exactly the trade an allowlist makes.
    '/stencils.js': { file: 'stencils.js', type: 'text/javascript; charset=utf-8' },
    '/style.css': { file: 'style.css', type: 'text/css; charset=utf-8' },
    '/wall.css': { file: 'wall.css', type: 'text/css; charset=utf-8' },
    // The mark (2026-09-24): favicon for both pages and the header logo, one
    // file for all three. Sessionless for the same reason as the rest of the
    // shell - a browser asks for it before anyone has signed in.
    '/favicon.svg': { file: 'favicon.svg', type: 'image/svg+xml' },
    // Its raster copies (2026-09-24), drawn by tools/make-favicons.mjs. The
    // .ico is what every browser requests unprompted at the root, and a 404
    // there is what Firefox remembers as "this origin has no icon" - the
    // globe the operator saw with the SVG answering 200. The apple-touch
    // icon is the head's 180px raster for a home screen.
    '/favicon.ico': { file: 'favicon.ico', type: 'image/x-icon' },
    '/apple-touch-icon.png': { file: 'apple-touch-icon.png', type: 'image/png' },
    // The wall page, sessionless for the SAME reason as the shell and not a
    // new exception: it contains no data. A display cannot log in, so the
    // page has to render before its token is presented - and every byte of
    // board content still arrives through /api/display/board, which refuses
    // without one.
    '/wall.html': { file: 'wall.html', type: 'text/html; charset=utf-8' },
    '/wall.js': { file: 'wall.js', type: 'text/javascript; charset=utf-8' },
    // The wall's pure half, imported by wall.js - sessionless like its
    // importer and for the same reason: it contains no data, only
    // arithmetic. The allowlist is why adding a file is a decision (see
    // stencils.js above, which shipped without its line once and rendered
    // every tile iconless with nothing in the log).
    '/wall-logic.js': { file: 'wall-logic.js', type: 'text/javascript; charset=utf-8' },
};

function serveStatic(res: http.ServerResponse, entry: { file: string; type: string }): void {
    fs.readFile(path.join(HERE, '..', 'public', entry.file), (err, buf) => {
        if (err) {
            sendJson(res, 404, { ok: false, detail: 'static file missing from public/' });
            return;
        }
        res.writeHead(200, {
            'content-type': entry.type,
            'cache-control': 'no-store',
            // Sent on every static surface, not only the two HTML documents:
            // the policy costs nothing on a .js or .css response and this way
            // there is no list of "which files get headers" to fall out of
            // date the day a surface is added.
            ...securityHeaders(tlsPair !== null),
        });
        res.end(buf);
    });
}

// TLS is decided once, here, and a half configuration is a boot failure
// rather than a plaintext surprise (src/http/tls.ts). The request handler
// below is the same either way; the URL base is only ever used for parsing.
let tlsPair: ReturnType<typeof loadTlsPair> = null;
try {
    tlsPair = loadTlsPair(CONFIG.tlsCert, CONFIG.tlsKey);
} catch (err) {
    if (!(err instanceof TlsConfigError)) throw err;
    log(`FATAL ${err.message}`);
    process.exit(1);
}
const SCHEME = tlsPair === null ? 'http' : 'https';
// TLS terminated in-process means every response leaves encrypted, so the
// session cookie defaults to Secure (src/auth/index.ts reads COOKIE_SECURE).
// An explicit setting wins either way: 0 behind a proxy that strips TLS
// before this process, 1 to force it behind one that terminates.
if (tlsPair !== null && process.env.COOKIE_SECURE === undefined) process.env.COOKIE_SECURE = '1';

/** host[:port] - a bracketed IPv6 literal or an RFC 3986 reg-name/IPv4. */
const HOST_SHAPE = /^(\[[0-9A-Fa-f:.]+\]|(?:[A-Za-z0-9._~!$&'()*+,;=-]|%[0-9A-Fa-f]{2})+)(:[0-9]{1,5})?$/;

const server = createWebServer(tlsPair, (req, res) => {
    // A CONSTANT BASE, AND A PARSE THAT CANNOT THROW OUT OF HERE (2026-10-01,
    // review F2). The base was built from the Host header, and this line runs
    // in the request listener itself, outside route() and its catch - so
    // `Host: a b`, or a request target of `//[`, both of which the HTTP parser
    // accepts, threw from new URL and ended the process. Only the path and the
    // query are ever read from this URL, never its host.
    let url: URL;
    try {
        url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
        sendJson(res, 400, { ok: false, detail: 'malformed request target' });
        return;
    }
    // And a Host that is not a host is refused, as HTTP/1.1 requires (RFC
    // 9112 section 3.2) - no longer because anything here would break on it.
    // An absent one is allowed (HTTP/1.0 probes send none), and so is an
    // empty one, which HTTP/1.1 permits.
    const host = req.headers.host;
    if (host !== undefined && host !== '' && !HOST_SHAPE.test(host)) {
        sendJson(res, 400, { ok: false, detail: 'malformed Host header' });
        return;
    }
    const method = req.method ?? 'GET';
    const path = url.pathname;

    const route = async (): Promise<void> => {
        // A PAGE ON ANOTHER ORIGIN CANNOT CHANGE ANYTHING, whatever cookie
        // its request carries (review F12; respond.ts crossSiteRefusal).
        // Before every route, so no route can forget it.
        const crossSite = crossSiteRefusal(req);
        if (crossSite !== null) {
            sendJson(res, 403, { ok: false, detail: crossSite });
            return;
        }
        // INPUT NO ROUTE CAN USE, refused before any route sees it (2026-09-28,
        // the surface sweep - tools/live-surface.mjs). A NUL in a query
        // parameter reached PostgreSQL, which cannot store one, as a 500 on
        // four routes; an id of 20 digits passed every [0-9]+ check and
        // overflowed bigint, a 500 again. Both are refused here once, rather
        // than in each of the sixty routes that would otherwise have to
        // remember.
        for (const v of url.searchParams.values()) {
            if (containsNul(v)) {
                sendJson(res, 400, { ok: false, detail: 'a query parameter contains a NUL character' });
                return;
            }
        }
        for (const seg of path.split('/')) {
            if (/^[0-9]{19,}$/.test(seg) && BigInt(seg) > 9223372036854775807n) {
                sendJson(res, 404, { ok: false, detail: 'no such id' });
                return;
            }
        }
        // A CONTAINER HEALTHCHECK MUST TARGET THIS ROUTE, NOT /api/health.
        //
        // There is no compose file in the repo yet, so this constraint has
        // nowhere else to live, and the person who writes one may not be the
        // person who wrote this.
        //
        // /api/health returns 503 on two conditions a restart cannot fix. It
        // requires a session, so an unauthenticated probe fails permanently.
        // And it degrades when the partition runway runs short - which is an
        // ALERTING condition, not a restart condition.
        //
        // Pointed at /api/health, a healthcheck produces a restart loop that
        // destroys the ingest queue on every cycle while creating exactly zero
        // partitions: the very failure the runway warning exists to prevent,
        // caused by the warning itself. Liveness and health are different
        // questions and only one of them should restart a container.
        //
        // One of exactly TWO unauthenticated routes (/api/health/work is
        // the other, twelve lines down), and both say nothing beyond
        // whether something is working - which is the narrow claim
        // ARCHITECTURE section 3 now makes, having twice been caught
        // making the categorical one.
        //
        // ARCHITECTURE.md section 3 is categorical that nothing is served
        // unauthenticated, and the detailed health report obeys that: lane
        // statistics, heartbeat gaps, ingest counters and cache residency are
        // all behind a session. This returns a bare {ok} and no detail, for
        // container orchestration, which has no session and cannot get one.
        // It reveals only that the port answers, which completing the TCP
        // handshake already revealed.
        if (path === '/api/health/live') {
            sendJson(res, 200, { ok: true });
            return;
        }

        // WORK LIVENESS, which is a different question from process liveness
        // and needs its own probe (slice 46). Sessionless and free, like
        // /live, because an external monitor has no session and must not be
        // able to cost anything.
        //
        // /api/health/live answers "is this process running JavaScript", and
        // it answers it perfectly: one line, no auth, no database, so its
        // latency is a pure event-loop trace. That is exactly the instrument
        // the parent suite needed on a Pi, where a synchronous full-table
        // scan held the thread for 66 seconds and a zero-work endpoint timed
        // out at 48.
        //
        // IT IS BLIND TO THE OPPOSITE FAILURE, which is the one this fork
        // actually hit at 30k. The scheduler starved, 1,472 devices went
        // unpolled and throughput fell 77% - while the box sat at 100% idle
        // with the heartbeat reading worst_ms=4.3 and over_50ms=0. A zero-work
        // probe answered in a millisecond throughout. Nothing that measures
        // whether a process CAN respond will ever notice a process that
        // responds instantly and does nothing.
        //
        // The number that would have caught it was already published and
        // already named the done-when criterion. What was missing was any way
        // for a monitor to see it go wrong - so this says it in the STATUS
        // CODE, because that is what a monitor reads. It is a separate route
        // rather than a status change on /api/health because the UI reads
        // that one and would stop rendering the very panel that explains the
        // problem.
        if (path === '/api/health/work' && method === 'GET') {
            const scan = jobsStats?.jobs.find((j) => j.name === 'alerts:scan') ?? null;
            const verdict = workHealth(collectorStats, CONFIG.pollLagAlarmMs, CONFIG.collectorEnabled, {
                scan, ingest: ingestStats, nowMs: Date.now(), limitMs: CONFIG.dbOutageAlarmMs,
            });
            // The STATUS CODE stays sessionless - it is the whole point of
            // the route (see above): a monitor learns "starved" from a 503.
            // The BODY is operational detail - lag percentiles, concurrency,
            // in-flight counts, a prose diagnosis - and detail is what
            // "nothing is served unauthenticated" is about. For its first
            // week this route shipped the full fleet diagnostic to whoever
            // could reach the port, while the startup banner still called
            // /live the only sessionless route (2026-09-01 review). A
            // session that may read health gets the verdict; everyone else
            // gets the code and a bare {ok}, exactly /live's posture.
            // The session read must not be able to take the route down
            // (AUDIT-2026-09-01 finding 7): validateSession throws when the
            // interactive lane refuses, which is a plausible state during
            // the very starvation this route exists to report - and the
            // route's whole purpose is a status code that survives when the
            // system does not. A tokenless monitor never reaches the
            // database at all; a cookie-carrying browser whose session
            // cannot be read right now degrades to the bare body, which is
            // the safe direction: unreadable means not authorised for
            // detail, never means no answer.
            let detailed = false;
            try {
                const p = await auth.validateSession(auth.tokenFromRequest(req));
                detailed = authorize(p, 'health.read').allowed;
            } catch { /* the bare body is the answer */ }
            sendJson(res, verdict.status,
                detailed ? verdict.body : { ok: verdict.status === 200 });
            return;
        }

        // GET /metrics (easy-win E2): the numbers the workers already push,
        // as OpenMetrics text, behind the endpoint's OWN credential - a
        // bearer token, because a scraper cannot hold a session and
        // Prometheus carries one natively. Unset token = the route does not
        // exist, so a bare deployment exposes nothing new. Zero database
        // work per scrape by construction (the serializer is pure over
        // in-memory snapshots), so a 15s cadence cannot compete with the
        // thing it measures.
        if (path === '/metrics' && method === 'GET') {
            if (CONFIG.metricsToken === '') {
                sendJson(res, 404, { ok: false, detail: 'metrics are off - set METRICS_TOKEN to enable' });
                return;
            }
            // Hash both sides before comparing: timingSafeEqual demands
            // equal lengths, and length itself must not leak.
            const presented = crypto.createHash('sha256')
                .update(req.headers.authorization ?? '').digest();
            const wanted = crypto.createHash('sha256')
                .update(`Bearer ${CONFIG.metricsToken}`).digest();
            if (!crypto.timingSafeEqual(presented, wanted)) {
                sendJson(res, 401, { ok: false, detail: 'metrics needs `authorization: Bearer <METRICS_TOKEN>`' });
                return;
            }
            const threads: Array<{ thread: string; worstGapMs: number; p99GapMs: number; overThresholdCount: number }> = [hb.stats()];
            if (ingestStats) threads.push(ingestStats.heartbeat);
            if (collectorStats) threads.push(collectorStats.heartbeat);
            if (jobsStats) threads.push(jobsStats.heartbeat);
            const body = serializeMetrics({
                uptimeS: process.uptime(),
                heartbeats: threads,
                collector: collectorStats,
                ingest: ingestStats,
                jobs: jobsStats,
            });
            res.writeHead(200, {
                'content-type': 'application/openmetrics-text; version=1.0.0; charset=utf-8',
                ...securityHeaders(tlsPair !== null),
            });
            res.end(body);
            return;
        }

        // The shell (see STATIC_FILES for why it is sessionless).
        const staticEntry = STATIC_FILES[path];
        if (staticEntry !== undefined && method === 'GET') {
            serveStatic(res, staticEntry);
            return;
        }

        // Login is the only other route reachable without a session, by
        // definition. Rate limited per IP inside the handler.
        if (path === '/api/login') {
            if (method !== 'POST') { sendJson(res, 405, { ok: false, detail: 'POST only' }); return; }
            await authRoutes.login(req, res);
            return;
        }

        const principal: Principal = await auth.validateSession(auth.tokenFromRequest(req));

        if (path === '/api/logout') {
            if (method !== 'POST') { sendJson(res, 405, { ok: false, detail: 'POST only' }); return; }
            await authRoutes.logout(req, res, principal);
            return;
        }
        if (path === '/api/me' && method === 'GET') {
            authRoutes.me(res, principal);
            return;
        }

        if (path === '/api/health' && method === 'GET') {
            if (!enforce(res, principal, 'health.read')) return;
            await health(res, url.searchParams.get('deep') === '1');
            return;
        }
        if (path === '/api/syslog/search' && method === 'GET') {
            if (!enforce(res, principal, 'syslog.read')) return;
            await search(res, url.searchParams);
            return;
        }
        if (path === '/api/alerts' && method === 'GET') {
            if (!enforce(res, principal, 'alerts.read')) return;
            const open = await OPS.uiOpenAlerts();
            if (!open.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${open.reason})` }); return; }
            const cleared = await OPS.uiRecentCleared(
                Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('history') ?? 25)) || 25)));
            if (!cleared.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${cleared.reason})` }); return; }
            // The flap report (easy-win E11) rides the same response: keys
            // that raised and cleared three-plus times today are the churn
            // the hysteresis bands exist to kill, and the cleared history
            // already held the evidence under stable keys. A refusal costs
            // the list, never the page.
            const flapRes = await OPS.alertFlaps();
            const flaps = flapRes.ok ? flapRes.rows : [];
            // TRUE TOTALS ONLY WHEN THE CAP ENGAGED. A full page means the
            // set was larger than UI_PAGE_CAP, and the three numbers the page
            // states as fact - open, crit, undelivered - must then come from
            // the whole set rather than from the slice. Under the cap this
            // costs nothing: the rows ARE the set.
            let counts = {
                total: open.rows.length,
                crits: open.rows.filter((a) => a.severity === 'crit').length,
                owed: open.rows.filter((a) => a.state !== 'pending' && !a.notified_raise).length,
            };
            // `capped` is derived from the TOTAL, not from the row count, so a
            // set of exactly UI_PAGE_CAP does not claim to be truncated.
            let capped = false;
            if (open.rows.length >= UI_PAGE_CAP) {
                const c = await OPS.uiOpenAlertCounts();
                // A refused count does not fail the page. It leaves the page
                // reporting what it can see, which is what it did before.
                if (c.ok && c.rows[0] !== undefined) {
                    counts = c.rows[0];
                    capped = counts.total > open.rows.length;
                }
            }
            // The scan counters mean nothing without their denominators, and
            // a page that TYPED "2 of 3" would go quietly wrong the day
            // someone retunes the config. Same computed-not-typed rule the
            // derived constants live under: the denominator ships from the
            // config the machine itself reads.
            sendJsonGzip(req, res, 200, {
                ok: true,
                open: open.rows,
                flaps,
                // `capped` is what the page renders its honesty from: the list
                // is a slice, the counts are the whole.
                capped,
                openTotal: counts.total,
                openCrits: counts.crits,
                openOwed: counts.owed,
                recentCleared: cleared.rows,
                raiseScans: CONFIG.alertRaiseScans,
                clearScans: CONFIG.alertClearScans,
            });
            return;
        }
        if (path === '/api/alert' && method === 'GET') {
            if (!enforce(res, principal, 'alerts.read')) return;
            const id = url.searchParams.get('id') ?? '';
            // Validated here rather than let a bad id reach `::bigint` and
            // come back as a 503 "store refused" - a typo in a query string
            // is a 400, and calling it a store failure would send whoever
            // reads the health page looking at the database.
            if (!/^[0-9]{1,19}$/.test(id)) {
                sendJson(res, 400, { ok: false, detail: 'id must be a positive integer' });
                return;
            }
            const alert = await OPS.uiAlert(id);
            if (!alert.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${alert.reason})` }); return; }
            if (alert.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such alert' }); return; }
            const history = await OPS.uiAlertHistory(
                id, Math.min(500, Math.max(1, Math.floor(Number(url.searchParams.get('history') ?? 50)) || 50)));
            if (!history.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${history.reason})` }); return; }
            // THRESHOLD PROVENANCE, resolved NOW rather than stored at raise:
            // the row's threshold column is what fired (frozen, honest), and
            // this says which tier answers TODAY - per-entity, host, kind, or
            // default - through the same resolveLevelsInfo the scan uses, so
            // the label cannot drift from the engine. When the two disagree
            // (someone moved the threshold since it fired) the UI says both.
            // Bool-rule kinds carry no threshold, but if-down DOES answer
            // "is this muted?" - it used to be skipped here, so a muted link
            // alert aged out with no word on this page about why (2026-09-23).
            // device-down keys by host, not code, and stays out; a lookup
            // failure degrades to no line, never a 500, because provenance is
            // garnish on a page that must render.
            const a = alert.rows[0];
            let provenance: Record<string, unknown> = {};
            if (a.code !== null && a.kind !== 'device-down' && a.kind !== 'event') {
                try {
                    let cfg = loadRulesConfig();
                    const orows = await OPS.thresholdOverrides('interactive');
                    if (orows.ok) cfg = mergeOverrides(cfg, orows.rows);
                    const info = resolveRuleInfo(
                        buildOverrideIndex(cfg.overrides), cfg, a.kind, a.code, a.host);
                    // THE LAPTOP-OR-UPS HINT, and it is deliberately a HINT.
                    // A state sensor reading 1 raises crit by default, which
                    // is right for a UPS on battery and wrong for a laptop
                    // that is simply undocked. Mainline shipped a
                    // discriminator for this - suppress the default on hosts
                    // reporting both a battery and a filesystem, since no UPS
                    // has a filesystem - and then REVERSED it, because a
                    // server reporting its own UPS through its own agent is
                    // byte-for-byte a laptop in the feed. Those are the
                    // machines the alarm exists for.
                    //
                    // The asymmetry decides it: alerting on an unplugged
                    // laptop is noise - visible, annoying, one override away.
                    // Silencing a UPS-backed server is absence. A rule that
                    // cannot separate two cases must fail toward the noisy
                    // one. So the classifier stays, the decision goes: the
                    // machine reports what it noticed and the operator says
                    // what it means, one click, next to the control that
                    // does it.
                    if (a.kind === 'state') {
                        const shape = await OPS.deviceBatteryShape(String(a.host ?? ''));
                        if (shape.ok && shape.rows[0]?.battery_host === true) {
                            provenance.battery_host = true;
                        }
                    }
                    if (info.source !== 'none') {
                        const now = info.levels === null ? null
                            : (a.severity === 'crit' ? info.levels.crit : info.levels.warn);
                        provenance = {
                            ...provenance,
                            threshold_source: info.source,
                            threshold_muted: info.muted,
                            threshold_now: now,
                            // (The E8 wedge detector lived here until alerts-F3
                            // was fixed on 2026-09-30: a loosened rule no longer
                            // holds an alert open - hysteresis.ts
                            // clearBandThreshold. The provenance line above
                            // already shows the threshold then and now.)
                        };
                    }
                } catch { /* garnish - the page renders without it */ }
            }
            // A GROUP alert (slice 55) names its members as they stand now:
            // the page is where an operator acts on "6 of 10 down", and the
            // six are the answer to "which". Garnish like provenance - a
            // refused lookup leaves the list off, never the page.
            let group: Record<string, unknown> | null = null;
            const gk = a.kind === GROUP_KIND ? parseGroupKey(a.alert_key) : null;
            if (gk !== null) {
                const m = await OPS.groupMembers('interactive', gk.axis, gk.value).catch(() => null);
                if (m !== null && m.ok) {
                    group = {
                        axis: gk.axis, value: gk.value, minDown: m.rows[0]?.min_down ?? null,
                        members: m.rows.map((x) => ({ name: x.name, status: x.st })),
                    };
                }
            }
            sendJson(res, 200, { ok: true, alert: { ...a, ...provenance, ...(group ? { group } : {}) }, history: history.rows });
            return;
        }
        if (path === '/api/devices' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const devices = await OPS.uiDevices();
            if (!devices.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${devices.reason})` }); return; }
            // Same rule as /api/alerts: the true count only when the cap ran.
            let total = devices.rows.length;
            let devCapped = false;
            if (devices.rows.length >= UI_PAGE_CAP) {
                const c = await OPS.uiDeviceCount();
                if (c.ok && c.rows[0] !== undefined) {
                    total = c.rows[0].total;
                    devCapped = total > devices.rows.length;
                }
            }
            sendJsonGzip(req, res, 200, { ok: true, devices: devices.rows, capped: devCapped, total });
            return;
        }
        // The U3 events lane (slice 9). Behind alerts.read because that is
        // the page it renders on: a viewer who may read alerts may read the
        // transitions that explain them.
        if (path === '/api/reachability/events' && method === 'GET') {
            if (!enforce(res, principal, 'alerts.read')) return;
            const events = await OPS.reachEvents();
            if (!events.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${events.reason})` }); return; }
            sendJson(res, 200, { ok: true, events: events.rows });
            return;
        }
        // One entity's history, for the drill-down charts. The SOURCE is
        // chosen by range, not by preference: raw samples inside the raw
        // retention horizon where per-poll detail exists, the rollup beyond
        // it where raw has already aged out. A chart that silently ran off
        // the end of raw retention and drew a flat line would be the worst
        // of both.
        if (path === '/api/entity/history' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const code = url.searchParams.get('code') ?? '';
            if (code === '') { sendJson(res, 400, { ok: false, detail: 'code is required' }); return; }
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const to = new Date();
            const from = new Date(to.getTime() - hours * 3600_000);
            // Raw while the window fits inside raw retention with a day of
            // margin; the rollup beyond. Bucket sized to keep the point count
            // near 300 whatever the range - a chart 860px wide cannot show
            // 2,880 points and a browser should not be asked to hold them.
            const useRaw = hours <= Math.max(1, CONFIG.rawRetentionDays - 1) * 24;
            const bucketSec = useRaw
                ? Math.max(60, Math.round(hours * 3600 / 300 / 60) * 60)
                : 3600;
            const r = useRaw
                ? await OPS.entityHistoryRaw(code, bucketSec, from, to)
                : await OPS.entityHistoryHourly(code, from, to);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            sendJson(res, 200, {
                ok: true,
                from: Math.floor(from.getTime() / 1000),
                to: Math.floor(to.getTime() / 1000),
                bucketSec,
                // NAMED, so the chart can say which it is drawing rather than
                // leaving an operator to wonder why yesterday looks smoother
                // than this morning.
                source: useRaw ? 'raw samples' : 'hourly rollup',
                // [ts, v0, v1, v2, v3, v4, v5, status, m0?, m1?] - the sample
                // row's own column order, so a reader comparing this against
                // the schema is not translating. m0/m1 (the hour's traffic
                // MAXIMA) ride only on rollup rows - raw buckets are already
                // near the resolution of the truth, and the client adds the
                // worst-series only when the elements exist, so the payload
                // shape says which view this is as plainly as `source` does.
                points: r.rows.map((p) => [
                    Number(p.b), p.v0, p.v1, p.v2, p.v3, p.v4, p.v5, p.st,
                    ...(useRaw ? [] : [(p as { m0?: number | null }).m0 ?? null,
                        (p as { m1?: number | null }).m1 ?? null]),
                ]),
            });
            return;
        }
        // SNMP round-trip history for one device - the responsiveness line's
        // chart. Raw samples only (the rollup carries no rtt), so the range
        // is clamped to raw retention and the payload names its source; a
        // 30-day request against 2-day retention draws what exists rather
        // than pretending. Ping history is NOT here: only transitions are
        // recorded for reach, and inventing a series from them would be the
        // chart lying. If ping rtt earns a history it earns a write path
        // first.
        if (path === '/api/device/rtt' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const name = url.searchParams.get('name') ?? '';
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            const rawCapH = Math.max(1, CONFIG.rawRetentionDays) * 24;
            const hours = Math.min(rawCapH, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const bucketSec = Math.max(60, Math.round(hours * 3600 / 300 / 60) * 60);
            const to = new Date();
            const from = new Date(to.getTime() - hours * 3600_000);
            const r = await OPS.deviceRttSeries(name, hours, bucketSec);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            // PING RIDES THE SAME CHART (slice 36). Two instruments, one
            // picture: SNMP round-trip says how slow the AGENT is, ICMP says
            // how slow the PATH is, and an operator staring at a spike wants
            // to know which - a device whose agent crawls while its ping is
            // flat is a different fault from one where both climb. A
            // ping-only device simply has no SNMP line, and that is the
            // whole of its special-casing.
            const p = await OPS.pingSeries(name, hours, bucketSec);
            if (!p.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${p.reason})` }); return; }
            sendJson(res, 200, {
                ok: true,
                from: Math.floor(from.getTime() / 1000),
                to: Math.floor(to.getTime() / 1000),
                bucketSec,
                source: `SNMP from raw samples (kept ${CONFIG.rawRetentionDays} day(s)), `
                    + `ping from its own history (kept ${CONFIG.pingHistoryDays} day(s))`,
                points: r.rows.map((x) => [Number(x.b), x.med_ms, x.max_ms]),
                // [ts, median, worst, lossPercent] - loss comes free from the
                // same scan, because a probe that missed is a null row rather
                // than an absent one.
                ping: p.rows.map((x) => [
                    Number(x.b), x.med_ms, x.max_ms,
                    x.n > 0 ? Math.round((x.misses / x.n) * 100) : null,
                ]),
            });
            return;
        }
        // --- the Dashboard's top lists (2026-09-25, operator) ----------------
        //
        // Top 10 interfaces received, transmitted, and by errors plus
        // discards; top 10 CPU and memory - over 6 hours, 24 hours or 7 days,
        // each with the previous window's figure for the trend. Everyone who
        // can read devices can read this: it is the same data as the charts,
        // summed. One answer per window per rollup hour, computed once and
        // warmed in the background (DASHBOARD_WARM_IDLE_MS says why).
        if (path === '/api/dashboard' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const hours = parseWindowHours(url.searchParams.get('window'));
            if (hours === null) {
                sendJson(res, 400, { ok: false, detail: `window must be one of ${DASHBOARD_WINDOWS.join(', ')} hours` });
                return;
            }
            const f = await OPS.rollupFrontier();
            if (!f.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${f.reason})` }); return; }
            const through = f.rows[0]?.through_ts ?? null;
            if (through === null) {
                sendJson(res, 200, { ok: true, window: null, rx: [], tx: [], errs: [], cpu: [], mem: [],
                    detail: 'the hourly rollup has not completed an hour yet - the lists appear after it does' });
                return;
            }
            const hiMs = Math.floor(new Date(through).getTime() / 3600_000) * 3600_000;
            dashboardLastAsked = Date.now();
            const answer = await dashboardFor(hours, hiMs);
            if (!answer.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${answer.reason})` }); return; }
            sendJson(res, 200, answer.body);
            // The windows not yet computed for this hour, in the background,
            // so the next switch finds its answer waiting.
            warmDashboards(hiMs);
            return;
        }
        // --- the interface traffic report (2026-09-25, operator) -------------
        //
        // "How much did this ISP link carry this month": chosen interfaces,
        // a calendar range in the operator's time zone, one line per
        // interface-day plus a total per interface - GB in and out, peak
        // Mbps each way, and the coverage that says how much of the period
        // the samples saw. JSON for the page, CSV for the spreadsheet (every
        // cell formula-guarded: interface descriptions are device text).
        if (path === '/api/report/traffic' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const codes = [...new Set((url.searchParams.get('codes') ?? '').split(',')
                .map((c) => c.trim()).filter((c) => c !== ''))];
            if (codes.length === 0 || codes.length > REPORT_MAX_INTERFACES
                || codes.some((c) => !/^[A-Za-z0-9_-]{1,64}$/.test(c))) {
                sendJson(res, 400, { ok: false, detail: `codes: 1 to ${REPORT_MAX_INTERFACES} interface codes, comma separated` });
                return;
            }
            const fromDay = url.searchParams.get('from');
            const toDay = url.searchParams.get('to');
            if (!isDay(fromDay) || !isDay(toDay) || fromDay > toDay) {
                sendJson(res, 400, { ok: false, detail: 'from and to must be dates (YYYY-MM-DD), from not after to' });
                return;
            }
            if ((Date.parse(toDay) - Date.parse(fromDay)) / 86_400_000 > REPORT_MAX_DAYS) {
                sendJson(res, 400, { ok: false, detail: `a report covers at most ${REPORT_MAX_DAYS} days` });
                return;
            }
            const tz = url.searchParams.get('tz') ?? 'UTC';
            if (!isTimeZone(tz)) { sendJson(res, 400, { ok: false, detail: 'tz must be a time zone name, e.g. America/Chicago' }); return; }
            const csv = url.searchParams.get('format') === 'csv';
            const f = await OPS.rollupFrontier();
            if (!f.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${f.reason})` }); return; }
            const frontier = f.rows[0]?.through_ts ?? null;
            const r = frontier === null ? null : await OPS.trafficReport(codes, fromDay, toDay, tz, new Date(frontier));
            if (r !== null && !r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const lines = reportLines(r === null ? [] : r.rows);
            if (csv) {
                res.writeHead(200, {
                    'content-type': 'text/csv; charset=utf-8',
                    'content-disposition': `attachment; filename="rscanvas-traffic-${fromDay}-to-${toDay}.csv"`,
                    'cache-control': 'no-store',
                });
                res.end(reportCsv(lines));
                return;
            }
            const found = new Set((r?.rows ?? []).map((x) => x.code));
            sendJson(res, 200, {
                ok: true, from: fromDay, to: toDay, tz,
                through: frontier === null ? null : new Date(frontier).toISOString(),
                lines,
                // Codes that matched no interface: said, not silently dropped.
                missing: codes.filter((c) => !found.has(c)),
            });
            return;
        }
        // --- event alert rules (slice 10) ----------------------------------
        // --- group alerts (slice 55) ------------------------------------------
        //
        // Every location and application with its counts, and the rule for
        // each that has one (a rule for a group that no longer has devices is
        // listed too, so it can be switched off). Read with the event rules'
        // right; written with theirs.
        if (path === '/api/group-alerts' && method === 'GET') {
            if (!enforce(res, principal, 'alertrule.read')) return;
            const [groups, rules] = await Promise.all([OPS.groupHealth(), OPS.groupAlertRules()]);
            if (!groups.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${groups.reason})` }); return; }
            if (!rules.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${rules.reason})` }); return; }
            const byKey = new Map(rules.rows.map((r) => [JSON.stringify([r.axis, r.value]), r]));
            const out: Array<Record<string, unknown>> = [];
            for (const g of groups.rows) {
                if (g.value === null) continue;   // "no location" is not a group a rule can name
                const r = byKey.get(JSON.stringify([g.axis, g.value]));
                byKey.delete(JSON.stringify([g.axis, g.value]));
                out.push({
                    axis: g.axis, value: g.value, up: g.up, down: g.down, other: g.other,
                    enabled: r?.enabled ?? false, thresholdPct: r?.threshold_pct ?? 50, minDown: r?.min_down ?? 3,
                    hasRule: r !== undefined,
                });
            }
            for (const r of byKey.values()) {
                out.push({
                    axis: r.axis, value: r.value, up: 0, down: 0, other: 0,
                    enabled: r.enabled, thresholdPct: r.threshold_pct, minDown: r.min_down, hasRule: true, gone: true,
                });
            }
            sendJson(res, 200, { ok: true, groups: out });
            return;
        }
        if (path === '/api/group-alerts' && method === 'POST') {
            if (!enforce(res, principal, 'alertrule.write')) return;
            const body = await readBodyOr400(req, res);
            if (body === null) return;
            const axis = body.axis === 'location' || body.axis === 'application' ? body.axis : null;
            const value = typeof body.value === 'string' ? body.value.trim() : '';
            const pct = Number(body.thresholdPct);
            const minDown = Number(body.minDown);
            if (axis === null) { sendJson(res, 400, { ok: false, detail: 'axis must be location or application' }); return; }
            if (value === '' || value.length > 200) { sendJson(res, 400, { ok: false, detail: 'value must name a group (1 to 200 characters)' }); return; }
            if (!Number.isInteger(pct) || pct < 1 || pct > 100) { sendJson(res, 400, { ok: false, detail: 'thresholdPct must be a whole percent, 1 to 100' }); return; }
            if (!Number.isInteger(minDown) || minDown < 1 || minDown > 100000) { sendJson(res, 400, { ok: false, detail: 'minDown must be a whole number of devices, at least 1' }); return; }
            const enabled = body.enabled === true;
            const w = await OPS.setGroupAlertRule(axis, value, enabled, pct, minDown, principal.kind === 'user' ? principal.username : 'unknown');
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            await auth.audit(principal, 'grouprule.set', `${axis}:${value}`,
                { enabled, thresholdPct: pct, minDown }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, rule: w.rows[0] });
            return;
        }

        if (path === '/api/alert-rules' && method === 'GET') {
            if (!enforce(res, principal, 'alertrule.read')) return;
            const rules = await OPS.listEventRules();
            if (!rules.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${rules.reason})` }); return; }
            sendJson(res, 200, { ok: true, rules: rules.rows });
            return;
        }
        // --- CREDENTIAL PROFILES (SLICE-CREDENTIALS-PLAN) -----------------------
        //
        // The secret enters here plaintext over the request, is encrypted in
        // THIS thread, and is written as ciphertext. It never comes back out:
        // the list reports whether each secret is SET and whether it is
        // DECRYPTABLE under the current key, and nothing else. The collector
        // decrypts on its own thread from the same ciphertext.
        if (path === '/api/credentials' && method === 'GET') {
            if (!enforce(res, principal, 'credential.read')) return;
            const r = await OPS.credentialProfiles();
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const ready = credentialStoreReady();
            const profiles: ProfileView[] = r.rows.map((row) => ({
                id: row.id, name: row.name, version: row.version as ProfileView['version'],
                hasCommunity: row.community !== null,
                v3User: row.v3_user, v3Level: row.v3_level as ProfileView['v3Level'],
                v3AuthProto: row.v3_auth_proto, hasV3AuthKey: row.v3_auth_key !== null,
                v3PrivProto: row.v3_priv_proto, hasV3PrivKey: row.v3_priv_key !== null,
                devices: row.devices,
                // Decryptable is TESTED, not assumed: the one place the HTTP
                // thread touches plaintext is to discard it immediately. This
                // is what makes the wrong-key case visible BY NAME on the page
                // rather than as devices quietly refusing to poll.
                decryptable: ready && [row.community, row.v3_auth_key, row.v3_priv_key]
                    .filter((c): c is string => c !== null)
                    .every((c) => decrypt(c) !== null),
                createdTs: row.created_ts, updatedTs: row.updated_ts,
            }));
            // The env-named references that also resolve, so the picker can
            // offer both kinds and say which is which. NAMES ONLY.
            const envRefs = Object.keys(process.env)
                .filter((k) => isPermittedEnvRef(k) && process.env[k] !== '')
                .sort();
            sendJson(res, 200, { ok: true, storeReady: ready, profiles, envRefs });
            return;
        }
        if (path === '/api/credentials' && method === 'POST') {
            if (!enforce(res, principal, 'credential.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            // REFUSE BEFORE VALIDATING when there is no key: the message about
            // RSCANVAS_SECRET is the one the operator needs first, and a
            // profile that validated and then failed to store would leave them
            // wondering which half was wrong.
            if (!credentialStoreReady()) {
                sendJson(res, 503, { ok: false, reason: 'no-secret', detail: new CredentialKeyMissing().message });
                return;
            }
            const v = validateProfile(body);
            if (!v.ok) { sendJson(res, 400, { ok: false, detail: v.detail }); return; }
            const pf = v.profile;
            const enc = (x: string | null | undefined): string | null => (x === null || x === undefined || x === '' ? null : encrypt(x));
            const w = await OPS.insertCredentialProfile(
                pf.name, pf.version, enc(pf.community),
                pf.v3User ?? null, pf.v3Level ?? null, pf.v3AuthProto ?? null,
                enc(pf.v3AuthKey), pf.v3PrivProto ?? null, enc(pf.v3PrivKey),
            );
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            if (w.rows.length === 0) {
                sendJson(res, 409, { ok: false, reason: 'exists', detail: `a profile named "${pf.name}" already exists - update it, or choose another name` });
                return;
            }
            // Audited by NAME. Never the secret, never a hash of it, never its
            // length: the audit log is readable by admins and lives in the
            // same database as the ciphertext it must not help decrypt.
            await auth.audit(principal, 'credential.create', pf.name,
                // The v3 IDENTITY is audit-worthy and carries no secret: which
                // user, which level, which algorithms. "Who pointed the fleet
                // at DES" is a question worth being able to answer.
                {
                    version: pf.version,
                    ...(pf.version === '3' ? {
                        v3User: pf.v3User, v3Level: pf.v3Level,
                        v3AuthProto: pf.v3AuthProto, v3PrivProto: pf.v3PrivProto,
                    } : {}),
                }, inetOrNull(clientIp(req)));
            credentialsChanged();
            sendJson(res, 200, {
                ok: true, id: w.rows[0]?.id, name: pf.name,
                ...(v.warning !== undefined ? { warning: v.warning } : {}),
            });
            return;
        }
        if (path === '/api/credentials/secret' && method === 'POST') {
            if (!enforce(res, principal, 'credential.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            if (!credentialStoreReady()) {
                sendJson(res, 503, { ok: false, reason: 'no-secret', detail: new CredentialKeyMissing().message });
                return;
            }
            const name = String(body.name ?? '').trim();
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            const enc = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? encrypt(x) : null);
            const community = enc(body.community), authKey = enc(body.v3AuthKey), privKey = enc(body.v3PrivKey);
            if (community === null && authKey === null && privKey === null) {
                sendJson(res, 400, { ok: false, detail: 'nothing to update - supply community, v3AuthKey or v3PrivKey' });
                return;
            }
            const w = await OPS.updateCredentialProfileSecrets(name, community, authKey, privKey);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            if (w.rows.length === 0) { sendJson(res, 404, { ok: false, detail: `no profile named "${name}"` }); return; }
            await auth.audit(principal, 'credential.rotate', name, {}, inetOrNull(clientIp(req)));
            credentialsChanged();
            // SAID AT THE MOMENT OF THE RISK, not in a document nobody opens.
            // Rotating in place is the operation that raised alerts 19337 and
            // 19338 on the lab: the collector has the new secret now, but any
            // device whose own secret changed at a different moment is
            // authenticating with a mismatch until the two line up, and two
            // failed polls is device-down, CRIT. The alternative costs
            // nothing and is one sentence away, so it belongs here.
            sendJson(res, 200, {
                ok: true,
                name,
                detail: 'the collector has this immediately. But if the DEVICE\'s secret changed at '
                    + 'a different moment than this save, it is failing authentication in between, '
                    + 'and two failed polls raise device-down. To rotate without that gap: add the '
                    + 'new secret to the device ALONGSIDE the old one, make a second profile, probe '
                    + 'it, then repoint the devices with /api/devices/credential and retire the old '
                    + 'one. Both orders were measured; this is the one without the gap.',
            });
            return;
        }
        if (path === '/api/credentials/delete' && method === 'POST') {
            if (!enforce(res, principal, 'credential.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = String(body.name ?? '').trim();
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            // Report the devices that will lose their credential, BEFORE the
            // delete, so the response can name the consequence. Not a gate:
            // deleting a profile is how a credential is revoked, and a
            // revocation that a forgotten device could block is not one.
            const using = await OPS.devicesUsingCredential(name);
            const w = await OPS.deleteCredentialProfile(name);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            if (w.rows.length === 0) { sendJson(res, 404, { ok: false, detail: `no profile named "${name}"` }); return; }
            const orphaned = using.ok ? using.rows[0]?.n ?? 0 : 0;
            await auth.audit(principal, 'credential.delete', name, { orphanedDevices: orphaned }, inetOrNull(clientIp(req)));
            credentialsChanged();
            sendJson(res, 200, {
                ok: true, name, orphanedDevices: orphaned,
                detail: orphaned > 0
                    ? `deleted; ${orphaned} device(s) still name "${name}" and will refuse to poll until re-pointed or the profile is recreated`
                    : 'deleted',
            });
            return;
        }

        // --- THRESHOLD OVERRIDES (SLICE-THRESHOLDS-PLAN) -------------------------
        //
        // Same permission as alert rules: an override changes what alerts,
        // which is the same trust. Three tiers by which of host/code is set;
        // the route does not invent a fourth. Every write is audited by
        // target and levels, because the audit log is how a future operator
        // learns why a sensor at 95C never alerted.
        if (path === '/api/thresholds' && method === 'GET') {
            if (!enforce(res, principal, 'alertrule.read')) return;
            const r = await OPS.thresholdOverridesAnnotated();
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            sendJson(res, 200, {
                ok: true,
                overrides: r.rows.map((o) => ({
                    id: o.id, kind: o.kind, host: o.host, code: o.code,
                    scope: o.code ? 'code' : o.host ? 'host-kind' : 'kind',
                    warn: o.warn, crit: o.crit, enabled: o.enabled, note: o.note, updatedTs: o.updated_ts,
                    entityName: o.entity_name, deviceName: o.device_name,
                })),
                // The shipped defaults, so the page can show what an override
                // is overriding. Levels only - never the whole rules doc.
                defaults: loadRulesConfig().thresholds,
            });
            return;
        }
        if (path === '/api/thresholds' && method === 'POST') {
            if (!enforce(res, principal, 'alertrule.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            // THE TWO VOCABULARIES, normalized at the one write path
            // (2026-08-27). The collector says fs and gauge; the engine says
            // disk and util (alertScanSensors makes the same rename in SQL).
            // The sensor card posted the collector's word, the row stored it,
            // and the engine's lookup missed it forever - a Set or Mute on a
            // filesystem sensor was a silent no-op. slice24.sql renames any
            // rows stored before this line existed.
            const rawKind = String(body.kind ?? '').trim();
            const kind = rawKind === 'fs' ? 'disk' : rawKind === 'gauge' ? 'util' : rawKind;
            if (kind === '') { sendJson(res, 400, { ok: false, detail: 'kind is required' }); return; }
            const host = typeof body.host === 'string' && body.host.trim() !== '' ? body.host.trim() : null;
            const code = typeof body.code === 'string' && body.code.trim() !== '' ? body.code.trim() : null;
            const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
            const warn = num(body.warn), crit = num(body.crit);
            if ((warn !== null && !Number.isFinite(warn)) || (crit !== null && !Number.isFinite(crit))) {
                sendJson(res, 400, { ok: false, detail: 'warn and crit must be numbers, or absent' }); return;
            }
            const enabled = body.enabled !== false;
            // An ENABLED override with no levels at all would replace the
            // default with nothing - which is a mute wearing the wrong name.
            // Say what you mean: enabled:false.
            if (enabled && warn === null && crit === null) {
                sendJson(res, 400, { ok: false, detail: 'an enabled override needs a warn or a crit level - to suspend the rule instead, send enabled:false' });
                return;
            }
            const note = typeof body.note === 'string' && body.note.trim() !== '' ? body.note.trim().slice(0, 200) : null;
            const w = await OPS.upsertThresholdOverride(kind, host, code, warn, crit, enabled, note);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            const target = code ? `code ${code}` : host ? `${host}/${kind}` : `every ${kind}`;
            await auth.audit(principal, enabled ? 'threshold.set' : 'threshold.mute', target,
                { kind, host, code, warn, crit, enabled }, inetOrNull(clientIp(req)));
            sendJson(res, 200, {
                ok: true, id: w.rows[0]?.id,
                detail: enabled
                    ? `${target}: warn ${warn ?? '-'} / crit ${crit ?? '-'} - live on the next scan`
                    : `${target}: rule suspended - live on the next scan`,
            });
            return;
        }
        if (path === '/api/thresholds/delete' && method === 'POST') {
            if (!enforce(res, principal, 'alertrule.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const id = String(body.id ?? '').trim();
            if (!/^\d+$/.test(id)) { sendJson(res, 400, { ok: false, detail: 'id is required' }); return; }
            const w = await OPS.deleteThresholdOverride(id);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            if (w.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such override' }); return; }
            const o = w.rows[0]!;
            const target = o.code ? `code ${o.code}` : o.host ? `${o.host}/${o.kind}` : `every ${o.kind}`;
            await auth.audit(principal, 'threshold.delete', target, { kind: o.kind, host: o.host, code: o.code }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, detail: `${target}: override removed - the next tier or the default applies on the next scan` });
            return;
        }

        if (path === '/api/alert-rules' && method === 'POST') {
            if (!enforce(res, principal, 'alertrule.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = String(body.name ?? '').trim();
            const pattern = String(body.pattern ?? '');
            const isRegex = body.isRegex === true;
            const source = body.source === 'syslog' ? 'syslog' : body.source === 'trap' ? 'trap' : 'any';
            const severity = body.severity === 'crit' ? 'crit' : 'warn';
            const clearAfterS = Math.max(60, Number(body.clearAfterS) || 300);
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            // COMPILE-CHECKED AT CREATE, through the same compileRule the
            // ingest worker arms - a rule this route accepts is a rule that
            // compiles, so a broken regex is refused HERE with its reason
            // rather than discovered per-message on the latency thread.
            const trial = compileRule({ id: '0', name, pattern, isRegex, source, severity });
            if (!trial.ok) { sendJson(res, 400, { ok: false, detail: trial.detail }); return; }
            const w = await OPS.createEventRule(
                name, pattern, isRegex, source, severity, clearAfterS,
                principal.kind === 'user' ? principal.username : 'unknown');
            if (!w.ok) {
                const dup = w.reason.includes('unique') || w.reason.includes('duplicate');
                sendJson(res, dup ? 409 : 503, {
                    ok: false,
                    detail: dup ? `a rule named "${name}" already exists` : `store refused (${w.reason})`,
                });
                return;
            }
            await auth.audit(principal, 'alertrule.create', name,
                { pattern, isRegex, source, severity, clearAfterS }, inetOrNull(clientIp(req)));
            eventRulesChanged();
            sendJson(res, 200, { ok: true, id: w.rows[0]?.id });
            return;
        }
        if (path === '/api/alert-rules/delete' && method === 'POST') {
            if (!enforce(res, principal, 'alertrule.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const id = String(body.id ?? '');
            if (!/^\d+$/.test(id)) { sendJson(res, 400, { ok: false, detail: 'id is required' }); return; }
            const w = await OPS.deleteEventRule(id);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            if (w.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such rule' }); return; }
            // An OPEN alert from a deleted rule is not orphaned forever: the
            // TTL clear falls back to the 300s default when the rule is gone.
            await auth.audit(principal, 'alertrule.delete', w.rows[0]?.name ?? id,
                {}, inetOrNull(clientIp(req)));
            eventRulesChanged();
            sendJson(res, 200, { ok: true, deleted: w.rows[0]?.name });
            return;
        }
        if (path === '/api/alert-rules/enable' && method === 'POST') {
            if (!enforce(res, principal, 'alertrule.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const id = String(body.id ?? '');
            const enabled = body.enabled === true;
            if (!/^\d+$/.test(id)) { sendJson(res, 400, { ok: false, detail: 'id is required' }); return; }
            const w = await OPS.setEventRuleEnabled(id, enabled);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            if (w.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such rule' }); return; }
            await auth.audit(principal, enabled ? 'alertrule.enable' : 'alertrule.disable',
                w.rows[0]?.name ?? id, {}, inetOrNull(clientIp(req)));
            eventRulesChanged();
            sendJson(res, 200, { ok: true });
            return;
        }
        // The U1 drill-down. One statement, pinned by the query budget in
        // tools/test-page-budgets.ts - the N+1 that cost the parent 5,200
        // queries a page load lived at exactly this level of the UI.
        if (path === '/api/device' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const name = url.searchParams.get('name');
            if (name === null || name === '') {
                sendJson(res, 400, { ok: false, detail: 'name is required' });
                return;
            }
            const rows = await OPS.uiDeviceEntities(name);
            if (!rows.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${rows.reason})` }); return; }
            // THRESHOLD PROVENANCE ON THE CARDS (2026-08-27). "Is that
            // muted?" was unanswerable from the sensor card: the mute lived
            // in the fleet table as a bare code, and the card looked the
            // same either way. Resolved here with the SAME resolver the
            // scan and the alert detail use, so the card cannot disagree
            // with the engine. try/catch because this is garnish: a refusal
            // costs the annotation, never the page.
            let entities: Array<Record<string, unknown>> = rows.rows as unknown as Array<Record<string, unknown>>;
            // The interface rules' effective defaults (env merged over the
            // shipped ones), so the page's per-interface form can prefill
            // what applies without a second fetch. Null when resolution
            // failed - the form then opens blank, which is still correct.
            let ifRuleDefaults: Record<string, { warn: number | null; crit: number | null } | null> | null = null;
            try {
                let cfg = loadRulesConfig();
                const orows = await OPS.thresholdOverrides('interactive');
                if (orows.ok) cfg = mergeOverrides(cfg, orows.rows);
                const idx = buildOverrideIndex(cfg.overrides);
                ifRuleDefaults = {
                    'if-errors': cfg.ifRules.errors ?? null,
                    'if-discards': cfg.ifRules.discards ?? null,
                    'if-util': cfg.ifRules.util ?? null,
                };
                // The collector-to-engine kind rename, the same one
                // alertScanSensors makes in SQL and the POST route makes on
                // write. Three sites is two too many; if a third kind ever
                // diverges, unify them before adding it here.
                const ek = (k: string): string => (k === 'fs' ? 'disk' : k === 'gauge' ? 'util' : k);
                entities = entities.map((r) => {
                    if (r.code === null || r.code === undefined) return r;
                    // INTERFACE RULES ON THE ROW (2026-09-23, operator: "no
                    // obvious way to mute alerts on individual interfaces").
                    // The engine always honoured a per-interface override -
                    // if-down and the three rate rules resolve by code like
                    // any sensor - but the page never asked, so a mute set
                    // anywhere was invisible on the row it silenced. Shipped
                    // only when some rule differs from the default: the
                    // quiet norm costs the payload nothing.
                    if (r.kind === 'if') {
                        const rules: Record<string, { source: string; muted: boolean; warn: number | null; crit: number | null }> = {};
                        let differs = false;
                        for (const k of IF_RULE_KINDS) {
                            const info = resolveRuleInfo(idx, cfg, k, String(r.code), name);
                            rules[k] = {
                                source: info.source, muted: info.muted,
                                warn: info.levels?.warn ?? null, crit: info.levels?.crit ?? null,
                            };
                            if (info.source !== 'default' && info.source !== 'none') differs = true;
                        }
                        return differs ? { ...r, ifRules: rules } : r;
                    }
                    const info = resolveRuleInfo(idx, cfg, ek(String(r.kind)), String(r.code), name);
                    if (info.source === 'none') return r;
                    return {
                        ...r,
                        threshold: {
                            source: info.source, muted: info.muted,
                            warn: info.levels?.warn ?? null, crit: info.levels?.crit ?? null,
                        },
                    };
                });
            } catch { /* annotation only - the entities still ship bare */ }
            // SNMP round-trip over the last hour, in the same response so the
            // banner needs no second fetch. samples.rtt_ms has carried this per
            // row since slice 4; this is the first thing to read it back.
            const rtt = await OPS.deviceRttHour(name);
            // Availability over 24h from ping_samples (easy-win E4): misses
            // are rows with NULL rtt - probed and unanswered - which is a
            // different fact from an absent row, and that distinction is the
            // whole reason the fraction is computable at all. Null when the
            // device has no ping history; the client says nothing rather
            // than inventing 100%.
            const avail = await OPS.pingAvailability(name, 24);
            const availRow = avail.ok ? avail.rows[0] : undefined;
            const probes = Number(availRow?.probes ?? 0);
            sendJson(res, 200, {
                ok: true, device: name, entities, ifRuleDefaults,
                entitiesCapped: rows.rows.length >= UI_DEVICE_ENTITY_CAP,
                availability24h: probes > 0
                    ? { probes, misses: Number(availRow?.misses ?? 0) }
                    : null,
                snmpRtt: rtt.ok && rtt.rows[0] && rtt.rows[0].n > 0
                    ? { samples: rtt.rows[0].n, medianMs: rtt.rows[0].med_ms, maxMs: rtt.rows[0].max_ms }
                    : null,
                // The slot count THIS server runs, so the client's slot-share
                // figure is computed from the truth rather than a typed
                // constant that drifts when someone sets POLL_CONCURRENCY.
                pollSlots: CONFIG.pollConcurrency,
            });
            return;
        }
        if (path === '/api/syslog/export') {
            if (method === 'POST') {
                // Authorised FIRST (2026-09-28, the surface sweep): the body was
                // parsed and its window validated before submit() checked the
                // role, so a signed-out caller was told which parameters to
                // send. submit() still checks too; this is the order.
                if (!enforce(res, principal, 'syslog.export')) return;
                let body: Record<string, unknown> = {};
                try {
                    body = await readJsonBody(req);
                } catch (err) {
                    sendJson(res, 400, { ok: false, detail: (err as Error).message });
                    return;
                }
                // Filters come from the body for a POST, but go through the
                // same parser as the search route so an export cannot express
                // a query the search rules would refuse.
                const params = new URLSearchParams();
                for (const [k, v] of Object.entries(body)) {
                    if (typeof v === 'string' || typeof v === 'number') params.set(k, String(v));
                }
                const window = parseWindow(params);
                if ('error' in window) {
                    sendJson(res, 400, { ok: false, reason: 'window-required', detail: window.error });
                    return;
                }
                const ipError = ipParamError(params);
                if (ipError !== null) {
                    sendJson(res, 400, { ok: false, reason: 'bad-filter', detail: ipError });
                    return;
                }
                const numError = numParamError(params);
                if (numError !== null) {
                    sendJson(res, 400, { ok: false, reason: 'bad-filter', detail: numError });
                    return;
                }
                await exportRoutes.submit(
                    res, principal, filtersFrom(window, params), body.confirm === true, req,
                );
                return;
            }
            if (method === 'GET') { exportRoutes.list(res, principal); return; }
            sendJson(res, 405, { ok: false, detail: 'GET or POST' });
            return;
        }

        const exportMatch = /^\/api\/exports\/([A-Za-z0-9_-]+)(\/download)?$/.exec(path);
        if (exportMatch) {
            const id = exportMatch[1] as string;
            if (exportMatch[2] === '/download' && method === 'GET') {
                exportRoutes.download(res, principal, id);
                return;
            }
            if (exportMatch[2] === undefined && method === 'GET') {
                exportRoutes.status(res, principal, id);
                return;
            }
            if (exportMatch[2] === undefined && method === 'DELETE') {
                await exportRoutes.cancel(req, res, principal, id);
                return;
            }
            sendJson(res, 405, { ok: false, detail: 'method not allowed for this export route' });
            return;
        }

        // The retention surface. GET is the inventory and the job history;
        // the PREVIEW is a POST because it takes an advisory lock the real
        // hourly run also wants, so it must be an explicit operator action
        // and must never end up on a polling loop. It is not a POST because
        // it changes anything - `retentionPreview` cannot drop.
        if (path === '/api/admin/retention' && method === 'GET') {
            if (!enforce(res, principal, 'retention.read')) return;
            const parts = await OPS.uiPartitions();
            if (!parts.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${parts.reason})` }); return; }
            const jobs = await OPS.uiJobState();
            if (!jobs.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${jobs.reason})` }); return; }
            sendJson(res, 200, {
                ok: true,
                partitions: parts.rows,
                jobs: jobs.rows,
                // The settings that govern retention, with the env var that
                // sets each one. They are env-only by decision - there is no
                // config store - so showing the NAME is what makes the page
                // actionable instead of merely informative.
                config: [
                    { name: 'MESSAGE_RETENTION_DAYS', value: CONFIG.messageRetentionDays, means: 'days of syslog and trap messages kept' },
                    { name: 'RAW_RETENTION_DAYS', value: CONFIG.rawRetentionDays, means: 'days of raw samples kept (the rollup keeps the hourly summary longer)' },
                    { name: 'ALERT_RETENTION_DAYS', value: CONFIG.alertRetentionDays, means: 'days a cleared alert and its delivery log are kept' },
                    { name: 'TRGM_RECENT_DAYS', value: CONFIG.trgmRecentDays, means: 'days of message partitions carrying a trigram index, which is what free-text search can reach' },
                    { name: 'RETENTION_DRY_RUN', value: CONFIG.retentionDryRun, means: 'when true the hourly job reports what it would drop and drops nothing' },
                    { name: 'RETENTION_MIN_KEEP_DAYS', value: CONFIG.retentionMinKeepDays, means: 'floor: a keep_days below this is refused outright (guard 1)' },
                    { name: 'RETENTION_MAX_DROP_PER_RUN', value: CONFIG.retentionMaxDropPerRun, means: 'most partitions one run may drop (guard 2)' },
                    { name: 'RETENTION_MIN_PARTITIONS', value: CONFIG.retentionMinPartitions, means: 'partitions that must survive whatever the horizon says (guard 3)' },
                    { name: 'RETENTION_MAX_SPAN_DAYS', value: CONFIG.retentionMaxSpanDays, means: 'a partition wider than this is never dropped (guard 4)' },
                    { name: 'RETENTION_INTERVAL_MS', value: CONFIG.retentionIntervalMs, means: 'how often the retention job runs' },
                ],
            });
            return;
        }
        if (path === '/api/admin/retention/preview' && method === 'POST') {
            if (!enforce(res, principal, 'retention.preview')) return;
            const table = url.searchParams.get('table') ?? '';
            // Named, not discovered, and checked against the two tables
            // retention actually runs on. Anything else would reach a
            // SECURITY DEFINER function as a table name.
            if (table !== 'messages' && table !== 'samples') {
                sendJson(res, 400, { ok: false, detail: 'table must be messages or samples' });
                return;
            }
            const keepDays = table === 'messages'
                ? CONFIG.messageRetentionDays : CONFIG.rawRetentionDays;
            // GUARD 1 REFUSES BY RAISING, not by returning a row - and a
            // raised error leaves the lane by being rethrown, so without this
            // the clearest sentence in the system ("refusing: keep_days 3 is
            // below the floor of 7 for messages") would reach the operator as
            // a generic 500. That is the same swap that made an invalid IP
            // look like a database fault earlier today: a layer above the
            // truth replacing it with something shaped like a server problem.
            // A misconfigured horizon is a 400 - the request is answerable,
            // the configuration is not.
            let r;
            try {
                r = await OPS.retentionPreview(
                    table, keepDays, CONFIG.retentionMinKeepDays, CONFIG.retentionMaxDropPerRun,
                    CONFIG.retentionMinPartitions, CONFIG.retentionMaxSpanDays,
                    CONFIG.retentionLockTimeout,
                );
            } catch (err) {
                const e = err as { message?: string; hint?: string };
                sendJson(res, 400, {
                    ok: false,
                    reason: 'retention-refused',
                    detail: [e.message, e.hint].filter(Boolean).join(' - '),
                });
                return;
            }
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            // Audited like every other admin action, including this one that
            // changes nothing - a preview is how someone learns what is about
            // to be lost, and "who looked, and when" is part of the story the
            // morning after a partition goes missing.
            await auth.audit(principal, 'retention.preview', table,
                { keepDays, actions: r.rows.map((x) => x.action) }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, table, keepDays, rows: r.rows });
            return;
        }
        // --- bulk removal, behind ONE informative gate (U6) ---------------------
        //
        // Not three dialogs. Catalyst Center stacks confirmation layers and
        // this project already wrote down why that is the wrong lesson: a
        // prompt with no information in it trains the operator to click
        // through, and somebody who has dismissed the same box forty times
        // dismisses the forty-first without reading it.
        //
        // So: one gate carrying facts available nowhere else, and FRICTION
        // THAT SCALES WITH BLAST RADIUS. Disable is one confirmation because
        // it is reversible. A handful of deletes gets the estimate. A lot of
        // deletes additionally requires typing the count - which a click
        // cannot become reflex about, and which forces the operator to have
        // READ the number the gate computed.
        // REDISCOVER: re-probe devices that already exist.
        //
        // The gap this fills was found on a real onboarding. A device carries
        // the tracking decisions made when it was ADDED, and those decisions
        // change - IF_NOISE landed after four Ubuntu VMs and a Pi were already
        // in the roster, so they kept 18 tracked interfaces of which two were
        // real. Nothing short of delete-and-re-add could revisit that, which is
        // a destructive answer to a question that is not destructive.
        //
        // TWO SEPARATE THINGS, and only one of them touches operator choices:
        //
        //   default      probe, and INSERT entities that have appeared since.
        //                Purely additive; existing rows are not touched.
        //   retrack:true also RESET the tracked flag of existing entities to
        //                what the current default policy says.
        //
        // retrack is opt-in because it discards manual selections - somebody
        // who deliberately tracked a veth gets it turned off. That is the right
        // outcome when the policy changed and the wrong one when it did not, so
        // the caller says which, and the response names every entity it moved
        // rather than reporting a count.
        if (path === '/api/devices/rediscover' && method === 'POST') {
            if (!enforce(res, principal, 'device.create')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            // NAMED, NOT DISCOVERED - the same rule the removal path follows.
            // "Rediscover everything" would re-probe a 450-device fleet from a
            // single click.
            const sel = normalizeNames(body.names, 200, 'rediscover');
            if (!sel.ok) { sendJson(res, 400, { ok: false, detail: sel.detail }); return; }
            const retrack = body.retrack === true;

            const found = await OPS.devicesByName(sel.names);
            if (!found.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${found.reason})` }); return; }
            const missing = sel.names.filter((n) => !found.rows.some((d) => d.name === n));
            if (found.rows.length === 0) {
                sendJson(res, 404, { ok: false, detail: 'none of those devices exist', missing });
                return;
            }

            let probed: Array<Record<string, unknown>>;
            try {
                probed = await probeDevices(found.rows.map((d) => ({
                    host: d.host, port: d.snmp_port,
                    version: d.snmp_version, credentialRef: d.credential_ref,
                }))) as Array<Record<string, unknown>>;
            } catch (err) {
                sendJson(res, 503, { ok: false, detail: (err as Error).message });
                return;
            }

            const taken = await OPS.takenCodes();
            if (!taken.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${taken.reason})` }); return; }
            const takenCodes = new Set(taken.rows.map((t) => t.code));

            const report: Array<Record<string, unknown>> = [];
            for (const d of found.rows) {
                const r = probed.find((p) => String(p.host) === d.host);
                if (r === undefined || r.ok !== true) {
                    report.push({
                        name: d.name, ok: false,
                        detail: (r?.error as string | undefined) ?? 'the probe returned nothing for this host',
                    });
                    continue;
                }
                const ents = (r.entities ?? []) as Array<Record<string, unknown>>;
                const added: string[] = [];
                for (const e of ents) {
                    const code = generateCode(d.name, String(e.name), takenCodes);
                    takenCodes.add(code);
                    // WRITE-IN-LOOP-OK: DISCOVERY, and bounded by one operator
                    // action on a named device. Each insert mints and
                    // collision-checks its own short code, which is per-row
                    // work by construction, and ON CONFLICT DO NOTHING makes a
                    // re-run of an unchanged device write nothing at all. Same
                    // shape and justification as the discovery inserts in
                    // collector/poll.ts.
                    const created = await OPS.insertEntity(
                        d.id, String(e.kind ?? 'if'), String(e.snmpIndex), String(e.name),
                        (e.descr ?? null) as string | null, (e.alias ?? null) as string | null,
                        (e.speedBps ?? null) as number | null, code,
                        e.extra ? JSON.stringify(e.extra) : null, e.tracked === true,
                    );
                    if (created.ok && created.rows.length > 0) added.push(String(e.name));
                }

                let moved: Array<{ name: string; tracked: boolean }> = [];
                if (retrack && ents.length > 0) {
                    // WRITE-IN-LOOP-OK: one statement per DEVICE, not per
                    // entity - the arrays unnest inside the UPDATE, so a
                    // 48-port switch is a single write. The loop is over
                    // devices an operator named, and its IS DISTINCT FROM
                    // means an unchanged device modifies no rows at all.
                    const t = await OPS.retrackEntities(
                        d.id,
                        ents.map((e) => String(e.kind ?? 'if')),
                        ents.map((e) => String(e.snmpIndex)),
                        ents.map((e) => e.tracked === true),
                    );
                    if (t.ok) moved = t.rows.map((x) => ({ name: x.name, tracked: x.tracked }));
                }
                report.push({
                    name: d.name, ok: true,
                    seen: ents.length,
                    added,
                    trackedNow: ents.filter((e) => e.tracked === true).length,
                    // NAMED, not counted: "9 stopped being tracked" sends
                    // somebody hunting for which nine.
                    stoppedTracking: moved.filter((m) => !m.tracked).map((m) => m.name),
                    startedTracking: moved.filter((m) => m.tracked).map((m) => m.name),
                });
            }

            await auth.audit(principal, 'device.rediscover',
                `${found.rows.length} device(s)`, { retrack }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, retrack, missing, devices: report });
            return;
        }

        // SET CREDENTIAL: point a selection at a profile or env name, all at
        // once. The enterprise case is credential rotation - retire the old
        // community, move forty switches to the new profile in one click - and
        // the homelab case is migrating from env names to profiles without a
        // delete-and-re-add. Same shape as rediscover: NAMED devices, one
        // statement, a per-device report.
        //
        // The reference is CHECKED before the write, against the same two
        // sources the collector resolves - profiles and env - so an operator
        // is told "that name resolves nowhere" before forty devices go dark
        // rather than after. It is a warning that can be overridden with
        // force:true, not a wall: a profile about to be created, or an env var
        // about to be set on restart, are legitimate reasons to point first.
        if (path === '/api/devices/credential' && method === 'POST') {
            if (!enforce(res, principal, 'device.create')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const sel = normalizeNames(body.names, 1000, 'set a credential on');
            if (!sel.ok) { sendJson(res, 400, { ok: false, detail: sel.detail }); return; }
            const ref = String(body.credentialRef ?? '').trim();
            if (ref === '') { sendJson(res, 400, { ok: false, detail: 'credentialRef is required - a profile name or an environment variable name' }); return; }

            let resolves: 'profile' | 'env' | null = null;
            const profs = await OPS.credentialProfiles();
            if (profs.ok && profs.rows.some((p) => p.name === ref)) resolves = 'profile';
            else if (isPermittedEnvRef(ref) && (process.env[ref] ?? '') !== '') resolves = 'env';
            if (resolves === null && body.force !== true) {
                sendJson(res, 409, {
                    ok: false, reason: 'unresolvable',
                    detail: `"${ref}" is neither a credential profile nor an environment variable on this server. `
                        + 'Devices pointed at it will refuse to poll until it exists. Create the profile first, '
                        + 'or send force:true if you are about to.',
                });
                return;
            }

            const w = await OPS.setDevicesCredential(sel.names, ref);
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            const changed = w.rows.map((r) => r.name);
            const unchanged = sel.names.filter((n) => !changed.includes(n));
            await auth.audit(principal, 'device.credential', `${changed.length} device(s) -> ${ref}`,
                { changed, resolves }, inetOrNull(clientIp(req)));
            sendJson(res, 200, {
                ok: true, credentialRef: ref, resolves, changed, unchanged,
                detail: `${changed.length} device(s) now use "${ref}"`
                    + (unchanged.length ? `; ${unchanged.length} already did or do not exist` : '')
                    + (resolves === null ? ' - WARNING: that name resolves nowhere yet, they will refuse to poll until it does' : '')
                    + '. The collector picks it up on each device\'s next poll.',
            });
            return;
        }

        if (path === '/api/devices/remove' && method === 'POST') {
            // AUTHORISED BEFORE THE BODY IS READ (review L3, the 09-28 rule):
            // the lesser action first, since every role that may delete may
            // also disable; the mode the body asks for is checked after it.
            if (!enforce(res, principal, 'device.disable')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const mode = normalizeMode(body.mode);
            if (mode === 'delete' && !enforce(res, principal, 'device.delete')) return;

            // The rules themselves live in src/devices/removal.ts and are
            // asserted offline by tools/test-onboarding.ts. What stays here is
            // the I/O: authorize, ask the store, apply the verdict, audit.
            const sel = normalizeNames(body.names, 1000, 'remove');
            if (!sel.ok) { sendJson(res, 400, { ok: false, detail: sel.detail }); return; }
            const names = sel.names;

            const pre = await OPS.previewDeviceRemoval(names);
            if (!pre.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${pre.reason})` }); return; }

            const plan = planRemoval(mode, pre.rows, CONFIG.rawRetentionDays);
            const verdict = gateRemoval(plan, body.confirm === true, body.confirmCount);
            if (!verdict.proceed) {
                sendJson(res, verdict.status, {
                    ok: false,
                    reason: verdict.reason,
                    detail: verdict.detail,
                    mode,
                    devices: plan.found.map((r) => ({
                        name: r.name, entities: Number(r.entities), shapes: Number(r.shapes),
                    })),
                    missing: plan.missing,
                    counts: {
                        devices: plan.found.length,
                        entities: plan.entities,
                        shapes: plan.shapes,
                        boards: plan.boards,
                    },
                    // Named so the client cannot invent the rule.
                    typedConfirmation: verdict.typedConfirmation,
                });
                return;
            }

            const r = mode === 'delete'
                ? await OPS.deleteDevices(names)
                : await OPS.disableDevices(names, mode === 'enable');
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const affected = r.rows.map((x) => x.name);
            await auth.audit(principal, `device.${mode}`, `${affected.length} device(s)`,
                { names: affected, entities: plan.entities, shapes: plan.shapes },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, {
                ok: true, mode, affected, missing: plan.missing,
                entities: plan.entities, shapes: plan.shapes,
            });
            return;
        }

        // --- onboarding: probe, then add (U6) ----------------------------------
        //
        // TWO STEPS, AND THE SPLIT IS THE POINT. The add route accepts a probe
        // TOKEN, never an address, so a device that did not answer cannot be
        // added - a typo is refused here rather than sitting in the roster
        // rendering "down" forever. Ported in shape from SNMPCanvas, which
        // learned it the same way.
        //
        // The probe result is held SERVER-side against the token, which also
        // closes a time-of-check gap: the entity list the operator reviewed is
        // the list that gets written, not whatever the device says a minute
        // later.
        // SUBNET SCAN: the first five minutes on a fresh box. The suite's
        // install script seeded its board from nmap -sn; this is the same
        // idea as an action in the add form. Expand the CIDR (bounded at /22
        // - src/devices/cidr.ts says why), fping it on the collector thread,
        // and return the responders for the operator to review and probe.
        // Writes nothing: a host that pings is a candidate, not a device, and
        // the add flow's "a device that did not answer cannot be added"
        // property stays where it is.
        // TRACK / UNTRACK one or more entities on a named device. This is
        // the answer to "a down alert for a permanently dead port that I
        // cannot clear without deleting the switch": untracked entities feed
        // no conditions, so the open alert ages to source-removed within
        // ALERT_MISSING_SCANS healthy scans - the same path a deleted device
        // takes, no special case. Polling semantics differ by kind ON
        // PURPOSE (the parent's asymmetry, kept): an untracked interface is
        // still counter-polled so re-tracking has instant history, while an
        // untracked sensor is not polled at all. Re-running discovery does
        // not resurrect the choice (inserts are ON CONFLICT DO NOTHING);
        // "Rediscover + reset tracking" DOES overwrite it - resetting is
        // that button's whole job.
        // SPEED OVERRIDE on one interface. The engine has honored
        // speed_override_bps since the speed-trust port (override outranks a
        // conviction; utilization resumes against it) - this is the missing
        // control. NULL clears, and clearing while a conviction stands means
        // the interface goes back to unrated, which is correct: the operator
        // withdrew their number, not the measurement's verdict.
        if (path === '/api/device/speed' && method === 'POST') {
            if (!enforce(res, principal, 'device.speed')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = String(body.name ?? '');
            const index = String(body.index ?? '');
            const raw = body.bps;
            if (name === '' || index === '') {
                sendJson(res, 400, { ok: false, detail: 'need a device name and an interface index' });
                return;
            }
            let bps: number | null = null;
            if (raw !== null && raw !== undefined && raw !== '') {
                bps = Number(raw);
                if (!Number.isFinite(bps) || bps <= 0 || bps > 1e15 || !Number.isInteger(bps)) {
                    sendJson(res, 400, { ok: false, detail: 'bps must be a positive integer (or null to clear the override)' });
                    return;
                }
            }
            const dev = await OPS.devicesByName([name]);
            if (!dev.ok || dev.rows.length === 0) {
                sendJson(res, 404, { ok: false, detail: `no device named ${JSON.stringify(name)}` });
                return;
            }
            const r = await OPS.setSpeedOverride(dev.rows[0].id, index, bps);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rows.length === 0) {
                sendJson(res, 404, { ok: false, detail: `no interface with index ${JSON.stringify(index)} on ${name}` });
                return;
            }
            await auth.audit(principal, 'device.speed', name,
                { interface: r.rows[0].name, override_bps: bps }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, name: r.rows[0].name, override_bps: r.rows[0].speed_override_bps });
            return;
        }
        if (path === '/api/device/track' && method === 'POST') {
            if (!enforce(res, principal, 'device.track')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = String(body.name ?? '');
            const wanted = Array.isArray(body.entities) ? body.entities as Array<Record<string, unknown>> : [];
            if (name === '' || wanted.length === 0) {
                sendJson(res, 400, { ok: false, detail: 'need a device name and at least one {kind, index, tracked}' });
                return;
            }
            const dev = await OPS.devicesByName([name]);
            if (!dev.ok || dev.rows.length === 0) {
                sendJson(res, 404, { ok: false, detail: `no device named ${JSON.stringify(name)}` });
                return;
            }
            // BY CODE when the caller has one, which the device page always
            // does: code is the identity every row carries, index is not -
            // a planner-parked row has none, and matching on it made the
            // untrack a silent no-op (afternoon audit, finding 9). The
            // (kind, index) form stays for callers that only know the walk.
            const byCode = wanted.filter((e) => typeof e.code === 'string' && e.code !== '');
            const byIndex = wanted.filter((e) => !(typeof e.code === 'string' && e.code !== ''));
            const changedRows: Array<{ name: string; kind: string; tracked: boolean }> = [];
            if (byCode.length > 0) {
                const t = await OPS.setEntitiesTrackedByCode(
                    dev.rows[0].id,
                    byCode.map((e) => String(e.code)),
                    byCode.map((e) => e.tracked === true),
                );
                if (!t.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${t.reason})` }); return; }
                changedRows.push(...t.rows);
            }
            if (byIndex.length > 0) {
                const t = await OPS.retrackEntities(
                    dev.rows[0].id,
                    byIndex.map((e) => String(e.kind ?? 'if')),
                    byIndex.map((e) => String(e.index ?? '')),
                    byIndex.map((e) => e.tracked === true),
                );
                if (!t.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${t.reason})` }); return; }
                changedRows.push(...t.rows);
            }
            const t = { rows: changedRows };
            await auth.audit(principal, 'device.track', name,
                { changed: t.rows.map((x) => `${x.name}=${x.tracked ? 'tracked' : 'untracked'}`) },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, changed: t.rows.map((x) => ({ name: x.name, tracked: x.tracked })) });
            return;
        }
        if (path === '/api/devices/scan' && method === 'POST') {
            if (!enforce(res, principal, 'device.create')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const cidr = expandCidr(String(body.cidr ?? ''));
            if (!cidr.ok) { sendJson(res, 400, { ok: false, detail: cidr.detail }); return; }
            // Already-known hosts are reported so the operator sees what a
            // scan would ADD, not a list that is mostly the roster again.
            const known = await OPS.knownDevices([], cidr.hosts);
            const knownHosts = new Set(known.ok ? known.rows.map((k) => k.host) : []);
            let found: Array<{ host: string; rttMs: number | null }>;
            try {
                found = await scanHosts(cidr.hosts) as Array<{ host: string; rttMs: number | null }>;
            } catch (err) {
                sendJson(res, 503, { ok: false, detail: (err as Error).message });
                return;
            }
            await auth.audit(principal, 'device.scan', String(body.cidr ?? ''),
                { swept: cidr.hosts.length, answered: found.length }, inetOrNull(clientIp(req)));
            sendJson(res, 200, {
                ok: true, swept: cidr.hosts.length,
                hosts: found.map((h) => ({ host: h.host, rttMs: h.rttMs, known: knownHosts.has(h.host) })),
            });
            return;
        }
        if (path === '/api/devices/probe' && method === 'POST') {
            if (!enforce(res, principal, 'device.create')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const parsed = normalizeProbeRequest(body, 500);
            if (!parsed.ok) { sendJson(res, 400, { ok: false, detail: parsed.detail }); return; }
            const { hosts, version, port, credentialRef } = parsed.req;

            let results: Array<Record<string, unknown>>;
            try {
                // A REFERENCE crosses the thread boundary, never a secret.
                // The collector resolves it from the environment, which is
                // where secrets live by standing decision - main has no
                // business holding a community string even briefly.
                results = await probeDevices(
                    hosts.map((h) => ({ host: h, port, version, credentialRef })),
                ) as Array<Record<string, unknown>>;
            } catch (err) {
                sendJson(res, 503, { ok: false, detail: (err as Error).message });
                return;
            }

            // Already-known is its own outcome, not an error. Onboarding gets
            // retried after fixing two credentials, and a retry that fails on
            // the successes is a retry nobody runs. Known means the same
            // address AND port; probeStanding owns that call.
            const proposed = results.map((r) => probedName(r));
            const known = await OPS.knownDevices(proposed, hosts);
            if (!known.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${known.reason})` }); return; }

            const token = crypto.randomBytes(16).toString('base64url');
            probeCache.set(token, {
                results, port, version, credentialRef,
                pollIntervalS: Math.max(30, Number(body.pollIntervalS) || 30),
                expires: Date.now() + PROBE_TTL_MS,
            });
            sweepProbeCache();

            await auth.audit(principal, 'device.probe', `${hosts.length} host(s)`,
                { answered: results.filter((r) => r.ok).length }, inetOrNull(clientIp(req)));

            // THE LOCATION SUGGESTION, computed here because this is the only
            // moment sysLocation is worth anything.
            //
            // It is an ONBOARDING ACCELERATOR for shops that already keep the
            // field tidy, and it must cost everyone else nothing. So the whole
            // design is TWO NUMBERS shown before anything is created: "405 of
            // 450 devices reported 4 distinct locations" is an obvious yes,
            // "38 of 450 reported 31" is an obvious no, and the operator
            // decides in one glance without the product guessing whether they
            // are disciplined.
            //
            // sysLocation is DEVICE-CONTROLLED, so this is the one sanctioned
            // use of it: a suggestion a human confirms, never a direct write
            // into the operator-owned column. See sql/slice11.sql.
            const grouped = suggestLocations(results);
            const near = grouped.distinct > 1
                // WRITE-IN-LOOP-OK: the .map on the next line BUILDS THE
                // ARGUMENT to one batched call - it is the batching this
                // checker exists to encourage, not a callback wrapping an
                // await. scan() matches CALL and LOOP against the same line
                // and treats a braceless `.map((` as a single-line loop, so
                // argument construction and iteration are indistinguishable
                // to it. Its own header calls that a floor rather than a
                // proof; this is the floor being met, and the marker is the
                // escape hatch it documents for exactly this case.
                ? await OPS.locationNearMisses(grouped.groups.map((g) => g.value))
                : { ok: true as const, rows: [] };
            const suggestion = {
                ...grouped,
                // Named pairs, not a count: "18 locations, 2 look like typos"
                // sends somebody hunting; naming them ends the hunt.
                nearMisses: near.ok ? near.rows : [],
            };

            // THE REPORT IS THE FEATURE. An operator who sees 187 answered and
            // 13 refused makes a decision; one who is told "imported 187"
            // learns nothing about the 13.
            sendJson(res, 200, {
                ok: true,
                probeToken: token,
                expiresInS: Math.round(PROBE_TTL_MS / 1000),
                locationSuggestion: suggestion,
                devices: results.map((r) => ({
                    host: r.host,
                    ok: r.ok,
                    name: probedName(r),
                    sysDescr: r.sysDescr,
                    sysLocation: r.sysLocation,
                    // Interfaces and sensors reported SEPARATELY: "25
                    // interfaces, 9 sensors" is a review a human can sanity
                    // check against the box they know; one merged count is
                    // not.
                    entities: Array.isArray(r.entities)
                        ? (r.entities as Array<{ kind?: string }>).filter((e) => e.kind === 'if').length : 0,
                    sensors: Array.isArray(r.entities)
                        ? (r.entities as Array<{ kind?: string }>).filter((e) => e.kind !== 'if').length : 0,
                    tracked: r.trackedCount ?? 0,
                    ...standingFields(probeStanding(probedName(r), String(r.host), port, known.rows)),
                    error: r.error,
                    errorKind: r.errorKind,
                })),
            });
            return;
        }

        if (path === '/api/devices' && method === 'POST') {
            if (!enforce(res, principal, 'device.create')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            sweepProbeCache();
            const probe = probeCache.get(String(body.probeToken ?? ''));
            if (probe === undefined) {
                sendJson(res, 400, {
                    ok: false,
                    reason: 'probe-expired',
                    detail: 'that probe has expired or was never made - run the probe again. '
                        + 'A device can only be added from a probe that answered.',
                });
                return;
            }
            // NAMED, NOT DISCOVERED: the caller lists which probed hosts to
            // accept. Absent means all that answered, which is the common case
            // and is still bounded by the probe the operator just read.
            const accept = Array.isArray(body.accept)
                ? new Set(body.accept.map((h) => String(h))) : null;

            // CODES ARE COLLISION-CHECKED AT MINT and are FROZEN once written,
            // because they live in .xcanvas files on other people's disks. So
            // the existing set is read once and grown as this batch mints -
            // minting 200 devices against a stale snapshot would collide
            // within the batch itself, which no per-device check would catch.
            const taken = await OPS.takenCodes();
            if (!taken.ok) {
                sendJson(res, 503, { ok: false, detail: `store refused (${taken.reason})` });
                return;
            }
            const takenCodes = new Set(taken.rows.map((t) => t.code));
            const mint = (deviceName: string, entityName: string): string => {
                const c = generateCode(deviceName, entityName, takenCodes);
                takenCodes.add(c);
                return c;
            };

            // WHICH ONES, decided in src/devices/onboard.ts: not-accepted is
            // omitted silently because it was never proposed, and did-not-
            // answer is refused and NAMED. That refusal is U6's central claim
            // and is asserted offline in tools/test-onboarding.ts.
            const selection = selectForAdd(probe.results, accept);
            const added: string[] = [];
            const skipped = selection.skipped;
            // EXPLICIT NAMES, per host, the accept-by-map shape the location
            // suggestion already uses: `names: { "<probed host>": "<name>" }`.
            // This is the way OUT of a sysName collision (ruling 5) - twelve
            // factory-default switches all called `switch` cannot all keep
            // that name, nothing is ever auto-renamed, and a refusal with no
            // door is a dead end. Validated per item to the rename route's
            // own rules, because both land in the same column.
            const explicitNames = (typeof body.names === 'object' && body.names !== null)
                ? body.names as Record<string, unknown> : {};
            // Name collisions counted as their OWN category beside the
            // report, never folded into "already known" - the fold was the
            // defect: a third of a fleet vanished behind a message that
            // could not distinguish a rerun from a theft.
            let nameCollisions = 0;
            // Entities a probe returned twice under the same identity, dropped
            // here and NAMED in the response. Reported rather than swallowed
            // because the duplicate is a defect in discovery - two sensors
            // claiming one index means one of them is invisible - and the
            // operator is the only person who can see it happened.
            const collisions: Array<{ device: string; dropped: string }> = [];
            for (const r of selection.write) {
                const host = String(r.host);
                const override = normalizeExplicitName(explicitNames[host]);
                if (!override.ok) { skipped.push({ host, why: override.detail }); continue; }
                const name = override.name ?? probedName(r);
                const all = (r.entities ?? []) as Array<Record<string, unknown>>;
                // DE-DUPLICATED BEFORE THE WRITE, first occurrence wins. A
                // collision used to be a unique violation that THREW, so a
                // single bad sensor pair on one device answered "internal
                // error" and rolled back every device after it in the batch.
                const seen = new Set<string>();
                const ents = all.filter((e) => {
                    const key = `${String(e.kind ?? 'if')} ${String(e.snmpIndex)}`;
                    if (seen.has(key)) {
                        collisions.push({ device: name, dropped: `${String(e.name)} (${key.replace(' ', ' index ')})` });
                        return false;
                    }
                    seen.add(key);
                    return true;
                });
                // WRITE-IN-LOOP-OK: one statement per DEVICE, and the loop is
                // an operator action rather than a poll. Each insert is atomic
                // by design - device and its entities together - and batching
                // every device into one statement would trade that away:
                // a half-written device polls forever against a partial
                // interface list. 200 statements once at onboarding is not the
                // 331/s forever that this checker exists to catch, and the
                // per-device outcome is also what the report needs (added,
                // already known, refused) - a single batched write could not
                // say which of the two hundred was which.
                //
                // ONE DEVICE MUST NOT ABORT THE BATCH. laneQuery returns an
                // Outcome for lane refusals but a driver or constraint error
                // THROWS, and an uncaught throw here reached the top-level
                // handler as a bare "internal error" - so the operator saw one
                // useless sentence, the devices already written stayed
                // written, and everything behind the failure was silently
                // lost. That is the shape that made this bug unfindable from
                // the outside: the batch that failed and the batch that half
                // worked looked identical.
                //
                // The refusal now belongs to the DEVICE, is named with the
                // driver's own message, and the loop continues. A per-item
                // failure reported per item is the difference between "add 23
                // devices" being a coin flip and being a report.
                let w: Awaited<ReturnType<typeof OPS.insertDeviceWithEntities>> | undefined;
                let refusal: string | null = null;
                // A CODE RACE IS RETRIED, NOT REPORTED AS A BAD DEVICE
                // (2026-09-24, the lab-5 ingest run). takenCodes is read once
                // per REQUEST, so two adds running at once cannot see each
                // other's new codes; at 30,000 entities in a space of about a
                // million, birthday collisions between them are expected, and
                // the loser was refused outright - 6 of 292 dense devices at
                // concurrency 8, each reported as "refused by the database".
                // The codes are only the key, not the device, so a collision
                // on either code index re-reads what is taken and mints again.
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        // WRITE-IN-LOOP-OK: one statement per DEVICE, per the
                        // paragraph above, retried at most twice on a code
                        // race - the try/catch moved the call away from that
                        // marker, and the checker is right that a marker
                        // separated from its call proves nothing about the call.
                        w = await OPS.insertDeviceWithEntities(
                        name, host, probe.port, probe.version, probe.credentialRef,
                        probe.pollIntervalS,
                        r.sysName as string | null, r.sysDescr as string | null,
                        r.sysLocation as string | null, mint(name, 'uptime'),
                        // The kind comes from the probe now (sensors slice): 'if'
                        // for interfaces, the sensor kinds beside them, each with
                        // its polling instruction in extra.
                        ents.map((e) => String(e.kind ?? 'if')),
                        ents.map((e) => String(e.snmpIndex)),
                        ents.map((e) => String(e.name)),
                        ents.map((e) => (e.descr ?? null) as string | null),
                        ents.map((e) => (e.alias ?? null) as string | null),
                        ents.map((e) => (e.speedBps ?? null) as number | null),
                        ents.map((e) => e.tracked === true),
                        ents.map((e) => mint(name, String(e.name))),
                        ents.map((e) => (e.extra ? JSON.stringify(e.extra) : null)),
                        );
                        refusal = null;
                        break;
                    } catch (err) {
                        const e = err as { message?: string; constraint?: string; detail?: string; code?: string };
                        const codeRace = e.code === '23505'
                            && (e.constraint === 'entities_code_idx' || e.constraint === 'devices_uptime_code_idx');
                        if (codeRace && attempt < 3) {
                            // WRITE-IN-LOOP-OK: a READ, and only on a code race
                            // - at most twice per device, never on the path an
                            // uncontended add takes.
                            const fresh = await OPS.takenCodes();
                            if (fresh.ok) for (const t of fresh.rows) takenCodes.add(t.code);
                            log(`add of ${name} (${host}): a concurrent add took one of its codes `
                                + `(${e.constraint}) - minting again (attempt ${attempt + 1} of 3)`);
                            continue;
                        }
                        // The CONSTRAINT name is the useful half and a bare
                        // message usually omits it, so both travel.
                        refusal = `refused by the database: ${e.message ?? String(err)}`
                            + (e.constraint ? ` [constraint ${e.constraint}]` : '')
                            + (e.detail ? ` - ${e.detail}` : '');
                        break;
                    }
                }
                if (refusal !== null || w === undefined) {
                    const why = refusal ?? 'refused by the database';
                    log(`add of ${name} (${host}) failed: ${why}`);
                    skipped.push({ host, why });
                    continue;
                }
                if (!w.ok) { skipped.push({ host, why: `store refused (${w.reason})` }); continue; }
                // Three outcomes now, and the judgement is onboard.ts's so
                // the matrix is pinned offline: added; genuinely already
                // known (same host and port); or a COLLISION - this name
                // belongs to a different target - refused with the incumbent
                // named and the way out stated (ruling 5).
                const o = addOutcome(name, host, w.rows[0], override.name !== null);
                if (o.kind !== 'added') {
                    if (o.kind === 'collision') nameCollisions++;
                    skipped.push({ host, why: o.why });
                    continue;
                }
                added.push(name);
            }

            // FORCE ADD (the operator's LibreNMS comparison, 2026-09-01):
            // no-answer hosts from THIS probe, added anyway as pending rows.
            // The judgement is selectForForce's, pinned offline: a host
            // outside the probe is refused (force is not a side door for
            // arbitrary addresses), and one that ANSWERED is refused too
            // (accepting it normally keeps the discovery force would drop).
            // The rows are credential-and-address only; the ordinary poller
            // discovers everything on first contact, and until then the one
            // status definition reads them as 'pending' - no device-down
            // alert for a host that has only ever been a promise.
            const forceList = Array.isArray(body.force) ? body.force.map((h) => String(h)) : [];
            const forced: string[] = [];
            if (forceList.length > 0) {
                const sel = selectForForce(probe.results, forceList);
                skipped.push(...sel.skipped);
                for (const r of sel.write) {
                    const host = String(r.host);
                    const override = normalizeExplicitName(explicitNames[host]);
                    if (!override.ok) { skipped.push({ host, why: override.detail }); continue; }
                    // No sysName exists to propose a name, so the address
                    // stands in until the operator renames - same posture as
                    // the ping path's typed identity.
                    const name = override.name ?? host;
                    let w;
                    try {
                        // WRITE-IN-LOOP-OK: one statement per forced device
                        // on an operator's explicit list, bounded by the
                        // probe batch - an onboarding action, not a poll
                        // path; same shape as the probed loop above.
                        w = await OPS.forceAddDevice(
                            name, host, probe.port, probe.version,
                            probe.credentialRef, probe.pollIntervalS, mint(name, 'uptime'));
                    } catch (err) {
                        skipped.push({ host, why: `refused by the database: ${(err as Error).message}` });
                        continue;
                    }
                    if (!w.ok) { skipped.push({ host, why: `store refused (${w.reason})` }); continue; }
                    const o = addOutcome(name, host, w.rows[0], true);
                    if (o.kind !== 'added') {
                        if (o.kind === 'collision') nameCollisions++;
                        skipped.push({ host, why: o.why });
                        continue;
                    }
                    forced.push(name);
                }
            }
            // APPLY THE ACCEPTED LOCATIONS, if any. The client sends back a
            // map of { reportedValue: chosenName } - so accepting is one
            // decision, renaming is the same decision with a different string,
            // and rejecting is simply leaving the value out. There is no
            // separate reject verb because absence already means it.
            //
            // Applied AFTER the inserts and only to names that were added, so
            // a re-run cannot retag devices somebody has since moved by hand.
            const accepted = (typeof body.locations === 'object' && body.locations !== null)
                ? body.locations as Record<string, unknown> : {};
            let tagged = 0;
            for (const group of locationAssignments(probe.results, accepted, new Set(added))) {
                // WRITE-IN-LOOP-OK: one statement per accepted LOCATION, not
                // per device - a handful of groups, each tagging its whole set
                // in a single UPDATE. The per-device shape this checker exists
                // to catch would be inside applyLocationToDevices, and is not.
                const t = await OPS.applyLocationToDevices(group.names, group.location);
                if (t.ok) tagged += t.rowCount;
            }

            // APPLICATION AT ADD TIME (slice 30). Location arrives SUGGESTED,
            // because devices report sysLocation; application never can -
            // nothing on a box knows it serves Exchange - so it is one typed
            // value for the whole batch, applied like an accepted location.
            // The operator asked for this after tagging six guest PCs one
            // page at a time: the add flow already knew the group, and made
            // them say it again afterwards.
            const application = typeof body.application === 'string' && body.application.trim() !== ''
                ? body.application.trim().slice(0, 120) : null;
            let taggedApp = 0;
            if (application !== null && added.length > 0) {
                const t = await OPS.applyApplicationToDevices(added, application);
                if (t.ok) taggedApp = t.rowCount;
            }

            await auth.audit(principal, 'device.create', `${added.length + forced.length} device(s)`,
                {
                    added, skipped: skipped.length, tagged, collisions: collisions.length,
                    nameCollisions,
                    ...(forced.length > 0 ? { forced } : {}),
                    ...(application !== null ? { application, taggedApp } : {}),
                },
                inetOrNull(clientIp(req)));
            // `collisions` is the SENSOR pairs dropped at de-dup;
            // `nameCollisions` counts refused sysName thefts (ruling 5) -
            // two different defects that both earned the word, kept apart.
            // `forced` is separate from `added` because the report must not
            // let "pending first contact" read as "probed and discovered".
            sendJson(res, 200, { ok: true, added, forced, skipped, tagged, taggedApp, collisions, nameCollisions });
            return;
        }

        // --- device grouping (slice 11) ----------------------------------------
        //
        // The first route in the product that mutates a DEVICE. It writes
        // exactly two columns and nothing else can, which is the invariant
        // slice11.sql spells out: location and application are
        // operator-assigned, and the monitored device must never get a say in
        // which group its own outage is counted in.
        // RENAME. The name is the key under alerts and host overrides, so
        // the store carries it across all of them in one statement
        // (renameDevice). A collision is checked before the write and
        // caught after it: the unique constraint is the real guard, the
        // pre-check is the readable error, and the catch is the race
        // between two admins renaming at once.
        if (path === '/api/device/rename' && method === 'POST') {
            if (!enforce(res, principal, 'device.rename')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const from = typeof body.name === 'string' ? body.name : '';
            // ONE definition of what a device name may be (AUDIT-2026-09-01
            // finding 3): this route's trim, length cap and control-character
            // test and the add path's explicit-name override are the same rule
            // landing in the same column, and for one day they were two copies
            // with byte-identical messages - the section-21 class, created by
            // the commit that was fixing an instance of it. normalizeExplicitName
            // owns the rule now, and check-call-sites pins both consumers so the
            // day one site gains a character and the other does not fails the
            // build instead of waiting for an operator.
            const norm = normalizeExplicitName(body.newName);
            if (!norm.ok) { sendJson(res, 400, { ok: false, detail: norm.detail }); return; }
            const to = norm.name ?? '';
            if (from === '' || to === '') { sendJson(res, 400, { ok: false, detail: 'name and newName are required' }); return; }
            if (to === from) { sendJson(res, 400, { ok: false, detail: 'that is already its name' }); return; }
            const clash = await OPS.devicesByName([to]);
            if (clash.ok && clash.rows.length > 0) {
                sendJson(res, 409, { ok: false, detail: `a device named ${JSON.stringify(to)} already exists` });
                return;
            }
            // A notify policy already standing for the NEW name is the one
            // thing the cascade cannot carry (UNIQUE (scope, target)). The
            // store lets a SQL error PROPAGATE (pool.ts: only a statement
            // timeout becomes a refused outcome), so the whole statement
            // fails as a thrown unique violation - caught here and named,
            // so the operator is told which policy to remove rather than
            // that the rename "failed". The first cut of this cascade
            // dropped this catch on the belief that the store returned it
            // as an outcome; the scratch suite's clash step found out.
            let r;
            try {
                r = await OPS.renameDevice(from, to);
            } catch (err) {
                const e = err as { code?: string; table?: string; message: string };
                if (e.code === '23505' && e.table === 'notify_policy') {
                    sendJson(res, 409, { ok: false, detail: `a notify policy already exists for ${JSON.stringify(to)}; remove it first, then rename` });
                    return;
                }
                sendJson(res, 409, { ok: false, detail: `rename refused: ${e.message}` });
                return;
            }
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const row = r.rows[0];
            if (!row || row.renamed === 0) { sendJson(res, 404, { ok: false, detail: 'no such device' }); return; }
            await auth.audit(principal, 'device.rename', from, {
                to, alerts_carried: row.alerts, overrides_carried: row.overrides,
                windows_carried: row.windows, policies_carried: row.policies, boards_carried: row.boards,
            }, inetOrNull(clientIp(req)));
            sendJson(res, 200, {
                ok: true, name: to, alerts: row.alerts, overrides: row.overrides,
                windows: row.windows, policies: row.policies, boards: row.boards,
            });
            return;
        }
        if (path === '/api/device/address' && method === 'POST') {
            // Move a device to another address without losing it. The only
            // path before 2026-09-15 was delete and re-add, which threw away
            // every sample the device had ever produced.
            if (!enforce(res, principal, 'device.address')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = typeof body.name === 'string' ? body.name : '';
            const host = typeof body.host === 'string' ? body.host.trim() : '';
            if (name === '' || host === '') { sendJson(res, 400, { ok: false, detail: 'name and host are required' }); return; }
            // An ADDRESS, not a hostname: the column is inet and the poller
            // hands it to the SNMP session verbatim, so the check that
            // Postgres would make on write is made here with the reason.
            if (isIP(host) === 0) { sendJson(res, 400, { ok: false, detail: `${JSON.stringify(host)} is not an IPv4 or IPv6 address` }); return; }
            let port: number | null = null;
            if (body.snmp_port !== undefined && body.snmp_port !== null && body.snmp_port !== '') {
                const p = Number(body.snmp_port);
                if (!Number.isInteger(p) || p < 1 || p > 65535) { sendJson(res, 400, { ok: false, detail: 'snmp_port must be an integer from 1 to 65535' }); return; }
                port = p;
            }
            const cur = await OPS.devicesByName([name]);
            if (!cur.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${cur.reason})` }); return; }
            const before = cur.rows[0];
            if (!before) { sendJson(res, 404, { ok: false, detail: 'no such device' }); return; }
            if (before.host === host && (port === null || port === before.snmp_port)) {
                sendJson(res, 400, { ok: false, detail: 'that is already its address' });
                return;
            }
            let r;
            try {
                r = await OPS.setDeviceAddress(name, host, port);
            } catch (err) {
                // The store throws SQL errors; the only one this statement
                // can raise past isIP is Postgres disagreeing about the
                // literal, which is a request problem, not a store one.
                sendJson(res, 400, { ok: false, detail: `move refused: ${(err as Error).message}` });
                return;
            }
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const row = r.rows[0];
            if (!row) { sendJson(res, 404, { ok: false, detail: 'no such device' }); return; }
            await auth.audit(principal, 'device.address', name, {
                from: `${before.host}:${before.snmp_port}`, to: `${row.host}:${row.snmp_port}`,
            }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, name, host: row.host, snmp_port: row.snmp_port });
            return;
        }
        if (path === '/api/maintenance' && method === 'GET') {
            if (!enforce(res, principal, 'alerts.read')) return;
            const w = await OPS.maintenanceWindows();
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            sendJson(res, 200, { ok: true, windows: w.rows });
            return;
        }
        if (path === '/api/maintenance' && method === 'POST') {
            if (!enforce(res, principal, 'alert.suppress')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const scope = typeof body.scope === 'string' ? body.scope : '';
            if (!['device', 'location', 'application', 'all'].includes(scope)) {
                sendJson(res, 400, { ok: false, detail: 'scope must be device, location, application or all' });
                return;
            }
            const target = typeof body.target === 'string' ? body.target.trim() : '';
            if ((scope === 'all') !== (target === '')) {
                sendJson(res, 400, {
                    ok: false,
                    detail: scope === 'all' ? 'scope all takes no target' : `scope ${scope} requires a target`,
                });
                return;
            }
            // Both ends are REQUIRED (plan decision 2): a window with no end
            // is device.disable with extra steps, and it fails the same way.
            // starts defaults to now because the workflow that exists is
            // "I am patching this NOW, for about two hours"; a future starts
            // is planned work and equally welcome.
            const starts = body.starts === undefined ? new Date() : new Date(String(body.starts));
            if (Number.isNaN(starts.getTime())) { sendJson(res, 400, { ok: false, detail: 'starts is not a timestamp' }); return; }
            const minutes = typeof body.minutes === 'number' ? Math.round(body.minutes) : NaN;
            const ends = body.ends !== undefined ? new Date(String(body.ends))
                : Number.isFinite(minutes) && minutes > 0 ? new Date(starts.getTime() + minutes * 60_000)
                    : new Date(NaN);
            if (Number.isNaN(ends.getTime())) {
                sendJson(res, 400, { ok: false, detail: 'give ends (timestamp) or minutes (positive number) - a window has both ends by design' });
                return;
            }
            if (ends.getTime() <= starts.getTime()) { sendJson(res, 400, { ok: false, detail: 'ends must be after starts' }); return; }
            if (ends.getTime() <= Date.now()) { sendJson(res, 400, { ok: false, detail: 'that window is already over' }); return; }
            // 30 days is a typo guard, not policy: 120 minutes mistyped as
            // 12000 sails past every other check and this one catches it.
            if (ends.getTime() - starts.getTime() > 30 * 86_400_000) {
                sendJson(res, 400, { ok: false, detail: 'a window longer than 30 days is a disable, not maintenance' });
                return;
            }
            const note = typeof body.note === 'string' && body.note.trim() !== ''
                ? body.note.trim().slice(0, 500) : null;
            if (scope !== 'all') {
                const m = await OPS.maintenanceTargetCount(scope, target);
                if (!m.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${m.reason})` }); return; }
                if ((m.rows[0]?.n ?? '0') === '0') {
                    sendJson(res, 404, { ok: false, detail: `no device matches ${scope} ${JSON.stringify(target)}` });
                    return;
                }
            }
            const created = await OPS.createMaintenanceWindow(
                scope, scope === 'all' ? null : target, starts, ends, note,
                principal.kind === 'user' ? principal.username : 'unknown');
            if (!created.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${created.reason})` }); return; }
            // The audit row is the durable answer to "why was nobody paged
            // at 02:00 on the 14th": scope, target, both timestamps, note,
            // author. The window row itself is pruned with alert retention.
            await auth.audit(principal, 'alert.suppress', scope === 'all' ? 'all' : `${scope}:${target}`,
                { starts: starts.toISOString(), ends: ends.toISOString(), note },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, id: created.rows[0]?.id ?? null, starts, ends });
            return;
        }
        if (path === '/api/maintenance' && method === 'DELETE') {
            if (!enforce(res, principal, 'alert.suppress')) return;
            const id = url.searchParams.get('id') ?? '';
            if (!/^[0-9]{1,19}$/.test(id)) { sendJson(res, 400, { ok: false, detail: 'id must be a positive integer' }); return; }
            const gone = await OPS.cancelMaintenanceWindow(id);
            if (!gone.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${gone.reason})` }); return; }
            const row = gone.rows[0];
            if (row === undefined) { sendJson(res, 404, { ok: false, detail: 'no such window' }); return; }
            await auth.audit(principal, 'alert.unsuppress', row.scope === 'all' ? 'all' : `${row.scope}:${row.target}`,
                { starts: row.starts_ts.toISOString(), ends: row.ends_ts.toISOString(), note: row.note },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true });
            return;
        }
        // --- notify policy (slice 25, quiet 1) -------------------------------
        //
        // The standing sibling of /api/maintenance: same permission, same
        // scope vocabulary minus 'all' (a policy over everything is the
        // channel toggle in a costume), same typo-guard 404 on a target no
        // device matches, and the same audit discipline - the trail is the
        // durable answer to "why was nobody paged", and a policy makes that
        // question MORE likely to be asked months later, not less.
        if (path === '/api/policy' && method === 'GET') {
            if (!enforce(res, principal, 'alerts.read')) return;
            const p = await OPS.notifyPolicies();
            if (!p.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${p.reason})` }); return; }
            sendJson(res, 200, { ok: true, policies: p.rows });
            return;
        }
        if (path === '/api/policy' && method === 'POST') {
            if (!enforce(res, principal, 'alert.suppress')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const scope = typeof body.scope === 'string' ? body.scope : '';
            if (!['device', 'location', 'application'].includes(scope)) {
                sendJson(res, 400, { ok: false, detail: 'scope must be device, location or application - a policy over everything is the channel toggle, which already exists' });
                return;
            }
            const target = typeof body.target === 'string' ? body.target.trim() : '';
            if (target === '') { sendJson(res, 400, { ok: false, detail: `scope ${scope} requires a target` }); return; }
            const note = typeof body.note === 'string' && body.note.trim() !== ''
                ? body.note.trim().slice(0, 500) : null;
            const m = await OPS.maintenanceTargetCount(scope, target);
            if (!m.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${m.reason})` }); return; }
            if ((m.rows[0]?.n ?? '0') === '0') {
                sendJson(res, 404, { ok: false, detail: `no device matches ${scope} ${JSON.stringify(target)}` });
                return;
            }
            const created = await OPS.createNotifyPolicy(scope, target, note,
                principal.kind === 'user' ? principal.username : 'unknown');
            if (!created.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${created.reason})` }); return; }
            if (created.rows.length === 0) {
                sendJson(res, 200, { ok: true, id: null, detail: `${scope} ${JSON.stringify(target)} is already covered by a policy` });
                return;
            }
            await auth.audit(principal, 'alert.policy', `${scope}:${target}`,
                { note }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, id: created.rows[0]?.id ?? null });
            return;
        }
        if (path === '/api/policy' && method === 'DELETE') {
            if (!enforce(res, principal, 'alert.suppress')) return;
            const id = url.searchParams.get('id') ?? '';
            if (!/^[0-9]{1,19}$/.test(id)) { sendJson(res, 400, { ok: false, detail: 'id must be a positive integer' }); return; }
            const gone = await OPS.deleteNotifyPolicy(id);
            if (!gone.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${gone.reason})` }); return; }
            const row = gone.rows[0];
            if (row === undefined) { sendJson(res, 404, { ok: false, detail: 'no such policy' }); return; }
            // Dropping a policy makes still-active covered alerts owed on the
            // next pass - the same catch-up a cancelled window gets, worth a
            // word in the response because it can mean a burst of pages.
            await auth.audit(principal, 'alert.unpolicy', `${row.scope}:${row.target}`,
                { note: row.note }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, detail: 'policy dropped - anything it was withholding is delivered on the next pass' });
            return;
        }
        // --- transient flag (slice 25, quiet 2) ------------------------------
        //
        // Grouping-family: the same declaration posture as location and
        // application, made from the same corner of the device page, behind
        // the same permission. One boolean, operator-declared, audited -
        // never derived from behavior.
        if (path === '/api/device/transient' && method === 'POST') {
            if (!enforce(res, principal, 'device.group')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = typeof body.name === 'string' ? body.name : '';
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            if (typeof body.transient !== 'boolean') {
                sendJson(res, 400, { ok: false, detail: 'transient must be true or false' });
                return;
            }
            const r = await OPS.setDeviceTransient(name, body.transient);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such device' }); return; }
            await auth.audit(principal, 'device.transient', name,
                { transient: body.transient }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, name, transient: body.transient });
            return;
        }
        // BULK TRANSIENT (slice 30): the roster selection, one statement. The
        // per-device route stays - it is where the decision is made while
        // looking at one machine - but a gaming parlor is declared as a SET,
        // and making the operator open six pages to flip one boolean six
        // times is the product being pedantic about where a fact is entered.
        if (path === '/api/devices/transient' && method === 'POST') {
            if (!enforce(res, principal, 'device.group')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            // normalizeNames RATHER THAN A BIGGER BODY. This route had no
            // semantic cap at all, so the 8 KB body limit was its only bound -
            // which made raising that limit the one change here that could
            // have removed a control instead of correcting one. Taking the
            // shared helper caps it at 1,000 like its three siblings, and
            // brings the dedupe and the counted refusal it never had.
            const sel = normalizeNames(body.names, 1000, 'set transient on');
            if (!sel.ok) { sendJson(res, 400, { ok: false, detail: sel.detail }); return; }
            const names = sel.names;
            if (typeof body.transient !== 'boolean') {
                sendJson(res, 400, { ok: false, detail: 'transient must be true or false' });
                return;
            }
            const r = await OPS.setTransientForDevices(names, body.transient);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const changed = r.rows.map((x) => x.name);
            // Audited with the NAMES, not just a count: "who declared these
            // machines transient" is exactly the question a quiet pager
            // provokes six months later.
            await auth.audit(principal, 'device.transient', `${changed.length} device(s)`,
                { transient: body.transient, names: changed }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, changed, transient: body.transient });
            return;
        }
        // --- device mute (slice 54) ------------------------------------------
        //
        // One route for the device page (a one-name list) and the roster's
        // selection, because it is one statement. Muted means NOTHING of the
        // device raises; the scan reads the column on its next pass, so open
        // alerts retire as source-removed within ALERT_MISSING_SCANS and
        // unmuting lets anything still true raise afresh.
        if (path === '/api/devices/mute' && method === 'POST') {
            if (!enforce(res, principal, 'device.mute')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const sel = normalizeNames(body.names, 1000, 'mute');
            if (!sel.ok) { sendJson(res, 400, { ok: false, detail: sel.detail }); return; }
            if (typeof body.muted !== 'boolean') {
                sendJson(res, 400, { ok: false, detail: 'muted must be true or false' });
                return;
            }
            const r = await OPS.setMutedForDevices(sel.names, body.muted);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const changed = r.rows.map((x) => x.name);
            // Names in the audit, as for transient: "who silenced this box"
            // is the question a missed outage asks months later.
            await auth.audit(principal, 'device.mute', `${changed.length} device(s)`,
                { muted: body.muted, names: changed }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, changed, muted: body.muted });
            return;
        }
        // THE WRITE PATH reach_check WAITED FOR (DECISIONS-2026-09-01 ruling
        // 6). The column has dispatched on its value and alarmed on what it
        // cannot probe since 2026-08-31; until this route, setting it - the
        // opt-out for a firewalled agent that answers every poll and blocks
        // ping - meant direct SQL. Accepted values are SUPPORTED_CHECKS plus
        // 'none', ONE source of truth imported from reach.ts - and the day
        // this comment once said would come CAME: when rung 1's transport
        // landed, 'tcp' entered the vocabulary in reach.ts and this route
        // accepted it with no edit to its allow-list, exactly the no-drift
        // property importing the constant was for. What tcp adds here is the
        // PORT - required exactly when the check is tcp, refused otherwise,
        // because a port silently ignored on an icmp write is the
        // ambiguity-by-leniency class the explicit-name override refused.
        if (path === '/api/devices/reach-check' && method === 'POST') {
            if (!enforce(res, principal, 'device.group')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const sel = normalizeNames(body.names, 1000, 'set the reach check on');
            if (!sel.ok) { sendJson(res, 400, { ok: false, detail: sel.detail }); return; }
            const check = typeof body.check === 'string' ? body.check : '';
            const allowed = [...SUPPORTED_CHECKS, 'none'];
            if (!allowed.includes(check)) {
                sendJson(res, 400, { ok: false, detail: `check must be one of: ${allowed.join(', ')}` });
                return;
            }
            let port: number | null = null;
            if (check === 'tcp') {
                port = Number(body.port);
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    sendJson(res, 400, {
                        ok: false,
                        detail: "a tcp check needs `port` (1-65535) - rung 1 is one port "
                            + 'standing in for the host, and which port answers is a fact '
                            + 'about the device only its operator knows',
                    });
                    return;
                }
            } else if (body.port !== undefined) {
                sendJson(res, 400, {
                    ok: false,
                    detail: `port only applies to check 'tcp' - a port on '${check}' would be `
                        + 'stored and silently mean nothing',
                });
                return;
            }
            if (check === 'none') {
                // A ping-only device's reach IS its status (slice 35); 'none'
                // would leave it monitored by nothing, rendering its last
                // state forever. Refused whole rather than partially applied.
                const pingOnly = await OPS.pingOnlyAmong(sel.names);
                if (!pingOnly.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${pingOnly.reason})` }); return; }
                if (pingOnly.rows.length > 0) {
                    sendJson(res, 400, {
                        ok: false,
                        detail: `${pingOnly.rows.length} of these are ping-only devices whose reach IS their `
                            + 'status - setting none would leave them monitored by nothing: '
                            + pingOnly.rows.map((x) => x.name).join(', '),
                    });
                    return;
                }
            }
            const r = await OPS.setDevicesReachCheck(sel.names, check, port);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const changed = r.rows.map((x) => x.name);
            await auth.audit(principal, 'device.reachCheck', `${changed.length} device(s)`,
                { check, ...(port !== null ? { port } : {}), names: changed }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, changed, check, ...(port !== null ? { port } : {}) });
            return;
        }
        // PING-ONLY DEVICES (slice 35). The external row at the top of a NOC
        // wall: the internet, an ISP handoff, anything that answers ICMP and
        // has no agent. No probe token, because there is nothing to probe -
        // the operator's typed name is the only identity such a host will
        // ever have, which is why this is its own route rather than a flag
        // on the onboarding flow whose entire purpose is reviewing what an
        // agent reported.
        if (path === '/api/devices/ping' && method === 'POST') {
            if (!enforce(res, principal, 'device.create')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_BULK);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const rows = Array.isArray(body.devices) ? body.devices : [];
            if (rows.length === 0 || rows.length > 100) {
                sendJson(res, 400, { ok: false, detail: 'devices takes 1 to 100 entries of {host, name}' });
                return;
            }
            const str = (v: unknown): string | null =>
                typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : null;
            const location = str(body.location);
            const application = str(body.application);
            const added: string[] = [];
            const skipped: Array<{ host: string; why: string }> = [];
            for (const r of rows) {
                const host = str((r as Record<string, unknown>).host);
                const name = str((r as Record<string, unknown>).name) ?? host;
                if (host === null || name === null) { skipped.push({ host: String(host), why: 'host is required' }); continue; }
                // The inet cast refuses a hostname, and saying so beats a
                // store error the operator has to decode. Resolution is not
                // done here on purpose: a name that resolves differently
                // later would silently start watching a different machine.
                if (!/^[0-9.]+$|^[0-9a-fA-F:]+$/.test(host)) {
                    skipped.push({ host, why: 'must be an IP address - a hostname could resolve elsewhere later' });
                    continue;
                }
                // WRITE-IN-LOOP-OK: one statement per device on a hand-typed
                // list of external services, bounded at 100 by the check
                // above. This is an onboarding action, not a poll path.
                const w = await OPS.insertPingDevice(name, host, location, application, 'globe');
                if (!w.ok) { skipped.push({ host, why: `store refused (${w.reason})` }); continue; }
                // Same judgement as the probe-add path (ruling 5), and the
                // name here is always TYPED, so a collision's way out is
                // always "pick a different name". Same address means the
                // machine is already watched under this name - said as that,
                // not as a refusal.
                const o = addOutcome(name, host, w.rows[0], true);
                if (o.kind === 'known') {
                    skipped.push({ host, why: 'that name already watches this address' });
                    continue;
                }
                if (o.kind === 'collision') { skipped.push({ host, why: o.why }); continue; }
                added.push(name);
            }
            await auth.audit(principal, 'device.create', `${added.length} ping-only device(s)`,
                { added, skipped: skipped.length, monitor: 'icmp', location, application },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, added, skipped });
            return;
        }
        // Slice 32: the operator's icon correction. Validated against the
        // SAME vocabulary the guesser can produce, so the override can only
        // ever be a stencil the wall knows how to draw - an unknown string
        // stored here would render as a blank tile nobody could explain.
        // Empty clears it and the machine's guess takes over again.
        if (path === '/api/device/stencil' && method === 'POST') {
            if (!enforce(res, principal, 'device.group')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = typeof body.name === 'string' ? body.name : '';
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            const raw = typeof body.stencil === 'string' ? body.stencil.trim() : '';
            if (raw !== '' && !STENCIL_NAMES.includes(raw)) {
                sendJson(res, 400, {
                    ok: false,
                    detail: `"${raw}" is not a stencil this build draws - one of: ${STENCIL_NAMES.join(', ')}, or blank to use the detected type`,
                });
                return;
            }
            const r = await OPS.setDeviceStencil(name, raw === '' ? null : raw);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such device' }); return; }
            await auth.audit(principal, 'device.stencil', name,
                { stencil: raw === '' ? null : raw }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, name, stencil: raw === '' ? null : raw });
            return;
        }
        if (path === '/api/device/grouping' && method === 'POST') {
            if (!enforce(res, principal, 'device.group')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const name = typeof body.name === 'string' ? body.name : '';
            if (name === '') { sendJson(res, 400, { ok: false, detail: 'name is required' }); return; }
            // Absent and empty mean different things at the API and the same
            // thing in the column: absent leaves the value alone would be the
            // richer contract, but this route always writes BOTH fields from
            // one form, so a partial update has no caller and would be an
            // untested path. Said out loud because "PATCH semantics" is the
            // obvious review question.
            const str = (v: unknown): string | null =>
                typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 120) : null;
            const location = str(body.location);
            const application = str(body.application);

            const r = await OPS.setDeviceGrouping(name, location, application);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rows.length === 0) { sendJson(res, 404, { ok: false, detail: 'no such device' }); return; }
            // Audited with BOTH values, because "who put this server in the
            // wrong application" is answerable only if the change is recorded
            // with what it became.
            await auth.audit(principal, 'device.group', name,
                { location, application }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, name, location, application });
            return;
        }
        // THE INVENTORY EXPORT: RSCanvas feeding CrossCanvas.
        //
        // RSCanvas builds no layout engine. CrossCanvas's inventory import
        // already turns a device list into a zoned, laid-out starting diagram,
        // and its column spec is documented as stable for exactly this - an
        // external producer is the supported case, not a hack. So this emits
        // that CSV and stops.
        //
        // Served on the interactive lane rather than the export lane, and
        // deliberately not as a job: the whole fleet is 450 rows at the lab
        // and about 600 at the stated ceiling. The export machinery exists for
        // millions of syslog rows; borrowing it for a spreadsheet that fits in
        // a packet would be ceremony.
        if (path === '/api/inventory.csv' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const axis = url.searchParams.get('axis') === 'application' ? 'application' : 'location';
            const value = url.searchParams.get('value');
            const boardRaw = url.searchParams.get('board');
            if (boardRaw !== null && !/^[0-9]{1,18}$/.test(boardRaw)) {
                sendJson(res, 400, { ok: false, detail: 'board must be a positive integer' });
                return;
            }
            // WHEN A BOARD IS NAMED, THE BOARD DECIDES WHAT IT IS A PICTURE
            // OF. Regenerating "application: Wiki" against a board sourced to
            // "location: HQ" would quietly produce a CSV that re-lays the
            // wrong fleet over somebody's arrangement, and the caller would
            // have no way to see it happened. The board already recorded the
            // answer; asking the query string instead would be preferring the
            // less-authoritative copy. A board with no source falls through to
            // the parameters, which is the hand-drawn case.
            let useAxis: 'location' | 'application' = axis;
            let useValues: string[] | null = value === null ? null : [value];
            if (boardRaw !== null) {
                const src = await OPS.boardSource(boardRaw);
                if (!src.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${src.reason})` }); return; }
                const row = src.rows[0];
                if (row === undefined) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
                if (row.source_axis !== null) {
                    useAxis = row.source_axis === 'application' ? 'application' : 'location';
                    // Slice 27: the declared LIST; null means the whole fleet.
                    useValues = Array.isArray(row.source_values)
                        ? (row.source_values as string[]) : null;
                }
            }
            const r = await OPS.inventoryForExport(useAxis, useValues);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }

            let body = inventoryHeader();
            for (const d of r.rows) {
                body += csvRow([
                    // label is the OPERATOR-ASSIGNED name; Hostname carries the
                    // device-reported sys_name beside it. Both go through
                    // csvCell, which asks nothing about origin - see the note
                    // in csv.ts about provenance not being the safety test.
                    d.name,
                    d.sys_name,
                    d.host,
                    // A best-effort stencil, ported from SNMPCanvas's own
                    // inventory export with two ordering bugs corrected (a
                    // MikroTik CRS is a switch, a TrueNAS is a NAS). It
                    // returns '' whenever the evidence is ambiguous, so the
                    // wall of "unrecognized stencil" warnings that the raw
                    // sysDescr produced does not come back - names here were
                    // verified by importing them into a real CrossCanvas.
                    guessStencil({
                        sysDescr: d.sys_descr, sysName: d.sys_name,
                        name: d.name, cpuModel: d.cpu_model,
                    }),
                    d.grouping,
                ]);
            }
            // Named for what it is, with the axis in it: an operator who
            // exports by location and by application in one session ends up
            // with two files in Downloads, and "inventory.csv (1)" is how the
            // wrong one gets imported.
            const stamp = new Date().toISOString().slice(0, 10);
            const slug = useValues === null ? 'all'
                : useValues.join('-').replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40);
            res.writeHead(200, {
                'content-type': 'text/csv; charset=utf-8',
                'content-disposition':
                    `attachment; filename="rscanvas-${useAxis}-${slug}-${stamp}.csv"`,
                'cache-control': 'no-store',
            });
            res.end(body);
            return;
        }

        // THE ROUND TRIP HOME: a laid-out inventory CSV from CrossCanvas
        // becomes this board's document.
        //
        // CSV BOTH WAYS, and never .xcanvas. The native format carries an
        // image table, zones, connections and a file version this application
        // would then be coupled to; the inventory CSV carries exactly the
        // fields both sides already agree on, and CrossCanvas exports it with
        // x/y/width/height. One format in each direction, no version handshake.
        const boardImport = /^\/api\/boards\/([0-9]{1,19})\/import$/.exec(path);
        if (boardImport && method === 'POST') {
            if (!enforce(res, principal, 'board.write')) return;
            const boardId = boardImport[1] as string;

            // Bounded before it is read, not after. An unbounded body on a
            // route that accepts a file is how a text/csv endpoint becomes a
            // memory-pressure lever, and the honest limit here is generous:
            // 4 MB is thousands of shapes.
            const chunks: Buffer[] = [];
            let size = 0;
            let tooBig = false;
            for await (const chunk of req) {
                size += (chunk as Buffer).length;
                if (size > 4_000_000) { tooBig = true; break; }
                chunks.push(chunk as Buffer);
            }
            if (tooBig) {
                sendJson(res, 413, { ok: false, detail: 'that file is over 4 MB - is it a .xcanvas rather than an inventory CSV?' });
                return;
            }

            const rows = parseCsv(Buffer.concat(chunks).toString('utf8'));
            if (rows.length < 2) {
                sendJson(res, 400, { ok: false, detail: 'that file has no data rows' });
                return;
            }
            const idx = headerIndex(rows[0] as string[]);
            const col = (r: string[], key: string): string => {
                const i = idx.get(key);
                return i === undefined ? '' : (r[i] ?? '').trim();
            };
            if (idx.get('x') === undefined || idx.get('y') === undefined) {
                sendJson(res, 400, {
                    ok: false,
                    detail: 'no x and y columns - export the inventory from CrossCanvas AFTER arranging, '
                        + 'so the positions come with it',
                });
                return;
            }

            const ids = await OPS.deviceIdentity();
            if (!ids.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${ids.reason})` }); return; }
            // THREE KEYS, IN DECLARED PRECEDENCE, because CrossCanvas says
            // plainly that the label is a human role name meant to be
            // sanitised for screen-sharing - "this board says Core Switch;
            // SNMPCanvas matches on 10.20.0.2". Matching on the label alone
            // would break the first time somebody renames a shape, which is
            // the normal thing to do to a diagram.
            //
            // AND AN AMBIGUOUS KEY IS NOT A MATCH. The first version built
            // plain Maps, so a key held by several devices silently kept
            // whichever was inserted last - and the round-trip test caught it
            // binding a renamed shape to mock-0161 instead of mock-0010,
            // because every device on the lab fixture answers on 127.0.0.1.
            //
            // That is not a fixture artefact to work around. Management
            // addresses genuinely repeat in the field: overlapping VRFs, NAT,
            // a re-addressed device whose old value lingers. A join key that
            // is not unique must refuse rather than choose, because choosing
            // produces a board that looks right and points at the wrong
            // machine - and nobody re-checks a shape that rendered.
            const uniqueBy = <T>(pairs: Array<[string, T]>): Map<string, T> => {
                const seen = new Map<string, T>();
                const dupes = new Set<string>();
                for (const [k, v] of pairs) {
                    if (k === '') continue;
                    if (seen.has(k)) dupes.add(k); else seen.set(k, v);
                }
                for (const k of dupes) seen.delete(k);
                return seen;
            };
            const byName = uniqueBy(ids.rows.map((d) => [d.name.toLowerCase(), d.name] as [string, string]));
            const byIp = uniqueBy(ids.rows.map((d) => [d.host, d.name] as [string, string]));
            const bySys = uniqueBy(ids.rows
                .filter((d) => d.sys_name !== null)
                .map((d) => [(d.sys_name as string).toLowerCase(), d.name] as [string, string]));

            // Every value that appeared, unique or not - the difference
            // between "not present" and "present more than once".
            const ipSeen = new Set(ids.rows.map((d) => d.host));
            const sysSeen = new Set(ids.rows
                .filter((d) => d.sys_name !== null)
                .map((d) => (d.sys_name as string).toLowerCase()));

            const shapes: Array<Record<string, unknown>> = [];
            const unmatched: string[] = [];
            let n = 0;
            for (const r of rows.slice(1)) {
                const type = col(r, 'type');
                // CrossCanvas exports zones, connections and text boxes in the
                // same file. Only devices bind to anything here; the rest are
                // dropped rather than stored as shapes that can never light up.
                if (type !== '' && type !== 'device') continue;
                const label = col(r, 'label');
                const shown = label === '' ? '(unlabelled)' : label;

                const x = Number(col(r, 'x'));
                const y = Number(col(r, 'y'));
                if (!Number.isFinite(x) || !Number.isFinite(y)) {
                    // NAMED, like every other drop. This used to be a bare
                    // `continue`: a spreadsheet that blanked one row's x on
                    // the way through - a sort that moved a cell, a locale
                    // that rewrote a decimal - lost that shape with no trace
                    // but a `placed` count nobody cross-checks. The comment
                    // eight lines below already promised every drop was named
                    // and with a reason; this one was neither.
                    if (unmatched.length < 50) unmatched.push(`${shown} (no usable x/y)`);
                    continue;
                }

                // THREE AXES, AND THEY MUST AGREE.
                //
                // The chain used to take the first hit, so a shape whose label
                // matched device A while its IP-Address uniquely identified
                // device B bound to A - silently, with the more specific
                // identity sitting unread in the same row. The path there is
                // ordinary editor work: copy a shape (the label comes along),
                // repoint its address, regenerate later.
                //
                // CrossCanvas's own guidance treats the label as the LEAST
                // trustworthy field - it is the one deliberately sanitised for
                // screen-sharing - so letting it outrank a matching address
                // had it exactly backwards. Now a disagreement refuses, on the
                // same reasoning as the duplicate-key refusal: a board that
                // looks right and points at the wrong machine is never
                // re-checked.
                const candidates = [
                    byName.get(label.toLowerCase()),
                    byIp.get(col(r, 'ipaddress')),
                    bySys.get(col(r, 'hostname').toLowerCase()),
                ].filter((v): v is string => v !== undefined);
                const distinct = [...new Set(candidates)];
                if (distinct.length > 1) {
                    if (unmatched.length < 50) {
                        unmatched.push(`${shown} (identifies ${distinct.join(' and ')} - which is it?)`);
                    }
                    continue;
                }
                const bind = distinct[0] ?? null;
                if (bind === null) {
                    // NAMED, NOT COUNTED, AND WITH THE REASON. "3 shapes did
                    // not match" sends somebody hunting. Naming them says
                    // which three - and distinguishing "no device has this
                    // identity" from "several do" matters, because the fixes
                    // differ: one is a rename, the other is a duplicate
                    // address somebody has to resolve before a board can
                    // point at the right machine.
                    const ip = col(r, 'ipaddress');
                    const sys = col(r, 'hostname').toLowerCase();
                    const ambiguous = (ip !== '' && !byIp.has(ip) && ipSeen.has(ip))
                        || (sys !== '' && !bySys.has(sys) && sysSeen.has(sys));
                    const why = ambiguous ? ' (identity shared by several devices)' : '';
                    if (unmatched.length < 50) unmatched.push(shown + why);
                    continue;
                }
                n += 1;
                shapes.push({
                    id: `s${n}`,
                    kind: 'device',
                    bind,
                    label: label === '' ? bind : label,
                    x, y,
                    w: Number(col(r, 'width')) || 190,
                    h: Number(col(r, 'height')) || 100,
                });
            }

            if (shapes.length === 0) {
                sendJson(res, 400, {
                    ok: false,
                    detail: `no row matched a device. Tried label against device name, then IP-Address, `
                        + `then Hostname. ${unmatched.length} row(s) went unmatched.`,
                    unmatched,
                });
                return;
            }

            const w = await OPS.rawSetBoardDoc(boardId, JSON.stringify({ shapes }));
            if (!w.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${w.reason})` }); return; }
            // A zero-row UPDATE is a board that does not exist, not a
            // success: without this check the route answered `200 placed: N`
            // for a bogus id, having written nothing and audited a phantom
            // action. The /source route reads first and 404s; these UPDATE
            // routes learn the same answer from rowCount (2026-09-01 review).
            if (w.rowCount === 0) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
            await auth.audit(principal, 'board.import', boardId,
                { placed: shapes.length, unmatched: unmatched.length }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, placed: shapes.length, unmatched });
            return;
        }

        const boardSource = /^\/api\/boards\/([0-9]{1,19})\/source$/.exec(path);
        if (boardSource && method === 'POST') {
            if (!enforce(res, principal, 'board.write')) return;
            const body = await readBodyOr400(req, res);
            if (body === null) return;
            const id = boardSource[1] as string;
            // Slice 41: this route was written before team boards and spoke
            // only {axis, value} - ONE group. Slice 27 gave a board a LIST and
            // made DECLARED ORDER the section order on the wall, but this
            // route learned neither, so the order was settled at creation and
            // could not be changed: reordering five zones meant building a
            // sixth board, which meant a new id, which revoked every display
            // token aimed at the old one.
            //
            // The old field names keep working, TRANSLATED into the new ones
            // rather than validated a second time - the both-or-neither rule
            // now lives once, in boards/source.ts.
            const shaped = 'sourceAxis' in body || 'sourceValues' in body || 'sourceValue' in body
                ? body
                : { sourceAxis: body.axis, sourceValue: body.value, allValues: body.allValues };
            const parsed = parseSourceDeclaration(shaped as Record<string, unknown>);
            if (!parsed.ok) { sendJson(res, 400, { ok: false, detail: parsed.detail }); return; }
            const { axis, values } = parsed.decl;

            // Read BEFORE the write, because the response has to distinguish
            // two outcomes the caller acts on differently. A REORDER leaves
            // the board covering exactly the devices it already covered. A
            // RETARGET does not, and this route deliberately does not rewrite
            // the document (see setBoardSource - a hand-drawn board may be
            // sourced purely to give the drift check something to check), so
            // the shapes now bind the previous set and somebody should be
            // told that plainly rather than discovering it via drift.
            const cur = await OPS.boardSource(id);
            if (!cur.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${cur.reason})` }); return; }
            const row = cur.rows[0];
            if (row === undefined) { sendJson(res, 404, { ok: false, detail: `there is no board ${id}` }); return; }
            const before = {
                axis: row.source_axis === 'location' ? 'location' as const
                    : row.source_axis === 'application' ? 'application' as const : null,
                values: Array.isArray(row.source_values) ? row.source_values as string[] : null,
            };
            const reorderOnly = sameCoverage(before, { axis, values });

            const r = await OPS.setBoardSource(id, axis, values);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            await auth.audit(principal, 'board.setSource', id,
                { from: before, to: { axis, values }, reorderOnly }, inetOrNull(clientIp(req)));
            sendJson(res, 200, {
                ok: true,
                sourceAxis: axis,
                sourceValues: values,
                reorderOnly,
                detail: axis === null
                    ? 'this board no longer declares a group, so nothing checks it for drift'
                    : reorderOnly
                        ? 'same groups, new order - the board covers the devices it already covered, '
                          + 'and its sections will render top to bottom in the order just given'
                        : 'the groups changed, and this board still binds the previous set - '
                          + 'regenerate or re-import it, and the drift check will name the gap',
                // The single value this route used to speak in, kept so a
                // caller written against the old shape still reads an answer.
                axis,
                value: values === null ? null : values[0] ?? null,
            });
            return;
        }

        // THE VERB the drift detection never had (DECISIONS-2026-09-01
        // ruling 8). Since slice 41 the boards list has detected drift,
        // quantified it and named it - and offered View, Displays and
        // Delete beside the number. An operator who reassigned a fleet got
        // a correct, actionable-sounding count and no action: the routes
        // out were delete-and-recreate, which revokes every display token,
        // or hand-editing the document. Three verbs now, each a deliberate
        // operator action, never automatic, and the board id - therefore
        // its tokens - survives all three. The judgements live in
        // boards/reconcile.ts; this route feeds them the SAME drift query
        // the list reports from, so a reconcile drives that exact report
        // to zero by construction.
        const boardRec = /^\/api\/boards\/([0-9]{1,19})\/reconcile$/.exec(path);
        if (boardRec && method === 'POST') {
            if (!enforce(res, principal, 'board.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const id = boardRec[1] as string;
            const action = body.action;
            if (action !== 'add-missing' && action !== 'drop-moved' && action !== 'rebuild') {
                sendJson(res, 400, { ok: false, detail: 'action must be add-missing, drop-moved, or rebuild' });
                return;
            }
            const b = await OPS.boardForReconcile(id);
            if (!b.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${b.reason})` }); return; }
            const board = b.rows[0];
            if (board === undefined) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
            if (board.source_axis === null) {
                // The drift cell's own words: a hand-drawn board is not "0
                // drift", it is a board the question does not apply to - and
                // a board that cannot drift from a group cannot be
                // reconciled against one.
                sendJson(res, 400, {
                    ok: false,
                    detail: 'this board declares no source - only a sourced board can be reconciled against its group',
                });
                return;
            }
            const axis = board.source_axis === 'location' ? 'location' as const : 'application' as const;
            const values = Array.isArray(board.source_values)
                ? (board.source_values as unknown[]).map((v) => String(v)) : null;
            const doc = board.doc ?? {};
            const shapes = Array.isArray(doc.shapes) ? doc.shapes as Array<Record<string, unknown>> : [];

            let newShapes: Array<Record<string, unknown>>;
            let report: Record<string, unknown>;
            if (action === 'rebuild') {
                // Behind a confirmation that says what it discards, because
                // this is the delete-and-recreate workflow with the id kept:
                // every hand placement goes, and that is the point of asking.
                if (body.confirm !== true) {
                    sendJson(res, 400, {
                        ok: false,
                        reason: 'confirm-required',
                        detail: `rebuild regenerates this board from its group and discards all `
                            + `${shapes.length} current shape(s) and every hand placement. The board id `
                            + 'and its display tokens survive. Send confirm: true to proceed.',
                    });
                    return;
                }
                const inv = await OPS.inventoryForExport(axis, values);
                if (!inv.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${inv.reason})` }); return; }
                newShapes = generatedShapes(inv.rows.map((d) => d.name));
                report = { devices: inv.rows.length, discardedShapes: shapes.length };
            } else {
                const drift = await OPS.boardDrift(id);
                if (!drift.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${drift.reason})` }); return; }
                const row = drift.rows[0];
                if (action === 'add-missing') {
                    // Ordered by the same query creation orders by, filtered
                    // to the missing set, so an appended run and a rebuilt
                    // board agree about sequence.
                    const missing = new Set((row?.missing_names ?? []).map((n) => String(n)));
                    const inv = await OPS.inventoryForExport(axis, values);
                    if (!inv.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${inv.reason})` }); return; }
                    const ordered = inv.rows.map((d) => d.name).filter((n) => missing.has(n));
                    const r2 = appendMissing(shapes, ordered);
                    newShapes = r2.shapes;
                    report = { added: r2.added };
                } else {
                    // extra covers moved AND deleted on a sourced board (a
                    // deleted device trivially no longer matches the source);
                    // broken is unioned in anyway so the two counts can never
                    // drift apart here even if the query's sets change shape.
                    const gone = new Set([
                        ...(row?.extra_names ?? []).map((n) => String(n)),
                        ...(row?.broken_names ?? []).map((n) => String(n)),
                    ]);
                    const r2 = dropMoved(shapes, gone);
                    newShapes = r2.shapes;
                    report = { dropped: r2.dropped, removedShapes: r2.removedShapes };
                }
            }
            // Top-level document keys OTHER than shapes pass through
            // untouched - the verbs edit exactly what they name. rowCount 0
            // is the board vanishing between the read and the write.
            const wrote = await OPS.rawSetBoardDoc(id, JSON.stringify({ ...doc, shapes: newShapes }));
            if (!wrote.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${wrote.reason})` }); return; }
            if (wrote.rowCount === 0) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
            await auth.audit(principal, 'board.reconcile', id,
                { board: board.name, action, ...report, shapes: newShapes.length },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, action, ...report, shapes: newShapes.length });
            return;
        }

        const boardDrift = /^\/api\/boards\/([0-9]{1,19})\/drift$/.exec(path);
        if (boardDrift && method === 'GET') {
            if (!enforce(res, principal, 'board.read')) return;
            const r = await OPS.boardDrift(boardDrift[1] as string);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const row = r.rows[0];
            sendJson(res, 200, {
                ok: true,
                missing: Number(row?.missing ?? 0),
                extra: Number(row?.extra ?? 0),
                missingNames: row?.missing_names ?? [],
                extraNames: row?.extra_names ?? [],
                broken: Number(row?.broken ?? 0),
                brokenNames: row?.broken_names ?? [],
            });
            return;
        }

        if (path === '/api/device/groups' && method === 'GET') {
            if (!enforce(res, principal, 'devices.read')) return;
            const axis = url.searchParams.get('axis') === 'application' ? 'application' : 'location';
            const r = await OPS.deviceGroupCounts(axis);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            sendJson(res, 200, { ok: true, axis, groups: r.rows });
            return;
        }
        if (path === '/api/dashboard/groups' && method === 'GET') {
            // The Dashboard's health by location and application: live, on
            // the interactive lane, fetched with the page's 10 s refresh -
            // not the top-10 lists' cached heavy-lane answer, because up and
            // down move between rollups.
            if (!enforce(res, principal, 'devices.read')) return;
            const r = await OPS.groupHealth();
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            sendJson(res, 200, {
                ok: true,
                locations: r.rows.filter((g) => g.axis === 'location'),
                applications: r.rows.filter((g) => g.axis === 'application'),
            });
            return;
        }

        // --- boards and capability tokens (slice 8 / U5) -----------------------
        //
        // BOARD-EXPOSURE.md governs everything below. Its two clauses appear
        // here as: no route returns a collection to a display, and the only
        // board content a display can reach is the projection.

        if (path === '/api/boards' && method === 'GET') {
            // Signed-in humans only. THERE IS DELIBERATELY NO DISPLAY PATH TO
            // THIS ROUTE - clause 2. A token that could list boards turns one
            // leaked corridor screen into an inventory of every site the
            // organisation runs.
            if (!enforce(res, principal, 'board.read')) return;
            const r = await OPS.uiBoards();
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            // The grid field registry rides along (slice 26) so the admin UI
            // renders checkboxes from the server's own list - a client copy
            // would be a second place for the registry to rot.
            sendJson(res, 200, {
                ok: true, boards: r.rows,
                gridFields: GRID_FIELDS, gridDefaults: GRID_DEFAULT_FIELDS,
                // Whether the page offers the hand-placed layout controls
                // (BOARDS_MANUAL_LAYOUT, config.ts says why it is off).
                manualLayout: CONFIG.boardsManualLayout,
            });
            return;
        }
        if (path === '/api/boards' && method === 'POST') {
            if (!enforce(res, principal, 'board.write')) return;
            const body = await readBodyOr400(req, res);
            if (body === null) return;
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            const collection = body.collection === 'diagram' ? 'diagram' : 'wall';
            if (name === '' || name.length > 120) {
                sendJson(res, 400, { ok: false, detail: 'name is required, up to 120 characters' });
                return;
            }
            // GENERATED FROM A GROUP: the board records what it is a picture
            // of at the moment it is made, so the drift check works from the
            // first minute rather than after somebody remembers to set it.
            // Same both-or-neither rule as the source route - an axis with no
            // value would describe a board as "the location board for
            // nothing", and drift would then call every ungrouped device
            // missing from it.
            // The rules themselves moved to boards/source.ts when the UPDATE
            // route (slice 41) needed the same ones. Two copies of a
            // both-or-neither rule is how one of them quietly stops being
            // true, and it is always the copy nobody re-reads.
            const parsed = parseSourceDeclaration(body);
            if (!parsed.ok) { sendJson(res, 400, { ok: false, detail: parsed.detail }); return; }
            const { axis, values } = parsed.decl;
            const owner = principal.kind === 'user' ? principal.id : null;
            const r = await OPS.createBoard(name, collection, owner, axis, values);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            const newId = r.rows[0]?.id;
            // A SOURCED board populates its own shapes at birth (slice 27):
            // bind and label per device, coordinates a formality grid so the
            // drawn mode stays renderable. This is generation, not layout -
            // the glance grid ignores the coordinates entirely, and a board
            // headed for CrossCanvas polish still goes through the CSV ferry
            // exactly as before. Two clicks from group to wall.
            let placed = 0;
            if (axis !== null && newId !== undefined) {
                const inv = await OPS.inventoryForExport(axis, values);
                if (inv.ok && inv.rows.length > 0) {
                    // One generator, shared with the reconcile route's
                    // rebuild verb - which IS this path with the id kept, so
                    // the two must mint identical documents or "rebuild from
                    // group" quietly stops meaning that.
                    const shapes = generatedShapes(inv.rows.map((d) => d.name));
                    const wrote = await OPS.rawSetBoardDoc(String(newId), JSON.stringify({ shapes }));
                    if (wrote.ok) placed = shapes.length;
                }
                // BORN LAID OUT (2026-09-30): a generated board is an
                // automatic glance grid from its first minute - columns
                // fitted to each display's screen, the default fields -
                // rather than a set of coordinates that waited for someone
                // to find the grid editor. The grid editor still changes it.
                await OPS.setBoardGrid(String(newId), 0, JSON.stringify(GRID_DEFAULT_FIELDS));
            }
            await auth.audit(principal, 'board.create', name,
                { collection, sourceAxis: axis, sourceValues: values, placed }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, id: newId, sourceAxis: axis, sourceValues: values, placed });
            return;
        }

        // Boards accumulate otherwise. An admin surface that can only create
        // is one somebody stops using once the list is unreadable - and the
        // exposure test was leaving a fixture board behind on every run.
        const boardOne = /^\/api\/boards\/([0-9]{1,19})$/.exec(path);
        if (boardOne && method === 'DELETE') {
            if (!enforce(res, principal, 'board.write')) return;
            const r = await OPS.deleteBoard(boardOne[1] as string);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            // Tokens cascade with the board (ON DELETE CASCADE), so deleting a
            // board revokes its displays by removing them - worth saying,
            // because "delete the board" quietly being "revoke every token for
            // it" is the sort of side effect that should be written down.
            await auth.audit(principal, 'board.delete', boardOne[1] as string,
                { deleted: r.rowCount }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, deleted: r.rowCount });
            return;
        }

        const boardAddr = /^\/api\/boards\/([0-9]{1,19})\/addresses$/.exec(path);
        if (boardAddr && method === 'POST') {
            if (!enforce(res, principal, 'board.write')) return;
            const body = await readBodyOr400(req, res);
            if (body === null) return;
            const show = body.show === true;
            const r = await OPS.setBoardAddresses(boardAddr[1] as string, show);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rowCount === 0) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
            // Audited because it widens what a capability token can see.
            // Clause 3 makes this a declared choice, and a choice nobody can
            // reconstruct afterwards is not much of one.
            await auth.audit(principal, 'board.setAddresses', boardAddr[1] as string,
                { show }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, show });
            return;
        }

        // Slice 26: the grid declaration. cols turns the rendering mode on
        // (null off); fields is the tile registry selection, validated
        // against GRID_FIELDS server-side so an unknown key is refused, not
        // stored-and-ignored. Audited like setAddresses and for the same
        // reason: identity fields widen what a capability token can see,
        // and a choice nobody can reconstruct afterwards is not much of one.
        const boardGrid = /^\/api\/boards\/([0-9]{1,19})\/grid$/.exec(path);
        if (boardGrid && method === 'POST') {
            if (!enforce(res, principal, 'board.write')) return;
            const body = await readBodyOr400(req, res);
            if (body === null) return;
            let cols: number | null = null;
            if (body.cols !== null && body.cols !== undefined) {
                cols = Math.round(Number(body.cols));
                // 0 means AUTO (the operator finding: CrossCanvas's static
                // 4-per-zone gave an 80-device zone twenty rows; the fix is
                // fitting the screen, and the display is the only one that
                // knows its own screen - so auto is computed at render, from
                // the tile height the per-board field set already fixes).
                if (!Number.isFinite(cols) || cols < 0 || cols > 24) {
                    sendJson(res, 400, { ok: false, detail: 'cols must be 1..24, 0 for auto, or null to turn the grid off' });
                    return;
                }
            }
            let fieldsJson: string | null = null;
            if (body.fields !== undefined) {
                const known = new Set(GRID_FIELDS.map((f) => f.key));
                const fields = Array.isArray(body.fields) ? body.fields : null;
                if (fields === null || fields.some((f) => typeof f !== 'string' || !known.has(f))) {
                    sendJson(res, 400, {
                        ok: false,
                        detail: `fields must be an array drawn from: ${[...known].join(', ')}`,
                    });
                    return;
                }
                fieldsJson = JSON.stringify(fields);
            }
            const r = await OPS.setBoardGrid(boardGrid[1] as string, cols, fieldsJson);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rowCount === 0) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
            await auth.audit(principal, 'board.setGrid', boardGrid[1] as string,
                { cols, fields: fieldsJson === null ? undefined : JSON.parse(fieldsJson) },
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, cols });
            return;
        }

        // The editor's save path, and the only way a document is written.
        // Note what it does NOT do: validate or sanitise the contents. The
        // guarantee this codebase relies on is that the document is never
        // SERVED to a display, not that it was scrubbed on the way in -
        // scrubbing protects only the fields somebody thought of, while the
        // projection protects every field nobody did.
        const boardDoc = /^\/api\/boards\/([0-9]{1,19})\/doc$/.exec(path);
        if (boardDoc && method === 'PUT') {
            if (!enforce(res, principal, 'board.write')) return;
            let body: Record<string, unknown>;
            try {
                body = await readJsonBody(req, BODY_CAP_DOC);
            } catch (err) {
                sendJson(res, 400, { ok: false, detail: (err as Error).message });
                return;
            }
            const r = await OPS.rawSetBoardDoc(boardDoc[1] as string, JSON.stringify(body));
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            if (r.rowCount === 0) { sendJson(res, 404, { ok: false, detail: 'no such board' }); return; }
            await auth.audit(principal, 'board.save', boardDoc[1] as string, undefined,
                inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true });
            return;
        }

        const boardTokens = /^\/api\/boards\/([0-9]{1,19})\/tokens$/.exec(path);
        if (boardTokens && method === 'GET') {
            if (!enforce(res, principal, 'board.read')) return;
            const r = await OPS.boardTokens(boardTokens[1] as string);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            sendJson(res, 200, { ok: true, tokens: r.rows });
            return;
        }
        if (boardTokens && method === 'POST') {
            if (!enforce(res, principal, 'token.mint')) return;
            const body = await readBodyOr400(req, res);
            if (body === null) return;
            const label = typeof body.label === 'string' ? body.label.trim() : '';
            if (label === '' || label.length > 120) {
                sendJson(res, 400, { ok: false, detail: 'label is required - it is how you will know which display to revoke' });
                return;
            }
            const secret = mintSecret();
            const r = await OPS.mintToken(
                boardTokens[1] as string, hashToken(secret), label,
                principal.kind === 'user' ? principal.id : null);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            await auth.audit(principal, 'token.mint', label,
                { boardId: boardTokens[1], tokenId: r.rows[0]?.id }, inetOrNull(clientIp(req)));
            // THE ONE AND ONLY TIME THE SECRET EXISTS OUTSIDE THE MINTING
            // CALL. Only the hash was stored, so this cannot be re-shown, and
            // the UI has to say so - a "copy it now" that is actually true is
            // worth more than a reassuring one that is not.
            sendJson(res, 200, { ok: true, id: r.rows[0]?.id, secret, showOnce: true });
            return;
        }

        const tokenRevoke = /^\/api\/tokens\/([0-9]{1,19})$/.exec(path);
        if (tokenRevoke && method === 'DELETE') {
            if (!enforce(res, principal, 'token.revoke')) return;
            const r = await OPS.revokeToken(
                tokenRevoke[1] as string, principal.kind === 'user' ? principal.id : null);
            if (!r.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${r.reason})` }); return; }
            // Zero rows means it was already revoked, which is a SUCCESS and
            // not a 404: the caller asked for it to be dead and it is dead.
            // Reporting failure here would train an operator to retry, or
            // worse to wonder whether the revoke took.
            const already = r.rows.length === 0;
            await auth.audit(principal, 'token.revoke', tokenRevoke[1] as string,
                { already }, inetOrNull(clientIp(req)));
            sendJson(res, 200, { ok: true, already });
            return;
        }

        // THE DISPLAY PATH. The only route a capability token can reach.
        //
        // TWO WAYS IN, ONE AUTHORISATION (slice 45). A kiosk has no session,
        // so it presents a capability token. A signed-in operator already has
        // a session, and making them mint a token to look at their own board
        // was a real tax: mintToken stores only a token_hash, so a display URL
        // is unrecoverable by construction and "I lost the link" means revoke
        // and re-mint. That property is right for a credential handed to a TV
        // and wrong as the only way through the door.
        //
        // The two paths differ ONLY in where the board id comes from, and
        // both end at the same enforce() and the same projection:
        //
        //   token   - id comes FROM THE TOKEN, and the request cannot name a
        //             board, so a token can never be pointed at another one.
        //   session - id comes from ?board=, which is ordinary and checked,
        //             because a user principal is authorised per resource the
        //             way every other route in this file authorises.
        //
        // Anonymous still gets 'token-required'. The display route does not
        // become a public one.
        if (path === '/api/display/board' && method === 'GET') {
            const secret = tokenFromRequest(req.headers, url.searchParams);
            let viewer: Principal;
            let boardId: string;
            if (secret !== null) {
                let display: Principal | null;
                try {
                    display = await principalForToken(secret);
                } catch (err) {
                    // A store refusal is not an auth failure. Saying "bad token"
                    // when the truth is "database busy" sends whoever is standing
                    // at the display looking for a credential problem that does
                    // not exist.
                    sendJson(res, 503, { ok: false, detail: (err as Error).message });
                    return;
                }
                if (display === null) {
                    // One answer for "no such token" and "revoked", deliberately:
                    // distinguishing them tells a holder of a dead token that it
                    // was once real, which is a small oracle and free to withhold.
                    sendJson(res, 403, { ok: false, reason: 'token-invalid' });
                    return;
                }
                viewer = display;
                boardId = String((display as { boardId: number }).boardId);
            } else if (principal.kind === 'user') {
                const asked = url.searchParams.get('board') ?? '';
                // Within bigint: 20 digits passed [0-9]+ and overflowed in SQL.
                if (!/^[0-9]{1,18}$/.test(asked)) {
                    sendJson(res, 400, {
                        ok: false,
                        reason: 'board-required',
                        detail: 'signed-in requests name the board: /api/display/board?board=<id>',
                    });
                    return;
                }
                viewer = principal;
                boardId = asked;
            } else {
                sendJson(res, 401, { ok: false, reason: 'token-required' });
                return;
            }
            // Authorised against the board actually about to be rendered,
            // whichever way the id arrived.
            if (!enforce(res, viewer, 'board.render', { type: 'board', id: boardId })) return;

            // The binding identity is projected only for a session, which is
            // the same test that sets `interactive` below. One decision, made
            // once: a viewer that may not click through is never sent the
            // names it would click through TO.
            const proj = await OPS.boardProjection(boardId, viewer.kind === 'user');
            if (!proj.ok) { sendJson(res, 503, { ok: false, detail: `store refused (${proj.reason})` }); return; }
            const board = proj.rows[0];
            if (board === undefined) { sendJson(res, 404, { ok: false, detail: 'board not found' }); return; }
            sendJson(res, 200, {
                ok: true, name: board.name, collection: board.collection, shapes: board.shapes,
                // WHO IS LOOKING, decided HERE and never by the display.
                //
                // This is the flag that will let a signed-in operator click a
                // tile through to the device, and a kiosk not. It is sent by
                // the server rather than inferred by the page from its own URL
                // because a page that reads its trust level out of its query
                // string is not a control: anyone with the lobby TV's link
                // could append the parameter. Same shape as BOARD-EXPOSURE
                // clause 1 - the display renders what it is told it may, and
                // cannot grant itself more.
                //
                // A capability token is a capability for ONE BOARD. Letting it
                // navigate into the app would silently widen it into a weak
                // session with worse revocation, so it never gets this.
                interactive: viewer.kind === 'user',
                // Slice 26: the grid declaration rides the same payload -
                // cols plus the DECLARED field keys, which is also the
                // client's render order source of truth. Absent entirely for
                // a drawn board, so the wall's default path is untouched.
                ...(board.grid_cols !== null ? {
                    grid: {
                        cols: board.grid_cols, fields: board.grid_fields,
                        // Slice 27: the declared groups IN DECLARED ORDER -
                        // the renderer's section ordering, chosen by the team
                        // that owns the board. null on an unsourced board
                        // (flat grid) and on the all-fleet board (sections
                        // from the values present, alphabetically - the only
                        // case where alphabetical is honest, since nobody
                        // declared an order).
                        sections: board.source_axis !== null && Array.isArray(board.source_values)
                            ? board.source_values : null,
                        sectioned: board.source_axis !== null,
                    },
                } : {}),
            });
            return;
        }

        if (path === '/api/audit' && method === 'GET') {
            await authRoutes.listAudit(res, principal, url.searchParams);
            return;
        }

        if (path === '/api/users') {
            if (method === 'GET') { await authRoutes.listUsers(res, principal); return; }
            if (method === 'POST') { await authRoutes.createUser(req, res, principal); return; }
            sendJson(res, 405, { ok: false, detail: 'GET or POST' });
            return;
        }

        const userMatch = /^\/api\/users\/([^/]+)(\/role|\/password)?$/.exec(path);
        if (userMatch) {
            // A malformed escape (`%`, `%zz`) threw a URIError here, before
            // any route authorised - a 500 and a stack trace in the log for
            // anyone (review L2). It is the client's mistake: a 400.
            let target: string;
            try {
                target = decodeURIComponent(userMatch[1] as string);
            } catch {
                sendJson(res, 400, { ok: false, detail: 'malformed user name in the path' });
                return;
            }
            const sub = userMatch[2];
            if (sub === '/role' && method === 'POST') {
                await authRoutes.setRole(req, res, principal, target);
                return;
            }
            if (sub === '/password' && method === 'POST') {
                await authRoutes.setPassword(req, res, principal, target);
                return;
            }
            if (sub === undefined && method === 'DELETE') {
                await authRoutes.deleteUser(req, res, principal, target);
                return;
            }
            sendJson(res, 405, { ok: false, detail: 'method not allowed for this user route' });
            return;
        }

        sendJson(res, 404, { ok: false, detail: 'not found' });
    };

    route().catch((err) => {
        // Fail loud, but not into a hung socket.
        log('unhandled route error:', err);
        if (!res.headersSent) sendJson(res, 500, { ok: false, detail: 'internal error' });
        else res.end();
    });
});

// An 'error' on the server has no listener by default, so a failed bind throws
// a raw stack. EADDRINUSE is the common one and it is not a mystery worth
// debugging from a stack trace - it means the previous instance is still up,
// which the chaos suite hits whenever a scenario's cleanup loses a race.
//
// Still fatal, deliberately: an application that cannot bind its port has
// nothing useful to do. What changes is that it says so in one line.
server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
        log(`FATAL port ${CONFIG.httpPort} is already in use - another instance is still running`);
    } else {
        log(`FATAL http server error: ${err.message}`);
    }
    process.exit(1);
});

// DERIVE THE CREDENTIAL KEY BEFORE ACCEPTING TRAFFIC (2026-08-31, independent
// review S4). credentialKey() is scryptSync at N=16384 - about 30ms, the same
// cost auth/password.ts exists to keep off this thread - and it is cached, so
// it happens exactly once. The question was only WHERE. Before this, the first
// call came from a /api/credentials handler, so the very first operator to
// open the Credentials page paid it on the main thread, and the heartbeat
// recorded one gap per process lifetime, which reads as noise.
//
// Warming it here also improves the failure: an unusable RSCANVAS_SECRET
// becomes a startup condition rather than a first-visit-to-a-page condition.
// Each worker keeps its own module instance and warms its own cache off this
// thread, which is the point of the split.
log(credentialStoreReady()
    ? '  credential store: key derived at boot'
    : '  credential store: RSCANVAS_SECRET unset - profiles disabled, SNMP_COMMUNITY* still resolve');

// On BIND_ADDRESS when it is set, else every address, IPv6 included (config.ts
// bindAddressSet says why the default is not passed through).
const onListening = (): void => {
    log(`${SCHEME} listening on ${CONFIG.bindAddressSet ? `${CONFIG.bindAddress}:` : ''}${CONFIG.httpPort}${tlsPair === null ? '' : ` (TLS_CERT=${CONFIG.tlsCert}; plain http on this port is redirected)`}`);
    log('  POST /api/login                 {username, password}');
    log('  POST /api/logout');
    log('  GET  /api/me');
    log('  GET  /api/health/live           unauthenticated: liveness, bare {ok}');
    log('  GET  /api/health/work           unauthenticated: work verdict for monitors (503 = starved)');
    log('  GET  /api/health[?deep=1]       authenticated');
    log('  GET  /api/syslog/search?hours=1&host=sw-0001&q=fragment');
    log('  GET  /api/alerts[?history=25]   open + recently cleared');
    log('  GET  /api/alert?id=[&history=50] one alert + its delivery log');
    log('  GET  /api/devices               the watched roster with alert counts');
    log('  GET  /                          the read-only shell (data via the routes above)');
    log('  GET  /api/users                 admin');
    log('  POST /api/users                 admin   {username, password, role}');
    log('  DELETE /api/users/:name         admin');
    log('  POST /api/users/:name/role      admin   {role}');
    log('  POST /api/users/:name/password  own or admin');
    log('  GET  /api/audit                 admin');

    // The default configuration writes forever and expires nothing, and it says
    // so once rather than being discovered from a disk graph.
    //
    // JOBS_ENABLED defaults to 0 while both writers run unconditionally. That is
    // the right default for a first run - retention should not drop anything
    // until somebody has watched it - but left alone it is a deployment that
    // ingests indefinitely and never expires. On a 30,000-entity fleet that is
    // about 11GB a day.
    if (!CONFIG.jobsEnabled) {
        log('WARNING JOBS_ENABLED=0 - the rollup and retention are NOT running.');
        log('        Nothing will ever be expired and nothing is rolled up.');
        log('        Deliberate for a first run; a permanent state to check on.');
    }

    // Notification channels, with the decision/mistake discrimination that
    // every other absence in this codebase gets. Nothing configured is a
    // choice and says so once; half-configured is a TYPO and shouts, because
    // otherwise it is invisible - the channel is silently off, alerts settle
    // as delivered since nothing owed them, and nobody is ever told.
    const channels = channelConfig();
    for (const [ch, missing] of Object.entries(channels.incomplete)) {
        log(`WARNING notification channel "${ch}" is HALF-CONFIGURED: `
            + `${missing.join(' and ')} not set.`);
        log('        It is silently disabled, and alerts will settle as delivered');
        log('        without reaching it. Set the missing value, or unset the rest');
        log('        to turn the channel off on purpose. Also on /api/health.');
    }
    if (channels.enabled.length === 0) {
        log('NOTE no notification channels are configured - alerts will be raised and');
        log('     visible on the page, and nobody will be told. Set ALERT_SYSLOG_HOST,');
        log('     ALERT_NTFY_SERVER + TOPIC, or ALERT_SMTP_HOST + FROM + TO.');
    } else {
        log(`notification channels: ${channels.enabled.join(', ')}`);
    }
    if (CONFIG.alertSmtpModeUnknown !== null) {
        log(`WARNING ALERT_SMTP_MODE=${JSON.stringify(CONFIG.alertSmtpModeUnknown)} is not tls, starttls or none -`);
        log('        email uses starttls (upgrade or fail, never plaintext). Set it to one of the three.');
    }
};
if (CONFIG.bindAddressSet) server.listen(CONFIG.httpPort, CONFIG.bindAddress, onListening);
else server.listen(CONFIG.httpPort, onListening);

/** One window's lists for the rollup hour ending at hiMs, computed once. */
async function computeDashboard(hours: number, hiMs: number): Promise<DashboardAnswer> {
    const H = 3600_000;
    const hi = new Date(hiMs);
    const lo = new Date(hi.getTime() - hours * H);
    const prevLo = new Date(lo.getTime() - hours * H);
    const t0 = performance.now();
    const [ifs, sens] = await Promise.all([
        OPS.dashboardInterfaces(prevLo, lo, hi, DASHBOARD_TOP_N),
        OPS.dashboardSensors(prevLo, lo, hi, DASHBOARD_TOP_N),
    ]);
    if (!ifs.ok || !sens.ok) {
        return { ok: false, reason: !ifs.ok ? ifs.reason : !sens.ok ? sens.reason : '' };
    }
    const ifRow = (r: (typeof ifs.rows)[number]) => ({
        device: r.device, code: r.code, name: r.name, alias: r.alias,
        speedBps: r.speed_bps === null ? null : Number(r.speed_bps),
        inBytes: bytesFromHourlyBps(r.in_s), outBytes: bytesFromHourlyBps(r.out_s),
        peakInBps: r.pk_in, peakOutBps: r.pk_out,
        errors: countFromHourlyRate(r.err_s), discards: countFromHourlyRate(r.disc_s),
        coverage: coverage(r.cov_h, hours),
        // Per covered hour on each side, and none against a thin
        // previous window (trend() says why).
        trendIn: trend(r.in_s, r.p_in_s, r.cov_h, r.p_cov_h, hours),
        trendOut: trend(r.out_s, r.p_out_s, r.cov_h, r.p_cov_h, hours),
        trendErrs: trend(r.err_s, r.p_err_s, r.cov_h, r.p_cov_h, hours),
        trendDiscards: trend(r.disc_s, r.p_disc_s, r.cov_h, r.p_cov_h, hours),
    });
    const sensRow = (r: (typeof sens.rows)[number]) => ({
        device: r.device, code: r.code, name: r.name,
        meanPct: r.mean_pct, peakPct: r.peak_pct,
        coverage: coverage(r.cov_h, hours),
        trend: trend(r.mean_pct, r.p_mean_pct, null, r.p_cov_h, hours),
    });
    const body = {
        ok: true,
        window: { hours, from: lo.toISOString(), to: hi.toISOString() },
        rx: ifs.rows.filter((r) => r.list === 'rx').map(ifRow),
        tx: ifs.rows.filter((r) => r.list === 'tx').map(ifRow),
        errs: ifs.rows.filter((r) => r.list === 'errs').map(ifRow),
        discards: ifs.rows.filter((r) => r.list === 'disc').map(ifRow),
        cpu: sens.rows.filter((r) => r.list === 'cpu').map(sensRow),
        mem: sens.rows.filter((r) => r.list === 'mem').map(sensRow),
        ms: Math.round(performance.now() - t0),
    };
    return { ok: true, body };
}

/**
 * The answer for a window at this rollup hour: cached, or being computed
 * (join it), or computed now. A refusal is not cached - the next ask tries
 * again.
 */
function dashboardFor(hours: number, hiMs: number): Promise<DashboardAnswer> {
    const cached = dashboardCache.get(hours);
    if (cached !== undefined && cached.hi === hiMs) return Promise.resolve({ ok: true, body: cached.body });
    const key = `${hours}@${hiMs}`;
    const running = dashboardInflight.get(key);
    if (running !== undefined) return running;
    const p = computeDashboard(hours, hiMs)
        .then((r) => { if (r.ok) dashboardCache.set(hours, { hi: hiMs, body: r.body }); return r; })
        .catch((err: unknown): DashboardAnswer => ({ ok: false, reason: (err as Error).message }))
        .finally(() => dashboardInflight.delete(key));
    dashboardInflight.set(key, p);
    return p;
}

/**
 * Compute, one after another, the windows not yet answered for this hour.
 * One at a time on purpose: the heavy lane is four connections shared with
 * charts, searches and reports, and a warm-up is never urgent.
 */
function warmDashboards(hiMs: number): void {
    if (dashboardWarming) return;
    dashboardWarming = true;
    void (async () => {
        for (const w of DASHBOARD_WINDOWS) {
            if (dashboardCache.get(w)?.hi === hiMs) continue;
            const r = await dashboardFor(w, hiMs);
            if (!r.ok) { log(`dashboard warm-up of ${w} h refused (${r.reason}) - it computes on the next visit`); break; }
        }
    })().catch((err: unknown) => log('dashboard warm-up failed:', (err as Error).message))
        .finally(() => { dashboardWarming = false; });
}

// When the rollup moves, the lists move with it: refill them in the
// background while the Dashboard is in use (visited in the last day).
setInterval(() => {
    if (Date.now() - dashboardLastAsked > DASHBOARD_WARM_IDLE_MS) return;
    OPS.rollupFrontier().then((f) => {
        const through = f.ok ? f.rows[0]?.through_ts ?? null : null;
        if (through !== null) warmDashboards(Math.floor(new Date(through).getTime() / 3600_000) * 3600_000);
    }).catch(() => { /* the next minute tries again */ });
}, 60_000).unref();

// First-run bootstrap, then a session prune on a slow timer. Expired sessions
// are already rejected on validation, so this is housekeeping rather than a
// security control, and it runs on the jobs lane.
auth.bootstrapFromEnv().catch((err: unknown) => log('bootstrap failed:', err));
setInterval(() => {
    auth.pruneSessions()
        .then((n) => { if (n > 0) log(`pruned ${n} expired sessions`); })
        .catch((err: unknown) => log('session prune failed:', (err as Error).message));
    const swept = exportJobs.sweep();
    if (swept > 0) log(`swept ${swept} finished exports`);
}, 3600_000).unref();

// --- shutdown ----------------------------------------------------------------

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} received, draining`);

    server.close();

    // Jobs live in memory, so a restart loses them. Cancelling them loudly
    // beats leaving an operator polling an id that will never change again.
    // shutdown() now also stops the export WORKER and resolves on its exit -
    // for the whole life of this process only ingest ever received a stop,
    // and the other three workers' stop handlers were dead code: the
    // collector lost ~1s of fleet samples on every clean shutdown, and the
    // jobs worker's let-the-job-finish wait never ran (2026-09-01 review).
    const exportStopped = exportJobs.shutdown();

    // Give every worker the chance to flush what it has already accepted.
    // Anything accepted is owed a write; that is the invariant, and it applies
    // during shutdown as much as during a burst.
    // TIMESTAMP 1 OF 3, AND WHICH WAY EACH WAIT ENDED.
    //
    // "No stopped line, no drain line, no final stats" has four causes needing
    // four different fixes, and nothing distinguished them: main died before
    // posting, the worker never received, drain hit its deadline, or only the
    // reporting path failed. An intermittent failure that destroys its own
    // diagnosis is the expensive kind of wrong, and two of these logs have
    // already been lost.
    //
    // There is a fifth path visible only from here: if main's wait and a
    // worker's drain deadline were EQUAL, main could give up at the same
    // moment the worker was finishing - and then exit, killing a worker that
    // was still writing. `resolvedBy` is what tells those apart, and every
    // wait below is DERIVED as the worker's own deadline plus the margin,
    // NOT WRITTEN DOWN TWICE. The ingest pair were both once 15,000, which
    // is a race rather than an ordering; see src/config.ts.
    const stopWorker = (name: string, w: Worker, deadlineMs: number): Promise<string> => {
        const waitMs = deadlineMs + CONFIG.shutdownWaitMarginMs;
        return new Promise((resolve) => {
            let resolvedBy = 'pending';
            const done = (how: string): void => {
                if (resolvedBy !== 'pending') return;
                resolvedBy = how;
                log(`SHUTDOWN wait-ended by=${how} (${name})`);
                // Now that main genuinely outwaits each worker, this branch
                // means one thing only: the worker exceeded its own deadline
                // AND the margin on top. Whatever it held is being abandoned
                // by a process exit rather than by its own drain accounting,
                // so it says so at the volume that deserves.
                if (how === 'main-timeout') {
                    log(`ALARM the ${name} worker did not finish within ${waitMs}ms - its own deadline is `
                        + `${deadlineMs}ms, so it overran by more than the ${CONFIG.shutdownWaitMarginMs}ms `
                        + 'margin. Exiting now abandons whatever it still held, and its final stats will not arrive');
                }
                resolve(how);
            };
            w.once('exit', () => done('worker-exit'));
            setTimeout(() => done('main-timeout'), waitMs).unref();
            log(`SHUTDOWN stop-posted to the ${name} worker (waiting ${waitMs}ms, `
                + `its own deadline is ${deadlineMs}ms)`);
            w.postMessage({ type: 'stop' });
        });
    };

    // ALL WORKERS IN PARALLEL, deliberately: they share nothing on the way
    // down but the database, and sequential waits would sum the deadlines -
    // 15s + 15s + 20s plus margins - past systemd's stop timeout, turning a
    // clean drain into a SIGKILL that loses exactly what the drains protect.
    // The total wait is the LONGEST single deadline, not the sum.
    await Promise.all([
        stopWorker('ingest', ingest, CONFIG.ingestDrainDeadlineMs),
        collector !== null
            ? stopWorker('collector', collector, CONFIG.collectorDrainDeadlineMs)
            : Promise.resolve('not-running'),
        jobsWorker !== null
            ? stopWorker('jobs', jobsWorker, CONFIG.jobsStopDeadlineMs)
            : Promise.resolve('not-running'),
        exportStopped,
    ]);

    // Pretty-printed DELIBERATELY, all three: chaos.sh's sigterm scenario
    // parses these blocks with a sed range ending at `^}`, so compacting a
    // final-stats line is the same instrument-breaking format change the
    // 08-31 compact-JSON fix inflicted on the spool greps.
    //
    // Each worker posts 'final', awaits closeAll, then exits from inside
    // the thread - so "the stats variable updated before the exit resolved
    // the wait" is an ORDERING ASSUMPTION about message delivery racing
    // thread exit, not a guarantee (AUDIT-2026-09-01 section 3). Node
    // delivers messages posted before termination in practice, and the
    // sigterm drill asserts the blocks are PRESENT per started worker
    // rather than trusting a clean exit - if final stats ever go missing
    // intermittently, this race is where to look first.
    if (ingestStats) {
        log('final ingest stats:', JSON.stringify(ingestStats, null, 2));
    }
    if (collector !== null && collectorStats) {
        log('final collector stats:', JSON.stringify(collectorStats, null, 2));
    }
    if (jobsWorker !== null && jobsStats) {
        log('final jobs stats:', JSON.stringify(jobsStats, null, 2));
    }
    hb.stop();
    await closeAll();
    log('stopped');
    process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
