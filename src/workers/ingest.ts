// The ingest worker. Owns the UDP sockets and nothing else runs on this thread.
//
// ARCHITECTURE.md gives this concern a dedicated worker for one reason: the OS
// receive buffer absorbs about 300ms of not-reading and no more, and dropping a
// datagram is a violated invariant rather than a degraded service. Anything
// else sharing this thread is a chance to miss that window.
//
// The batching policy is ported from syslogcanvas/server/store.js, where every
// constant is load bearing and was arrived at against this exact problem:
//
//   FLUSH_MS    300    max latency from datagram to database
//   FLUSH_ROWS  200    flush early when a burst starts filling the queue
//   FLUSH_CHUNK 2000   cap one transaction, so a burst cannot hold the thread
//                      long enough to overflow the OS receive buffer
//   QUEUE_MAX   50000  backpressure ceiling - INGEST_QUEUE_MAX since
//                      2026-09-30 (config.ts says what it costs)
//   DROP_BATCH  1%     shed in BATCHES, never one row per datagram: a
//                      per-datagram splice reindexes the whole 50k array, so a
//                      sustained flood costs O(n) per packet and O(n^2) over
//                      the burst
//
// One thing the parent needed that this does not. Its flush ran a synchronous
// SQLite transaction, so it had to hand control back with setImmediate between
// chunks or datagram reception would stall for the whole write. Here the COPY
// is awaited, which yields the loop for its entire duration, so reception
// drains DURING the write rather than between writes. The chunk cap stays
// anyway: it bounds how much work one failure loses, and it is what keeps a
// 50,000 row burst from becoming one enormous transaction.

import dgram from 'node:dgram';
import { isIP } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import { CONFIG } from '../config.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { installSafetyNet } from '../safety.ts';
import { copyMessages, closeAll, OPS, type MessageRow } from '../store/index.ts';
import { parse } from '../syslog/parse.ts';
import {
    compileRule, matchMessage, eventLabel, PENDING_EVENTS_MAX,
    type CompiledRule, type PendingEvent, type EventRule,
} from '../alerts/events.ts';
import { socketStats, systemStats, describeRcvbuf, PROC_AVAILABLE } from '../net/udpstats.ts';
import type { IngestStats } from './protocol.ts';
import { makeFlushGate, failureBackoffMs, shouldLogFailure } from './flush-gate.ts';
import { renderTrap, renderValue, deviceForAddress, hostForMessage, keptVarbinds, clipText } from '../syslog/trap.ts';
import { guardTrapReceiver, logSafe, type TrapDrop } from '../syslog/trap-guard.ts';
import { copyIsolating, isDataError } from './copy-isolate.ts';
import { decodePet, petSyslogSeverity } from '../syslog/pet.ts';
import { safeLogArgs } from '../logsafe.ts';

const FLUSH_MS = 300;
const FLUSH_ROWS = 200;
const FLUSH_CHUNK = 2000;
const QUEUE_MAX = CONFIG.ingestQueueMax;
const DROP_BATCH = Math.max(1, Math.floor(QUEUE_MAX * 0.01));

const hb = startHeartbeat('ingest', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);

let queue: MessageRow[] = [];
let received = 0;
let shed = 0;
let written = 0;
let flushes = 0;
let flushFailures = 0;
let nulsStripped = 0;
let truncated = 0;
/** Rows the database refused on their content and that were dropped alone
 *  (review F4) - the one deliberate loss besides shedding. */
let rowsRefused = 0;
let laneBusyEvents = 0;
let running = true;
let flushing = false;
// A database that refuses writes is retried on a backoff, not per datagram -
// see failureBackoffMs in flush-gate.ts for the drill that measured why.
// failingSince also feeds the health status: how long writes have been
// failing is the one number a monitor needs during an outage.
let failStreak = 0;
let failingSince: number | null = null;
let backoffUntil = 0;
function flushFailed(what: string): void {
    failStreak++;
    failingSince ??= Date.now();
    backoffUntil = Date.now() + failureBackoffMs(failStreak);
    if (shouldLogFailure(failStreak)) {
        log(`ALARM ${what} - rows requeued, depth now ${queue.length}; failing for `
            + `${Math.round((Date.now() - failingSince) / 1000)}s, attempt ${failStreak}, next in ${failureBackoffMs(failStreak)} ms`);
    }
}
function flushSucceeded(): void {
    if (failStreak > 0) {
        log(`flush recovered after ${failStreak} failed attempt(s) over `
            + `${Math.round((Date.now() - (failingSince ?? Date.now())) / 1000)}s - depth now ${queue.length}`);
    }
    failStreak = 0;
    failingSince = null;
    backoffUntil = 0;
}
// The flush timer lives in a gate that clears its handle before firing - see
// flush-gate.ts for the stale-handle defect the lab-5 ingest run found here.
const flushGate = makeFlushGate(() => { flush().catch(onAsyncError); }, FLUSH_MS);
/**
 * The chunk currently between the queue and a committed COPY.
 *
 * Rows spliced out of the queue exist nowhere else until the COPY commits, so
 * this is what the catch requeues. Without it a thrown COPY silently destroyed
 * up to 2,000 accepted datagrams per failure.
 */
let inFlightBatch: MessageRow[] | null = null;
// BOUNDED, same class as the collector's lagMs: unbounded push-per-flush plus
// a per-second sort is the growth that crashed the collector on 2026-07-29
// (its Math.max spread hit the stack limit at hour eleven). This array cannot
// stack-overflow - the sort spread is heap - but the sort cost and memory
// grow identically, and a rolling window answers "how are flushes NOW", which
// is what the percentiles are read for.
const FLUSH_WINDOW = 10_000;
const flushMs: number[] = [];
function pushFlushMs(v: number): void {
    flushMs.push(v);
    if (flushMs.length >= FLUSH_WINDOW * 2) flushMs.splice(0, flushMs.length - FLUSH_WINDOW);
}

// Kernel counters at startup, so every later figure is a delta rather than a
// lifetime total for a socket that may have existed across runs.
let baselineSyslogDrops = 0;
let baselineTrapDrops = 0;
let baselineSystem = { rcvbufErrors: 0, inErrors: 0 };
let peakRxQueueBytes = 0;

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[ingest]', ...safeLogArgs(args));
}

// Traps refused or failed, counted always and logged at most once a minute
// (2026-10-01, review F10): a line per packet was a journal flood any sender
// could drive, and the error text carried sender-chosen bytes - a v3 user
// name with a CR LF in it forged a log line.
const trapsRefused: Record<TrapDrop | 'error', number> = { v3: 0, malformed: 0, ack: 0, error: 0 };
const TRAP_DROP_TEXT: Record<TrapDrop | 'error', string> = {
    v3: 'refused: SNMPv3 is not accepted',
    malformed: 'dropped: the SNMP library could not handle it',
    ack: 'Inform acknowledgement could not be encoded (the trap itself was kept)',
    error: 'error',
};
let trapLogQuietUntil = 0;
let trapLogSuppressed = 0;
function trapProblem(why: TrapDrop | 'error', detail: string, from?: string): void {
    trapsRefused[why]++;
    const now = Date.now();
    if (now < trapLogQuietUntil) { trapLogSuppressed++; return; }
    trapLogQuietUntil = now + 60_000;
    const more = trapLogSuppressed > 0 ? ` (and ${trapLogSuppressed} more since the last line)` : '';
    trapLogSuppressed = 0;
    log(`trap ${TRAP_DROP_TEXT[why]}${from ? ` from ${from}` : ''}`
        + `${detail ? `: ${logSafe(detail.slice(0, 200))}` : ''}${more}`);
}

let asyncErrors = 0;

/**
 * The handler for every fire-and-forget call on this thread.
 *
 * On this worker especially, an unhandled rejection is not merely a crash: it
 * is a crash holding up to 50,000 accepted datagrams that were owed a write.
 * Every timer and every enqueue-triggered flush routes its failures here so a
 * database blip stays a retry rather than becoming data loss.
 */
function onAsyncError(err: unknown): void {
    asyncErrors++;
    const e = err instanceof Error ? err : new Error(String(err));
    log(`async error (${asyncErrors} total): ${e.message}`);
}

installSafetyNet({ thread: 'ingest', onRejection: () => { asyncErrors++; } });

// --- event alerting (slice 10) -----------------------------------------------
//
// Match at INGEST, in this worker, because raise latency is the design's
// point: the row is born active the flush after the message lands, never a
// scan tick later. The matching itself is on the hot path and priced
// accordingly - N substring tests per message where N is the enabled-rule
// count - and the heartbeat instrument that owns this thread is the check
// that the price stays paid (the plan's done-when says measure, not assume).
let compiledEventRules: CompiledRule[] = [];
let pendingEvents = new Map<string, PendingEvent>();
let eventMatches = 0;
let eventUpserts = 0;
let eventRuleErrors = 0;
let lastRulesSignature = '';

let eventRulesDisarmed = 0;
/**
 * Rules pulled out of the armed set at RUNTIME for blowing the per-message
 * budget (slice 10 / review S3). Distinct from eventRuleErrors, which counts
 * rules refused at COMPILE - these compiled fine and then behaved badly.
 *
 * Kept by id and re-checked on reload, so editing the pattern rearms it
 * without a restart while leaving an unedited one disarmed. A rule that
 * stalls the ingest thread must not come back merely because the rule list
 * was polled again.
 */
const disarmedRuleIds = new Map<string, string>();

function disarmRule(rule: EventRule, ms: number): void {
    if (disarmedRuleIds.has(rule.id)) return;
    disarmedRuleIds.set(rule.id, rule.pattern);
    compiledEventRules = compiledEventRules.filter((c) => c.rule.id !== rule.id);
    eventRulesDisarmed = disarmedRuleIds.size;
    // LOUD, AND BY NAME. "the ingest thread stalled" is what the heartbeat
    // says; it does not say which rule, and the whole point of this counter
    // is to name the subject rather than the symptom.
    console.error(`[ingest] ALARM event rule "${rule.name}" took ${ms.toFixed(0)}ms on a single `
        + 'message and has been DISARMED - it will not run again until its pattern is edited. '
        + `Pattern: ${rule.pattern.slice(0, 120)}`);
}

// Which device is at which address, for traps and for syslog lines that name
// no host (syslog/trap.ts). Refreshed on the event rules' timer; a device
// added a moment ago is attributed within 30 s, and until then its messages
// carry the address alone, as they always did.
let devicesByAddress = new Map<string, string[]>();
async function reloadDeviceAddresses(): Promise<void> {
    const res = await OPS.deviceAddresses();
    if (!res.ok) return;   // keep the last good map
    devicesByAddress = new Map(res.rows.map((r) => [r.address, r.names]));
}

async function reloadEventRules(): Promise<void> {
    await reloadDeviceAddresses();
    const res = await OPS.eventRules();
    if (!res.ok) return;   // lane hiccup: keep the last good set, retry next tick
    const signature = JSON.stringify(res.rows);
    if (signature === lastRulesSignature) return;
    lastRulesSignature = signature;
    const compiled: CompiledRule[] = [];
    let broken = 0;
    for (const row of res.rows) {
        const rule: EventRule = {
            id: row.id, name: row.name, pattern: row.pattern,
            isRegex: row.is_regex,
            source: row.source as EventRule['source'],
            severity: row.severity as EventRule['severity'],
        };
        const c = compileRule(rule);
        // A broken rule must not break the others - and it cannot arrive by
        // the API, which compile-checks at create. This catches rows edited
        // by hand in SQL, and says so rather than silently thinning the set.
        if (!c.ok) { broken += 1; log(`event rule "${row.name}" refused: ${c.detail}`); continue; }
        // A rule disarmed for blowing the budget stays disarmed while its
        // pattern is unchanged. Editing it is the operator saying "I fixed
        // it", and is the only thing that rearms it short of a restart.
        const wasDisarmed = disarmedRuleIds.get(rule.id);
        if (wasDisarmed !== undefined) {
            if (wasDisarmed === rule.pattern) continue;
            disarmedRuleIds.delete(rule.id);
            log(`event rule "${row.name}" was edited and is rearmed`);
        }
        compiled.push(c.compiled);
    }
    eventRuleErrors = broken;
    eventRulesDisarmed = disarmedRuleIds.size;
    compiledEventRules = compiled;
    log(`event rules armed: ${compiled.length}${broken > 0 ? ` (${broken} refused)` : ''}`);
}

/** Drain this flush's accumulated matches: ONE statement per flush however
 *  many messages matched. On refusal the pending map is merged back rather
 *  than dropped - the next flush retries, and a flood that outlives a lane
 *  hiccup still folds to one row per key. */
async function flushEvents(): Promise<void> {
    if (pendingEvents.size === 0) return;
    const batch = pendingEvents;
    pendingEvents = new Map();
    const items = [...batch.values()];
    const res = await OPS.upsertEventAlerts(
        items.map((p) => p.alertKey),
        items.map((p) => p.severity),
        items.map((p) => p.host),
        items.map((p) => eventLabel(p)),
        items.map((p) => p.count),
        items.map((p) => p.lastTs),
        CONFIG.eventAlertHostsMax,
    );
    if (!res.ok) {
        for (const [k, p] of batch) {
            const cur = pendingEvents.get(k);
            if (cur === undefined) pendingEvents.set(k, p);
            else { cur.count += p.count; if (p.lastTs > cur.lastTs) cur.lastTs = p.lastTs; }
        }
        return;
    }
    eventUpserts += items.length;
}

// --- queue -------------------------------------------------------------------

function enqueue(row: MessageRow): void {
    if (queue.length >= QUEUE_MAX) {
        queue.splice(0, DROP_BATCH);
        shed += DROP_BATCH;
    }
    queue.push(row);
    received++;

    // Slice 10: the match hook. Every parsed message crosses here - syslog
    // and trap alike - so one hook covers both feeds. Shedding above does
    // not unmatch: a message the queue dropped still happened, and an alert
    // raised by a line the storage lost is the alert WORKING during a flood.
    if (compiledEventRules.length > 0) {
        eventMatches += matchMessage(compiledEventRules, pendingEvents, {
            msg: row.msg ?? '', host: row.host,
            // Both null only if a parse produced neither hostname nor source
            // address, which the socket paths cannot do - but the key must
            // never be 'event|N|null', so the last resort is named.
            sourceIp: row.sourceIp ?? 'unknown-source',
            proto: row.proto ?? 'syslog', app: row.app, ts: row.ts,
        }, disarmRule, PENDING_EVENTS_MAX);
    }

    if (queue.length >= FLUSH_ROWS) {
        flush().catch(onAsyncError);
    } else {
        flushGate.armIfIdle();
    }
}

/** copyMessages in the shape copyIsolating takes, counting NULs on success. */
async function copyForIsolation(part: MessageRow[]): Promise<{ ok: boolean; rowCount: number }> {
    const { outcome, nulsStripped: nuls } = await copyMessages(part);
    if (!outcome.ok) return { ok: false, rowCount: 0 };
    nulsStripped += nuls;
    return { ok: true, rowCount: outcome.rowCount };
}

async function flush(): Promise<void> {
    if (flushing) return;
    flushGate.disarm();
    if (queue.length === 0) return;
    // Backing off after a failure: the gate brings us back, the rows wait in
    // the queue, and an arriving datagram no longer means another attempt.
    if (Date.now() < backoffUntil) {
        flushGate.armIfIdle();
        return;
    }

    flushing = true;
    try {
        // Loop rather than recurse. Each await yields the event loop, so the
        // socket keeps draining while a chunk is in flight.
        while (queue.length > 0) {
            const batch = queue.splice(0, FLUSH_CHUNK);
            // Held where the catch can find it. Rows spliced out of the queue
            // exist ONLY here until the COPY commits, so a throw between these
            // two points is the one moment they can be lost.
            inFlightBatch = batch;
            const t0 = performance.now();
            let copied: Awaited<ReturnType<typeof copyMessages>>;
            try {
                copied = await copyMessages(batch);
            } catch (err) {
                if (!isDataError(err)) throw err;
                // ONE ROW'S DATA, NOT THE DATABASE (review F4): written in
                // halves until what cannot be stored is a single row, and only
                // that row is dropped. copyIsolating never throws.
                const iso = await copyIsolating(batch, copyForIsolation);
                inFlightBatch = null;
                written += iso.written;
                rowsRefused += iso.dropped.length;
                if (iso.dropped.length > 0) {
                    const first = iso.dropped[0] as MessageRow;
                    log(`ALARM the database refused ${iso.dropped.length} message row(s) on their content `
                        + `(${logSafe((err as Error).message).slice(0, 160)}); dropped them alone and wrote the other `
                        + `${iso.written}. First: from ${first.sourceIp ?? '?'}: ${logSafe(first.raw).slice(0, 160)}`);
                }
                if (iso.requeue.length > 0) {
                    queue.unshift(...iso.requeue);
                    flushFailed(`flush failed while isolating a refused row, ${iso.requeue.length} rows requeued`);
                    break;
                }
                flushes++;
                flushSucceeded();
                continue;
            }
            const { outcome, nulsStripped: nuls } = copied;
            nulsStripped += nuls;

            if (outcome.ok) {
                inFlightBatch = null;
                pushFlushMs(performance.now() - t0);
                written += outcome.rowCount;
                flushes++;
                flushSucceeded();
                continue;
            }
            inFlightBatch = null;

            // The ingest lane's policy is wait-and-alarm with a 10s ceiling.
            // Reaching either refusal means something is badly wrong upstream,
            // so it is loud, and the batch goes back to the FRONT of the queue
            // rather than being discarded: a database problem must not become
            // a dropped datagram.
            laneBusyEvents++;
            queue.unshift(...batch);
            flushFailed(`lane refused a flush (${outcome.reason}), ${batch.length} rows`);
            break;
        }
    } catch (err) {
        // REQUEUE, do not discard. This is the never-drop invariant on the
        // path that had been getting it wrong.
        //
        // A structured refusal six lines above requeues correctly; a THROWN
        // error is every other failure - Postgres restarting, a connection
        // reset, a missing partition, a full server disk - and it used to
        // count one flushFailure and let the batch go. The COPY had been
        // rolled back server side, so those rows existed nowhere but in that
        // local variable.
        //
        // The old comment cited "no defensive plumbing" as justification. That
        // rule is about not coding around UPSTREAM breakage; it does not
        // license dropping data the architecture promises to keep. What the
        // rule actually asks for is exactly this: fail loud, stay idempotent,
        // and let backpressure be honest. If the outage outlasts the 50,000
        // row queue, shedding applies backpressure and the counters say so.
        flushFailures++;
        if (inFlightBatch !== null) {
            queue.unshift(...inFlightBatch);
            inFlightBatch = null;
        }
        flushFailed(`flush threw (${(err as Error).message})`);
    } finally {
        flushing = false;
        // RE-ARM AFTER A REQUEUE. Filed as a minor latency note in the first
        // review - "if traffic stops entirely, requeued rows sit unwritten
        // until the next datagram or shutdown" - and it was minor while nothing
        // depended on the queue draining by itself.
        //
        // It is not minor now. `enqueue` is the ONLY other thing that schedules
        // a flush, so after a requeue the retry waits on an arriving datagram:
        // a burst that ends during a database outage leaves rows sitting until
        // traffic resumes, which on a quiet syslog source can be a long time.
        // The rows are not lost - the queue holds them and shutdown drains them
        // - but "written when someone else happens to send something" is not a
        // schedule.
        //
        // One line, and it also removes an entire hypothesis about the
        // intermittent sigterm failure rather than leaving it to be argued.
        if (queue.length > 0 && running) flushGate.armIfIdle();
    }
}

// --- partitions, which ingest owns rather than inherits -------------------------
//
// A COPY into a range-partitioned table fails outright if no partition covers
// the row's timestamp. Nothing created tomorrow's, so at the first midnight
// past the last pre-created partition every flush would have thrown - and
// before the requeue fix above, silently discarded its batch.
//
// So the writer guarantees its own precondition. It runs at startup and again
// every hour, always creating a few days AHEAD, so a missed run has days of
// slack rather than failing at the next midnight. Idempotent: the SQL function
// creates only what is absent.
//
// PARTITION_LOOKAHEAD_DAYS is deliberately larger than one. One day of runway
// means a single failed maintenance run is an outage at midnight; a week means
// it is a warning with time to act.
const PARTITION_LOOKAHEAD_DAYS = Number(process.env.PARTITION_LOOKAHEAD_DAYS ?? 7);
/** Below this many days of runway, the thread reports itself unhealthy. */
const PARTITION_RUNWAY_ALARM_DAYS = Number(process.env.PARTITION_RUNWAY_ALARM_DAYS ?? 3);

let partitionsEnsuredThrough: string | null = null;
let partitionFailures = 0;
let partitionConsecutiveFailures = 0;

function isoDay(offsetDays: number): string {
    const d = new Date(Date.now() + offsetDays * 86_400_000);
    return d.toISOString().slice(0, 10);
}

/**
 * Days of partition coverage remaining, or null if none has ever succeeded.
 *
 * THE POINT OF THIS NUMBER. Creating partitions seven days ahead does not give
 * seven days of safety - it gives seven days during which something must
 * shout. If the hourly tick only logs its failures, the margin is a FUSE: the
 * tick fails quietly, nobody reads the line, and seven days later every COPY
 * begins failing at midnight with the never-drop invariant already violated.
 *
 * So the runway is computed, reported in stats, and drives the thread's health
 * rather than a log line. Partition maintenance is the precondition for the
 * invariant, so its failure gets the same treatment as a lane refusal.
 */
function partitionRunwayDays(): number | null {
    if (partitionsEnsuredThrough === null) return null;
    const through = Date.parse(`${partitionsEnsuredThrough}T00:00:00Z`);
    return Math.floor((through - Date.now()) / 86_400_000);
}

async function ensurePartitions(): Promise<void> {
    const first = isoDay(0);
    const last = isoDay(PARTITION_LOOKAHEAD_DAYS);
    try {
        const res = await OPS.ensureDailyPartitions('messages', first, last);
        if (!res.ok) {
            partitionFailures++;
            partitionConsecutiveFailures++;
            log(`ALARM could not ensure partitions (${res.reason}) - attempt ${partitionConsecutiveFailures}, `
                + `runway ${partitionRunwayDays() ?? 'unknown'} days until every COPY fails`);
            return;
        }
        const made = res.rows[0]?.ensure_daily_partitions ?? 0;
        partitionsEnsuredThrough = last;
        partitionConsecutiveFailures = 0;
        if (made > 0) log(`created ${made} message partitions, covered through ${last}`);
    } catch (err) {
        partitionFailures++;
        partitionConsecutiveFailures++;
        // Loud, non-fatal, and COUNTED: the datagrams already queued are still
        // owed a write and the next attempt may succeed, but a silent retry
        // loop is how a seven-day margin gets spent without anyone noticing.
        log(`ALARM ensurePartitions threw (attempt ${partitionConsecutiveFailures}): ${(err as Error).message} - `
            + `runway ${partitionRunwayDays() ?? 'unknown'} days`);
    }
}

/**
 * Drain everything accepted, on shutdown.
 *
 * The stop handler used to call flush() directly, which was a no-op whenever a
 * flush was already in flight - and at any real load, one usually is. So the
 * handler drained nothing, posted its final stats, closed the pools and called
 * process.exit, while a concurrent flush loop was still holding rows. Its next
 * chunk then hit an ending pool, threw, and (before the fix above) was
 * discarded. A SIGTERM during a 5,000/s burst could destroy 40,000 accepted
 * datagrams during exactly the busy minute an investigation would later want.
 *
 * "Anything accepted is owed a write" is what the shutdown comment always
 * claimed. This is what honouring it costs: wait for the in-flight flush to
 * finish, keep flushing until the queue is empty, and bound the whole thing so
 * a wedged database cannot hold shutdown open forever.
 */
// PAIRED WITH CONFIG.shutdownWaitMarginMs, and main.ts derives its own wait
// from this value plus that margin. If you shorten this, main follows; if you
// ever hard-code a wait in main again, the two can invert and main will kill
// this worker mid-flush. See the ordering note in src/config.ts.
async function drain(deadlineMs = CONFIG.ingestDrainDeadlineMs): Promise<void> {
    // Named at the START, not only when it goes wrong.
    //
    // Operationally this is the line that says whether a deploy cost anything.
    // It also gives the chaos suite's sigterm scenario its FAULT-ARRIVED half:
    // that scenario asserted the process shut down cleanly without ever
    // checking there was anything to drain, so a regression that made drain()
    // return immediately would have passed it while losing the queue. An
    // assertion needs to know the fault was present, and this is where the
    // ingest worker knows it.
    const owed = queue.length + (inFlightBatch?.length ?? 0);
    const t0 = Date.now();
    log(`SHUTDOWN drain-enter owed=${owed} flushing=${flushing}`);

    const until = t0 + deadlineMs;
    while (Date.now() < until) {
        if (!flushing && queue.length === 0 && inFlightBatch === null) {
            // EXIT REASON, ALWAYS LOGGED, not only when it goes wrong.
            //
            // "No stopped line, no drain line, no final stats" is produced by
            // four different causes needing four different fixes - main died
            // before posting, the worker never received, drain hit its
            // deadline, or only the reporting path failed - and the suite could
            // not tell them apart. An intermittent failure that destroys its own
            // diagnosis is the expensive kind.
            //
            // Logged on the SUCCESS path too, deliberately: if it only appeared
            // on failure, a passing run would say nothing about which path it
            // took, and the evidence would exist only in the ~30% of runs that
            // fail - two of which have already been lost.
            log(`SHUTDOWN drain-exit reason=queue-empty ms=${Date.now() - t0} wrote=${owed}`);
            return;
        }
        // During a failure backoff flush() returns at once, so waiting here
        // is what stops this loop spinning; the deadline still bounds it.
        if (!flushing && Date.now() >= backoffUntil) {
            await flush();
            continue;
        }
        await new Promise((r) => setTimeout(r, 20));
    }
    log(`SHUTDOWN drain-exit reason=deadline ms=${Date.now() - t0} `
        + `stranded=${queue.length + (inFlightBatch?.length ?? 0)}`);
    // Say what is being abandoned rather than exiting quietly. Losing rows to a
    // deadline is a violated invariant; losing them silently is worse.
    const stranded = queue.length + (inFlightBatch?.length ?? 0);
    if (stranded > 0) {
        log(`ALARM shutdown deadline reached with ${stranded} rows still unwritten - these are lost`);
    }
}

// --- sockets -----------------------------------------------------------------

function bindSyslog(): dgram.Socket {
    // udp6 for an IPv6 BIND_ADDRESS: a udp4 socket cannot bind one (review F9).
    const socket = dgram.createSocket({ type: isIP(CONFIG.bindAddress) === 6 ? 'udp6' : 'udp4', recvBufferSize: CONFIG.rcvbufBytes });

    socket.on('error', (err: NodeJS.ErrnoException) => {
        log(`syslog socket error: ${err.message}`);
        // NAME THE FIX, not just the errno. The lab has always run on 5514,
        // so this path is first met on a real deployment pointing real
        // senders at the real port - and "bind EACCES" alone sends an
        // operator reading strace at 8am. Ports below 1024 need privilege
        // that a monitoring daemon should not be given wholesale.
        if (err.code === 'EACCES' && CONFIG.syslogPort < 1024) {
            log(`ALARM cannot bind udp/${CONFIG.syslogPort} - ports below 1024 need privilege. `
                + 'Either grant the capability once (sudo setcap '
                + "'cap_net_bind_service=+ep' \"$(command -v node)\"), or run on a high port "
                + '(SYSLOG_PORT=5514) and redirect with iptables. Do NOT run this as root.');
        }
        if (err.code === 'EACCES' || err.code === 'EADDRINUSE') process.exit(1);
    });

    socket.on('message', (buf, rinfo) => {
        try {
            let b = buf;
            if (b.length > CONFIG.maxDatagramBytes) {
                b = b.subarray(0, CONFIG.maxDatagramBytes);
                truncated++;
            }
            // Trim the trailing newline some senders append; keep inner ones.
            const line = b.toString('utf8').replace(/[\r\n]+$/, '');
            if (!line) return;
            const p = parse(line, rinfo.address, undefined, 'syslog');
            enqueue({
                ts: p.ts,
                msgTs: p.msgTs,
                sourceIp: p.sourceIp,
                facility: p.facility,
                severity: p.severity,
                // The line's own hostname, else the device at its address.
                host: hostForMessage(p.host, p.sourceIp, devicesByAddress),
                app: p.app,
                procid: p.procid,
                proto: p.proto,
                msg: p.msg,
                raw: p.raw,
            });
        } catch (err) {
            log('failed to handle datagram:', (err as Error).message);
        }
    });

    socket.bind(CONFIG.syslogPort, CONFIG.bindAddress, () => {
        const rcvbuf = describeRcvbuf(CONFIG.rcvbufBytes, socket.getRecvBufferSize());
        log(`syslog listening on udp/${CONFIG.syslogPort}`);
        // Requested and actual, separately and always. getsockopt returns
        // double what setsockopt was given; only `clamped` indicates a problem.
        log(`  SO_RCVBUF requested ${rcvbuf.requestedBytes} bytes, kernel reports ${rcvbuf.actualBytes}`
            + (rcvbuf.clamped
                ? '  CLAMPED - raise net.core.rmem_max'
                : '  (the kernel doubles it for bookkeeping; this is expected)'));
        if (!PROC_AVAILABLE) {
            log('  WARNING /proc/net/udp unavailable on this platform: kernel drop counts cannot be read,'
                + ' so "zero dropped" here would mean only "we shed nothing ourselves"');
        }
        const s = socketStats(CONFIG.syslogPort);
        baselineSyslogDrops = s?.drops ?? 0;
        const sys = systemStats();
        if (sys) baselineSystem = sys;
    });

    return socket;
}

// SNMP traps. The worker owns this socket too, because "the ingest worker owns
// the UDP syslog and trap sockets" is what makes the thread's isolation claim
// real: a second thread with a second socket would be a second thing to stall.
//
// Rendering follows syslogcanvas/server/traps.js - a readable one-line msg so
// plain-text filtering works, with the structured form kept in raw. Trap
// PARSING beyond that, and trap-to-alert, are slice 10.
type TrapReceiver = { close: () => void };

async function bindTraps(): Promise<TrapReceiver | null> {
    if (!CONFIG.trapsEnabled) {
        log('traps disabled (TRAPS_ENABLED=0)');
        return null;
    }
    let snmp: typeof import('net-snmp');
    try {
        snmp = await import('net-snmp');
    } catch (err) {
        log(`traps unavailable: ${(err as Error).message}`);
        return null;
    }

    // On BIND_ADDRESS like the syslog socket (review F9: it had no address,
    // so it listened everywhere whatever BIND_ADDRESS said).
    const receiver = snmp.createReceiver(
        {
            port: CONFIG.trapPort, address: CONFIG.bindAddress,
            transport: isIP(CONFIG.bindAddress) === 6 ? 'udp6' : 'udp4',
            disableAuthorization: true, includeAuthentication: true,
        },
        (error: Error | null, notification: unknown) => {
            if (error) {
                // Same first-deployment trap as syslog above, and traps are
                // WORSE to diagnose because this receiver does not exit -
                // the app runs happily while nothing arrives.
                if (/EACCES|permission denied/i.test(error.message) && CONFIG.trapPort < 1024) {
                    log('trap error:', error.message);
                    log(`ALARM cannot bind udp/${CONFIG.trapPort} for traps - ports below 1024 `
                        + 'need privilege. Grant the capability to node once, or set '
                        + 'TRAP_PORT to a high port and redirect. Traps are NOT being received.');
                    return;
                }
                // Per packet otherwise, so counted and rate-limited.
                trapProblem('error', error.message);
                return;
            }
            try {
                const n = notification as {
                    pdu?: {
                        varbinds?: Array<{ oid: string; value: unknown }>;
                        enterprise?: unknown; agentAddr?: unknown; generic?: unknown; specific?: unknown;
                    };
                    rinfo?: { address?: string };
                };
                const pdu = n.pdu ?? {};
                const varbinds = pdu.varbinds ?? [];
                const kept = keptVarbinds(varbinds);
                const sourceIp = n.rinfo?.address ?? null;
                const now = new Date();
                enqueue({
                    ts: now,
                    msgTs: null,
                    sourceIp,
                    // A trap has no syslog PRI. Recording 0 would claim
                    // "kernel/emergency", which is a lie a dashboard would act
                    // on; absent is the honest answer. An IPMI Platform Event
                    // Trap states its own severity, and that one is kept.
                    facility: null,
                    severity: petSyslogSeverity(decodePet(pdu, now.getTime())),
                    // The device at that address, so an event alert raised
                    // from this trap is that device's - its window, its mute,
                    // its policy (syslog/trap.ts says what went wrong before).
                    host: deviceForAddress(sourceIp, devicesByAddress),
                    app: 'snmp-trap',
                    procid: null,
                    proto: 'trap',
                    // Cut like a syslog datagram (review F15; trap.ts says why).
                    msg: clipText(renderTrap(pdu, now.getTime()), CONFIG.maxDatagramBytes),
                    raw: JSON.stringify({
                        source: sourceIp,
                        ...(typeof pdu.enterprise === 'string' ? {
                            enterprise: pdu.enterprise, generic: pdu.generic, specific: pdu.specific, agentAddr: pdu.agentAddr,
                        } : {}),
                        // renderValue, not String(): a binary varbind (a PET's
                        // 47 bytes) came out of String() as mangled UTF-8.
                        varbinds: kept.kept.map((v) => ({ oid: v.oid, value: renderValue(v.value) })),
                        ...(kept.more > 0 ? { moreVarbinds: kept.more } : {}),
                    }),
                });
            } catch (err) {
                log('failed to handle trap:', (err as Error).message);
            }
        },
    ) as unknown as TrapReceiver;

    // THE GUARD, BEFORE ANYTHING ELSE TOUCHES THE SOCKET (review F1 and F10;
    // syslog/trap-guard.ts). Without it one Inform datagram ends the process,
    // so a receiver that cannot be guarded is closed rather than run.
    const guarded = guardTrapReceiver(receiver, (why, detail, rinfo) => trapProblem(why, detail, rinfo?.address));
    if (guarded === 0) {
        receiver.close();
        log('ALARM traps are OFF: the trap receiver\'s socket could not be reached to guard it '
            + '(net-snmp internals moved?), and unguarded it can be stopped by one datagram');
        return null;
    }

    // SIZE THE TRAP SOCKET LIKE THE SYSLOG ONE (2026-09-24, the lab-5 ingest
    // test). net-snmp creates the receiver's socket itself with no buffer
    // option (index.js:3105, dgram.createSocket(transport) and bind), so the
    // trap socket ran on the kernel DEFAULT (rmem_default, 212,992 bytes on
    // Ubuntu) while syslog asked for RCVBUF_BYTES - the half of the ingest
    // worker's "the OS buffer absorbs ~300 ms of not-reading" promise that
    // nothing had ever set. Reached through the receiver's listener
    // (index.js:3441 this.listener, 3102 this.sockets), which the ambient
    // types deliberately leave undeclared; if a library upgrade moves it, the
    // log says so instead of the socket silently staying small.
    const sockets = Object.values(
        (receiver as unknown as { listener?: { sockets?: Record<string, dgram.Socket> } }).listener?.sockets ?? {});
    if (sockets.length === 0) {
        log('WARNING could not reach the trap receiver\'s socket to size SO_RCVBUF - '
            + 'traps run on the kernel default buffer (net-snmp internals moved?)');
    }
    for (const s of sockets) {
        // bind() is asynchronous and setRecvBufferSize needs a bound socket,
        // so this waits for 'listening'; attaching here, synchronously after
        // createReceiver returned, cannot miss the event.
        s.once('listening', () => {
            try {
                s.setRecvBufferSize(CONFIG.rcvbufBytes);
            } catch (err) {
                log(`WARNING could not set the trap socket's SO_RCVBUF: ${(err as Error).message}`);
            }
            const rb = describeRcvbuf(CONFIG.rcvbufBytes, s.getRecvBufferSize());
            log(`  traps SO_RCVBUF requested ${rb.requestedBytes} bytes, kernel reports ${rb.actualBytes}`
                + (rb.clamped ? '  CLAMPED - raise net.core.rmem_max' : ''));
        });
    }

    log(`traps listening on udp/${CONFIG.trapPort}`);
    const s = socketStats(CONFIG.trapPort);
    baselineTrapDrops = s?.drops ?? 0;
    return receiver;
}

// --- reporting ---------------------------------------------------------------

// Returns the SHARED type, so main cannot read a field this does not publish.
function snapshot(): IngestStats {
    const sorted = [...flushMs].sort((a, b) => a - b);
    const pick = (p: number): number => sorted.length === 0
        ? 0
        : Number((sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] as number).toFixed(1));

    const sysSock = socketStats(CONFIG.syslogPort);
    const trapSock = CONFIG.trapsEnabled ? socketStats(CONFIG.trapPort) : null;
    const sys = systemStats();

    if (sysSock && sysSock.rxQueueBytes > peakRxQueueBytes) peakRxQueueBytes = sysSock.rxQueueBytes;

    return {
        thread: 'ingest' as const,
        received,
        written,
        queued: queue.length,
        queueMax: QUEUE_MAX,
        flushes,
        flushFailures,
        writeFailingMs: failingSince === null ? 0 : Date.now() - failingSince,
        laneBusyEvents,
        truncated,
        nulsStripped,
        flushP50Ms: pick(0.5),
        flushP99Ms: pick(0.99),
        flushMaxMs: sorted.length ? Number((sorted.at(-1) as number).toFixed(1)) : 0,

        // Ours: what we threw away under backpressure.
        shedByUs: shed,
        rowsRefused,
        asyncErrors,
        eventRulesArmed: compiledEventRules.length,
        eventRuleErrors,
        eventRulesDisarmed,
        // The NAMES behind the count (easy-win E7): only the number crossed
        // the boundary, so the operator whose rule was disarmed for
        // stalling the ingest thread had a console.error nobody was reading
        // as their only notice. The ids let the Alerts page badge the
        // actual rule row.
        disarmedRuleIds: [...disarmedRuleIds.keys()],
        eventMatches,
        eventUpserts,
        trapsRefused: { ...trapsRefused },

        // The kernel's: what never reached us at all. This is the number the
        // done-when criterion is about, and it is null rather than 0 where it
        // cannot be read, because a confident zero from an unavailable source
        // is the failure mode this whole module exists to prevent.
        kernel: {
            available: PROC_AVAILABLE,
            syslogDrops: sysSock === null ? null : sysSock.drops - baselineSyslogDrops,
            trapDrops: trapSock === null ? null : trapSock.drops - baselineTrapDrops,
            rxQueueBytes: sysSock === null ? null : sysSock.rxQueueBytes,
            peakRxQueueBytes: PROC_AVAILABLE ? peakRxQueueBytes : null,
            systemRcvbufErrors: sys === null ? null : sys.rcvbufErrors - baselineSystem.rcvbufErrors,
            systemInErrors: sys === null ? null : sys.inErrors - baselineSystem.inErrors,
        },

        // TOP LEVEL, not nested under `kernel`.
        //
        // It was nested, which meant main.ts read `ingestStats.partitions` and
        // got undefined, so `healthy: false` was published every second and
        // silently ignored - the runway alarm existed, reported correctly, and
        // was wired to nothing. Caught by the chaos suite's partition scenario
        // on its first run, which is precisely the class of thing no load test
        // reaches: the value was right, the path to it was wrong.
        partitions: {
            ensuredThrough: partitionsEnsuredThrough,
            runwayDays: partitionRunwayDays(),
            failures: partitionFailures,
            consecutiveFailures: partitionConsecutiveFailures,
            // The precondition for never-drop. False here means every COPY
            // starts failing on a known date, so it degrades health rather
            // than only appearing in a log line nobody reads.
            healthy: partitionRunwayDays() !== null
                && (partitionRunwayDays() as number) >= PARTITION_RUNWAY_ALARM_DAYS,
            alarmBelowDays: PARTITION_RUNWAY_ALARM_DAYS,
        },

        heartbeat: hb.stats(),
    };
}

// --- lifecycle ---------------------------------------------------------------

await ensurePartitions();
setInterval(() => { ensurePartitions().catch(onAsyncError); }, 3600_000).unref();

// Slice 10: arm the rules now and re-arm on a short poll. A poll, not a push
// channel: a rules change taking up to 30s to arm is invisible to a human,
// and the signature check makes the idle poll a no-op string compare.
reloadEventRules().catch(onAsyncError);
setInterval(() => { reloadEventRules().catch(onAsyncError); }, 30_000).unref();
// The event drain rides its own second-cadence timer rather than living
// inside flush(): flush runs on rows-or-timeout for MESSAGES, and a quiet
// network would otherwise strand a matched alert in memory until the next
// unrelated datagram arrived.
setInterval(() => { flushEvents().catch(onAsyncError); }, 1000).unref();

const syslogSocket = bindSyslog();
const trapReceiver = await bindTraps();

// Sample the receive queue often enough to catch a peak between flushes. This
// is the early warning: a queue that is climbing says the edge is close, which
// a drop count of zero does not.
if (PROC_AVAILABLE) {
    const poll = setInterval(() => {
        const s = socketStats(CONFIG.syslogPort);
        if (s && s.rxQueueBytes > peakRxQueueBytes) peakRxQueueBytes = s.rxQueueBytes;
    }, 100);
    poll.unref();
}

parentPort?.on('message', async (msg: { type: string }) => {
    // Slice 43: RELOAD NOW, the same fix and the same reason as slice 42's
    // credential reload - and found the same way, by testing a claim rather
    // than asserting it.
    //
    // Measured 2026-08-29. Wrote an event rule for a Cisco config-change line,
    // sent a matching message eight seconds later, and got nothing. The
    // datagram was stored (id 13741881) so ingest was fine; the rule simply
    // was not loaded yet. Sent again after the 30s timer and it raised
    // immediately (alert 19353).
    //
    // WHY THIS MATTERS MORE THAN THE CREDENTIAL CASE. An operator writes an
    // event rule BECAUSE something is happening right now: "alert me when
    // that appears again". The 30 second window is therefore aimed squarely
    // at the messages the rule was written for, and it fails silently - no
    // error, no missed-match counter, just a rule that looks live and is not.
    if (msg.type === 'event-rules') {
        await reloadEventRules();
        return;
    }
    if (msg.type === 'stats') {
        parentPort?.postMessage({ type: 'stats', stats: snapshot() });
        return;
    }
    if (msg.type === 'stop') {
        // TIMESTAMP 2 OF 3. Main logs when it POSTS the stop; this is when the
        // worker RECEIVES it. A gap between them, or this line missing while
        // main's is present, says the worker was wedged rather than the
        // shutdown path being wrong - a different bug with a different fix.
        log('SHUTDOWN stop-received');
        running = false;
        syslogSocket.close();
        trapReceiver?.close();
        await drain();
        // Matched-but-not-yet-upserted event alerts get one last flush:
        // drain() covers MESSAGES only, and the pending map can hold up to a
        // second of ordinary accumulation - or, after an upsert refusal, an
        // arbitrarily old merged-back backlog from a database outage, which
        // is exactly the condition a SIGTERM tends to arrive during. A raise
        // the operator was owed must not vanish on the way down; if it still
        // cannot be written, name what is being abandoned rather than
        // dropping it silently (2026-09-01 review).
        await flushEvents();
        if (pendingEvents.size > 0) {
            log(`ALARM abandoning ${pendingEvents.size} pending event alert(s) at shutdown - `
                + 'the upsert was refused and the process is exiting');
        }
        parentPort?.postMessage({ type: 'final', stats: snapshot() });
        await closeAll();
        hb.stop();
        process.exit(0);
    }
});

parentPort?.postMessage({ type: 'ready', workerData });
log(`ready, running=${running}`);
