// Print /api/health as a readable summary.
//
//   ADMIN_PASSWORD=... node tools/report-health.ts
//
// Exists because reading it with an inline `node -e` over ssh has now broken
// four separate times on quoting - three levels of shell between here and the
// lab, each with its own opinion about single quotes. SESSION-NOTES records the
// same lesson from the spike ("everything now pipes a script file"); this is
// that lesson applied to the reporting side.

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

interface Thread {
    thread: string; worstGapMs: number; p50GapMs: number; p99GapMs: number;
    overThresholdCount: number; ticks: number;
}

async function main(): Promise<void> {
    let cookie = '';
    if (ADMIN_PASSWORD) {
        const li = await fetch(`${BASE}/api/login`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ username: ADMIN, password: ADMIN_PASSWORD }),
        });
        const sc = li.headers.get('set-cookie');
        if (sc) cookie = sc.split(';')[0] as string;
    }

    const res = await fetch(`${BASE}/api/health`, { headers: cookie ? { cookie } : {} });
    if (res.status === 401) { console.error('unauthenticated - set ADMIN_PASSWORD'); process.exit(2); }
    const h = await res.json() as Record<string, unknown>;

    const hbs = h.heartbeat as { thresholdMs: number; threads: Thread[]; anyThreadOverThreshold: boolean };
    console.log(`heartbeat, threshold ${hbs.thresholdMs}ms`);
    console.log('  thread      ticks     worst    p50    p99  over');
    for (const t of hbs.threads) {
        console.log(
            `  ${t.thread.padEnd(10)} ${String(t.ticks).padStart(7)} `
            + `${String(t.worstGapMs).padStart(8)}ms ${String(t.p50GapMs).padStart(5)} `
            + `${String(t.p99GapMs).padStart(5)}  ${String(t.overThresholdCount).padStart(4)}`,
        );
    }
    console.log(`  any thread over threshold: ${hbs.anyThreadOverThreshold}`);

    const c = h.collector as Record<string, unknown> | undefined;
    if (c && c.polls !== undefined) {
        console.log('\ncollector');
        console.log(`  polls ${c.polls}, failures ${c.failures}, discovered ${c.discovered}`);
        console.log(`  samples written ${Number(c.samplesWritten).toLocaleString()}, write failures ${c.writeFailures}`);
        console.log(`  in flight ${c.inFlight}/${c.concurrency} (down ${c.inFlightDown}/${c.downConcurrency}), skipped ${c.skippedNoSlot}`);
        console.log(`  poll lag  p50 ${c.pollLagP50Ms}ms  p95 ${c.pollLagP95Ms}ms  max ${c.pollLagMaxMs}ms`);
        console.log(`  poll time p50 ${c.pollP50Ms}ms  p95 ${c.pollP95Ms}ms`);
    }

    const i = h.ingest as Record<string, unknown> | undefined;
    if (i && i.received !== undefined) {
        const k = i.kernel as Record<string, unknown>;
        console.log('\ningest');
        console.log(`  received ${Number(i.received).toLocaleString()}, written ${Number(i.written).toLocaleString()}, queued ${i.queued}`);
        console.log(`  shed by us ${i.shedByUs}, kernel drops ${k.syslogDrops}, rcvbuf errors ${k.systemRcvbufErrors}`);
        console.log(`  flush p50 ${i.flushP50Ms}ms p99 ${i.flushP99Ms}ms max ${i.flushMaxMs}ms`);
    }

    const lanes = h.lanes as Array<Record<string, unknown>>;
    console.log('\nlanes');
    for (const l of lanes) {
        if (Number(l.samples) === 0) continue;
        console.log(`  ${String(l.lane).padEnd(12)} n=${String(l.samples).padStart(6)} `
            + `busy=${l.busy} timeouts=${l.statementTimeouts} `
            + `wait p99 ${l.waitP99Ms}ms  exec p99 ${l.execP99Ms}ms`);
    }

    const m = h.memory as Record<string, unknown> | undefined;
    if (m) console.log(`\nrss ${(Number(m.rssBytes) / 1048576).toFixed(1)}MB`);
}

main().catch((err) => { console.error('report-health failed:', err); process.exit(1); });
