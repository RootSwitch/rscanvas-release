// The thin UI's whole stack, over real HTTP against a real spawned server:
// shell -> login -> session cookie -> role enforcement -> store read.
//
// This is the measurement the UI exists to produce: the frontend was the one
// triage category nobody had tested ("neither free nor a store rewrite"), and
// this proves the layers it depends on - static serving, auth, routing,
// interactive-lane reads - compose end to end before anything bigger is built
// on them.
//
// The negative cases carry the weight, as usual: the shell must serve WITHOUT
// a session but contain NO data; the data routes must refuse without one; a
// viewer must read alerts but must NOT create users.

import { spawn } from 'node:child_process';
import { internalUnsafeLane as onLane, closeAll, OPS } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';
import { assertDestructiveTarget } from '../src/safety.ts';
import { hashPassword } from '../src/auth/password.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'uiadmin';
const ADMIN_PW = 'ui-test-password-1';
const VIEWER = 'uiviewer';
const VIEWER_PW = 'ui-viewer-password-1';
const LABEL = 'ui-probe link down';

const sql = async (text: string, values: unknown[] = []): Promise<Array<Record<string, unknown>>> => {
    const r = await onLane<Record<string, unknown>>('jobs', async (c) => {
        const q = await c.query<Record<string, unknown>>(text, values);
        return { rows: q.rows, rowCount: q.rows.length };
    });
    if (!r.ok) throw new Error(`lane refused (${r.reason})`);
    return r.rows;
};

const cookieOf = (res: Response): string =>
    res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

async function login(username: string, password: string): Promise<{ status: number; cookie: string }> {
    const res = await fetch(`${BASE}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    await res.text();
    return { status: res.status, cookie: cookieOf(res) };
}

async function main(): Promise<void> {
    assertDestructiveTarget('test-ui', CONFIG.databaseUrl);
    console.log('the thin UI stack: shell, session, roles, reads\n');

    // ONLY THIS TEST'S OWN ROWS. The first version wiped the whole users
    // table for a deterministic env bootstrap - and the demo instance shares
    // this database, so every test run silently deleted the demo's admin and
    // the next person to open the page found their login dead. The admin is
    // now inserted directly instead of via bootstrapFromEnv (which only runs
    // on an EMPTY users table), so the test needs no clean slate and other
    // accounts on this database are none of its business.
    await sql('DELETE FROM users WHERE username IN ($1, $2)', [ADMIN, VIEWER]);
    await sql('DELETE FROM alerts');
    await sql('INSERT INTO users (username, password, role) VALUES ($1, $2, $3)',
        [ADMIN, await hashPassword(ADMIN_PW), 'admin']);

    // One device carrying one crit alert, planted directly - the scan's own
    // correctness has its own tests; this one is about the HTTP layer.
    const dev = await OPS.upsertDevice('ui-probe', '127.0.0.1', 39161, '2c', 'SNMP_COMMUNITY', 30);
    if (!dev.ok) throw new Error('device fixture failed');
    await OPS.recordDevicePoll(dev.rows[0]!.id, true, 'ui-probe', null, null, false, null);
    const ins = await OPS.insertAlert({
        alertKey: 'if:UIPROBE:down', state: 'active', severity: 'crit', kind: 'if-down',
        host: 'ui-probe', code: 'UIPROBE', label: LABEL, value: null, peakValue: null,
        threshold: null, unit: '', breachCount: 2,
        firstBreachTs: new Date(), raisedTs: new Date(), lastSeenTs: new Date(),
    });
    if (!ins.ok) throw new Error('alert fixture failed');

    const app = spawn(process.execPath, ['src/main.ts'], {
        env: {
            ...process.env,
            HTTP_PORT: String(PORT), SYSLOG_PORT: '25514', TRAP_PORT: '25162',
            COLLECTOR_ENABLED: '0', JOBS_ENABLED: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let appLog = '';
    app.stdout.on('data', (c: Buffer) => { appLog += c.toString(); });
    app.stderr.on('data', (c: Buffer) => { appLog += c.toString(); });

    try {
        // Wait for the port, bounded.
        let up = false;
        for (let i = 0; i < 100 && !up; i++) {
            await new Promise((r) => setTimeout(r, 200));
            up = await fetch(`${BASE}/api/health/live`).then((r) => r.ok).catch(() => false);
        }
        if (!up) throw new Error(`the app never came up:\n${appLog.slice(-2000)}`);

        // --- the shell, sessionless and data-free ----------------------------
        const shell = await fetch(BASE);
        const html = await shell.text();
        if (shell.ok && (shell.headers.get('content-type') ?? '').includes('text/html')
            && html.includes('RSCanvas')) {
            ok('the shell serves without a session');
        } else {
            bad('the shell did not serve', shell.status);
        }
        if (!html.includes(LABEL) && !html.includes('ui-probe')) {
            ok('and contains NO data - the alert exists only behind the session');
        } else {
            bad('THE SHELL LEAKED DATA');
        }
        for (const f of ['/app.js', '/themes.js']) {
            const js = await fetch(`${BASE}${f}`);
            await js.text();
            if (js.ok && (js.headers.get('content-type') ?? '').includes('javascript')) {
                ok(`${f} serves with its content type`);
            } else {
                bad(`${f} did not serve`, js.status);
            }
        }
        const sneaky = await fetch(`${BASE}/..%2fpackage.json`);
        if (sneaky.status === 404) {
            ok('a traversal-shaped path is a 404 - the whitelist has no directory to walk');
        } else {
            bad('a traversal-shaped path returned something', sneaky.status);
        }

        // --- the gate ---------------------------------------------------------
        for (const p of ['/api/alerts', '/api/devices']) {
            const res = await fetch(`${BASE}${p}`);
            await res.text();
            if (res.status === 401) ok(`${p} without a session is 401`);
            else bad(`${p} served without a session`, res.status);
        }
        const wrong = await login(ADMIN, 'not-the-password');
        if (wrong.status === 401 && wrong.cookie === '') {
            ok('a wrong password is 401 with no cookie');
        } else {
            bad('a wrong password produced something', JSON.stringify(wrong));
        }

        // --- the session ------------------------------------------------------
        const admin = await login(ADMIN, ADMIN_PW);
        if (admin.status === 200 && admin.cookie !== '') {
            ok('login yields a session cookie');
        } else {
            bad('login failed', JSON.stringify(admin));
        }
        const H = { cookie: admin.cookie };

        const alerts = await fetch(`${BASE}/api/alerts`, { headers: H })
            .then((r) => r.json()) as { ok: boolean; open: Array<{ label: string; severity: string }> };
        if (alerts.ok && alerts.open.some((a) => a.label === LABEL && a.severity === 'crit')) {
            ok('/api/alerts returns the planted crit through the interactive lane');
        } else {
            bad('the alert did not come through', JSON.stringify(alerts).slice(0, 200));
        }
        const devices = await fetch(`${BASE}/api/devices`, { headers: H })
            .then((r) => r.json()) as {
                ok: boolean;
                devices: Array<{ name: string; open_alerts: number; worst: string | null }>;
            };
        const d = devices.devices?.find((x) => x.name === 'ui-probe');
        if (devices.ok && d !== undefined && d.open_alerts === 1 && d.worst === 'crit') {
            ok('/api/devices carries the roster with its alert count and worst severity');
        } else {
            bad('the device row is wrong', JSON.stringify(d));
        }

        // --- roles ------------------------------------------------------------
        const mk = await fetch(`${BASE}/api/users`, {
            method: 'POST',
            headers: { ...H, 'content-type': 'application/json' },
            body: JSON.stringify({ username: VIEWER, password: VIEWER_PW, role: 'viewer' }),
        });
        await mk.text();
        if (mk.status !== 201) throw new Error(`could not create the viewer (${mk.status})`);
        const viewer = await login(VIEWER, VIEWER_PW);
        const VH = { cookie: viewer.cookie };
        const va = await fetch(`${BASE}/api/alerts`, { headers: VH });
        await va.text();
        if (va.status === 200) {
            ok('a viewer reads alerts - the page is for everyone who can sign in');
        } else {
            bad('a viewer cannot read alerts', va.status);
        }
        const vu = await fetch(`${BASE}/api/users`, {
            method: 'POST',
            headers: { ...VH, 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'nope', password: 'x'.repeat(16), role: 'admin' }),
        });
        await vu.text();
        if (vu.status === 403) {
            ok('and a viewer creating a user is 403 - the enforcement is per action, not per login');
        } else {
            bad('a viewer created a user', vu.status);
        }

        // --- the search route, through the grammar ----------------------------
        //
        // The parse itself is pinned offline (test-grammar) and the row sets
        // against the parent (test-engine-differential). What only this test
        // can prove is that a query string survives the HTTP layer intact and
        // that the two things written to be READ - the refusal detail and the
        // zero-result hints - actually reach a client.
        await sql(`INSERT INTO messages (ts, host, app, proto, severity, msg, raw)
                   VALUES (now(), 'ui-probe-sw1', 'sshd', 'udp', 3, 'ui probe disk full', 'x'),
                          (now(), 'ui-probe-sw2', 'bgpd', 'udp', 6, 'ui probe session up', 'x')`);

        const search = async (q: string): Promise<Record<string, unknown>> => {
            const url = `${BASE}/api/syslog/search?hours=1&limit=50`
                + (q === '' ? '' : `&q=${encodeURIComponent(q)}`);
            const res = await fetch(url, { headers: H });
            return { status: res.status, ...(await res.json()) as Record<string, unknown> };
        };

        const byMsg = (r: Record<string, unknown>): string[] =>
            (r.rows as Array<{ msg: string }> | undefined ?? []).map((x) => x.msg).sort();

        const exact = await search('host:ui-probe-sw1');
        if (exact.ok === true && byMsg(exact).join() === 'ui probe disk full') {
            ok('a grammar query survives the URL and returns only the exact host row');
        } else {
            bad('host: through HTTP returned the wrong set', JSON.stringify(byMsg(exact)));
        }

        const sub = await search('host~ui-probe-sw');
        if (sub.ok === true && byMsg(sub).length === 2) {
            ok('host~ returns both, so the two operators are distinguishable end to end');
        } else {
            bad('host~ through HTTP returned the wrong set', JSON.stringify(byMsg(sub)));
        }

        const combined = await search('sev:<=3 host~ui-probe');
        if (combined.ok === true && byMsg(combined).join() === 'ui probe disk full') {
            ok('sev:<=3 with a substring host narrows to the one urgent row');
        } else {
            bad('the combined query was wrong', JSON.stringify(byMsg(combined)));
        }

        // THE GUIDANCE, which is the reason exact-by-default is safe to ship.
        const near = await search('host:ui-probe');
        const hints = (near.hints as string[] | undefined) ?? [];
        if (near.returned === 0 && hints.some((h) => h.includes('host~ui-probe'))) {
            ok('a zero-result exact host: comes back with the host~ hint, not just silence');
        } else {
            bad('the zero-result guidance did not reach the client',
                JSON.stringify({ returned: near.returned, hints }));
        }

        // THE REFUSALS, which have to arrive as text an operator can act on.
        const appSub = await search('app~ssh');
        if (appSub.status === 400 && String(appSub.detail).includes('device filter')) {
            ok('app~ with no device filter is refused, and the refusal says what to add');
        } else {
            bad('the app~ admission rule did not reach the client', JSON.stringify(appSub));
        }

        // THE ip: ADMISSION FLOOR. The indexability premise was verified with
        // EXPLAIN (see buildWhere) and survived; what the floor guards is
        // SELECTIVITY - a /8 matched 73% of the corpus, indistinguishable
        // from no filter, so it must not unlock unindexed free text.
        const wideIpRes = await fetch(
            `${BASE}/api/syslog/search?hours=240&limit=50&q=${encodeURIComponent('timeout ip:10.0.0.0/8')}`,
            { headers: H });
        const wideIpJson = await wideIpRes.json() as Record<string, unknown>;
        const wideIpBody = { status: wideIpRes.status, ...wideIpJson };
        if (wideIpBody.status === 400 && String(wideIpJson.detail).includes('/24 or longer')) {
            ok('a /8 does NOT qualify as a device filter - too wide to bound the scan, and the refusal says the floor');
        } else {
            bad('a /8 unlocked unindexed free text', JSON.stringify(wideIpBody).slice(0, 160));
        }
        const narrowIpRes = await fetch(
            `${BASE}/api/syslog/search?hours=240&limit=50&q=${encodeURIComponent('timeout ip:10.20.1.0/24')}`,
            { headers: H });
        const narrowBody = { status: narrowIpRes.status, ...(await narrowIpRes.json()) as Record<string, unknown> };
        if (narrowBody.status === 200) {
            ok('and a /24 DOES qualify - at the floor, free text outside the trigram window is admitted');
        } else {
            bad('a /24 was refused as a device filter', JSON.stringify(narrowBody).slice(0, 160));
        }

        const badDates = await search('after:2027-01-01 before:2020-01-01');
        if (badDates.status === 400 && String(badDates.detail).includes('narrow')) {
            ok('dates that leave no time refuse and NAME THE WINDOW rather than saying "empty"');
        } else {
            bad('the empty-intersection refusal was wrong', JSON.stringify(badDates));
        }

        // --- logout is real ---------------------------------------------------
        const out = await fetch(`${BASE}/api/logout`, { method: 'POST', headers: H });
        await out.text();
        const after = await fetch(`${BASE}/api/alerts`, { headers: H });
        await after.text();
        if (after.status === 401) {
            ok('after logout the same cookie is 401 - the session died server-side');
        } else {
            bad('a logged-out cookie still works', after.status);
        }
    } finally {
        app.kill('SIGTERM');
        await new Promise((r) => setTimeout(r, 500));
        await sql('DELETE FROM alerts');
        await sql(`DELETE FROM messages WHERE host LIKE 'ui-probe-%'`);
        await sql(`DELETE FROM devices WHERE name = 'ui-probe'`);
        await sql('DELETE FROM users WHERE username IN ($1, $2)', [ADMIN, VIEWER]);
        await closeAll();
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('ui test failed:', err);
    void closeAll();
    process.exit(1);
});
