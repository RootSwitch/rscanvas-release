// The jobs worker. Rollup, retention, and trigram index maintenance.
//
// ARCHITECTURE.md gives these a dedicated worker holding the jobs lane: "long,
// rare, blocking, must not run twice, and must never queue the application
// behind itself (see rule 7)".
//
// SINGLE FLIGHT BY CONSTRUCTION, not by guard. Every job here runs through
// `runOnce`, which owns the only path to invocation - a scheduled tick cannot
// start a second copy of a job that is still running, because the tick does not
// call the job, it calls `runOnce`.
//
// That phrasing is deliberate. Finding 3 was a reentrancy guard used as a
// scheduler: `flush()` opened with `if (flushing) return`, so the SHUTDOWN path
// calling it silently did nothing whenever a flush was in flight. A guard that
// makes a function a no-op is indistinguishable, at the call site, from a
// function that ran. Here the state is held outside the jobs, so a skipped run
// is reported as a skipped run.
//
// The three jobs are deliberately independent. They run on their own schedules
// and none waits for another - which is only safe because the ordering
// constraint between them is enforced in the DATABASE (guard 5: retention
// refuses to drop raw samples the rollup has not consumed), not by hoping they
// are scheduled in the right order.

import { parentPort } from 'node:worker_threads';
import { CONFIG } from '../config.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { installSafetyNet } from '../safety.ts';
import { OPS, closeAll } from '../store/index.ts';
import { scanTick } from '../alerts/scan.ts';
import { dispatchEvent, retryPass } from '../alerts/notify.ts';
import type { FrontierState, JobsStats } from './protocol.ts';

const hb = startHeartbeat('jobs', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[jobs]', ...args);
}

let asyncErrors = 0;
function onAsyncError(err: unknown): void {
    asyncErrors++;
    log(`async error (${asyncErrors} total): ${(err as Error).message}`);
}
installSafetyNet({ thread: 'jobs', onRejection: () => { asyncErrors++; } });

let running = true;

// The shape is declared in protocol.ts and imported here rather than defined in
// both places, which is the entire point of that file: main and the worker
// agree by construction instead of by inspection.
type JobRecord = JobsStats['jobs'][number];

const jobs = new Map<string, JobRecord>();
const inFlight = new Set<string>();

function record(name: string): JobRecord {
    let r = jobs.get(name);
    if (!r) {
        r = {
            name, runs: 0, skippedInFlight: 0, failures: 0, consecutiveFailures: 0,
            lastRunAt: null, lastOkAt: null, lastMs: 0, lastDetail: '',
        };
        jobs.set(name, r);
    }
    return r;
}

/**
 * The only way a job is invoked.
 *
 * A run that outlasts its interval does not get a second copy started on top of
 * it - and the skip is COUNTED and named, rather than being a silent early
 * return. A job that is permanently skipping is a job that is wedged, and that
 * should be visible in the stats rather than inferred from an absence.
 */
/**
 * Jobs whose outcome is worth a row in job_state.
 *
 * NOT EVERY JOB, and the reason is the write-amplification lesson still warm
 * from this month: an UPSERT always dirties a tuple, so persisting the alert
 * scan - which fires every 5 seconds on the lab - would add about 17,000
 * transactions a day, each carrying an autovacuum bill, to record "scanned"
 * seventeen thousand times. That is the same shape as the three N+1 write
 * paths the A/B just removed, arrived at from the other direction.
 *
 * The threshold is a MINUTE of cadence, which keeps exactly the jobs whose
 * history an operator asks about the morning after a restart - retention
 * (hourly), the rollup (5 minutes), the trigram sync (6 hours) - and costs
 * under 350 writes a day in total. The fast jobs stay in the in-memory
 * record the health page already reads: their liveness is visible in their
 * own output, which is what history would have been used to check anyway.
 */
const PERSIST_CADENCE_MS = 60_000;

async function runOnce(
    name: string, fn: () => Promise<string>, persist = false,
): Promise<void> {
    const r = record(name);
    if (inFlight.has(name)) {
        r.skippedInFlight++;
        log(`${name}: still running from the last tick, skipping this one `
            + `(${r.skippedInFlight} skipped so far)`);
        return;
    }
    inFlight.add(name);
    r.runs++;
    r.lastRunAt = new Date().toISOString();
    const t0 = performance.now();
    try {
        r.lastDetail = await fn();
        r.lastOkAt = new Date().toISOString();
        // CONSECUTIVE, not cumulative. `failures` alone cannot tell "lost one
        // lock race in March" from "has thrown on every run since Tuesday", and
        // those need different responses - the first is the design working.
        r.consecutiveFailures = 0;
    } catch (err) {
        r.failures++;
        r.consecutiveFailures++;
        r.lastDetail = `failed: ${(err as Error).message}`;
        log(`${name}: ${r.lastDetail} (${r.consecutiveFailures} consecutive)`);
    } finally {
        r.lastMs = Number((performance.now() - t0).toFixed(1));
        inFlight.delete(name);
    }
    // After the finally, so a persistence failure cannot mask the job's own
    // outcome or leave `inFlight` stuck. Recording history is strictly less
    // important than the work, so it fails LOUDLY into the log and changes
    // nothing else - no defensive plumbing, no swallowed error, and a run
    // that happened is never reported as one that did not.
    if (persist) {
        const w = await OPS.recordJobRun(name, r.consecutiveFailures === 0, r.lastDetail ?? '');
        if (!w.ok) log(`${name}: ran, but its history row was refused (${w.reason})`);
    }
}

// --- rollup ---------------------------------------------------------------------
//
// Chunked, and driven by the persisted frontier rather than by the clock. The
// loop is what makes a long gap heal: each call advances the frontier by at
// most rollupChunkHours and commits, so a week-long gap becomes seven bounded
// steps rather than one unbounded transaction that times out and loses all of
// its work.
//
// Bounded per TICK as well as per chunk, so catching up cannot monopolise the
// jobs lane forever - it simply resumes on the next tick, from a frontier that
// has genuinely moved.
async function rollup(): Promise<string> {
    let chunks = 0;
    let hours = 0;
    let caughtUp = false;

    while (running && chunks < CONFIG.rollupChunksPerRun) {
        // WRITE-IN-LOOP-OK: one transaction PER CHUNK is the design - the lock
        // releases between chunks so two instances interleave at chunk
        // granularity. Bounded by ROLLUP_CHUNKS_PER_RUN, not by fleet size.
        const res = await OPS.rollUpChunk(CONFIG.rollupChunkHours, CONFIG.rollupSettleMinutes);
        if (!res.ok) throw new Error(`lane refused (${res.reason}) after ${chunks} chunks`);
        const row = res.rows[0];
        if (!row) throw new Error('roll_up_chunk returned no row');

        // Another instance holds the advisory lock. Not a failure - it is the
        // guard working - so it returns rather than throwing, because a throw
        // would count toward the three consecutive failures health alarms on
        // and a rolling deploy would trip that alarm every time.
        if (row.locked === true) return 'another instance holds the rollup lock, skipping';

        chunks++;
        hours += Number(row.hours_written ?? 0);
        if (row.caught_up) { caughtUp = true; break; }
    }

    return caughtUp
        ? `caught up: ${chunks} chunk(s), ${hours} hours written`
        : `${chunks} chunk(s), ${hours} hours written, MORE REMAINING - resumes next tick`;
}

// --- retention ------------------------------------------------------------------
//
// Every guard lives inside drop_partitions_guarded, including the lock_timeout.
// This caller passes configuration and reports what came back; it deliberately
// makes no decisions of its own, because the caller is exactly what was careful
// last time and still lost 158GB.
async function retention(table: 'samples' | 'messages', keepDays: number): Promise<string> {
    const res = await OPS.retentionRun(
        table, keepDays, CONFIG.retentionMinKeepDays, CONFIG.retentionMaxDropPerRun,
        CONFIG.retentionMinPartitions, CONFIG.retentionMaxSpanDays,
        CONFIG.retentionDryRun, CONFIG.retentionLockTimeout,
    );
    if (!res.ok) throw new Error(`lane refused (${res.reason})`);

    const by = new Map<string, string[]>();
    for (const row of res.rows) {
        const list = by.get(row.action) ?? [];
        list.push(row.partition_name);
        by.set(row.action, list);
    }
    if (by.size === 0) return 'nothing expired';

    // Every outcome is named, including the ones that did nothing. A deferral
    // that is never reported is a leak nobody notices.
    const parts: string[] = [];
    for (const [action, list] of by) parts.push(`${action}: ${list.join(', ')}`);
    const summary = parts.join(' | ');
    if (by.has('deferred-unrolled')) {
        log(`${table}: retention is WAITING for the rollup - ${by.get('deferred-unrolled')?.length} `
            + 'partition(s) hold raw samples the rollup has not consumed');
    }
    return summary;
}

// --- trigram index maintenance ---------------------------------------------------
//
// Two phases, and the split is what keeps a config change from becoming a
// never-drop violation.
//
// The function drops aged-out indexes under lock_timeout and creates indexes
// only where it is free - on a partition with no rows. Populated partitions
// come back as 'needs-index' and are built HERE, with CREATE INDEX
// CONCURRENTLY, because plpgsql cannot use CONCURRENTLY and a plain build takes
// SHARE against the writer's ROW EXCLUSIVE on today's partition.
//
// Raising TRGM_RECENT_DAYS is what makes this matter: it brings populated
// partitions into the window all at once, and before this split every one of
// them was a blocking GIN build against the live ingest path.
// DONE 2026-09-24 (was KNOWN, DECIDED, DEFERRED since 2026-07-28): this job
// used to build a DUPLICATE msg gin on every populated partition, because the
// parent's partitioned index (messages_msg_trgm_idx, from the spike schema)
// gave each partition an auto child and this sync checks for its OWN index
// name rather than a gin on the column. A partitioned index cannot be
// windowed, so TRGM_RECENT_DAYS never bounded msg storage, only host's. The
// window's founding commit (f7bcf90) says it exists for STORAGE, and the fix
// that kept faith with it was to drop the parent index and let this sync own
// msg exactly as it owns host. The lab-5 ingest run measured the duplicate at
// about a fifth of the ingest write ceiling and 108 bytes a message, and the
// operator approved the drop: bootstrap.sql no longer creates it and
// slice53-retention.sql removes it from existing databases. Admission reads
// coverage from pg_index by column, so it sees the windowed msg as a fact.
/**
 * Targets currently deferred, and since when.
 *
 * ONE DEFERRAL IS RULE 7 WORKING. The function takes a 2s lock_timeout and
 * turns `lock_not_available` into a `deferred-locked` row rather than blocking
 * ingest, which is the correct trade and is not in question.
 *
 * A deferral THAT NEVER CLEARS is a different thing wearing the same clothes,
 * and it reported as healthy: on minipc, 8 runs, 0 failures, a last_ok_ts, and
 * a job that had never once done what it exists to do. Rule 7's "willing to
 * lose, retry later" carries an unwritten precondition - that contention is
 * TRANSIENT - and a 2s timeout against a reader arriving every 6s and running
 * up to 30s does not lose a race repeatedly, it is structurally unable to win.
 *
 * So persistence is the signal, not the deferral. Tracked in memory rather
 * than in job_state because a restart resetting the clock is the honest
 * behaviour: after a restart the contention genuinely has not been observed
 * for long enough yet.
 */
const trgmDeferredSince = new Map<string, number>();
/** Three consecutive syncs at the default 6h interval. Long enough that a busy
 *  afternoon does not alarm, short enough that a starved window is named the
 *  same day it starts. */
const TRGM_DEFERRAL_ALARM_MS = 3 * 6 * 3600_000;

async function trgmSync(): Promise<string> {
    // A cancelled CONCURRENTLY build leaves an INVALID index behind that the
    // planner never uses and nothing ever repairs. Cleared first, so a
    // half-built index from a previous run does not make IF NOT EXISTS skip the
    // rebuild and report success over a search that has silently fallen back to
    // a LIKE scan.
    const cleaned = await OPS.dropInvalidTrgmIndexes();
    if (!cleaned.ok) throw new Error(`lane refused clearing invalid indexes (${cleaned.reason})`);

    const res = await OPS.syncTrgmIndexes(CONFIG.trgmRecentDays);
    if (!res.ok) throw new Error(`lane refused (${res.reason})`);

    const built: string[] = [];
    const dropped: string[] = [];
    const failed: string[] = [];
    const failedDrops: string[] = [];

    // DROPS FIRST, and deliberately: they free space and they are the half
    // that was starving, so a run cut short by shutdown does the scarce work
    // before the plentiful work.
    for (const r of res.rows) {
        if (r.action !== 'needs-drop') continue;
        if (!running) break;
        // WRITE-IN-LOOP-OK: DROP INDEX CONCURRENTLY cannot run inside a
        // transaction block either, so one statement per partition is mandatory
        // rather than chosen - the same reason the build loop below carries the
        // same marker. Bounded by how many partitions aged out of the window,
        // which is one per day in steady state.
        const d = await OPS.dropTrgmIndexConcurrently(r.partition_name);
        if (d.ok) dropped.push(r.partition_name);
        // NAMED, not swallowed - and the measurement this comment once
        // predicted came back with a different answer. It expected :msg to
        // refuse because the partitioned parent's child index cannot be
        // dropped individually; the refusal that actually arrived (lab,
        // 2026-08-22) was "must be owner of index" for BOTH columns, because
        // the sync had built them inline as its definer owner. The msg trgm
        // index is the sync's own standalone index, distinct from the
        // parent's child (messages_*_msg_idx), and it drops fine as the
        // owning role. Hence the maintenance lane; a refusal here now means
        // that lane's credential is missing or wrong (config.ts).
        else { failed.push(`${r.partition_name} drop (${d.reason})`); failedDrops.push(r.partition_name); }
    }

    for (const r of res.rows) {
        if (r.action !== 'needs-index') continue;
        if (!running) break;   // shutting down; the next run picks it up
        // WRITE-IN-LOOP-OK: CREATE INDEX CONCURRENTLY cannot run inside a
        // transaction block, so one statement per partition is mandatory rather
        // than chosen. Bounded by TRGM_RECENT_DAYS.
        const b = await OPS.createTrgmIndexConcurrently(r.partition_name);
        if (b.ok) built.push(r.partition_name);
        else failed.push(`${r.partition_name} (${b.reason})`);
    }

    const parts = res.rows
        .filter((r) => r.action !== 'needs-index' && r.action !== 'needs-drop')
        .map((r) => `${r.action} ${r.partition_name}`);
    if (dropped.length > 0) parts.push(`dropped concurrently: ${dropped.join(', ')}`);
    if (built.length > 0) parts.push(`built concurrently: ${built.join(', ')}`);
    if (failed.length > 0) parts.push(`FAILED: ${failed.join(', ')}`);

    // THE DEFERRAL CLOCK. Start one for anything newly deferred, stop it for
    // anything that is no longer, and raise once a target has been unable to
    // proceed for long enough that "retry later" has stopped being true.
    // The function reports and never drops (slice 19), so "deferred" is now
    // the worker's own drop failing on this run. Same alarm, same window:
    // a target that keeps failing for three syncs is named, whatever the
    // reason - and with ownership settled the remaining reasons are a
    // missing credential or a lock that never clears.
    const now = Date.now();
    const deferredNow = new Set(failedDrops);
    for (const t of deferredNow) if (!trgmDeferredSince.has(t)) trgmDeferredSince.set(t, now);
    for (const t of [...trgmDeferredSince.keys()]) if (!deferredNow.has(t)) trgmDeferredSince.delete(t);

    const stuck = [...trgmDeferredSince.entries()]
        .filter(([, since]) => now - since >= TRGM_DEFERRAL_ALARM_MS)
        .map(([t, since]) => `${t} (${Math.round((now - since) / 3600_000)}h)`);
    const detail = parts.length === 0 ? 'no change' : parts.join(', ');

    // THROWN, so it uses the failure counter this system already watches
    // rather than inventing a second channel for the same news. The detail
    // travels in the message because the throw replaces the return value.
    if (stuck.length > 0) {
        throw new Error(
            `trigram window NOT being maintained: ${stuck.join(', ')} have failed to drop `
            + `for over ${TRGM_DEFERRAL_ALARM_MS / 3600_000}h (last reasons: ${failed.join('; ') || 'none recorded'}). `
            + 'With ownership settled by the maintenance lane this is a missing credential or a lock that never clears, so the window '
            + 'is not shrinking and index storage grows without bound. Find the long-running '
            + `reader (pg_stat_activity, state='active' on messages) rather than raising the `
            + `timeout. Work done this run: ${detail}`);
    }
    return detail;
}

// --- the alert scan ----------------------------------------------------------------
//
// The vertical slice's heartbeat: last values -> rules -> the state machine.
// All the decisions live in src/alerts; what belongs to this worker is the
// scheduling (through runOnce like every job, so it can never overlap itself)
// and the summary line.
//
// Events are persisted as owed notifications (notified_* false) before this
// returns, so a crash between scan and dispatch loses nothing - the notify
// pass reads its queue from the database, not from this variable.
async function alertScan(): Promise<string> {
    const r = await scanTick();
    const parts = [
        `${r.devices} device(s), ${r.interfaces} interface(s), ${r.conditions} condition(s), ${r.open} open`,
    ];
    if (!r.collectorHealthy) parts.push('COLLECTOR STALE - aging suspended');
    if (r.events.length > 0) {
        parts.push(r.events.map((e) => `${e.type} ${e.key}`).join(', '));
        eventsToNotify.push(...r.events);
    }

    // THE SPLIT (2026-09-01 review). Dispatch is KICKED, never awaited:
    // scan.ts's header always claimed "a scan is never blocked by a slow
    // SMTP server", and at this altitude the claim was false for the whole
    // life of this job - dispatch and retryPass ran inside the scan's own
    // runOnce slot, so one dead relay's serial 15-45s timeouts made every
    // subsequent scanTick skip, stalling raises, clears, TTL clears and
    // last_seen_ts liveness exactly during an incident. The notify job has
    // its own slot and its own timer below; this kick only makes delivery
    // PROMPT when a scan produced something new.
    if (running) runOnce('alerts:notify', alertNotify).catch(onAsyncError);
    return parts.join('; ');
}

// Events flow scan -> notify through this queue rather than through call
// arguments, so a kick that lands while a pass is already mid-SMTP queues
// the events instead of dropping them. EVERY event type now has a database
// debt to fall back on - ruling 1 gave escalates escalated_ts and
// notified_escalate nineteen minutes after this queue was written with the
// opposite justification, and AUDIT-2026-09-01 finding 2 caught the stale
// claim standing - so what this queue buys is PROMPTNESS alone: a queued
// event dispatches on the next kick at its true type, where the owed
// queues would deliver it a tick later. Worth its twelve lines for that;
// no longer load-bearing for correctness. Bounded by open-alert
// transitions per scan, which is small; the pass drains it whole.
type ScanEvent = Awaited<ReturnType<typeof scanTick>>['events'][number];
const eventsToNotify: ScanEvent[] = [];

async function alertNotify(): Promise<string> {
    // Dispatch queued events at their true type (an escalate arrives as an
    // escalate), then drain the owed queues - which retries anything that
    // just failed AND delivers debts left by earlier crashes or scans that
    // ran before a channel was configured. Delivery failures never fail the
    // pass: the debt stays on the row and the next tick retries under
    // backoff.
    const events = eventsToNotify.splice(0);
    let sent = 0;
    // WRITE-IN-LOOP-OK: a READ, and the loop is bounded by the notify
    // batch rather than by fleet size - it cannot scale with entities.
    for (const ev of events) {
        // WRITE-IN-LOOP-OK: a READ, and bounded by the notify batch rather than
        // by fleet size.
        const rec = await OPS.getAlert(ev.alertId);
        if (!rec.ok || rec.rows[0] === undefined) continue;   // cleared+pruned mid-tick
        // THE SECOND HALF OF THE MAINTENANCE GATE (slice 22), and the drill
        // that shipped the first half could not see this one: it inserted
        // alerts by SQL, so every delivery went through the owed queues,
        // which are gated in ops.ts. A LIVE raise arrives here first -
        // dispatched immediately at its true type, before retryPass runs -
        // and without this check a window suppressed the queue while the
        // scan's own event stream paged anyway. Skipping leaves every debt
        // unsettled, and since ruling 1 that sentence covers ESCALATES too:
        // escalated_ts and notified_escalate open a debt the moment the
        // scan's batch write records the transition, and
        // alertsOwingEscalate delivers it when the window closes. SO DO NOT
        // "FIX" THIS SKIP - dispatching an escalate inside the window is
        // the one edit that would defeat the gate for exactly the event
        // type ruling 1 made safe to skip. (Two earlier versions of this
        // comment were each wrong in turn: the first claimed the scan
        // re-emits escalates - it never did - and the second claimed a
        // skipped escalate is lost forever, which ruling 1 had already
        // fixed by the time the comment landed; AUDIT-2026-09-01 finding 2
        // called the second "a comment describing a hazard the code no
        // longer has ... worse than a stale comment, because it argues for
        // reintroducing it". Renotify has its generator now too, opt-in
        // via ALERT_RENOTIFY_H.)
        // under_policy rides the same gate for the same reason (slice 25):
        // the live-raise path must consult every filter the owed queues
        // apply, or a policy quiets the queue while the scan's own event
        // stream pages anyway.
        if (rec.rows[0].in_maintenance || rec.rows[0].under_policy) continue;
        if (await dispatchEvent(ev.type, rec.rows[0])) sent++;
    }
    const r = await retryPass();
    sent += r.sent;
    // Channel health, refreshed once a minute off the pass that owns the
    // channels (easy-win E6): the trailing-failure streaks ride JobsStats so
    // the health page can say "email has failed 96 times since Tuesday"
    // instead of the notifications table silently growing.
    if (Date.now() - lastChannelHealthMs >= 60_000) {
        lastChannelHealthMs = Date.now();
        const ch = await OPS.notifyChannelHealth();
        if (ch.ok) {
            notifyChannels = ch.rows.map((c) => ({
                channel: c.channel,
                trailingFailures: c.trailing_failures,
                lastDeliveredTs: c.last_delivered_ts === null ? null : c.last_delivered_ts.toISOString(),
                lastAttemptTs: c.last_attempt_ts.toISOString(),
            }));
        }
    }
    // The owed depths and the oldest untold incident are the line's
    // load-bearing half: a wedged channel shows here before someone misses
    // a page, which is the whole reason the pass reports at all.
    const owedTotal = r.owed.raise + r.owed.escalate + r.owed.clear + r.owed.renotify;
    const owedNote = owedTotal === 0 ? '' : `; owed ${r.owed.raise}r/${r.owed.escalate}e/`
        + `${r.owed.clear}c/${r.owed.renotify}n`
        + (r.oldestOwedTs === null ? ''
            : `, oldest untold ${Math.round((Date.now() - r.oldestOwedTs.getTime()) / 60_000)}m`);
    return `${events.length} event(s), notified ${sent}${owedNote}`;
}

let lastChannelHealthMs = 0;
let notifyChannels: Array<{
    channel: string; trailingFailures: number;
    lastDeliveredTs: string | null; lastAttemptTs: string;
}> = [];

// --- schedule ---------------------------------------------------------------------
//
// Independent timers. Nothing here sequences the jobs relative to each other,
// because the one ordering constraint that matters - retention must not outrun
// the rollup - is enforced by guard 5 in the database. A scheduler that
// enforced it by ordering would be correct only while it kept running.

function every(ms: number, name: string, fn: () => Promise<string>): void {
    // ANY job on an interval longer than an hour ALSO runs once shortly after
    // boot. setInterval's first firing is one full interval out, and for a
    // long-interval job that gap is a live defect window, not a scheduling
    // detail - measured 2026-07-28, when the trgm sync's six-hour interval
    // meant a fresh deployment served free text for six hours against a
    // partition whose host trigram index did not exist yet (search duration
    // ramped 1.1s -> 2.3s, a 25-point CPU ramp on the host graph, gone within
    // seconds of the first sync finishing). A RULE rather than a property of
    // trgm, so the next long-interval job gets it without anyone remembering.
    //
    // The threshold is INCLUSIVE of exactly-hourly jobs, and the boundary was
    // learned the hard way: `partitions:monthly` runs at exactly one hour, a
    // strict `>` excluded it, and on a database born from sql/ alone
    // samples_hourly has NO partitions - so the 5-minute rollup threw "no
    // partition found" from the first complete hour until this job's first
    // firing, tripping the three-consecutive-failures health alarm on every
    // fresh install (2026-09-01 review). The sweep that justified the strict
    // form also mis-credited ensurePartitions() at collector startup, which
    // ensures the DAILY partitions for samples and messages, not the rollup's
    // monthly ones - only this job creates those.
    //
    // The sub-hour jobs were swept and are fine without it: rollup fires at
    // 5 minutes, the alert scan in seconds. The hourly retention jobs did not
    // need the kick (a fresh deploy has nothing to drop for days) but take it
    // harmlessly: retention is advisory-locked, willing to lose, and a no-op
    // when nothing is eligible.
    // Cadence decides whether this job's outcome is durable - see
    // PERSIST_CADENCE_MS. Derived from the interval rather than listed by
    // name, so retuning a job's schedule moves it across the threshold
    // automatically instead of leaving a hand-maintained list to rot.
    const persist = ms >= PERSIST_CADENCE_MS;
    if (ms >= 3600_000) {
        setTimeout(() => {
            if (running) runOnce(name, fn, persist).catch(onAsyncError);
        }, 15_000).unref();
    }
    const t = setInterval(() => {
        if (running) runOnce(name, fn, persist).catch(onAsyncError);
    }, ms);
    t.unref();
}

every(CONFIG.rollupIntervalMs, 'rollup', rollup);
every(CONFIG.retentionIntervalMs, 'retention:samples',
    () => retention('samples', CONFIG.rawRetentionDays));
every(CONFIG.retentionIntervalMs, 'retention:messages',
    () => retention('messages', CONFIG.messageRetentionDays));
every(CONFIG.trgmSyncIntervalMs, 'trgm', trgmSync);
every(CONFIG.alertScanIntervalMs, 'alerts:scan', alertScan);
// The notify pass has its OWN timer as well as the scan's kick, so delivery
// keeps draining debts even while the scan itself is failing - the two were
// coupled before the split, and a scan refused by its lane also silently
// stopped all delivery for that tick. runOnce dedupes the timer against the
// kicks, so at most one pass runs at a time either way.
every(CONFIG.alertScanIntervalMs, 'alerts:notify', alertNotify);
every(CONFIG.retentionIntervalMs, 'retention:alerts', async () => {
    const r = await OPS.pruneClearedAlerts(CONFIG.alertRetentionDays);
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    // By age as well as by cascade: a broken channel's failure log against
    // never-clearing alerts is what the cascade cannot reach.
    const n = await OPS.pruneNotifications(CONFIG.alertRetentionDays);
    if (!n.ok) throw new Error(`lane refused (${n.reason})`);
    // Expired maintenance windows ride along: the settle lookback needs one
    // day of history, alert retention keeps far more, and a table of dead
    // windows is not a record - the audit rows are.
    const w = await OPS.pruneMaintenanceWindows(CONFIG.alertRetentionDays);
    if (!w.ok) throw new Error(`lane refused (${w.reason})`);
    // Slice 36: ping history has its OWN horizon, longer than raw samples
    // (the rows are three columns) and shorter than nothing - a year of
    // internet latency nobody asked for is still a table that grows.
    const p = await OPS.prunePingSamples(CONFIG.pingHistoryDays);
    if (!p.ok) throw new Error(`lane refused (${p.reason})`);
    return `pruned ${r.rows[0]?.n ?? '0'} cleared alert(s), `
        + `${n.rows[0]?.n ?? '0'} aged notification row(s), `
        + `${w.rows[0]?.n ?? '0'} expired window(s) past ${CONFIG.alertRetentionDays}d, `
        + `${p.rows[0]?.n ?? '0'} ping sample(s) past ${CONFIG.pingHistoryDays}d`;
});
// Generation corpses (INVESTIGATION-DUP-INTERFACES remedy 6): untracked,
// week-stale, superseded interface rows from ifIndex re-deals. Its own job
// name rather than a rider on retention:alerts, because "how many corpses
// went" is the number an operator watches while the agent fleet upgrades -
// steady zero afterwards is the proof the churn stopped.
every(CONFIG.retentionIntervalMs, 'retention:corpses', async () => {
    const c = await OPS.pruneCorpseInterfaces(CONFIG.corpseRetentionDays);
    if (!c.ok) throw new Error(`lane refused (${c.reason})`);
    return `removed ${c.rows[0]?.n ?? '0'} superseded interface generation(s) `
        + `untracked and stale past ${CONFIG.corpseRetentionDays}d`;
});

// Deliberately NOT through `every`/`runOnce`. This is a single-row read, not a
// job: it takes no lock, cannot overlap meaningfully, and must keep reporting
// while every actual job is failing - which is the state it exists to make
// visible. Putting it in the job list would also mean a wedged rollup showed up
// as two red entries instead of one true one.
//
// Run once immediately so the first /api/health after startup has a real answer
// rather than the fail-closed "never read" placeholder.
setInterval(() => { if (running) void refreshFrontier().catch(onAsyncError); }, 60_000).unref();
void refreshFrontier().catch(onAsyncError);

// Partition creation ahead of need, on the jobs lane for the ROLLUP's monthly
// partitions. The daily partitions for messages and samples are owned by their
// writers, because a missing one there is an ingest outage rather than
// housekeeping.
every(3600_000, 'partitions:monthly', async () => {
    const now = new Date();
    const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 3, 1));
    const res = await OPS.ensureMonthlyPartitions(
        'samples_hourly', first.toISOString().slice(0, 10), last.toISOString().slice(0, 10),
    );
    if (!res.ok) throw new Error(`lane refused (${res.reason})`);
    return `${res.rows[0]?.ensure_monthly_partitions ?? 0} created`;
});

// --- the frontier, published rather than left in the database -------------------
//
// The health endpoint has to be able to say "the rollup has stalled", and it
// must not issue its own query to find out: reading job_state from the request
// path would put a database round trip inside a liveness check.
//
// Read on its own timer rather than piggybacked on the rollup, because the case
// that matters is the rollup NOT RUNNING. A frontier refreshed only by a
// successful rollup would freeze at its last good value exactly when it stopped
// being true, and would report health right through the failure it exists to
// catch.
let frontier: FrontierState | null = null;

async function refreshFrontier(): Promise<void> {
    const res = await OPS.jobState();
    // Leave the whole object where it was, INCLUDING readAt, so its age is what
    // reports the failure. isFrontierHealthy consumes that age - which it did
    // not when this line was first written, so a frozen lag figure read as a
    // current one and health stayed green through a jobs worker that could not
    // see the database at all.
    if (!res.ok) return;

    const row = res.rows.find((r) => r.job === 'rollup');
    const throughTs = row?.through_ts ?? null;
    const lagHours = throughTs === null
        ? null : (Date.now() - new Date(throughTs).getTime()) / 3_600_000;

    // The young-database signal; a failed read leaves it out, which means no
    // grace rather than a guess.
    const age = await OPS.deviceAge();
    const ageRow = age.ok ? age.rows[0] : undefined;

    frontier = {
        throughTs: throughTs === null ? null : new Date(throughTs).toISOString(),
        lagHours: lagHours === null ? null : Number(lagHours.toFixed(2)),
        readAt: new Date().toISOString(),
        alarmAboveHours: CONFIG.rollupLagAlarmHours,
        ...(ageRow !== undefined ? {
            devices: ageRow.n,
            firstDeviceAt: ageRow.first === null ? null : new Date(ageRow.first).toISOString(),
        } : {}),
        // THERE IS NO `healthy` FLAG HERE, and removing it was a finding.
        //
        // The worker computed one, with a comment claiming it was "repeated in
        // isFrontierHealthy because main must not trust a flag it cannot
        // check". Main does not trust it - it derives the verdict from lagHours
        // against alarmAboveHours, both of which it can check. So the flag was
        // consumed by nothing at all: a second source of truth for a question
        // already answered, free to DISAGREE with the real verdict and be read
        // by an operator looking at the payload.
        //
        // PartitionState keeps its flag for the opposite reason: main cannot
        // independently derive a runway from a date only the worker knows it
        // ensured, so there the flag IS the verdict and is consumed.
    };
}

function snapshot(): JobsStats {
    return {
        thread: 'jobs',
        asyncErrors,
        jobs: [...jobs.values()],
        inFlight: [...inFlight],
        frontier,
        notifyChannels,
        heartbeat: hb.stats(),
    };
}

parentPort?.on('message', (msg: { type: string; job?: string }) => {
    if (msg.type === 'stats') {
        parentPort?.postMessage({ type: 'stats', stats: snapshot() });
        return;
    }
    // An explicit kick, for tests and for an operator who does not want to wait
    // for the next tick. Goes through runOnce like everything else, so it
    // cannot start a second copy either.
    if (msg.type === 'run' && msg.job) {
        const fn = msg.job === 'rollup' ? rollup
            : msg.job === 'trgm' ? trgmSync
            : msg.job === 'retention:samples' ? () => retention('samples', CONFIG.rawRetentionDays)
            : msg.job === 'retention:messages' ? () => retention('messages', CONFIG.messageRetentionDays)
            : null;
        if (fn) {
            runOnce(msg.job, fn)
                .then(() => parentPort?.postMessage({ type: 'ran', job: msg.job, stats: snapshot() }))
                .catch(onAsyncError);
        }
        return;
    }
    if (msg.type === 'stop') {
        log('SHUTDOWN stop-received');
        running = false;
        // Let an in-flight job finish rather than killing it mid-transaction.
        // Bounded, because a wedged job must not hold shutdown open forever.
        // The deadline lives in CONFIG because main derives its own wait from
        // it plus the margin - a literal here and a literal there is the
        // two-numbers race the ingest pairing note in config.ts records.
        const deadline = Date.now() + CONFIG.jobsStopDeadlineMs;
        const wait = (): void => {
            if (inFlight.size === 0 || Date.now() > deadline) {
                if (inFlight.size > 0) log(`ALARM stopping with ${[...inFlight].join(', ')} still in flight`);
                parentPort?.postMessage({ type: 'final', stats: snapshot() });
                closeAll().then(() => { hb.stop(); process.exit(0); }).catch(() => process.exit(1));
                return;
            }
            setTimeout(wait, 200);
        };
        wait();
    }
});

parentPort?.postMessage({ type: 'ready' });
if (CONFIG.adminDbPassword === '') {
    log('maintenance lane: RSCANVAS_ADMIN_DB_PASSWORD not set - index DDL runs as the app role, '
        + 'which works only on a database that was never hardened; on a hardened one every trgm drop '
        + 'fails with "must be owner" (INSTALL.md: the maintenance credential)');
}
log(`ready - rollup every ${CONFIG.rollupIntervalMs / 1000}s (${CONFIG.rollupChunkHours}h chunks, `
    + `max ${CONFIG.rollupChunksPerRun}/run, ${CONFIG.rollupSettleMinutes}min settle), `
    + `retention every ${CONFIG.retentionIntervalMs / 1000}s `
    + `(dryRun=${CONFIG.retentionDryRun}), trgm every ${CONFIG.trgmSyncIntervalMs / 1000}s`);
