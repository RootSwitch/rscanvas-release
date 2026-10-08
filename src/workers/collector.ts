// The collector worker. Owns the poll loop and the collector lane.
//
// ARCHITECTURE.md gives this concern a dedicated worker because slot-second
// scheduling must not be perturbed by HTTP work or by a GC pause caused by a
// large web response. A stalled poll loop is the worst kind of failure here:
// it stretches the interval silently, and the data still looks regular
// afterwards, so nothing in the samples says it happened.
//
// SCHEDULING IS SLOT-SECONDS, and the arithmetic is the whole design. Capacity
// is CONCURRENCY x 60 seconds per minute. A responder costs about 50ms of a
// slot; a dead device costs about 10s (a 5s timeout times one retry), which is
// roughly 200x. Both carried fixes exist because of that ratio:
//
//   FIX 1: refill a freed slot ON COMPLETION, not once per tick. Waiting for
//          the next tick to reuse a slot wastes the remainder of every tick a
//          poll finishes early in, and at 50ms per poll against a 1s tick that
//          is most of the capacity.
//
//   FIX 2: cap concurrent DOWN devices separately. Without it, a handful of
//          dead devices hold most of the slots for ten seconds at a time and
//          starve every responder behind them. They are not merely slow, they
//          are 200x slow, so they need their own budget rather than a share of
//          the general one.

import { parentPort } from 'node:worker_threads';
import { CONFIG } from '../config.ts';
import { startHeartbeat } from '../heartbeat.ts';
import { percentiles } from '../collector/percentiles.ts';
import { installSafetyNet } from '../safety.ts';
import { OPS, copySamples, closeAll, storeFailureLane, type SampleRow } from '../store/index.ts';
import { pollDevice } from '../collector/poll.ts';
import { probeAll, type ProbeResult } from '../collector/probe.ts';
import {
    applySweep, validatePingInterval, type ReachState, type ProbeReading,
    partitionChecks, SUPPORTED_CHECKS, tcpKey,
} from '../collector/reach.ts';
import { tcpSweep } from '../collector/tcpcheck.ts';
import { downBudget, liveBudget } from '../collector/lanes.ts';
import { pollTiming } from '../collector/schedule.ts';
import { copyIsolating, isDataError } from './copy-isolate.ts';
import { fpingAvailable, runFpingSweep } from '../collector/fping.ts';
import type { Target } from '../collector/snmp.ts';
import type { CollectorStats } from './protocol.ts';
import { decrypt, credentialStoreReady } from '../credentials/crypto.ts';
import { credentialFields, sessionVersion, type Credential } from '../credentials/v3.ts';
import { isPermittedEnvRef } from '../credentials/profiles.ts';
import { safeLogArgs } from '../logsafe.ts';
import { runCheck } from '../checks/probe.ts';
import { CheckScheduler, type ScheduledCheck } from '../checks/scheduler.ts';
import {
    BUSY_RUNS_LIMIT, inWindow, isCheckKind, OUTCOME_TEXT, outsideVerdict, parseCheckDef, sampleOf, storedDef,
    THROUGHPUT_GAP_S, type CheckDef, type CheckKind, type CheckResult, type ThroughputCheckDef,
} from '../checks/model.ts';
import { PathGate, type Release } from '../checks/pathgate.ts';
import { execFile } from 'node:child_process';

const hb = startHeartbeat('collector', CONFIG.heartbeatMs, CONFIG.heartbeatThresholdMs);

const community = process.env[
    // The credential_ref column names an ENVIRONMENT KEY rather than holding a
    // secret, per ARCHITECTURE.md section 4. This is the DEFAULT, used only
    // when a device names no reference of its own.
    'SNMP_COMMUNITY_ENV_KEY'
] ?? process.env.SNMP_COMMUNITY ?? 'public';

/**
 * CREDENTIAL PROFILES, decrypted in THIS thread only.
 *
 * Loaded from the store at start and on a reload message, exactly as the
 * ingest worker reloads event rules. The map holds PLAINTEXT communities and
 * lives in the collector's heap alone - the HTTP thread never asks for a
 * plaintext community and the store never sees one, so a heap snapshot of
 * main and a lane query log both stay clean. That is the property env-only
 * secrecy had, kept.
 *
 * A profile whose ciphertext does not decrypt under the current key - the
 * wrong-key recovery case - is recorded by NAME in undecryptable, and a device
 * that names it refuses to poll saying so. It does not fall through to the
 * environment: a profile that exists but cannot be read is a different fault
 * from a name nobody defined, and it deserves a different sentence.
 */
const profiles = new Map<string, Credential>();
const undecryptable = new Set<string>();
/** The last "credential profiles loaded" line, so a reload repeats it only when it changes. */
let lastProfileSummary = '';

async function loadProfiles(): Promise<void> {
    if (!credentialStoreReady()) return;   // env-only deployment: nothing to load
    const r = await OPS.credentialProfilesForCollector();
    if (!r.ok) { log(`credential profiles NOT loaded - lane refused (${r.reason}); env refs still resolve`); return; }
    profiles.clear(); undecryptable.clear();
    let v3 = 0;
    for (const p of r.rows) {
        if (p.version === '3') {
            // Slice 29: v3 rows are LOADED now. Both secret fields decrypt
            // here in the collector thread, same as a community - and a
            // profile whose auth key will not decrypt is undecryptable by
            // NAME rather than silently half-usable, because a v3 session
            // built with a missing key fails as "wrong digest" and would
            // send the operator hunting a passphrase that is actually fine.
            if (p.v3_user === null || p.v3_level === null) continue;
            const level = p.v3_level as 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';
            let authKey: string | null = null;
            let privKey: string | null = null;
            if (p.v3_auth_key !== null) {
                authKey = decrypt(p.v3_auth_key);
                if (authKey === null) { undecryptable.add(p.name); continue; }
            }
            if (p.v3_priv_key !== null) {
                privKey = decrypt(p.v3_priv_key);
                if (privKey === null) { undecryptable.add(p.name); continue; }
            }
            profiles.set(p.name, {
                version: '3', user: p.v3_user, level,
                authProto: p.v3_auth_proto, authKey,
                privProto: p.v3_priv_proto, privKey,
            });
            v3++;
            continue;
        }
        if (p.community === null) continue;
        const plain = decrypt(p.community);
        if (plain === null) { undecryptable.add(p.name); continue; }
        profiles.set(p.name, { version: p.version, community: plain });
    }
    // SAID WHEN IT CHANGES (2026-10-02). The reload runs every 30 s and this
    // line went out every time - 2,880 identical lines a day on production,
    // burying whatever sat between them. The first load is logged, and so is
    // every load whose answer differs; a profile turning UNDECRYPTABLE is a
    // difference, so the line that matters still arrives the moment it is true.
    const summary = `credential profiles loaded: ${profiles.size} usable`
        + (v3 > 0 ? ` (${v3} SNMPv3)` : '')
        + (undecryptable.size > 0 ? `, ${undecryptable.size} UNDECRYPTABLE under the current RSCANVAS_SECRET: ${[...undecryptable].join(', ')}` : '');
    if (summary !== lastProfileSummary) {
        log(summary);
        lastProfileSummary = summary;
    }
}

/**
 * Resolve a credential reference, or REFUSE. Never fall back.
 *
 * Order: a PROFILE named ref, then an ENV VAR named ref, then refusal. The
 * old form was `process.env[ref] ?? community`, and it cost a real
 * onboarding on 2026-08-16: an operator typed the community string itself
 * into the field, process.env['<their community>'] was undefined, and the
 * fallback quietly probed everything with public. An absent reference takes
 * the fleet default; a NAMED reference that resolves nowhere is an error
 * carrying the name and both places it looked.
 */
function resolveCommunity(ref: string | undefined): { ok: true; value: Credential } | { ok: false; detail: string } {
    if (ref === undefined || ref === '') return { ok: true, value: { version: '2c', community } };
    const prof = profiles.get(ref);
    if (prof !== undefined) return { ok: true, value: prof };
    if (undecryptable.has(ref)) {
        return {
            ok: false,
            detail: `credential profile "${ref}" exists but cannot be decrypted under the current `
                + "RSCANVAS_SECRET. Either the key changed - restore it - or re-enter this profile's "
                + 'secret on the Credentials page.',
        };
    }
    // An environment reference is a COMMUNITY by construction: v3 has six
    // fields and a passphrase pair, which is a profile, not a variable.
    //
    // ALLOWLISTED BEFORE IT IS RESOLVED (2026-08-31). This is the only site in
    // the process that reads process.env by an operator-supplied name and puts
    // the result on the wire, and it used to read ANY name. Every secret this
    // product has lives in this environment by standing decision, so without
    // this test an admin could set a device's credential_ref to
    // RSCANVAS_SECRET and have the collector send the credential-store key to
    // a host of their choosing as a cleartext community string. The rule is
    // shared with the two main.ts sites rather than copied - copying it is
    // what left this site out of it.
    if (!isPermittedEnvRef(ref)) {
        return {
            ok: false,
            detail: `credential "${ref}" is not a profile on the Credentials page, and only `
                + 'environment variables named SNMP_COMMUNITY* may be used as credential '
                + `references. If ${ref} is meant to be a device community, create a credential `
                + 'profile for it instead - profiles are encrypted at rest and are the supported '
                + 'way to add a secret without restarting the service.',
        };
    }
    const v = process.env[ref];
    if (v !== undefined && v !== '') return { ok: true, value: { version: '2c', community: v } };
    return {
        ok: false,
        detail: `credential "${ref}" is neither a profile on the Credentials page nor an environment `
            + 'variable on this server. That field takes a NAME, never the community string itself. '
            + `Create a profile called ${ref}, or add ${ref}=<community> to /etc/rscanvas/rscanvas.env `
            + 'and restart, or pick one that already exists.',
    };
}

let running = true;
let inFlight = 0;
let inFlightDown = 0;
let takenCodes = new Set<string>();

/**
 * Devices currently being polled.
 *
 * Dispatch decides what is due from devices.last_poll_ts, which is only written
 * when a poll FINISHES. Without this set an in-flight device still looks due,
 * so every tick launches it again - and the longer a poll takes, the more
 * duplicates it accumulates. Measured before the fix: a dead device (10s per
 * attempt, against a 1s tick) was dispatched about ten times over, which
 * saturated all 24 slots at a load needing about fifteen percent of them and
 * produced 406 slot-skips in fifty seconds.
 *
 * It also matters for correctness, not just capacity: two concurrent polls of
 * one device both read the same prev counters and both write a sample, so the
 * second computes its rate against a stale baseline.
 */
// id -> what is in flight and SINCE WHEN. The since is the oldest-in-flight
// gauge (AUDIT-2026-09-01 finding 1, review easy-win E1): every prior
// instrument reads healthy while a leaked poll slot holds a device forever
// - the heartbeat is fine, CPU is flat, inFlight is a number with no age -
// so the age is published and alarmed on. With the walk deadline in place
// this should never exceed deadline-plus-noise, which is exactly what makes
// it the detector: it fires only when the belt above it has failed.
const polling = new Map<string, { name: string; since: number }>();
let lastStuckAlarmMs = 0;
/** Failures BY KIND (easy-win E5). runPoll always computed the kind - to
 *  rate-limit the log line - and then discarded it, so "auth failures
 *  spiked after the credential rotation" was a log grep instead of a
 *  glance. The credential-refusal path counts as auth: the poll never
 *  reached the wire, but the reason it could not is a credential fact. */
const failuresByKind: Record<'timeout' | 'auth' | 'other', number> = {
    timeout: 0, auth: 0, other: 0,
};

/**
 * POLLS THAT COULD NOT BE RECORDED (2026-10-06): they failed on our own
 * database, not on the device - in the lab's second real outage, 93 refused
 * connects that the poller wrote down as about a hundred devices going down.
 * Not device failures, so not in `failures`: counted here instead, and the
 * last fifteen minutes of them are a health verdict (isPollRecording),
 * because the device now keeps its last state and health is where the
 * database's refusal has to show. The window is timestamps, oldest first,
 * bounded so an outage of any length costs a fixed amount.
 */
const UNRECORDED_WINDOW_MS = 15 * 60_000;
const UNRECORDED_KEEP = 10_000;
const unrecordedRecent: number[] = [];
let unrecordedTotal = 0;
let unrecordedLastReason: string | null = null;
let unrecordedLastTs: number | null = null;

/**
 * Devices whose poll could not be recorded, and when each is due again
 * (2026-10-06). The schedule's anchor is written to the database too
 * (OPS.advancePollAnchor), but that write meets the same refusal - in the
 * drill that capped the app's connections, 697 of 2,524 - and a device whose
 * anchor did not move reads as due on the next dispatch pass, so for as long
 * as the refusal lasted it would be polled again and again, each poll asking
 * the device for nothing that could be kept. (The drill did not show harm
 * from it; the SNMP timeouts logged during it were the lab's long-dead
 * devices' hourly reminders. The hold is by construction, not by symptom.)
 * So it is kept here as well, where it does not depend on the database it is
 * a hold against. Bounded by the fleet: an entry
 * leaves when it expires, at the next dispatch pass after its due time.
 */
const heldUntil = new Map<string, number>();

function heldIds(now: number): string[] {
    const ids: string[] = [];
    for (const [id, until] of heldUntil) {
        if (until <= now) heldUntil.delete(id); else ids.push(id);
    }
    return ids;
}

function unrecordedInWindow(now: number): number {
    let drop = 0;
    while (drop < unrecordedRecent.length && unrecordedRecent[drop] < now - UNRECORDED_WINDOW_MS) drop++;
    if (drop > 0) unrecordedRecent.splice(0, drop);
    return unrecordedRecent.length;
}

// Metrics. Poll LAG is the one that matters: how late a poll started against
// when it was due. The interval can look perfect while every poll inside it is
// arriving thirty seconds late.
//
// THE ARRAYS ARE BOUNDED, and the bound is written in a crash. The first
// version pushed per poll forever and computed pollLagMaxMs with
// Math.max(...lagMs) - a spread that puts every element on the CALL STACK.
// On 2026-07-29 at 10:28 UTC, eleven hours after a restart, the spread
// crossed the stack limit and took the process down with RangeError -
// restart-dependent state in its purest form: the bound on the array was
// "the process will not live that long", and the soak existed precisely to
// outlive it. The instruments saw it coming all morning - the per-second
// snapshot() sort over the swelling arrays pushed the collector's heartbeat
// gap 66 -> 628ms across five hourly lines, and rss came within 9 MB of the
// +25% breach - so the crash was the third detector to fire, just the only
// one anyone could not miss. A window of the most recent SAMPLE_WINDOW
// entries also answers the question the percentiles are FOR - "is the
// scheduler keeping up NOW" - where all-time percentiles increasingly
// answered "how was the morning".
const SAMPLE_WINDOW = 10_000;
const lagMs: number[] = [];
const pollMs: number[] = [];
/** Push with an amortised trim: never more than 2x the window in memory. */
function pushSample(arr: number[], v: number): void {
    arr.push(v);
    if (arr.length >= SAMPLE_WINDOW * 2) arr.splice(0, arr.length - SAMPLE_WINDOW);
}
let polls = 0;
let failures = 0;
let samplesWritten = 0;
let writeFailures = 0;
let discovered = 0;
let skippedNoSlot = 0;
let lastWriteMs = 0;
/** Last time each failure kind was logged, so a known-dead fleet stays quiet. */
const failureLog = new Map<string, number>();

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[collector]', ...safeLogArgs(args));
}

let asyncErrors = 0;

/**
 * The handler for every fire-and-forget call on this thread.
 *
 * The store rethrows anything that is not lane-busy or statement-timeout, so
 * these reject exactly when the database blips - and an unhandled rejection is
 * fatal on Node 22. The collector dying takes the whole process with it via
 * main.ts's FATAL handler, which kills the INGEST worker and up to 50,000
 * accepted, unwritten datagrams. A five second Postgres restart became a
 * never-drop violation because a poll tick had no .catch.
 *
 * Counted and logged, never swallowed silently: the next tick will retry, and
 * a collector that is failing every cycle must be visible in the stats rather
 * than only in the log.
 */
function onAsyncError(err: unknown): void {
    asyncErrors++;
    const e = err instanceof Error ? err : new Error(String(err));
    log(`async error (${asyncErrors} total): ${e.message}`);
}

installSafetyNet({ thread: 'collector', onRejection: () => { asyncErrors++; } });

// --- the sample write ----------------------------------------------------------
//
// Batched across devices rather than written per poll. The collector produces
// every entity's row each cycle, so at the ceiling that is about 1,000 rows a
// second, and a COPY per device would spend the lane's budget on protocol.

let pending: SampleRow[] = [];
let flushing = false;
/** The batch a flush is writing, for isolating a refused row (review F7). */
let lastFlushBatch: SampleRow[] | null = null;

async function flush(): Promise<void> {
    if (flushing || pending.length === 0) return;
    flushing = true;
    try {
        const batch = pending;
        pending = [];
        lastFlushBatch = batch;
        const t0 = performance.now();
        const res = await copySamples(batch);
        lastWriteMs = Number((performance.now() - t0).toFixed(1));
        if (res.ok) {
            samplesWritten += res.rowCount;
        } else {
            writeFailures++;
            // The collector lane's policy is wait-and-alarm. Reaching a refusal
            // means something upstream is badly wrong, and these samples cannot
            // be recovered - a sample is a measurement of a moment.
            log(`ALARM sample write refused (${res.reason}), ${batch.length} rows lost`);
        }
    } catch (err) {
        writeFailures++;
        log('sample write failed:', (err as Error).message);
        // ONE DEVICE'S VALUE, NOT THE DATABASE (review F7). The COPY carries
        // every device's rows, and bounds.ts keeps device values storable;
        // if a row is refused on its content anyway, the rest of the fleet's
        // rows are written around it rather than lost with it.
        if (isDataError(err) && lastFlushBatch !== null) {
            const iso = await copyIsolating(lastFlushBatch, async (part) => {
                const r = await copySamples(part);
                return { ok: r.ok, rowCount: r.ok ? r.rowCount : 0 };
            });
            samplesWritten += iso.written;
            log(`  isolated: wrote ${iso.written}, dropped ${iso.dropped.length} refused row(s)`
                + (iso.dropped[0] ? ` (first: entity ${iso.dropped[0].entityId})` : '')
                + (iso.requeue.length > 0 ? `, ${iso.requeue.length} lost to a second failure` : ''));
        }
    } finally {
        lastFlushBatch = null;
        flushing = false;
    }
}

// --- one device ------------------------------------------------------------------

async function runPoll(device: {
    id: string; name: string; host: string; snmp_port: number; snmp_version: string;
    credential_ref: string; poll_interval_s: number; consecutive_failures: number;
    last_poll_ts: Date | null;
    /** Slice 56: when the last poll was due - the schedule's grid. */
    poll_anchor_ts: Date | null;
    /** Last ATTEMPT at the inventory read; null means never, so it is due. */
    inventory_ts: Date | null;
}): Promise<void> {
    const isDown = device.consecutive_failures >= CONFIG.pollDownAfter;
    polling.set(device.id, { name: device.name, since: Date.now() });
    inFlight++;
    if (isDown) inFlightDown++;

    // Lag: how late this poll started against when it was due. Measured before
    // any work, because the number is about the SCHEDULER rather than the
    // device.
    // KEPT PER DEVICE from here on, not only folded into the fleet
    // percentile: the number that says WHICH device is hurting the scheduler
    // is worth a column, and this is where it is known.
    // Against the schedule's grid since slice 56 (src/collector/schedule.ts
    // says why), and the grid's next anchor decided here, where the start
    // time is known.
    const timing = pollTiming(
        device.last_poll_ts?.getTime() ?? null, device.poll_anchor_ts?.getTime() ?? null,
        device.poll_interval_s, Date.now(),
    );
    const thisLagMs = timing.lagMs;
    if (thisLagMs !== null) pushSample(lagMs, thisLagMs);
    const anchor = new Date(timing.anchorMs);
    // The two failure paths record the same grid; lag stays null there, as before.
    const recordFailed = () => OPS.recordDevicePoll(
        device.id, false, null, null, null, false, null, null, null, null, null, null, null, null, anchor,
    );
    // The third path (2026-10-06): the poll failed on the STORE. Nothing
    // about the device is written - it keeps its status and failure count,
    // and its last_poll_ts, so a run of these leaves it stale rather than
    // down - and only the schedule moves on (OPS.advancePollAnchor says why).
    const recordUnrecorded = async (reason: string): Promise<void> => {
        const now = Date.now();
        unrecordedTotal++;
        unrecordedLastReason = reason;
        unrecordedLastTs = now;
        unrecordedRecent.push(now);
        if (unrecordedRecent.length > UNRECORDED_KEEP) unrecordedRecent.shift();
        heldUntil.set(device.id, anchor.getTime() + device.poll_interval_s * 1000);
        const seen = failureLog.get('store') ?? 0;
        if (now - seen > 30_000) {
            failureLog.set('store', now);
            log(`poll of ${device.name} could not be recorded - the database refused (${reason}); `
                + 'the device keeps its last state [further store refusals quiet for 30s]');
        }
        // The same refusal usually meets this write too, so its failure is
        // rate limited like the poll's, and harmless: heldUntil above keeps
        // the device from being due again before its time.
        let why: string | null = null;
        try {
            const moved = await OPS.advancePollAnchor(device.id, anchor);
            if (!moved.ok) why = moved.reason;
        } catch (err) {
            why = (err as Error).message;
        }
        const seenAnchor = failureLog.get('store-anchor') ?? 0;
        if (why !== null && Date.now() - seenAnchor > 30_000) {
            failureLog.set('store-anchor', Date.now());
            log(`advancePollAnchor refused for ${device.name} (${why}) - held in memory until it is due `
                + '[further anchor refusals quiet for 30s]');
        }
    };

    const t0 = performance.now();
    try {
        // INVENTORY CADENCE, decided here rather than inside pollDevice: the
        // poll function handles one device and has no business knowing the
        // schedule. Null means never attempted, which includes every device
        // that existed before this column did - so the backfill is automatic
        // rather than a migration somebody has to remember to run.
        const wantInventory = device.inventory_ts === null
            || Date.now() - device.inventory_ts.getTime() >= CONFIG.inventoryRefreshMs;
        // PER-DEVICE CREDENTIALS, actually applied. The column has been read
        // into this row since slice 4 and then discarded here, with the fleet
        // default passed in its place - so a mixed estate could be onboarded
        // with the right reference and would still be POLLED with the wrong
        // secret. Nothing said so: the device simply timed out forever, which
        // reads as unreachable.
        const cred = resolveCommunity(device.credential_ref);
        if (!cred.ok) {
            failures++;
            failuresByKind.auth++;
            // Rate limited on the SAME key discipline as the failure path
            // below: a fleet onboarded against one missing variable would
            // otherwise log every device every cycle, and the point is to
            // notice the fault, not to transcribe it 450 times a minute.
            const seen = failureLog.get('credential') ?? 0;
            if (Date.now() - seen > 30_000) {
                failureLog.set('credential', Date.now());
                log(`poll of ${device.name} at ${device.host} refused - ${cred.detail}`
                    + ' [further credential failures quiet for 30s]');
            }
            // Recorded as a failed poll so the device shows down rather than
            // silently stale, and the finally block below still runs. Checked
            // like the success path: a refused write here has the same
            // consequence, and this path is the one most likely taken during
            // exactly the database trouble that makes writes refuse.
            const rec = await recordFailed();
            if (!rec.ok) {
                log(`ALARM recordDevicePoll refused for ${device.name} (${rec.reason}) - `
                    + 'this device will be re-polled immediately and forever');
            }
            return;
        }
        const res = await pollDevice(device, cred.value, takenCodes, wantInventory);
        pushSample(pollMs, performance.now() - t0);
        polls++;
        if (!res.ok && res.errorKind === 'store') {
            await recordUnrecorded(res.error ?? 'refused');
            return;
        }
        if (!res.ok) {
            failures++;
            // A failing poll must SAY SO. The first version counted failures
            // and logged nothing, and produced 1,816 silent failures against a
            // configuration error - every one of them invisible in the log
            // while the stats showed a busy, healthy-looking collector.
            //
            // Rate limited rather than suppressed: a fleet with ten dead
            // devices would otherwise fill the log every cycle, and the point
            // is to notice a NEW failure, not to transcribe a known one.
            const key = res.errorKind ?? 'other';
            failuresByKind[key in failuresByKind ? key as keyof typeof failuresByKind : 'other']++;
            // A KNOWN FAILURE IS NOT RE-TOLD EVERY POLL (2026-10-03). The
            // limit above was per KIND, fleet-wide, and 30 s is the default
            // poll interval: one device that stays down - a transient laptop
            // that is simply off - logged a line on every poll, 2,300 a day
            // on production. Now a device's FIRST failed poll in a streak is
            // told, then a reminder about once an hour while it lasts. The
            // streak is the row's own count of failed polls before this one,
            // so this costs no state. The per-kind 30 s limit stays, as the
            // flood guard for many devices failing at once.
            const streak = device.consecutive_failures;
            const perHour = Math.max(1, Math.round(3600 / Math.max(1, device.poll_interval_s)));
            const reminder = streak > 0 && (streak + 1) % perHour === 0;
            const seen = failureLog.get(key) ?? 0;
            if ((streak === 0 || reminder) && Date.now() - seen > 30_000) {
                failureLog.set(key, Date.now());
                log(`poll of ${device.name} at ${device.host}:${device.snmp_port} failed `
                    + `(${key}): ${res.error}`
                    + (reminder ? ` [still failing: ${streak + 1} polls in a row; reminded about hourly]`
                        : ` [further ${key} failures quiet for 30s; this device's are retold about hourly]`));
            }
        }
        discovered += res.discovered;
        // Once per interface, ever - the row flag stops a repeat. Not rate
        // limited, because a fleet convicting forty virtio NICs on first
        // contact is forty facts an operator wants, not noise.
        for (const line of res.speedConvictions) log(`${device.name} ${line}`);
        // A re-enumeration is a hardware event worth a line per interface: it
        // is the moment history would have been spliced onto the wrong port
        // before this existed, and an operator who just installed a card
        // wants to see that the tool followed the names.
        for (const line of res.rekeyed) log(`${device.name} re-enumeration: ${line}`);

        if (res.samples.length > 0) {
            pending.push(...res.samples);
            if (res.counters.length > 0) {
                // ONE statement for the whole device, matching the last-value
                // write below. The loop this replaces sat directly under a
                // comment warning about exactly this N+1 shape and ran one
                // transaction per ENTITY per poll - 331/s across the fleet,
                // 38% of all write transactions (SOAK-CRITERIA 2026-08-10).
                // All counters from one poll share one `now`, so the single
                // ts is the data's own shape, not a compromise.
                const cs = res.counters;
                const cCol = (i: number): Array<bigint | null> => cs.map((x) => x.c[i] ?? null);
                const saved = await OPS.saveCountersBatch(
                    cs.map((x) => x.id),
                    cs[0]?.ts ?? new Date(),
                    cCol(0), cCol(1), cCol(2), cCol(3), cCol(4), cCol(5),
                );
                if (!saved.ok) log(`counter write refused (${saved.reason})`);
            }
            if (CONFIG.lastValueWrites && res.lastValues.length > 0) {
                // ONE statement for the whole device, not one per interface.
                // The per-entity loop is 24 round trips on a typical switch,
                // which is the N+1 shape that made the parent's /api/devices
                // cost 5,200 queries - and measuring the denormalisation
                // decision against it would have reproduced the parent's
                // verdict by construction rather than by evidence.
                const lv = res.lastValues;
                const col = (i: number): Array<number | null> => lv.map((x) => x.v[i] ?? null);
                const batched = await OPS.updateLastValuesBatch(
                    lv.map((x) => x.id),
                    lv[0]?.ts ?? new Date(),
                    lv.map((x) => x.status),
                    lv.map((x) => x.rttMs),
                    col(0), col(1), col(2), col(3), col(4), col(5),
                );
                if (!batched.ok) log(`last-value write refused (${batched.reason})`);
                // The other half of the one-way door: interfaces the walk no
                // longer returned get their went-quiet stamp, so a port that
                // vanishes from the ifTable stops rendering its last numbers
                // as if they were current. Gated on res.ok - a failed poll
                // says nothing about individual ports, and a mid-walk throw
                // leaves partial lastValues that must not stamp everything
                // after the point it died. Zero rows matched in steady state.
                if (res.ok) {
                    const marked = await OPS.markInterfacesStale(
                        device.id, lv.map((x) => x.id), lv[0]?.ts ?? new Date());
                    if (!marked.ok) log(`stale-mark write refused (${marked.reason})`);
                }
            }
        }

        // Checked, not fired and forgotten. If this write is refused the
        // device's last_poll_ts never advances, so it stays permanently due and
        // the scheduler re-polls it forever - a failure that presents as a busy
        // collector rather than as an error.
        const recorded = await OPS.recordDevicePoll(
            device.id, res.ok, res.sysName, res.sysDescr, res.sysLocation,
            res.inventoryTried, res.cpuModel, thisLagMs, res.summary,
            res.uptimeS, res.cpuCores, res.ramKb,
            res.ok && res.rttMs > 0 ? res.rttMs : null,
            res.stencil, anchor,
        );
        if (!recorded.ok) {
            log(`ALARM recordDevicePoll refused for ${device.name} (${recorded.reason}) - `
                + 'this device will be re-polled immediately and forever');
        }
    } catch (err) {
        if (storeFailureLane(err) !== null) {
            await recordUnrecorded((err as Error).message);
            return;
        }
        failures++;
        failuresByKind.other++;
        log(`poll of ${device.name} threw:`, (err as Error).message);
        // false for inventoryTried on the throw path, deliberately: a poll
        // that blew up may not have reached the inventory read at all, and
        // stamping the timestamp here would silently skip a day's refresh
        // every time a device had a bad poll.
        const rec = await recordFailed();
        if (!rec.ok) {
            log(`ALARM recordDevicePoll refused for ${device.name} (${rec.reason}) - `
                + 'this device will be re-polled immediately and forever');
        }
    } finally {
        polling.delete(device.id);
        inFlight--;
        if (isDown) inFlightDown--;
        // FIX 1: refill immediately on completion rather than waiting for the
        // next tick. This is the line that turns a 50ms poll back into a free
        // slot now instead of up to a tick later.
        if (running) dispatch().catch(onAsyncError);
    }
}

// --- the scheduler ----------------------------------------------------------------

let dispatching = false;

/**
 * One lane's share of a dispatch pass.
 *
 * The candidate list is scoped to the lane IN SQL, so a run of down devices
 * at the head of the overdue ordering can no longer consume the pass - which
 * is what it did, taking 44 of 48 candidate slots while 1,048 live devices
 * sat due and 20 of 24 poll slots stayed idle.
 */
async function dispatchLane(lane: 'live' | 'down', budget: number): Promise<void> {
    if (budget <= 0) return;
    // `polling` is passed so the query can exclude what is already in flight.
    // Those rows still carry an old last_poll_ts, so they read as due on every
    // tick, and before this they filled candidate slots that could never be
    // used.
    // Held devices too (heldUntil): their poll could not be recorded and
    // they are not due again yet, whatever their row says.
    const held = heldIds(Date.now());
    const due = await OPS.duePollTargets(budget, lane, CONFIG.pollDownAfter, [...polling.keys(), ...held]);
    if (!due.ok) return;

    for (const d of due.rows) {
        // Raced with another pass between the query and here.
        if (polling.has(d.id) || heldUntil.has(d.id)) continue;
        if (inFlight >= CONFIG.pollConcurrency) { skippedNoSlot++; break; }
        // BREAK, NOT CONTINUE, and the difference matters. Every remaining
        // candidate is in this same lane, so once the lane is full the rest
        // cannot be dispatched either - continuing only burned a counter.
        if (lane === 'down' && inFlightDown >= CONFIG.pollDownConcurrency) { skippedNoSlot++; break; }

        // The 30s floor, enforced here as well as by the CHECK constraint
        // on the column. Three places in the parent, deliberately: a floor
        // one code path can bypass is not a floor.
        const interval = Math.max(CONFIG.pollIntervalFloorS, d.poll_interval_s);
        runPoll({ ...d, poll_interval_s: interval }).catch(onAsyncError);
    }
}

async function dispatch(): Promise<void> {
    if (!running || dispatching) return;
    if (inFlight >= CONFIG.pollConcurrency) return;
    dispatching = true;
    try {
        // DOWN FIRST, because it is the lane that cannot do harm by going
        // first - its cap is bounded below the pool (half of it by default
        // since C6, never all of it; lanes.ts downCap), so it can never take
        // every slot from the fleet that answers. Live first would look
        // equally reasonable and would mean a busy fleet never retries a
        // dead device, so one that came back would stay marked down
        // indefinitely.
        await dispatchLane('down', downBudget(
            inFlight, inFlightDown, CONFIG.pollConcurrency, CONFIG.pollDownConcurrency,
        ));
        // Recomputed, not carried: the down lane has just taken slots, and
        // completions may have returned others while it awaited.
        await dispatchLane('live', liveBudget(inFlight, CONFIG.pollConcurrency));
    } finally {
        dispatching = false;
    }
}

setInterval(() => { if (running) dispatch().catch(onAsyncError); }, CONFIG.pollTickMs).unref();
setInterval(() => { if (running) flush().catch(onAsyncError); }, 1000).unref();

// --- reachability (slice 9) --------------------------------------------------
//
// A second scheduler beside the SNMP one, in THIS worker because "the
// collector is the only worker that reaches the network on its own
// initiative" is a stated ARCHITECTURE invariant - reachability belongs
// under it, not beside it. The decisions live in src/collector/reach.ts and
// are asserted offline; what lives here is I/O and the clock.
let reachEnabled = false;
/** Whether fping answered the startup probe. The sweep runs either way now
 *  (the TCP lane needs no fping); this only gates the ICMP half, whose
 *  devices read `unknown` without it - absence of a probe, said honestly. */
let fpingPresent = false;
let reachSweeps = 0;
let reachOverruns = 0;
let reachTransitions = 0;
let reachLastSweepMs = 0;
/** Enabled devices whose reach_check names a probe this build cannot perform
 *  (see partitionChecks). Their reach_state is frozen, which is why this is a
 *  published number and not only a log line. */
let reachUnsupported = 0;
/** Alarm ONCE per distinct value, not once per sweep: the sweep runs every
 *  10s, so warning every time would be ~8,600 identical lines a day and the
 *  operator would filter out the one thing this exists to say. The COUNT
 *  stays live in the stats; only the shouting is deduped. */
const warnedChecks = new Set<string>();
let sweepInFlight = false;
/** When the last ping HISTORY row was written (slice 36) - the sweep runs
 *  every 10s, the history writes every 60s. */
let lastPingSampleMs = 0;

async function reachSweep(): Promise<void> {
    const t0 = performance.now();
    const fleet = await OPS.reachFleet();
    if (!fleet.ok) return;   // lane down: the next sweep retries, nothing ages
    // DISPATCH ON THE VALUE, and account for what could not be dispatched.
    // reach.ts owns the rule and says why dropping the remainder silently is
    // the worse of the two available mistakes.
    const { probe, tcp, unsupported } = partitionChecks(fleet.rows.map((d) => ({
        id: d.id, host: d.host, prev: d.reach_state as ReachState, check: d.reach_check,
        port: d.reach_port,
    })));
    reachUnsupported = [...unsupported.values()].reduce((a, b) => a + b, 0);
    for (const [check, n] of unsupported) {
        if (warnedChecks.has(check)) continue;
        warnedChecks.add(check);
        console.error(`[collector] ALARM ${n} device(s) have reach_check='${check}', `
            + 'which this build cannot probe. Their reach_state is FROZEN at its last '
            + `value and will not update. Supported: ${SUPPORTED_CHECKS.join(', ')}, `
            + "plus 'none' to opt out of probing entirely.");
    }
    // DEDUPE BY HOST for the probe list (the parent's rule); the fanout back
    // to every device row sharing a host lives in applySweep.
    const hosts = [...new Set(probe.map((d) => d.host))];
    // THE TCP LANE (ruling 6, rung 1) runs CONCURRENTLY with fping, keyed by
    // tcpKey(host, port) - so two devices declaring the same host:port share
    // one probe, the same host on two ports is honestly two, and the merged
    // readings map cannot collide across lanes ('#' never appears in an
    // address; ':' does, in every IPv6 one). The tcp lane's device rows
    // carry the composite key in the host slot, which applySweep documents
    // as the probe identity - everything downstream of the merge (the state
    // machine, the rtt writers, the transition write) is lane-blind.
    const tcpTargets = [...new Map(tcp.map((d) => {
        const key = tcpKey(d.host, d.port);
        return [key, { key, host: d.host, port: d.port }];
    })).values()];
    const tcpDevices = tcp.map((d) => ({ id: d.id, host: tcpKey(d.host, d.port), prev: d.prev }));
    const [icmpReadings, tcpReadings] = await Promise.all([
        hosts.length > 0 && fpingPresent
            ? runFpingSweep(hosts, CONFIG.pingTimeoutMs)
            : Promise.resolve(new Map<string, ProbeReading | null>()),
        tcpTargets.length > 0
            ? tcpSweep(tcpTargets, CONFIG.tcpCheckTimeoutMs, CONFIG.tcpCheckSpacingMs)
            : Promise.resolve(new Map<string, ProbeReading | null>()),
    ]);
    if (icmpReadings === null) {
        // fping was ended by a signal before it printed - a restart's stop
        // reaches it in the same instant as this process. A sweep it did not
        // finish says nothing, not "every host unknown"; the next one decides
        // (reach.ts, sweepReadings). The TCP half goes with it: one sweep,
        // applied whole or not at all.
        log('reach sweep cut short (fping ended by a signal) - nothing applied');
        return;
    }
    const readings = new Map([...icmpReadings, ...tcpReadings]);
    const swept = [...probe, ...tcpDevices];
    const { transitions } = applySweep(swept, readings, CONFIG.pingDegradedMs);
    // The LIVE ping RTT for every device that answered, one change-only
    // statement per sweep. Separate from the transition write on purpose:
    // that one is rare and carries state, this one is every sweep and carries
    // a number, and a quiet fleet must cost nothing.
    {
        // `swept`, not `probe`: the TCP lane's rtt is that device's reach
        // rtt - the number its roster column and its latency chart mean -
        // and leaving the lane out would re-open the ping-only blank-chart
        // hole for tcp-checked devices the day one exists.
        const ids: string[] = [], rtts: Array<number | null> = [];
        for (const d of swept) {
            const r = readings.get(d.host);
            if (r === undefined) continue;
            ids.push(d.id); rtts.push(r === null ? null : r.rttMs);
        }
        if (ids.length > 0) {
            const w = await OPS.recordPingRtts(ids, rtts);
            if (!w.ok) log(`ping rtt batch refused (${w.reason})`);
        }
    }
    // LATENCY HISTORY (slice 36), at a sixth of the sweep rate. The sweep
    // stays fast so a state change is caught in ten seconds; only every
    // sixth one is written down, because "is it up" and "how slow is it
    // today" want completely different resolutions and the expensive one is
    // not the one that has to be quick.
    if (Date.now() - lastPingSampleMs >= 60_000) {
        lastPingSampleMs = Date.now();
        const ids: string[] = [], rtts: Array<number | null> = [];
        for (const d of swept) {
            const r = readings.get(d.host);
            if (r === undefined) continue;   // not probed: NO ROW, which is not a miss
            ids.push(d.id);
            rtts.push(r === null ? null : r.rttMs);
        }
        if (ids.length > 0) {
            const w = await OPS.insertPingSamples(ids, rtts);
            if (!w.ok) log(`ping history batch refused (${w.reason})`);
        }
    }

    if (transitions.length > 0) {
        const w = await OPS.recordReachTransitions(
            transitions.map((t) => t.id),
            transitions.map((t) => t.to),
            transitions.map((t) => t.rttMs),
        );
        if (w.ok) reachTransitions += transitions.length;
    }
    reachSweeps += 1;
    reachLastSweepMs = Math.round(performance.now() - t0);
}

if (CONFIG.collectorEnabled && CONFIG.pingEnabled) {
    // Refused, not clamped - asked-for-2s must fail loudly (reach.ts owns
    // the floor and the reasoning).
    validatePingInterval(CONFIG.pingIntervalS);
    void fpingAvailable().then((present) => {
        fpingPresent = present;
        if (!present) {
            // The plan forbids a silent degrade to no-reachability: a fleet
            // stuck at 'unknown' because a package is missing must say why.
            // Since the TCP lane (ruling 6) this is no longer all-or-nothing:
            // TCP checks need no fping and keep running, so the alarm names
            // exactly what is off rather than claiming more.
            console.error('[collector] ALARM fping is not installed - ICMP reachability is OFF '
                + 'and every icmp-checked reach_state stays unknown until `apt-get install '
                + 'fping` and a restart. TCP checks still run.');
        }
        reachEnabled = true;
        setInterval(() => {
            if (!running) return;
            // SKIP, NEVER OVERLAP. A sweep slower than the interval means the
            // fleet outgrew it (sweep ~= N x spacing + timeout); overlapping
            // sweeps would hide that as drifting cadence and racing writes.
            // The counter makes it a number somebody can alarm on instead.
            if (sweepInFlight) { reachOverruns += 1; return; }
            sweepInFlight = true;
            reachSweep()
                .catch(onAsyncError)
                .finally(() => { sweepInFlight = false; });
        }, CONFIG.pingIntervalS * 1000).unref();
    });
}

// --- service checks (slice 58) --------------------------------------------------
//
// A third scheduler beside polls and reach, in this worker for the same
// invariant: the collector is the only worker that reaches the network on its
// own initiative. The decisions are elsewhere - what a check is and what its
// answer means in src/checks/model.ts, when it starts in scheduler.ts, the
// sockets in probe.ts - and what lives here is the clock and the writes.
//
// A result is two writes: a SAMPLE, into the same pending batch the polls
// fill (history, charts, rollups, retention - all inherited), and the LAST
// VALUES, batched once a second into one statement, which is what the alert
// scan and the device page read.
let checkRuns = 0;
let checkNotOk = 0;
/** Stored checks this build could not read, so is not running. */
let checksUnreadable = 0;
const warnedUnreadable = new Set<string>();
let checkLv: Array<{ id: string; ts: Date; r: CheckResult; outside: boolean | null }> = [];
let checkLvWriting = false;

/** Each check's last outcome, so a CHANGE is logged once - with the reason in
 *  the check's own words - and a steady state is silent (slice 60: a voice
 *  test failed under impairment and nothing anywhere said why). */
const lastOutcome = new Map<string, string>();

function onCheckResult(c: ScheduledCheck, r: CheckResult): void {
    const prev = lastOutcome.get(c.code);
    if (prev !== r.outcome) {
        lastOutcome.set(c.code, r.outcome);
        // The first result after a start is a change from nothing; only a
        // non-ok one is worth a line then.
        if (prev !== undefined || r.outcome !== 'ok') {
            log(`check ${c.deviceName}/${c.name}: ${prev ?? 'start'} -> ${r.outcome} - ${r.detail}`);
        }
    }
    const ts = new Date();
    const s = sampleOf(r);
    pending.push({ entityId: c.id, ts, status: s.status, rttMs: s.rttMs, v: s.v });
    // Slice 59: whether this check counts as outside, by its setting or the
    // address it reached; null (no address) keeps the stored verdict.
    checkLv.push({ id: c.id, ts, r, outside: outsideVerdict(c.def.outside, r.peer) });
    checkRuns++;
    if (r.outcome !== 'ok') checkNotOk++;
}

/** Voice tests that ended busy, in a row, by code (slice 60). */
const busyRuns = new Map<string, number>();

/**
 * One scheduled run, start to written result. A BUSY responder (slice 60) -
 * the iperf3 daemon serves one test at a time, so someone else is testing -
 * is retried once 30 to 90 s later, still holding the check's in-flight
 * mark so the schedule cannot start it twice; busy again is recorded as a
 * gap, never a failure, and twelve in a row read as the responder taken
 * over by something else (busy-always, a down reason).
 */
/**
 * THE STAGGER (slice 61, src/checks/pathgate.ts): one throughput test at a
 * time with a gap after it, no voice test beside one, and a waiting
 * throughput test let in once the running voice tests end. Services pass
 * straight through - they share nothing with a path test.
 */
const pathGate = new PathGate(THROUGHPUT_GAP_S * 1000, () => Date.now(), (fn, ms) => setTimeout(fn, ms).unref());
/** Max-mode throughput tests that came due outside their hours. */
let skippedWindow = 0;

function gateFor(kind: string): Promise<Release> {
    if (kind === 'path-tput') return pathGate.acquireThroughput();
    if (kind === 'path-voice') return pathGate.acquireVoice();
    return Promise.resolve(() => { /* nothing to release */ });
}

/** One run through the gate; released however it ends. */
async function gatedRun(kind: CheckKind, def: CheckDef, deviceHost: string, rttMs: number | null): Promise<CheckResult> {
    const release = await gateFor(kind);
    try {
        return await runCheck(kind, def, deviceHost, { rttMs });
    } finally {
        release();
    }
}

function runScheduled(c: ScheduledCheck, retried = false): void {
    // An uncapped throughput test outside its hours is simply not due: no
    // run, no reading, nothing to alert on - the window is the operator's
    // statement of when the link may be filled.
    if (c.kind === 'path-tput' && !inWindow(c.def as ThroughputCheckDef, new Date().getHours())) {
        skippedWindow++;
        checkScheduler.finished(c.code);
        return;
    }
    // runCheck never throws; the catch is the house rule for a
    // fire-and-forget promise on this thread, not an expected path.
    gatedRun(c.kind, c.def, c.deviceHost, c.deviceRttMs ?? null)
        .then((first) => {
            // A run cut short on THIS box (iperf3's client stopped with the
            // service) is a gap, not a reading: nothing is recorded, so the
            // check keeps its last real one (IPERF_CLIENT_INTERRUPTED).
            if (first.interrupted === true) {
                log(`check ${c.deviceName}/${c.name}: cut short on this box (${first.detail}) - not recorded`);
                checkScheduler.finished(c.code);
                return;
            }
            let r = first;
            if (r.outcome === 'busy' && !retried) {
                setTimeout(() => runScheduled(c, true), 30_000 + Math.random() * 60_000).unref();
                return;
            }
            if (r.outcome === 'busy') {
                const n = (busyRuns.get(c.code) ?? 0) + 1;
                busyRuns.set(c.code, n);
                if (n >= BUSY_RUNS_LIMIT) r = { ...r, outcome: 'busy-always', detail: OUTCOME_TEXT['busy-always'] };
            } else {
                busyRuns.delete(c.code);
            }
            onCheckResult(c, r);
            checkScheduler.finished(c.code);
        })
        .catch((err) => { onAsyncError(err); checkScheduler.finished(c.code); });
}

const checkScheduler = new CheckScheduler(CONFIG.serviceCheckSpacingMs, () => Date.now(), (c, atMs) => {
    setTimeout(() => runScheduled(c), Math.max(0, atMs - Date.now()));
});

/** Whether the iperf3 client is on this box (slice 60): voice tests need it,
 *  nothing else does - so its absence is a number in the stats and a reason
 *  on each voice test, never a failure of the service. */
let iperf3Present: boolean | null = null;
execFile('iperf3', ['--version'], { timeout: 5000, windowsHide: true }, (err) => { iperf3Present = err === null; });

async function loadChecks(): Promise<void> {
    const res = await OPS.probeChecks();
    if (!res.ok) return;   // lane busy: the schedule keeps the set it has
    const specs: ScheduledCheck[] = [];
    let unreadable = 0;
    for (const row of res.rows) {
        const def = storedDef(row.kind, row.extra);
        if (def === null || !isCheckKind(row.kind)) {
            unreadable++;
            if (!warnedUnreadable.has(row.code)) {
                warnedUnreadable.add(row.code);
                log(`ALARM service check ${row.device_name}/${row.name} (${row.code}) has a definition `
                    + 'this build cannot read - it is NOT running. Edit and save it on the device page.');
            }
            continue;
        }
        specs.push({
            id: row.id, code: row.code, kind: row.kind, def,
            deviceHost: row.device_host, deviceName: row.device_name, name: row.name,
            deviceRttMs: row.device_rtt_ms,
        });
    }
    checksUnreadable = unreadable;
    checkScheduler.setChecks(specs);
}

async function flushCheckLv(): Promise<void> {
    if (checkLvWriting || checkLv.length === 0) return;
    checkLvWriting = true;
    const batch = checkLv;
    checkLv = [];
    try {
        // EVERY field through sampleOf, the one layout: reading status and
        // rtt off the result directly stored a voice call's ten seconds as
        // its round trip (slice 60's drill).
        const s = batch.map((b) => sampleOf(b.r));
        const v = (i: number): Array<number | null> => s.map((x) => x.v[i] ?? null);
        const w = await OPS.updateProbeLastValues(
            batch.map((b) => b.id), batch.map((b) => b.ts),
            s.map((x) => x.status), s.map((x) => x.rttMs),
            v(0), v(1), v(2), v(3), v(4), v(5),
            batch.map((b) => b.r.peer), batch.map((b) => b.outside),
        );
        if (!w.ok) log(`service check last-value write refused (${w.reason}), ${batch.length} result(s)`);
    } finally {
        checkLvWriting = false;
    }
}

setInterval(() => { if (running) checkScheduler.tick(); }, 250).unref();
setInterval(() => { if (running) flushCheckLv().catch(onAsyncError); }, 1000).unref();
// Reloaded every minute AND on a 'checks' message from main when one is
// saved - the credentials pattern: the message makes it prompt, the timer
// makes it reliable.
setInterval(() => { if (running) loadChecks().catch(onAsyncError); }, 60_000).unref();

// Partitions for `samples`, owned by the writer for the same reason ingest owns
// its own: a COPY into a range-partitioned table fails outright if no partition
// covers the row, and nothing else was creating tomorrow's. Always several days
// ahead, so a failed run is a warning with slack rather than an outage at
// midnight.
const PARTITION_LOOKAHEAD_DAYS = Number(process.env.PARTITION_LOOKAHEAD_DAYS ?? 7);

/** Below this many days of runway, the thread reports itself unhealthy. */
const PARTITION_RUNWAY_ALARM_DAYS = Number(process.env.PARTITION_RUNWAY_ALARM_DAYS ?? 3);

let partitionsEnsuredThrough: string | null = null;
let partitionFailures = 0;
let partitionConsecutiveFailures = 0;

function partitionRunwayDays(): number | null {
    if (partitionsEnsuredThrough === null) return null;
    return Math.floor((Date.parse(`${partitionsEnsuredThrough}T00:00:00Z`) - Date.now()) / 86_400_000);
}

// THE SAME CONTRACT AS INGEST, and it was not before.
//
// The jobs worker's comment says daily partitions are "owned by their writers"
// because a missing one is an outage rather than housekeeping. Ingest honours
// that: it awaits ensurePartitions() before declaring itself ready, tracks the
// runway, and has a health verdict wired to it. The collector had NEITHER - it
// registered the hourly interval and nothing else, and CollectorStats carried
// no partition state, so the fail-closed health sweep could not see it.
//
// What that permitted, on the day it is most likely to happen: fresh database,
// collector enabled, fleet seeded. Polls succeed, every copySamples throws
// because there is no partition for today, and the collector's flush DISCARDS
// samples on a throw BY DECLARED POLICY - "a sample is a measurement of a
// moment", which is right. /api/health stays 200 because the heartbeat is fine
// and writeFailures is not a verdict. Up to an hour of a brand-new
// deployment's first samples silently do not exist, on the day an operator is
// most likely to conclude it takes a while to warm up.
async function ensurePartitions(): Promise<void> {
    const day = (n: number): string => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const last = day(PARTITION_LOOKAHEAD_DAYS);
    try {
        const res = await OPS.ensureSamplePartitions(day(0), last);
        if (!res.ok) {
            partitionFailures++;
            partitionConsecutiveFailures++;
            log(`ALARM could not ensure sample partitions (${res.reason}) - attempt `
                + `${partitionConsecutiveFailures}, runway ${partitionRunwayDays() ?? 'unknown'} days `
                + 'until every sample is discarded on write');
            return;
        }
        const made = res.rows[0]?.ensure_daily_partitions ?? 0;
        partitionsEnsuredThrough = last;
        partitionConsecutiveFailures = 0;
        if (made > 0) log(`created ${made} sample partitions, covered through ${last}`);
    } catch (err) {
        partitionFailures++;
        partitionConsecutiveFailures++;
        log(`ALARM ensurePartitions threw (attempt ${partitionConsecutiveFailures}): `
            + `${(err as Error).message} - runway ${partitionRunwayDays() ?? 'unknown'} days`);
    }
}
setInterval(() => { if (running) ensurePartitions().catch(onAsyncError); }, 3600_000).unref();

// Codes are minted against a snapshot of what is taken. Refreshed periodically
// rather than per poll: the unique index is the real guard, and a stale
// snapshot costs at most a retry against it.
async function refreshCodes(): Promise<void> {
    const res = await OPS.takenCodes();
    if (res.ok) takenCodes = new Set(res.rows.map((r) => r.code));
}
setInterval(() => { if (running) refreshCodes().catch(onAsyncError); }, 60_000).unref();

// Credential profiles: loaded once at start, then re-read every 30s exactly as
// the ingest worker re-reads event rules - a profile created on the
// Credentials page is live within half a minute with no message plumbing.
// The first load races the first poll and loses gracefully: a device that
// names a profile before it is loaded refuses ONCE, by name, and succeeds on
// its next slot.
loadProfiles().catch(onAsyncError);
setInterval(() => { if (running) loadProfiles().catch(onAsyncError); }, 30_000).unref();

/** The oldest in-flight poll's age, and the alarm on it. Null when idle.
 *  The threshold is derived from the walk deadline rather than written
 *  twice: a poll is walks plus GETs, so several deadlines of age means the
 *  belt failed and a slot is leaking - the condition every other instrument
 *  reads as healthy. Rate-limited to once a minute; the gauge itself stays
 *  live in every stats block. */
function oldestInFlight(): number | null {
    if (polling.size === 0) return null;
    let oldestMs = 0;
    let oldestName = '';
    const now = Date.now();
    for (const p of polling.values()) {
        const age = now - p.since;
        if (age > oldestMs) { oldestMs = age; oldestName = p.name; }
    }
    if (oldestMs > CONFIG.snmpWalkDeadlineMs * 4 && now - lastStuckAlarmMs > 60_000) {
        lastStuckAlarmMs = now;
        log(`ALARM a poll of ${oldestName} has been in flight for ${Math.round(oldestMs / 1000)}s `
            + `- past every deadline that should have ended it. Its slot is unusable until it `
            + 'settles, and if it never does, this line is the only instrument that can see that');
    }
    return oldestMs;
}

function snapshot(): CollectorStats {
    // One sorted copy per window, not one per percentile: this runs every
    // second, and four copy-and-sorts of a 10,000+ entry window were a third
    // of the collector's stalls at 30k (src/collector/percentiles.ts).
    const [lagP50, lagP95] = percentiles(lagMs, [50, 95]) as [number, number];
    const [pollP50, pollP95] = percentiles(pollMs, [50, 95]) as [number, number];
    return {
        thread: 'collector' as const,
        polls,
        failures,
        discovered,
        samplesWritten,
        writeFailures,
        pendingSamples: pending.length,
        inFlight,
        inFlightDown,
        concurrency: CONFIG.pollConcurrency,
        downConcurrency: CONFIG.pollDownConcurrency,
        skippedNoSlot,
        asyncErrors,
        lastWriteMs,
        // Poll lag is the criterion: p95 must stay under the interval. A mean
        // hides exactly the tail that matters.
        pollLagP50Ms: lagP50,
        pollLagP95Ms: lagP95,
        // A loop, never Math.max(...arr): the spread form is what crashed the
        // process - every element becomes a call argument on the stack.
        pollLagMaxMs: Number(lagMs.reduce((m, v) => (v > m ? v : m), 0).toFixed(1)),
        pollP50Ms: pollP50,
        pollP95Ms: pollP95,
        reachEnabled,
        reachSweeps,
        reachOverruns,
        reachTransitions,
        reachLastSweepMs,
        reachUnsupported,
        oldestInFlightMs: oldestInFlight(),
        failuresByKind: { ...failuresByKind },
        pollsUnrecorded: {
            total: unrecordedTotal,
            recent: unrecordedInWindow(Date.now()),
            windowMs: UNRECORDED_WINDOW_MS,
            lastReason: unrecordedLastReason,
            lastTs: unrecordedLastTs === null ? null : new Date(unrecordedLastTs).toISOString(),
        },
        checks: {
            scheduled: checkScheduler.size,
            inFlight: checkScheduler.inFlight,
            runs: checkRuns,
            notOk: checkNotOk,
            skippedInFlight: checkScheduler.skippedInFlight,
            unreadable: checksUnreadable,
            iperf3: iperf3Present,
            skippedWindow,
            gate: pathGate.state,
        },
        // AT THE TOP LEVEL, deliberately. The ingest worker published exactly
        // this block nested inside `kernel` while main read it at the top, so a
        // correctly computed alarm was published every second and read as
        // undefined. Same shape, same place, and the shared type in protocol.ts
        // is what now makes the two sides agree by construction.
        partitions: {
            ensuredThrough: partitionsEnsuredThrough,
            runwayDays: partitionRunwayDays(),
            failures: partitionFailures,
            consecutiveFailures: partitionConsecutiveFailures,
            // False here means every sample is DISCARDED on write, not queued:
            // the collector's declared policy is that a sample is a measurement
            // of a moment and a stale one is worse than none. That makes the
            // runway more urgent here than in ingest, where the queue absorbs it.
            healthy: partitionRunwayDays() !== null
                && (partitionRunwayDays() as number) >= PARTITION_RUNWAY_ALARM_DAYS,
            alarmBelowDays: PARTITION_RUNWAY_ALARM_DAYS,
        },
        heartbeat: hb.stats(),
    };
}

parentPort?.on('message', async (msg: {
    type: string; id?: string;
    targets?: Array<{ host: string; port: number; version: string; credentialRef?: string }>;
    hosts?: string[];
    check?: { kind: string; def: Record<string, unknown>; deviceHost: string; rttMs?: number | null };
}) => {
    // SUBNET SCAN: an fping sweep of a host list, answered with the
    // responders. Runs here because this is the thread that owns the
    // network and the fping binary, and it rides the probe's own
    // correlation and timeout in main. NOT the reachability sweep: that one
    // is scheduled and writes state; this one is an operator action that
    // writes nothing and returns a list. A scan does not probe SNMP - it
    // hands the responders to the add form, whose Test & discover probes
    // them with whatever credential the operator chooses. Two steps on
    // purpose: a host that pings is a candidate, not a device.
    if (msg.type === 'scan') {
        let results: Array<{ host: string; rttMs: number | null }> = [];
        try {
            // null: fping was ended by a signal, so this scan found nothing.
            const readings = await runFpingSweep(msg.hosts ?? [], 500) ?? new Map<string, ProbeReading | null>();
            for (const [host, r] of readings) {
                if (r !== null && r.alive) results.push({ host, rttMs: r.rttMs });
            }
            results.sort((a, b) => {
                const ka = a.host.split('.').map(Number), kb = b.host.split('.').map(Number);
                for (let i = 0; i < 4; i++) if (ka[i] !== kb[i]) return (ka[i] ?? 0) - (kb[i] ?? 0);
                return 0;
            });
        } catch (err) {
            log(`scan failed: ${(err as Error).message}`);
            results = [];
        }
        parentPort?.postMessage({ type: 'probe-result', id: msg.id, results });
        return;
    }

    // PROBE, answered here because this is the thread allowed to touch the
    // network. Correlated by id rather than assumed in-order: probes take
    // seconds and two operators can be onboarding at once.
    //
    // It does NOT take a slot from the poll loop's admission control, and that
    // is a deliberate trade rather than an oversight - probeAll has its own
    // bound. Sharing the poll budget would mean onboarding two hundred devices
    // starves the fleet already being watched, which is the wrong way round:
    // the running system outranks the one being added.
    if (msg.type === 'probe') {
        // Resolve each target's credential REFERENCE here. main sent a name;
        // the value never crossed the thread boundary and never appears in a
        // message, a log line or a heap snapshot of the HTTP thread.
        // A HOST WHOSE CREDENTIAL CANNOT BE RESOLVED IS NOT PROBED, and comes
        // back as its own named refusal rather than as a timeout. Probing it
        // with the fleet default would produce exactly the failure this fix
        // exists to end: a timeout against the right device with the wrong
        // secret, indistinguishable from a device that is down.
        const targets: Target[] = [];
        const refused: ProbeResult[] = [];
        for (const t of msg.targets ?? []) {
            const cred = resolveCommunity(t.credentialRef);
            if (!cred.ok) {
                refused.push({
                    host: t.host, ok: false, sysName: null, sysDescr: null, sysLocation: null,
                    entities: [], trackedCount: 0, trackedUpCount: 0, error: cred.detail, errorKind: 'auth',
                });
                continue;
            }
            targets.push({
                host: t.host, port: t.port,
                // sessionVersion, not t.version verbatim: rediscover sends
                // the device row's STORED version, and a row still saying 2c
                // while its profile went v3 would build a v2c session with
                // an empty community - every probe a timeout, the device
                // reading as down while its poll loop is fine. The poll had
                // this rule from slice 29; this site did not (2026-09-01
                // review).
                version: sessionVersion(t.version, cred.value),
                ...credentialFields(cred.value),
            } as Target);
        }
        let results: ProbeResult[] = [];
        try {
            results = [...refused, ...(targets.length > 0 ? await probeAll(targets) : [])];
        } catch (err) {
            // probeTarget never throws, so reaching here means something
            // structural. Report it as every target failing rather than
            // leaving the caller on a timeout with no reason.
            const detail = (err as Error).message;
            results = targets.map((t: Target) => ({
                host: t.host, ok: false, sysName: null, sysDescr: null, sysLocation: null,
                entities: [], trackedCount: 0, trackedUpCount: 0, error: detail, errorKind: 'other' as const,
            }));
        }
        parentPort?.postMessage({ type: 'probe-result', id: msg.id, results });
        return;
    }
    // Slice 42: RELOAD NOW, because a credential write is a known moment and
    // waiting out the 30s timer costs a page.
    //
    // Measured 2026-08-29 on the lab. Rotate an SNMPv3 key on the agent and
    // update the profile in the same minute - the correct, careful order -
    // and the poll that lands before the next timer tick still authenticates
    // with the OLD key, fails, and marks the device down. Alert 19337:
    // device-down, CRIT, raised 5s later, cleared 30s after that. It only
    // failed to page because the drill was inside a maintenance window.
    //
    // So routine credential hygiene - the thing a security policy MANDATES
    // quarterly - woke the on-call, and the cause was a timer that had no
    // reason to be the only trigger. main already messages this thread for
    // scan and probe; this is the same channel, and it collapses the window
    // from up to 30 seconds to the length of a postMessage.
    //
    // What it does NOT fix, and must not pretend to: the window between the
    // operator changing the DEVICE and updating RSCanvas. That device really
    // is unreachable for that time and really should alert.
    if (msg.type === 'credentials') {
        await loadProfiles();
        return;
    }
    // Slice 58: a service check was added, edited, paused or removed.
    if (msg.type === 'checks') {
        await loadChecks();
        return;
    }
    // Slice 58: the add form's Test button. Run here, on the thread that owns
    // the network, and answered through the probe plumbing. The definition
    // is validated AGAIN - main did, but a message is not a promise - and
    // the reply carries outcome, timings and pass or fail. Never a body.
    if (msg.type === 'check-test') {
        const kind = msg.check?.kind;
        let result: CheckResult;
        if (!isCheckKind(kind) || msg.check === undefined) {
            result = {
                outcome: 'ours', httpStatus: null, totalMs: null, connectMs: null, dnsMs: null,
                certDays: null, assertion: null, peer: null, detail: 'not a check kind this build runs',
            };
        } else {
            const parsed = parseCheckDef(kind, msg.check.def);
            result = parsed.ok
                // Through the gate like a scheduled run: a Test pressed during
                // a throughput test waits its turn rather than measuring it.
                ? await gatedRun(kind, parsed.def, msg.check.deviceHost, msg.check.rttMs ?? null)
                : {
                    outcome: 'ours', httpStatus: null, totalMs: null, connectMs: null, dnsMs: null,
                    certDays: null, assertion: null, peer: null, detail: parsed.detail,
                };
        }
        parentPort?.postMessage({ type: 'probe-result', id: msg.id, results: [result] });
        return;
    }
    if (msg.type === 'stats') {
        parentPort?.postMessage({ type: 'stats', stats: snapshot() });
        return;
    }
    // Handled with no in-repo sender - a counters-reset hook kept for soak
    // instrumentation (SOAK-CRITERIA records its use), sent by hand-patching
    // main when a run needs a clean baseline. Wiring a real sender or
    // deleting the handler both remove the marker below; what it refuses is
    // the handler LOOKING wired while nothing can reach it, which is how
    // three stop handlers spent a month as prose.
    // PROTOCOL-OK: manual soak hook, no sender by design
    if (msg.type === 'reset') {
        lagMs.length = 0;
        pollMs.length = 0;
        polls = 0; failures = 0; samplesWritten = 0; writeFailures = 0;
        discovered = 0; skippedNoSlot = 0;
        hb.reset();
        return;
    }
    if (msg.type === 'stop') {
        // TIMESTAMP 2 OF 3, the ingest worker's protocol: main logs when it
        // POSTS, this is when the worker RECEIVES, and the gap between them
        // is its own diagnosis.
        log('SHUTDOWN stop-received');
        running = false;

        // A DRAIN, modeled on ingest's, and for the reason ingest's own
        // header records: the old body here was one bare `await flush()`,
        // and flush() opens with `if (flushing || ...) return` - so with a
        // flush in flight it drained NOTHING and exited while a concurrent
        // flush still held rows. The guard-as-scheduler defect, in the
        // handler that existed to prevent losing samples. It never fired
        // only because nothing ever posted this stop; main now stops every
        // worker, which is what made this path real (2026-09-01 review).
        //
        // In-flight polls settle on their own - each is bounded by its SNMP
        // conversation, and `running = false` stops the refill in runPoll's
        // finally - and their samples land in `pending`, so the loop waits
        // for both, bounded, because a wedged poll must not hold shutdown
        // open forever.
        const t0 = Date.now();
        log(`SHUTDOWN drain-enter inFlight=${inFlight} pending=${pending.length} flushing=${flushing}`);
        const until = t0 + CONFIG.collectorDrainDeadlineMs;
        while (Date.now() < until) {
            if (inFlight === 0 && !flushing && pending.length === 0) break;
            if (!flushing && pending.length > 0) await flush();
            else await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // The service checks' last values ride their own once-a-second
        // write; one more pass so a reading taken just before stop is kept.
        await flushCheckLv().catch(onAsyncError);
        if (inFlight === 0 && !flushing && pending.length === 0) {
            log(`SHUTDOWN drain-exit reason=drained ms=${Date.now() - t0}`);
        } else {
            log(`SHUTDOWN drain-exit reason=deadline ms=${Date.now() - t0} - ALARM abandoning `
                + `${pending.length} pending sample(s) with ${inFlight} poll(s) still in flight`);
        }
        parentPort?.postMessage({ type: 'final', stats: snapshot() });
        await closeAll();
        hb.stop();
        process.exit(0);
    }
});

// AWAITED BEFORE `ready`, not left to the hourly tick.
//
// Only the interval was registered, so on a fresh database the first partition
// creation happened up to an HOUR after the first poll - and every sample
// written in that hour was discarded, silently, because the collector's flush
// drops on a throw by design. Ingest has always awaited this; the collector is
// the writer where the cost is immediate rather than queued.
Promise.all([refreshCodes(), ensurePartitions()]).then(() => {
    parentPort?.postMessage({ type: 'ready' });
    log(`ready, concurrency ${CONFIG.pollConcurrency} (${CONFIG.pollDownConcurrency} for down devices, `
        + `${CONFIG.pollDownConcurrencySource === 'default' ? 'half the pool' : 'by POLL_DOWN_CONCURRENCY'}), `
        + `floor ${CONFIG.pollIntervalFloorS}s, last-value writes ${CONFIG.lastValueWrites ? 'ON' : 'OFF'}, `
        + `partition runway ${partitionRunwayDays() ?? 'unknown'} days`);
    dispatch().catch(onAsyncError);
    loadChecks().catch(onAsyncError);
}).catch(onAsyncError);
