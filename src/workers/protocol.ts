// The worker/main message contract, declared ONCE and imported by both sides.
//
// WHY THIS EXISTS. Worker payloads cross an untyped boundary: `postMessage`
// takes anything, `on('message')` yields anything, and each side then asserts a
// shape by hand. `tsc` cannot see structural drift between what a worker
// publishes and what main reads, so the two can disagree silently and forever.
//
// That is not hypothetical. The ingest worker published its partition runway
// nested inside `kernel`, main read `ingestStats.partitions`, and the result
// was `undefined` - so a correctly computed alarm was published every second
// and wired to nothing. It typechecked. It ran. The chaos suite found it.
//
// A single shared type removes the class: the worker builds a value OF this
// type and main consumes a value OF this type, so a field that moves breaks
// the build on both sides at once instead of going quiet on one.

import type { HeartbeatStats } from '../heartbeat.ts';

// --- EVERY FIELD IS CLASSIFIED, AND THE CLASSIFICATION IS THE POINT -----------
//
// A shared type proves SHAPE. It does not prove CONSUMPTION, and all three
// wiring bugs in this project's history lived in that gap:
//
//   1. `partitions` published nested inside `kernel` - main read
//      `ingestStats.partitions` and got undefined.
//   2. The jobs worker absent from health entirely - typed, published, never
//      evaluated.
//   3. `readAt` published as the staleness signal and never aged - a frozen lag
//      figure read as a current one.
//
// Every one of them typechecked. In every one the producer and the consumer
// agreed perfectly about the field's TYPE. What was missing each time was any
// proof that the consumer used the field for the thing it was published to
// express.
//
// So each field below carries one of two markers, and adding a field means
// choosing one:
//
//   VERDICT  Something in health() reads this and it can change ok/not-ok.
//            Every VERDICT field owes a CONTROL in tools/test-health-predicates.ts:
//            assert healthy, corrupt THIS field alone, assert unhealthy, and
//            assert the problem names it. Three corruptions, because a field can
//            be guarded against one and open to the others - ABSENT (missing or
//            undefined), STALE (present, correctly typed, describing a moment
//            that has passed) and WRONG (present, current, and false).
//
//   DISPLAY  Published for an operator or an investigation. Nothing branches on
//            it. Free to be missing without health noticing, and that is the
//            deliberate choice rather than an oversight.
//
// A DISPLAY field that SHOULD drive a verdict is a defect, not a classification.
// The ones found by this sweep are listed at the bottom of the file.
//
// --- AND ONE RULE ABOUT CUMULATIVE FIELDS, WHICH COST THREE INSTANCES ------
//
//   CUMULATIVE COUNTERS ARE SAFE TO PUBLISH AND NEVER SAFE TO THRESHOLD.
//
// A counter that only rises describes HISTORY. A verdict is about NOW. Read
// one directly and the verdict becomes true forever on the first occurrence -
// it can only degrade, never recover, and on a process designed to run for
// weeks that is indistinguishable from a permanent fault.
//
// The discipline already existed here, in exactly one place: `syslogDrops` is
// BASELINED at bind time so the consumer sees drops since the worker started
// rather than since boot. Correct, deliberate, and not applied to its
// neighbours - so the same bug arrived twice more:
//
//   overThresholdCount  read as "any tick ever exceeded". Health went 503 on
//                       the first transient and could never return. Fixed by
//                       a RATE (over/ticks) plus an acute bound.
//   worstGapMs          read as an absolute threshold in the soak. Reported
//                       17, 47, 124 ... 561, 561 - one stall, nine breaches.
//                       Fixed by checking MOVEMENT rather than value.
//
// So a consumer of a cumulative field must do ONE of three things, and the
// audit below says which applies to each:
//
//   BASELINE   subtract a starting value, as the ingest worker does.
//   RATE       divide by ticks or elapsed, as isHeartbeatHealthy now does.
//   MOVEMENT   compare against the previous reading, as the soak now does for
//              worstGapMs and the rollup frontier.
//
// THE AUDIT, every cumulative field on these structures:
//
//   syslogDrops, trapDrops    VERDICT, and BASELINED at bind. Correct, and the
//                             origin of the rule.
//   worstGapMs                VERDICT via the acute bound in isHeartbeatHealthy
//                             - which is safe BECAUSE it is a maximum: "worst
//                             ever exceeded 500ms" is a true statement about a
//                             real stall, and it is deliberately paired with
//                             the rate so recovery is possible on the rate
//                             half. The SOAK consumes it by MOVEMENT.
//   overThresholdCount        VERDICT via RATE. Fixed 2026-07-28.
//   ticks                     DISPLAY, and the denominator of that rate.
//   received/written/queued   DISPLAY. Never thresholded; the conservation law
//   flushes/flushFailures     is asserted by chaos.sh against FINAL stats on
//   truncated/nulsStripped    shutdown, which is a delta by construction.
//   shedByUs, laneBusyEvents  DISPLAY.
//   polls/failures/discovered DISPLAY.
//   samplesWritten            DISPLAY.
//   writeFailures             DISPLAY - and flagged in the sweep findings as a
//                             field that SHOULD drive a verdict. If it ever
//                             does, it needs a rate or a delta, not a bound.
//   asyncErrors               DISPLAY on every thread.
//   runs, skippedInFlight     DISPLAY, both cumulative.
//   failures (per job)        DISPLAY, and this is why consecutiveFailures
//                             exists beside it.
//   consecutiveFailures       VERDICT, and NOT cumulative - it resets on
//                             success, which is what makes it thresholdable.
//                             The model for every counter that must be judged.
//   notify_attempts (alerts)  VERDICT-adjacent, in a COLUMN, and zeroed on
//                             delivery. Same shape as consecutiveFailures.
//
// Nothing else on these structures is both cumulative and read as a verdict.

/**
 * Partition maintenance state.
 *
 * Cannot go stale independently of its worker: every field is recomputed at
 * snapshot time from the clock, so a frozen partition block is impossible while
 * the worker is publishing - and a worker that has STOPPED publishing is caught
 * by `isFresh` on its report age. That is why this structure needs no `readAt`
 * of its own and `FrontierState` does.
 */
export interface PartitionState {
    /** DISPLAY. The date the worker last covered through. Evidence, not a verdict. */
    ensuredThrough: string | null;
    /** DISPLAY, but QUOTED in the verdict's problem string, so a control asserts it appears. */
    runwayDays: number | null;
    /** DISPLAY. Cumulative, for an investigation. */
    failures: number;
    /** DISPLAY, quoted in the problem string. */
    consecutiveFailures: number;
    /**
     * VERDICT. The only field in this structure health branches on.
     *
     * Computed by the worker because the worker owns the threshold. Main trusts
     * it here and deliberately does NOT trust the equivalent flag on
     * FrontierState - the difference is that main can independently check a lag
     * against a published threshold and cannot independently check a runway
     * against a date the worker alone knows it ensured.
     */
    healthy: boolean;
    /**
     * DISPLAY. The threshold the worker applied, published so an operator can
     * see WHY `healthy` is what it is. Main does not re-derive from it.
     */
    alarmBelowDays: number;
}

/**
 * Kernel-side UDP counters.
 *
 * THE DROP COUNTERS ARE VERDICT, and classifying them DISPLAY was the sweep's
 * own mistake, corrected the same day. The reasoning that produced it was that
 * a threshold would have to be invented - true of `shedByUs` and
 * `writeFailures`, and false here. A kernel drop is not a symptom of a
 * never-drop violation; it IS the violation, and the invariant already fixes
 * the threshold at zero.
 *
 * Both counters are BASELINED at bind time by the ingest worker, so they mean
 * "since this worker started" rather than since boot - the delta is already
 * taken, and it is monotonic, so a violation stays visible instead of scrolling
 * past between two health polls.
 */
export interface KernelUdpState {
    /**
     * VERDICT. False means /proc could not be read, so the invariant is
     * UNMONITORED rather than satisfied - the case that matters most, because a
     * deployment on such a platform reported perfect health on the one metric
     * it cannot read.
     */
    available: boolean;
    /** VERDICT. Datagrams the KERNEL dropped since this worker started. Zero, or it is a violation. */
    syslogDrops: number | null;
    /** VERDICT. Same, for the trap socket. */
    trapDrops: number | null;
    /** DISPLAY. Current socket queue depth. */
    rxQueueBytes: number | null;
    /** DISPLAY. High-water mark, for sizing rcvbuf. */
    peakRxQueueBytes: number | null;
    /** DISPLAY. System-wide, so not attributable to this process. */
    systemRcvbufErrors: number | null;
    /** DISPLAY. System-wide. */
    systemInErrors: number | null;
}

export interface IngestStats {
    /** DISPLAY. Discriminant. */
    thread: 'ingest';
    // DISPLAY, all of them. The conservation law `received == written +
    // shedByUs` is asserted by tools/chaos.sh against the FINAL stats on
    // shutdown, not by health - a running system's counters are always
    // momentarily unequal because rows are in flight.
    received: number;
    written: number;
    queued: number;
    flushes: number;
    flushFailures: number;
    /** VERDICT, via databaseVerdict in health/work.ts: how long writes have
     *  been failing, 0 once one succeeds. Optional for fixture compatibility. */
    writeFailingMs?: number;
    laneBusyEvents: number;
    truncated: number;
    nulsStripped: number;
    flushP50Ms: number;
    flushP99Ms: number;
    flushMaxMs: number;
    /** DISPLAY - see the sweep findings. Deliberate loss, and health does not say so. */
    shedByUs: number;
    asyncErrors: number;
    // DISPLAY, event alerting (slice 10). Rules armed is the compiled count;
    // ruleErrors is rows that refused to compile (hand-edited SQL - the API
    // compile-checks at create); matches counts every rule hit, upserts the
    // per-flush folded rows that reached the database. matches >> upserts is
    // the rate limiter WORKING, not a discrepancy.
    eventRulesArmed: number;
    eventRuleErrors: number;
    /** Rules pulled from the armed set at RUNTIME for exceeding the
     *  per-message budget - they compiled fine and then stalled the latency
     *  thread. Non-zero means an operator's rule is not running and they have
     *  not been told by anything except a log line. */
    eventRulesDisarmed: number;
    /** The ids behind that count (easy-win E7), so the Alerts page can
     *  badge the disarmed rule rather than leaving the operator a number
     *  and a log line. Optional for fixture compatibility. */
    disarmedRuleIds?: string[];
    eventMatches: number;
    eventUpserts: number;
    /** VERDICT. isKernelDropFree - the never-drop invariant itself. */
    kernel: KernelUdpState;
    /** VERDICT. isPartitionHealthy(_, 'ingest'). */
    partitions: PartitionState;
    /** VERDICT. isReporting (presence) and isHeartbeatHealthy (overThresholdCount). */
    heartbeat: HeartbeatStats;
}

export interface CollectorStats {
    /** DISPLAY. Discriminant. */
    thread: 'collector';
    // DISPLAY, all of them.
    polls: number;
    failures: number;
    discovered: number;
    samplesWritten: number;
    /** DISPLAY - see the sweep findings. Samples DISCARDED, and health is silent. */
    writeFailures: number;
    pendingSamples: number;
    inFlight: number;
    inFlightDown: number;
    concurrency: number;
    downConcurrency: number;
    skippedNoSlot: number;
    asyncErrors: number;
    lastWriteMs: number;
    // DISPLAY. pollLagP95Ms is the slice 4 done-when criterion, checked by the
    // harness against a fixture rather than by health against a threshold.
    pollLagP50Ms: number;
    pollLagP95Ms: number;
    pollLagMaxMs: number;
    pollP50Ms: number;
    pollP95Ms: number;
    // DISPLAY, reachability (slice 9). reachEnabled false means fping was
    // absent or PING_ENABLED=0 - a fleet stuck at 'unknown' must say why
    // here rather than reading as quiet. Overruns are sweeps SKIPPED because
    // the previous one was still running: the sweep never overlaps itself,
    // and a fleet too big for its interval shows up as this counter climbing
    // rather than as drifting cadence (SLICE-9-PLAN, the overrun policy).
    reachEnabled: boolean;
    reachSweeps: number;
    reachOverruns: number;
    reachTransitions: number;
    reachLastSweepMs: number;
    /**
     * Enabled devices whose reach_check names a probe this build cannot
     * perform. Non-zero means those devices' reach_state is FROZEN - they are
     * not being probed by anything and their last value stands indefinitely,
     * which on a ping-only device is its whole status. Published rather than
     * logged alone for the same reason reachEnabled is: a fleet that is not
     * being watched must say so in a number somebody can alarm on, not only
     * in a line somebody has to be reading at the time.
     */
    reachUnsupported: number;
    /**
     * The oldest in-flight poll's age in ms, null when nothing is in
     * flight (AUDIT-2026-09-01 finding 1). The detector for the leaked
     * poll slot: every other instrument reads healthy while one holds a
     * device forever, because a slot leak is work NOT happening - the
     * scheduler starvation lesson restated per device.
     */
    oldestInFlightMs: number | null;
    /** Failures split by kind (easy-win E5): a credential-rotation auth
     *  spike and a dead-fleet timeout spike are different incidents that
     *  one total made a log grep to tell apart. Optional so stats fixtures
     *  built before it existed keep compiling. */
    failuresByKind?: { timeout: number; auth: number; other: number };
    /**
     * VERDICT. isPartitionHealthy(_, 'collector').
     *
     * Present for the same reason as IngestStats.partitions, and it was absent.
     * The collector discards samples on a write failure by design, so a missing
     * partition costs data immediately rather than filling a queue - which
     * makes the runway MORE urgent here, not less. Adding it to the shared type
     * is what forces the worker to publish it.
     */
    partitions: PartitionState;
    /** VERDICT. isReporting and isHeartbeatHealthy. */
    heartbeat: HeartbeatStats;
}

export interface ExportWorkerStats {
    /** DISPLAY. Discriminant. */
    thread: 'export';
    /** DISPLAY. Exports in flight. */
    active: number;
    /** VERDICT. isReporting and isHeartbeatHealthy, while a worker is up. */
    heartbeat: HeartbeatStats;
}

/**
 * The rollup frontier, as the jobs worker sees it.
 *
 * Published rather than left in the database because the health endpoint must
 * be able to say "the rollup has stalled" without issuing a query of its own,
 * and because a frontier the jobs worker cannot READ is itself a problem worth
 * reporting - `readAt` is null in that case rather than the lag silently
 * freezing at its last good value.
 */
export interface FrontierState {
    /** VERDICT. ISO timestamp the rollup has consumed through; null means it never ran. */
    throughTs: string | null;
    /** VERDICT. now - throughTs, compared against alarmAboveHours. */
    lagHours: number | null;
    /**
     * VERDICT. When this was last read from job_state.
     *
     * Null means never; an OLD value means the jobs worker cannot reach the
     * database and every other field here is frozen at its last good value.
     * This is the field that was published as the staleness signal and then
     * never aged - the third wiring bug.
     */
    readAt: string | null;
    /** VERDICT. The threshold lagHours is compared against, by MAIN rather than the worker. */
    alarmAboveHours: number;
    /** VERDICT, for the never-ran grace: how many devices exist, and when the
     *  first was added (null when none has an added time). Optional for
     *  fixture compatibility; absent means no grace. */
    devices?: number;
    firstDeviceAt?: string | null;
}

/**
 * How long a new install may have a rollup that has never run (2026-09-28,
 * the chaos drill on a fresh database). The rollup takes complete hours after
 * a five-minute settle, so its first pass comes 60-70 minutes after the first
 * samples; until then "never ran" is simply true, and a brand-new install
 * showed red health for its first hour - the first thing a new user sees.
 */
export const ROLLUP_FIRST_RUN_GRACE_MS = 2 * 3_600_000;

export interface JobRecordState {
    /** DISPLAY. */
    name: string;
    /** DISPLAY. */
    runs: number;
    /** DISPLAY. A job permanently skipping is visible here and in consecutiveFailures. */
    skippedInFlight: number;
    /** DISPLAY. Cumulative, so it cannot distinguish "failed once in March" from "failing now". */
    failures: number;
    /** DISPLAY, quoted in the verdict's problem string. */
    lastRunAt: string | null;
    /** DISPLAY, quoted in the problem string. */
    lastOkAt: string | null;
    /** DISPLAY. */
    lastMs: number;
    /** DISPLAY, quoted in the problem string - it carries the actual error text. */
    lastDetail: string;
    /**
     * VERDICT. Consecutive failures since the last success, via isJobsHealthy.
     *
     * ADDED BY THE CONSUMPTION SWEEP, because it is the fourth instance of the
     * shape. Every job's outcome was DISPLAY: `failures` was cumulative, so
     * "failed once last week" and "has failed every run since Tuesday" were the
     * same number, and nothing branched on either.
     *
     * What that permitted is the same disk-exhaustion path the frontier check
     * was built to catch, reached by a different route. The frontier check sees
     * a wedged ROLLUP. It cannot see a wedged RETENTION: the rollup keeps
     * running, the frontier stays current, health stays 200, and nothing is
     * ever expired because the job that expires things has been throwing every
     * hour. Same for the trigram job, which Fable already described failing
     * "every run forever, visible only in jobsStats".
     */
    consecutiveFailures: number;
}

export interface JobsStats {
    /** DISPLAY. Discriminant. */
    thread: 'jobs';
    /** DISPLAY. */
    asyncErrors: number;
    /** VERDICT. Each record's consecutiveFailures, via isJobsHealthy. */
    jobs: JobRecordState[];
    /** DISPLAY. Which jobs are running right now. */
    inFlight: string[];
    /** VERDICT. isFrontierHealthy. */
    frontier: FrontierState | null;
    /** DISPLAY. Per-channel delivery health (easy-win E6), refreshed once a
     *  minute by the notify pass: the trailing failure streak is the
     *  "configured-and-dead" signal isNotifyConfigSane cannot see. Optional
     *  for fixture compatibility. */
    notifyChannels?: Array<{
        channel: string; trailingFailures: number;
        lastDeliveredTs: string | null; lastAttemptTs: string;
    }>;
    /** VERDICT. isReporting and isHeartbeatHealthy. */
    heartbeat: HeartbeatStats;
}

// --- the worker enumeration ----------------------------------------------------
//
// EVERY WORKER, IN ONE PLACE, so that health cannot silently omit one.
//
// protocol.ts was created to close the untyped-worker-boundary class after the
// ingest worker's partition runway was published to a field main did not read.
// It closed it for the two workers that appeared in that bug. The JOBS worker -
// added afterwards, and the only one with no typed contract here - was then the
// one worker with no health verdict of any kind: not reporting, not freshness,
// not frontier lag. The mechanism built to prevent "computed correctly, wired
// to nothing" had the newest component outside it.
//
// Adding the missing checks would fix the instance. This fixes the class: main
// must supply a report for `Record<WorkerName, WorkerReport>`, and an object
// literal missing a key does not compile. Adding a fifth worker to the list
// below breaks the build in main.ts until it is given a verdict, which is the
// only version of this that survives the next worker.
//
// What the omission permitted, concretely: the rollup wedges (its own sibling
// `partitions:monthly` failing is enough - on the 1st, every roll_up_chunk
// throws on INSERT), the frontier stalls, guard 5 correctly defers every
// samples partition forever, and disk grows about 11GB a day while /api/health
// stays 200. The first hard signal is ENOSPC roughly 30 days later, and it
// lands on INGEST - so a quiet failure in one job destroys the never-drop
// invariant in another.

export const WORKER_NAMES = ['ingest', 'collector', 'export', 'jobs'] as const;
export type WorkerName = typeof WORKER_NAMES[number];

export interface WorkerReport {
    /** Whatever the worker last published, or null if it has published nothing. */
    stats: unknown;
    /** Whether this worker is supposed to be running at all in this configuration. */
    expected: boolean;
    /** Age of the last report, or null when freshness cannot be judged. */
    reportAgeMs: number | null;
}

/**
 * One verdict per expected worker, plus a freshness verdict for each.
 *
 * The loop is the point. A per-worker `if` block in main is what let the jobs
 * worker be forgotten; iterating a declared list means the only way to omit a
 * worker is to delete it from WORKER_NAMES, which is a visible act rather than
 * an oversight.
 */
export function evaluateWorkers(reports: Record<WorkerName, WorkerReport>): HealthVerdict[] {
    const verdicts: HealthVerdict[] = [];
    for (const name of WORKER_NAMES) {
        const r = reports[name];
        verdicts.push(isReporting(r.stats, name, r.expected));
        if (r.expected) verdicts.push(isFresh(r.reportAgeMs, name));
    }
    return verdicts;
}

/**
 * The rollup must not fall so far behind that retention cannot expire anything.
 *
 * Fail-closed on every absence, and there are three distinct ones - a frontier
 * that was never read, a rollup that never ran, and a rollup that ran long ago.
 * They need different fixes, so they get different problem strings rather than
 * one shared "unhealthy".
 *
 * NOT unhealthy when the jobs worker is disabled: that configuration has its
 * own warning at startup, and reporting it here every second would train
 * everyone to ignore the field.
 */
export function isFrontierHealthy(
    f: FrontierState | null | undefined, jobsEnabled: boolean,
): HealthVerdict {
    if (!jobsEnabled) return { healthy: true };

    if (f === null || f === undefined) {
        return {
            healthy: false,
            problem: 'rollup frontier unknown - the jobs worker published no frontier state',
        };
    }
    if (f.readAt === null) {
        return {
            healthy: false,
            problem: 'rollup frontier unreadable - the jobs worker has never successfully read job_state',
        };
    }

    // A FROZEN VALUE MUST NOT READ AS A CURRENT ONE.
    //
    // The pattern is AlertCanvas's, and its version is finer than the one this
    // file arrived at: readFeed separates missing, unreadable, malformed,
    // non-document and STALE, and an open alert FREEZES rather than ageing out
    // while its feed is bad - because ageing it out silently says "resolved"
    // when the truth is "unknown".
    //
    // This file had four of those five and was missing exactly that one.
    // `refreshFrontier` returns early when the read fails, leaving the entire
    // object untouched - so `lagHours` keeps reporting the last GOOD value
    // while real lag grows, and health stays 200 through the failure. The
    // worker's own heartbeat is fine and `isReporting` passes, because the
    // worker is alive; it just cannot see the database.
    //
    // Which is the same bug as the comment above `refreshFrontier` warns
    // about - "a frontier refreshed only by a successful rollup would freeze
    // at its last good value exactly when it stopped being true" - reproduced
    // one level down, in the code written to avoid it. `readAt` was published
    // as the signal and nothing consumed it: computed correctly, wired to
    // nothing, for the third time in this project.
    //
    // Unknown is its own verdict, not a healthy one and not a lag figure.
    const readAgeMs = Date.now() - Date.parse(f.readAt);
    if (!Number.isFinite(readAgeMs)) {
        // Its own branch rather than folded into staleness, because the old
        // version would have printed "NaNs ago" - a message that tells an
        // operator the check ran and nothing else.
        return {
            healthy: false,
            problem: `the rollup frontier's readAt is not a parseable timestamp `
                + `(${JSON.stringify(f.readAt)}), so its age cannot be judged`,
        };
    }
    if (readAgeMs > FRONTIER_STALE_MS) {
        return {
            healthy: false,
            problem: `the rollup frontier was last read ${Math.round(readAgeMs / 1000)}s ago - the jobs `
                + 'worker cannot reach job_state, so the lag figure it reports is FROZEN at its last '
                + 'good value and describes the past, not now',
        };
    }
    if (f.throughTs === null) {
        // Young, or empty: nothing has had a complete hour to roll up yet. An
        // install with devices but no recorded add time (from before that
        // column) gets no grace, so a rollup broken on an old box still shows.
        if (f.devices === 0) return { healthy: true };
        const first = f.firstDeviceAt ? Date.parse(f.firstDeviceAt) : Number.NaN;
        if (Number.isFinite(first) && Date.now() - first < ROLLUP_FIRST_RUN_GRACE_MS) return { healthy: true };
        return {
            healthy: false,
            problem: 'the rollup has never run, so no raw partition can ever be expired - '
                + 'guard 5 will defer every one of them while disk grows',
        };
    }

    // TWO FAIL-OPEN BRANCHES, FOUND BY THE CONSUMPTION SWEEP RATHER THAN BY A
    // FAILURE. Neither is producible by today's `refreshFrontier`; both would
    // read as HEALTHY if it ever changed, which is the whole reason to close
    // them now rather than after.
    //
    // The comparison was `f.lagHours !== null && f.lagHours > f.alarmAboveHours`.
    // A null lagHours beside a non-null throughTs skips the check and returns
    // healthy - an internally inconsistent frontier read as fine. And a missing
    // or NaN threshold makes `lagHours > alarmAboveHours` false for every lag,
    // so a corrupted threshold silently disables the check it defines. In both
    // cases the guard evaluates to "no problem" on input it cannot interpret,
    // which is the rule this file exists to enforce, broken inside the file.
    if (!Number.isFinite(f.alarmAboveHours)) {
        return {
            healthy: false,
            problem: 'the rollup lag threshold (alarmAboveHours) is missing or not a number, so no '
                + 'lag can ever exceed it - the frontier check is disabled rather than passing',
        };
    }
    if (f.lagHours === null || !Number.isFinite(f.lagHours)) {
        return {
            healthy: false,
            problem: 'the rollup frontier reports a consumed-through time but no lag figure - '
                + 'the published state is internally inconsistent and cannot be judged',
        };
    }
    if (f.lagHours > f.alarmAboveHours) {
        return {
            healthy: false,
            problem: `the rollup is ${f.lagHours.toFixed(1)} hours behind (alarm above `
                + `${f.alarmAboveHours}) - retention is deferring raw partitions it cannot expire, `
                + 'and disk grows until it catches up',
        };
    }
    return { healthy: true };
}

/**
 * A scheduled job that has failed every attempt since its last success.
 *
 * THE FOURTH INSTANCE OF THE SHAPE, and the sweep found it by asking what
 * `JobRecordState.failures` was for. Every job's outcome was DISPLAY. The
 * frontier check catches a wedged ROLLUP; nothing caught a wedged RETENTION,
 * whose failure reaches the same end - disk grows until ENOSPC lands on ingest -
 * with the rollup healthy and the frontier current the whole way. The trigram
 * job could equally fail every run forever, degrading search to LIKE scans,
 * with `/api/health` at 200.
 *
 * Threshold rather than one failure, because these jobs are DESIGNED to lose
 * races: retention gives up on a 2s lock_timeout and retries, and the trigram
 * drop defers on contention. One failure is the system working. Three in a row
 * is not a race, it is a fault.
 */
export const JOB_FAILURES_ALARM = 3;

export function isJobsHealthy(
    jobs: JobRecordState[] | null | undefined, jobsEnabled: boolean,
): HealthVerdict {
    if (!jobsEnabled) return { healthy: true };
    if (jobs === null || jobs === undefined) {
        return { healthy: false, problem: 'the jobs worker published no job records' };
    }

    const failing = jobs.filter((j) => (j.consecutiveFailures ?? 0) >= JOB_FAILURES_ALARM);
    if (failing.length === 0) return { healthy: true };

    // Named individually. "A job is failing" sends someone to read logs; naming
    // retention:samples and the error it last returned does not.
    const named = failing
        .map((j) => `${j.name} (${j.consecutiveFailures} consecutive, last ok `
            + `${j.lastOkAt ?? 'never'}: ${j.lastDetail})`)
        .join('; ');
    return {
        healthy: false,
        problem: `scheduled jobs are failing every run: ${named}`,
    };
}

/**
 * A CHANNEL THAT STOPPED DELIVERING (2026-09-28, the notification drill).
 * Email pointed at a relay that could not do the STARTTLS it requires: every
 * alert was refused - correctly, never sent in plaintext - and /api/health
 * said ok:true throughout. The channel ledger (easy-win E6) already counted
 * the failures and the page drew them red, but only on the page: a monitor
 * polling health, and anyone not looking at that panel, learned nothing while
 * alerts were raised and nobody was told. Three in a row, because the retry
 * pass retries, and one refused connection is a blip rather than an outage.
 */
export const NOTIFY_FAILURES_ALARM = 3;

export function isNotifyDelivering(
    channels: Array<{ channel: string; trailingFailures: number; lastDeliveredTs?: string | null; lastAttemptTs?: string | null }> | null | undefined,
): HealthVerdict {
    const dead = (channels ?? []).filter((c) => c.trailingFailures >= NOTIFY_FAILURES_ALARM);
    if (dead.length === 0) return { healthy: true };
    return {
        healthy: false,
        problem: dead.map((c) => `notification channel "${c.channel}" has failed its last `
            + `${c.trailingFailures} delivery attempts (last delivered ${c.lastDeliveredTs ?? 'never'}) - `
            + 'alerts are being raised and nobody is being told; each alert\'s delivery history says why')
            .join('; '),
    };
}

/**
 * RETENTION THAT ONLY TALKS (2026-09-28, found rebooting a test install).
 *
 * RETENTION_DRY_RUN defaults to 1 - "the first time this runs against a real
 * deployment it should say what it would do" - and every lab script set it to
 * 0 by hand. The installer never did. So every box installed the documented
 * way, production included, has reported what it would drop every hour and
 * dropped nothing: the database grows until the disk is full, and health was
 * green the whole way, because a dry run succeeds.
 *
 * The installer now turns retention on for NEW installs (the operator's
 * ruling); this is for the ones that already exist. Red only once the dry run
 * has named something past its keep date - before that, dry run and real
 * retention behave identically and there is nothing to warn about.
 */
export function isRetentionEnforcing(
    jobs: JobRecordState[] | null | undefined, dryRun: boolean, jobsEnabled: boolean,
): HealthVerdict {
    if (!jobsEnabled || !dryRun || !jobs) return { healthy: true };
    const kept: string[] = [];
    for (const j of jobs) {
        if (j.name !== 'retention:samples' && j.name !== 'retention:messages') continue;
        const m = /would-drop: ([^|]*)/.exec(j.lastDetail ?? '');
        if (m) kept.push(...(m[1] as string).split(',').map((s) => s.trim()).filter(Boolean));
    }
    if (kept.length === 0) return { healthy: true };
    return {
        healthy: false,
        problem: `retention is in dry run (RETENTION_DRY_RUN=1): ${kept.length} partition(s) are past `
            + `their keep date and are being kept (${kept.slice(0, 3).join(', ')}${kept.length > 3 ? ', ...' : ''}), `
            + 'so the database grows until the disk is full - set RETENTION_DRY_RUN=0 in '
            + '/etc/rscanvas/rscanvas.env and restart the service',
    };
}

// --- fail-closed predicates ---------------------------------------------------
//
// THE RULE: a guard whose ABSENT input reads as permission is not a guard.
//
// `partitionsUnhealthy` was `partitions !== null && partitions.healthy === false`,
// which treats missing data as healthy. But the ingest worker is SUPPOSED to
// publish a runway every second - silence means something is wrong, not that
// everything is fine. A wiring break, a worker that never started, a payload
// that moved: all of them read as "fine".
//
// Same shape as the authorisation question: default deny, and an unknown is a
// denial rather than an allowance.

export type HealthVerdict =
    | { healthy: true }
    | { healthy: false; problem: string };

/**
 * Unhealthy unless PROVEN healthy.
 *
 * Absent data is its own problem string rather than being folded into the
 * healthy case, so a wiring break is distinguishable from a genuine runway
 * shortage - the two need different fixes and should not look the same.
 */
export function isPartitionHealthy(
    p: PartitionState | null | undefined,
    // NAMED, because two writers now report a runway and the strings were
    // identical. An operator reading `problems` saw the same sentence twice
    // with no way to tell which writer was short - and the two have different
    // consequences: ingest queues through a missing partition, the collector
    // DISCARDS. Same principle as absence versus shortage below.
    worker: 'ingest' | 'collector' = 'ingest',
): HealthVerdict {
    // What is lost differs, so the sentence differs.
    const consequence = worker === 'collector'
        ? 'every sample will be DISCARDED when it reaches zero - the collector does not queue'
        : 'every COPY will fail when it reaches zero';

    if (p === null || p === undefined) {
        return {
            healthy: false,
            problem: `partition runway unknown - the ${worker} worker published no partition state`,
        };
    }
    if (typeof p.healthy !== 'boolean') {
        return {
            healthy: false,
            problem: `partition runway unknown - the ${worker} worker's published state has no healthy flag`,
        };
    }
    if (!p.healthy) {
        return {
            healthy: false,
            problem: `the ${worker} worker's partition runway is ${p.runwayDays ?? 'unknown'} days after `
                + `${p.consecutiveFailures} consecutive maintenance failures - ${consequence}`,
        };
    }
    return { healthy: true };
}

/**
 * A worker that should be reporting and is not.
 *
 * Same rule one level up: a thread whose heartbeat never arrives is not a
 * thread with a perfect heartbeat. The ingest worker is always expected; the
 * collector only when enabled; the export worker only once one has run.
 */
export function isReporting(
    stats: unknown, name: string, expected: boolean,
): HealthVerdict {
    if (!expected) return { healthy: true };
    if (stats === null || stats === undefined) {
        return { healthy: false, problem: `the ${name} worker has published no stats` };
    }
    const hb = (stats as { heartbeat?: unknown }).heartbeat;
    if (hb === null || hb === undefined || typeof (hb as HeartbeatStats).worstGapMs !== 'number') {
        return { healthy: false, problem: `the ${name} worker published stats with no usable heartbeat` };
    }
    return { healthy: true };
}

/**
 * The never-drop invariant, finally visible to health.
 *
 * A KERNEL DROP IS NOT A SYMPTOM OF A VIOLATION - IT IS THE VIOLATION. It is
 * the exact thing "never drop a syslog datagram" forbids, and the thing the
 * chaos suite's restart scenario exists to prove does not happen. Until now the
 * system's most important promise was the one thing `/api/health` could not
 * see: the counter was published, correct, and consumed by nothing. The fifth
 * instance of that shape, and the most consequential.
 *
 * THE THRESHOLD IS ZERO AND IS NOT A JUDGEMENT CALL. `shedByUs` and
 * `writeFailures` need somebody to define abnormal, because shedding is
 * designed backpressure and polls fail when devices go down. This does not:
 * the invariant already fixes it, and a threshold above zero here would be
 * somebody quietly deciding how much of that invariant is acceptable.
 *
 * THE COUNTER IS ALREADY A DELTA. The ingest worker baselines both counters at
 * bind time, so `syslogDrops` means "since this worker started", not since
 * boot. Monotonic, therefore sticky - which is right for an invariant
 * violation: a flood an hour ago still happened, still needs investigating, and
 * nothing else in the system records it.
 *
 * ABSENT IS ITS OWN VERDICT, AND IT IS THE IMPORTANT ONE. `available: false`
 * means /proc could not be read, so the invariant is UNMONITORED rather than
 * satisfied - and a deployment on such a platform was reporting perfect health
 * on precisely the metric it cannot read. The ingest worker already warns about
 * this at startup, in a log line, which is where things go to be unread.
 *
 * STALE has no branch here, and that is a property of the structure rather than
 * an omission: every field is re-read from /proc at snapshot time, so the block
 * cannot freeze while its worker publishes, and a worker that has stopped
 * publishing is caught by `isFresh`. A read that fails mid-run yields null,
 * which is the ABSENT branch. The composition is asserted in
 * tools/test-health-predicates.ts rather than assumed.
 */
export function isKernelDropFree(k: KernelUdpState | null | undefined): HealthVerdict {
    if (k === null || k === undefined) {
        return {
            healthy: false,
            problem: 'no kernel UDP counters were published, so the never-drop invariant is '
                + 'UNMONITORED - not satisfied',
        };
    }
    if (!k.available) {
        return {
            healthy: false,
            problem: '/proc/net/udp cannot be read on this platform, so kernel drops cannot be '
                + 'counted - the never-drop invariant is UNMONITORED rather than satisfied, and '
                + '"zero dropped" elsewhere means only "we shed nothing ourselves"',
        };
    }

    // Null with `available: true` is a read that failed after startup, which is
    // a different fault from a platform that never had the file - and it is not
    // a zero.
    const unreadable = (['syslogDrops', 'trapDrops'] as const)
        .filter((f) => typeof k[f] !== 'number' || !Number.isFinite(k[f] as number));
    if (unreadable.length > 0) {
        return {
            healthy: false,
            problem: `kernel drop counters became unreadable (${unreadable.join(', ')}) while /proc `
                + 'was reported available - the invariant is unmonitored from here on',
        };
    }

    const dropped = (['syslogDrops', 'trapDrops'] as const)
        .filter((f) => (k[f] as number) > 0)
        .map((f) => `${f}=${k[f] as number}`);
    if (dropped.length > 0) {
        return {
            healthy: false,
            problem: `THE KERNEL DROPPED DATAGRAMS (${dropped.join(', ')}) - this is the never-drop `
                + 'invariant being violated, not a symptom of one. They never reached the '
                + 'application, so no queue, requeue or drain can recover them. Raise '
                + 'RCVBUF_BYTES and net.core.rmem_max',
        };
    }
    return { healthy: true };
}

/**
 * Rule 6's verdict, moved out of main.ts so it can be corrupted in a test.
 *
 * FOUND BY THE SWEEP: THE GUARD CHECKED A DIFFERENT FIELD FROM THE ONE THE
 * VERDICT USED. `isReporting` validates that `worstGapMs` is a number - and the
 * verdict was `threads.some((t) => t.overThresholdCount > 0)`, computed inline
 * in main. A heartbeat payload carrying a valid `worstGapMs` and a missing
 * `overThresholdCount` therefore passed the guard, and then `undefined > 0` is
 * false, so every thread reported as within threshold. Fail-open, on the field
 * rule 6 is actually about.
 *
 * It was inline in main.ts, which is why no control could reach it. Anything
 * that decides ok/not-ok belongs where a test can hand it a broken input.
 */
/**
 * WHICH THREADS ARE JUDGED ON LATENCY, and which are only observed.
 *
 * THIS PREDICATE WAS A PORTED METRIC MEASURING THE PARENT'S ARCHITECTURE.
 * "Worst event-loop gap across the process" was THE number in the suite:
 * one loop, everything shared it, so a 105ms stall meant every user waited
 * and any occurrence mattered. This fork deliberately has FOUR loops with
 * different tolerances, and the jobs thread blocking is the design working -
 * so the ported rule read the fork's central achievement as a failure. Same
 * family as the LIKE escaping and the case sensitivity, except the thing
 * ported was a MEASUREMENT, which no parent-diff covers because nobody diffs
 * a threshold.
 *
 * Measured on the demo at ~10,000 entities, 2026-07-28:
 *
 *   main 9.7ms   ingest 150.7ms (1 tick)   collector 165.6ms (7 ticks)
 *   jobs 115.2ms (509 ticks)
 *
 * JUDGED - a gap here is user- or data-visible:
 *   main       the HTTP loop. A gap is latency somebody waits for.
 *   ingest     a gap buffers datagrams. The 8MB rcvbuf holds about 8s at the
 *              design point, so a 500ms gap spends 6% of it - and the actual
 *              never-drop violation is measured directly by isKernelDropFree,
 *              which makes this a LEADING INDICATOR rather than the invariant.
 *   collector  a gap delays polls against a 30s interval; pollLagP95 is the
 *              real measure and the harness checks it against a fixture.
 *
 * OBSERVED - blocking is what the thread is FOR, and isolating it is why it
 * has its own loop:
 *   jobs       rollup chunks and retention are heavy synchronous work.
 *   export     streaming a large CSV is the same shape.
 *
 * Their gaps stay in the report because they say how hard the jobs are
 * working. They are not verdicts. isReporting already covers "is it alive",
 * which is the only thing about those threads that can be unhealthy.
 */
export const LATENCY_JUDGED: ReadonlySet<string> = new Set(['main', 'ingest', 'collector']);

/**
 * AND THE PREDICATE WAS MONOTONE, which is the same bug wearing a second
 * face. `overThresholdCount` is cumulative from process start and nothing
 * resets it, so "any tick ever exceeded" means health degrades permanently
 * on the first transient and can never recover. The parent's processes did
 * not run for weeks; this one is expected to.
 *
 * So the judgement is a RATE plus an absolute bound:
 *
 *   sustained   more than 0.1% of ticks over threshold - at a 10ms heartbeat
 *               that is a stall roughly every 10 seconds, which is systematic
 *               rather than a blip.
 *   acute       any single gap over 500ms, which is a real stall on any
 *               thread whatever the rate.
 *
 * A thread with one 150ms transient in twenty minutes passes both, and
 * should: it cost 2% of the ingest buffer and dropped nothing.
 */
export const HEARTBEAT_SUSTAINED_RATE = 0.001;
export const HEARTBEAT_ACUTE_GAP_MS = 500;

export function isHeartbeatHealthy(threads: HeartbeatStats[]): HealthVerdict {
    for (const t of threads) {
        if (typeof t.overThresholdCount !== 'number' || !Number.isFinite(t.overThresholdCount)) {
            return {
                healthy: false,
                problem: `the ${t.thread ?? 'unknown'} thread published no usable `
                    + 'overThresholdCount, so its heartbeat cannot be judged',
            };
        }
    }

    const problems: string[] = [];
    for (const t of threads) {
        if (!LATENCY_JUDGED.has(t.thread)) continue;
        const ticks = typeof t.ticks === 'number' && t.ticks > 0 ? t.ticks : 0;
        const rate = ticks > 0 ? t.overThresholdCount / ticks : 0;
        if (t.worstGapMs > HEARTBEAT_ACUTE_GAP_MS) {
            problems.push(`${t.thread} stalled ${t.worstGapMs}ms in one tick `
                + `(limit ${HEARTBEAT_ACUTE_GAP_MS}ms)`);
        } else if (rate > HEARTBEAT_SUSTAINED_RATE) {
            problems.push(`${t.thread} is over ${t.thresholdMs}ms on `
                + `${(rate * 100).toFixed(2)}% of ticks (${t.overThresholdCount} of ${ticks}), `
                + `sustained past ${(HEARTBEAT_SUSTAINED_RATE * 100).toFixed(2)}%`);
        }
    }
    if (problems.length === 0) return { healthy: true };
    return { healthy: false, problem: problems.join('; ') };
}

export const FRONTIER_STALE_MS = 5 * 60_000;

/** Stats older than this are stale enough to be a problem in their own right. */
export const STATS_STALE_MS = 10_000;

export function isFresh(reportAgeMs: number | null, name: string): HealthVerdict {
    if (reportAgeMs === null) return { healthy: true };
    if (reportAgeMs > STATS_STALE_MS) {
        return {
            healthy: false,
            problem: `the ${name} worker's stats are ${Math.round(reportAgeMs / 1000)}s old - it may be wedged`,
        };
    }
    return { healthy: true };
}

// === WHAT THE CONSUMPTION SWEEP FOUND, 2026-07-27 =============================
//
// Method: enumerate every field, classify VERDICT or DISPLAY, then for every
// VERDICT field write a control that asserts a healthy baseline, corrupts that
// one field, and requires the verdict to flip AND the problem to name it -
// against all three modes, ABSENT, STALE and WRONG. tools/test-health-predicates.ts.
//
// FOUR LIVE DEFECTS, not missing coverage:
//
//   1. Job outcomes were DISPLAY. `failures` was cumulative, so "lost one lock
//      race in March" and "has thrown every run since Tuesday" were the same
//      number, and nothing branched on either. A wedged RETENTION reaches the
//      same disk exhaustion as a wedged rollup - the failure the frontier check
//      was built for - with the rollup healthy and the frontier current the
//      whole way, because they are different jobs. Closed by
//      `consecutiveFailures` and `isJobsHealthy`. THIS IS THE FOURTH INSTANCE.
//
//   2. The heartbeat guard checked a DIFFERENT FIELD from the one the verdict
//      used. `isReporting` validated `worstGapMs`; the verdict was
//      `overThresholdCount > 0`, computed inline in main.ts where no control
//      could reach it. A payload with a good `worstGapMs` and no
//      `overThresholdCount` passed the guard, and `undefined > 0` is false, so
//      every thread reported as within threshold. Closed by `isHeartbeatHealthy`.
//
//   3. Two fail-open branches in `isFrontierHealthy`. A null `lagHours` beside
//      a present `throughTs` skipped the comparison and returned healthy; a
//      missing or NaN `alarmAboveHours` made every lag fail the `>` test, so a
//      corrupted threshold DISABLED the check rather than failing it. Neither
//      is producible by today's `refreshFrontier` - both would have been silent
//      the moment it changed.
//
//   4. `FrontierState.healthy` was consumed by nothing. The worker computed it
//      under a comment claiming main re-derived because it "must not trust a
//      flag it cannot check" - and main does re-derive, so the flag was a
//      second source of truth for an answered question, free to contradict the
//      real verdict in a payload an operator reads. Deleted.
//
// FIFTH DEFECT, AND IT WAS THE SWEEP'S OWN MISCLASSIFICATION.
//
//   5. `KernelUdpState.syslogDrops` / `trapDrops` were filed as DISPLAY, on the
//      reasoning that a verdict would need a threshold this sweep should not
//      invent. That reasoning is right for `shedByUs` and `writeFailures` and
//      wrong here, and the difference is not one of degree. A kernel drop is
//      not a symptom of a never-drop violation - it IS the violation, the exact
//      thing the invariant forbids and the thing the chaos suite's restart
//      scenario exists to prove does not happen. The threshold is zero, already
//      fixed by an invariant this project has stated, tested and built guards
//      around; the only open question was mechanical, and it was already
//      answered, because the worker baselines both counters at bind time.
//
//      So the system's most important promise was the one thing health could
//      not see. Closed by `isKernelDropFree`, with `available: false` as its
//      own verdict: unreadable /proc means UNMONITORED, not satisfied.
//
// TWO DISPLAY FIELDS GENUINELY LEFT AS DECISIONS, because nonzero is normal for
// both and somebody has to define abnormal:
//
//   * `IngestStats.shedByUs` - DESIGNED backpressure when the 50,000 queue
//     fills under flood. The system working, and also the invariant being
//     traded away deliberately.
//   * `CollectorStats.writeFailures` - samples discarded on a write failure by
//     declared policy, and polls fail routinely because devices go down. Fable
//     named this one in the 2026-07-27 review and it is still not a verdict.
//
// NO FIELD WAS UNCLASSIFIABLE. Every one had an answer, which is a weaker
// result than it sounds: the question had simply never been asked, and asking
// it is what produced the four defects above.


// --- the database's own health (U0, 2026-08-13) ------------------------------
//
// Three checks the soak program paid for and the product now carries: the
// wraparound clock (two orphaned tables froze datfrozenxid and put a
// cluster-wide stop ~3 weeks out, silently, while every app instrument read
// healthy), churn bloat (entities reached 10x its live size from no-op
// updates), and disk headroom (retention wedged = disk exhaustion with a
// healthy frontier). Each is fail-closed per this file's rule: an absent
// input is its own named problem, never a pass.

export interface DbSelfState {
    /** max(age(datfrozenxid)) across all databases, from pg_database. */
    oldestDatAge: number | null;
    /** dead/live tuple counts for the hot small tables the collector churns. */
    bloat: Array<{ rel: string; live: number; dead: number }> | null;
    /** per-path filesystem headroom; error entries are absences, not passes. */
    disks: Array<{ path: string; availPct: number } | { path: string; error: string }> | null;
}

// The wraparound alarm fires at the soak's own tripwire (1.5B was "escalate
// immediately"; alarming at 800M leaves ~18 days of runway at the measured
// 65-75M XIDs/day burn). Bloat alarms at dead > 10x live, the measured
// signature of the unbatched churn. Disk alarms under 10% available.
export const WRAPAROUND_ALARM_AGE = 800_000_000;
export const BLOAT_ALARM_RATIO = 10;
export const DISK_ALARM_AVAIL_PCT = 10;

export function isDbSelfHealthy(db: DbSelfState | null): HealthVerdict[] {
    if (db === null) {
        return [{ healthy: false, problem: 'db self-checks unmeasured - the health query itself failed' }];
    }
    const out: HealthVerdict[] = [];

    if (db.oldestDatAge === null) {
        out.push({ healthy: false, problem: 'wraparound age unknown - pg_database returned no ages' });
    } else if (db.oldestDatAge >= WRAPAROUND_ALARM_AGE) {
        out.push({
            healthy: false,
            problem: `wraparound age ${db.oldestDatAge.toLocaleString()} past `
                + `${WRAPAROUND_ALARM_AGE.toLocaleString()} - autovacuum is not advancing `
                + 'datfrozenxid somewhere; find the anchor before the 2.1B hard stop',
        });
    } else {
        out.push({ healthy: true });
    }

    if (db.bloat === null) {
        out.push({ healthy: false, problem: 'bloat unmeasured - pg_stat_user_tables returned nothing' });
    } else {
        let bloated = false;
        for (const t of db.bloat) {
            if (t.live > 0 && t.dead > t.live * BLOAT_ALARM_RATIO) {
                bloated = true;
                out.push({
                    healthy: false,
                    problem: `${t.rel} carries ${t.dead.toLocaleString()} dead tuples against `
                        + `${t.live.toLocaleString()} live - churn is outrunning autovacuum`,
                });
            }
        }
        if (!bloated) out.push({ healthy: true });
    }

    if (db.disks === null || db.disks.length === 0) {
        out.push({ healthy: false, problem: 'disk headroom unmeasured - no paths could be statted' });
    } else {
        for (const d of db.disks) {
            if ('error' in d) {
                out.push({ healthy: false, problem: `disk headroom unmeasured for ${d.path}: ${d.error}` });
            } else if (d.availPct < DISK_ALARM_AVAIL_PCT) {
                out.push({
                    healthy: false,
                    problem: `${d.path} has ${d.availPct}% free - retention or WAL growth `
                        + 'will hit the wall before the next scheduled look',
                });
            } else {
                out.push({ healthy: true });
            }
        }
    }
    return out;
}
