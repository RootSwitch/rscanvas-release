// The /metrics serializer (easy-win E2): the numbers /api/health already
// computes, in OpenMetrics text, so "who monitors the monitor" is answered
// the way the suite answers it - pair with the stack you have.
//
// PURE, deliberately: worker snapshots in, text out, no clock, no DB. Every
// number here is already in memory on the main thread (the workers push
// stats each second), so a 15-second scraper costs this process a string
// build and nothing else - no lane, no query, no work that could compete
// with the thing being measured. That is also why the DB self-checks
// (wraparound, churn, disk) are NOT here: they cost queries, /api/health
// owns them, and a scrape cadence must not set their cadence.
//
// Naming: rscanvas_<noun>_<unit> with _total on counters, labels for the
// per-thing splits, one HELP/TYPE header per family - the conventions
// Prometheus tooling assumes. tools/test-metrics.ts pins the format so a
// renamed field in a stats interface breaks the build here and not on a
// dashboard three weeks later.

import type { CollectorStats, IngestStats, JobsStats } from '../workers/protocol.ts';

export interface HeartbeatLike {
    thread: string;
    worstGapMs: number;
    p99GapMs: number;
    overThresholdCount: number;
}

export interface MetricsInput {
    uptimeS: number;
    heartbeats: HeartbeatLike[];
    collector: CollectorStats | null;
    ingest: IngestStats | null;
    jobs: JobsStats | null;
}

/** Label values are operator-influenced in one place (job and channel
 *  names); escaped per the exposition format so a quote cannot break a
 *  scrape. */
const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');

export function serializeMetrics(m: MetricsInput): string {
    const out: string[] = [];
    const family = (name: string, type: 'counter' | 'gauge', help: string): void => {
        out.push(`# HELP rscanvas_${name} ${help}`);
        out.push(`# TYPE rscanvas_${name} ${type}`);
    };
    const line = (name: string, value: number | null | undefined, labels = ''): void => {
        if (value === null || value === undefined || !Number.isFinite(value)) return;
        out.push(`rscanvas_${name}${labels === '' ? '' : `{${labels}}`} ${value}`);
    };

    family('up', 'gauge', 'The process is serving; uptime rides beside it.');
    line('up', 1);
    family('uptime_seconds', 'gauge', 'Main process uptime.');
    line('uptime_seconds', Math.round(m.uptimeS));

    family('worker_reporting', 'gauge', 'Whether each worker has published stats (absence is a fact, not a zero).');
    for (const [thread, stats] of [
        ['collector', m.collector], ['ingest', m.ingest], ['jobs', m.jobs],
    ] as const) {
        line('worker_reporting', stats === null ? 0 : 1, `thread="${thread}"`);
    }

    family('heartbeat_worst_gap_ms', 'gauge', 'Worst event-loop gap per thread - the isolation thesis metric.');
    family('heartbeat_over_threshold_total', 'counter', 'Gaps over the per-thread threshold.');
    for (const h of m.heartbeats) {
        line('heartbeat_worst_gap_ms', h.worstGapMs, `thread="${esc(h.thread)}"`);
        line('heartbeat_over_threshold_total', h.overThresholdCount, `thread="${esc(h.thread)}"`);
    }

    const c = m.collector;
    if (c !== null) {
        family('polls_total', 'counter', 'Completed polls.');
        line('polls_total', c.polls);
        family('poll_failures_total', 'counter', 'Failed polls, by kind.');
        line('poll_failures_total', c.failures, 'kind="all"');
        for (const [kind, n] of Object.entries(c.failuresByKind ?? {})) {
            line('poll_failures_total', n, `kind="${esc(kind)}"`);
        }
        family('samples_written_total', 'counter', 'Sample rows written.');
        line('samples_written_total', c.samplesWritten);
        family('sample_write_failures_total', 'counter', 'Sample batches refused or thrown.');
        line('sample_write_failures_total', c.writeFailures);
        family('pending_samples', 'gauge', 'Rows accumulated toward the next flush.');
        line('pending_samples', c.pendingSamples);
        family('polls_in_flight', 'gauge', 'In-flight polls, by lane.');
        line('polls_in_flight', c.inFlight, 'lane="all"');
        line('polls_in_flight', c.inFlightDown, 'lane="down"');
        family('poll_concurrency', 'gauge', 'Configured slots, by lane.');
        line('poll_concurrency', c.concurrency, 'lane="all"');
        line('poll_concurrency', c.downConcurrency, 'lane="down"');
        family('poll_skipped_no_slot_total', 'counter',
            'The starvation counter - the one honest number of the 30k scheduler finding.');
        line('poll_skipped_no_slot_total', c.skippedNoSlot);
        family('poll_lag_ms', 'gauge', 'How late polls start against their due time.');
        line('poll_lag_ms', c.pollLagP50Ms, 'q="p50"');
        line('poll_lag_ms', c.pollLagP95Ms, 'q="p95"');
        line('poll_lag_ms', c.pollLagMaxMs, 'q="max"');
        family('poll_duration_ms', 'gauge', 'Poll wall time.');
        line('poll_duration_ms', c.pollP50Ms, 'q="p50"');
        line('poll_duration_ms', c.pollP95Ms, 'q="p95"');
        family('poll_oldest_in_flight_ms', 'gauge',
            'Age of the oldest in-flight poll - the leaked-slot detector; every other instrument reads healthy.');
        line('poll_oldest_in_flight_ms', c.oldestInFlightMs ?? 0);
        family('reach_sweeps_total', 'counter', 'Reachability sweeps completed.');
        line('reach_sweeps_total', c.reachSweeps);
        family('reach_overruns_total', 'counter', 'Sweeps skipped because the previous one still ran.');
        line('reach_overruns_total', c.reachOverruns);
        family('reach_transitions_total', 'counter', 'Reach state changes written.');
        line('reach_transitions_total', c.reachTransitions);
        family('reach_unsupported_devices', 'gauge',
            'Devices whose reach_check this build cannot probe - their state is frozen.');
        line('reach_unsupported_devices', c.reachUnsupported);
    }

    const i = m.ingest;
    if (i !== null) {
        family('datagrams_received_total', 'counter', 'Datagrams accepted off the sockets.');
        line('datagrams_received_total', i.received);
        family('messages_written_total', 'counter', 'Message rows written.');
        line('messages_written_total', i.written);
        family('datagrams_shed_total', 'counter',
            'Accepted datagrams shed at the queue cap - the never-drop ledger\'s debit side.');
        line('datagrams_shed_total', i.shedByUs);
        family('ingest_queue_depth', 'gauge', 'Rows queued toward the next COPY.');
        line('ingest_queue_depth', i.queued);
        family('ingest_flush_failures_total', 'counter', 'COPY batches that failed and were requeued.');
        line('ingest_flush_failures_total', i.flushFailures);
        family('event_matches_total', 'counter', 'Messages matched by event alert rules.');
        line('event_matches_total', i.eventMatches);
        family('event_upserts_total', 'counter', 'Event alerts written (matches fold per key per flush).');
        line('event_upserts_total', i.eventUpserts);
        family('event_rules_armed', 'gauge', 'Compiled event rules currently matching.');
        line('event_rules_armed', i.eventRulesArmed);
        family('event_rules_disarmed', 'gauge', 'Rules disarmed for stalling the ingest thread.');
        line('event_rules_disarmed', i.eventRulesDisarmed);
    }

    const j = m.jobs;
    if (j !== null) {
        family('job_runs_total', 'counter', 'Completed runs per job.');
        family('job_failures_total', 'counter', 'Failed runs per job.');
        family('job_consecutive_failures', 'gauge', 'The health alarm counts from this.');
        for (const job of j.jobs) {
            const l = `job="${esc(job.name)}"`;
            line('job_runs_total', job.runs, l);
            line('job_failures_total', job.failures, l);
            line('job_consecutive_failures',
                (job as { consecutiveFailures?: number }).consecutiveFailures ?? 0, l);
        }
        family('notify_trailing_failures', 'gauge',
            'Consecutive failures at the tail of each channel\'s delivery log - configured-and-dead.');
        for (const ch of j.notifyChannels ?? []) {
            line('notify_trailing_failures', ch.trailingFailures, `channel="${esc(ch.channel)}"`);
        }
    }

    out.push('# EOF');
    return `${out.join('\n')}\n`;
}
