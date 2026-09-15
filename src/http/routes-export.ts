// Export routes: submit a job, poll it, download it, cancel it.

import fs from 'node:fs';
import type http from 'node:http';
import * as jobs from '../export/jobs.ts';
import { humanBytes, humanDuration } from '../export/estimate.ts';
import { audit } from '../auth/index.ts';
import type { Principal } from '../auth/authorize.ts';
import type { SearchFilters } from '../store/index.ts';
import { sendJson, clientIp, inetOrNull, enforce } from './respond.ts';

function view(job: jobs.Job): Record<string, unknown> {
    return {
        id: job.id,
        state: job.state,
        owner: job.owner,
        createdAt: new Date(job.createdAt).toISOString(),
        startedAt: job.startedAt === null ? null : new Date(job.startedAt).toISOString(),
        finishedAt: job.finishedAt === null ? null : new Date(job.finishedAt).toISOString(),
        estimate: {
            rows: job.estimate.rows,
            narrow: job.estimate.narrow,
            rowsPerSecond: job.estimate.rowsPerSecond,
            durationMs: job.estimate.durationMs,
            duration: humanDuration(job.estimate.durationMs),
            bytes: job.estimate.bytes,
            size: humanBytes(job.estimate.bytes),
        },
        projectedStart: humanDuration(job.projectedStartMs),
        // Reported alongside the estimate on every finished job, because the
        // estimator is load bearing for admission and an ETA nobody checks
        // drifts silently.
        actual: job.state === 'done' && job.startedAt !== null && job.finishedAt !== null
            ? {
                rows: job.rows,
                bytes: job.bytes,
                durationMs: job.finishedAt - job.startedAt,
                estimateRatio: job.estimate.durationMs > 0
                    ? Number(((job.finishedAt - job.startedAt) / job.estimate.durationMs).toFixed(2))
                    : null,
            }
            : null,
        error: job.error,
        downloadReady: job.state === 'done' && job.filePath !== null,
    };
}

export async function submit(
    res: http.ServerResponse, principal: Principal, filters: SearchFilters,
    confirm: boolean, req: http.IncomingMessage,
): Promise<void> {
    if (!enforce(res, principal, 'syslog.export')) return;
    const owner = principal.kind === 'user' ? principal.username : 'unknown';

    const result = await jobs.submit({ owner, filters, confirm });
    if (!result.ok) {
        // Each refusal carries what the caller needs to act: how long the wait
        // would be, how many they already have, how big the result is. A bare
        // 429 would send them away to guess.
        const status = result.reason === 'confirmation-required' ? 409
            : result.reason === 'busy' ? 503
            : result.reason === 'queue-wait-too-long' ? 503
            : result.reason === 'too-many-for-user' ? 429
            : 400;
        sendJson(res, status, { ...result, queue: jobs.queueState() });
        return;
    }

    await audit(principal, 'syslog.export', null, {
        jobId: result.job.id,
        rows: result.job.estimate.rows,
        narrow: result.job.estimate.narrow,
        from: filters.from.toISOString(),
        to: filters.to.toISOString(),
        host: filters.host ?? null,
        fragment: filters.fragment ?? null,
    }, inetOrNull(clientIp(req)));

    sendJson(res, 202, { ok: true, job: view(result.job), queue: jobs.queueState() });
}

export function list(res: http.ServerResponse, principal: Principal): void {
    if (!enforce(res, principal, 'syslog.export')) return;
    // An admin sees every job; anyone else sees their own. Someone else's
    // export reveals what they were investigating.
    const mine = principal.kind === 'user' && principal.role === 'admin'
        ? jobs.listAll()
        : jobs.listFor(principal.kind === 'user' ? principal.username : 'unknown');
    sendJson(res, 200, { ok: true, jobs: mine.map(view), queue: jobs.queueState() });
}

/** Owner or admin. Returns null having answered if the caller may not see it. */
function findVisible(
    res: http.ServerResponse, principal: Principal, id: string,
): jobs.Job | null {
    const job = jobs.get(id);
    const owner = principal.kind === 'user' ? principal.username : 'unknown';
    const isAdmin = principal.kind === 'user' && principal.role === 'admin';
    // A job belonging to someone else is reported as absent rather than as
    // forbidden, so job ids cannot be probed for existence.
    if (!job || (job.owner !== owner && !isAdmin)) {
        sendJson(res, 404, { ok: false, detail: 'no such export' });
        return null;
    }
    return job;
}

export function status(res: http.ServerResponse, principal: Principal, id: string): void {
    if (!enforce(res, principal, 'syslog.export')) return;
    const job = findVisible(res, principal, id);
    if (!job) return;
    sendJson(res, 200, { ok: true, job: view(job) });
}

export function download(
    res: http.ServerResponse, principal: Principal, id: string,
): void {
    if (!enforce(res, principal, 'syslog.export')) return;
    const job = findVisible(res, principal, id);
    if (!job) return;

    if (job.state !== 'done' || job.filePath === null) {
        sendJson(res, 409, { ok: false, detail: `export is ${job.state}`, job: view(job) });
        return;
    }
    let stat: fs.Stats;
    try {
        stat = fs.statSync(job.filePath);
    } catch {
        sendJson(res, 410, { ok: false, detail: 'the spooled file has been swept' });
        return;
    }

    res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-length': stat.size,
        // The filename is ours, not the caller's, so nothing user-controlled
        // reaches a Content-Disposition header.
        'content-disposition': `attachment; filename="rscanvas-syslog-${job.id}.csv"`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
    });
    // An error listener BEFORE the pipe. The hourly sweep can delete the file
    // between statSync and open - a microsecond window, but an unhandled
    // 'error' here is fatal on the MAIN thread, which is the one holding every
    // other request.
    const stream = fs.createReadStream(job.filePath);
    stream.on('error', (err: Error) => {
        console.error(new Date().toISOString(), '[main] export download failed:', err.message);
        // Headers are already sent, so the only honest signal left is to end
        // the response short rather than pretend the file completed.
        res.destroy();
    });
    stream.pipe(res);
}

export async function cancel(
    req: http.IncomingMessage, res: http.ServerResponse, principal: Principal, id: string,
): Promise<void> {
    if (!enforce(res, principal, 'syslog.export')) return;
    const job = findVisible(res, principal, id);
    if (!job) return;

    const cancelled = jobs.cancel(id);
    if (cancelled) {
        await audit(principal, 'syslog.export.cancel', id, { state: job.state }, inetOrNull(clientIp(req)));
    }
    sendJson(res, cancelled ? 200 : 409, {
        ok: cancelled,
        detail: cancelled ? 'cancelled' : `export is already ${job.state}`,
        job: view(jobs.get(id) as jobs.Job),
    });
}
