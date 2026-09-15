// Drive logins against the running server and watch the main thread.
//
// BUILD-PLAN slice 2, done-when criterion 3:
//
//   "crypto.scrypt is async and the login path costs no heartbeat gap. Drive
//    repeated failed logins under load and watch the main thread: this is the
//    defect found in all four parent apps and it must not be reproduced here."
//
// tools/scrypt-blocking.ts measures the crypto in isolation. This measures the
// whole path - HTTP, session lookup, database, scrypt - on the real server.
//
//   node tools/login-load.ts
//
// A note on driving FAILED logins specifically. The per-IP limiter locks out
// after 5 failures for a minute, so a flood of failures from one host becomes a
// flood of cheap 429s and stops exercising scrypt after the fifth attempt.
// That is the limiter working, and it is also why failures alone cannot prove
// the point. So this drives both: failures until the limiter engages (which is
// itself checked), and then successful logins, which are NOT rate limited and
// cost a full scrypt verification each. The successful path is the one an
// attacker cannot be locked out of and therefore the one that must not block.

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ROUNDS = Number(process.env.ROUNDS || 60);
const CONCURRENCY = Number(process.env.CONCURRENCY || 8);

interface HealthThread { thread: string; worstGapMs: number; overThresholdCount: number }

async function health(cookie: string): Promise<{ threads: HealthThread[]; worst: number }> {
    const res = await fetch(`${BASE}/api/health`, { headers: { cookie } });
    const body = await res.json() as {
        heartbeat: { threads: HealthThread[]; worstGapMsAcrossThreads: number };
    };
    return { threads: body.heartbeat.threads, worst: body.heartbeat.worstGapMsAcrossThreads };
}

async function login(username: string, password: string): Promise<{ status: number; cookie: string | null }> {
    const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const setCookie = res.headers.get('set-cookie');
    return { status: res.status, cookie: setCookie ? (setCookie.split(';')[0] ?? null) : null };
}

async function main(): Promise<void> {
    if (!ADMIN_PASSWORD) {
        console.error('ADMIN_PASSWORD must be set');
        process.exit(2);
    }

    const first = await login(ADMIN, ADMIN_PASSWORD);
    if (first.status !== 200 || !first.cookie) {
        console.error(`could not sign in to read health: ${first.status}`);
        process.exit(1);
    }
    const cookie = first.cookie;

    const before = await health(cookie);
    console.log('login load');
    console.log(`  ${BASE}, ${ROUNDS} logins at concurrency ${CONCURRENCY}`);
    console.log(`  heartbeat worst gap before: ${before.worst}ms`);
    console.log('');

    // --- failed logins, until the limiter engages ---------------------------
    let failed = 0;
    let limited = 0;
    for (let i = 0; i < 12; i++) {
        const r = await login(ADMIN, `wrong-password-${i}`);
        if (r.status === 401) failed++;
        else if (r.status === 429) limited++;
    }
    console.log(`  failed logins: ${failed} rejected, ${limited} rate limited`);
    if (limited === 0) {
        console.error('  FAIL the per-IP limiter never engaged over 12 failures');
        process.exit(1);
    }

    // Wait out the lockout so successful logins are not refused.
    console.log('  waiting out the 60s lockout');
    await new Promise((r) => setTimeout(r, 62_000));

    // --- successful logins, the path that cannot be rate limited ------------
    const t0 = performance.now();
    const latencies: number[] = [];
    let ok = 0;
    let other = 0;

    for (let done = 0; done < ROUNDS; done += CONCURRENCY) {
        const batch = Math.min(CONCURRENCY, ROUNDS - done);
        const results = await Promise.all(
            Array.from({ length: batch }, async () => {
                const t = performance.now();
                const r = await login(ADMIN, ADMIN_PASSWORD);
                return { ms: performance.now() - t, status: r.status };
            }),
        );
        for (const r of results) {
            latencies.push(r.ms);
            if (r.status === 200) ok++; else other++;
        }
    }
    const wallMs = performance.now() - t0;

    // The heartbeat is cumulative, so give the server a moment to record any
    // late tick before reading it. The same microtask-before-timer trap that
    // made tools/scrypt-blocking.ts report 0ms for a 226ms stall.
    await new Promise((r) => setTimeout(r, 200));
    const after = await health(cookie);

    latencies.sort((a, b) => a - b);
    const at = (p: number): number => latencies[Math.min(latencies.length - 1, Math.ceil(p / 100 * latencies.length) - 1)] as number;

    console.log('');
    console.log(`  successful logins ${ok}, other ${other}`);
    console.log(`  wall clock        ${wallMs.toFixed(0)}ms`);
    console.log(`  rate              ${(ok / (wallMs / 1000)).toFixed(1)} logins/s`);
    console.log(`  latency p50       ${at(50).toFixed(1)}ms`);
    console.log(`  latency p99       ${at(99).toFixed(1)}ms`);
    console.log('');
    console.log('  heartbeat, per thread, cumulative since server start:');
    for (const t of after.threads) {
        console.log(`    ${t.thread.padEnd(8)} worst ${String(t.worstGapMs).padStart(6)}ms, ${t.overThresholdCount} over threshold`);
    }

    const failures: string[] = [];
    for (const t of after.threads) {
        if (t.overThresholdCount > 0) {
            failures.push(`thread ${t.thread} exceeded the 50ms threshold ${t.overThresholdCount} times`);
        }
    }
    if (ok === 0) failures.push('no login succeeded, so the expensive path was never driven');

    console.log('');
    if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL - ${f}`);
        process.exit(1);
    }
    console.log(`PASS - ${ok} logins, each a full scrypt verification, and no thread lost the event loop for 50ms`);
    console.log(`       worst gap across all threads: ${after.worst}ms`);
}

main().catch((err) => {
    console.error('login load failed:', err);
    process.exit(1);
});
