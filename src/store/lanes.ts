// The lane table. ARCHITECTURE.md section 1 rule 2, and the admission policy
// settled at the top of BUILD-PLAN.md.
//
// A lane IS its limits. Sizes and both timeouts are declared here and applied
// per connection rather than per query, because a caller that could opt out of
// a lane's timeout would defeat the isolation the lane exists to provide.
//
// Eight lanes are defined. Slice 1 calls three of them (ingest, interactive,
// heavy) plus jobs for maintenance reads. collector, alerts and export are
// declared and uncalled on purpose: the table is the design, and a later slice
// adding a caller should not also be re-litigating the sizing.

export type Lane =
    | 'collector'
    | 'ingest'
    | 'alerts'
    | 'jobs'
    | 'interactive'
    | 'heavy'
    | 'export'
    | 'maintenance';

// What the CALLER should do when a lane will not admit it. The store always
// returns the same structured refusal; this records the intended response so
// the decision lives next to the sizing rather than scattered across handlers.
export type ExhaustionPolicy =
    | 'wait-and-alarm'  // failing to acquire is worse than waiting; if it fires, something is badly wrong
    | 'skip'            // drop this cycle, try the next one
    | 'http-503'        // retriable, the client may come straight back
    | 'report-busy'     // tell the human how many are already running
    | 'queue-job';      // hand back an id, do the work out of band

export interface LaneSpec {
    /** Pool size, and the admission ceiling. */
    readonly max: number;
    /** Bounds EXECUTION. null means no server-side limit. */
    readonly statementTimeoutMs: number | null;
    /**
     * Bounds WAITING. The measurement this whole table turns on: six concurrent
     * heavy queries against four connections produced 20.7s of user-visible
     * latency while every individual query finished inside its 30s limit. The
     * statement timeout never fired, because the query was not slow, the queue
     * was.
     */
    readonly connectionTimeoutMs: number;
    readonly onExhaustion: ExhaustionPolicy;
    readonly why: string;
}

export const LANES: Readonly<Record<Lane, LaneSpec>> = {
    collector: {
        max: 8,
        statementTimeoutMs: 10_000,
        connectionTimeoutMs: 10_000,
        onExhaustion: 'wait-and-alarm',
        why: 'Reserved write capacity that web traffic can never consume. A generous wait, because failing to acquire is worse than waiting here.',
    },
    ingest: {
        max: 4,
        statementTimeoutMs: 10_000,
        connectionTimeoutMs: 10_000,
        onExhaustion: 'wait-and-alarm',
        why: 'Never drop a datagram. Blocking briefly is survivable, refusing to write is not.',
    },
    alerts: {
        max: 2,
        statementTimeoutMs: 15_000,
        connectionTimeoutMs: 5_000,
        onExhaustion: 'skip',
        why: 'A skipped scan costs one cycle of latency on an alert. Tolerates blocking by design.',
    },
    jobs: {
        max: 2,
        statementTimeoutMs: null,
        connectionTimeoutMs: 30_000,
        onExhaustion: 'skip',
        why: 'Long, rare, blocking. Retention is never urgent, so it gives up and retries later rather than queueing the application behind itself.',
    },
    interactive: {
        max: 16,
        statementTimeoutMs: 2_000,
        connectionTimeoutMs: 500,
        onExhaustion: 'http-503',
        why: 'Bounded queries only, which is what makes them interactive. A short wait ceiling because a dashboard that is queueing is already broken.',
    },
    heavy: {
        max: 4,
        statementTimeoutMs: 30_000,
        connectionTimeoutMs: 2_000,
        onExhaustion: 'report-busy',
        why: 'Four simultaneous 90-day charts is a bad afternoon, not an outage, and the collector keeps its slots throughout. Two seconds because a human will wait two seconds and will not wait twenty.',
    },
    export: {
        max: 2,
        statementTimeoutMs: null,
        connectionTimeoutMs: 1_000,
        onExhaustion: 'queue-job',
        why: 'A 400,000 row CSV is minutes. In the heavy lane one export would hold a quarter of capacity for its whole duration, so exports get their own lane and become jobs with ids.',
    },
    maintenance: {
        max: 1,
        statementTimeoutMs: null,
        connectionTimeoutMs: 30_000,
        onExhaustion: 'skip',
        why: 'DDL that must run in a session as an owning role: CREATE/DROP INDEX CONCURRENTLY cannot run inside a function, and a hardened app role owns no index. One connection, the admin credential (pool.ts maintenanceConnectionString), the jobs thread only - the one thread that never touches network input.',
    },
} as const;

export const ALL_LANES = Object.keys(LANES) as Lane[];
