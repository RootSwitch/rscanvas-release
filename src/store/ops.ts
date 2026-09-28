// The named operations. ARCHITECTURE.md rule 1: no SQL outside this module,
// and every query is a named operation that declares its lane.
//
// Named rather than composed at the call site, which is the whole point of the
// rule. A handler has no way to obtain a connection except by naming one of
// these, which is what makes the lanes real rather than documented. It is also
// the insurance against the engine choice: reading what the application asks
// the database for is a matter of reading this list.
//
// Where a query needs optional filters, the SQL is still built HERE, from an
// allowlisted typed filter object with bound parameters. The caller passes
// intent, never fragments of SQL.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import copyFrom from 'pg-copy-streams';
import { CONFIG } from '../config.ts';
import { laneQuery, onLane, type Outcome } from './pool.ts';
import { copyChunks, copyLine, stripNul } from './copy.ts';
import type { Clause } from '../search/grammar.ts';

/**
 * A read on the interactive lane, returned untyped.
 *
 * Used by the two shapes compared in slice 4e, where what is being measured is
 * the plan and the timing rather than the columns. Kept as a helper so both
 * sides of that comparison go through exactly the same path and the difference
 * is the query and nothing else.
 */
const timedInteractive = (
    text: string, values: unknown[],
): Promise<Outcome<Record<string, unknown>>> =>
    laneQuery<Record<string, unknown>>('interactive', text, values);

// --- ingest ------------------------------------------------------------------

export interface MessageRow {
    /** Receive time. The partition key, and always ours rather than the device's. */
    ts: Date;
    /** The device's own claimed timestamp, which may be absent, wrong, or a lie. */
    msgTs: Date | null;
    sourceIp: string | null;
    facility: number | null;
    severity: number | null;
    host: string | null;
    app: string | null;
    /** RFC 5424 PROCID / 3164 tag[pid], its own column - never folded into app. */
    procid: string | null;
    proto: string;
    msg: string;
    raw: string;
}

const MESSAGE_COLUMNS = [
    'ts', 'msg_ts', 'source_ip', 'facility', 'severity', 'host', 'app', 'procid', 'proto', 'msg', 'raw',
];

export interface CopyResult {
    outcome: Outcome<never>;
    /** Counted rather than silently absorbed, so a device sending NULs is visible. */
    nulsStripped: number;
}

/**
 * Bulk insert on the ingest lane. Rows are generated into the stream in
 * bounded chunks (copyChunks) rather than joined into one string, so a 2,000
 * row flush never materialises as a single large buffer - and rather than one
 * row per chunk, which cost two socket writes per message.
 */
export async function copyMessages(rows: MessageRow[]): Promise<CopyResult> {
    let nulsStripped = 0;

    const outcome = await onLane<never>('ingest', async (client) => {
        const sink = client.query(
            copyFrom.from(`COPY messages (${MESSAGE_COLUMNS.join(', ')}) FROM STDIN`),
        );
        const source = Readable.from(copyChunks(rows, (r) => {
            const msg = stripNul(r.msg);
            const raw = stripNul(r.raw);
            const host = r.host === null ? null : stripNul(r.host);
            const app = r.app === null ? null : stripNul(r.app);
            const procid = r.procid === null ? null : stripNul(r.procid);
            nulsStripped += msg.stripped + raw.stripped
                + (host?.stripped ?? 0) + (app?.stripped ?? 0) + (procid?.stripped ?? 0);
            return copyLine([
                r.ts.toISOString(),
                r.msgTs === null ? null : r.msgTs.toISOString(),
                r.sourceIp,
                r.facility,
                r.severity,
                host === null ? null : host.text,
                app === null ? null : app.text,
                procid === null ? null : procid.text,
                r.proto,
                msg.text,
                raw.text,
            ]);
        }));

        await pipeline(source, sink);
        return { rows: [] as never[], rowCount: rows.length };
    });

    return { outcome, nulsStripped };
}

// --- samples -------------------------------------------------------------------

export interface SampleRow {
    entityId: string;
    ts: Date;
    status: number | null;
    /**
     * Per-poll response time. ARCHITECTURE.md lists this among the one-way
     * doors: it cannot be backfilled, and slow agents are the measured cause of
     * throughput loss (a fleet whose slowest agent took 1000ms lost 61% of
     * throughput with CPU flat). If it is not written on the poll, it does not
     * exist.
     */
    rttMs: number | null;
    /** in_bps, out_bps, in_err/s, out_err/s, in_disc/s, out_disc/s. Rates stay fractional. */
    v: Array<number | null>;
}

const SAMPLE_COLUMNS = ['entity_id', 'ts', 'status', 'rtt_ms', 'v0', 'v1', 'v2', 'v3', 'v4', 'v5'];

/**
 * Bulk sample insert on the collector lane.
 *
 * COPY rather than INSERT for the same reason ingest uses it: the collector
 * writes every entity together each cycle, which at the ceiling is about 1,000
 * rows per second, and per-row round trips would spend the lane's whole budget
 * on protocol.
 */
export async function copySamples(rows: SampleRow[]): Promise<Outcome<never>> {
    return onLane<never>('collector', async (client) => {
        const sink = client.query(
            copyFrom.from(`COPY samples (${SAMPLE_COLUMNS.join(', ')}) FROM STDIN`),
        );
        // In chunks, not a row at a time: see COPY_CHUNK_CHARS for the stall
        // the per-row form put on the collector thread at 30k entities.
        const source = Readable.from(copyChunks(rows, (r) => copyLine([
            r.entityId,
            r.ts.toISOString(),
            r.status,
            r.rttMs,
            ...r.v,
        ])));
        await pipeline(source, sink);
        return { rows: [] as never[], rowCount: rows.length };
    });
}

// --- export ------------------------------------------------------------------

export interface ExportProbeResult {
    outcome: Outcome<never>;
    rows: number;
    bytes: number;
    firstByteMs: number;
    /** How long the export lane connection was held, start to release. */
    heldMs: number;
}

/**
 * Stream a filtered result set out on the export lane, counting rather than
 * keeping it. A measurement probe for the export worst case, not slice 3's
 * product export: there is no CSV formula guard here and no job id.
 *
 * A SERVER-SIDE CURSOR, fetched in batches, for two reasons.
 *
 * The first is forced: `COPY (SELECT ...) TO STDOUT` does not accept bind
 * parameters, and the alternative - interpolating an operator's own host and
 * fragment into SQL text - is not one worth measuring.
 *
 * The second is that it is the right thing anyway. Slice 3 has to touch every
 * field to apply the OWASP formula guard, so the product export cannot be a
 * single COPY regardless. A cursor is what it will be, which makes this the
 * realistic figure rather than an optimistic floor.
 *
 * Note what is NOT bounded. The export lane has no statement timeout, by
 * design, because a legitimate export is genuinely long. The store's filter
 * rules bound the WINDOW but never the ROW COUNT, and a device filter is only
 * required when a fragment is present. So "every message in the last 14 days"
 * is a permitted export, and its size is whatever the window holds.
 */
export async function exportProbe(
    f: SearchFilters, sink: NodeJS.WritableStream, batchSize = 5_000,
): Promise<ExportProbeResult | SearchRefusal> {
    const coverage = await trgmCoverage('export');
    if (!Array.isArray(coverage)) return coverage;
    const built = buildWhere(f, coverage);
    if ('ok' in built) return built;

    let rows = 0;
    let bytes = 0;
    let firstByteMs = 0;
    const t0 = performance.now();

    const outcome = await onLane<never>('export', async (client) => {
        // No LIMIT: rule 3 says every query carries a LIMIT or streams a
        // cursor, and this is the streaming half.
        await client.query('BEGIN');
        try {
            await client.query(
                `DECLARE export_probe NO SCROLL CURSOR FOR
                 SELECT id, ts, msg_ts, source_ip, facility, severity, host, app, proto, msg
                   FROM messages
                  WHERE ${built.conditions.join('\n                    AND ')}
                  ORDER BY ts DESC`,
                built.values,
            );

            // WRITE-IN-LOOP-OK: a cursor FETCH is the streaming read this
            // lane exists for - one round trip per batch of rows, which is
            // the opposite of the per-item shape, and the alternative is
            // materialising the whole result set (rule 3 forbids it).
            for (;;) {
                // WRITE-IN-LOOP-OK: cursor FETCH, one round trip per BATCH of rows -
                // the opposite of per-item, and rule 3 forbids materialising instead.
                const batch = await client.query(`FETCH FORWARD ${batchSize} FROM export_probe`);
                if (batch.rows.length === 0) break;
                if (firstByteMs === 0) firstByteMs = performance.now() - t0;

                // Serialise as the real export would, so the per-row cost is in
                // the measurement rather than skipped by counting rows.
                let chunk = '';
                for (const r of batch.rows) {
                    chunk += Object.values(r).map((v) => (v === null ? '' : String(v))).join(',') + '\n';
                }
                bytes += Buffer.byteLength(chunk);
                rows += batch.rows.length;

                if (!sink.write(chunk)) {
                    await new Promise<void>((resolve) => sink.once('drain', () => resolve()));
                }
                if (batch.rows.length < batchSize) break;
            }

            await client.query('CLOSE export_probe');
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        return { rows: [] as never[], rowCount: rows };
    });

    return { outcome, rows, bytes, firstByteMs, heldMs: performance.now() - t0 };
}

export interface StreamExportResult {
    outcome: Outcome<never>;
    rows: number;
    bytes: number;
    cancelled: boolean;
    heldMs: number;
}

/**
 * The product export: a filtered result set, CSV-encoded, streamed out on the
 * export lane.
 *
 * A server-side cursor fetched in batches. `COPY (SELECT ...) TO STDOUT` would
 * be faster but takes no bind parameters, and the alternative - interpolating
 * an operator's host and fragment into SQL text - is not one worth having. It
 * would also not help: every field has to be touched anyway for the formula
 * guard, so the encoding is per-row regardless.
 *
 * `shouldCancel` is checked between batches rather than mid-batch, so
 * cancellation is bounded by one fetch (5,000 rows) rather than being instant.
 * That is what makes it possible to release the connection promptly: the cursor
 * is closed and the transaction ended on the way out, in the same `finally`
 * that a normal completion uses.
 */
export async function streamExportCsv(
    f: SearchFilters,
    sink: NodeJS.WritableStream,
    encodeRow: (row: Record<string, unknown>) => string,
    header: string,
    shouldCancel: () => boolean,
    batchSize = 5_000,
): Promise<StreamExportResult | SearchRefusal> {
    const coverage = await trgmCoverage('export');
    if (!Array.isArray(coverage)) return coverage;
    const built = buildWhere(f, coverage);
    if ('ok' in built) return built;

    let rows = 0;
    let bytes = 0;
    let cancelled = false;
    const t0 = performance.now();

    const write = async (chunk: string): Promise<void> => {
        bytes += Buffer.byteLength(chunk);
        if (!sink.write(chunk)) {
            // Waits for 'drain' OR 'error'. A stream that has failed never
            // emits 'drain', so waiting only for that turns a swallowed write
            // error into a permanent stall holding one of only two export
            // connections - the lane is then half gone until the process ends.
            await new Promise<void>((resolve, reject) => {
                const onDrain = (): void => { sink.off('error', onError); resolve(); };
                const onError = (err: Error): void => { sink.off('drain', onDrain); reject(err); };
                sink.once('drain', onDrain);
                sink.once('error', onError);
            });
        }
    };

    const outcome = await onLane<never>('export', async (client) => {
        await client.query('BEGIN');
        try {
            await client.query(
                `DECLARE export_cursor NO SCROLL CURSOR FOR
                 SELECT id, ts, msg_ts, source_ip, proto, facility, severity, host, app, procid, msg, raw
                   FROM messages
                  WHERE ${built.conditions.join('\n                    AND ')}
                  ORDER BY ts DESC`,
                built.values,
            );

            await write(header);

            // WRITE-IN-LOOP-OK: same streaming cursor FETCH as above, per
            // BATCH rather than per row.
            for (;;) {
                if (shouldCancel()) { cancelled = true; break; }
                // WRITE-IN-LOOP-OK: cursor FETCH, one round trip per BATCH of rows.
                const batch = await client.query(`FETCH FORWARD ${batchSize} FROM export_cursor`);
                if (batch.rows.length === 0) break;

                let chunk = '';
                for (const r of batch.rows) chunk += encodeRow(r as Record<string, unknown>);
                await write(chunk);
                rows += batch.rows.length;

                if (batch.rows.length < batchSize) break;
            }

            await client.query('CLOSE export_cursor');
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        }
        return { rows: [] as never[], rowCount: rows };
    });

    return { outcome, rows, bytes, cancelled, heldMs: performance.now() - t0 };
}

// --- search ------------------------------------------------------------------

export interface SearchFilters {
    /** Inclusive lower bound. Mandatory: it drives partition pruning. */
    from: Date;
    /** Exclusive upper bound. Mandatory. */
    to: Date;
    host?: string;
    /** An address or CIDR, matched against the indexed inet column. */
    sourceIp?: string;
    app?: string;
    facility?: number;
    /** Match this severity or anything more urgent (numerically lower). */
    severityAtMost?: number;
    /** The free-text fragment. Applied LAST, to whatever survived. */
    fragment?: string;
    /**
     * The grammar's parsed clauses (src/search/grammar.ts). ANDed with the
     * structured fields above, which stay for callers that already build
     * filters directly - the export path, the tests, the collector's own
     * views. A query string reaches here as clauses, never as text.
     */
    clauses?: Clause[];
    limit?: number;
}

export type SearchRefusal = {
    ok: false;
    reason: 'window-required' | 'window-too-wide' | 'window-inverted'
        | 'unindexed-free-text' | 'window-excludes-dates' | 'unindexed-substring'
        | 'coverage-unavailable'
        // ITS OWN REASON, deliberately not folded into 'unindexed-free-text'.
        // That one means "an index is missing"; this one means "the cost is
        // unpredictable even with every index present", and they call for
        // different operator actions and different fixes. One counter for two
        // rules is the mistake ADMITTED-BUT-SHOULD-REFUSE already made.
        | 'free-text-window';
    detail: string;
};

/**
 * THE TRIGRAM COVERAGE FACT, read from pg_index rather than derived from a
 * date window.
 *
 * Admission originally decided "the window is trigram-indexed" by arithmetic:
 * f.from within TRGM_RECENT_DAYS of now. That is a statement of INTENT about
 * what the sync job should have built, not a fact about the catalog, and the
 * two disagreed for six hours on 2026-07-28: a fresh deployment's first sync
 * ran at boot+6h, and until it did, admission admitted free text into a
 * growing partition whose host trigram index did not exist - the soak's
 * search ramped 1.1s -> 2.3s and put a 25-point CPU ramp on the host graph.
 * The date window also cannot see a CONCURRENTLY build that failed and left
 * an INVALID index, a sync job failing repeatedly, or TRGM_RECENT_DAYS being
 * raised before the sync catches up. One fact, not a fact and a proxy.
 *
 * A partition is covered when a VALID, READY gin index exists on msg AND on
 * host - by indexed COLUMN, not by index name. Until 2026-09-24 msg's index
 * arrived two ways (a partitioned GIN on the parent gave every partition an
 * auto child, beside the sync's own); the parent index is gone now
 * (slice53-retention.sql), so both columns arrive only via the sync - but a
 * database that has not yet applied slice 53 still carries the inherited
 * one, and checking by column keeps admission right on either. Queried per
 * search on the same lane the search runs on: a ~15-row catalog join, and a
 * cache would be another proxy with its own drift.
 */
export interface TrgmCoverageDay { day: string; covered: boolean }

const TRGM_COVERAGE_SQL = `
    SELECT right(c.relname, 8) AS day,
           (SELECT count(DISTINCT a.attname)
              FROM pg_index x
              JOIN pg_class ic ON ic.oid = x.indexrelid
              JOIN pg_am am ON am.oid = ic.relam AND am.amname = 'gin'
              JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = ANY (x.indkey)
             WHERE x.indrelid = c.oid AND x.indisvalid AND x.indisready
               AND a.attname IN ('msg', 'host')) = 2 AS covered
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'messages'::regclass
       AND c.relname ~ '^messages_[0-9]{8}$'`;

const trgmCoverage = async (
    lane: 'heavy' | 'export',
): Promise<TrgmCoverageDay[] | SearchRefusal> => {
    const r = await laneQuery<TrgmCoverageDay>(lane, TRGM_COVERAGE_SQL);
    if (!r.ok) {
        // FAIL CLOSED. Admitting an unverifiable free-text search is how the
        // 3,355ms scan comes back wearing an error message as a disguise.
        return {
            ok: false,
            reason: 'coverage-unavailable',
            detail: `cannot verify which partitions are trigram-indexed (${r.reason}) - retry`,
        };
    }
    return r.rows;
};

export interface MessageHit {
    id: string;
    ts: Date;
    msg_ts: Date | null;
    source_ip: string | null;
    facility: number | null;
    severity: number | null;
    host: string | null;
    app: string | null;
    procid: string | null;
    proto: string | null;
    msg: string;
}

/**
 * Validate a filter set against the rules ARCHITECTURE.md section 3b derives
 * from measurement, and build the bound WHERE clause.
 *
 * These are not UI preferences. Free-text with no device filter outside the
 * trigram window is the query measured to breach the heavy lane's own 30s
 * timeout, so it is refused HERE rather than in a handler: a rule the UI is
 * merely asked to respect is a rule that gets routed around.
 */
export function buildWhere(
    f: SearchFilters, coverage: TrgmCoverageDay[],
): SearchRefusal | { conditions: string[]; values: unknown[] } {
    if (!(f.from instanceof Date) || !(f.to instanceof Date)
        || Number.isNaN(f.from.getTime()) || Number.isNaN(f.to.getTime())) {
        return { ok: false, reason: 'window-required', detail: 'a from and to timestamp are both required' };
    }
    if (f.to.getTime() <= f.from.getTime()) {
        return { ok: false, reason: 'window-inverted', detail: 'to must be later than from' };
    }

    // --- after:/before: INTERSECT the window, never widen it -----------------
    //
    // The parent had no window at all, so its dates were the whole filter.
    // Here the window is mandatory and capped, and a typed date that could
    // WIDEN it would be a way to route around the ceiling from the search box.
    // So they tighten only: from = max(from, after), to = min(to, before).
    //
    // An empty intersection REFUSES AND NAMES THE WINDOW, because "empty
    // range" reads as "your data is gone" - the same responsibility as the
    // zero-result guidance, and the same reason: an operator needs to be told
    // what happened and what to change, not left to infer it.
    let from = f.from;
    let to = f.to;
    for (const c of f.clauses ?? []) {
        if (c.negate) continue;   // a negated date bound is not a bound
        if (c.kind === 'after' && c.ts.getTime() > from.getTime()) from = c.ts;
        if (c.kind === 'before' && c.ts.getTime() < to.getTime()) to = c.ts;
    }
    if (to.getTime() <= from.getTime()) {
        const fmt = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 16);
        return {
            ok: false,
            reason: 'window-excludes-dates',
            detail: `the after:/before: dates leave no time to search: they narrow `
                + `${fmt(f.from)} to ${fmt(f.to)} down to nothing. Searches are capped at `
                + `${CONFIG.maxSearchWindowHours / 24} days, and typed dates can only narrow `
                + `that window - widen the search window itself, or move the dates inside it`,
        };
    }
    f = { ...f, from, to };

    const spanHours = (f.to.getTime() - f.from.getTime()) / 3_600_000;
    if (spanHours > CONFIG.maxSearchWindowHours) {
        return {
            ok: false,
            reason: 'window-too-wide',
            detail: `window is ${spanHours.toFixed(1)}h, ceiling is ${CONFIG.maxSearchWindowHours}h`,
        };
    }

    // --- ADMISSION: THE RULE FOLLOWS THE INDEX, NOT THE OPERATOR ------------
    //
    // Stated as two separate rules on purpose, because they LOOK like one and
    // are not, and whoever adds the next operator has to be able to see which
    // one it falls under. What decides is which index serves the predicate:
    //
    //   msg, host        TRIGRAM INDEXED, on recent partitions only
    //                    (sync_recent_trgm_indexes, TRGM_RECENT_DAYS). So free
    //                    text and host~ are indexed INSIDE the window and
    //                    unindexed outside it -> device filter required only
    //                    outside.
    //   app              INDEXED NOWHERE for substring. The free-text decision
    //                    was explicitly "not app or source_ip", so no app
    //                    trigram index was ever built. app~ inside the window
    //                    has nothing to run on either - it is a sequential
    //                    scan over partitions taking 11GB/day at the ceiling
    //                    -> device filter required ALWAYS.
    //
    // A DEVICE FILTER is host= or ip containment: btree and inet lookups that
    // are indexed on EVERY partition, so they bound the scan before the
    // substring predicate runs. host~ and app~ are substring-class and can
    // never qualify - narrowing by a scan is not narrowing.
    //
    // NEGATION CUTS ONE WAY ONLY, and the distinction matters twice:
    //
    //   * a negated predicate NEVER QUALIFIES as a device filter. -host:x
    //     widens the result set rather than bounding it.
    //   * but a negated substring STILL REQUIRES one. `NOT ILIKE` cannot use
    //     a trigram index at all, so `-app~bgp` alone is a sequential scan
    //     exactly as `app~bgp` is - MORE certainly, since the positive form
    //     can at least use the index where one exists.
    //
    // The first version of this checked `!c.negate` on both sides, which let
    // a bare `-error` or `-app~x` through as if negation made it cheap. The
    // asymmetry is the whole rule: negation earns nothing and excuses
    // nothing.
    // ip: COUNTS AS A DEVICE FILTER ONLY AT /24 OR LONGER (/64 for IPv6).
    //
    // The indexability half of this was VERIFIED WITH EXPLAIN on the corpus
    // (2026-07-28, PostgreSQL 18.4) after a review claimed <<= could not use
    // the btree at any prefix - and the verification overturned the claim:
    // since PostgreSQL 14, planner support functions derive a btree range
    // from <<= automatically. The corpus plan shows
    //
    //   Index Cond: ((source_ip >= '10.20.1.0/24') AND (source_ip <= '10.20.1.255'))
    //   Filter: (source_ip <<= '10.20.1.0/24')
    //
    // 443,591 rows in 23ms warm via parallel index-only scan. The review's
    // suggested rewrite (>= network() AND <= broadcast()) was ALSO checked
    // and is subtly broken: broadcast() keeps the netmask, and inet ordering
    // sorts a /32 host AFTER a /24-masked value, so the range form matched
    // ZERO rows at /8, /16 and /24 where containment matched a million. Row
    // agreement, not the plan shape, is what caught it. <<= stays.
    //
    // What survives the verification is the SELECTIVITY half: the index
    // serves every prefix, but a short prefix does not NARROW. Measured on
    // the corpus (1,426,492 rows): /32 matches 0.14%, /24 31%, /16 and /8
    // both 73% - indistinguishable from no filter on a single-site network,
    // which the design target (one shop, one address plan) will be. So a
    // prefix shorter than the floor still FILTERS, but does not qualify as
    // the device filter that admits unindexed free text: admitting the
    // 3,355ms scan because "a filter is present" that excludes almost
    // nothing would be the admission rule in name only.
    const IP_FLOOR_V4 = 24;
    const IP_FLOOR_V6 = 64;   // one standard subnet; unmeasured (no v6 corpus), by analogy
    const ipQualifies = (cidr: string): boolean => {
        if (!cidr.includes('/')) return true;   // a bare host address is the narrowest filter there is
        const bits = Number(cidr.slice(cidr.indexOf('/') + 1));
        return cidr.includes(':') ? bits >= IP_FLOOR_V6 : bits >= IP_FLOOR_V4;
    };
    const clauses = f.clauses ?? [];
    // The structured sourceIp field gets the same floor as the ip: clause -
    // it accepts a CIDR too, and a rule one entry path can route around is
    // not a rule.
    const hasDeviceFilter = f.host !== undefined
        || (f.sourceIp !== undefined && ipQualifies(f.sourceIp))
        || clauses.some((c) => !c.negate
            && ((c.kind === 'host' && c.op === 'exact')
                || (c.kind === 'ip' && ipQualifies(c.cidr))));
    // "Inside the trigram window" is now a CATALOG FACT, not date arithmetic:
    // every existing partition the window touches must carry a valid gin
    // index on BOTH msg and host (free text is `msg ILIKE OR host ILIKE`, a
    // BitmapOr that needs both branches - the 2026-07-28 six-hour ramp was
    // the HOST branch missing while the msg one existed). Days with no
    // partition at all cannot hold rows, so they cannot make a scan
    // expensive and do not count against coverage. TRGM_RECENT_DAYS remains
    // the SYNC's build policy; admission no longer reads it, so the two
    // cannot drift - see TRGM_COVERAGE_SQL for the failure modes the date
    // arithmetic could not see.
    const coveredByDay = new Map(coverage.map((r) => [r.day, r.covered]));
    const uncoveredDays: string[] = [];
    {
        const d = new Date(Date.UTC(
            f.from.getUTCFullYear(), f.from.getUTCMonth(), f.from.getUTCDate()));
        while (d.getTime() < f.to.getTime()) {
            const key = d.toISOString().slice(0, 10).replace(/-/g, '');
            if (coveredByDay.get(key) === false) uncoveredDays.push(key);
            d.setUTCDate(d.getUTCDate() + 1);
        }
    }
    const insideTrgmWindow = uncoveredDays.length === 0;

    const wantsTrigram = (f.fragment !== undefined && f.fragment !== '')
        || clauses.some((c) => c.kind === 'text' || (c.kind === 'host' && c.op === 'substring'));

    // THE COST RULE, CHECKED BEFORE THE INDEX RULE, because it is the more
    // fundamental of the two and does not depend on the catalog at all.
    //
    // Coverage answers "is a trigram index present". This answers "can the
    // cost be bounded", and on 2026-08-15 those came apart in the worst
    // direction: minipc had COMPLETE coverage, which is precisely what
    // admitted a query that then ran for thirty seconds, ten times a minute,
    // for eleven hours. A present index is not a used index - see the plan and
    // the four-way isolation in SOAK-CRITERIA 5b, and CONFIG.freeTextMaxHours
    // for why the number is a policy rather than a calibration.
    //
    // Ordered first so a wide free-text search is refused on a rule that needs
    // no query to evaluate. That matters beyond tidiness: the coverage probe
    // runs on the SAME heavy lane this query saturates, so the old ordering
    // made a lane under pressure spend more of itself deciding whether to add
    // to that pressure.
    if (wantsTrigram && !hasDeviceFilter && spanHours > CONFIG.freeTextMaxHours) {
        return {
            ok: false,
            reason: 'free-text-window',
            detail: `free text and host~ without a device filter are capped at `
                + `${CONFIG.freeTextMaxHours}h and this window is ${spanHours.toFixed(1)}h. `
                + 'Postgres has no selectivity statistics for substrings, so past that width '
                + 'the planner stops using the trigram indexes and scans by time instead - '
                + 'fast for a common word, unbounded for a rare one, and it cannot tell which '
                + 'you typed. Narrow the window, or add host:<exact name> or ip:<address, or a '
                + 'CIDR of /24 or longer> to bound the scan and lift the cap',
        };
    }

    if (wantsTrigram && !hasDeviceFilter && !insideTrgmWindow) {
        return {
            ok: false,
            reason: 'unindexed-free-text',
            detail: `free text and host~ need a trigram index on every day they touch, and `
                + `${uncoveredDays.length} day(s) in this window have none `
                + `(${uncoveredDays.slice(0, 3).join(', ')}${uncoveredDays.length > 3 ? ', ...' : ''}; `
                + `the sync keeps the last ${CONFIG.trgmRecentDays} days indexed); narrow the `
                + 'window to indexed days, or add host:<exact name> or ip:<address, or a CIDR '
                + 'of /24 or longer - a shorter prefix excludes too little to bound the scan>',
        };
    }

    const wantsAppSubstring = clauses.some((c) => c.kind === 'app' && c.op === 'substring');
    if (wantsAppSubstring && !hasDeviceFilter) {
        return {
            ok: false,
            reason: 'unindexed-substring',
            detail: 'app~ has no index on any partition, inside the trigram window or out, '
                + 'so it always needs a device filter: add host:<exact name> or '
                + 'ip:<address, or a CIDR of /24 or longer>, or use the exact app: form',
        };
    }

    const conditions: string[] = [];
    const values: unknown[] = [];
    const bind = (v: unknown): string => {
        values.push(v);
        return `$${values.length}`;
    };

    // 1. The window, always first. This is the optimisation, not a UI nicety.
    conditions.push(`ts >= ${bind(f.from)}`);
    conditions.push(`ts < ${bind(f.to)}`);

    // 2. Structured filters, all indexed. Btree lookups, nearly free.
    if (f.host !== undefined) conditions.push(`host = ${bind(f.host)}`);
    if (f.sourceIp !== undefined) conditions.push(`source_ip <<= ${bind(f.sourceIp)}::inet`);
    if (f.app !== undefined) conditions.push(`app = ${bind(f.app)}`);
    if (f.facility !== undefined) conditions.push(`facility = ${bind(f.facility)}`);
    if (f.severityAtMost !== undefined) conditions.push(`severity <= ${bind(f.severityAtMost)}`);

    // 3. The fragment last, against whatever survived. Once the device and the
    // window have run there are a few hundred rows left and matching is free.
    //
    // ESCAPED, because section 3b promises "a very good bounded grep" and a
    // grep matches literals. Unescaped it was not one:
    //
    //   * `%` and `_` are LIKE wildcards. Searching for "100%" matched any
    //     message containing "100"; "user_1" matched "userA1". The wrong count
    //     also fed countMessages, which is load bearing for export admission
    //     and the confirmation threshold - so a mistyped search could push an
    //     export over the confirm limit, or under it.
    //   * A fragment ending in a backslash - an operator pasting "C:\" - raised
    //     "LIKE pattern must not end with escape character". That is not
    //     SQLSTATE 57014, so it threw rather than becoming a structured
    //     refusal, and the route's catch-all returned a bare 500 "internal
    //     error": indistinguishable from the database being down, which is the
    //     exact outcome the structured-refusal design exists to prevent.
    //
    // Backslash first, or the escapes introduced after it get escaped again.
    //
    // ILIKE, NOT LIKE, AND THE ENGINE IS THE WHOLE REASON.
    //
    // SQLite's LIKE is CASE-INSENSITIVE for ASCII by default. Postgres's LIKE
    // is case-SENSITIVE; ILIKE is the insensitive one. So the parent's
    // `msg LIKE ?` and a literal port of it to Postgres are the same code with
    // different behaviour, and nothing on either side would notice, because
    // each is internally consistent.
    //
    // MEASURED, both engines, 2026-07-27, same four rows:
    //
    //   SQLite   LIKE  '%error%'  -> "Error: disk full", "error: disk full"
    //   Postgres LIKE  '%error%'  -> "error: disk full"          ONE row
    //   Postgres ILIKE '%error%'  -> "Error: disk full", "error: disk full"
    //
    // A user searching "error" who stopped seeing lines containing "Error"
    // would experience that as the search being broken, and would be right.
    // This is the SECOND confirmed instance of the port silently changing
    // behaviour - the first was the LIKE escaping below, and it was found the
    // same way, by comparing against the parent rather than by reading.
    //
    // The trigram index still serves it: `EXPLAIN` on the corpus shows
    // `Bitmap Index Scan on messages_..._msg_trgm` with
    // `Index Cond: (msg ~~* '%timeout%')` - `~~*` is ILIKE - at 1.78ms. So
    // this costs nothing, which is worth stating because the obvious worry is
    // that it would fall back to a sequential scan.
    if (f.fragment !== undefined && f.fragment !== '') {
        const literal = f.fragment
            .replace(/\\/g, '\\\\')
            .replace(/%/g, '\\%')
            .replace(/_/g, '\\_');
        // msg OR host. RESTORED 2026-07-27 after the port dropped it.
        //
        // SyslogCanvas's free text searched msg OR host OR app OR source_ip, so
        // typing a hostname into the search box found that host's messages. The
        // fork searched msg only and typing a hostname found NOTHING - the same
        // shape as the LIKE/ILIKE defect, a user-visible capability that
        // vanished silently across the port.
        //
        // MEASURED before restoring, because "hostnames repeat heavily" is a
        // guess about cost, not a measurement. On messages_20260726 (1,426,492
        // rows, 601 distinct hosts): the host trigram index is 19MB against the
        // msg index's 129MB - 14.8% - and built in 2.1s.
        //
        // And the OR does not defeat them, which was the real risk. It plans as
        // a BitmapOr over BOTH index scans, 21.8ms warm, no sequential scan.
        //
        // NOT app or source_ip. Typing a raw IP or an app name into free text is
        // rare, both already have structured filters, and `source_ip <<= inet`
        // does real subnet containment where the parent's free-text branch did a
        // substring match - so pulling it in would reintroduce weaker behaviour.
        // The parent searching all four reads more like nobody drew a line than
        // a decision that was made.
        const p = bind(literal);
        conditions.push(`(msg ILIKE '%' || ${p} || '%' OR host ILIKE '%' || ${p} || '%')`);
    }

    // --- 4. the grammar's clauses -------------------------------------------
    //
    // Same escaping as the fragment above, applied to every substring form,
    // for the same reason: the promise is a bounded GREP, and a grep matches
    // literals.
    //
    // NEGATION IS NULL-SAFE, straight from the parent and worth keeping for
    // its stated reason: `-app:cron` must keep rows with no app at all (traps,
    // unparsed lines). A bare NOT drops them, because NULL is not TRUE - but
    // NOT NULL is not TRUE either. Postgres spells the parent's
    // `NOT COALESCE(x, 0)` as `NOT COALESCE(x, false)`.
    const escapeLike = (v: string): string => v
        .replace(/\\/g, '\\\\')
        .replace(/%/g, '\\%')
        .replace(/_/g, '\\_');
    const push = (sql: string, negate: boolean): void => {
        conditions.push(negate ? `NOT COALESCE(${sql}, false)` : sql);
    };

    for (const c of f.clauses ?? []) {
        switch (c.kind) {
            case 'text': {
                const p = bind(escapeLike(c.value));
                push(`(msg ILIKE '%' || ${p} || '%' OR host ILIKE '%' || ${p} || '%')`, c.negate);
                break;
            }
            case 'host':
                if (c.op === 'exact') push(`host = ${bind(c.value)}`, c.negate);
                else push(`host ILIKE '%' || ${bind(escapeLike(c.value))} || '%'`, c.negate);
                break;
            case 'app':
                if (c.op === 'exact') push(`app = ${bind(c.value)}`, c.negate);
                else push(`app ILIKE '%' || ${bind(escapeLike(c.value))} || '%'`, c.negate);
                break;
            case 'procid':
                push(`procid = ${bind(c.value)}`, c.negate);
                break;
            case 'ip':
                push(`source_ip <<= ${bind(c.cidr)}::inet`, c.negate);
                break;
            case 'severity':
                push(`severity ${c.op} ${bind(c.value)}`, c.negate);
                break;
            case 'facility':
                push(`facility ${c.op} ${bind(c.value)}`, c.negate);
                break;
            case 'proto':
                push(`proto = ${bind(c.value)}`, c.negate);
                break;
            case 'after':
            case 'before':
                // Already folded into the window above, which is strictly
                // stronger: it prunes partitions rather than filtering rows.
                break;
        }
    }

    // --- TWO FURTHER DIFFERENCES FROM THE PARENT, DELIBERATE AND NAMED -------
    //
    // Both are behavioural changes, so under the merge's own rule they have to
    // be stated rather than left for someone to discover by diffing.
    //
    // 1. FREE TEXT SEARCHES `msg` ONLY. The parent searches
    //    `msg OR host OR app OR source_ip`. Kept narrow here because the
    //    trigram index exists on `msg` alone: widening the OR would make three
    //    of the four branches unindexed and turn the bounded grep this section
    //    promises back into the 3,355ms scan it was designed to prevent. The
    //    fork offers `host`, `app` and `sourceIp` as their own filters, which
    //    the parent's single search box could not express.
    //
    // 2. STRUCTURED FILTERS ARE EXACT, NOT SUBSTRING. The parent does
    //    `host LIKE '%x%'`; this does `host = $1`. And `source_ip <<= $1::inet`
    //    is subnet containment rather than the parent's string prefix match, so
    //    "10.0.0" no longer also matches "110.0.0.7". Both are indexed btree or
    //    inet operations rather than scans.
    //
    // Neither is reversible by accident: changing them changes the search
    // envelope the done-when criteria are measured against.

    return { conditions, values };
}

/**
 * The glance-grid tile field registry (slice 26). One list, two consumers:
 * the /grid route validates declarations against it, and the projection's
 * VALUES table below must carry exactly these keys - a key here without a
 * SQL expression is a checkbox that silently shows nothing.
 *
 * `identity: true` marks fields that NAME things (addresses, interface and
 * filesystem names, hardware strings) rather than measuring them - the
 * screenshot-safe split the operator asked for by practice: their real
 * board is shareable precisely because it carries values without identities.
 * The flag is served to the admin UI so the checkboxes can say which is
 * which; the exposure decision itself is simply whether the key is in the
 * board's list.
 */
export const GRID_FIELDS: ReadonlyArray<{ key: string; label: string; identity: boolean }> = [
    // VALUE FIELDS FIRST, in roughly the order an operator reaches for them.
    // The registry order is also the render order down a tile, so this list
    // is a layout decision as much as a vocabulary.
    { key: 'cpu', label: 'CPU %', identity: false },
    { key: 'mem', label: 'memory %', identity: false },
    { key: 'top', label: 'top interface usage', identity: false },
    { key: 'fs', label: 'fullest filesystem %', identity: false },
    { key: 'temp', label: 'temperature', identity: false },
    { key: 'errs', label: 'interface errors/s', identity: false },
    { key: 'uptime', label: 'uptime', identity: false },
    { key: 'ping', label: 'ping rtt', identity: false },
    { key: 'snmp', label: 'SNMP rtt', identity: false },
    { key: 'batt', label: 'battery %', identity: false },
    { key: 'runtime', label: 'battery runtime', identity: false },
    // IDENTITY FIELDS LAST, grouped so the split the panel labels is visible
    // in the list itself rather than only in the tags.
    // Slice 32: the icon is identity, and the call is deliberate - it names
    // what a thing IS ("that one is the firewall"), which is exactly the
    // kind of fact a screenshot-safe board may want to withhold even while
    // showing every number.
    { key: 'stencil', label: 'device type icon', identity: true },
    { key: 'address', label: 'IP address', identity: true },
    { key: 'hardware', label: 'hardware / CPU model', identity: true },
    { key: 'topif', label: 'top interface NAME', identity: true },
    { key: 'fsname', label: 'filesystem NAME', identity: true },
];

/**
 * What a board gets the first time somebody switches its grid on (slice 34).
 *
 * Two rules decide this list and both are refusals rather than preferences:
 *
 *   * NO IDENTITY FIELDS. A board that has never been configured must not
 *     start out publishing addresses, interface names or hardware strings -
 *     the same posture as show_addresses defaulting false. Ticking one is a
 *     decision somebody makes, never one they inherit.
 *   * NOTHING WIDE. `hardware` is the longest value any tile can hold - "AMD
 *     Ryzen 9 9950X3D 16-Core Processor" beside "2%" - and one wide field
 *     sets the width of every column on the wall. The operator watched it
 *     happen at sixteen fields and asked for it out of the default; it is
 *     one tick away for the boards that want it.
 */
export const GRID_DEFAULT_FIELDS: readonly string[] = ['cpu', 'mem', 'top', 'uptime'];

/**
 * ONE definition of what a device's status IS (slice 35), as a fragment so
 * the three readers cannot drift - the same discipline ALERT_IN_MAINTENANCE
 * established after the maintenance predicate was nearly written twice.
 *
 * Two populations, one expression:
 *
 *   * A device WITH an agent keeps the slice-9 merge: ICMP-down wins over
 *     SNMP-up, because ping notices in seconds what a 30s poll notices in a
 *     minute, and SNMP-down stands even when ping answers, because a host
 *     that pings while its agent is dead is monitored in name only.
 *   * A PING-ONLY device has no agent to disagree with, so reach IS the
 *     status. 'unknown' passes through rather than being flattened to up -
 *     never-probed is not up, which is the same one-way door the roster's
 *     pending state exists for.
 */
/**
 * THE UI PAGE CAP (2026-08-31, independent review C1).
 *
 * `uiOpenAlerts` and `uiDevices` carried no LIMIT while the docstring on
 * `uiRecentCleared`, two lines below one of them, states rule 3: every query
 * carries a LIMIT. Both run on the INTERACTIVE lane with its 2s statement
 * timeout, and the open alert set is largest exactly when an incident is
 * largest - so the alerts page was most likely to time out at the moment it
 * existed for.
 *
 * `RENDER_CAP = 100` in app.js does not help and was never meant to: it caps
 * the DOM, after the server has selected, sorted, serialised and transmitted
 * every row. The three costs it leaves untouched - the lane, the main thread
 * and the wire - are the ones that fail first.
 *
 * FIVE THOUSAND IS A SAFETY VALVE, NOT PAGING, and the size is the argument.
 * At the 1,550-device lab it never engages, so nothing about today changes.
 * At the 30k ceiling it holds the payload near 3 MB instead of 19 MB and the
 * page still renders. It is deliberately far above any set a human reads,
 * because the client filters and sorts IN THE BROWSER: a tight cap would mean
 * the filter box could not find a device outside the first N, which is a
 * functional regression wearing a performance fix's clothes. Keyset paging is
 * still owed (section 13) and is what would let this come down.
 *
 * The caller asks for the TRUE TOTAL only when the cap was hit, so the normal
 * case costs nothing extra and the truncated case can say so honestly.
 */
export const UI_PAGE_CAP = 5000;

export const deviceStatusSql = (a: string): string => `
    CASE WHEN NOT ${a}.snmp_enabled
              THEN CASE ${a}.reach_state
                       WHEN 'down' THEN 'down'
                       WHEN 'unknown' THEN 'unknown'
                       ELSE 'up' END
         -- NEVER CONTACTED reads as 'pending', not 'down' (the Force Add
         -- slice, 2026-09-01): down is a verdict about a device we have
         -- seen, and a forced row awaiting first contact has only ever been
         -- a promise. last_seen_ts is written by the first successful poll
         -- - and, since the same slice, at probe-add time, because the
         -- probe seeing the device is a sighting - so this arm is exact:
         -- one contact ever, by either instrument, and it never fires
         -- again. Before the reach arm on purpose: a forced host that
         -- pings before its agent wakes is still pending ITS instrument.
         --
         -- WITH A HORIZON (ruling 10, from the afternoon audit's finding
         -- 10): a promise has an expiry. Past PENDING_CONTACT_H since the
         -- row was added, a never-seen device falls through to the arms
         -- below and reads 'down' like any other silent host - so a forced
         -- host with the wrong community pages ONCE, on schedule, instead
         -- of wearing a pending pill for as long as the row exists.
         WHEN ${a}.last_seen_ts IS NULL
              AND ${a}.added_ts > now() - make_interval(hours => ${Math.max(1, Math.floor(CONFIG.pendingContactH))})
              THEN 'pending'
         WHEN ${a}.reach_state = 'down' THEN 'down'
         ELSE ${a}.status END`;

export const OPS = {
    /**
     * Bounded syslog search, on the heavy lane. The realistic investigation:
     * one device, one window, one fragment.
     */
    searchMessages: async (f: SearchFilters): Promise<Outcome<MessageHit> | SearchRefusal> => {
        const coverage = await trgmCoverage('heavy');
        if (!Array.isArray(coverage)) return coverage;
        const built = buildWhere(f, coverage);
        if ('ok' in built) return built;

        const limit = Math.min(
            Math.max(1, Math.floor(f.limit ?? CONFIG.defaultSearchLimit)),
            CONFIG.maxSearchLimit,
        );
        const values = [...built.values, limit];
        return laneQuery<MessageHit>('heavy', `
            SELECT id::text AS id, ts, msg_ts, source_ip::text AS source_ip,
                   facility, severity, host, app, procid, proto, msg
              FROM messages
             WHERE ${built.conditions.join('\n               AND ')}
             ORDER BY ts DESC
             LIMIT $${values.length}`, values);
    },

    /**
     * Count before fetch, so the operator learns the result is 400,000 rows
     * BEFORE waiting for them. Same lane and same filters as the search.
     */
    countMessages: async (f: SearchFilters): Promise<Outcome<{ n: string }> | SearchRefusal> => {
        const coverage = await trgmCoverage('heavy');
        if (!Array.isArray(coverage)) return coverage;
        const built = buildWhere(f, coverage);
        if ('ok' in built) return built;
        return laneQuery<{ n: string }>('heavy', `
            SELECT count(*)::text AS n
              FROM messages
             WHERE ${built.conditions.join('\n               AND ')}`, built.values);
    },

    // --- run verification ----------------------------------------------------
    //
    // Every generated datagram carries "<run tag> seq=<n>". These two turn the
    // done-when criterion "zero dropped datagrams" from a claim about counters
    // into arithmetic against the stored rows.
    //
    // This matters because there are three separate places a datagram can be
    // lost and each has its own counter that is blind to the other two: the
    // sender's socket, the receiver's kernel buffer, and our own queue
    // shedding. All three can read zero while datagrams are missing. Counting
    // what is actually in the table is the only measurement that spans them.

    countRunTag: (tag: string, from: Date, to: Date) =>
        laneQuery<{ n: string; distinct_seq: string; min_seq: string | null; max_seq: string | null }>('heavy', `
            SELECT count(*)::text AS n,
                   count(DISTINCT substring(msg from 'seq=([0-9]+)'))::text AS distinct_seq,
                   min(substring(msg from 'seq=([0-9]+)')::bigint)::text AS min_seq,
                   max(substring(msg from 'seq=([0-9]+)')::bigint)::text AS max_seq
              FROM messages
             WHERE ts >= $2 AND ts < $3
               AND msg LIKE '%' || $1 || '%'`, [tag, from, to]),

    /**
     * The sequence numbers that never arrived, named rather than counted.
     *
     * generate_series over the expected range, left joined against what landed.
     * Capped, because a run that lost a hundred thousand datagrams has already
     * failed and does not need every one of them listed.
     */
    missingSequences: (tag: string, from: Date, to: Date, maxSeq: number, limit = 50) =>
        laneQuery<{ seq: string }>('heavy', `
            WITH expected AS (SELECT generate_series(0, $4::bigint) AS seq),
                 got AS (
                     SELECT DISTINCT substring(msg from 'seq=([0-9]+)')::bigint AS seq
                       FROM messages
                      WHERE ts >= $2 AND ts < $3
                        AND msg LIKE '%' || $1 || '%'
                 )
            SELECT e.seq::text AS seq
              FROM expected e
              LEFT JOIN got g ON g.seq = e.seq
             WHERE g.seq IS NULL
             ORDER BY e.seq
             LIMIT $5`, [tag, from, to, maxSeq, limit]),

    /** Did the deliberately unparseable datagrams land whole? */
    runTagUnparseable: (tag: string, from: Date, to: Date, limit = 5) =>
        laneQuery<{ raw: string; msg: string; host: string | null; app: string | null; facility: number | null; severity: number | null }>('heavy', `
            SELECT raw, msg, host, app, facility, severity
              FROM messages
             WHERE ts >= $2 AND ts < $3
               AND msg LIKE '%' || $1 || '%'
               AND msg LIKE '%GARBAGE%'
             ORDER BY ts DESC
             LIMIT $4`, [tag, from, to, limit]),

    /** Proto breakdown for a run, so trap and syslog rows can be told apart. */
    runTagByProto: (tag: string, from: Date, to: Date) =>
        laneQuery<{ proto: string | null; n: string }>('heavy', `
            SELECT proto, count(*)::text AS n
              FROM messages
             WHERE ts >= $2 AND ts < $3
               AND msg LIKE '%' || $1 || '%'
             GROUP BY proto
             ORDER BY proto`, [tag, from, to]),

    // --- collector -------------------------------------------------------------
    //
    // On the COLLECTOR lane, which has reserved write capacity that web traffic
    // can never consume. The poll loop is latency sensitive: a stall stretches
    // the interval silently, and a stretched interval is invisible in the data
    // because the samples still look regular.

    /**
     * Devices due for a poll IN ONE LANE, with the counters the scheduler
     * needs.
     *
     * SCOPED TO A LANE, AND THAT IS THE WHOLE FIX (slice 47). This used to be
     * one query for both populations, `ORDER BY last_poll_ts LIMIT free * 2`,
     * with the caller skipping any down device that could not get a slot. The
     * ordering made that fatal: down devices are retired only as fast as the
     * down lane allows, so they are permanently the most overdue rows in the
     * table and permanently the head of the ordering. Skipping one consumed a
     * candidate and freed nothing, there was no refetch, and the live fleet
     * was never reached. Measured at 30k with 78 of 1,550 dead: 44 of 48
     * candidates were dead devices while 1,048 live devices sat due, and
     * throughput fell 77% with 20 of 24 slots idle.
     *
     * SNMPCanvas's poller documents the same hazard above its own loop -
     * "walk the WHOLE due list rather than the first free of it: a run of
     * down devices at the head must be skipped past, not allowed to consume
     * the pass" - and gets away with an unbounded in-memory walk because
     * SQLite lookups cost ~2us. Over Postgres that shape would be 25-100x
     * worse, so the answer is not to copy it: keep the bounded query and give
     * each lane its own, so neither can eat the other's candidates.
     *
     * `busy` EXCLUDES WHAT IS ALREADY IN FLIGHT, which retires the `free * 2`
     * oversample. That factor existed to leave room for candidates the caller
     * would drop as already-polling; naming them in the query instead makes
     * the limit mean exactly what it says, and removes a second way for a
     * candidate list to fill with rows that cannot be dispatched.
     */
    duePollTargets: (
        limit: number, lane: 'live' | 'down', downAfter: number, busy: string[],
    ) => laneQuery<{
        id: string; name: string; host: string; snmp_port: number; snmp_version: string;
        credential_ref: string; poll_interval_s: number; consecutive_failures: number;
        last_poll_ts: Date | null;
        /** Last ATTEMPT at the slow-changing inventory read; null = never. */
        inventory_ts: Date | null;
    }>('collector', `
        -- host(), NOT host::text. Casting an inet to text keeps the netmask,
        -- so a device stored as 127.0.0.1 comes back "127.0.0.1/32" and every
        -- SNMP session fails instantly against a target that is not an
        -- address. host() returns just the address.
        SELECT id::text AS id, name, host(host) AS host, snmp_port, snmp_version,
               credential_ref, poll_interval_s, consecutive_failures, last_poll_ts,
               -- One more column on a row already being read, so the caller
               -- can decide whether the inventory refresh is due.
               inventory_ts
          FROM devices
         WHERE enabled = true
           -- Slice 35: a ping-only device has no agent, so polling it buys
           -- two five-second timeouts and a false down. Excluded here rather
           -- than skipped in the worker, so it never occupies a poll slot at
           -- all - the scheduler's whole cost model is slots.
           AND snmp_enabled = true
           -- The lane. The operator is composed from a two-value union in
           -- TypeScript, never from input - the same posture as the
           -- deviceStatusSql fragment above.
           AND consecutive_failures ${lane === 'down' ? '>=' : '<'} $2
           -- Already being polled. Their last_poll_ts still reads old, so
           -- without this they come back due on every tick and occupy
           -- candidate slots that cannot be used.
           AND NOT (id = ANY($3::bigint[]))
           AND (last_poll_ts IS NULL
                OR last_poll_ts <= now() - (poll_interval_s || ' seconds')::interval)
         ORDER BY last_poll_ts NULLS FIRST
         LIMIT $1`, [limit, downAfter, busy]),

    /**
     * Register a device, idempotently.
     *
     * ON CONFLICT (name), not (id). The id target could never fire - it is
     * sequence-assigned and never supplied, so the conflict was unreachable and
     * the operation's name promised an idempotency it did not have. Two
     * concurrent registrations produced duplicate devices with the same name,
     * both polled, minting codes twice for the same logical interface.
     *
     * DO UPDATE rather than DO NOTHING so the returning clause always yields a
     * row, and so re-registering a moved device corrects its address rather
     * than silently keeping the old one.
     *
     * FIXTURE-ONLY, and the product add path must never adopt it (ruling 5,
     * DECISIONS-2026-09-01): DO UPDATE on a name conflict MOVES the
     * incumbent - a second host claiming an existing sysName would silently
     * retarget the first device's identity, history and codes at the new
     * address, which is the HIJACK variant of the collision the add path now
     * refuses by name. Its three callers are seed-fleet, test-scan and
     * test-ui, all of which own the names they register. If that ever stops
     * being true, this operation needs the incumbent-naming shape its
     * product siblings have, not a new caller.
     */
    upsertDevice: (
        name: string, host: string, port: number, version: string, credentialRef: string, intervalS: number,
    ) => laneQuery<{ id: string }>('collector', `
        INSERT INTO devices (name, host, status, snmp_port, snmp_version, credential_ref, poll_interval_s)
        VALUES ($1, $2::inet, 'unknown', $3, $4, $5, $6)
        ON CONFLICT (name) DO UPDATE
           SET host = excluded.host,
               snmp_port = excluded.snmp_port,
               snmp_version = excluded.snmp_version,
               credential_ref = excluded.credential_ref,
               poll_interval_s = excluded.poll_interval_s
        RETURNING id::text AS id`, [name, host, port, version, credentialRef, intervalS]),

    findDeviceByName: (name: string) => laneQuery<{ id: string; name: string }>('collector',
        'SELECT id::text AS id, name FROM devices WHERE name = $1', [name]),

    /** After a poll: system scalars, liveness, and the failure counter. */
    /**
     * One write per poll, and the identity columns ride along FREE.
     *
     * Worth stating because it looks like waste and is not: this row has to be
     * rewritten every poll regardless - last_poll_ts, status and
     * consecutive_failures all genuinely change - so a tuple version is
     * created either way. Adding sys_name, sys_descr and sys_location to the
     * same UPDATE costs nothing on top. Splitting them into a conditional
     * write would ADD a statement to save nothing.
     *
     * The inventory columns are different and are handled here too: the
     * TIMESTAMP is stamped whenever the collector ATTEMPTED the read, while
     * the value is only overwritten when the agent actually answered. That
     * asymmetry is what stops an agent with no HOST-RESOURCES subtree - most
     * switches, and the lab's own mock fleet - from being permanently stale
     * and re-asked on every poll of every device forever.
     */
    recordDevicePoll: (
        id: string, ok: boolean, sysName: string | null, sysDescr: string | null,
        sysLocation: string | null, inventoryTried: boolean, cpuModel: string | null,
        // How late this poll STARTED against when it was due, in ms; null on
        // the first poll ever, which has no due time. Same statement, one more
        // column - the collector already knew this number and threw it away.
        pollLagMs: number | null = null,
        // The roster summary (slice 20), one JSON argument rather than
        // fifteen positional ones; null on a failed poll leaves the last
        // written values in place, and the roster blanks them by status.
        summary: import('../collector/summary.ts').DeviceSummary | null = null,
        // Slice 21. Uptime is a reading, written as read on a successful
        // poll; cores and RAM are inventory facts that survive a miss.
        uptimeS: number | null = null, cpuCores: number | null = null, ramKb: number | null = null,
        // Slice 26: the whole-conversation SNMP wall time for this poll.
        snmpRttMs: number | null = null,
        // Slice 32: the device-type guess from sysDescr, for wall icons.
        stencil: string | null = null,
    ) => laneQuery('collector', `
        UPDATE devices
           SET last_poll_ts = now(),
               poll_lag_ms  = $8,
               cpu_pct       = CASE WHEN $9::jsonb IS NULL THEN cpu_pct ELSE ($9::jsonb->>'cpu_pct')::real END,
               mem_pct       = CASE WHEN $9::jsonb IS NULL THEN mem_pct ELSE ($9::jsonb->>'mem_pct')::real END,
               fs_pct        = CASE WHEN $9::jsonb IS NULL THEN fs_pct ELSE ($9::jsonb->>'fs_pct')::real END,
               fs_name       = CASE WHEN $9::jsonb IS NULL THEN fs_name ELSE $9::jsonb->>'fs_name' END,
               temp_c        = CASE WHEN $9::jsonb IS NULL THEN temp_c ELSE ($9::jsonb->>'temp_c')::real END,
               down_ports    = CASE WHEN $9::jsonb IS NULL THEN down_ports ELSE ($9::jsonb->>'down_ports')::int END,
               if_count      = CASE WHEN $9::jsonb IS NULL THEN if_count ELSE ($9::jsonb->>'if_count')::int END,
               if_errs       = CASE WHEN $9::jsonb IS NULL THEN if_errs ELSE ($9::jsonb->>'if_errs')::real END,
               top_if        = CASE WHEN $9::jsonb IS NULL THEN top_if ELSE $9::jsonb->>'top_if' END,
               top_bps       = CASE WHEN $9::jsonb IS NULL THEN top_bps ELSE ($9::jsonb->>'top_bps')::float8 END,
               top_speed     = CASE WHEN $9::jsonb IS NULL THEN top_speed ELSE ($9::jsonb->>'top_speed')::float8 END,
               alarms        = CASE WHEN $9::jsonb IS NULL THEN alarms ELSE ($9::jsonb->>'alarms')::int END,
               state_sensors = CASE WHEN $9::jsonb IS NULL THEN state_sensors ELSE ($9::jsonb->>'state_sensors')::int END,
               batt_pct      = CASE WHEN $9::jsonb IS NULL THEN batt_pct ELSE ($9::jsonb->>'batt_pct')::real END,
               runtime_s     = CASE WHEN $9::jsonb IS NULL THEN runtime_s ELSE ($9::jsonb->>'runtime_s')::real END,
               uptime_s      = CASE WHEN $2 THEN $10 ELSE uptime_s END,
               cpu_cores     = coalesce($11, cpu_cores),
               ram_kb        = coalesce($12, ram_kb),
               last_seen_ts = CASE WHEN $2 THEN now() ELSE last_seen_ts END,
               status       = CASE WHEN $2 THEN 'up' ELSE 'down' END,
               consecutive_failures = CASE WHEN $2 THEN 0 ELSE consecutive_failures + 1 END,
               sys_name     = coalesce($3, sys_name),
               sys_descr    = coalesce($4, sys_descr),
               sys_location = coalesce($5, sys_location),
               inventory_ts = CASE WHEN $6 THEN now() ELSE inventory_ts END,
               cpu_model    = coalesce($7, cpu_model),
               -- Slice 32: the GUESS only. The override beside it is the
               -- operator's and is never touched by a poll.
               stencil      = coalesce($14, stencil),
               -- Slice 26: the poll's own wall time, kept beside ping_rtt_ms
               -- so the glance grid reads latency from the device row. Only a
               -- successful poll writes it - a failed one's elapsed time is
               -- the timeout constant, not a measurement.
               snmp_rtt_ms  = CASE WHEN $2 THEN $13 ELSE snmp_rtt_ms END
         WHERE id = $1::bigint`,
        [id, ok, sysName, sysDescr, sysLocation, inventoryTried, cpuModel, pollLagMs,
            summary === null ? null : JSON.stringify(summary), uptimeS, cpuCores, ramKb,
            snmpRttMs, stencil]),

    /**
     * Create a PING-ONLY device (slice 35).
     *
     * Deliberately NOT the probe path: there is nothing to probe. The whole
     * onboarding flow exists to let an operator look at what an agent said
     * before accepting it, and a host with no agent says nothing - so the
     * operator's own typed name is the only identity there will ever be,
     * which is exactly right for "Internet" or "ISP-A handoff".
     *
     * ON CONFLICT DO NOTHING: adding a host that is already watched is a
     * no-op the route reports, not an overwrite of a device that may be a
     * fully-polled machine. The conflict arm names the incumbent (ruling 5),
     * same shape as insertDeviceWithEntities and for the same reason: the
     * name here is TYPED, and an operator typing "Internet" deserves to be
     * told whether that name already watches this address or a different
     * one. same_target compares the HOST only - a ping-only add colliding
     * with a fully-polled device at the same address is the same machine,
     * already watched, whatever its snmp_port says.
     */
    insertPingDevice: (
        name: string, host: string, location: string | null, application: string | null,
        stencil: string,
    ) => laneQuery<{
        outcome: 'added' | 'conflict'; name: string | null;
        incumbent_host: string | null; incumbent_port: number | null; same_target: boolean | null;
    }>('interactive', `
        WITH d AS (
            INSERT INTO devices (name, host, snmp_enabled, reach_check, location, application, stencil)
            VALUES ($1, $2::inet, false, 'icmp', $3, $4, $5)
            ON CONFLICT (name) DO NOTHING
            RETURNING name
        )
        SELECT 'added' AS outcome, d.name,
               NULL::text AS incumbent_host, NULL::int AS incumbent_port, NULL::boolean AS same_target
          FROM d
        UNION ALL
        SELECT 'conflict', inc.name, host(inc.host), inc.snmp_port, (inc.host = $2::inet)
          FROM devices inc
         WHERE inc.name = $1 AND NOT EXISTS (SELECT 1 FROM d)`,
        [name, host, location, application, stencil]),

    /**
     * FORCE ADD (the Force Add slice): a device row with its credential and
     * nothing else - no entities, no sys facts, last_seen_ts NULL, raw
     * status 'down' so the summary CASEs stay blank. deviceStatusSql reads
     * the row as 'pending' until first contact; the ordinary poller and its
     * discovery fill everything in the first time the host answers. The
     * conflict arm is the ruling-5 shape shared with the ping path: the
     * name here is TYPED (there is no sysName to propose one), so a
     * collision's way out is always "pick a different name".
     */
    forceAddDevice: (
        name: string, host: string, port: number, version: string,
        credentialRef: string, pollIntervalS: number, uptimeCode: string,
    ) => laneQuery<{
        outcome: 'added' | 'conflict'; name: string | null;
        incumbent_host: string | null; incumbent_port: number | null; same_target: boolean | null;
    }>('interactive', `
        WITH d AS (
            INSERT INTO devices
                (name, host, snmp_port, snmp_version, credential_ref,
                 poll_interval_s, uptime_code, status, enabled)
            VALUES ($1, $2::inet, $3, $4, $5, $6, $7, 'down', true)
            ON CONFLICT (name) DO NOTHING
            RETURNING name
        )
        SELECT 'added' AS outcome, d.name,
               NULL::text AS incumbent_host, NULL::int AS incumbent_port, NULL::boolean AS same_target
          FROM d
        UNION ALL
        SELECT 'conflict', inc.name, host(inc.host), inc.snmp_port, (inc.host = $2::inet)
          FROM devices inc
         WHERE inc.name = $1 AND NOT EXISTS (SELECT 1 FROM d)`,
        [name, host, port, version, credentialRef, pollIntervalS, uptimeCode]),

    /** Slice 32: the operator's correction. NULL clears it and the machine's
     *  guess takes over again - the same "withdraw your number" semantics as
     *  clearing a speed override. */
    setDeviceStencil: (name: string, stencil: string | null) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET stencil_override = $2 WHERE name = $1 RETURNING name`,
        [name, stencil]),

    /**
     * The live ping RTT for the whole fleet, one statement, CHANGE-ONLY.
     *
     * The transition path writes reach_rtt_ms only when state flips, so a
     * device's shown RTT could be days old. This carries every sweep's reading
     * - but IS DISTINCT FROM (rounded to the millisecond) means a fleet whose
     * latencies did not move writes nothing, and one that did writes only the
     * rows that did. A 400-device sweep at 5s that rewrote every row would be
     * 80 UPDATE/s of no-op tuple versions, which is the shape check-write-loops
     * exists to catch; this is one statement per sweep, touching only changed
     * rows, which is what it exists to encourage.
     */
    recordPingRtts: (ids: string[], rtts: Array<number | null>) => laneQuery('collector', `
        UPDATE devices d
           SET ping_rtt_ms = v.rtt
          FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::real[]) AS rtt) v
         WHERE d.id = v.id
           AND round(coalesce(d.ping_rtt_ms, -1)::numeric) IS DISTINCT FROM round(coalesce(v.rtt, -1)::numeric)`,
        [ids, rtts]),

    /**
     * SNMP round-trip over the last hour for one device: median and worst,
     * from samples.rtt_ms which every interface row carries. Median so a single
     * slow walk does not alarm and a slow HOUR does. Bounded to one device and
     * one hour on the interactive lane; the device page asks for it once per
     * refresh of an open device only.
     */
    deviceRttHour: (deviceName: string) => laneQuery<{ n: number; med_ms: number | null; max_ms: number | null }>('interactive', `
        SELECT count(*)::int AS n,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY s.rtt_ms)::float8 AS med_ms,
               max(s.rtt_ms)::float8 AS max_ms
          FROM samples s
          JOIN entities e ON e.id = s.entity_id
          JOIN devices  d ON d.id = e.device_id
         WHERE d.name = $1 AND e.kind = 'if'
           AND s.ts > now() - interval '1 hour' AND s.rtt_ms IS NOT NULL`, [deviceName]),

    /**
     * The hour number above, as a SERIES - the investigation tool for "this
     * device drifts toward degraded and clears before it alerts" (the
     * operator's MikroTik case: 5s medians that are how RouterOS behaves,
     * not a fault). Bucketed median and worst per bucket, RAW SAMPLES ONLY:
     * the hourly rollup does not carry rtt, so the window honestly ends
     * where raw retention does and the route says so. No kind filter,
     * unlike the hour aggregate: every sample row of a poll carries that
     * poll's rtt, so a sensor-only device (a UPS) still has a history, and
     * duplicated identical values inside one poll do not move a median.
     */
    deviceRttSeries: (deviceName: string, hours: number, bucketSec: number) => laneQuery<{
        b: string; med_ms: number | null; max_ms: number | null;
    }>('interactive', `
        SELECT floor(extract(epoch FROM s.ts) / $3) * $3 AS b,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY s.rtt_ms)::float8 AS med_ms,
               max(s.rtt_ms)::float8 AS max_ms
          FROM samples s
          JOIN entities e ON e.id = s.entity_id
          JOIN devices  d ON d.id = e.device_id
         WHERE d.name = $1 AND s.rtt_ms IS NOT NULL
           AND s.ts > now() - make_interval(hours => $2::int)
         GROUP BY 1 ORDER BY 1`, [deviceName, hours, bucketSec]),

    /**
     * The U3 events lane: the newest transitions across the fleet, with the
     * device name joined in one statement. 100 is a render bound, not paging
     * - the lane answers "what flapped recently", and a page of history
     * deeper than that is the drill-down's job when one exists.
     */
    reachEvents: () => laneQuery<{
        ts: Date; name: string; from_state: string; to_state: string;
        rtt_ms: number | null;
    }>('interactive', `
        SELECT e.ts, d.name, e.from_state, e.to_state, e.rtt_ms
          FROM reachability_events e
          JOIN devices d ON d.id = e.device_id
         ORDER BY e.ts DESC
         LIMIT 100`),

    /**
     * The reachability fleet: every enabled device that asked for a probe,
     * WITH the probe it asked for. reach_check = 'none' opts a device out
     * (schema comment in slice12.sql) and is the one value filtered here.
     *
     * THE COLUMN COMES BACK RATHER THAN BEING TESTED. This comment used to
     * say a future 'tcp' would "join the WHERE rather than a new query", and
     * that sentence described the bug as if it were the plan: `<> 'none'` is
     * a boolean test, so every value that was not the opt-out went to fping
     * and any other probe would have reported ICMP truth under its name.
     * Dispatch is a decision, so it lives in reach.ts where the offline suite
     * can assert it - see partitionChecks, which also explains why an
     * unsupported value must not simply be dropped from this result.
     */
    reachFleet: () => laneQuery<{
        id: string; host: string; reach_state: string; reach_check: string;
        reach_port: number | null;
    }>(
        'collector', `
        SELECT id::text AS id, host(host) AS host, reach_state, reach_check, reach_port
          FROM devices
         WHERE enabled = true AND reach_check <> 'none'`),

    /**
     * One sweep's transitions: the device rows AND the event rows, one
     * statement, atomic. Called once per sweep with arrays - the per-device
     * loop shape the write checker exists to catch would be here if the
     * arrays were rows, and it is not: a sweep with 40 transitions is one
     * round trip, and a healthy sweep with none never calls this at all.
     *
     * reach_since_ts is stamped by POSTGRES's now(), same clock as every
     * other timestamp on the row - the one-clock rule from alertScanDevices.
     */
    recordReachTransitions: (
        ids: string[], states: string[], rtts: Array<number | null>,
    ) => laneQuery<never>('collector', `
        WITH t AS (
            SELECT unnest($1::bigint[]) AS device_id,
                   unnest($2::text[])   AS to_state,
                   unnest($3::real[])   AS rtt_ms
        ),
        prev AS (
            SELECT t.device_id, d.reach_state AS from_state, t.to_state, t.rtt_ms
              FROM t JOIN devices d ON d.id = t.device_id
        ),
        upd AS (
            UPDATE devices d
               SET reach_state    = p.to_state,
                   reach_since_ts = now(),
                   reach_rtt_ms   = p.rtt_ms
              FROM prev p
             WHERE d.id = p.device_id
         RETURNING d.id
        )
        INSERT INTO reachability_events (device_id, from_state, to_state, rtt_ms)
        SELECT device_id, from_state, to_state, rtt_ms FROM prev`,
        [ids, states, rtts]),

    /**
     * Slice 36: one minute's ping latencies, one statement. Arrays rather
     * than rows for the same reason recordReachTransitions takes arrays - a
     * sweep is one round trip whatever the fleet size.
     *
     * A device that did not answer is written with a NULL rtt, deliberately:
     * "probed and silent" is a reading, and only an absent ROW means nobody
     * was looking.
     */
    insertPingSamples: (ids: string[], rtts: Array<number | null>) => laneQuery<never>(
        'collector', `
        INSERT INTO ping_samples (device_id, rtt_ms)
        SELECT unnest($1::bigint[]), unnest($2::real[])`, [ids, rtts]),

    /**
     * The series behind the latency chart. Bucketed like the SNMP one, and
     * carrying LOSS as well as latency - for an internet link "how often did
     * it not answer" is at least as interesting as "how fast when it did",
     * and both come free from the same scan because a miss is a null row.
     */
    pingSeries: (deviceName: string, hours: number, bucketSec: number) => laneQuery<{
        b: string; med_ms: number | null; max_ms: number | null; n: number; misses: number;
    }>('interactive', `
        SELECT floor(extract(epoch FROM p.ts) / $3) * $3 AS b,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY p.rtt_ms)::float8 AS med_ms,
               max(p.rtt_ms)::float8 AS max_ms,
               count(*)::int AS n,
               count(*) FILTER (WHERE p.rtt_ms IS NULL)::int AS misses
          FROM ping_samples p
          JOIN devices d ON d.id = p.device_id
         WHERE d.name = $1
           AND p.ts > now() - make_interval(hours => $2::int)
         GROUP BY 1 ORDER BY 1`, [deviceName, hours, bucketSec]),

    /** Retention, riding the same job as alerts and windows. */
    /**
     * Availability over a window, from data already collected (easy-win
     * E4): ping_samples distinguishes probed-and-missed (a row with NULL
     * rtt) from not-probed (no row), so misses / probes IS the uptime
     * fraction with no new write path. One device, one window, one
     * aggregate - the device drill-down's cost model, not the roster's,
     * which is why this is not a roster column.
     */
    pingAvailability: (name: string, hours: number) => laneQuery<{ probes: string; misses: string }>(
        'interactive', `
        SELECT count(*)::text AS probes,
               count(*) FILTER (WHERE p.rtt_ms IS NULL)::text AS misses
          FROM ping_samples p JOIN devices d ON d.id = p.device_id
         WHERE d.name = $1 AND p.ts > now() - make_interval(hours => $2::int)`,
        [name, hours]),

    prunePingSamples: (days: number) => laneQuery<{ n: string }>('jobs', `
        WITH gone AS (
            DELETE FROM ping_samples WHERE ts < now() - make_interval(days => $1::int)
            RETURNING 1
        ) SELECT count(*)::text AS n FROM gone`, [days]),

    /**
     * The database's own health, one query, interactive lane. Feeds the
     * isDbSelfHealthy verdicts: wraparound age across ALL databases (the
     * soak's incident lived in a database no app instrument watched), and
     * dead/live tuples on the tables the collector churns.
     */
    healthDbSelf: () => laneQuery<{
        oldest_dat_age: string;
        bloat: Array<{ rel: string; live: number; dead: number }>;
    }>('interactive', `
        SELECT (SELECT max(age(datfrozenxid)) FROM pg_database)::text AS oldest_dat_age,
               (SELECT coalesce(json_agg(json_build_object(
                        'rel', relname, 'live', n_live_tup, 'dead', n_dead_tup)
                        ORDER BY relname), '[]'::json)
                  FROM pg_stat_user_tables
                 WHERE relname IN ('entities', 'devices', 'alerts')) AS bloat`, []),

    // Carries descr/alias/speed/status alongside the counter state so the
    // poller can COMPARE before writing. Widening this SELECT is what made
    // refreshEntity skippable: reading six more columns per device costs
    // nothing next to writing 25 unchanged rows per device per poll.
    entitiesForDevice: (deviceId: string) => laneQuery<{
        id: string; snmp_index: string | null; name: string | null; code: string | null;
        descr: string | null; alias: string | null; speed_bps: number | null;
        speed_untrusted: boolean; speed_override_bps: number | null;
        tracked: boolean; hc_missing: boolean;
        admin_status: number | null; oper_status: number | null;
        /** The rekey planner's generation evidence - see src/collector/rekey.ts. */
        lv_ts: Date | null; lv_stale_since: Date | null;
        prev_ts: Date | null; prev_c0: string | null; prev_c1: string | null;
        prev_c2: string | null; prev_c3: string | null; prev_c4: string | null; prev_c5: string | null;
    }>('collector', `
        SELECT id::text AS id, snmp_index, name, code,
               descr, alias, speed_bps::float8 AS speed_bps, admin_status, oper_status,
               speed_untrusted, speed_override_bps::float8 AS speed_override_bps, tracked,
               hc_missing,
               lv_ts, lv_stale_since,
               prev_ts,
               prev_c0::text AS prev_c0, prev_c1::text AS prev_c1, prev_c2::text AS prev_c2,
               prev_c3::text AS prev_c3, prev_c4::text AS prev_c4, prev_c5::text AS prev_c5
          FROM entities
         -- kind = 'if' EXPLICITLY, since the sensors slice: this query feeds
         -- the INTERFACE poll (ifTable lookups by snmp_index, counter deltas
         -- into lv_*), and a temp or cpu entity flowing through it would be
         -- matched against ifTable rows it has nothing to do with. Sensor
         -- entities are discovered and stored now, polled by their own pass
         -- when it lands - invisible here by construction, not by luck.
         WHERE device_id = $1::bigint AND kind = 'if'`, [deviceId]),

    /** Slice 28: which counter source this interface's deltas come from.
     *  Flips only when the agent's capability changes - effectively once. */
    setHcMissing: (id: string, missing: boolean) => laneQuery('collector', `
        UPDATE entities SET hc_missing = $2 WHERE id = $1::bigint`, [id, missing]),

    /**
     * Every code currently in use, across the shared namespace.
     *
     * Entity codes and device uptime codes collide with each other, so both
     * halves are needed. Fetched once per discovery rather than per candidate:
     * a round trip per window would be absurd on a 48-port switch.
     */
    takenCodes: () => laneQuery<{ code: string }>('collector', `
        SELECT code FROM entities WHERE code IS NOT NULL
        UNION
        SELECT uptime_code FROM devices WHERE uptime_code IS NOT NULL`),

    /**
     * Create an entity discovered on a device.
     *
     * The code is passed in already minted, and ON CONFLICT DO NOTHING against
     * the (device_id, kind, snmp_index) index makes rediscovery idempotent -
     * which matters because a code must never be regenerated for an entity
     * that already has one.
     */
    insertEntity: (
        deviceId: string, kind: string, snmpIndex: string, name: string, descr: string | null,
        alias: string | null, speedBps: number | null, code: string,
        extra: string | null = null, tracked = true,
    ) => laneQuery<{ id: string; code: string }>('collector', `
        INSERT INTO entities (device_id, kind, snmp_index, name, descr, alias, speed_bps, code, extra, tracked)
        VALUES ($1::bigint, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)
        ON CONFLICT (device_id, kind, snmp_index) WHERE snmp_index IS NOT NULL DO NOTHING
        RETURNING id::text AS id, code`,
        [deviceId, kind, snmpIndex, name, descr, alias, speedBps, code, extra, tracked]),

    /** Does this device have ANY sensor entities yet? One count, asked at
     *  the inventory cadence, never per poll - it gates the backfill. */
    sensorCountForDevice: (deviceId: string) => laneQuery<{ n: number }>('collector', `
        SELECT count(*)::int AS n FROM entities
         WHERE device_id = $1::bigint AND kind <> 'if'`, [deviceId]),

    /**
     * The sensors this device polls: TRACKED only, unlike the interface
     * query above which reads every row. The asymmetry is the parent's and
     * it is deliberate: interfaces are polled wholesale because their
     * counters are the product, but the sensor discovery gates (FS_NOISE,
     * plausibleC, stopped fans) exist precisely so junk never reaches the
     * samples table - polling an untracked sensor would write history for a
     * reading the discovery already judged implausible.
     */
    sensorsForDevice: (deviceId: string) => laneQuery<{
        id: string; kind: string; name: string; extra: import('../collector/sensors.ts').SensorExtra;
    }>('collector', `
        SELECT id::text AS id, kind, name, extra
          FROM entities
         WHERE device_id = $1::bigint AND kind <> 'if'
           AND tracked = true AND extra IS NOT NULL`, [deviceId]),

    /**
     * Every sensor row for the re-pin pass - UNTRACKED included, because a
     * sensor the operator parked still deserves a correct instruction the
     * day they re-track it, and repinning writes no readings either way.
     */
    sensorRowsForRepin: (deviceId: string) => laneQuery<{
        id: string; kind: string; snmp_index: string | null; name: string | null;
        extra: import('../collector/sensors.ts').SensorExtra;
    }>('collector', `
        SELECT id::text AS id, kind, snmp_index, name, extra
          FROM entities
         WHERE device_id = $1::bigint AND kind <> 'if'
           AND extra IS NOT NULL`, [deviceId]),

    /**
     * Refresh one sensor's polling INSTRUCTION - and, for the hr-indexed
     * kinds, follow its renumbered index - leaving identity alone: code,
     * name binding, history, tracked flag all stay. The planner
     * (planSensorRepin) decides what may move; the NOT EXISTS is the same
     * last-line race guard rekeyEntity carries, making a lost race a named
     * zero-row no-op rather than a unique-index error.
     */
    repinSensor: (id: string, snmpIndex: string, extra: string) => laneQuery<{ id: string }>('collector', `
        UPDATE entities e SET snmp_index = $2, extra = $3::jsonb
         WHERE e.id = $1::bigint
           AND NOT EXISTS (SELECT 1 FROM entities o
                            WHERE o.device_id = e.device_id AND o.kind = e.kind
                              AND o.snmp_index = $2 AND o.id <> e.id)
     RETURNING e.id::text AS id`, [id, snmpIndex, extra]),

    /**
     * CONVICT an advertised speed: measured traffic exceeded it past the
     * jitter margin. Written on the poll that convicts and never again -
     * the poll row carries the flag, so a convicted interface skips this.
     * WHERE NOT speed_untrusted makes a racing double-write a no-op.
     */
    /**
     * Set or clear an operator speed override on one interface. NULL clears:
     * the advertised speed (and any standing untrusted conviction) takes
     * back over, which is exactly the SNMPCanvas semantic - override
     * outranks conviction while present, changes nothing else.
     */
    setSpeedOverride: (deviceId: string, snmpIndex: string, bps: number | null) =>
        laneQuery<{ name: string; speed_override_bps: number | null }>('interactive', `
        UPDATE entities SET speed_override_bps = $3
         WHERE device_id = $1::bigint AND kind = 'if' AND snmp_index = $2
        RETURNING name, speed_override_bps::float8 AS speed_override_bps`,
        [deviceId, snmpIndex, bps]),

    markSpeedUntrusted: (id: string) => laneQuery('collector', `
        UPDATE entities SET speed_untrusted = true
         WHERE id = $1::bigint AND NOT speed_untrusted`, [id]),

    /**
     * Move an interface entity to a new ifIndex after a re-enumeration.
     *
     * ONLY the index changes. The row keeps its id, its code (bound to a board
     * somewhere), its history, its tracked flag and its speed trust - that is
     * the whole point, since the alternative was a fresh row and an orphan.
     * See src/collector/rekey.ts for when this is allowed to happen.
     *
     * The WHERE guards the race the planner cannot see: another poll may have
     * inserted a row at the target index in the meantime, and the unique
     * index (device_id, kind, snmp_index) would then refuse. NOT EXISTS makes
     * that a zero-row no-op the caller can name rather than a thrown error.
     */
    rekeyEntity: (id: string, toIdx: string) => laneQuery<{ id: string }>('collector', `
        UPDATE entities e SET snmp_index = $2
         WHERE e.id = $1::bigint
           AND NOT EXISTS (SELECT 1 FROM entities o
                            WHERE o.device_id = e.device_id AND o.kind = e.kind
                              AND o.snmp_index = $2 AND o.id <> e.id)
     RETURNING e.id::text AS id`, [id, toIdx]),

    /**
     * Free an interface's ifIndex without touching anything else - the
     * eviction half of a re-deal (src/collector/rekey.ts): the row's adapter
     * is no longer at this index, and a DIFFERENT adapter's row is about to
     * take it. Parked, never renamed across adapters - the row keeps its
     * name, code, history and open alerts, and if its adapter returns a
     * boot later the planner re-keys it back by name (a NULL index is
     * maximally displaced). The partial unique index only covers non-NULL
     * snmp_index, so parked rows never contend for a slot.
     */
    parkEntity: (id: string) => laneQuery<{ id: string }>('collector', `
        UPDATE entities SET snmp_index = NULL
         WHERE id = $1::bigint
     RETURNING id::text AS id`, [id]),

    /** Names, alias and speed can change on a live device; the code cannot. */
    refreshEntity: (
        id: string, name: string, descr: string | null, alias: string | null,
        speedBps: number | null, adminStatus: number | null, operStatus: number | null,
    ) => laneQuery('collector', `
        UPDATE entities
           SET name = $2, descr = $3, alias = $4, speed_bps = $5,
               -- A re-negotiated link gets a fresh trial: the conviction
               -- was against the OLD claim. Ported from SNMPCanvas
               -- poller.js:391 - see src/collector/speedtrust.ts.
               speed_untrusted = CASE WHEN speed_bps IS DISTINCT FROM $5 THEN false
                                      ELSE speed_untrusted END,
               admin_status = $6, oper_status = $7
         WHERE id = $1::bigint`,
        [id, name, descr, alias, speedBps, adminStatus, operStatus]),

    /**
     * Raw counters and their timestamp, so rates survive a restart. ONE
     * statement per device, exactly like updateLastValuesBatch below - and it
     * was not always so: the per-entity form of this call ran 331 times a
     * second across the fleet and was, with its neighbours, most of a
     * measured 457 GB/day of device writes (each autocommit transaction
     * fsync'd a partially-filled 8 KB WAL block; SOAK-CRITERIA 2026-08-10).
     * The shared ts is real, not a simplification: a device's counters are
     * all read in one poll pass and stamped with its single `now`.
     */
    saveCountersBatch: (
        ids: string[], ts: Date,
        c0: Array<bigint | null>, c1: Array<bigint | null>, c2: Array<bigint | null>,
        c3: Array<bigint | null>, c4: Array<bigint | null>, c5: Array<bigint | null>,
    ) => laneQuery('collector', `
        UPDATE entities e
           SET prev_ts = $2, prev_c0 = u.c0, prev_c1 = u.c1, prev_c2 = u.c2,
               prev_c3 = u.c3, prev_c4 = u.c4, prev_c5 = u.c5
          FROM (
            SELECT * FROM unnest(
                $1::bigint[], $3::numeric[], $4::numeric[], $5::numeric[],
                $6::numeric[], $7::numeric[], $8::numeric[]
            ) AS t(id, c0, c1, c2, c3, c4, c5)
          ) u
         WHERE e.id = u.id`,
        [ids, ts,
            ...[c0, c1, c2, c3, c4, c5].map((col) =>
                col.map((v) => (v === null ? null : v.toString())))]),

    /**
     * The denormalised last-value write, measured in slice 4e.
     *
     * Deliberately a SEPARATE operation rather than folded into the sample
     * write, so the cost of having it can be measured by running with and
     * without it rather than estimated.
     *
     * NOT ON THE POLL PATH any more - the collector writes through
     * updateLastValuesBatch below. This single-row form survives as the
     * fixture helper tools/test-scan.ts sets entity states with; if that
     * ever stops being true, delete it rather than letting two write shapes
     * for one set of columns drift apart.
     */
    updateLastValues: (
        id: string, ts: Date, status: number | null, rttMs: number | null,
        v: Array<number | null>, staleSince: Date | null,
    ) => laneQuery('collector', `
        UPDATE entities
           SET lv_ts = $2, lv_status = $3, lv_rtt_ms = $4,
               lv_v0 = $5, lv_v1 = $6, lv_v2 = $7, lv_v3 = $8, lv_v4 = $9, lv_v5 = $10,
               lv_stale_since = $11
         WHERE id = $1::bigint`,
        [id, ts, status, rttMs, ...v, staleSince]),

    /**
     * Populate lv_* for the seeded fixture entities from their latest sample.
     *
     * A measurement fixture, not a product path. The comparison in slice 4e has
     * to be made at the 30,000-entity ceiling against the 92GB corpus, not at
     * the 2,160 entities the mock fleet produces - the whole question is how
     * the two read shapes scale, and 2,160 is below where either one hurts.
     *
     * Idempotent and additive: it only fills columns that were NULL when slice
     * 4 added them, and touches no column any earlier measurement used.
     */
    backfillFixtureLastValues: (limit: number) => laneQuery<{ n: string }>('jobs', `
        WITH latest AS (
            SELECT DISTINCT ON (s.entity_id)
                   s.entity_id, s.ts, s.status, s.rtt_ms, s.v0, s.v1, s.v2, s.v3, s.v4, s.v5
              FROM samples s
             WHERE s.entity_id < 100000
             ORDER BY s.entity_id, s.ts DESC
             LIMIT $1
        ), updated AS (
            UPDATE entities e
               SET lv_ts = l.ts, lv_status = l.status, lv_rtt_ms = l.rtt_ms,
                   lv_v0 = l.v0, lv_v1 = l.v1, lv_v2 = l.v2,
                   lv_v3 = l.v3, lv_v4 = l.v4, lv_v5 = l.v5
              FROM latest l
             WHERE e.id = l.entity_id
            RETURNING 1
        )
        SELECT count(*)::text AS n FROM updated`, [limit]),

    /** The fixture-scale versions of the same two shapes: 30,000 entities. */
    fixtureLatestFromSamples: () => timedInteractive(`
        SELECT DISTINCT ON (s.entity_id) s.entity_id, s.ts, s.v0, s.v1
          FROM samples s
         WHERE s.entity_id < 100000
           AND s.ts > now() - interval '30 days'
         ORDER BY s.entity_id, s.ts DESC`, []),

    /**
     * The same query on the jobs lane, which has no statement timeout.
     *
     * The spike needed exactly this pattern and said why: a query that breaches
     * its lane stops returning a measurement and starts returning "statement
     * timeout", which is a useful product finding and a useless benchmark.
     * Running both says whether the query breaches the lane AND what it would
     * have cost had it been allowed to finish. One number without the other
     * cannot support a decision.
     */
    fixtureLatestFromSamplesUnbounded: () => laneQuery<Record<string, unknown>>('jobs', `
        SELECT DISTINCT ON (s.entity_id) s.entity_id, s.ts, s.v0, s.v1
          FROM samples s
         WHERE s.entity_id < 100000
           AND s.ts > now() - interval '30 days'
         ORDER BY s.entity_id, s.ts DESC`, []),

    fixtureLatestFromEntities: () => timedInteractive(`
        SELECT id AS entity_id, lv_ts AS ts, lv_v0 AS v0, lv_v1 AS v1
          FROM entities
         WHERE id < 100000 AND lv_ts IS NOT NULL`, []),

    /**
     * The BEST samples-shaped read, not the naive one.
     *
     * DISTINCT ON scans every sample in the window and discards all but the
     * newest per entity. A lateral with LIMIT 1 instead walks the (entity_id,
     * ts) primary key backwards once per entity and stops - 30,000 index
     * descents rather than a 92GB scan.
     *
     * It exists so the denormalisation decision is made against the strongest
     * alternative. Comparing last-value columns to a query nobody would write
     * is how a benchmark tells you what you already believed. The handoff notes
     * the parent tried the neighbouring shapes: a correlated max(ts) was FAR
     * worse (12s, full scan) and join-plus-scalar-subqueries only 1.9x better.
     */
    fixtureLatestLateral: () => laneQuery<Record<string, unknown>>('jobs', `
        SELECT e.id AS entity_id, s.ts, s.v0, s.v1
          FROM entities e
          CROSS JOIN LATERAL (
              SELECT ts, v0, v1 FROM samples
               WHERE entity_id = e.id
               ORDER BY ts DESC
               LIMIT 1
          ) s
         WHERE e.id < 100000`, []),

    /**
     * All of a device's last-value rows in ONE statement.
     *
     * The per-entity version below is one round trip per interface, which is 24
     * on a typical switch and 48 on a dense one - the same N+1 shape that cost
     * the parent 5,200 queries per page load, reappearing on the write side.
     * Measuring the denormalisation decision against that would be measuring a
     * bad implementation rather than the idea, and would reproduce the parent's
     * verdict by construction.
     *
     * unnest() turns seven parallel arrays into rows, so the whole device is one
     * statement with one round trip regardless of interface count.
     */
    updateLastValuesBatch: (
        ids: string[], ts: Date, statuses: Array<number | null>, rtts: Array<number | null>,
        v0: Array<number | null>, v1: Array<number | null>, v2: Array<number | null>,
        v3: Array<number | null>, v4: Array<number | null>, v5: Array<number | null>,
    ) => laneQuery('collector', `
        UPDATE entities e
           SET lv_ts = $2, lv_status = u.status, lv_rtt_ms = u.rtt,
               lv_v0 = u.a0, lv_v1 = u.a1, lv_v2 = u.a2,
               lv_v3 = u.a3, lv_v4 = u.a4, lv_v5 = u.a5,
               lv_stale_since = NULL
          FROM (
            SELECT * FROM unnest(
                $1::bigint[], $3::smallint[], $4::real[],
                $5::float8[], $6::float8[], $7::float8[],
                $8::float8[], $9::float8[], $10::float8[]
            ) AS t(id, status, rtt, a0, a1, a2, a3, a4, a5)
          ) u
         WHERE e.id = u.id`,
        [ids, ts, statuses, rtts, v0, v1, v2, v3, v4, v5]),

    /**
     * The write half of "stale is PRESENT-WHEN-TRUE" - slice 4's one-way
     * door, which for a while had readers and no writer: the column, the
     * read ops and the UI branch all existed while nothing ever set it
     * (found by the 2026-09-01 review; the single-row op that once carried
     * it lost its last product caller to the batch rewrite above).
     *
     * After a SUCCESSFUL poll, any interface of the device that has
     * reported before and was not in this poll's walk gets stamped with
     * when it went quiet. Every predicate is load-bearing:
     *
     * - `lv_stale_since IS NULL`: the stamp records the FIRST time it went
     *   quiet, and re-stamping would also be a no-op row version per poll
     *   per stale interface - the exact write shape the amplification fix
     *   removed. In steady state this statement matches zero rows and
     *   costs no XID.
     * - `lv_ts IS NOT NULL`: an interface that never reported shows blank,
     *   not stale - "was never successfully asked" must not read as "went
     *   quiet" (the inventory pass draws the same line).
     * - `kind = 'if'`, deliberately: a sensor that stops answering is
     *   written as nulls by the sensor pass (a blank card, honest
     *   already), and a sensor pass that THROWS is documented to cost one
     *   cycle of readings, nothing else - a kind-blind sweep would turn
     *   that one bad cycle into stamping every sensor on the device.
     *
     * The batch write above clears the stamp when an interface answers
     * again, on a row version it is already creating, so the clear is
     * free.
     */
    markInterfacesStale: (deviceId: string, freshIds: string[], ts: Date) =>
        laneQuery('collector', `
        UPDATE entities
           SET lv_stale_since = $3
         WHERE device_id = $1::bigint
           AND kind = 'if'
           AND lv_ts IS NOT NULL
           AND lv_stale_since IS NULL
           AND NOT (id = ANY($2::bigint[]))`,
        [deviceId, freshIds, ts]),

    // --- the two read shapes compared in slice 4e --------------------------------

    /** Latest sample per entity, read from samples. The shape the parent used. */
    latestFromSamples: (deviceId: string) => timedInteractive(`
        SELECT DISTINCT ON (s.entity_id)
               s.entity_id, s.ts, s.status, s.rtt_ms, s.v0, s.v1, s.v2, s.v3, s.v4, s.v5
          FROM samples s
          JOIN entities e ON e.id = s.entity_id
         WHERE e.device_id = $1::bigint
           AND s.ts > now() - interval '10 minutes'
         ORDER BY s.entity_id, s.ts DESC`, [deviceId]),

    /** The same answer read from the denormalised columns. One index scan. */
    latestFromEntities: (deviceId: string) => timedInteractive(`
        SELECT id AS entity_id, lv_ts AS ts, lv_status AS status, lv_rtt_ms AS rtt_ms,
               lv_v0 AS v0, lv_v1 AS v1, lv_v2 AS v2, lv_v3 AS v3, lv_v4 AS v4, lv_v5 AS v5,
               lv_stale_since
          FROM entities
         WHERE device_id = $1::bigint`, [deviceId]),

    /** The whole-fleet version of each, which is what /api/devices actually needs. */
    fleetLatestFromSamples: (minEntityId: number) => timedInteractive(`
        SELECT DISTINCT ON (s.entity_id)
               s.entity_id, s.ts, s.v0, s.v1
          FROM samples s
         WHERE s.entity_id >= $1
           AND s.ts > now() - interval '10 minutes'
         ORDER BY s.entity_id, s.ts DESC`, [minEntityId]),

    fleetLatestFromEntities: (minEntityId: number) => timedInteractive(`
        SELECT id AS entity_id, lv_ts AS ts, lv_v0 AS v0, lv_v1 AS v1
          FROM entities
         WHERE id >= $1 AND lv_ts IS NOT NULL`, [minEntityId]),

    // --- auth ----------------------------------------------------------------
    //
    // These run on the INTERACTIVE lane, including the small writes.
    //
    // The lane table annotates interactive as "(read)", which describes its
    // dominant use rather than a prohibition. Every statement here is a
    // single-row lookup or a single-row write against a small table, bounded by
    // the lane's own 2s statement_timeout, and session validation happens on
    // every authenticated request so it belongs on the lane sized for
    // per-request work. The alternative - an eighth lane for auth - would break
    // the seven-lane table for traffic measured in microseconds.
    //
    // Note what is NOT here: password hashing. That is CPU on the libuv
    // threadpool, not database work, and it lives in src/auth/password.ts.

    countUsers: () => laneQuery<{ n: string }>('interactive',
        'SELECT count(*)::text AS n FROM users'),

    findUserByName: (username: string) => laneQuery<{
        id: string; username: string; password: string; role: string; disabled: boolean;
    }>('interactive',
        'SELECT id::text AS id, username, password, role, disabled FROM users WHERE username = $1',
        [username]),

    listUsers: () => laneQuery<{
        id: string; username: string; role: string; disabled: boolean;
        created_ts: Date; last_login_ts: Date | null;
    }>('interactive',
        `SELECT id::text AS id, username, role, disabled, created_ts, last_login_ts
           FROM users ORDER BY username`),

    insertUser: (username: string, passwordHash: string, role: string) =>
        laneQuery<{ id: string }>('interactive',
            `INSERT INTO users (username, password, role)
             VALUES ($1, $2, $3) RETURNING id::text AS id`,
            [username, passwordHash, role]),

    /**
     * Delete a user, but never the last admin.
     *
     * The guard is in the SQL rather than in a read-then-write, because a
     * check followed by a delete is a race: two admins deleting each other
     * concurrently both see two admins and both proceed. The NOT EXISTS runs
     * inside the same statement, so the second one deletes nothing.
     */
    deleteUser: (username: string) => laneQuery<{ username: string }>('interactive',
        `DELETE FROM users u
          WHERE u.username = $1
            AND NOT (
                u.role = 'admin'
                AND NOT EXISTS (
                    SELECT 1 FROM users o
                     WHERE o.role = 'admin' AND o.disabled = false AND o.id <> u.id
                )
            )
        RETURNING username`, [username]),

    setUserPassword: (username: string, passwordHash: string) =>
        laneQuery<{ id: string }>('interactive',
            'UPDATE users SET password = $2 WHERE username = $1 RETURNING id::text AS id',
            [username, passwordHash]),

    /** Same last-admin guard as deleteUser, for demotion. */
    setUserRole: (username: string, role: string) =>
        laneQuery<{ username: string; role: string }>('interactive',
            `UPDATE users u SET role = $2
              WHERE u.username = $1
                AND NOT (
                    u.role = 'admin' AND $2 <> 'admin'
                    AND NOT EXISTS (
                        SELECT 1 FROM users o
                         WHERE o.role = 'admin' AND o.disabled = false AND o.id <> u.id
                    )
                )
            RETURNING username, role`, [username, role]),

    touchLastLogin: (userId: string) => laneQuery('interactive',
        'UPDATE users SET last_login_ts = now() WHERE id = $1::bigint', [userId]),

    // --- sessions ------------------------------------------------------------

    insertSession: (
        tokenHash: string, userId: string, ttlSeconds: number,
        userAgent: string | null, sourceIp: string | null,
    ) => laneQuery('interactive',
        `INSERT INTO sessions (token_hash, user_id, expires_ts, user_agent, source_ip)
         VALUES ($1, $2::bigint, now() + ($3 || ' seconds')::interval, $4, $5::inet)`,
        [tokenHash, userId, String(ttlSeconds), userAgent, sourceIp]),

    /** One round trip: the session, its owner, and whether it is still valid. */
    findSession: (tokenHash: string) => laneQuery<{
        token_hash: string; user_id: string; username: string; role: string;
        disabled: boolean; expires_ts: Date; expired: boolean;
    }>('interactive',
        `SELECT s.token_hash, s.user_id::text AS user_id, u.username, u.role, u.disabled,
                s.expires_ts, (s.expires_ts <= now()) AS expired
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = $1`, [tokenHash]),

    refreshSession: (tokenHash: string, ttlSeconds: number) => laneQuery('interactive',
        `UPDATE sessions SET expires_ts = now() + ($2 || ' seconds')::interval
          WHERE token_hash = $1`, [tokenHash, String(ttlSeconds)]),

    deleteSession: (tokenHash: string) => laneQuery('interactive',
        'DELETE FROM sessions WHERE token_hash = $1', [tokenHash]),

    /**
     * Every session belonging to a user except, optionally, the one making the
     * change. This is what makes a password change mean something: without it,
     * changing a password after a laptop is stolen leaves the thief signed in.
     */
    deleteUserSessions: (userId: string, exceptTokenHash: string | null) =>
        laneQuery<{ token_hash: string }>('interactive',
            `DELETE FROM sessions
              WHERE user_id = $1::bigint
                AND ($2::text IS NULL OR token_hash <> $2)
            RETURNING token_hash`, [userId, exceptTokenHash]),

    pruneSessions: () => laneQuery<{ token_hash: string }>('jobs',
        'DELETE FROM sessions WHERE expires_ts <= now() RETURNING token_hash'),

    // --- audit ---------------------------------------------------------------

    insertAudit: (
        actorId: string | null, actorUsername: string, action: string,
        target: string | null, detail: unknown, sourceIp: string | null,
    ) => laneQuery('interactive',
        `INSERT INTO audit (actor_id, actor_username, action, target, detail, source_ip)
         VALUES ($1::bigint, $2, $3, $4, $5::jsonb, $6::inet)`,
        [actorId, actorUsername, action, target, detail === undefined ? null : JSON.stringify(detail), sourceIp]),

    listAudit: (limit: number) => laneQuery<{
        id: string; ts: Date; actor_username: string; action: string;
        target: string | null; detail: unknown; source_ip: string | null;
    }>('interactive',
        `SELECT id::text AS id, ts, actor_username, action, target, detail,
                source_ip::text AS source_ip
           FROM audit ORDER BY ts DESC, id DESC LIMIT $1`, [limit]),

    // --- maintenance and health ---------------------------------------------

    /** Cheap liveness probe for /api/health. */
    ping: () => laneQuery<{ one: number }>('interactive', 'SELECT 1 AS one'),

    /**
     * A dashboard-shaped read that TOUCHES `samples`, for the lock collision
     * test.
     *
     * `ping` is `SELECT 1` and never requests a lock on anything, so a probe
     * built on it cannot queue behind a DROP's ACCESS EXCLUSIVE request and
     * measures nothing about collateral damage. The first version of
     * tools/locktest.ts used it and reported a reassuring 0.67ms that proved
     * nothing at all.
     *
     * The predicate prunes to no rows, so the query is cheap - but it still
     * takes ACCESS SHARE on the parent, which is the only property the test
     * needs.
     */
    dashboardProbe: () => laneQuery<{ n: string }>('interactive',
        `SELECT count(*)::text AS n FROM samples
          WHERE entity_id = -1 AND ts >= now() + interval '1 day'`),

    /**
     * Buffer-cache counters for the residency report.
     *
     * A named operation because residency.ts is reachable from an HTTP request
     * (`GET /api/health?deep=1`) and used to run this as inline SQL through a
     * re-exported laneQuery - SQL outside the store, on a request path,
     * choosing its own lane at the call site. That was rule 1's first crack.
     */
    pgBufferStats: () => laneQuery<{ blks_read: string; blks_hit: string; blk_read_time: string }>(
        'jobs',
        `SELECT blks_read, blks_hit, blk_read_time
           FROM pg_stat_database WHERE datname = current_database()`),

    /**
     * Per-partition row counts for the messages table, used to record the
     * fixture baseline before a run and re-check it after, so drift in the
     * corpus the done-when criteria are measured against is visible rather
     * than discovered later.
     *
     * reltuples is the planner's estimate and is not exact; that is deliberate.
     * An exact count(*) across 50M rows is a heavy scan, and what this needs to
     * detect is a partition disappearing or gaining millions of rows.
     */
    /**
     * Partition inventory for EVERY partitioned table, not just messages.
     *
     * Slice 1 tracked messages alone because it touched nothing else. Slice 5
     * is retention, so it touches samples too - and a dropped samples partition
     * would have been invisible to a messages-only baseline. Extending this is
     * a prerequisite for slice 5, not a nicety: a guard that prevents a loss
     * beats a check that detects one, but a loss nobody detects is worse than
     * either.
     */
    partitionStats: () => laneQuery<{
        parent: string; partition_name: string; est_rows: string;
        bytes: string; pretty: string; has_trgm: boolean; has_host_trgm: boolean;
    }>('jobs', `
        SELECT parent.relname AS parent,
               c.relname AS partition_name,
               c.reltuples::bigint::text AS est_rows,
               pg_total_relation_size(c.oid)::text AS bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty,
               to_regclass(c.relname || '_msg_trgm')  IS NOT NULL AS has_trgm,
               -- BOTH indexes, since free text became "msg OR host" on
               -- 2026-07-27. Reporting only the msg index would have made a
               -- dropped host index invisible to the baseline, which is the
               -- same shape as every other blind instrument found here: the
               -- check reports clean because it never looked.
               to_regclass(c.relname || '_host_trgm') IS NOT NULL AS has_host_trgm
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class parent ON parent.oid = i.inhparent
         WHERE parent.relkind = 'p'
         ORDER BY parent.relname, c.relname`),

    /** Unpartitioned tables worth watching for wholesale loss, e.g. the rollup. */
    plainTableStats: () => laneQuery<{ name: string; est_rows: string; bytes: string; pretty: string }>(
        'jobs', `
        SELECT c.relname AS name,
               c.reltuples::bigint::text AS est_rows,
               pg_total_relation_size(c.oid)::text AS bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
           AND c.relname IN ('samples_hourly', 'entities', 'devices')
         ORDER BY c.relname`),

    /**
     * Create the daily partitions ingest is about to write into.
     *
     * This is NOT the retention job, which is slice 5. It creates and never
     * drops, and it is the precondition for a COPY landing at all: a datagram
     * arriving with no partition for today fails the whole flush.
     */
    /**
     * Create daily partitions for a table, on the INGEST lane.
     *
     * Not the jobs lane, and that is the point. This had zero callers - the
     * only occurrence of the old name in the whole tree was its own definition
     * - so at the first midnight past the last pre-created partition every COPY
     * would have failed with "no partition of relation messages found for row",
     * continuously, until someone ran the spike's addpartitions script by hand.
     *
     * It runs on the lane of the writer that needs it, because a partition that
     * does not exist is not housekeeping whose failure is quiet: it is the
     * never-drop invariant with a calendar expiry date. The jobs lane is
     * allowed to skip a run and retry later; ingest is not.
     */
    ensureDailyPartitions: (table: 'messages' | 'samples', firstDay: string, lastDay: string) =>
        laneQuery<{ ensure_daily_partitions: number }>('ingest',
            'SELECT ensure_daily_partitions($1, $2::date, $3::date)',
            [table, firstDay, lastDay]),

    /** The collector's copy, on its own lane, for the same reason. */
    ensureSamplePartitions: (firstDay: string, lastDay: string) =>
        laneQuery<{ ensure_daily_partitions: number }>('collector',
            'SELECT ensure_daily_partitions($1, $2::date, $3::date)',
            ['samples', firstDay, lastDay]),

    /** Monthly, for the rollup. Runs on jobs: the rollup is not a live writer. */
    ensureMonthlyPartitions: (table: string, firstMonth: string, lastMonth: string) =>
        laneQuery<{ ensure_monthly_partitions: number }>('jobs',
            'SELECT ensure_monthly_partitions($1, $2::date, $3::date)',
            [table, firstMonth, lastMonth]),

    /**
     * A query that occupies a lane for a known duration, so admission can be
     * tested without needing a genuinely expensive query to hand.
     *
     * A harness operation, not a product one, but it lives here anyway: rule 1
     * has no exemption for test code, and an escape hatch that exists only for
     * tests is how SQL starts appearing outside the store.
     *
     * Note it sleeps on the HEAVY lane, whose statement_timeout is 30s. A
     * probe longer than that measures the timeout rather than the queue.
     */
    slowProbe: (seconds: number) =>
        laneQuery<{ slept: number }>('heavy',
            'SELECT pg_sleep($1::float8), $1::float8 AS slept', [seconds]),

    /**
     * The same probe on the jobs lane, whose policy is to WAIT (30s ceiling,
     * capacity 2) rather than to refuse.
     *
     * This exists to falsify a specific way the heavy-lane result could be
     * flattering. There, every refusal reports a waitMs equal to the ceiling,
     * which is also exactly what a store that measured its own timeout rather
     * than the queue would report. A lane where the wait SUCCEEDS distinguishes
     * the two: waitMs then has to come back as the real queueing delay, a value
     * nothing in the store knows in advance.
     *
     * Declared as its own operation rather than parameterising the lane,
     * because an operation whose lane is chosen by the caller is not a lane.
     */
    slowProbeQueued: (seconds: number) =>
        laneQuery<{ slept: number }>('jobs',
            'SELECT pg_sleep($1::float8), $1::float8 AS slept', [seconds]),

    // --- the scheduled jobs ---------------------------------------------------

    /**
     * One bounded chunk of rollup, advancing the persisted frontier with it.
     *
     * The frontier is what makes "a missed run self-heals" true rather than
     * aspirational: the window is [through_ts, now) rather than a clock offset,
     * so a skipped run is covered by the next one instead of being lost.
     *
     * settleMinutes holds the ceiling back so the frontier cannot overtake rows
     * that are still committing. It is passed explicitly rather than left to the
     * function's default so that the value appears on the command line of any
     * run that changes it - see roll_up_chunk for why it must never be zero.
     */
    rollUpChunk: (maxHours: number, settleMinutes: number) => laneQuery<{
        hours_written: string; from_ts: Date | null; to_ts: Date | null;
        caught_up: boolean; locked: boolean;
    }>('jobs', 'SELECT * FROM roll_up_chunk($1::int, $2::int)', [maxHours, settleMinutes]),

    /** The rollup frontier and job bookkeeping, for /api/health. */
    /** How many devices there are and when the first was added: the young-
     *  database signal for isFrontierHealthy. A two-row-scan-cheap stand-in
     *  for "when did samples start", which on a big samples table is not. */
    deviceAge: () => laneQuery<{ n: number; first: Date | null }>('jobs', `
        SELECT count(*)::int AS n, min(added_ts) AS first FROM devices`),

    jobState: () => laneQuery<{
        job: string; through_ts: Date | null; last_run_ts: Date | null;
        last_ok_ts: Date | null; runs: string; failures: string;
    }>('jobs', `
        SELECT job, through_ts, last_run_ts, last_ok_ts, runs::text, failures::text
          FROM job_state ORDER BY job`),

    /** Retention. Every guard, and the lock_timeout, are inside the function. */
    retentionRun: (
        table: string, keepDays: number, minKeepDays: number, maxDrop: number,
        minKeep: number, maxSpanDays: number, dryRun: boolean, lockTimeout: string,
    ) => laneQuery<{ action: string; partition_name: string; span_days: number }>('jobs',
        'SELECT * FROM drop_partitions_guarded($1, $2, $3, $4, $5, $6, $7, $8)',
        [table, keepDays, minKeepDays, maxDrop, minKeep, maxSpanDays, dryRun, lockTimeout]),

    // --- inventory export and board drift (slice 11) ---------------------------

    /**
     * The devices an inventory export should carry.
     *
     * NO POSITION JOIN. An earlier version carried each device's current board
     * coordinates so a regenerated CSV would preserve the arrangement -
     * removed once CrossCanvas's import was read rather than assumed: a row
     * with explicit x/y is diverted before zone construction, so shipping
     * coordinates silently costs the zones. See INVENTORY_COLUMNS.
     */
    inventoryForExport: (
        axis: 'location' | 'application', values: string[] | null,
    ) => laneQuery<{
        name: string; sys_name: string | null; host: string; sys_descr: string | null;
        cpu_model: string | null; grouping: string | null;
    }>('interactive', `
        SELECT d.name, d.sys_name, host(d.host) AS host, d.sys_descr, d.cpu_model,
               CASE WHEN $1 = 'location' THEN d.location ELSE d.application END AS grouping
          FROM devices d
         WHERE d.enabled = true
           AND ($2::text[] IS NULL
                OR (CASE WHEN $1 = 'location' THEN d.location ELSE d.application END) = ANY($2))
         ORDER BY d.name`, [axis, values]),

    /**
     * Every device's identifying keys, for resolving an imported layout.
     *
     * Read once and matched in memory rather than one lookup per row: a
     * forty-shape import doing forty queries is the N+1 shape by another name,
     * and the whole roster is 450 rows.
     */
    deviceIdentity: () => laneQuery<{
        name: string; sys_name: string | null; host: string;
    }>('interactive', `
        SELECT name, sys_name, host(host) AS host FROM devices WHERE enabled = true`),

    /**
     * Add one device and all of its entities in ONE statement.
     *
     * A CTE rather than a loop, and not only for the round trips: this is the
     * shape check-write-loops exists to enforce, and an onboarding path that
     * inserted per interface would put 24 statements on a switch and 500 on a
     * chassis. It is also ATOMIC by construction - a device whose entity insert
     * failed halfway would poll forever against a partial interface list, which
     * is worse than not adding it.
     *
     * ON CONFLICT DO NOTHING on the device makes the whole thing idempotent:
     * re-running an onboarding list after fixing two credentials reports the
     * successes as already-known rather than erroring on them. A retry that
     * fails on what already worked is a retry nobody runs.
     *
     * ON CONFLICT THE INCUMBENT IS NAMED, in the same statement (ruling 5,
     * DECISIONS-2026-09-01). "Returns nothing when the name was taken" was
     * this operation's contract for its whole life, and it made two
     * different facts indistinguishable: re-adding a device that genuinely
     * exists, and adding a DIFFERENT host:port whose sysName an existing
     * row already owns. Twelve factory-default switches named `switch`
     * onboarded as one; 1,235 of 1,550 mock devices vanished this way once.
     * The conflict arm returns the incumbent's host and port plus a
     * same_target verdict computed HERE, as inet - devices.host carries an
     * explicit /32 and a text comparison silently misses (the
     * TESTING-BATCHES gotcha). The caller turns the row into "already
     * known" or a refusal that names both parties; src/devices/onboard.ts
     * owns that judgement so the matrix is testable offline.
     *
     * ZERO rows remains possible in exactly one case - the conflicting row
     * was committed after this statement's snapshot, so ON CONFLICT saw it
     * and the SELECT cannot - and the caller falls back to the old generic
     * "already known" for it. A race that narrow degrades to the historic
     * behaviour rather than to a lie.
     */
    insertDeviceWithEntities: (
        name: string, host: string, port: number, version: string, credentialRef: string,
        pollIntervalS: number, sysName: string | null, sysDescr: string | null,
        sysLocation: string | null, uptimeCode: string,
        kinds: string[], indices: string[], names: string[], descrs: Array<string | null>,
        aliases: Array<string | null>, speeds: Array<number | null>, tracked: boolean[],
        codes: string[], extras: Array<string | null>,
    ) => laneQuery<{
        outcome: 'added' | 'conflict'; id: string | null; entities: number | null;
        incumbent_host: string | null; incumbent_port: number | null; same_target: boolean | null;
    }>('interactive', `
        WITH d AS (
            INSERT INTO devices
                (name, host, snmp_port, snmp_version, credential_ref, poll_interval_s,
                 sys_name, sys_descr, sys_location, uptime_code, status, enabled,
                 -- The probe that built this row SAW the device answer
                 -- seconds ago: a sighting, recorded as one, so the
                 -- never-contacted 'pending' arm of deviceStatusSql can be
                 -- exact instead of approximately right.
                 last_seen_ts)
            VALUES ($1, $2::inet, $3, $4, $5, $6, $7, $8, $9, $10, 'up', true, now())
            ON CONFLICT (name) DO NOTHING
            RETURNING id
        ), e AS (
            INSERT INTO entities
                (device_id, kind, snmp_index, name, descr, alias, speed_bps, tracked, code, extra)
            SELECT d.id, t.kind, t.idx, t.nm, t.descr, t.alias, t.speed, t.tracked, t.code, t.extra
              FROM d, unnest($11::text[], $12::text[], $13::text[], $14::text[],
                             $15::text[], $16::bigint[], $17::boolean[], $18::text[],
                             $19::jsonb[])
                   AS t(kind, idx, nm, descr, alias, speed, tracked, code, extra)
            -- THE BACKSTOP, and it was missing while insertEntity has always
            -- had it. A probe returning two entities that share
            -- (kind, snmp_index) violated entities_device_kind_index_idx, and
            -- a unique violation THROWS rather than returning an Outcome - so
            -- nothing caught it, the route answered "internal error", and the
            -- whole statement rolled back leaving the device unadded. One
            -- device with one colliding sensor pair took down the add for
            -- every device after it in the batch.
            --
            -- Sensor indices are namespaced by source (v-, lm-) but one is
            -- derived from the LAST TWO OCTETS of a vendor OID, so two scalars
            -- ending in the same two octets collide by construction. The
            -- caller de-duplicates and REPORTS what it dropped, because
            -- silently losing a sensor is the other way to be wrong; this
            -- clause exists so that no future source of collisions can ever
            -- 500 the onboarding again.
            ON CONFLICT (device_id, kind, snmp_index) WHERE snmp_index IS NOT NULL
                DO NOTHING
            RETURNING 1
        )
        SELECT 'added' AS outcome, d.id::text AS id, (SELECT count(*) FROM e)::int AS entities,
               NULL::text AS incumbent_host, NULL::int AS incumbent_port, NULL::boolean AS same_target
          FROM d
        UNION ALL
        SELECT 'conflict', NULL, NULL, host(inc.host), inc.snmp_port,
               (inc.host = $2::inet AND inc.snmp_port = $3)
          FROM devices inc
         WHERE inc.name = $1 AND NOT EXISTS (SELECT 1 FROM d)`,
        [name, host, port, version, credentialRef, pollIntervalS,
            sysName, sysDescr, sysLocation, uptimeCode,
            kinds, indices, names, descrs, aliases, speeds, tracked, codes, extras]),

    /**
     * Which of these names or addresses are already known, for the report.
     * The port comes back too: a device is its address AND port, and
     * probeStanding (src/devices/onboard.ts) makes that call.
     */
    knownDevices: (names: string[], hosts: string[]) => laneQuery<{
        name: string; host: string; snmp_port: number;
    }>('interactive', `
        SELECT name, host(host) AS host, snmp_port FROM devices
         WHERE name = ANY($1::text[]) OR host = ANY($2::inet[])`, [names, hosts]),

    /**
     * Connection details for NAMED devices, for re-probing.
     *
     * host() rather than host::text for the same reason duePollTargets gives:
     * an inet cast to text keeps its netmask and every SNMP session fails
     * against "10.0.0.5/32".
     */
    devicesByName: (names: string[]) => laneQuery<{
        id: string; name: string; host: string; snmp_port: number;
        snmp_version: string; credential_ref: string;
    }>('interactive', `
        SELECT id::text AS id, name, host(host) AS host, snmp_port, snmp_version, credential_ref
          FROM devices WHERE name = ANY($1::text[]) ORDER BY name`, [names]),

    /**
     * Re-apply a tracking decision to entities that already exist.
     *
     * ONE STATEMENT FOR THE WHOLE DEVICE, unnesting three parallel arrays,
     * rather than a statement per entity - a 48-port switch is one write.
     *
     * `IS DISTINCT FROM` is what makes this reportable rather than merely
     * idempotent: only rows whose decision actually CHANGED are updated and
     * returned, so the caller can say "9 interfaces stopped being tracked"
     * instead of "48 entities considered". A no-op rediscover returns zero
     * rows and writes nothing, which also means it assigns no transaction id
     * and costs no WAL.
     */
    /**
     * The per-entity track toggle, keyed by CODE - the one identity every
     * entity row always carries. The route used to funnel through
     * retrackEntities and match on snmp_index, which a parked row (the
     * planner's eviction, snmp_index NULL) cannot satisfy: the untrack
     * reported success and changed nothing (afternoon audit, finding 9).
     * IS DISTINCT FROM keeps the no-change case a zero-row answer the
     * caller can name.
     */
    setEntitiesTrackedByCode: (
        deviceId: string, codes: string[], tracked: boolean[],
    ) => laneQuery<{ name: string; kind: string; tracked: boolean }>('collector', `
        UPDATE entities e
           SET tracked = v.tracked
          FROM (SELECT unnest($2::text[]) AS code, unnest($3::boolean[]) AS tracked) v
         WHERE e.device_id = $1::bigint AND e.code = v.code
           AND e.tracked IS DISTINCT FROM v.tracked
     RETURNING e.name, e.kind, e.tracked`, [deviceId, codes, tracked]),

    retrackEntities: (
        deviceId: string, kinds: string[], indexes: string[], tracked: boolean[],
    ) => laneQuery<{ name: string; kind: string; tracked: boolean }>('collector', `
        UPDATE entities e
           SET tracked = v.tracked
          FROM (SELECT unnest($2::text[]) AS kind,
                       unnest($3::text[]) AS snmp_index,
                       unnest($4::boolean[]) AS tracked) v
         WHERE e.device_id = $1::bigint
           AND e.kind = v.kind AND e.snmp_index = v.snmp_index
           AND e.tracked IS DISTINCT FROM v.tracked
     RETURNING e.name, e.kind, e.tracked`,
    [deviceId, kinds, indexes, tracked]),

    /**
     * Distinct location strings that are suspiciously similar to each other.
     *
     * Past about a dozen devices the COUNT stops being enough: one typo makes
     * "Building 3" and "Buidling 3" two values that read as one to anybody
     * scanning a list, and the operator accepts 18 locations believing there
     * are 17. So the near-misses are pointed at rather than left to be found.
     *
     * pg_trgm is already installed and already load-bearing - it is what
     * free-text search runs on - so this is an existing mechanism applying to
     * a second problem rather than a new dependency. O(n^2) over DISTINCT
     * values, which is a handful even for a large fleet.
     *
     * TRIGRAM SIMILARITY ALONE GETS THIS EXACTLY BACKWARDS, and the fixture
     * proved it rather than hiding it. Measured on the real fleet's four
     * values: SIX of six flagged pairs were siblings - "Lab / Rack 1" against
     * "Lab / Rack 2" scores 0.69 - while the actual transposition typo,
     * "Building 3" against "Buidling 3", scores 0.47 and fell BELOW the
     * threshold. A hundred percent false positives and a miss on the only
     * case the feature exists for.
     *
     * The reason is structural: a transposition destroys several trigrams at
     * once, while a differing digit destroys one. So similarity ranks the
     * legitimate pattern - Floor 1, Floor 2, Rack 3 - above the mistake.
     *
     * THE DISCRIMINATOR IS DIGITS. Strip them and compare: if two values are
     * identical apart from numbers, they are SIBLINGS and must never be
     * offered as a typo. With those excluded the threshold can drop to where
     * transpositions actually live, because the main source of
     * high-similarity-but-correct pairs is gone.
     *
     * levenshtein() would be the textbook tool and fuzzystrmatch is available
     * but not installed. It is not needed: the evidence says digit-stripping
     * plus a lower trigram threshold separates these cleanly, and that avoids
     * adding an extension to a codebase whose posture is PG-native with
     * pg_trgm already earning its place.
     */
    locationNearMisses: (values: string[]) => laneQuery<{
        a: string; b: string; sim: number;
    }>('interactive', `
        SELECT a.v AS a, b.v AS b, round(similarity(a.v, b.v)::numeric, 2)::float8 AS sim
          FROM unnest($1::text[]) AS a(v), unnest($1::text[]) AS b(v)
         WHERE a.v < b.v
           AND similarity(a.v, b.v) > 0.40
           -- Siblings, not typos: identical once the numbers are removed.
           AND regexp_replace(a.v, '[0-9]+', '#', 'g')
               <> regexp_replace(b.v, '[0-9]+', '#', 'g')
         ORDER BY sim DESC
         LIMIT 20`, [values]),

    /** Set location on devices just added, from an accepted suggestion. */
    applyLocationToDevices: (names: string[], location: string) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET location = NULLIF(btrim($2), '')
         WHERE name = ANY($1::text[]) RETURNING name`, [names, location]),

    /** The same, for APPLICATION (slice 30). Location arrives suggested by
     *  the devices themselves (sysLocation); application never can - nothing
     *  on a device knows it serves Exchange - so it is typed once for the
     *  batch at add time instead of visited per device afterwards. */
    applyApplicationToDevices: (names: string[], application: string) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET application = NULLIF(btrim($2), '')
         WHERE name = ANY($1::text[]) RETURNING name`, [names, application]),

    /** Bulk transient (slice 30): the roster's answer to visiting six device
     *  pages to flip one boolean six times. */
    setTransientForDevices: (names: string[], transient: boolean) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET transient = $2
         WHERE name = ANY($1::text[]) RETURNING name`, [names, transient]),

    /** Mute or unmute devices' alerts (slice 54): one device from its page,
     *  a selection from the roster - the same statement either way. */
    setMutedForDevices: (names: string[], muted: boolean) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET alerts_muted = $2
         WHERE name = ANY($1::text[]) RETURNING name`, [names, muted]),

    /**
     * The write path reach_check waited for (DECISIONS-2026-09-01 ruling 6):
     * the column dispatched and alarmed since 2026-08-31 and could still
     * only be set by direct SQL - the opt-out for an ICMP-blocked agent
     * existed in the schema and was unreachable by the product. The ROUTE
     * validates the value against SUPPORTED_CHECKS plus 'none' (one source
     * of truth, imported from reach.ts), so this op trusts its input the
     * way its siblings do.
     */
    setDevicesReachCheck: (names: string[], check: string, port: number | null) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET reach_check = $2, reach_port = $3
         WHERE name = ANY($1::text[]) RETURNING name`, [names, check, port]),

    /**
     * The refusal check for reach_check = 'none' on ping-only devices: a
     * device with snmp_enabled = false has no poll, so reach IS its status
     * (slice 35's whole point), and 'none' would leave it monitored by
     * nothing while rendering as its last state forever. The route refuses
     * the whole request naming these rather than partially applying - a
     * bulk action that silently skips some of its selection is the
     * "already known" ambiguity wearing a different hat.
     */
    pingOnlyAmong: (names: string[]) => laneQuery<{ name: string }>(
        'interactive', `
        SELECT name FROM devices
         WHERE name = ANY($1::text[]) AND NOT snmp_enabled
         ORDER BY name`, [names]),

    /**
     * Point NAMED devices at a credential reference - a profile name or an env
     * var name. ONE statement for the whole selection, RETURNING the names it
     * actually changed so the caller can say which of forty were already
     * there. Does not validate that the reference resolves: a device pointed
     * at a name nobody defined refuses to poll BY NAME on its next slot, which
     * is loud, immediate and reversible - and the route checks resolvability
     * first anyway so the operator is warned before the click lands.
     */
    setDevicesCredential: (names: string[], ref: string) => laneQuery<{ name: string }>('interactive', `
        UPDATE devices SET credential_ref = $2
         WHERE name = ANY($1::text[]) AND credential_ref IS DISTINCT FROM $2
     RETURNING name`, [names, ref]),

    // --- bulk removal (U6) -----------------------------------------------------

    /**
     * What removing these devices would actually do. ONE statement.
     *
     * NOTE WHAT IS NOT COUNTED: samples. `samples` carries no foreign key to
     * entities - deliberately, on a 249-million-row partitioned table where an
     * FK would cost an index check per insert on the hot path - so nothing
     * forces their deletion, and nothing should. A DELETE over 17 partitions
     * filtered by entity_id prunes on nothing and would scan the corpus.
     *
     * So the rows stay and age out with retention, and the GATE SAYS SO rather
     * than reporting a number. That is the more useful answer as well as the
     * cheaper one: "2.3M samples" invites the reading that disk comes back
     * today, and it does not.
     */
    previewDeviceRemoval: (names: string[]) => laneQuery<{
        name: string; exists: boolean; enabled: boolean; entities: string; shapes: string;
        boardIds: string[];
    }>('interactive', `
        SELECT n AS name,
               d.id IS NOT NULL AS exists,
               COALESCE(d.enabled, false) AS enabled,
               COALESCE((SELECT count(*) FROM entities e WHERE e.device_id = d.id), 0)::text AS entities,
               -- Shapes that would stop binding, and on which boards. This is
               -- the consequence nobody predicts, and the drift machinery
               -- already knows how to look for it.
               COALESCE((SELECT count(*) FROM boards b,
                                jsonb_array_elements(COALESCE(b.doc->'shapes','[]'::jsonb)) sh
                          WHERE sh->>'bind' = n), 0)::text AS shapes,
               -- The board IDS, not a per-device count. Two selected devices
               -- pinned to the same board are ONE board losing two shapes, and
               -- only the caller sees the whole selection, so only the caller
               -- can union them. Returning a count per row invites the sum,
               -- which is wrong, and the previous consumer did something worse
               -- with it - see planRemoval.
               COALESCE((SELECT array_agg(DISTINCT b.id::text) FROM boards b,
                                jsonb_array_elements(COALESCE(b.doc->'shapes','[]'::jsonb)) sh
                          WHERE sh->>'bind' = n), '{}')  AS "boardIds"
          FROM unnest($1::text[]) AS n
          LEFT JOIN devices d ON d.name = n
         ORDER BY n`, [names]),

    /**
     * Stop watching, keep everything. The reversible verb, and the default.
     *
     * `enabled = false` already gates the poller and the alert scan's arming
     * rule, so this is not a new mechanism - it is the one the schema already
     * had, finally reachable from the UI.
     */
    disableDevices: (names: string[], enabled: boolean) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET enabled = $2 WHERE name = ANY($1::text[]) RETURNING name`,
        [names, enabled]),

    /**
     * Delete for real: entities first, then the devices, in one statement.
     *
     * entities -> devices is NO ACTION rather than CASCADE, so the order is
     * forced. A CTE keeps it atomic - a half-deleted device whose entities
     * went but whose row stayed would be polled forever against nothing.
     *
     * Samples are deliberately untouched; see previewDeviceRemoval.
     */
    deleteDevices: (names: string[]) => laneQuery<{ name: string }>('interactive', `
        WITH target AS (SELECT id, name FROM devices WHERE name = ANY($1::text[])),
             gone AS (DELETE FROM entities WHERE device_id IN (SELECT id FROM target) RETURNING 1)
        DELETE FROM devices WHERE id IN (SELECT id FROM target) RETURNING name`, [names]),

    /** Delete a board. Its tokens cascade, which revokes its displays. */
    deleteBoard: (id: string) => laneQuery('interactive',
        'DELETE FROM boards WHERE id = $1::bigint', [id]),

    /**
     * What a board declares itself to be a picture of.
     *
     * Slice 41 widened this from ONE value to a LIST - the thing slice 27
     * made boards capable of, which this statement had never caught up with.
     * Until it did, the only way to reorder a team board's sections (and
     * declared order IS section order on the wall) was to build a new board,
     * which meant a new id, which revoked every display token pointed at the
     * old one. A steep price for moving "Basement" above "First Floor".
     *
     * Deliberately does NOT touch the board document, because the route above
     * it never did either. A HAND-DRAWN board may declare a group purely so
     * the drift check has something to check, and regenerating its shapes
     * would throw away the placement that made it hand-drawn. Changing the
     * declaration and changing the picture are two acts, and this is the
     * first one.
     *
     * The legacy single column keeps carrying the FIRST value, exactly as
     * createBoard leaves it, so readers built before slice 27 stay truthful
     * about the single-group boards they were built to understand.
     */
    setBoardSource: (id: string, axis: string | null, values: string[] | null) =>
        laneQuery('interactive', `
        UPDATE boards SET source_axis = $2, source_value = $3,
               source_values = $4::jsonb,
               updated_ts = now()
         WHERE id = $1::bigint`,
        [id, axis, values === null ? null : values[0] ?? null,
            values === null ? null : JSON.stringify(values)]),

    /**
     * Board drift, BOTH DIRECTIONS.
     *
     * "3 devices at HQ are not on this board" is the obvious half. The other
     * half matters as much and is easier to forget: a device ON the board that
     * has since moved to another location, or been deleted, is a shape that
     * lies. A wall claiming to be a picture of HQ while showing a switch that
     * left last month is exactly the silent-partial-coverage failure that
     * killed board-based suppression.
     *
     * Boards with no recorded source return nothing - a hand-drawn board is
     * not supposed to contain any particular set, so nothing can be missing
     * from it. That is a real answer, not an empty one.
     */
    boardDrift: (boardId: string) => laneQuery<{
        missing: string; extra: string; missing_names: string[]; extra_names: string[];
        broken: string; broken_names: string[];
    }>('interactive', `
        WITH b AS (SELECT source_axis, source_values, doc FROM boards WHERE id = $1::bigint),
        -- BROKEN BINDINGS, and these are NOT gated on a declared source.
        --
        -- A shape pointing at a device that no longer exists is wrong on ANY
        -- board, hand-drawn or generated - it is a box on a wall that can
        -- never light up. The group-drift counts above answer "is this still
        -- a picture of its group", which only a sourced board can be asked;
        -- this answers "does every shape still point at something", which
        -- every board can.
        --
        -- Found by deleting a device: the removal gate promised "1 shape will
        -- stop binding" and then nothing in the system reported that it had,
        -- because the board had no source. A gate that names a consequence
        -- nothing afterwards can see is only half a warning.
        brk AS (
            SELECT DISTINCT sh->>'bind' AS name
              FROM b, jsonb_array_elements(COALESCE(b.doc->'shapes','[]'::jsonb)) sh
             WHERE sh->>'bind' IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.name = sh->>'bind')
        ),
        bound AS (
            SELECT DISTINCT s->>'bind' AS name
              FROM b, jsonb_array_elements(COALESCE(b.doc->'shapes', '[]'::jsonb)) s
             -- THE SOURCE GUARD BELONGS ON BOTH SIDES, and leaving it off here
             -- was a real bug caught by running it: with the should CTE empty for a
             -- sourceless board, every drawn device fell out of the FULL OUTER
             -- JOIN as "extra", so a hand-drawn diagram reported all of its own
             -- contents as devices that should not be there. Gating both CTEs
             -- makes the join empty, and empty is the honest answer - a board
             -- that never declared a group cannot have strays any more than it
             -- can have gaps.
             WHERE b.source_axis IS NOT NULL AND s->>'bind' IS NOT NULL
        ),
        should AS (
            -- Slice 27: the declared set is a LIST (or NULL = every value,
            -- the all-fleet board). An undeclared group is not a question -
            -- the team-board insight that unskipped this feature.
            SELECT d.name FROM devices d, b
             WHERE b.source_axis IS NOT NULL AND d.enabled = true
               AND (b.source_values IS NULL
                    OR (CASE WHEN b.source_axis = 'location' THEN d.location ELSE d.application END)
                       IN (SELECT jsonb_array_elements_text(b.source_values)))
        )
        SELECT count(*) FILTER (WHERE bound.name IS NULL)::text AS missing,
               count(*) FILTER (WHERE should.name IS NULL)::text AS extra,
               COALESCE(array_agg(should.name) FILTER (WHERE bound.name IS NULL), '{}') AS missing_names,
               COALESCE(array_agg(bound.name)  FILTER (WHERE should.name IS NULL), '{}') AS extra_names,
               (SELECT count(*) FROM brk)::text AS broken,
               COALESCE((SELECT array_agg(name) FROM brk), '{}') AS broken_names
          FROM should FULL OUTER JOIN bound ON bound.name = should.name`, [boardId]),

    /**
     * Everything the reconcile route needs about one board, in one read
     * (DECISIONS-2026-09-01 ruling 8): the declaration - only a sourced
     * board can be reconciled against its group - and the document the
     * verbs edit. grid_cols rides along for the report; placement does not
     * branch on it, because appended shapes go below the drawing either way
     * and the glance grid ignores coordinates entirely.
     */
    boardForReconcile: (id: string) => laneQuery<{
        name: string; source_axis: string | null; source_values: unknown;
        grid_cols: number | null; doc: Record<string, unknown> | null;
    }>('interactive', `
        SELECT name, source_axis, source_values, grid_cols, doc
          FROM boards WHERE id = $1::bigint`, [id]),

    // --- device grouping: location and application (slice 11) ------------------

    /**
     * THE ONLY WRITE PATH FOR location AND application, and its narrowness is
     * the design.
     *
     * These are operator-assigned. `sys_location` sits on the same table and
     * is SNMP-reported - the monitored device controls it - so no machine path
     * may reach these columns, or a device could choose which group its own
     * outage is counted in. One op, one caller, pinned by
     * tools/check-call-sites.mjs so it stays true after the comment stops
     * being read.
     *
     * Empty string is normalised to NULL rather than stored: "" and NULL would
     * both render as ungrouped while grouping as two different buckets, and a
     * device that silently forms its own group of one is exactly the sort of
     * quiet wrongness this codebase keeps finding.
     */
    /**
     * Rename a device, carrying the name across EVERY table keyed by it in
     * one statement: alerts.host (and the device-down key, which embeds
     * the name), and threshold_overrides.host for host-scoped overrides.
     * Entities, samples, reachability events and boards bind by id or code
     * and do not move. messages.host is the syslog-reported hostname, not a
     * device key, and is deliberately untouched.
     *
     * Without the alert carry an open alert would lose its readings on the
     * next scan and age out as source-removed - a rename reported as an
     * outage ending. The EXISTS guards make the secondary updates no-ops
     * when the device row was not found, so the caller reads renamed=0 and
     * nothing else changed.
     */
    /**
     * Rename a device and carry EVERY row that hangs on its name.
     *
     * The 2026-09-01 review's finding 7: this carried alerts and threshold
     * overrides and silently left three more name-keyed rows behind - a
     * maintenance window scoped to the device stopped withholding
     * notification, a notify policy scoped to it stopped applying, and every
     * board shape bound to it drew a tile for a device that no longer
     * existed. Each is a quiet failure that shows up as "the thing I set
     * up stopped working" days later. All five travel in ONE statement, so
     * a rename is either whole or refused.
     *
     * Board shapes bind by `bind` (boards/reconcile.ts), and their `label`
     * is the operator's to edit - it is carried only where it still equals
     * the old name, so a label somebody changed stays theirs. A notify
     * policy already standing for the NEW name makes the statement fail on
     * that table's UNIQUE (scope, target); the route turns that into a 409
     * rather than dropping either policy.
     */
    renameDevice: (from: string, to: string) =>
        laneQuery<{ renamed: number; alerts: number; overrides: number;
                    windows: number; policies: number; boards: number }>('interactive', `
        WITH d AS (
            UPDATE devices SET name = $2 WHERE name = $1 RETURNING id
        ), a AS (
            UPDATE alerts
               SET host = $2,
                   alert_key = CASE WHEN alert_key = 'device:' || $1
                                    THEN 'device:' || $2 ELSE alert_key END
             WHERE host = $1 AND EXISTS (SELECT 1 FROM d)
            RETURNING 1
        ), t AS (
            UPDATE threshold_overrides SET host = $2
             WHERE host = $1 AND EXISTS (SELECT 1 FROM d)
            RETURNING 1
        ), w AS (
            UPDATE maintenance_windows SET target = $2
             WHERE scope = 'device' AND target = $1 AND EXISTS (SELECT 1 FROM d)
            RETURNING 1
        ), p AS (
            UPDATE notify_policy SET target = $2
             WHERE scope = 'device' AND target = $1 AND EXISTS (SELECT 1 FROM d)
            RETURNING 1
        ), b AS (
            UPDATE boards
               SET doc = jsonb_set(doc, '{shapes}', (
                       SELECT jsonb_agg(
                                CASE WHEN s->>'bind' = $1
                                     THEN jsonb_set(
                                            CASE WHEN s->>'label' = $1
                                                 THEN jsonb_set(s, '{label}', to_jsonb($2::text))
                                                 ELSE s END,
                                            '{bind}', to_jsonb($2::text))
                                     ELSE s END
                                ORDER BY ord)
                         FROM jsonb_array_elements(doc->'shapes') WITH ORDINALITY AS t(s, ord))),
                   updated_ts = now()
             WHERE jsonb_typeof(doc->'shapes') = 'array'
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(doc->'shapes') s WHERE s->>'bind' = $1)
               AND EXISTS (SELECT 1 FROM d)
            RETURNING 1
        )
        SELECT (SELECT count(*) FROM d)::int AS renamed,
               (SELECT count(*) FROM a)::int AS alerts,
               (SELECT count(*) FROM t)::int AS overrides,
               (SELECT count(*) FROM w)::int AS windows,
               (SELECT count(*) FROM p)::int AS policies,
               (SELECT count(*) FROM b)::int AS boards`, [from, to]),

    /**
     * Move a device to a new address, and optionally a new SNMP port.
     *
     * Until 2026-09-15 there was no way to do this short of delete and
     * re-add, which discards the device's history - the one gap on the
     * release list a forker could not work around. Nothing else keys on the
     * address: polls read host(host) on every dispatch, the reach sweep
     * reads the fleet on every pass, entities hang on device_id. So the
     * move is one UPDATE, plus the reset that makes it take effect NOW
     * rather than after the old address's failures play out: the failure
     * count returns to zero so the device is not classed down for a place
     * it no longer is, last_poll_ts is cleared so the scheduler's NULLS
     * FIRST ordering polls it on the next tick, and the reach state returns
     * to unknown for the sweep to re-establish. Syslog already received
     * under the old address stays under it - that is where it came from.
     */
    setDeviceAddress: (name: string, host: string, port: number | null) =>
        laneQuery<{ id: string; host: string; snmp_port: number }>('interactive', `
        UPDATE devices
           SET host = $2::inet,
               snmp_port = COALESCE($3::int, snmp_port),
               consecutive_failures = 0,
               last_poll_ts = NULL,
               reach_state = 'unknown'
         WHERE name = $1
        RETURNING id::text AS id, host(host) AS host, snmp_port`, [name, host, port]),

    setDeviceGrouping: (name: string, location: string | null, application: string | null) =>
        laneQuery<{ name: string }>('interactive', `
        UPDATE devices
           SET location    = NULLIF(btrim(COALESCE($2, '')), ''),
               application = NULLIF(btrim(COALESCE($3, '')), '')
         WHERE name = $1
        RETURNING name`, [name, location, application]),

    /**
     * Distinct values for one axis, with how many devices carry each.
     *
     * Ungrouped devices are returned as their own row with a NULL value rather
     * than omitted, because "38 devices have no location" is the number that
     * tells an operator whether a location board would be worth making. An
     * axis summary that silently drops the untagged reports better coverage
     * than exists, which is the blind-instrument shape.
     *
     * The axis is NOT interpolated: it selects between two fixed expressions.
     * A column name arriving from a query string and reaching SQL by string
     * concatenation is how this would otherwise go wrong.
     *
     * down is judged by deviceStatusSql - the ONE definition (slice 35) -
     * never raw status. A ping-only device (snmp_enabled = false) has no poll
     * to write status, so counting the raw column reads a dark External group
     * as 0 down forever. This was the last reader still doing that.
     */
    deviceGroupCounts: (axis: 'location' | 'application') =>
        laneQuery<{ value: string | null; devices: string; down: string }>('interactive', `
        SELECT CASE WHEN $1 = 'location' THEN d.location ELSE d.application END AS value,
               count(*)::text AS devices,
               count(*) FILTER (WHERE ${deviceStatusSql('d')} = 'down')::text AS down
          FROM devices d
         GROUP BY 1
         ORDER BY 1 NULLS LAST`, [axis]),

    /**
     * WHAT RETENTION WOULD DO RIGHT NOW - asked of the function that will
     * actually do it, never recomputed alongside it.
     *
     * The eligibility rule is NOT "older than keep_days". A partition is kept
     * until its UPPER bound clears the cutoff, so a day-partition dated D
     * survives until D + keep_days + 1. I have already got this wrong once,
     * in SOAK-CRITERIA, by reasoning from the phrase "8-day retention"
     * instead of reading the installed predicate - every date in a published
     * staircase was a day early. A page that re-derived the rule would ship
     * that same off-by-one to operators, and it would be believed, because a
     * confident date looks like a fact.
     *
     * So this asks `drop_partitions_guarded` itself, in dry-run, and renders
     * the `would-drop` rows it returns. It also inherits every guard for
     * free: the floor, the per-run cap, the minimum-partitions rule, the
     * span check and the rollup deferral all report through the same `action`
     * column, so the preview shows the REFUSALS too rather than a naive list
     * of old partitions the guards would never have let go.
     *
     * DRY RUN IS NOT A PARAMETER HERE, AND THAT IS THE POINT. It is written
     * true at this call site, so there is no query string, body field or
     * typo anywhere above this line that can turn a preview into a drop. The
     * HTTP surface cannot express the destructive call at all - which is a
     * structural fix, not a guard on top of one.
     *
     * ONE INTERFERENCE NOTE, because it decides how the UI may call this: the
     * function takes a transaction-scoped advisory lock, and the real hourly
     * run uses `pg_try_advisory_xact_lock`. A preview holding that lock makes
     * a concurrent real run report 'skipped-locked' and wait for the next
     * hour. Harmless once; a dashboard POLLING this could starve retention
     * indefinitely. It is therefore an explicit operator action, never part
     * of a refresh loop - see the admin page.
     */
    retentionPreview: (
        table: string, keepDays: number, minKeepDays: number, maxDrop: number,
        minKeep: number, maxSpanDays: number, lockTimeout: string,
    ) => laneQuery<{ action: string; partition_name: string; span_days: number }>('interactive',
        'SELECT * FROM drop_partitions_guarded($1, $2, $3, $4, $5, $6, true, $7)',
        [table, keepDays, minKeepDays, maxDrop, minKeep, maxSpanDays, lockTimeout]),

    /**
     * The partition inventory for the admin page: sizes, row estimates and
     * trigram coverage, on the INTERACTIVE lane rather than jobs. Same query
     * the soak baseline uses, which is the convergence thesis applied to
     * instrumentation - the measurement columns become the product's admin
     * surface instead of a parallel implementation that can disagree with it.
     */
    uiPartitions: () => laneQuery<{
        parent: string; partition_name: string; est_rows: string;
        bytes: string; pretty: string; has_trgm: boolean; has_host_trgm: boolean;
    }>('interactive', `
        SELECT parent.relname AS parent,
               c.relname AS partition_name,
               c.reltuples::bigint::text AS est_rows,
               pg_total_relation_size(c.oid)::text AS bytes,
               pg_size_pretty(pg_total_relation_size(c.oid)) AS pretty,
               to_regclass(c.relname || '_msg_trgm')  IS NOT NULL AS has_trgm,
               to_regclass(c.relname || '_host_trgm') IS NOT NULL AS has_host_trgm
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
          JOIN pg_class parent ON parent.oid = i.inhparent
         WHERE parent.relkind = 'p'
         ORDER BY parent.relname, c.relname`),

    /** What each background job last did, for "what did it do last night". */
    uiJobState: () => laneQuery<{
        job: string; through_ts: Date | null; last_run_ts: Date | null;
        last_ok_ts: Date | null; runs: string; failures: string; detail: unknown;
    }>('interactive', `
        SELECT job, through_ts, last_run_ts, last_ok_ts,
               runs::text, failures::text, detail
          FROM job_state ORDER BY job`),

    /**
     * Record one job's outcome so it survives a restart.
     *
     * The in-memory record the health page reads is lost on every deploy, and
     * "what did retention do last night" is exactly the question asked the
     * morning after a restart. job_state already had last_run_ts, last_ok_ts,
     * runs, failures and detail - built for this and used by one job, for one
     * column. Nothing new needed building; an existing mechanism finally
     * applies.
     *
     * `through_ts` is deliberately untouched: it is the rollup's frontier and
     * has a different owner. COALESCE on runs/failures rather than assignment
     * so a job that starts recording mid-life does not reset the rollup's
     * counters if the names ever collide.
     */
    recordJobRun: (job: string, ok: boolean, detail: string) => laneQuery('jobs', `
        INSERT INTO job_state (job, last_run_ts, last_ok_ts, runs, failures, detail)
        VALUES ($1, now(), CASE WHEN $2 THEN now() END, 1, CASE WHEN $2 THEN 0 ELSE 1 END,
                jsonb_build_object('last', $3::text))
        ON CONFLICT (job) DO UPDATE
           SET last_run_ts = now(),
               last_ok_ts  = CASE WHEN $2 THEN now() ELSE job_state.last_ok_ts END,
               runs        = job_state.runs + 1,
               failures    = job_state.failures + CASE WHEN $2 THEN 0 ELSE 1 END,
               detail      = jsonb_build_object('last', $3::text)`, [job, ok, detail]),

    // --- boards and capability tokens (slice 8 / U5) ---------------------------
    //
    // Every one of these is shaped by BOARD-EXPOSURE.md. Read that first; the
    // comments here say which clause a given decision serves rather than
    // restating the reasoning.

    /** Boards for the admin UI. Never reachable by a display principal. */
    uiBoards: () => laneQuery<{
        id: string; name: string; collection: string; owner: string | null;
        show_addresses: boolean; created_ts: Date; updated_ts: Date;
        grid_cols: number | null; grid_fields: unknown;
        tokens: string; live_tokens: string;
        source_axis: string | null; source_value: string | null;
        source_values: unknown;
        missing: string; extra: string; broken: string;
    }>('interactive', `
        SELECT b.id::text AS id, b.name, b.collection, u.username AS owner,
               b.show_addresses, b.created_ts, b.updated_ts,
               b.grid_cols, COALESCE(b.grid_fields, '[]'::jsonb) AS grid_fields,
               b.source_values,
               count(t.id)::text AS tokens,
               count(t.id) FILTER (WHERE t.revoked_ts IS NULL)::text AS live_tokens,
               b.source_axis, b.source_value,
               -- DRIFT COMES BACK WITH THE LIST, not one request per board.
               -- The page shows every board at once, so a per-board fetch is
               -- the N+1 shape this codebase has now removed four times - and
               -- at eight boards nobody would notice it, which is exactly how
               -- the parent's 5,200-query device page happened.
               COALESCE(dr.missing, 0)::text AS missing,
               COALESCE(dr.extra, 0)::text AS extra,
               COALESCE(dr.broken, 0)::text AS broken
          FROM boards b
          LEFT JOIN users u ON u.id = b.owner_id
          LEFT JOIN board_tokens t ON t.board_id = b.id
          LEFT JOIN LATERAL (
              WITH bound AS (
                  SELECT DISTINCT s->>'bind' AS name
                    FROM jsonb_array_elements(COALESCE(b.doc->'shapes', '[]'::jsonb)) s
                   WHERE b.source_axis IS NOT NULL AND s->>'bind' IS NOT NULL
              ),
              should AS (
                  SELECT d.name FROM devices d
                   WHERE b.source_axis IS NOT NULL AND d.enabled = true
                     AND (b.source_values IS NULL
                          OR (CASE WHEN b.source_axis = 'location' THEN d.location ELSE d.application END)
                             IN (SELECT jsonb_array_elements_text(b.source_values)))
              )
              SELECT count(*) FILTER (WHERE bound.name IS NULL) AS missing,
                     count(*) FILTER (WHERE should.name IS NULL) AS extra,
                     (SELECT count(*) FROM (
                          SELECT DISTINCT sh->>'bind' AS n
                            FROM jsonb_array_elements(COALESCE(b.doc->'shapes','[]'::jsonb)) sh
                           WHERE sh->>'bind' IS NOT NULL
                             AND NOT EXISTS (SELECT 1 FROM devices d2 WHERE d2.name = sh->>'bind')
                      ) x) AS broken
                FROM should FULL OUTER JOIN bound ON bound.name = should.name
          ) dr ON true
         GROUP BY b.id, u.username, dr.missing, dr.extra, dr.broken
         ORDER BY b.collection, b.name`),

    createBoard: (
        name: string, collection: string, ownerId: number | null,
        sourceAxis: string | null, sourceValues: string[] | null,
    ) => laneQuery<{ id: string }>('interactive', `
        INSERT INTO boards (name, collection, owner_id, source_axis, source_value, source_values)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id::text AS id`,
        [name, collection, ownerId, sourceAxis,
            // The legacy column keeps carrying the first value - old readers
            // stay truthful for single-group boards, which is all they knew.
            sourceValues === null ? null : sourceValues[0] ?? null,
            sourceValues === null ? null : JSON.stringify(sourceValues)]),

    /** What a board declares itself to be a picture of, for the export. */
    boardSource: (id: string) => laneQuery<{ source_axis: string | null; source_values: unknown }>(
        'interactive',
        'SELECT source_axis, source_values FROM boards WHERE id = $1::bigint', [id]),

    setBoardAddresses: (id: string, show: boolean) => laneQuery('interactive', `
        UPDATE boards SET show_addresses = $2, updated_ts = now()
         WHERE id = $1::bigint`, [id, show]),

    /** Slice 26: the grid declaration - cols null turns the grid off and the
     *  stored field list is kept (turning it back on restores the choices). */
    setBoardGrid: (id: string, cols: number | null, fieldsJson: string | null) => laneQuery(
        'interactive', `
        UPDATE boards SET grid_cols = $2,
               grid_fields = COALESCE($3::jsonb, grid_fields),
               updated_ts = now()
         WHERE id = $1::bigint`, [id, cols, fieldsJson]),

    /**
     * Tokens for one board, WITHOUT the hash.
     *
     * The hash is not secret in the way the token is, but there is no reason
     * for it to cross the HTTP boundary and every reason not to build the
     * habit: the one place a token value is ever knowable is the moment it is
     * minted, and it is returned from mintToken and never stored in the clear.
     */
    boardTokens: (boardId: string) => laneQuery<{
        id: string; label: string; created_ts: Date; created_by: string | null;
        last_used_ts: Date | null; revoked_ts: Date | null; revoked_by: string | null;
    }>('interactive', `
        SELECT t.id::text AS id, t.label, t.created_ts, c.username AS created_by,
               t.last_used_ts, t.revoked_ts, r.username AS revoked_by
          FROM board_tokens t
          LEFT JOIN users c ON c.id = t.created_by
          LEFT JOIN users r ON r.id = t.revoked_by
         WHERE t.board_id = $1::bigint
         ORDER BY t.revoked_ts NULLS FIRST, t.created_ts DESC`, [boardId]),

    mintToken: (boardId: string, hash: string, label: string, byId: number | null) =>
        laneQuery<{ id: string }>('interactive', `
        INSERT INTO board_tokens (board_id, token_hash, label, created_by)
        VALUES ($1::bigint, $2, $3, $4) RETURNING id::text AS id`,
        [boardId, hash, label, byId]),

    /**
     * Revoke. Idempotent by the NULL check rather than by blind assignment, so
     * a second revoke does not overwrite who revoked it first - after an
     * incident, the first revoker is the fact worth keeping.
     */
    revokeToken: (id: string, byId: number | null) => laneQuery<{ id: string }>('interactive', `
        UPDATE board_tokens SET revoked_ts = now(), revoked_by = $2
         WHERE id = $1::bigint AND revoked_ts IS NULL
        RETURNING id::text AS id`, [id, byId]),

    /**
     * Resolve a presented token to its board. THE ONLY WAY A DISPLAY BECOMES A
     * PRINCIPAL.
     *
     * Note what is NOT a parameter: the board id. It comes back FROM the
     * token, so a display cannot name the board it wants - clause 2. And the
     * revoked check is in the WHERE clause rather than applied after, because
     * a revoked token must not even produce a row to reason about.
     *
     * Looked up by hash, so the plaintext never reaches the database and a
     * query log cannot leak a live credential.
     */
    resolveToken: (hash: string) => laneQuery<{
        token_id: string; board_id: string; label: string;
        board_name: string; collection: string; show_addresses: boolean;
    }>('interactive', `
        SELECT t.id::text AS token_id, b.id::text AS board_id, t.label,
               b.name AS board_name, b.collection, b.show_addresses
          FROM board_tokens t JOIN boards b ON b.id = t.board_id
         WHERE t.token_hash = $1 AND t.revoked_ts IS NULL`, [hash]),

    /**
     * Mark a token used - COARSELY, and deliberately not on every render.
     *
     * A wall display polls. Writing last_used_ts on each poll would be one
     * UPDATE per display per interval forever, which is the write-amplification
     * shape this codebase has now removed three times (and the reason job
     * outcomes are only persisted for jobs slower than a minute). The WHERE
     * clause makes the write conditional on the stored value being stale, so a
     * steadily-polling display writes once an hour and a transaction that
     * changes no rows assigns no XID and writes no WAL.
     *
     * The cost is precision: "last used" is accurate to the hour. That is the
     * right trade, because the question it answers - "is anything still using
     * this token, or is it safe to revoke" - is not a question about minutes.
     */
    touchToken: (id: string) => laneQuery('interactive', `
        UPDATE board_tokens SET last_used_ts = now()
         WHERE id = $1::bigint
           AND (last_used_ts IS NULL OR last_used_ts < now() - interval '1 hour')`, [id]),

    /**
     * THE RENDER PROJECTION - clause 1, and the reason it is a store op rather
     * than a filter in the route.
     *
     * The board document is selected FROM here and never returned. What comes
     * back is built out of it: the shapes as drawn, their labels, and their
     * binding ids. Addresses appear only when the board declares
     * show_addresses, which defaults false.
     *
     * WHY THE PROJECTION IS BUILT IN SQL rather than in TypeScript over the
     * fetched document: because then the document is never in the process at
     * all. A projection applied in the route means the full board - addresses,
     * credential refs, annotations - has already crossed into a variable that
     * some future serialiser, log line or error report can reach. The cheapest
     * way to guarantee a field is not served is for it never to be loaded.
     */
    /**
     * `withDevice` (slice 45) is the ONE case where the binding identity may
     * travel, and it is a projection decision rather than a route decision on
     * purpose - see the note above about never loading what must not be
     * served. A kiosk's query is unchanged down to the byte: the column is
     * not selected, so no future serialiser or error report can reach it.
     *
     * It is true only for a SESSION principal, who already holds devices.read
     * and can list every device on the roster anyway. Withholding a name from
     * somebody who may fetch the whole inventory buys nothing and costs the
     * click-through. Clause 1 protects the DISPLAY, and a signed-in operator
     * at a keyboard is not one.
     */
    boardProjection: (boardId: string, withDevice = false) => laneQuery<{
        name: string; collection: string; shapes: unknown;
        grid_cols: number | null; grid_fields: unknown;
        source_axis: string | null; source_values: unknown;
    }>('interactive', `
        SELECT b.name, b.collection,
               b.grid_cols,
               COALESCE(b.grid_fields, '[]'::jsonb) AS grid_fields,
               b.source_axis, b.source_values,
               COALESCE((
                   SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                       'id',    shape->>'id',
                       'x',     shape->'x',
                       'y',     shape->'y',
                       'w',     shape->'w',
                       'h',     shape->'h',
                       'kind',  shape->>'kind',
                       'label', shape->>'label',
                       ${withDevice ? "'device', shape->>'bind'," : ''}
                       -- The bind field IS NOT SERVED, and its absence is
                       -- the point. It holds the DEVICE NAME, and clause 1
                       -- withholds device names the board does not draw: a
                       -- shape labelled "Core switch, floor 3" bound to
                       -- core-sw-01 would have handed the display an identity
                       -- nobody put on the wall.
                       -- (No backticks in this comment: the whole statement
                       -- is a template literal, and one would end it.)
                       --
                       -- It shipped for one afternoon because the fixture
                       -- used the same string for label and bind, so the leak
                       -- was invisible - the same way the hostile test once
                       -- looked at a field no payload could reach. Nothing
                       -- needs it: the status is resolved here and attached
                       -- to the shape, so the binding identity has no reason
                       -- to travel, and shape.id is already the stable key
                       -- the renderer associates state with.
                       -- STATUS IS RESOLVED HERE, SERVER-SIDE, and this is
                       -- clause 1 doing real work rather than just withholding.
                       -- A wall has to show what is down, so the display needs
                       -- the STATE of each binding - but not the identity
                       -- behind it. Joining here means the display learns
                       -- "shape s1 is down" and never "core-sw-01 is down"
                       -- unless the board draws that label itself.
                       --
                       -- The alternative everyone reaches for first is to send
                       -- the device name and let the client fetch status. That
                       -- hands a corridor screen a device inventory, and it is
                       -- the exact shape BOARD-EXPOSURE exists to refuse.
                       'status', ${deviceStatusSql('d')},
                       -- STALE IS ABOUT THE FRESHNESS OF THE INFORMATION,
                       -- NOT ABOUT THE DEVICE BEING DOWN, and deriving it
                       -- from last_seen_ts got that exactly backwards: a down
                       -- device has BY DEFINITION not been seen recently, so
                       -- every down device rendered as stale and the wall
                       -- dimmed the only thing on it that mattered.
                       --
                       -- last_poll_ts is when the collector last TRIED. A
                       -- device that is down and being polled every 30s has
                       -- fresh information - the information is "it is not
                       -- answering". Stale means nobody has looked lately, so
                       -- what is on screen might be about anything.
                       --
                       -- This is the handoff's present-when-true rule at the
                       -- render layer: distinguish "down" from "we have not
                       -- checked", exactly as the UI distinguishes 0 bps from
                       -- not heard from lately.
                       -- THE SAME RULE THE ALERT SCAN USES, not a second one.
                       -- This was a flat 5 minutes, which quietly disagreed
                       -- with the scan's "three times the device's own poll
                       -- interval" - a rule kept deliberately from the parent.
                       -- poll_interval_s has a floor of 30 and NO CEILING, so
                       -- any device deliberately polled slower than every 100
                       -- seconds - a WAN probe, a battery device - rendered
                       -- permanently stale on the wall while the scan treated
                       -- its readings as fresh. The wall dims it forever, the
                       -- operator learns to ignore the dimming, and the
                       -- dimming stops meaning anything.
                       --
                       -- That is finding 3 of this session's own list (down
                       -- devices dimmed because stale came from last_seen_ts)
                       -- repeated one constant further down. One rule, one
                       -- owner.
                       -- Slice 35: a ping-only device has no poll to be old,
                       -- so its freshness is whether reach has ever been
                       -- determined. Keeping the poll rule would have dimmed
                       -- every external service permanently.
                       'stale',  CASE WHEN NOT d.snmp_enabled
                                      THEN d.reach_state = 'unknown'
                                      ELSE d.last_poll_ts IS NULL
                                           OR d.last_poll_ts
                                              < now() - (d.poll_interval_s * 3 || ' seconds')::interval
                                 END,
                       'alerts', COALESCE(a.n, 0),
                       -- Slice 22: a BOOLEAN, not an identity - clause 1
                       -- still holds, the display learns "shape s1 is in
                       -- maintenance" and never which device that is. The
                       -- wall must render a window VISIBLY: a suppressed
                       -- alert that is also invisible would be exactly the
                       -- thing the design refused to be. NULL (stripped)
                       -- when the shape is unbound.
                       'maintenance', CASE WHEN d.name IS NULL THEN NULL ELSE EXISTS (
                           SELECT 1 FROM maintenance_windows w
                            WHERE now() >= w.starts_ts AND now() < w.ends_ts
                              AND (w.scope = 'all'
                                   OR (w.scope = 'device' AND w.target = d.name)
                                   OR (w.scope = 'location' AND w.target = d.location)
                                   OR (w.scope = 'application' AND w.target = d.application))) END,
                       -- Slice 25 quiet 2: a BOOLEAN like maintenance, and
                       -- present-when-true so jsonb_strip_nulls drops it from
                       -- every ordinary tile. The wall combines it with
                       -- status: down + transient renders OFF - dim and
                       -- deliberate - because a parlor of powered-down PCs at
                       -- 02:00 is a quiet grid, and one RED machine on it
                       -- still means exactly what red means everywhere else.
                       'transient', CASE WHEN d.transient THEN true ELSE NULL END,
                       -- Slice 26: the glance fields, DECLARED KEYS ONLY.
                       -- Clause 1 in one WHERE clause: a key absent from
                       -- grid_fields cannot be emitted, whatever the client
                       -- asks, because the filter runs here and the display
                       -- never names fields. The VALUES table must mirror
                       -- GRID_FIELDS in code - see the registry comment.
                       -- Values blank by the roster's own rule (nothing but
                       -- ping while the device is not up; ping while reach
                       -- has an opinion), so a dark device's tile goes quiet
                       -- rather than serving readings from last Tuesday.
                       -- Slice 27: which of the board's DECLARED groups this
                       -- tile belongs to. Only on sectioned grids (a sourced
                       -- board rendering as a grid), and the value served is
                       -- a group name the board itself declared - or, on the
                       -- all-fleet board, one every value is implicitly
                       -- declared by. A hand-bound stray from an undeclared
                       -- group gets NULL and renders in the trailing section.
                       'section', CASE WHEN b.grid_cols IS NOT NULL AND b.source_axis IS NOT NULL
                                        AND d.id IS NOT NULL THEN
                           CASE WHEN b.source_values IS NULL
                                 OR (CASE WHEN b.source_axis = 'location' THEN d.location ELSE d.application END)
                                    IN (SELECT jsonb_array_elements_text(b.source_values))
                                THEN (CASE WHEN b.source_axis = 'location' THEN d.location ELSE d.application END)
                           END
                       END,
                       'fields', CASE WHEN b.grid_cols IS NOT NULL AND d.id IS NOT NULL THEN (
                           SELECT COALESCE(jsonb_object_agg(f.k, f.v), '{}'::jsonb)
                             FROM (VALUES
                               ('address',  to_jsonb(host(d.host))),
                               -- Slice 32: the OVERRIDE wins, and it is not
                               -- blanked when the device is down - an icon is
                               -- what a machine IS, which does not stop being
                               -- true because it stopped answering.
                               ('stencil',  to_jsonb(coalesce(d.stencil_override, d.stencil))),
                               ('hardware', to_jsonb(d.cpu_model)),
                               ('cpu',      CASE WHEN d.status = 'up' THEN to_jsonb(round(d.cpu_pct::numeric)) END),
                               ('mem',      CASE WHEN d.status = 'up' THEN to_jsonb(round(d.mem_pct::numeric)) END),
                               ('top',      CASE WHEN d.status = 'up' THEN to_jsonb(d.top_bps::float8) END),
                               ('topif',    CASE WHEN d.status = 'up' THEN to_jsonb(d.top_if) END),
                               ('fs',       CASE WHEN d.status = 'up' THEN to_jsonb(round(d.fs_pct::numeric)) END),
                               ('fsname',   CASE WHEN d.status = 'up' THEN to_jsonb(d.fs_name) END),
                               ('temp',     CASE WHEN d.status = 'up' THEN to_jsonb(round(d.temp_c::numeric)) END),
                               ('errs',     CASE WHEN d.status = 'up' THEN to_jsonb(round(d.if_errs::numeric, 1)) END),
                               ('uptime',   CASE WHEN d.status = 'up' THEN to_jsonb(d.uptime_s) END),
                               ('ping',     CASE WHEN d.reach_state IN ('up', 'degraded') THEN to_jsonb(round(d.ping_rtt_ms::numeric)) END),
                               ('snmp',     CASE WHEN d.status = 'up' THEN to_jsonb(round(d.snmp_rtt_ms::numeric)) END),
                               ('batt',     CASE WHEN d.status = 'up' THEN to_jsonb(round(d.batt_pct::numeric)) END),
                               ('runtime',  CASE WHEN d.status = 'up' THEN to_jsonb(d.runtime_s::float8) END)
                             ) AS f(k, v)
                            WHERE COALESCE(b.grid_fields, '[]'::jsonb) ? f.k
                              AND f.v IS NOT NULL
                       ) END,
                       -- Clause 3: present only when the board declares it.
                       -- A CASE rather than a post-filter, so a board with
                       -- show_addresses false cannot emit the key at all.
                       'address', CASE WHEN b.show_addresses
                                       THEN shape->'address' ELSE NULL END
                   )))
                     FROM jsonb_array_elements(COALESCE(b.doc->'shapes', '[]'::jsonb)) shape
                     -- LEFT joins, so a shape bound to a device that no longer
                     -- exists renders as unknown rather than vanishing. A wall
                     -- that silently drops a shape is worse than one showing a
                     -- grey box: the box is a question, the absence is not.
                     LEFT JOIN devices d ON d.name = shape->>'bind'
                     LEFT JOIN LATERAL (
                         SELECT count(*) AS n FROM alerts al
                          WHERE al.host = d.name AND al.state != 'cleared'
                     ) a ON true
               ), '[]'::jsonb) AS shapes
          FROM boards b
         WHERE b.id = $1::bigint`, [boardId]),

    /**
     * Write a board document wholesale.
     *
     * Exists for the exposure test's fixture and for the editor integration
     * that follows. Named `raw` because it takes the document as given and
     * validates nothing about its contents - the security property this
     * codebase relies on is that the document is never SERVED, not that it is
     * sanitised on the way in. Sanitising here instead would be the weaker
     * guarantee: it protects only the fields somebody thought of.
     */
    rawSetBoardDoc: (id: string, doc: string) => laneQuery('interactive', `
        UPDATE boards SET doc = $2::jsonb, updated_ts = now()
         WHERE id = $1::bigint`, [id, doc]),

    syncTrgmIndexes: (days: number) => laneQuery<{ action: string; partition_name: string }>(
        'jobs', 'SELECT * FROM sync_recent_trgm_indexes($1, $2::int)', ['messages', days]),

    /**
     * Build one trigram index CONCURRENTLY, outside any transaction.
     *
     * WHY THIS IS NOT INSIDE THE FUNCTION. plpgsql cannot use CONCURRENTLY -
     * it refuses to run inside a transaction block and a function always is
     * one - and a plain CREATE INDEX takes SHARE, which conflicts with the
     * ingest writer's ROW EXCLUSIVE. The recent window includes TODAY'S
     * partition, so an in-function build would block every COPY for the length
     * of a GIN build over a partition-day, and past about 100 seconds at 500/s
     * the queue sheds. CONCURRENTLY takes SHARE UPDATE EXCLUSIVE instead, and
     * the writer keeps writing.
     *
     * The name is validated against the partition naming rule rather than
     * trusted, because it reaches DDL by interpolation - it cannot be a bind
     * parameter - and the only safe version of that is a name this code proved
     * matches a pattern.
     */
    createTrgmIndexConcurrently: (target: string) => {
        // `target` is "<partition>:<column>", which is what
        // sync_recent_trgm_indexes reports now that it maintains two indexes
        // per partition rather than one.
        const [partition, column] = target.split(':');
        if (!/^messages_\d{8}$/.test(partition ?? '')) {
            throw new Error(`refusing to build an index on ${JSON.stringify(target)}: `
                + 'not a messages partition name');
        }
        if (column !== 'msg' && column !== 'host') {
            throw new Error(`refusing to build a trigram index on column `
                + `${JSON.stringify(column)}: only msg and host are indexed`);
        }
        // MAINTENANCE LANE, not jobs: an index is owned by whoever creates
        // it, and only an owner can drop it. Built here as the admin role so
        // the drop below, as the same role, is never refused (slice 19).
        return laneQuery('maintenance',
            `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${partition}_${column}_trgm `
            + `ON ${partition} USING gin (${column} gin_trgm_ops)`);
    },

    /**
     * Drop one trigram index CONCURRENTLY, the mirror of the build above.
     *
     * WHY IT IS OUT HERE FOR THE SAME REASON. CONCURRENTLY refuses to run
     * inside a transaction block and a plpgsql function always is one, so the
     * function reports `needs-drop` and this does the work - exactly the shape
     * the create path already had, and the asymmetry between them is what let
     * a populated partition's index become undroppable under sustained read
     * load.
     *
     * DROP INDEX CONCURRENTLY holds SHARE UPDATE EXCLUSIVE for the bulk of its
     * work rather than ACCESS EXCLUSIVE, so an ordinary reader does not block
     * it. It is NOT a guarantee of never waiting: the final phase still waits
     * for transactions that can see the index to finish. That is a wait, not a
     * 2s timeout that abandons the attempt, which is the difference between
     * losing a race and being unable to enter it.
     *
     * The name is validated rather than trusted, because it reaches DDL by
     * interpolation and cannot be a bind parameter.
     */
    dropTrgmIndexConcurrently: (target: string) => {
        const [partition, column] = target.split(':');
        if (!/^messages_\d{8}$/.test(partition ?? '')) {
            throw new Error(`refusing to drop an index on ${JSON.stringify(target)}: `
                + 'not a messages partition name');
        }
        if (column !== 'msg' && column !== 'host') {
            throw new Error('refusing to drop a trigram index on column '
                + `${JSON.stringify(column)}: only msg and host are indexed`);
        }
        return laneQuery('maintenance',
            `DROP INDEX CONCURRENTLY IF EXISTS ${partition}_${column}_trgm`);
    },

    /**
     * Drop an index left INVALID by a failed CONCURRENTLY build.
     *
     * A cancelled or failed CREATE INDEX CONCURRENTLY leaves an invalid index
     * behind that is never used by the planner and never repaired on its own -
     * so without this the trigram job would report success forever while every
     * search fell back to a LIKE scan.
     */
    dropInvalidTrgmIndexes: () => laneQuery<{ dropped: string }>('maintenance', `
        DO $$
        DECLARE r record;
        BEGIN
            SET LOCAL lock_timeout = '2s';
            FOR r IN SELECT c.relname
                       FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
                      WHERE NOT i.indisvalid
                        AND (c.relname LIKE 'messages\\_%\\_msg\\_trgm'
                          OR c.relname LIKE 'messages\\_%\\_host\\_trgm')
            LOOP
                EXECUTE format('DROP INDEX %I', r.relname);
            END LOOP;
        END $$`),

    /** Which partitions currently carry a trigram index, and what they cost. */
    trgmFootprint: () => laneQuery<{ indexes: number; total: string }>('jobs', `
        SELECT count(*)::int AS indexes,
               pg_size_pretty(coalesce(sum(pg_relation_size(c.oid)), 0)) AS total
          FROM pg_class c
         WHERE c.relname LIKE 'messages\\_%\\_msg\\_trgm'
            OR c.relname LIKE 'messages\\_%\\_host\\_trgm'`),

    // --- alerts ------------------------------------------------------------------
    //
    // The scan tick's persistence, on the ALERTS lane - the lane that was
    // declared and sized for exactly this caller ("a skipped scan costs one
    // cycle of latency on an alert") and then sat with zero callers for the
    // fork's whole life while the scan ran on the no-timeout jobs lane,
    // queueing behind rollup catch-up and retention (2026-09-01 review).
    // The 15s statement timeout is the bound the lane was sized with; the
    // jobs lane's null timeout meant one wedged scan statement ran forever.
    //
    // The NOTIFY path's operations (the owed queues, markNotified, the
    // settle passes) stay on the jobs lane deliberately: its 30s connection
    // wait is the right policy for writes whose refusal means a duplicate
    // page, where the alerts lane's 5s skip is the right policy for a scan
    // that simply runs again next tick.
    //
    // The state DECISIONS live in src/alerts/machine.ts as pure functions;
    // these operations only read the open set and write back what the
    // machine returned. Every id is text because alerts.id is bigint and pg
    // returns int8 as a string.

    /** The open set the machine folds each scan's conditions onto. */
    openAlerts: () => laneQuery<AlertRecord>('alerts',
        `SELECT ${ALERT_COLUMNS} FROM alerts WHERE state != 'cleared'`),

    /** One alert by id, for dispatching an event the scan just produced.
     *  Carries the maintenance flag because the immediate-dispatch path in
     *  jobs.ts must consult the same gate the owed queues apply - see the
     *  comment there for why the gap only shows on a LIVE raise. */
    getAlert: (id: string) => laneQuery<AlertRecord & { in_maintenance: boolean; under_policy: boolean }>('jobs',
        `SELECT ${ALERT_COLUMNS},
               ${ALERT_IN_MAINTENANCE} AS in_maintenance,
               ${ALERT_UNDER_POLICY} AS under_policy
          FROM alerts WHERE id = $1::bigint`, [id]),

    /**
     * Insert a fresh alert from the machine. RETURNING the row, so the caller
     * can dispatch a raise that happened on the same step (raiseScans=1).
     */
    insertAlert: (a: {
        alertKey: string; state: string; severity: string; kind: string;
        host: string | null; code: string | null; label: string;
        value: number | null; peakValue: number | null; threshold: number | null;
        unit: string; breachCount: number; firstBreachTs: Date;
        raisedTs: Date | null; lastSeenTs: Date;
    }) => laneQuery<AlertRecord>('alerts', `
        INSERT INTO alerts (alert_key, state, severity, kind, host, code, label,
                            value, peak_value, threshold, unit, breach_count,
                            first_breach_ts, raised_ts, last_seen_ts)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
        RETURNING ${ALERT_COLUMNS}`,
        [a.alertKey, a.state, a.severity, a.kind, a.host, a.code, a.label,
            a.value, a.peakValue, a.threshold, a.unit, a.breachCount,
            a.firstBreachTs, a.raisedTs, a.lastSeenTs]),

    /** Write back the machine's transition for one existing alert. */
    /**
     * Every alert the scan advanced, written in ONE statement. This cannot be
     * a skip-if-unchanged: a breaching alert's value and last_seen_ts move on
     * every scan by design (last_seen_ts IS the liveness marker the missing
     * machinery reads), so unlike the collector's refreshEntity the writes are
     * real. What was wrong was the SHAPE - one autocommit UPDATE per alert,
     * 171 transactions a second sustained (SOAK-CRITERIA 2026-08-10) - not
     * the writing. Same rows, same values, ~one transaction per scan.
     */
    updateAlertStatesBatch: (a: {
        ids: string[]; states: string[]; severities: string[]; labels: string[];
        values: Array<number | null>; peakValues: Array<number | null>;
        thresholds: Array<number | null>; units: string[];
        breachCounts: number[]; clearCounts: number[]; missingCounts: number[];
        raisedTs: Array<Date | null>; escalatedTs: Array<Date | null>;
        clearedTs: Array<Date | null>;
        lastSeenTs: Date[]; clearReasons: Array<string | null>;
    }) => laneQuery('alerts', `
        UPDATE alerts al
           SET state = u.state, severity = u.severity, label = u.label,
               value = u.value, peak_value = u.peak_value, threshold = u.threshold,
               unit = u.unit, breach_count = u.breach_count, clear_count = u.clear_count,
               missing_count = u.missing_count, raised_ts = u.raised_ts,
               escalated_ts = u.escalated_ts,
               -- THE DEBT OPENS HERE, in the same statement that writes the
               -- fact: a row gaining its escalated_ts owes the operator the
               -- crit, and opening the debt anywhere else (the dispatch path
               -- deciding to skip, say) would lose it to a crash between
               -- scan and dispatch. The machine stays pure - it records the
               -- fact; this is where the fact becomes a queue entry
               -- (DECISIONS-2026-09-01 ruling 1).
               --
               -- LOAD-BEARING PAIR with markNotified's raise-success arm,
               -- which sets notified_escalate = true on every delivered
               -- raise, escalated or not: THIS reset is what makes that
               -- harmless for an alert that escalates later. Remove or
               -- narrow this CASE and that arm silently pre-settles every
               -- future escalation. Change either site with the other in
               -- view (AUDIT-2026-09-01 section 2 called this the most
               -- fragile coupling of the week).
               notified_escalate = CASE
                   WHEN al.escalated_ts IS NULL AND u.escalated_ts IS NOT NULL THEN false
                   ELSE al.notified_escalate END,
               cleared_ts = u.cleared_ts, last_seen_ts = u.last_seen_ts,
               clear_reason = u.clear_reason
          FROM (
            SELECT * FROM unnest(
                $1::bigint[], $2::text[], $3::text[], $4::text[],
                $5::float8[], $6::float8[], $7::float8[], $8::text[],
                $9::int[], $10::int[], $11::int[],
                $12::timestamptz[], $13::timestamptz[], $14::timestamptz[], $15::timestamptz[], $16::text[]
            ) AS t(id, state, severity, label, value, peak_value, threshold, unit,
                   breach_count, clear_count, missing_count,
                   raised_ts, escalated_ts, cleared_ts, last_seen_ts, clear_reason)
          ) u
         WHERE al.id = u.id`,
        [a.ids, a.states, a.severities, a.labels, a.values, a.peakValues,
            a.thresholds, a.units, a.breachCounts, a.clearCounts, a.missingCounts,
            a.raisedTs, a.escalatedTs, a.clearedTs, a.lastSeenTs, a.clearReasons]),

    /** A pending alert that lapsed or aged out: it never happened. */
    deleteAlert: (id: string) => laneQuery('alerts',
        'DELETE FROM alerts WHERE id = $1::bigint', [id]),

    /**
     * Record a dispatch outcome. The notified flag and the attempt counter
     * move together: success resets attempts to zero, failure increments -
     * which is what the retry pass's backoff is computed from.
     */
    /**
     * The raise and escalate debts settle INTO each other on success, and
     * only on success (DECISIONS-2026-09-01 ruling 1): a raise delivered
     * after the escalation goes out at the row's severity, which is already
     * crit (sticky) - the operator has been told the true state, so the
     * escalate debt is paid. An escalate delivered while the raise was
     * still owed carries the crit and the incident's existence in one
     * message, so the raise debt is paid. On FAILURE each event marks only
     * its own bit, and the owed-escalate queue requires notified_raise -
     * so an alert owing both sits in the raise queue alone, is announced
     * once at crit, and both debts settle together. No alert is ever in
     * two queues.
     *
     * LOAD-BEARING PAIR (AUDIT-2026-09-01 section 2): the raise-success arm
     * below sets notified_escalate = true even on an alert that has NEVER
     * escalated. That is inert today (the owed-escalate queue also requires
     * escalated_ts) and it is SAFE for an alert that escalates LATER only
     * because updateAlertStatesBatch's debt-opening CASE resets the bit to
     * false whenever a row gains its escalated_ts. Weaken that CASE and
     * this arm silently pre-settles every future escalation; weaken this
     * arm and a crit-carrying raise stops paying the escalate bill. Change
     * either site with the other in view.
     */
    markNotified: (id: string, which: 'raise' | 'clear' | 'escalate', ok: boolean, at: Date) =>
        laneQuery('jobs', `
        UPDATE alerts
           SET notified_raise = CASE WHEN $2 = 'raise' THEN $3
                                     WHEN $2 = 'escalate' AND $3 THEN true
                                     ELSE notified_raise END,
               notified_clear = CASE WHEN $2 = 'clear' THEN $3 ELSE notified_clear END,
               notified_escalate = CASE WHEN $2 = 'escalate' THEN $3
                                        WHEN $2 = 'raise' AND $3 THEN true
                                        ELSE notified_escalate END,
               notify_attempts = CASE WHEN $3 THEN 0 ELSE notify_attempts + 1 END,
               last_attempt_ts = $4
         WHERE id = $1::bigint`, [id, which, ok, at]),

    markRenotified: (id: string, at: Date) => laneQuery('jobs',
        'UPDATE alerts SET renotified_ts = $2 WHERE id = $1::bigint', [id, at]),

    /**
     * Per-channel delivery health from the log this table already is
     * (easy-win E6): the trailing failure streak and the last success. A
     * fully-configured channel that has been failing for days only GREW
     * this table before - isNotifyConfigSane catches half-configured, and
     * nothing caught configured-and-dead. Bounded to a week because the
     * prune keeps more and the question is "is anybody being told NOW".
     */
    notifyChannelHealth: () => laneQuery<{
        channel: string; trailing_failures: number;
        last_delivered_ts: Date | null; last_attempt_ts: Date;
    }>('jobs', `
        WITH recent AS (
            SELECT channel, ok, ts,
                   row_number() OVER (PARTITION BY channel ORDER BY ts DESC, id DESC) AS rn
              FROM notifications
             WHERE ts > now() - interval '7 days'
        )
        SELECT channel,
               COALESCE(min(rn) FILTER (WHERE ok) - 1, count(*))::int AS trailing_failures,
               max(ts) FILTER (WHERE ok) AS last_delivered_ts,
               max(ts) AS last_attempt_ts
          FROM recent GROUP BY channel ORDER BY channel`),

    /** Every attempt, delivered or failed - the "did anyone get told" record. */
    /**
     * Which channels have ALREADY delivered this debt, so a retry sends only
     * to the ones still failing. The notifications log is the source of truth
     * rather than per-channel flag columns: it already records every attempt,
     * and `since` scopes it to THIS incident's debt - a raise delivered last
     * month must not satisfy this month's.
     *
     * raise, escalate and renotify share a debt (they settle notified_raise
     * together), so any of them delivering on a channel settles that channel.
     */
    channelsDelivered: (alertId: string, events: string[], since: Date) =>
        laneQuery<{ channel: string }>('jobs', `
        SELECT DISTINCT channel FROM notifications
         WHERE alert_id = $1::bigint AND ok AND event = ANY($2) AND ts >= $3`,
        [alertId, events, since]),

    logNotification: (alertId: string, event: string, channel: string, ok: boolean, detail: string | null) =>
        laneQuery('jobs', `
        INSERT INTO notifications (alert_id, event, channel, ok, detail)
        VALUES ($1::bigint, $2, $3, $4, $5)`, [alertId, event, channel, ok, detail]),

    /**
     * The retry queues: raises still owed on active alerts, clears still owed
     * on recently cleared ones. Bounded to a day for clears, exactly as the
     * parent bounded it - a clear notification three days late is noise.
     */
    // --- credential profiles (SLICE-CREDENTIALS-PLAN) -----------------------
    //
    // Secret columns hold CIPHERTEXT. The store never encrypts or decrypts:
    // the route encrypts before insert, and the collector decrypts after
    // read, so the plaintext exists only in the thread that needs it and
    // never in a lane query or a log line.

    /** Every profile, secrets as ciphertext, with the count of devices
     *  naming each. For the credentials page and the add-form picker. */
    credentialProfiles: () => laneQuery<{
        id: string; name: string; version: string;
        community: string | null; v3_user: string | null; v3_level: string | null;
        v3_auth_proto: string | null; v3_auth_key: string | null;
        v3_priv_proto: string | null; v3_priv_key: string | null;
        devices: number; created_ts: Date; updated_ts: Date;
    }>('interactive', `
        SELECT p.id::text AS id, p.name, p.version, p.community, p.v3_user, p.v3_level,
               p.v3_auth_proto, p.v3_auth_key, p.v3_priv_proto, p.v3_priv_key,
               (SELECT count(*) FROM devices d WHERE d.credential_ref = p.name)::int AS devices,
               p.created_ts, p.updated_ts
          FROM credential_profiles p ORDER BY p.name`),

    /** The collector's read: name, version and ciphertext for every profile,
     *  on the collector lane, loaded at start and on reload. */
    credentialProfilesForCollector: () => laneQuery<{
        name: string; version: string; community: string | null;
        v3_user: string | null; v3_level: string | null;
        v3_auth_proto: string | null; v3_auth_key: string | null;
        v3_priv_proto: string | null; v3_priv_key: string | null;
    }>('collector', `
        SELECT name, version, community,
               v3_user, v3_level, v3_auth_proto, v3_auth_key, v3_priv_proto, v3_priv_key
          FROM credential_profiles`),

    /**
     * Create. INSERT, never upsert - a name collision is a refusal the
     * operator should see, not a silent overwrite of a profile that devices
     * already use. ON CONFLICT DO NOTHING + zero rows is that refusal.
     */
    insertCredentialProfile: (
        name: string, version: string, community: string | null,
        v3User: string | null, v3Level: string | null, v3AuthProto: string | null,
        v3AuthKey: string | null, v3PrivProto: string | null, v3PrivKey: string | null,
    ) => laneQuery<{ id: string }>('interactive', `
        INSERT INTO credential_profiles
            (name, version, community, v3_user, v3_level, v3_auth_proto, v3_auth_key, v3_priv_proto, v3_priv_key)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (name) DO NOTHING
        RETURNING id::text AS id`,
    [name, version, community, v3User, v3Level, v3AuthProto, v3AuthKey, v3PrivProto, v3PrivKey]),

    /**
     * Update the SECRETS of an existing profile by name. Version and v3
     * identity are not editable - a profile that changes version is a
     * different profile, and the operator should create one and re-point
     * devices, so the change is visible in the audit rather than silent.
     */
    updateCredentialProfileSecrets: (
        name: string, community: string | null, v3AuthKey: string | null, v3PrivKey: string | null,
    ) => laneQuery<{ id: string }>('interactive', `
        UPDATE credential_profiles
           SET community = COALESCE($2, community),
               v3_auth_key = COALESCE($3, v3_auth_key),
               v3_priv_key = COALESCE($4, v3_priv_key),
               updated_ts = now()
         WHERE name = $1
     RETURNING id::text AS id`, [name, community, v3AuthKey, v3PrivKey]),

    /**
     * Delete by name. NOT refused when devices still reference it - the
     * reference is deliberately not a foreign key - but the route reports
     * how many do, and those devices then refuse to poll by name, which is
     * the operator's signal to fix one or the other. Deleting a profile is
     * how you revoke a credential; a delete that could be blocked by a
     * forgotten device would be a revocation that could be blocked.
     */
    deleteCredentialProfile: (name: string) => laneQuery<{ id: string }>('interactive', `
        DELETE FROM credential_profiles WHERE name = $1 RETURNING id::text AS id`, [name]),

    /** How many devices name this profile - reported on delete. */
    devicesUsingCredential: (name: string) => laneQuery<{ n: number }>('interactive', `
        SELECT count(*)::int AS n FROM devices WHERE credential_ref = $1`, [name]),

    // --- threshold overrides (SLICE-THRESHOLDS-PLAN) -------------------------

    /** Every override, for the scan (alerts lane) and the page (interactive).
     *  Same shape both ways; the lane is the caller's. */
    thresholdOverrides: (lane: 'alerts' | 'interactive' = 'interactive') => laneQuery<{
        id: string; kind: string; host: string | null; code: string | null;
        warn: number | null; crit: number | null; enabled: boolean; note: string | null;
        updated_ts: Date;
    }>(lane, `
        SELECT id::text AS id, kind, host, code, warn, crit, enabled, note, updated_ts
          FROM threshold_overrides ORDER BY kind, host NULLS FIRST, code NULLS FIRST`),

    /**
     * The fleet Thresholds page's read: the same rows, with sensor-scoped
     * ones RESOLVED to what they govern. "code 3V92" is a fact nobody can
     * act on; "FW-1 Memory: Real Memory Metrics" answers the question that
     * exposed this gap (2026-08-27: eleven mem mutes, none attributable
     * from the page that listed them). Codes are minted fleet-unique, so
     * the join is exact; LEFT, so an override whose sensor is gone still
     * lists - now visibly orphaned instead of just cryptic.
     */
    thresholdOverridesAnnotated: () => laneQuery<{
        id: string; kind: string; host: string | null; code: string | null;
        warn: number | null; crit: number | null; enabled: boolean; note: string | null;
        updated_ts: Date; entity_name: string | null; device_name: string | null;
    }>('interactive', `
        SELECT o.id::text AS id, o.kind, o.host, o.code, o.warn, o.crit,
               o.enabled, o.note, o.updated_ts,
               e.name AS entity_name, d.name AS device_name
          FROM threshold_overrides o
          LEFT JOIN entities e ON o.code IS NOT NULL AND e.code = o.code
          LEFT JOIN devices d ON d.id = e.device_id
         ORDER BY o.kind, o.host NULLS FIRST, o.code NULLS FIRST`),

    /**
     * Create or replace the override for ONE target. Upsert on the unique
     * (kind, host, code) - NULLS NOT DISTINCT - so saving the same target
     * twice edits rather than shadows. The whole row is replaced, not merged:
     * an operator saving warn without crit means "no crit", and a merge would
     * keep a crit they intended to remove.
     */
    upsertThresholdOverride: (
        kind: string, host: string | null, code: string | null,
        warn: number | null, crit: number | null, enabled: boolean, note: string | null,
    ) => laneQuery<{ id: string }>('interactive', `
        INSERT INTO threshold_overrides (kind, host, code, warn, crit, enabled, note)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (kind, host, code) DO UPDATE
           SET warn = EXCLUDED.warn, crit = EXCLUDED.crit, enabled = EXCLUDED.enabled,
               note = EXCLUDED.note, updated_ts = now()
        RETURNING id::text AS id`, [kind, host, code, warn, crit, enabled, note]),

    /** Delete by id. The next tier - or the default - takes over on the
     *  next scan. RETURNING so the route can say which target it was. */
    deleteThresholdOverride: (id: string) => laneQuery<{ kind: string; host: string | null; code: string | null }>(
        'interactive', `DELETE FROM threshold_overrides WHERE id = $1::bigint RETURNING kind, host, code`, [id]),

    // --- event alerting (slice 10) ------------------------------------------

    /** The enabled rules, for the ingest worker to compile. Ingest lane:
     *  the reload runs beside the flush, never against another worker. */
    /** Every device's address, for attributing a trap to its device (the
     *  ingest worker refreshes this with its event rules). Grouped, so an
     *  address several devices share arrives as all of their names. */
    deviceAddresses: () => laneQuery<{ address: string; names: string[] }>('ingest', `
        SELECT host(host) AS address, array_agg(name ORDER BY name) AS names
          FROM devices GROUP BY 1`),

    eventRules: () => laneQuery<{
        id: string; name: string; pattern: string; is_regex: boolean;
        source: string; severity: string;
    }>('ingest', `
        SELECT id::text AS id, name, pattern, is_regex, source, severity
          FROM event_rules WHERE enabled = true ORDER BY id`),

    /**
     * One flush's accumulated matches, one statement. The upsert IS the rate
     * limiter (the design's pre-registered 10k-to-one requirement): a new key
     * is born ACTIVE with notified_raise false - the existing drain notifies
     * it, nothing new dispatches - and an existing open key folds the counts
     * in and refreshes last_seen_ts, sending NOTHING. `value` is the match
     * count this incident; the sticky-severity doctrine applies unchanged
     * (a rule edited mid-incident does not rewrite the open row's severity).
     *
     * The conflict target is the partial unique index alerts_open_key - one
     * open row per key is the table's own invariant doing the limiting.
     */
    upsertEventAlerts: (
        keys: string[], severities: string[], hosts: string[], labels: string[],
        counts: number[], lastTss: Date[],
    ) => laneQuery<never>('ingest', `
        INSERT INTO alerts (alert_key, state, severity, kind, host, label,
                            value, peak_value, unit, breach_count,
                            first_breach_ts, raised_ts, last_seen_ts)
        SELECT u.k, 'active', u.s, 'event', u.h, u.l,
               u.c, u.c, '', 1, u.t, u.t, u.t
          FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                      $5::float8[], $6::timestamptz[]) AS u(k, s, h, l, c, t)
        ON CONFLICT (alert_key) WHERE state != 'cleared'
        DO UPDATE SET
            last_seen_ts = GREATEST(alerts.last_seen_ts, EXCLUDED.last_seen_ts),
            value        = coalesce(alerts.value, 0) + EXCLUDED.value,
            peak_value   = coalesce(alerts.peak_value, 0) + EXCLUDED.value`,
        [keys, severities, hosts, labels, counts, lastTss]),

    /**
     * The TTL clear, with BOTH slice-10 scoping rules inside the statement:
     *
     *  * only kind 'event' - scan-owned rows have their own lifecycle;
     *  * gated on INGEST liveness, not collector health: the freshness CTE
     *    requires a message in the last 15 minutes, because a silent feed
     *    cannot distinguish "pattern stopped firing" from "nothing arrives",
     *    and freeze-rather-than-age-out is the standing doctrine. A dead
     *    feed freezes event aging; the ingest watchdog is a separate alarm.
     *
     * The rule id is parsed from the key the design defined
     * (event|<ruleId>|<host>); a rule deleted mid-incident clears on the
     * 300s default rather than never.
     */
    clearEventAlertsTtl: () => laneQuery<{ alert_key: string }>('alerts', `
        UPDATE alerts a
           SET state = 'cleared', cleared_ts = now(),
               clear_reason = 'ttl: no match for ' || t.ttl || 's'
          FROM (
            SELECT a2.id,
                   coalesce((SELECT r.clear_after_s FROM event_rules r
                              WHERE r.id::text = split_part(a2.alert_key, '|', 2)),
                            300) AS ttl
              FROM alerts a2
             WHERE a2.kind = 'event' AND a2.state = 'active'
          ) t
         WHERE a.id = t.id
           AND a.last_seen_ts < now() - make_interval(secs => t.ttl)
           -- The ingest-liveness gate: a silent feed cannot distinguish
           -- "pattern stopped" from "nothing arrives", so silence FREEZES
           -- aging instead of clearing. Partition pruning keeps this to the
           -- newest partition or two.
           AND EXISTS (SELECT 1 FROM messages
                        WHERE ts > now() - interval '15 minutes')
        RETURNING a.alert_key`),

    listEventRules: () => laneQuery<{
        id: string; name: string; pattern: string; is_regex: boolean;
        source: string; severity: string; clear_after_s: number;
        enabled: boolean; created_ts: Date; created_by: string | null;
    }>('interactive', `
        SELECT id::text AS id, name, pattern, is_regex, source, severity,
               clear_after_s, enabled, created_ts, created_by
          FROM event_rules ORDER BY name`),

    createEventRule: (
        name: string, pattern: string, isRegex: boolean, source: string,
        severity: string, clearAfterS: number, createdBy: string,
    ) => laneQuery<{ id: string }>('interactive', `
        INSERT INTO event_rules (name, pattern, is_regex, source, severity,
                                 clear_after_s, created_by)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING id::text AS id`,
        [name, pattern, isRegex, source, severity, clearAfterS, createdBy]),

    deleteEventRule: (id: string) => laneQuery<{ name: string }>('interactive', `
        DELETE FROM event_rules WHERE id = $1::bigint RETURNING name`, [id]),

    setEventRuleEnabled: (id: string, enabled: boolean) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE event_rules SET enabled = $2 WHERE id = $1::bigint RETURNING name`,
        [id, enabled]),

    // --- maintenance windows (slice 22) ---------------------------------------
    //
    // A window suppresses NOTIFICATION, never the alert. The scan, the state
    // machine, hysteresis and the freeze rule never see a window; the alert
    // raises, is stored, and appears everywhere marked as in-window - it is
    // simply not DELIVERED while a window matches. The gate lives on the two
    // owed queries below and nowhere else.

    createMaintenanceWindow: (
        scope: string, target: string | null, startsTs: Date, endsTs: Date,
        note: string | null, createdBy: string,
    ) => laneQuery<{ id: string }>('interactive', `
        INSERT INTO maintenance_windows (scope, target, starts_ts, ends_ts, note, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id::text AS id`,
        [scope, target, startsTs, endsTs, note, createdBy]),

    /** Active and upcoming, for the System list. Expired rows are history
     *  and the audit trail holds them; this list is operational state. */
    maintenanceWindows: () => laneQuery<{
        id: string; scope: string; target: string | null; starts_ts: Date;
        ends_ts: Date; note: string | null; created_by: string | null;
        active: boolean;
    }>('interactive', `
        SELECT id::text AS id, scope, target, starts_ts, ends_ts, note,
               created_by, now() >= starts_ts AS active
          FROM maintenance_windows
         WHERE ends_ts > now()
         ORDER BY starts_ts, id`),

    cancelMaintenanceWindow: (id: string) => laneQuery<{
        scope: string; target: string | null; starts_ts: Date; ends_ts: Date;
        note: string | null;
    }>('interactive', `
        DELETE FROM maintenance_windows WHERE id = $1::bigint
        RETURNING scope, target, starts_ts, ends_ts, note`, [id]),

    /** Route validation: does anything match this target TODAY? A typo'd
     *  location suppresses nothing, and the operator would learn that at
     *  02:10 from forty pages - refuse it up front with a 404 instead. */
    maintenanceTargetCount: (scope: string, target: string) => laneQuery<{ n: string }>(
        'interactive', `
        SELECT count(*)::text AS n FROM devices d
         WHERE CASE $1 WHEN 'device' THEN d.name
                       WHEN 'location' THEN d.location
                       ELSE d.application END = $2`, [scope, target]),

    /**
     * Settle clears nobody will ever hear about: cleared inside a window
     * that covered the device, raise never delivered. A "resolved" page
     * about an incident nobody was told of is noise with a false
     * implication (plan decision 5), and without settling it here the owed
     * clear would DELIVER once the window expired. Matched against the
     * window SPAN, not now(): a short window can expire between the clear
     * and the next drain pass, and the settlement must still apply. The
     * alert row keeps both transitions; only the delivery is waived.
     */
    settleInWindowClears: () => laneQuery<{ n: string }>('jobs', `
        WITH settled AS (
            UPDATE alerts SET notified_clear = true
             WHERE state = 'cleared' AND NOT notified_clear AND NOT notified_raise
               AND alerts.host IS NOT NULL
               AND cleared_ts > now() - interval '1 day'
               AND EXISTS (
                   SELECT 1 FROM maintenance_windows w
                    WHERE alerts.cleared_ts >= w.starts_ts
                      AND alerts.cleared_ts < w.ends_ts
                      AND (w.scope = 'all'
                           OR (w.scope = 'device' AND w.target = alerts.host)
                           OR (w.scope IN ('location', 'application') AND EXISTS (
                               SELECT 1 FROM devices d
                                WHERE d.name = alerts.host
                                  AND w.target = CASE w.scope WHEN 'location' THEN d.location
                                                              ELSE d.application END))))
            RETURNING 1
        ) SELECT count(*)::text AS n FROM settled`),

    /** Expired-window retention, riding the alert-prune job. The settlement
     *  lookback above needs one day; alert retention keeps far more. */
    pruneMaintenanceWindows: (days: number) => laneQuery<{ n: string }>('jobs', `
        WITH gone AS (
            DELETE FROM maintenance_windows
             WHERE ends_ts < now() - make_interval(days => $1::int)
            RETURNING 1
        ) SELECT count(*)::text AS n FROM gone`, [days]),

    // --- notify policy (slice 25, quiet 1) ------------------------------------

    notifyPolicies: () => laneQuery<{
        id: string; scope: string; target: string; note: string | null;
        created_by: string | null; created_ts: Date;
    }>('interactive', `
        SELECT id::text AS id, scope, target, note, created_by, created_ts
          FROM notify_policy
         ORDER BY scope, target`),

    /** ON CONFLICT DO NOTHING against the (scope, target) unique: an empty
     *  result means "already covered", which the route reports rather than
     *  stacking a second row the delete would then only half-remove. */
    createNotifyPolicy: (
        scope: string, target: string, note: string | null, createdBy: string,
    ) => laneQuery<{ id: string }>('interactive', `
        INSERT INTO notify_policy (scope, target, note, created_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (scope, target) DO NOTHING
        RETURNING id::text AS id`, [scope, target, note, createdBy]),

    deleteNotifyPolicy: (id: string) => laneQuery<{
        scope: string; target: string; note: string | null;
    }>('interactive', `
        DELETE FROM notify_policy WHERE id = $1::bigint
        RETURNING scope, target, note`, [id]),

    /**
     * Settle clears nobody will ever hear about, the POLICY twin of the
     * window settle above: raised under a policy (raise never delivered),
     * cleared under it too. Without this, DELETING the policy would owe a
     * "resolved" page about an incident nobody was told of. Unlike the
     * window form there is no span to match - the policy is standing, so
     * "currently covered" is the condition, checked every pass while the
     * clear is inside its one-day delivery lookback.
     */
    settleUnderPolicyClears: () => laneQuery<{ n: string }>('jobs', `
        WITH settled AS (
            UPDATE alerts SET notified_clear = true
             WHERE state = 'cleared' AND NOT notified_clear AND NOT notified_raise
               AND cleared_ts > now() - interval '1 day'
               AND ${ALERT_UNDER_POLICY}
            RETURNING 1
        ) SELECT count(*)::text AS n FROM settled`),

    // --- transient (slice 25, quiet 2) ----------------------------------------

    setDeviceTransient: (name: string, transient: boolean) => laneQuery<{ name: string }>(
        'interactive', `
        UPDATE devices SET transient = $2 WHERE name = $1 RETURNING name`,
        [name, transient]),

    // THE MAINTENANCE GATE, HERE AND NOWHERE ELSE (slice 22). Because a
    // suppressed raise keeps its debt unsettled, an alert still active when
    // its window expires is delivered by this same query on the next pass -
    // the catch-up path is the absence of a filter, not new code.
    alertsOwingRaise: () => laneQuery<AlertRecord>('jobs',
        `SELECT ${ALERT_COLUMNS} FROM alerts
          WHERE state = 'active' AND NOT notified_raise
            AND NOT ${ALERT_IN_MAINTENANCE}
            AND NOT ${ALERT_UNDER_POLICY}`),
    // The clear side gates on the same predicate: a clear withheld during a
    // window is still owed afterwards when its raise WAS delivered; clears
    // of never-delivered raises are settled silently by settleInWindowClears
    // before this query runs.
    alertsOwingClear: () => laneQuery<AlertRecord>('jobs',
        `SELECT ${ALERT_COLUMNS} FROM alerts
          WHERE state = 'cleared' AND NOT notified_clear
            AND cleared_ts > now() - interval '1 day'
            AND NOT ${ALERT_IN_MAINTENANCE}
            AND NOT ${ALERT_UNDER_POLICY}`),

    /**
     * The third queue (DECISIONS-2026-09-01 ruling 1): escalations whose
     * dispatch was skipped or failed. Requires notified_raise - an alert
     * whose raise is still owed belongs to the raise queue, which announces
     * it once at the row's (sticky, crit) severity and settles both debts.
     * Requires state = 'active' - a cleared alert's escalation is moot; the
     * clear is the message now and the row's sticky severity carries the
     * worst it reached. Gated like its siblings, so a window or policy
     * holds the debt rather than losing it - which is the entire defect
     * this queue exists to close.
     */
    alertsOwingEscalate: () => laneQuery<AlertRecord>('jobs',
        `SELECT ${ALERT_COLUMNS} FROM alerts
          WHERE state = 'active' AND notified_raise
            AND escalated_ts IS NOT NULL AND NOT notified_escalate
            AND NOT ${ALERT_IN_MAINTENANCE}
            AND NOT ${ALERT_UNDER_POLICY}`),

    /**
     * The renotify generator's queue (DECISIONS-2026-09-01 ruling 2). CRIT
     * only - renotify exists to prevent a forgotten page-worthy incident,
     * and re-paging warns is noise with a config knob. acked_ts excludes an
     * alert somebody has acknowledged: the column has waited since slice 6
     * for the ack surface to be built, and honouring it now means that
     * slice inherits correct renotify behaviour instead of remembering to
     * add it. Due-ness runs from the LATEST communication - raise,
     * escalate, or previous renotify - so any message restarts the clock.
     * The caller passes the interval; zero never reaches this query (the
     * feature is off unless ALERT_RENOTIFY_H is set).
     */
    alertsOwingRenotify: (hours: number) => laneQuery<AlertRecord>('jobs',
        `SELECT ${ALERT_COLUMNS} FROM alerts
          WHERE state = 'active' AND severity = 'crit' AND notified_raise
            AND acked_ts IS NULL
            AND GREATEST(raised_ts,
                         COALESCE(escalated_ts, raised_ts),
                         COALESCE(renotified_ts, raised_ts))
                < now() - make_interval(hours => $1::int)
            AND NOT ${ALERT_IN_MAINTENANCE}
            AND NOT ${ALERT_UNDER_POLICY}`, [hours]),

    /**
     * The flap report (easy-win E11): raise/clear cycles per key over the
     * last day, straight from the cleared history that already accumulates
     * under stable keys. This is the field evidence the hysteresis table's
     * deliberate zeros wait on - if-util's missing band would have shown
     * here as interface keys cycling while temp keys held. Cheap by the
     * digest's own asymmetry argument: alerts are thousands of rows, not
     * millions.
     */
    alertFlaps: () => laneQuery<{ alert_key: string; label: string; cycles: string }>(
        'interactive', `
        SELECT alert_key, max(label) AS label, count(*)::text AS cycles
          FROM alerts a
         WHERE state = 'cleared' AND cleared_ts > now() - interval '24 hours'
           -- A TRANSIENT device's raise/clear cycle IS its declared life:
           -- ruling 4 raises while it is present and clears when it leaves,
           -- so a laptop docking three times a day is the system working,
           -- not a threshold to tune - which is the only question the flap
           -- radar exists to raise. NOT EXISTS rather than a join so
           -- watchdog alerts (host is null) and alerts for since-deleted
           -- devices keep flapping honestly.
           AND NOT EXISTS (SELECT 1 FROM devices d
                            WHERE d.name = a.host AND d.transient)
         GROUP BY alert_key HAVING count(*) >= 3
         ORDER BY count(*) DESC, alert_key LIMIT 10`),

    /**
     * Delete generation corpses: interface rows whose ifIndex the agent
     * re-dealt at a reboot, leaving a duplicate that will never read again
     * (remedy 6 of INVESTIGATION-DUP-INTERFACES-2026-09-01).
     *
     * Every condition narrows on purpose:
     * - UNTRACKED only. A tracked corpse may have charts and board bindings
     *   somebody cares about; untracking it is the operator saying "not any
     *   more", and this job collects it a retention later. Auto-deleting
     *   tracked rows would decide that for them.
     * - stale-stamped LONGER than the retention, so the rekey planner has
     *   had every chance to reclaim the row first - a parked row is a
     *   rebind candidate right up until this deletes it.
     * - SUPERSEDED: a living row (unstamped, has read) with the same name
     *   on the same device must exist. An untracked stale row with no
     *   living sibling is the record of a port that left - unclaimed by
     *   this job, which removes clones, not history.
     *
     * samples.entity_id carries no FK, so a corpse's readings are not
     * cascaded - they age out under raw retention like everything else.
     */
    pruneCorpseInterfaces: (days: number) => laneQuery<{ n: string }>('jobs', `
        WITH gone AS (
            DELETE FROM entities e
             WHERE e.kind = 'if'
               -- Untracked BY THE OPERATOR, or parked BY THE PLANNER: a
               -- parked row (snmp_index NULL) is the planner's own verdict
               -- that its adapter left, and it is unreachable by any
               -- operator action anyway - the afternoon audit (finding 8)
               -- found that a parked row was tracked, indexless, stamped,
               -- retired from the scan, and then immortal, because the
               -- untrack path matched on the index the park had cleared.
               -- The other three predicates stay: clones, not history.
               AND (e.tracked = false OR e.snmp_index IS NULL)
               AND e.lv_stale_since IS NOT NULL
               AND e.lv_stale_since < now() - make_interval(days => $1::int)
               AND EXISTS (SELECT 1 FROM entities l
                            WHERE l.device_id = e.device_id AND l.kind = 'if'
                              AND l.name = e.name AND l.id <> e.id
                              AND l.lv_stale_since IS NULL
                              AND l.lv_ts IS NOT NULL)
            RETURNING 1
        ) SELECT count(*)::text AS n FROM gone`, [days]),

    /** Cleared-alert retention. Notifications go with their alert (CASCADE). */
    pruneClearedAlerts: (days: number) => laneQuery<{ n: string }>('jobs', `
        WITH gone AS (
            DELETE FROM alerts
             WHERE state = 'cleared' AND cleared_ts < now() - make_interval(days => $1::int)
            RETURNING 1
        ) SELECT count(*)::text AS n FROM gone`, [days]),

    /**
     * Notification-log retention BY AGE, because the CASCADE alone is not
     * enough: it removes rows when their ALERT is pruned, but a permanently
     * misconfigured channel writes about 96 rows/day per owed alert per
     * channel against alerts that never clear - rows the cascade never
     * reaches. The parent pruned notifications by ts for the same reason.
     * notifications was the one data table with neither partitioning nor
     * retention, which is exactly the shape a soak surfaces slowly and a
     * burst test never does.
     */
    pruneNotifications: (days: number) => laneQuery<{ n: string }>('jobs', `
        WITH gone AS (
            DELETE FROM notifications
             WHERE ts < now() - make_interval(days => $1::int)
            RETURNING 1
        ) SELECT count(*)::text AS n FROM gone`, [days]),

    /**
     * WHY DID THIS RETURN NOTHING? One cheap bounded query, run only when a
     * search matched zero rows and used an exact host: or app:.
     *
     * Exact-by-default fails SILENTLY WRONG: `host:core` returns zero rows and
     * the operator concludes there are no logs from that device. Substring has
     * a performance cost; exact has a WRONG ANSWER cost, and the answer to that
     * is not to change the operator - it is to explain the result. If the value
     * is a substring of a host or app that DOES exist in the window, say so and
     * name the operator that would have found it.
     *
     * Bounded three ways: the window, a LIKE on an indexed column, and LIMIT 5.
     * It runs at most once per zero-result search, on the interactive lane.
     */
    uiNearMisses: (from: Date, to: Date, host: string | null, app: string | null) =>
        laneQuery<{ kind: string; value: string }>('interactive', `
        (SELECT 'host' AS kind, host AS value FROM messages
          WHERE ts >= $1 AND ts < $2 AND $3::text IS NOT NULL
            AND host ILIKE '%' || $3 || '%' AND host <> $3
          GROUP BY host LIMIT 5)
        UNION ALL
        (SELECT 'app' AS kind, app AS value FROM messages
          WHERE ts >= $1 AND ts < $2 AND $4::text IS NOT NULL
            AND app ILIKE '%' || $4 || '%' AND app <> $4
          GROUP BY app LIMIT 5)`, [from, to, host, app]),

    // --- the UI's reads, on the INTERACTIVE lane ---------------------------------
    //
    // The scan's ops above run on the jobs lane because they belong to the
    // jobs worker. These serve HTTP requests, so they take the interactive
    // lane's statement timeout and queue like every other page read - a slow
    // dashboard must never compete with the machinery it is watching.

    /** Open alerts for the UI, worst first, newest within a severity. */
    uiOpenAlerts: (limit: number = UI_PAGE_CAP) => laneQuery<AlertRecord & { in_maintenance: boolean; under_policy: boolean }>('interactive', `
        SELECT ${ALERT_COLUMNS},
               ${ALERT_IN_MAINTENANCE} AS in_maintenance,
               ${ALERT_UNDER_POLICY} AS under_policy
          FROM alerts
         WHERE state != 'cleared'
         ORDER BY CASE severity WHEN 'crit' THEN 0 ELSE 1 END,
                  raised_ts DESC NULLS LAST, first_breach_ts DESC
         LIMIT $1`, [Math.min(Math.max(1, limit), UI_PAGE_CAP)]),

    /**
     * The three numbers the alerts page states as fact, computed over the
     * WHOLE open set rather than over whatever the cap returned.
     *
     * Called ONLY when uiOpenAlerts came back full, so a normal page costs
     * one query as before. It exists because the page's own comment makes a
     * promise the cap would otherwise break: "an alert nobody received is the
     * one failure this page exists to make impossible to miss." An undelivered
     * count derived from a truncated list understates precisely that, and
     * would look like a smaller problem rather than a truncated one.
     *
     * One scan, three aggregates, no sort and no 20-column projection - which
     * is why this is cheap where the query it accompanies is not.
     */
    uiOpenAlertCounts: () => laneQuery<{ total: number; crits: number; owed: number }>(
        'interactive', `
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE severity = 'crit')::int AS crits,
               count(*) FILTER (WHERE state != 'pending' AND NOT notified_raise)::int AS owed
          FROM alerts
         WHERE state != 'cleared'`),

    /** Recent history, bounded - rule 3: every query carries a LIMIT. */
    uiRecentCleared: (limit: number) => laneQuery<AlertRecord>('interactive', `
        SELECT ${ALERT_COLUMNS} FROM alerts
         WHERE state = 'cleared'
         ORDER BY cleared_ts DESC
         LIMIT $1`, [Math.min(Math.max(1, limit), 200)]),

    /**
     * One alert by id, for the U3 drill-down. Not filtered by state: the
     * detail view must still open on an alert that cleared while it was on
     * screen, or the operator's click lands on an error at exactly the
     * moment the thing they were watching resolved.
     */
    uiAlert: (id: string) => laneQuery<AlertRecord & { in_maintenance: boolean; under_policy: boolean }>('interactive', `
        SELECT ${ALERT_COLUMNS},
               ${ALERT_IN_MAINTENANCE} AS in_maintenance,
               ${ALERT_UNDER_POLICY} AS under_policy
          FROM alerts WHERE id = $1::bigint`, [id]),

    /**
     * Does this device report BOTH a battery and a filesystem?
     *
     * The shape of a laptop on battery - and, identically, of a server whose
     * SNMP agent reports the UPS it is plugged into alongside its own disks.
     * The feed cannot tell them apart, and THAT IS THE WHOLE POINT: this
     * answers a question for a human, never for the engine. Nothing branches
     * on it. See the note beside the state default in alerts/scan.ts.
     *
     * Read from entities rather than the roster summary columns so it says
     * what the device REPORTS, independent of what happens to be tracked or
     * fresh right now.
     */
    deviceBatteryShape: (name: string) => laneQuery<{ battery_host: boolean }>('interactive', `
        SELECT count(*) FILTER (WHERE e.kind = 'battery') > 0
           AND count(*) FILTER (WHERE e.kind = 'fs') > 0 AS battery_host
          FROM entities e JOIN devices d ON d.id = e.device_id
         WHERE d.name = $1`, [name]),

    /**
     * One incident's delivery log, newest first.
     *
     * This is the only durable record of what was SENT, as opposed to what
     * was true - and the two differ, which is the point of showing it. A row
     * here with ok=false is a delivery that failed on that channel; the alert
     * row's notified_raise is the folded per-incident bit, so an alert can
     * read "delivered" while this log carries three failures that preceded
     * the success. The operator asking "did anyone get paged?" is asking
     * about THIS table, not about the alert's state.
     *
     * Bounded like every other read. A renotifying alert accrues a row per
     * channel per interval, so a long weekend incident can carry hundreds.
     */
    uiAlertHistory: (id: string, limit: number) => laneQuery<NotificationRecord>('interactive', `
        SELECT id::text AS id, ts, event, channel, ok, detail
          FROM notifications
         WHERE alert_id = $1::bigint
         ORDER BY ts DESC, id DESC
         LIMIT $2`, [id, Math.min(Math.max(1, limit), 200)]),

    /**
     * The device board: status, freshness, and how many alerts each device
     * carries right now. Only devices the collector watches (same arming rule
     * as the scan), so the corpus's seeded fixtures do not render as a wall
     * of grey unknowns.
     */
    /**
     * One device's entities with last values, for the U1 drill-down. ONE
     * statement, and the budget test pins it: the parent's per-interface
     * "latest sample" loop is what cost 5,200 queries a page, and the same
     * N+1 shape has since been found three times in this fork's collector.
     *
     * Reads the denormalised lv_* columns rather than samples (slice 4e:
     * 2.2x against a well-written LATERAL, and hard to get wrong), and
     * carries lv_stale_since so the UI can render "not heard from lately"
     * as distinct from a genuine zero - the present-when-true rule reaching
     * the screen.
     */
    uiDeviceEntities: (deviceName: string) => laneQuery<{
        kind: string; extra: Record<string, unknown> | null;
        code: string; name: string; alias: string | null; descr: string | null;
        speed_bps: number | null; admin_status: number | null; oper_status: number | null;
        lv_ts: Date | null; lv_status: number | null; lv_rtt_ms: number | null;
        lv_v0: number | null; lv_v1: number | null; lv_v2: number | null;
        lv_v3: number | null; lv_v4: number | null; lv_v5: number | null;
        lv_stale_since: Date | null;
    }>('interactive', `
        -- kind and extra travel to the client since the sensors slice: the
        -- drill-down SPLITS on kind - sensors render as cards above the
        -- table, interfaces as the table - and a state sensor's display
        -- texts ride in extra. Tracked sensors were already flowing through
        -- this query via the tracked filter and rendering as nonsense
        -- interface rows; the split is the fix as much as the feature.
        -- tracked IS RETURNED, NOT FILTERED ON, since the untrack slice:
        -- this page is where tracking is now controlled, and a page that
        -- hides what is untracked is a control with no way back. The noise
        -- discovery skipped (Nu0, StackSub-*) surfaces here too, dimmed -
        -- which is honest, since "we saw this and chose not to watch it"
        -- and "we never saw this" are different facts.
        SELECT e.kind, e.extra, e.code, e.name, e.alias, e.descr, e.snmp_index,
               e.tracked, e.hc_missing,
               e.speed_bps::float8 AS speed_bps, e.admin_status, e.oper_status,
               e.speed_untrusted, e.speed_override_bps::float8 AS speed_override_bps,
               e.lv_ts, e.lv_status, e.lv_rtt_ms,
               e.lv_v0, e.lv_v1, e.lv_v2, e.lv_v3, e.lv_v4, e.lv_v5,
               e.lv_stale_since
          FROM entities e
          JOIN devices d ON d.id = e.device_id
         WHERE d.name = $1
         ORDER BY e.snmp_index NULLS LAST, e.name
         LIMIT 500`, [deviceName]),

    /**
     * One entity's history, RAW samples bucketed - the recent view.
     *
     * Bucketing in SQL rather than shipping every 30s point: a day at 30s is
     * 2,880 rows per series, and a chart 860 pixels wide cannot show them.
     * The bucket is computed by the caller from the range so the point count
     * stays bounded whatever the window.
     *
     * max(status), not min: IF-MIB reads 1 up / 2 down and the state kind
     * reads 1 ok / 2 alarm, so the LARGER value is the worse one in both.
     * A bucket that contained an outage says so.
     */
    entityHistoryRaw: (
        code: string, bucketSec: number, from: Date, to: Date,
    ) => laneQuery<{
        b: string; v0: number | null; v1: number | null;
        v2: number | null; v3: number | null; v4: number | null; v5: number | null;
        st: number | null;
    }>('interactive', `
        -- All six value columns, because an interface's history is two
        -- questions: how much traffic, and how much of it went wrong. v2-v5
        -- are the error and discard rates, which get their own chart rather
        -- than a second axis on the first one - see the comment on the
        -- error chart in public/app.js.
        --
        -- max() on the error and discard columns, not avg(): a bucket that
        -- contained a burst of CRC errors must SAY SO. Averaging a
        -- ten-second spike across a five-minute bucket is how a real fault
        -- renders as a rounding error.
        SELECT (floor(extract(epoch FROM s.ts) / $2) * $2)::bigint::text AS b,
               avg(s.v0)::float8 AS v0, avg(s.v1)::float8 AS v1,
               max(s.v2)::float8 AS v2, max(s.v3)::float8 AS v3,
               max(s.v4)::float8 AS v4, max(s.v5)::float8 AS v5,
               max(s.status)::int AS st
          FROM samples s
          JOIN entities e ON e.id = s.entity_id
         WHERE e.code = $1 AND s.ts >= $3 AND s.ts < $4
         GROUP BY 1 ORDER BY 1`, [code, bucketSec, from, to]),

    /**
     * The same shape from the ROLLUP - the long view. a0/a1 are the weighted
     * means the rollup computed (sum(a0*n)/sum(n), the arithmetic that makes
     * re-bucketing honest), st the worst status the hour reached.
     */
    entityHistoryHourly: (
        code: string, from: Date, to: Date,
    ) => laneQuery<{
        b: string; v0: number | null; v1: number | null;
        v2: number | null; v3: number | null; v4: number | null; v5: number | null;
        st: number | null; m0: number | null; m1: number | null;
    }>('interactive', `
        -- a2-a5 are the rollup's WEIGHTED MEANS of the error and discard
        -- rates, where the raw view takes max(). The difference is inherent
        -- rather than an inconsistency: an hour that averaged 0.4 errors a
        -- second had a real problem, and the rollup keeps no per-hour max
        -- for those columns (m0/m1 cover v0/v1 only). Worth knowing when
        -- comparing a 24-hour chart against a 30-day one - the older view
        -- is smoother because it is a different statistic, not because the
        -- fault went away.
        --
        -- m0/m1 ARE SERVED since easy-win E3: the rollup computed each
        -- hour's traffic maxima from the day it existed and NO reader ever
        -- consumed them, so the long view lost every peak to the hourly
        -- mean - the raw view's own "a real fault renders as a rounding
        -- error" warning happening quietly, one screen further out.
        SELECT extract(epoch FROM h.hour_ts)::bigint::text AS b,
               h.a0::float8 AS v0, h.a1::float8 AS v1,
               h.a2::float8 AS v2, h.a3::float8 AS v3,
               h.a4::float8 AS v4, h.a5::float8 AS v5,
               h.st::int AS st,
               h.m0::float8 AS m0, h.m1::float8 AS m1
          FROM samples_hourly h
          JOIN entities e ON e.id = h.entity_id
         WHERE e.code = $1 AND h.hour_ts >= $2 AND h.hour_ts < $3
         ORDER BY 1`, [code, from, to]),

    // --- reporting: the Dashboard's top lists and the interface report --------
    //
    // All of it reads samples_hourly - the per-hour mean rates, their sample
    // counts and the hourly peaks - so 24 hours is 24 narrow rows per entity
    // (568 ms for all 23,788 interfaces of the 30k lab, previous window
    // included). src/reports/traffic.ts turns the sums into bytes, counts,
    // coverage and trend; these return the sums. Heavy lane: fleet-wide
    // aggregation is exactly what that lane is for, and main caches the
    // Dashboard's answer per window so open browsers do not multiply it.

    /** The hour the rollup has consumed through: the end of every report
     *  window, because the rollup writes only complete hours. */
    rollupFrontier: () => laneQuery<{ through_ts: Date | null }>('interactive', `
        SELECT through_ts FROM job_state WHERE job = 'rollup'`),

    /**
     * Top interfaces over [lo, hi) three ways - received, transmitted, and
     * errors plus discards - each with the same interface's sums over the
     * previous window [prevLo, lo) for the trend. One scan of the hourly
     * rows serves all three lists.
     *
     * Coverage per hour is min(1, samples x poll interval / 3600): a fully
     * polled hour counts 1, a missing one 0.
     */
    dashboardInterfaces: (prevLo: Date, lo: Date, hi: Date, limit: number) => laneQuery<{
        list: 'rx' | 'tx' | 'errs'; rk: number;
        device: string; code: string; name: string | null; alias: string | null; speed_bps: string | null;
        in_s: number | null; out_s: number | null; pk_in: number | null; pk_out: number | null;
        err_s: number | null; disc_s: number | null; cov_h: number | null;
        p_in_s: number | null; p_out_s: number | null; p_ed_s: number | null; p_cov_h: number | null;
    }>('heavy', `
        WITH agg AS (
            SELECT h.entity_id,
                   sum(h.a0) FILTER (WHERE h.hour_ts >= $2) AS in_s,
                   sum(h.a1) FILTER (WHERE h.hour_ts >= $2) AS out_s,
                   max(h.m0) FILTER (WHERE h.hour_ts >= $2) AS pk_in,
                   max(h.m1) FILTER (WHERE h.hour_ts >= $2) AS pk_out,
                   sum(coalesce(h.a2, 0) + coalesce(h.a3, 0)) FILTER (WHERE h.hour_ts >= $2) AS err_s,
                   sum(coalesce(h.a4, 0) + coalesce(h.a5, 0)) FILTER (WHERE h.hour_ts >= $2) AS disc_s,
                   sum(least(1, coalesce(coalesce(h.n0, h.n) * d.poll_interval_s / 3600.0, 0)))
                       FILTER (WHERE h.hour_ts >= $2) AS cov_h,
                   sum(h.a0) FILTER (WHERE h.hour_ts < $2) AS p_in_s,
                   sum(h.a1) FILTER (WHERE h.hour_ts < $2) AS p_out_s,
                   sum(coalesce(h.a2, 0) + coalesce(h.a3, 0) + coalesce(h.a4, 0) + coalesce(h.a5, 0))
                       FILTER (WHERE h.hour_ts < $2) AS p_ed_s,
                   sum(least(1, coalesce(coalesce(h.n0, h.n) * d.poll_interval_s / 3600.0, 0)))
                       FILTER (WHERE h.hour_ts < $2) AS p_cov_h
              FROM samples_hourly h
              JOIN entities e ON e.id = h.entity_id AND e.kind = 'if'
              JOIN devices d ON d.id = e.device_id
             WHERE h.hour_ts >= $1 AND h.hour_ts < $3
             GROUP BY h.entity_id
        ), ranked AS (
            (SELECT 'rx' AS list, row_number() OVER (ORDER BY in_s DESC) AS rk, agg.*
               FROM agg WHERE in_s > 0 ORDER BY in_s DESC LIMIT $4)
            UNION ALL
            (SELECT 'tx', row_number() OVER (ORDER BY out_s DESC), agg.*
               FROM agg WHERE out_s > 0 ORDER BY out_s DESC LIMIT $4)
            UNION ALL
            (SELECT 'errs', row_number() OVER (ORDER BY err_s + disc_s DESC), agg.*
               FROM agg WHERE err_s + disc_s > 0 ORDER BY err_s + disc_s DESC LIMIT $4)
        )
        SELECT r.list, r.rk::int AS rk, d.name AS device, e.code, e.name, e.alias,
               coalesce(e.speed_override_bps, e.speed_bps)::text AS speed_bps,
               r.in_s::float8 AS in_s, r.out_s::float8 AS out_s,
               r.pk_in::float8 AS pk_in, r.pk_out::float8 AS pk_out,
               r.err_s::float8 AS err_s, r.disc_s::float8 AS disc_s, r.cov_h::float8 AS cov_h,
               r.p_in_s::float8 AS p_in_s, r.p_out_s::float8 AS p_out_s, r.p_ed_s::float8 AS p_ed_s,
               r.p_cov_h::float8 AS p_cov_h
          FROM ranked r
          JOIN entities e ON e.id = r.entity_id
          JOIN devices d ON d.id = e.device_id
         ORDER BY r.list, r.rk`, [prevLo, lo, hi, limit]),

    /**
     * Highest CPU and memory over [lo, hi), by the window's mean, with the
     * peak and the previous window's mean. CPU rows carry a percentage in
     * a0; memory rows carry USED bytes in a0 and SIZE in a1, so memory is
     * 100 x a0 / a1 per hour, and its peak 100 x m0 / a1. Means are
     * weighted by each hour's sample count - averaging the hourly averages
     * would mis-weight the hours the poller struggled.
     */
    dashboardSensors: (prevLo: Date, lo: Date, hi: Date, limit: number) => laneQuery<{
        list: 'cpu' | 'mem'; rk: number; device: string; code: string; name: string | null;
        mean_pct: number | null; peak_pct: number | null; cov_h: number | null; p_mean_pct: number | null;
        p_cov_h: number | null;
    }>('heavy', `
        WITH hours AS (
            SELECT h.entity_id, e.kind, h.hour_ts, coalesce(h.n0, h.n) AS n0, d.poll_interval_s,
                   CASE WHEN e.kind = 'mem' THEN 100 * h.a0 / nullif(h.a1, 0) ELSE h.a0 END AS pct,
                   CASE WHEN e.kind = 'mem' THEN 100 * h.m0 / nullif(h.a1, 0) ELSE h.m0 END AS peak
              FROM samples_hourly h
              JOIN entities e ON e.id = h.entity_id AND e.kind IN ('cpu', 'mem')
              JOIN devices d ON d.id = e.device_id
             WHERE h.hour_ts >= $1 AND h.hour_ts < $3
        ), agg AS (
            SELECT entity_id, kind,
                   sum(pct * n0) FILTER (WHERE hour_ts >= $2)
                       / nullif(sum(n0) FILTER (WHERE hour_ts >= $2 AND pct IS NOT NULL), 0) AS mean_pct,
                   max(peak) FILTER (WHERE hour_ts >= $2) AS peak_pct,
                   sum(least(1, coalesce(n0 * poll_interval_s / 3600.0, 0))) FILTER (WHERE hour_ts >= $2) AS cov_h,
                   sum(pct * n0) FILTER (WHERE hour_ts < $2)
                       / nullif(sum(n0) FILTER (WHERE hour_ts < $2 AND pct IS NOT NULL), 0) AS p_mean_pct,
                   sum(least(1, coalesce(n0 * poll_interval_s / 3600.0, 0))) FILTER (WHERE hour_ts < $2) AS p_cov_h
              FROM hours GROUP BY entity_id, kind
        ), ranked AS (
            SELECT agg.*, row_number() OVER (PARTITION BY kind ORDER BY mean_pct DESC) AS rk
              FROM agg WHERE mean_pct IS NOT NULL
        )
        SELECT r.kind AS list, r.rk::int AS rk, d.name AS device, e.code, e.name,
               r.mean_pct::float8 AS mean_pct, r.peak_pct::float8 AS peak_pct,
               r.cov_h::float8 AS cov_h, r.p_mean_pct::float8 AS p_mean_pct, r.p_cov_h::float8 AS p_cov_h
          FROM ranked r
          JOIN entities e ON e.id = r.entity_id
          JOIN devices d ON d.id = e.device_id
         WHERE r.rk <= $4
         ORDER BY r.kind, r.rk`, [prevLo, lo, hi, limit]),

    /**
     * The interface report: one row per chosen interface per calendar day in
     * `tz`, from `fromDay` to `toDay` inclusive, for the days that had begun
     * by the rollup frontier. A day with no hourly rows still returns (LEFT
     * JOIN) with null sums and zero coverage, so a gap is a line saying so
     * rather than a missing date. expected_h is the day's hours inside the
     * rollup - 24, or 23 and 25 on DST days, or fewer on the current day.
     */
    trafficReport: (codes: string[], fromDay: string, toDay: string, tz: string, frontier: Date) => laneQuery<{
        day: string; device: string; name: string | null; alias: string | null; code: string;
        sum_in: number | null; sum_out: number | null; peak_in: number | null; peak_out: number | null;
        covered_h: number | null; expected_h: number;
    }>('heavy', `
        WITH days AS (
            SELECT g::date AS day,
                   (g::date::timestamp AT TIME ZONE $4) AS lo,
                   ((g::date + 1)::timestamp AT TIME ZONE $4) AS hi
              FROM generate_series($2::date, $3::date, interval '1 day') AS g
        ), ents AS (
            SELECT e.id, e.code, e.name, e.alias, d.name AS device, d.poll_interval_s
              FROM entities e JOIN devices d ON d.id = e.device_id
             WHERE e.code = ANY($1::text[])
        )
        SELECT to_char(dy.day, 'YYYY-MM-DD') AS day, en.device, en.name, en.alias, en.code,
               sum(h.a0)::float8 AS sum_in, sum(h.a1)::float8 AS sum_out,
               max(h.m0)::float8 AS peak_in, max(h.m1)::float8 AS peak_out,
               -- least() IGNORES NULLS: least(1, NULL) is 1, not NULL. A day with no
               -- hourly rows reaches here as one LEFT JOIN row of NULLs, and the
               -- bare form counted it as a covered hour - every empty day read
               -- "4%" in the first rendered report. coalesce to 0 first.
               sum(least(1, coalesce(coalesce(h.n0, h.n) * en.poll_interval_s / 3600.0, 0)))::float8 AS covered_h,
               greatest(0, extract(epoch FROM least(dy.hi, $5) - dy.lo) / 3600.0)::float8 AS expected_h
          FROM days dy
         CROSS JOIN ents en
          LEFT JOIN samples_hourly h
            ON h.entity_id = en.id AND h.hour_ts >= dy.lo AND h.hour_ts < dy.hi AND h.hour_ts < $5
         WHERE dy.lo < $5
         GROUP BY dy.day, dy.lo, dy.hi, en.device, en.name, en.alias, en.code
         ORDER BY en.device, en.name, dy.day`, [codes, fromDay, toDay, tz, frontier]),

    uiDevices: (limit: number = UI_PAGE_CAP) => laneQuery<{
        name: string; host: string; status: string; last_poll_ts: Date;
        last_seen_ts: Date | null; poll_interval_s: number;
        reach_state: string; reach_since_ts: Date | null; reach_rtt_ms: number | null;
        poll_lag_ms: number | null; ping_rtt_ms: number | null;
        snmp_rtt_ms: number | null;
        credential_ref: string; snmp_enabled: boolean;
        entities: number; tracked_ifs: number; tracked_sensors: number;
        open_alerts: number; worst: string | null;
        location: string | null; application: string | null;
        transient: boolean; alerts_muted: boolean;
        // The aggregate columns (SLICE-ROSTER-COLUMNS-PLAN): null means no
        // fresh reading of that kind, never zero.
        cpu_pct: number | null; mem_pct: number | null;
        fs_pct: number | null; fs_name: string | null; temp_c: number | null;
        down_ports: number; if_count: number; if_errs: number | null;
        top_if: string | null; top_bps: number | null; top_speed: number | null;
        alarms: number; state_sensors: number;
        batt_pct: number | null; runtime_s: number | null;
        sys_descr: string | null; cpu_model: string | null;
        uptime_s: number | null; cpu_cores: number | null; ram_kb: number | null;
    }>('interactive', `
        -- GROUPED AGGREGATES JOINED ONCE, never correlated subqueries per row.
        --
        -- The first version ran three subqueries PER DEVICE: 405 devices x
        -- (entities count + alerts count + alerts min) = 1,215 scans, two of
        -- them against a table that GROWS: alerts accumulates cleared
        -- history toward the 90-day retention and carries no index on host.
        -- Measured on the demo 2026-08-02: 125,348 buffer pages per call
        -- (~1 GB) to list 405 devices, 265ms, and 13.4% of ALL database time
        -- since the run began - the second most expensive statement in the
        -- system, to render one page of the UI.
        --
        -- This form makes one grouped pass over each table and joins: 5,584
        -- pages, a 22.4x reduction, verified row-for-row identical against
        -- the old form (0 differing rows via EXCEPT in both directions)
        -- before replacing it. The growth is removed as well as the cost -
        -- one pass over alerts costs what alerts costs, rather than 810
        -- passes over it.
        SELECT d.name, host(d.host) AS host,
               -- Slice 35: ONE definition of status, shared with the alert
               -- scan and the wall - a ping-only device's comes from reach.
               ${deviceStatusSql('d')} AS status,
               d.snmp_enabled,
               d.last_poll_ts,
               d.last_seen_ts, d.poll_interval_s,
               -- Reachability rides the same row read as the grouping columns
               -- below: plain columns, no join, no per-device work, budget
               -- unchanged at 1. The roster shows BOTH instruments separately
               -- rather than the scan's merged verdict, because "host pings
               -- but the agent is dead" is a diagnosis the merge erases.
               d.reach_state, d.reach_since_ts, d.reach_rtt_ms,
               d.poll_lag_ms::float8 AS poll_lag_ms, d.ping_rtt_ms::float8 AS ping_rtt_ms,
               -- Easy-win E9: same blank-when-not-up rule as the summary
               -- columns - a slow reading from before the device went down
               -- must not keep it on the slow-agents list.
               CASE WHEN d.status = 'up' THEN d.snmp_rtt_ms END::float8 AS snmp_rtt_ms,
               d.credential_ref,
               coalesce(e.n, 0)::int AS entities,
               -- The roster's "interfaces" column counted ALL tracked
               -- entities, sensors included (operator, 2026-09-23: "seems to be
               -- a count of tracked sensors rather than interfaces"). Split
               -- inside the same grouped pass - no second scan - the way the
               -- onboarding preview already split them. "entities" stays the
               -- total for API callers that read it.
               coalesce(e.n_if, 0)::int AS tracked_ifs,
               coalesce(e.n - e.n_if, 0)::int AS tracked_sensors,
               coalesce(a.n, 0)::int AS open_alerts,
               a.worst,
               -- Two more columns on a statement whose whole history is about
               -- cost: these are plain columns of the row already being read,
               -- so they add no join, no scan and no per-device work. The
               -- query budget test pins that claim.
               d.location, d.application,
               d.transient, d.alerts_muted,
               -- THE SUMMARY COLUMNS (slice 20), written by the collector at
               -- poll time and read here as plain columns: the aggregate form
               -- failed its budget at 450 devices (SLICE-ROSTER-COLUMNS-PLAN,
               -- the measurement). BLANKED WHEN THE DEVICE IS NOT UP: a
               -- reading from a poll that has since failed is the last value
               -- received, not a current one, and the device page already
               -- refuses to present that as data - the roster follows. Null
               -- means nothing of the kind was measured; the counts are zero
               -- when there is nothing to count, which is a measurement.
               CASE WHEN d.status = 'up' THEN d.cpu_pct END::float8 AS cpu_pct,
               CASE WHEN d.status = 'up' THEN d.mem_pct END::float8 AS mem_pct,
               CASE WHEN d.status = 'up' THEN d.fs_pct END::float8 AS fs_pct,
               CASE WHEN d.status = 'up' THEN d.fs_name END AS fs_name,
               CASE WHEN d.status = 'up' THEN d.temp_c END::float8 AS temp_c,
               CASE WHEN d.status = 'up' THEN coalesce(d.down_ports, 0) ELSE 0 END::int AS down_ports,
               CASE WHEN d.status = 'up' THEN coalesce(d.if_count, 0) ELSE 0 END::int AS if_count,
               CASE WHEN d.status = 'up' THEN d.if_errs END::float8 AS if_errs,
               CASE WHEN d.status = 'up' THEN d.top_if END AS top_if,
               CASE WHEN d.status = 'up' THEN d.top_bps END::float8 AS top_bps,
               CASE WHEN d.status = 'up' THEN d.top_speed END::float8 AS top_speed,
               CASE WHEN d.status = 'up' THEN coalesce(d.alarms, 0) ELSE 0 END::int AS alarms,
               CASE WHEN d.status = 'up' THEN coalesce(d.state_sensors, 0) ELSE 0 END::int AS state_sensors,
               CASE WHEN d.status = 'up' THEN d.batt_pct END::float8 AS batt_pct,
               CASE WHEN d.status = 'up' THEN d.runtime_s END::float8 AS runtime_s,
               d.sys_descr, d.cpu_model,
               -- Slice 21: uptime is a reading (blank when not up, like the
               -- summary); cores and RAM are inventory facts and stay.
               CASE WHEN d.status = 'up' THEN d.uptime_s END::float8 AS uptime_s,
               d.cpu_cores, d.ram_kb::float8 AS ram_kb
          FROM devices d
          LEFT JOIN (SELECT device_id, count(*) AS n,
                            count(*) FILTER (WHERE kind = 'if') AS n_if
                       FROM entities WHERE tracked GROUP BY device_id) e
                 ON e.device_id = d.id
          LEFT JOIN (SELECT host, count(*) AS n, min(severity) AS worst
                       FROM alerts WHERE state IN ('active', 'clearing')
                      GROUP BY host) a
                 ON a.host = d.name
        -- NEVER-POLLED DEVICES BELONG IN THE ROSTER, and excluding them was a
        -- bug found on the first real onboarding (2026-08-15). last_poll_ts is
        -- NULL until the collector reaches a device for the first time, so an
        -- IS NOT NULL test here meant the add flow reported "added 4" and then
        -- the list it refetched genuinely did not contain them.
        -- The devices appeared a poll interval later, which reads exactly like
        -- the add having failed and the page being stale.
        --
        -- The SCAN's version of this query keeps the filter, and should: a
        -- device with no poll age cannot be judged late, and that is the
        -- enabled-versus-polled distinction the comment below it draws. The
        -- roster is answering a different question - "what did I just add" -
        -- and a device the operator created a second ago is the most
        -- interesting row on the page, not one to withhold until it earns a
        -- timestamp.
         WHERE d.enabled = true
         ORDER BY d.name
         LIMIT $1`, [Math.min(Math.max(1, limit), UI_PAGE_CAP)]),

    /** Enabled devices, for when uiDevices came back full. No join, no sort,
     *  no 40-column projection - the count is cheap where the roster is not. */
    uiDeviceCount: () => laneQuery<{ total: number }>('interactive', `
        SELECT count(*)::int AS total FROM devices WHERE enabled = true`),

    /**
     * The scan's device roster: what the collector is ACTUALLY watching.
     *
     * `last_poll_ts IS NOT NULL` is the arming rule, and it is the fork's
     * version of AlertCanvas's "a blank status_file disables the feed": a
     * device the collector has never polled has no opinion to alert on - which
     * also keeps the lab corpus's seeded fixture devices (never polled by a
     * collector) out of a scan that would otherwise open hundreds of
     * device-down alerts about synthetic hardware.
     */
    alertScanDevices: () => laneQuery<{
        name: string; host: string; status: string; transient: boolean;
        alerts_muted: boolean; snmp_enabled: boolean;
        poll_age_s: number; poll_interval_s: number;
    }>('alerts', `
        -- EFFECTIVE status merges both instruments (slice 9): ICMP-down wins
        -- over SNMP-up because ping notices in seconds what the 30s poll
        -- notices in up to a minute - and SNMP-down stands even when ping
        -- answers, because a host that pings while its agent is dead is
        -- monitored in name only. reach 'unknown' and 'degraded' defer to
        -- SNMP entirely: absence of ping data is not an outage, and degraded
        -- is not down. ONE condition key per device either way - the operator
        -- gets one device-down alert, not one per instrument, and the
        -- interface freeze downstream of it applies unchanged at ICMP speed.
        SELECT name, host(host) AS host,
               ${deviceStatusSql('devices')} AS status,
               transient, alerts_muted, snmp_enabled,
               -- ONE CLOCK: the age is computed by POSTGRES, against the same
               -- now() that stamped last_poll_ts in recordDevicePoll. The scan
               -- previously compared the jobs worker's JS clock against these
               -- Postgres timestamps, which fails permanently CLOSED when the
               -- app clock runs ahead (the collector reads stale forever, the
               -- watchdog raises forever, and mayAge freezes stepMissing with
               -- it) and permanently OPEN when it runs behind (a genuinely
               -- dead collector reads fresh). The database's clock is the one
               -- both sides can see.
               extract(epoch FROM now() - last_poll_ts)::int AS poll_age_s,
               poll_interval_s
          FROM devices
         WHERE enabled = true
           -- Slice 35: last_poll_ts is the SNMP poll's stamp, so gating on it
           -- would exclude every ping-only device from the alert scan
           -- entirely - they would go down and nothing would ever raise.
           AND (snmp_enabled = false OR last_poll_ts IS NOT NULL)`),

    /**
     * ENABLED versus POLLED, so the scan can tell a decision from a fault.
     *
     * The roster query above filters last_poll_ts IS NOT NULL, which is right
     * for its consumers - but used ALONE it made an unpolled fleet invisible:
     * enabled devices that the collector has never reached simply did not
     * appear, the roster was empty, and empty read as healthy-but-idle. A
     * monitoring system watching nothing, reporting green - the same
     * absent-versus-partial discrimination as the half-configured SMTP
     * channel, in the alerting path.
     */
    alertScanCoverage: () => laneQuery<{ enabled_total: number; polled_total: number }>('alerts', `
        -- Slice 35: POLLED devices only, both sides. A ping-only device is
        -- enabled and will never have a last_poll_ts, so counting it here
        -- would drag polled_total below enabled_total forever - and a fleet
        -- of nothing BUT ping-only devices would read as "the collector has
        -- never polled any of N devices", which is the alarm for a genuinely
        -- dead collector. An alarm a supported configuration can trip is an
        -- alarm operators learn to ignore.
        SELECT count(*) FILTER (WHERE enabled AND snmp_enabled)::int AS enabled_total,
               count(*) FILTER (WHERE enabled AND snmp_enabled AND last_poll_ts IS NOT NULL)::int AS polled_total
          FROM devices`),

    /**
     * The scan's interface view, from the lv_* columns - the fork's feed is
     * the store, not a JSON file another process wrote.
     *
     * fresh is computed HERE, against the device's own poll interval: rates
     * older than three intervals are not evidence of anything, and the scan
     * maps them to null so rules freeze rather than judge. Three is the
     * parent's staleness multiplier for its feed, kept for the same reason.
     */
    alertScanInterfaces: () => laneQuery<{
        code: string | null; name: string | null; alias: string | null;
        speed_bps: number | null; admin_status: number | null;
        lv_status: number | null;
        lv_v0: number | null; lv_v1: number | null; lv_v2: number | null;
        lv_v3: number | null; lv_v4: number | null; lv_v5: number | null;
        fresh: boolean;
        /** The went-quiet stamp, for the ghost gate (src/alerts/ghosts.ts). */
        lv_stale_since: Date | null;
        device_name: string; device_host: string; device_status: string;
    }>('alerts', `
        -- THE TRUSTED SPEED, resolved here so the rules engine needs no
        -- change: an operator override outranks the advertised speed, and a
        -- convicted advertised speed becomes NULL - which the existing
        -- (speedBps ?? 0) > 0 guard in rules.ts already treats as "no
        -- utilization rule". Suspended, not computed against fiction; the
        -- TrueNAS vtnet at 218% is the case. See src/collector/speedtrust.ts.
        SELECT e.code, e.name, e.alias,
               CASE WHEN e.speed_override_bps > 0 THEN e.speed_override_bps
                    WHEN e.speed_untrusted THEN NULL
                    ELSE e.speed_bps END::float8 AS speed_bps,
               e.admin_status, e.lv_status,
               e.lv_v0, e.lv_v1, e.lv_v2, e.lv_v3, e.lv_v4, e.lv_v5,
               (e.lv_ts IS NOT NULL
                AND e.lv_ts > now() - (d.poll_interval_s * 3 || ' seconds')::interval)
                   AS fresh,
               e.lv_stale_since,
               d.name AS device_name, host(d.host) AS device_host, d.status AS device_status
          FROM entities e
          JOIN devices d ON d.id = e.device_id
         WHERE e.kind = 'if' AND e.tracked = true
           AND d.enabled = true AND d.last_poll_ts IS NOT NULL`),

    /**
     * The sensor half of the same roster, for the metric thresholds that
     * AlertCanvas's engine has carried since slice 6 with nothing feeding
     * them.
     *
     * THE VALUE IS COMPUTED HERE, not in the caller, because the threshold
     * config is in the units an operator thinks in: disk and mem are
     * PERCENT (warn 85, crit 95), and this fork stores them as used/total
     * BYTES. The percent is derived at the point of use everywhere else in
     * the product - the cards, the drill-down - and this is one more of
     * those points, not a new convention.
     *
     * The same three-interval freshness rule as the interface query above:
     * a sensor nobody has heard from is FROZEN by the caller, never read as
     * a comfortable number.
     */
    alertScanSensors: () => laneQuery<{
        code: string; name: string; kind: string; value: number | null;
        unit: string | null; fresh: boolean;
        device_name: string; device_status: string;
    }>('alerts', `
        SELECT e.code, e.name,
               -- The kind names differ between the collector's vocabulary and
               -- the rules engine's, and the mismatch is silent: an unknown
               -- kind is skipped by evaluate() with no error, so a whole
               -- class of sensor would simply never alert. Mapped once, here.
               CASE e.kind WHEN 'fs' THEN 'disk' WHEN 'gauge' THEN 'util'
                           ELSE e.kind END AS kind,
               CASE
                   WHEN e.kind IN ('fs', 'mem')
                       THEN CASE WHEN e.lv_v1 > 0
                                 THEN round((100 * e.lv_v0 / e.lv_v1)::numeric, 1)::float8
                                 ELSE NULL END
                   ELSE e.lv_v0
               END AS value,
               CASE e.kind WHEN 'fs' THEN '%' WHEN 'mem' THEN '%' WHEN 'cpu' THEN '%'
                           WHEN 'gauge' THEN '%' WHEN 'battery' THEN '%'
                           WHEN 'temp' THEN 'C' WHEN 'fan' THEN 'rpm'
                           WHEN 'runtime' THEN 's' WHEN 'power' THEN 'W'
                           ELSE coalesce(e.extra->>'unit', '') END AS unit,
               (e.lv_ts IS NOT NULL
                AND e.lv_ts > now() - (d.poll_interval_s * 3 || ' seconds')::interval)
                   AS fresh,
               d.name AS device_name, d.status AS device_status
          FROM entities e
          JOIN devices d ON d.id = e.device_id
         WHERE e.kind <> 'if' AND e.tracked = true
           AND d.enabled = true AND d.last_poll_ts IS NOT NULL`),
} as const;

/** One alert as stored. Column list and record type stay side by side. */
export interface AlertRecord {
    id: string;
    alert_key: string;
    state: 'pending' | 'active' | 'clearing' | 'cleared';
    severity: 'warn' | 'crit';
    kind: string;
    host: string | null;
    code: string | null;
    label: string;
    value: number | null;
    peak_value: number | null;
    threshold: number | null;
    unit: string;
    breach_count: number;
    clear_count: number;
    missing_count: number;
    first_breach_ts: Date;
    raised_ts: Date | null;
    escalated_ts: Date | null;
    cleared_ts: Date | null;
    last_seen_ts: Date;
    renotified_ts: Date | null;
    acked_ts: Date | null;
    clear_reason: string | null;
    notified_raise: boolean;
    notified_clear: boolean;
    notified_escalate: boolean;
    notify_attempts: number;
    last_attempt_ts: Date | null;
}

export interface NotificationRecord {
    id: string;
    ts: Date;
    event: string;
    channel: string;
    ok: boolean;
    detail: string | null;
}

const ALERT_COLUMNS = `id::text AS id, alert_key, state, severity, kind, host, code, label,
    value, peak_value, threshold, unit, breach_count, clear_count, missing_count,
    first_breach_ts, raised_ts, escalated_ts, cleared_ts, last_seen_ts, renotified_ts, acked_ts,
    clear_reason, notified_raise, notified_clear, notified_escalate, notify_attempts, last_attempt_ts`;

/**
 * Is this alert's device inside an ACTIVE maintenance window right now?
 * (slice 22)
 *
 * Defined once and spliced into every statement that needs it - the owed
 * queries and the UI reads - so the drain and the page cannot drift apart on
 * what "in maintenance" means. Evaluated LIVE at each use (plan decision 3):
 * a window created after the alert raised but before the drain delivered it
 * suppresses that delivery, because the sequence that actually happens is
 * that the operator starts working and THEN remembers the window.
 *
 * host IS NOT NULL is the watchdog exemption working structurally: system
 * alerts (collector stalled, ingest stalled) carry no host, so no window of
 * any scope - 'all' included - can ever match one. If the monitor itself
 * dies at 02:30, the operator still hears about it.
 */
const ALERT_IN_MAINTENANCE = `(alerts.host IS NOT NULL AND EXISTS (
    SELECT 1 FROM maintenance_windows w
     WHERE now() >= w.starts_ts AND now() < w.ends_ts
       AND (w.scope = 'all'
            OR (w.scope = 'device' AND w.target = alerts.host)
            OR (w.scope IN ('location', 'application') AND EXISTS (
                SELECT 1 FROM devices d
                 WHERE d.name = alerts.host
                   AND w.target = CASE w.scope WHEN 'location' THEN d.location
                                               ELSE d.application END)))))`;

// Quiet 1 (slice 25): a STANDING policy - the alert raises, shows, and is
// never delivered while a covering row exists. Same shape as the window
// predicate minus the clock, and evaluated LIVE for the same reason: dropping
// the policy makes still-active alerts owed on the next pass, exactly as a
// cancelled window does. The watchdog is exempt structurally (host IS NULL),
// which matters more here than for windows - a policy has no expiry to save
// you from having silenced the smoke detector.
const ALERT_UNDER_POLICY = `(alerts.host IS NOT NULL AND EXISTS (
    SELECT 1 FROM notify_policy p
     WHERE (p.scope = 'device' AND p.target = alerts.host)
        OR (p.scope IN ('location', 'application') AND EXISTS (
            SELECT 1 FROM devices d
             WHERE d.name = alerts.host
               AND p.target = CASE p.scope WHEN 'location' THEN d.location
                                           ELSE d.application END))))`;
