// The export job queue, and its admission policy.
//
// The policy is settled in BUILD-PLAN.md ("Before slice 3: settle the export
// queue's admission policy"). The short version and the reason for each rule:
//
//   1. Every job is COSTED before it is queued, because a wait cannot be
//      bounded without knowing the length of what is ahead of it.
//   2. Refuse when the projected START exceeds a ceiling. This is
//      connectionTimeoutMillis at the job layer, and it is the rule that keeps
//      the queue honest. An unbounded queue is the 20.7s finding one level up:
//      a job id that resolves in three hours carries less information than a
//      refusal would have.
//   3. Cap per user, or one caller fills the queue and a second operator's
//      2,465 row export waits behind 46 million.
//   4. Above a row threshold, require explicit confirmation rather than
//      refusing. 10.9GB of CSV is not the tool's business to forbid, but
//      nobody should get it by accident.
//
// Jobs live in memory. An export is not resumable - a half-written CSV is not
// something to hand back - so surviving a restart would mean re-running the
// work anyway, and a jobs table would imply a durability this does not have.
// Restart cancels everything in flight, and says so.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { CONFIG } from '../config.ts';
import { OPS, type SearchFilters } from '../store/index.ts';
import { estimate, humanBytes, humanDuration, type Estimate } from './estimate.ts';
import type { HeartbeatStats } from '../heartbeat.ts';
import { safeLogArgs } from '../logsafe.ts';

export type JobState = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface Job {
    id: string;
    owner: string;
    state: JobState;
    filters: SearchFilters;
    estimate: Estimate;
    createdAt: number;
    startedAt: number | null;
    finishedAt: number | null;
    /** Rows actually written, which is the number to compare against the estimate. */
    rows: number;
    bytes: number;
    error: string | null;
    filePath: string | null;
    /** Projected start at the moment it was admitted, for measuring the estimator. */
    projectedStartMs: number;
}

export type Refusal =
    | { ok: false; reason: 'busy'; detail: string }
    | { ok: false; reason: 'queue-wait-too-long'; detail: string; projectedStartMs: number; ahead: number }
    | { ok: false; reason: 'too-many-for-user'; detail: string; limit: number }
    | { ok: false; reason: 'confirmation-required'; detail: string; rows: number; bytes: number; durationMs: number }
    | { ok: false; reason: 'too-large-for-spool'; detail: string; bytes: number }
    | { ok: false; reason: string; detail: string };

const jobs = new Map<string, Job>();
const queue: string[] = [];
let running = 0;

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[export]', ...safeLogArgs(args));
}

function spoolDir(): string {
    fs.mkdirSync(CONFIG.exportSpoolDir, { recursive: true });
    return CONFIG.exportSpoolDir;
}

/**
 * How long the work already accepted will take.
 *
 * Running jobs count only for their REMAINING estimated time, not their whole
 * estimate, or a job 90% finished would keep pushing new arrivals over the
 * ceiling for no reason.
 */
function projectedStartMs(): number {
    let ahead = 0;
    for (const id of queue) {
        const j = jobs.get(id);
        if (j) ahead += j.estimate.durationMs;
    }
    for (const j of jobs.values()) {
        if (j.state !== 'running' || j.startedAt === null) continue;
        const elapsed = Date.now() - j.startedAt;
        ahead += Math.max(0, j.estimate.durationMs - elapsed);
    }
    // Two connections work in parallel, so the wait is the backlog divided by
    // the lane width rather than the whole backlog.
    return ahead / CONFIG.exportConcurrency;
}

function countForUser(owner: string): number {
    let n = 0;
    for (const j of jobs.values()) {
        if (j.owner === owner && (j.state === 'queued' || j.state === 'running')) n++;
    }
    return n;
}

export interface SubmitOptions {
    owner: string;
    filters: SearchFilters;
    confirm: boolean;
}

export async function submit(opts: SubmitOptions): Promise<{ ok: true; job: Job } | Refusal> {
    // Rule 1: cost it first. The count runs on the heavy lane, which can itself
    // refuse - and that refusal is passed through rather than swallowed,
    // because "four searches are already running" is a true and useful answer
    // to "can I start an export".
    const counted = await OPS.countMessages(opts.filters);
    if (!counted.ok) {
        if (counted.reason === 'busy') {
            return { ok: false, reason: 'busy', detail: 'the search lane is busy; try again in a moment' };
        }
        if (counted.reason === 'statement-timeout') {
            return {
                ok: false,
                reason: 'count-too-slow',
                detail: 'counting the rows exceeded the lane timeout; narrow the window',
            };
        }
        // A validation refusal from the store: window missing, too wide, or
        // free-text outside the indexed window. Passed through verbatim, so an
        // export is refused for exactly the reason a search would have been.
        return { ok: false, reason: counted.reason, detail: counted.detail };
    }

    const rows = Number(counted.rows[0]?.n ?? 0);
    const est = estimate(opts.filters, rows);

    // Rule 3, checked before rule 2: a per-user cap is about fairness and
    // should not depend on how busy the queue happens to be.
    const mine = countForUser(opts.owner);
    if (mine >= CONFIG.exportMaxPerUser) {
        return {
            ok: false,
            reason: 'too-many-for-user',
            detail: `you already have ${mine} exports queued or running (limit ${CONFIG.exportMaxPerUser})`,
            limit: CONFIG.exportMaxPerUser,
        };
    }

    // Rule 4: confirmation, not refusal.
    if (rows > CONFIG.exportConfirmRows && !opts.confirm) {
        return {
            ok: false,
            reason: 'confirmation-required',
            detail: `${rows.toLocaleString()} rows, about ${humanBytes(est.bytes)} and ${humanDuration(est.durationMs)}. Resubmit with confirm to proceed.`,
            rows,
            bytes: est.bytes,
            durationMs: est.durationMs,
        };
    }

    // Disk is a real limit and running out of it mid-export corrupts nothing
    // but wastes everything. Checked against the estimate rather than
    // discovered at byte 10,900,000,000.
    if (est.bytes > CONFIG.exportMaxBytes) {
        return {
            ok: false,
            reason: 'too-large-for-spool',
            detail: `about ${humanBytes(est.bytes)} exceeds the ${humanBytes(CONFIG.exportMaxBytes)} spool limit`,
            bytes: est.bytes,
        };
    }

    // Rule 2: bound the WAIT, not the depth.
    const projected = projectedStartMs();
    if (projected > CONFIG.exportMaxQueueWaitMs) {
        // The count has to include RUNNING jobs, not just queued ones. Their
        // remaining time is most of the wait, and an earlier version of this
        // message said "1 exports are queued" while three were in flight - a
        // number that invites the caller to retry immediately.
        const ahead = queue.length + running;
        return {
            ok: false,
            reason: 'queue-wait-too-long',
            detail: `${ahead} export${ahead === 1 ? ' is' : 's are'} ahead of you and yours would start in about `
                + `${humanDuration(projected)}, past the ${humanDuration(CONFIG.exportMaxQueueWaitMs)} limit. `
                + 'Narrow the window or try later.',
            projectedStartMs: projected,
            ahead,
        };
    }

    const job: Job = {
        id: crypto.randomBytes(9).toString('base64url'),
        owner: opts.owner,
        state: 'queued',
        filters: opts.filters,
        estimate: est,
        createdAt: Date.now(),
        startedAt: null,
        finishedAt: null,
        rows: 0,
        bytes: 0,
        error: null,
        filePath: null,
        projectedStartMs: projected,
    };
    jobs.set(job.id, job);
    queue.push(job.id);
    log(`queued ${job.id} for ${job.owner}: ${rows.toLocaleString()} rows, `
        + `${est.narrow ? 'narrow' : 'wide'}, est ${humanDuration(est.durationMs)}, `
        + `projected start ${humanDuration(projected)}`);

    void pump();
    return { ok: true, job };
}

// --- the worker ---------------------------------------------------------------
//
// All row handling happens over there. The main thread keeps the queue and the
// admission policy, which are decisions rather than work, and never touches a
// row. See src/workers/export.ts for why: doing the formatting here cost the
// main thread 55.6ms of blocked loop with 5 excursions past the threshold.

const HERE = path.dirname(fileURLToPath(import.meta.url));

let worker: Worker | null = null;
let workerStats: { thread: string; active: number; heartbeat: HeartbeatStats } | null = null;

function ensureWorker(): Worker {
    if (worker) return worker;
    const w = new Worker(path.join(HERE, '..', 'workers', 'export.ts'), { name: 'export' });

    w.on('message', (msg: { type: string } & Record<string, unknown>) => {
        if (msg.type === 'ready') { log('worker ready'); return; }
        if (msg.type === 'stats') {
            workerStats = msg.stats as { thread: string; active: number; heartbeat: HeartbeatStats };
            return;
        }
        const job = jobs.get(String(msg.jobId));
        if (!job) return;

        if (msg.type === 'done') {
            if (msg.cancelled === true || job.state === 'cancelled') {
                job.state = 'cancelled';
                job.rows = Number(msg.rows ?? 0);
                if (job.filePath) fs.rm(job.filePath, { force: true }, () => { /* best effort */ });
                job.filePath = null;
            } else {
                job.state = 'done';
                job.rows = Number(msg.rows ?? 0);
                job.bytes = Number(msg.bytes ?? 0);
                const actualMs = Date.now() - (job.startedAt ?? Date.now());
                const ratio = job.estimate.durationMs > 0 ? actualMs / job.estimate.durationMs : 0;
                // Printed on every job, because the estimator is load bearing
                // for admission and an ETA nobody checks drifts silently.
                log(`done ${job.id}: ${job.rows.toLocaleString()} rows, ${humanBytes(job.bytes)}, `
                    + `${humanDuration(actualMs)} actual vs ${humanDuration(job.estimate.durationMs)} estimated `
                    + `(${ratio.toFixed(2)}x)`);
            }
        } else if (msg.type === 'failed') {
            job.state = 'failed';
            job.error = String(msg.error);
            log(`failed ${job.id}: ${job.error}`);
            if (job.filePath) fs.rm(job.filePath, { force: true }, () => { /* best effort */ });
            job.filePath = null;
        }
        job.finishedAt = Date.now();
        running--;
        void pump();
    });

    w.on('error', (err) => {
        // Fail loud. Every in-flight export is lost and the operator polling
        // one deserves to be told rather than left waiting.
        log('FATAL export worker error:', err);
        for (const j of jobs.values()) {
            if (j.state === 'running' || j.state === 'queued') {
                j.state = 'failed';
                j.error = 'export worker died';
                j.finishedAt = Date.now();
            }
        }
        running = 0;
        worker = null;
    });

    w.on('exit', (code) => {
        // The 'error' handler above is only HALF the death wiring: a worker
        // can terminate without ever emitting 'error' (process.exit inside
        // the worker, the thread killed from outside), and 'exit' is the one
        // event every termination fires. Without this handler the stale
        // handle stayed cached, so every later export posted into a corpse
        // and sat queued forever with `running` never decrementing
        // (2026-09-01 review). Guarded on identity: after an 'error' the
        // handle is already nulled and this is a no-op.
        if (worker !== w) return;
        if (code !== 0) log(`FATAL export worker exited with code ${code}`);
        for (const j of jobs.values()) {
            if (j.state === 'running' || j.state === 'queued') {
                j.state = 'failed';
                j.error = 'export worker exited';
                j.finishedAt = Date.now();
            }
        }
        running = 0;
        worker = null;
    });

    worker = w;
    return w;
}

export function requestWorkerStats(): void {
    worker?.postMessage({ type: 'stats' });
}

export function workerHeartbeat(): HeartbeatStats | null {
    return workerStats?.heartbeat ?? null;
}

/**
 * Whatever the export worker last published, for the health enumeration.
 *
 * Separate from workerHeartbeat because the health check needs to distinguish
 * "published stats with no usable heartbeat" from "published nothing", and a
 * function that returns only the heartbeat collapses those two into one null.
 */
export function workerStatsSnapshot(): unknown {
    return workerStats ?? null;
}

/**
 * Whether an export worker is currently up.
 *
 * The export worker is spawned on demand, so absence is its normal resting
 * state. Health must only EXPECT a report while one is actually running,
 * otherwise a quiet system reports itself unhealthy forever.
 */
export function workerRunning(): boolean {
    return worker !== null;
}

function pump(): void {
    if (running >= CONFIG.exportConcurrency) return;
    const id = queue.shift();
    if (id === undefined) return;
    const job = jobs.get(id);
    if (!job || job.state !== 'queued') { pump(); return; }

    running++;
    job.state = 'running';
    job.startedAt = Date.now();
    job.filePath = path.join(spoolDir(), `${job.id}.csv`);

    ensureWorker().postMessage({
        type: 'run',
        jobId: job.id,
        filters: job.filters,
        filePath: job.filePath,
    });
}

export function get(id: string): Job | undefined {
    return jobs.get(id);
}

export function listFor(owner: string): Job[] {
    return [...jobs.values()]
        .filter((j) => j.owner === owner)
        .sort((a, b) => b.createdAt - a.createdAt);
}

export function listAll(): Job[] {
    return [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export function cancel(id: string): boolean {
    const job = jobs.get(id);
    if (!job) return false;
    if (job.state === 'queued') {
        const i = queue.indexOf(id);
        if (i >= 0) queue.splice(i, 1);
        job.state = 'cancelled';
        job.finishedAt = Date.now();
        return true;
    }
    if (job.state === 'running') {
        // Observed by streamExportCsv between fetches, so the cursor is closed
        // and the connection released on the normal path rather than by killing
        // it. Bounded by one batch.
        job.state = 'cancelled';
        worker?.postMessage({ type: 'cancel', jobId: id });
        return true;
    }
    return false;
}

export function queueState(): {
    queued: number; running: number; concurrency: number;
    projectedStartMs: number; maxQueueWaitMs: number; maxPerUser: number;
} {
    return {
        queued: queue.length,
        running,
        concurrency: CONFIG.exportConcurrency,
        projectedStartMs: Math.round(projectedStartMs()),
        maxQueueWaitMs: CONFIG.exportMaxQueueWaitMs,
        maxPerUser: CONFIG.exportMaxPerUser,
    };
}

/** Delete spool files for finished jobs older than the retention window. */
export function sweep(): number {
    const cutoff = Date.now() - CONFIG.exportRetentionMs;
    let removed = 0;
    for (const [id, job] of jobs) {
        if (job.state === 'queued' || job.state === 'running') continue;
        if ((job.finishedAt ?? job.createdAt) > cutoff) continue;
        if (job.filePath) fs.rm(job.filePath, { force: true }, () => { /* best effort */ });
        jobs.delete(id);
        removed++;
    }
    return removed;
}

/**
 * Cancel everything on shutdown and say so.
 *
 * Jobs are in memory, so a restart loses them. Doing that silently would leave
 * an operator polling a job id that will never change state again.
 */
export function shutdown(): Promise<void> {
    for (const job of jobs.values()) {
        if (job.state === 'queued' || job.state === 'running') {
            job.state = 'cancelled';
            job.error = 'server shut down';
            log(`cancelled ${job.id} on shutdown`);
        }
    }
    // Stop the worker itself, and wait briefly for its exit. Its stop
    // handler existed for the whole life of this module and nothing ever
    // sent it (2026-09-01 review). Bounded short, because that handler has
    // no queue to drain - it closes the pool and exits; the in-flight
    // export it may abandon was already cancelled above, loudly.
    const w = worker;
    if (w === null) return Promise.resolve();
    return new Promise((resolve) => {
        const t = setTimeout(() => {
            log('ALARM the export worker did not exit within 3000ms of stop');
            resolve();
        }, 3_000);
        t.unref();
        w.once('exit', () => { clearTimeout(t); resolve(); });
        log('SHUTDOWN stop-posted to the export worker (waiting 3000ms)');
        w.postMessage({ type: 'stop' });
    });
}
