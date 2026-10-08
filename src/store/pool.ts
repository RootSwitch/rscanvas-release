// Per-lane pools, admission control, and the timing split.
//
// Two things here are load bearing.
//
// 1. ADMISSION IS OURS, NOT THE DRIVER'S. `pg` already bounds the wait with
//    connectionTimeoutMillis, but its rejection is an Error whose only
//    distinguishing feature is the message string "timeout exceeded when
//    trying to connect", and it cannot say how many queries are already
//    running. BUILD-PLAN requires a structured {busy, lane, inFlight,
//    capacity} so the UI can say "4 searches are already running", because a
//    bare connection timeout is indistinguishable from the database being
//    down and teaches the operator nothing. So a semaphore sized to the pool
//    gates entry, and pg's own timeout stays configured underneath as a
//    backstop for genuine connection failures.
//
// 2. WAITING AND EXECUTION ARE MEASURED SEPARATELY. The 20.7 second finding
//    was visible only because the spike's timed() happened to wrap both. That
//    conflation is now deliberate the other way: a lane whose wait time is not
//    measured will hide exactly this failure again.

import pg from 'pg';
import { CONFIG } from '../config.ts';
import { LANES, ALL_LANES, type Lane, type ExhaustionPolicy } from './lanes.ts';

export interface Timing {
    /** admitMs + connectMs. What the caller actually waited before work began. */
    waitMs: number;
    /** Time blocked on the lane's admission semaphore. */
    admitMs: number;
    /** Time establishing or checking out the physical connection. */
    connectMs: number;
    /** Time the statement itself ran. */
    execMs: number;
}

export type Refused =
    | {
        ok: false;
        reason: 'busy';
        lane: Lane;
        inFlight: number;
        capacity: number;
        policy: ExhaustionPolicy;
        waitMs: number;
    }
    | {
        ok: false;
        reason: 'statement-timeout';
        lane: Lane;
        limitMs: number;
        timing: Timing;
    };

export type Outcome<T> =
    | { ok: true; lane: Lane; rows: T[]; rowCount: number; timing: Timing }
    | Refused;

// --- admission semaphore -----------------------------------------------------

interface Waiter {
    resolve: (admitted: boolean) => void;
    timer: NodeJS.Timeout;
}

class Admission {
    capacity: number;
    inFlight = 0;
    waiters: Waiter[] = [];

    constructor(capacity: number) {
        this.capacity = capacity;
    }

    /** Resolves true if admitted, false if the wait ceiling elapsed first. */
    acquire(timeoutMs: number): Promise<boolean> {
        if (this.inFlight < this.capacity) {
            this.inFlight++;
            return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
            const waiter: Waiter = {
                resolve,
                timer: setTimeout(() => {
                    const i = this.waiters.indexOf(waiter);
                    if (i >= 0) this.waiters.splice(i, 1);
                    resolve(false);
                }, timeoutMs),
            };
            // Never hold the process open on a queued waiter.
            waiter.timer.unref();
            this.waiters.push(waiter);
        });
    }

    release(): void {
        const next = this.waiters.shift();
        if (next) {
            // Hand the slot straight over rather than decrementing and racing.
            clearTimeout(next.timer);
            next.resolve(true);
            return;
        }
        this.inFlight--;
    }
}

// --- rolling per-lane statistics --------------------------------------------
// A bounded ring rather than every sample: a run is minutes long and the
// interesting figures are the tail, not the history.

const RING = 2048;

class LaneStats {
    waits = new Float64Array(RING);
    execs = new Float64Array(RING);
    n = 0;
    admitted = 0;
    busy = 0;
    timedOut = 0;
    failed = 0;
    worstWaitMs = 0;
    worstExecMs = 0;

    record(waitMs: number, execMs: number): void {
        const i = this.n % RING;
        this.waits[i] = waitMs;
        this.execs[i] = execMs;
        this.n++;
        if (waitMs > this.worstWaitMs) this.worstWaitMs = waitMs;
        if (execMs > this.worstExecMs) this.worstExecMs = execMs;
    }

    private pct(arr: Float64Array, p: number): number {
        const len = Math.min(this.n, RING);
        if (len === 0) return 0;
        const copy = Array.from(arr.subarray(0, len)).sort((a, b) => a - b);
        const idx = Math.min(len - 1, Math.max(0, Math.ceil((p / 100) * len) - 1));
        return Number((copy[idx] as number).toFixed(1));
    }

    snapshot() {
        return {
            samples: this.n,
            admitted: this.admitted,
            busy: this.busy,
            statementTimeouts: this.timedOut,
            failed: this.failed,
            waitP50Ms: this.pct(this.waits, 50),
            waitP99Ms: this.pct(this.waits, 99),
            waitMaxMs: Number(this.worstWaitMs.toFixed(1)),
            execP50Ms: this.pct(this.execs, 50),
            execP99Ms: this.pct(this.execs, 99),
            execMaxMs: Number(this.worstExecMs.toFixed(1)),
        };
    }
}

// --- lane runtime ------------------------------------------------------------

interface LaneRuntime {
    pool: pg.Pool;
    admission: Admission;
    stats: LaneStats;
}

const runtimes = new Map<Lane, LaneRuntime>();

/**
 * The maintenance lane's connection string: the app's URL with the admin
 * role's credential in place of the app's. An empty password means "no
 * maintenance credential on this box" and the app credential is used as-is,
 * which is correct on an unhardened database (the app role owns everything)
 * and loudly wrong on a hardened one (every index DDL fails by name - see
 * config.ts adminDbPassword). Exported for the unit test; a URL that does
 * not parse throws rather than yielding a half-substituted string, because
 * a credential that silently did not apply is the failure mode this lane
 * exists to remove.
 */
export function maintenanceConnectionString(base: string, role: string, password: string): string {
    if (password === '') return base;
    const u = new URL(base);
    if (u.host === '') throw new Error('DATABASE_URL has no host - cannot derive the maintenance connection');
    u.username = role;
    u.password = password;
    return u.toString();
}

/**
 * "localhost" in the URL is connected to as 127.0.0.1 (2026-10-06). A name
 * costs a getaddrinfo per new connection, on libuv's threadpool - which
 * runs at most two lookups at once in the whole process (half of its four
 * threads), shared with the service checks' lookups of outside names. In
 * the operator's second real outage those hung on a blocked DNS server, and
 * the lanes' connects queued behind them until they timed out (0.5 to 30 s)
 * - 93 times in 20 minutes, read by the poller as devices going down. An
 * address needs no lookup. The installer writes localhost, and every
 * distribution's pg_hba admits 127.0.0.1 wherever it admits localhost; any
 * other host is left alone. Exported for the unit test.
 */
export function connectByAddress(url: string): string {
    let u: URL;
    try { u = new URL(url); } catch { return url; } // pg says what is wrong with it
    if (u.hostname.toLowerCase() !== 'localhost') return url;
    u.hostname = '127.0.0.1';
    return u.toString();
}

function runtime(lane: Lane): LaneRuntime {
    const existing = runtimes.get(lane);
    if (existing) return existing;

    const spec = LANES[lane];
    const pool = new pg.Pool({
        connectionString: connectByAddress(lane === 'maintenance'
            ? maintenanceConnectionString(CONFIG.databaseUrl, CONFIG.adminDbRole, CONFIG.adminDbPassword)
            : CONFIG.databaseUrl),
        max: spec.max,
        application_name: `rscanvas:${lane}`,
        // A backstop only. Admission above keeps in-flight at or below max, so
        // reaching this means connection ESTABLISHMENT is failing, which is a
        // different problem from the lane being full and should look different.
        connectionTimeoutMillis: spec.connectionTimeoutMs,
        // Applied per connection rather than per query. A lane is its timeout.
        //
        // TimeZone=UTC is pinned on every connection, and it closes a whole
        // class rather than one bug. The code was consistent only by luck of
        // configuration:
        //
        //   * Partition bounds are created from DATE LITERALS. For a
        //     timestamptz column, '2026-07-27' resolves to midnight in the
        //     CREATING SESSION's zone - so partitions created by sessions with
        //     different zones produce OVERLAPPING bounds (the CREATE fails and
        //     the day's partition never appears) or GAPPED bounds (a COPY for a
        //     row in the gap fails). Both feed straight into the discard path.
        //   * Retention's cutoff is current_date - keep_days, local midnight,
        //     so "keep 14 days" is 13 to 15 depending on where the job connects
        //     from.
        //   * date_trunc('hour', ts) truncates in session-local time. In a
        //     fractional-offset zone (IST +5:30, Nepal +5:45) buckets land on
        //     :30 or :45 UTC boundaries, and two runs under different settings
        //     write MISALIGNED keys for the same hours - double-counted history
        //     that the weighted mean then averages plausibly.
        //
        // One option, and the class disappears. The rollup and retention
        // functions also SET LOCAL TimeZone = 'UTC' themselves, because a
        // function invoked from psql by an operator does not come through this
        // pool.
        //
        // ALLOW_FIXTURE_DROPS travels the same way, as a session GUC, so that
        // fixture-guard layer 3 can live INSIDE drop_partitions_guarded. The
        // alternative - a parameter the caller passes - puts the interlock back
        // in the caller, and the caller is exactly what was careful last time
        // and still lost 158GB. An environment variable reaches the function
        // without any code being able to route around it.
        options: [
            '-c TimeZone=UTC',
            process.env.ALLOW_FIXTURE_DROPS === '1' ? '-c rscanvas.allow_fixture_drops=1' : null,
            spec.statementTimeoutMs === null ? null : `-c statement_timeout=${spec.statementTimeoutMs}`,
            // Per lane, and lanes.ts says which and why: /api/alerts spent
            // 730 of its 760 ms JIT-compiling at 30k alerts' worth of rows.
            spec.jit === false ? '-c jit=off' : null,
        ].filter(Boolean).join(' '),
    });
    pool.on('error', (err) => {
        console.error(`[store] idle client error on lane ${lane}: ${err.message}`);
    });

    const rt: LaneRuntime = {
        pool,
        admission: new Admission(spec.max),
        stats: new LaneStats(),
    };
    runtimes.set(lane, rt);
    return rt;
}

/** Postgres query_canceled, which is what statement_timeout raises. */
const QUERY_CANCELED = '57014';

function isStatementTimeout(err: unknown): boolean {
    return typeof err === 'object' && err !== null
        && (err as { code?: string }).code === QUERY_CANCELED;
}

/**
 * Run work on a lane with a connection, measuring wait and execution apart.
 *
 * Unexpected errors are rethrown rather than folded into the result. Only the
 * two outcomes the design has a policy for - the lane was full, or the
 * statement exceeded the lane's limit - come back as structured refusals. A
 * syntax error or a dead database is not a lane condition and must fail loud.
 */
export async function onLane<T>(
    lane: Lane,
    work: (client: pg.PoolClient) => Promise<{ rows: T[]; rowCount: number }>,
): Promise<Outcome<T>> {
    const spec = LANES[lane];
    const rt = runtime(lane);

    const tAdmit = performance.now();
    const admitted = await rt.admission.acquire(spec.connectionTimeoutMs);
    const admitMs = performance.now() - tAdmit;

    if (!admitted) {
        rt.stats.busy++;
        return {
            ok: false,
            reason: 'busy',
            lane,
            inFlight: rt.admission.inFlight,
            capacity: spec.max,
            policy: spec.onExhaustion,
            waitMs: Number(admitMs.toFixed(1)),
        };
    }

    let client: pg.PoolClient | null = null;

    // A CHECKED-OUT CLIENT WITH NO 'error' LISTENER KILLS THE PROCESS.
    //
    // `pool.on('error')` above covers clients sitting IDLE in the pool. It does
    // not cover one that is checked out and working, and pg emits asynchronous
    // connection failures on the client itself - so with no listener, Node's
    // EventEmitter turns an 'error' event into a THROWN exception with no
    // application frames on the stack. In a worker thread that surfaces as
    // `worker.on('error')` in main, which treats a dead ingest worker as fatal
    // and exits.
    //
    // MEASURED, not theorised. Stopping Postgres under a 2,000-6,000/s burst
    // with a COPY in flight produced exactly that:
    //
    //   [main] FATAL ingest worker error: error: terminating connection due to
    //          administrator command                              (SQLSTATE 57P01)
    //
    // and the process exited with ~22,000 accepted rows still queued. That is
    // the never-drop invariant lost to an unhandled event, and it is finding
    // 5's class on the one path finding 5's fix does not reach: the safety net
    // catches unhandledRejection deliberately and does NOT catch uncaught
    // exceptions, because those normally mean state nobody reasoned about.
    // This one is a known transient with a correct response - fail the query,
    // discard the connection, let the caller requeue - so it is handled where
    // it originates rather than by widening that net.
    let clientError: Error | null = null;
    const onClientError = (err: Error): void => {
        clientError = err;
        rt.stats.failed++;
        console.error(`[store] lane ${lane} client error while checked out: ${err.message} `
            + '- the connection is being discarded and the caller will see the query fail');
    };

    try {
        const tConnect = performance.now();
        client = await rt.pool.connect();
        client.on('error', onClientError);
        const connectMs = performance.now() - tConnect;

        const tExec = performance.now();
        try {
            const res = await work(client);
            const execMs = performance.now() - tExec;
            const timing: Timing = {
                waitMs: Number((admitMs + connectMs).toFixed(1)),
                admitMs: Number(admitMs.toFixed(1)),
                connectMs: Number(connectMs.toFixed(1)),
                execMs: Number(execMs.toFixed(1)),
            };
            rt.stats.admitted++;
            rt.stats.record(timing.waitMs, timing.execMs);
            return { ok: true, lane, rows: res.rows, rowCount: res.rowCount, timing };
        } catch (err) {
            const execMs = performance.now() - tExec;
            if (isStatementTimeout(err) && spec.statementTimeoutMs !== null) {
                rt.stats.timedOut++;
                rt.stats.record(admitMs + connectMs, execMs);
                return {
                    ok: false,
                    reason: 'statement-timeout',
                    lane,
                    limitMs: spec.statementTimeoutMs,
                    timing: {
                        waitMs: Number((admitMs + connectMs).toFixed(1)),
                        admitMs: Number(admitMs.toFixed(1)),
                        connectMs: Number(connectMs.toFixed(1)),
                        execMs: Number(execMs.toFixed(1)),
                    },
                };
            }
            rt.stats.failed++;
            throw err;
        }
    } catch (err) {
        // The connect's own failures land here too - the one the outage
        // produced, pg-pool's "Connection terminated due to connection
        // timeout", comes from rt.pool.connect() above, not from work().
        tagStoreFailure(err, lane);
        throw err;
    } finally {
        if (client) {
            client.removeListener('error', onClientError);
            // Released WITH the error when there was one, which tells the pool
            // to destroy the connection rather than return a broken socket to
            // the lane for the next caller to trip over.
            client.release(clientError ?? undefined);
        }
        rt.admission.release();
    }
}

/*
 * A FAILURE OF THE STORE, NAMED AS ONE (2026-10-06). Anything thrown out of
 * a lane - a connect that timed out, a refused or dropped connection, a
 * statement the server rejected - is tagged with the lane before it leaves,
 * so a caller can tell "our database failed" from its own failure without
 * matching message strings, and the error keeps its class and code for the
 * callers that branch on them. The poller is the reason: a poll that
 * reached the device and then could not write was recorded as the DEVICE
 * failing, and the lab's second real outage turned 93 refused connects into
 * about a hundred device-down alerts.
 */
const STORE_FAILURE_TAG = 'rscanvasStoreLane';

function tagStoreFailure(err: unknown, lane: Lane): void {
    if (err === null || typeof err !== 'object' || !Object.isExtensible(err) || STORE_FAILURE_TAG in err) return;
    Object.defineProperty(err, STORE_FAILURE_TAG, { value: lane, enumerable: false });
}

/** The lane a thrown error came out of, or null when it is not the store's. */
export function storeFailureLane(err: unknown): Lane | null {
    if (err === null || typeof err !== 'object' || !(STORE_FAILURE_TAG in err)) return null;
    return (err as Record<string, Lane>)[STORE_FAILURE_TAG] ?? null;
}

/** A structured refusal turned into a thrown, tagged error - for a caller
 *  that cannot go on without the rows (`what` names the operation). */
export function storeRefusal(what: string, r: Refused): Error {
    const e = new Error(`${what} refused (${r.reason})`);
    tagStoreFailure(e, r.lane);
    return e;
}

/** The common case: one parameterised statement on a lane. */
export function laneQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
    lane: Lane, text: string, values: unknown[] = [],
): Promise<Outcome<T>> {
    return onLane<T>(lane, async (client) => {
        const res = await client.query<T>(text, values);
        return { rows: res.rows, rowCount: res.rowCount ?? res.rows.length };
    });
}

export function laneState(lane: Lane) {
    const rt = runtimes.get(lane);
    const spec = LANES[lane];
    return {
        lane,
        capacity: spec.max,
        inFlight: rt ? rt.admission.inFlight : 0,
        queued: rt ? rt.admission.waiters.length : 0,
        statementTimeoutMs: spec.statementTimeoutMs,
        connectionTimeoutMs: spec.connectionTimeoutMs,
        onExhaustion: spec.onExhaustion,
        ...(rt ? rt.stats.snapshot() : new LaneStats().snapshot()),
    };
}

export function allLaneStates() {
    return ALL_LANES.map(laneState);
}

export async function closeAll(): Promise<void> {
    await Promise.all([...runtimes.values()].map((rt) => rt.pool.end()));
    runtimes.clear();
}
