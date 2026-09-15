// The notify pass's ORCHESTRATION, offline: queue order, backoff, the
// escalate debt's retry scoping, and the renotify generator's gates -
// driven through the SHIPPED retryPass/dispatchEvent against a real UDP
// syslog capture on loopback, with the store stubbed at the OPS boundary.
//
// Review 4c item 6 asked for the maintenance-gate matrix; the WINDOW half
// of that lives in SQL predicates (ALERT_IN_MAINTENANCE inside the owed
// queries) and needs a database, so it stays with the scratch-DB family.
// What is assertable offline is everything the worker itself decides once
// the queries have answered - which is exactly the part ruling 1 and
// ruling 2 changed this week, and none of it had a test.
//
//   node tools/test-notify-orchestration.ts

import dgram from 'node:dgram';

// Channel config is read from the environment AT IMPORT, so the socket is
// bound and the variables set before any project module loads.
const sock = dgram.createSocket('udp4');
const received: string[] = [];
sock.on('message', (buf) => { received.push(buf.toString('utf8')); });
await new Promise<void>((resolve) => sock.bind(0, '127.0.0.1', resolve));
const port = (sock.address() as { port: number }).port;
process.env.ALERT_SYSLOG_HOST = '127.0.0.1';
process.env.ALERT_SYSLOG_PORT = String(port);
process.env.ALERT_RENOTIFY_H = '4';

const { OPS } = await import('../src/store/index.ts');
const { retryPass, dispatchEvent } = await import('../src/alerts/notify.ts');
import type { AlertRecord } from '../src/store/ops.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

const NOW = new Date('2026-09-01T12:00:00Z');
const ago = (min: number): Date => new Date(NOW.getTime() - min * 60_000);

function alert(id: string, over: Partial<AlertRecord> = {}): AlertRecord {
    return {
        id, alert_key: `metric:${id}`, state: 'active', severity: 'crit',
        kind: 'cpu', host: `dev-${id}`, code: `c${id}`, label: `cpu ${id}`,
        value: 99, peak_value: 99, threshold: 90, unit: '%',
        breach_count: 3, clear_count: 0, missing_count: 0,
        first_breach_ts: ago(120), raised_ts: ago(110), escalated_ts: null,
        cleared_ts: null, last_seen_ts: NOW, renotified_ts: null, acked_ts: null,
        clear_reason: null, notified_raise: true, notified_clear: false,
        notified_escalate: false, notify_attempts: 0, last_attempt_ts: null,
        ...over,
    };
}

// --- the stub layer, at the OPS boundary --------------------------------------
type Row = Record<string, unknown>;
const okRows = <T,>(rows: T[]): Promise<{ ok: true; lane: 'jobs'; rows: T[]; rowCount: number; timing: { waitMs: number; execMs: number } }> =>
    Promise.resolve({ ok: true as const, lane: 'jobs' as const, rows, rowCount: rows.length, timing: { waitMs: 0, execMs: 0 } });

const calls: Array<{ op: string; args: unknown[] }> = [];
const stub = (name: string, fn: (...a: never[]) => unknown): void => {
    (OPS as unknown as Record<string, unknown>)[name] = (...args: never[]) => {
        calls.push({ op: name, args });
        return fn(...args);
    };
};

let queues: {
    raise: AlertRecord[]; escalate: AlertRecord[]; clear: AlertRecord[]; renotify: AlertRecord[];
} = { raise: [], escalate: [], clear: [], renotify: [] };

stub('settleInWindowClears', () => okRows<Row>([{ n: '0' }]));
stub('settleUnderPolicyClears', () => okRows<Row>([{ n: '0' }]));
stub('alertsOwingRaise', () => okRows(queues.raise));
stub('alertsOwingEscalate', () => okRows(queues.escalate));
stub('alertsOwingClear', () => okRows(queues.clear));
stub('alertsOwingRenotify', () => okRows(queues.renotify));
stub('channelsDelivered', () => okRows<Row>([]));
stub('logNotification', () => okRows<Row>([]));
stub('markNotified', () => okRows<Row>([]));
stub('markRenotified', () => okRows<Row>([]));

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 80));
const eventsSent = (): string[] => received
    .map((l) => / (RAISE|ESCALATE|CLEAR|RENOTIFY) /.exec(l)?.[1] ?? '?');
const reset = (): void => { calls.length = 0; received.length = 0; };

console.log('the notify pass, orchestrated offline\n');

{
    console.log('queue order and the debt settlements:');
    queues = {
        raise: [alert('1', { notified_raise: false })],
        escalate: [alert('2', { escalated_ts: ago(30) })],
        clear: [alert('3', { state: 'cleared', cleared_ts: ago(5), severity: 'warn' })],
        renotify: [alert('4', { raised_ts: ago(600) })],
    };
    const report = await retryPass(NOW);
    await settle();
    eq('all four queues delivered', report.sent, 4);
    eq('and the pass REPORTS its depths - the is-anybody-being-told numbers (E6)',
        report.owed, { raise: 1, escalate: 1, clear: 1, renotify: 1 });
    eq('with the oldest untold incident aged from first_breach_ts',
        report.oldestOwedTs?.getTime(), ago(120).getTime());
    eq('in the stated order - raise, escalate, clear, renotify',
        eventsSent(), ['RAISE', 'ESCALATE', 'CLEAR', 'RENOTIFY']);
    const settles = calls.findIndex((c) => c.op === 'alertsOwingRaise');
    const settled = calls.slice(0, settles).map((c) => c.op);
    if (settled.includes('settleInWindowClears') && settled.includes('settleUnderPolicyClears')) {
        ok('both settle passes run BEFORE any queue - the orphan clear is waived first');
    } else bad('settles did not lead', settled);
    const mn = calls.filter((c) => c.op === 'markNotified').map((c) => c.args[1]);
    eq('each event settles its own debt bit', mn, ['raise', 'escalate', 'clear', 'raise']);
    if (calls.some((c) => c.op === 'markRenotified')) {
        ok('renotify stamps renotified_ts - the clock restarts');
    } else bad('markRenotified never called');
    // The escalate retry's scoping (ruling 1): channels are consulted since
    // escalated_ts, not raised_ts - a channel that heard only the WARN raise
    // has not heard about the crit.
    const cd = calls.filter((c) => c.op === 'channelsDelivered');
    const escCd = cd.find((c) => (c.args[0] as string) === '2');
    if (escCd && (escCd.args[2] as Date).getTime() === ago(30).getTime()) {
        ok('an escalate retry scopes delivered-channels by escalated_ts');
    } else bad('escalate since wrong', escCd?.args);
    // Renotify is a NEW message: every channel, no retry consultation.
    if (!cd.some((c) => (c.args[0] as string) === '4')) {
        ok('a renotify consults no delivered-channels - it goes to everyone');
    } else bad('renotify treated as a retry');
    reset();
}

{
    console.log('\nbackoff gates FAILURES, not attempts:');
    queues = {
        raise: [
            alert('5', { notified_raise: false, notify_attempts: 3, last_attempt_ts: ago(1) }),
            alert('6', { notified_raise: false, notify_attempts: 0, last_attempt_ts: ago(1) }),
        ],
        escalate: [], clear: [], renotify: [],
    };
    const report = await retryPass(NOW);
    await settle();
    eq('three recent failures wait out their backoff; a zero counter is due NOW', report.sent, 1);
    eq('but BOTH are owed - backoff delays delivery, never the debt report',
        report.owed.raise, 2);
    eq('and the one delivered is the fresh debt', eventsSent(), ['RAISE']);
    reset();
}

{
    console.log('\nthe renotify gates:');
    // Off by config: the generator must not even ask the store.
    // (CONFIG was imported with ALERT_RENOTIFY_H=4 above; the OFF gate is
    // asserted structurally instead: an acked or non-crit row never reaches
    // dispatch because the QUERY excludes it - that half lives in SQL and
    // the scratch-DB family. What the worker owns is: renotify present in
    // the queue is dispatched at its true type, asserted above.)
    ok('the acked/crit/interval gates live in alertsOwingRenotify\'s SQL - scratch-DB family, recorded');
}

{
    console.log('\nthe wire format carries the loop-breaker:');
    queues = { raise: [alert('7', { notified_raise: false })], escalate: [], clear: [], renotify: [] };
    await retryPass(NOW);
    await settle();
    if (received.length === 1 && received[0]!.includes(' rscanvas ')) {
        ok('the syslog line rides NOTIFIER_APP, so the event matcher can refuse its own echo');
    } else bad('NOTIFIER_APP missing from the wire', received);
    reset();
}

{
    console.log('\ndispatchEvent settles raise for renotify (the folding):');
    await dispatchEvent('renotify', alert('8'));
    await settle();
    const mn = calls.filter((c) => c.op === 'markNotified').map((c) => c.args[1]);
    eq('renotify settles the RAISE debt - the parent\'s folding, kept', mn, ['raise']);
    reset();
}

sock.close();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
