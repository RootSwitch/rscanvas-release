// The /metrics serializer, offline (easy-win E2): the format is a CONTRACT
// with whatever dashboard scrapes it, so a renamed stats field breaks this
// suite instead of a graph three weeks later. Pure function, fixture
// snapshots in, exposition text out.
//
//   node tools/test-metrics.ts

import { serializeMetrics } from '../src/health/metrics.ts';
import type { CollectorStats, IngestStats, JobsStats } from '../src/workers/protocol.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const has = (text: string, needle: string, label: string): void => {
    if (text.includes(needle)) ok(label);
    else bad(label, `missing: ${needle}`);
};

const hb = (thread: string) => ({
    thread, ticks: 100, worstGapMs: 12.5, p50GapMs: 0.1, p99GapMs: 2,
    thresholdMs: 50, overThresholdCount: 0,
});

const collector = {
    thread: 'collector', polls: 1200, failures: 7, discovered: 3,
    samplesWritten: 50000, writeFailures: 0, pendingSamples: 42,
    inFlight: 5, inFlightDown: 1, concurrency: 24, downConcurrency: 4,
    skippedNoSlot: 0, asyncErrors: 0, lastWriteMs: 9,
    pollLagP50Ms: 120, pollLagP95Ms: 700, pollLagMaxMs: 1500,
    pollP50Ms: 8, pollP95Ms: 480,
    reachEnabled: true, reachSweeps: 300, reachOverruns: 0,
    reachTransitions: 4, reachLastSweepMs: 11, reachUnsupported: 0,
    oldestInFlightMs: 220,
    failuresByKind: { timeout: 5, auth: 2, other: 0 },
    heartbeat: hb('collector'),
} as unknown as CollectorStats;

const ingest = {
    thread: 'ingest', received: 90000, written: 89100, queued: 12, queueMax: 50000,
    flushes: 800, flushFailures: 1, laneBusyEvents: 0, truncated: 0,
    nulsStripped: 4, flushMaxMs: 90, shedByUs: 900, asyncErrors: 0,
    eventRulesArmed: 3, eventRuleErrors: 0, eventRulesDisarmed: 1,
    disarmedRuleIds: ['17'],
    eventMatches: 40, eventUpserts: 6,
    kernel: {}, partitions: {}, heartbeat: hb('ingest'),
} as unknown as IngestStats;

const jobs = {
    thread: 'jobs', asyncErrors: 0,
    jobs: [{ name: 'alerts:scan', runs: 500, skippedInFlight: 0, failures: 2,
        consecutiveFailures: 0, lastRunAt: null, lastOkAt: null, lastMs: 30 }],
    inFlight: [], frontier: null,
    notifyChannels: [{ channel: 'email', trailingFailures: 96,
        lastDeliveredTs: null, lastAttemptTs: '2026-09-01T00:00:00Z' }],
    heartbeat: hb('jobs'),
} as unknown as JobsStats;

const text = serializeMetrics({
    uptimeS: 3600.7, heartbeats: [hb('main'), hb('collector')],
    collector, ingest, jobs,
});

console.log('the exposition contract:\n');
has(text, '# TYPE rscanvas_up gauge', 'every family carries its TYPE header');
has(text, 'rscanvas_uptime_seconds 3601', 'uptime rounds to whole seconds');
has(text, 'rscanvas_heartbeat_worst_gap_ms{thread="main"} 12.5', 'heartbeats are labelled per thread');
has(text, 'rscanvas_poll_failures_total{kind="all"} 7', 'the failure total keeps its historic meaning');
has(text, 'rscanvas_poll_failures_total{kind="auth"} 2', 'and the per-kind split rides the same family (E5)');
has(text, 'rscanvas_poll_skipped_no_slot_total 0',
    'skippedNoSlot is exported - the one honest counter of the starvation finding');
has(text, 'rscanvas_poll_oldest_in_flight_ms 220', 'the leaked-slot detector is scrapeable (E1)');
has(text, 'rscanvas_datagrams_shed_total 900', 'the never-drop ledger\'s debit side');
has(text, 'rscanvas_job_consecutive_failures{job="alerts:scan"} 0', 'per-job health, labelled');
has(text, 'rscanvas_notify_trailing_failures{channel="email"} 96',
    'configured-and-dead is a number on a graph now (E6)');
has(text, '# EOF', 'the terminator OpenMetrics parsers require');

{
    const empty = serializeMetrics({ uptimeS: 5, heartbeats: [], collector: null, ingest: null, jobs: null });
    has(empty, 'rscanvas_worker_reporting{thread="collector"} 0',
        'a silent worker reads as NOT REPORTING, never as zeros pretending to be measurements');
    if (!empty.includes('rscanvas_polls_total')) {
        ok('and its families are absent rather than fabricated');
    } else bad('fabricated collector metrics for a silent worker');
}
{
    const quoted = serializeMetrics({
        uptimeS: 1, heartbeats: [], collector: null, ingest: null,
        jobs: { ...(jobs as object), notifyChannels: [{ channel: 'we"ird', trailingFailures: 1, lastDeliveredTs: null, lastAttemptTs: 'x' }] } as unknown as JobsStats,
    });
    has(quoted, 'channel="we\\"ird"', 'label values escape quotes - a channel name cannot break a scrape');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
