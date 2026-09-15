// Slice 2 done-when criteria, exercised over the real HTTP routes.
//
//   node tools/auth-test.ts
//
// Requires a running server with ADMIN_PASSWORD set, and it creates and deletes
// test accounts, so point it at a development instance.
//
// Cookies are handled by hand rather than with a jar library: there is one
// cookie and the point is to check exactly what is sent back.

import crypto from 'node:crypto';
import { OPS, closeAll } from '../src/store/index.ts';

const BASE = process.env.BASE_URL || 'http://localhost:8080';
const ADMIN = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

let pass = 0;
let fail = 0;

function check(ok: boolean, label: string, detail?: unknown): void {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail)); }
}

interface Res { status: number; body: Record<string, unknown>; cookie: string | null }

async function call(
    method: string, path: string, opts: { cookie?: string | null; body?: unknown } = {},
): Promise<Res> {
    const headers: Record<string, string> = {};
    if (opts.cookie) headers.cookie = opts.cookie;
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
    });
    const setCookie = res.headers.get('set-cookie');
    const cookie = setCookie ? (setCookie.split(';')[0] ?? null) : null;
    let body: Record<string, unknown> = {};
    try { body = await res.json() as Record<string, unknown>; } catch { /* empty body */ }
    return { status: res.status, body, cookie };
}

const rand = (): string => crypto.randomBytes(4).toString('hex');

async function main(): Promise<void> {
    if (!ADMIN_PASSWORD) {
        console.error('ADMIN_PASSWORD must be set to the running server\'s admin password');
        process.exit(2);
    }
    console.log(`auth against ${BASE}\n`);

    // --- nothing is served unauthenticated ---------------------------------
    console.log('unauthenticated access');
    const anonHealth = await call('GET', '/api/health');
    check(anonHealth.status === 401, 'GET /api/health is 401 without a session', anonHealth.status);
    const anonSearch = await call('GET', '/api/syslog/search?hours=1&host=sw-0001');
    check(anonSearch.status === 401, 'GET /api/syslog/search is 401 without a session', anonSearch.status);
    const anonUsers = await call('GET', '/api/users');
    check(anonUsers.status === 401, 'GET /api/users is 401 without a session', anonUsers.status);
    const live = await call('GET', '/api/health/live');
    check(live.status === 200, '/api/health/live is reachable for orchestration', live.status);
    check(Object.keys(live.body).length === 1 && live.body.ok === true,
        '/api/health/live leaks nothing but {ok}', live.body);

    // --- login --------------------------------------------------------------
    console.log('\nlogin');
    const bad = await call('POST', '/api/login', { body: { username: ADMIN, password: 'wrong-password' } });
    check(bad.status === 401, 'a wrong password is 401', bad.status);
    check(bad.cookie === null, 'a failed login sets no cookie');

    const noSuch = await call('POST', '/api/login', { body: { username: `ghost-${rand()}`, password: 'x' } });
    check(noSuch.status === 401 && noSuch.body.detail === bad.body.detail,
        'an unknown user and a wrong password give the identical message', {
            unknown: noSuch.body.detail, wrong: bad.body.detail,
        });

    const admin = await call('POST', '/api/login', { body: { username: ADMIN, password: ADMIN_PASSWORD } });
    check(admin.status === 200, 'admin can sign in', admin.status);
    check(admin.cookie !== null, 'login sets a session cookie');
    const adminCookie = admin.cookie as string;

    const rawSetCookie = adminCookie;
    check(/^rscanvas_session=/.test(rawSetCookie), 'the cookie is namespaced', rawSetCookie.slice(0, 20));

    const meRes = await call('GET', '/api/me', { cookie: adminCookie });
    check(meRes.status === 200 && (meRes.body.user as { role?: string })?.role === 'admin',
        '/api/me reports the admin role', meRes.body);

    // --- sessions are hashed at rest ---------------------------------------
    console.log('\nsessions');
    const token = adminCookie.split('=')[1] as string;
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const byHash = await OPS.findSession(tokenHash);
    check(byHash.ok && byHash.rows.length === 1, 'the session is found by sha256(token)');
    const byRaw = await OPS.findSession(token);
    check(byRaw.ok && byRaw.rows.length === 0, 'the RAW token is not stored - a dump hands over no live sessions');

    const authedHealth = await call('GET', '/api/health', { cookie: adminCookie });
    check(authedHealth.status === 200, 'health works with a session', authedHealth.status);

    // --- roles: a viewer cannot mutate anything ----------------------------
    console.log('\nroles');
    const viewer = `v-${rand()}`;
    const viewerPw = 'viewer-password-1';
    const made = await call('POST', '/api/users', {
        cookie: adminCookie, body: { username: viewer, password: viewerPw, role: 'viewer' },
    });
    check(made.status === 201, 'admin can create a viewer', made.body);

    const vLogin = await call('POST', '/api/login', { body: { username: viewer, password: viewerPw } });
    check(vLogin.status === 200, 'the viewer can sign in', vLogin.status);
    const vCookie = vLogin.cookie as string;

    const vRead = await call('GET', '/api/syslog/search?hours=1&host=sw-0001&count=0&limit=1', { cookie: vCookie });
    check(vRead.status === 200, 'a viewer CAN read syslog', vRead.status);

    const vList = await call('GET', '/api/users', { cookie: vCookie });
    check(vList.status === 403, 'a viewer cannot list users', vList.status);
    check(vList.body.reason === 'forbidden' && typeof vList.body.action === 'string',
        'the denial names the action it refused', vList.body);

    const vCreate = await call('POST', '/api/users', {
        cookie: vCookie, body: { username: `x-${rand()}`, password: 'password12', role: 'admin' },
    });
    check(vCreate.status === 403, 'a viewer cannot create a user', vCreate.status);

    const vDelete = await call('DELETE', `/api/users/${ADMIN}`, { cookie: vCookie });
    check(vDelete.status === 403, 'a viewer cannot delete the admin', vDelete.status);

    const vRole = await call('POST', `/api/users/${viewer}/role`, {
        cookie: vCookie, body: { role: 'admin' },
    });
    check(vRole.status === 403, 'a viewer cannot promote themselves', vRole.status);

    const vAudit = await call('GET', '/api/audit', { cookie: vCookie });
    check(vAudit.status === 403, 'a viewer cannot read the audit trail', vAudit.status);

    // --- the last-admin guard ----------------------------------------------
    console.log('\nfoot-guns');
    const selfDelete = await call('DELETE', `/api/users/${ADMIN}`, { cookie: adminCookie });
    check(selfDelete.status === 403, 'an admin cannot delete their own account', selfDelete.status);
    const selfDemote = await call('POST', `/api/users/${ADMIN}/role`, {
        cookie: adminCookie, body: { role: 'viewer' },
    });
    check(selfDemote.status === 403, 'an admin cannot demote themselves', selfDemote.status);

    // --- password change revokes other sessions ----------------------------
    console.log('\npassword change revokes sessions');
    const vSecond = await call('POST', '/api/login', { body: { username: viewer, password: viewerPw } });
    const vSecondCookie = vSecond.cookie as string;
    check(vSecond.status === 200 && vSecondCookie !== vCookie, 'the viewer has a second, distinct session');

    const changed = await call('POST', `/api/users/${viewer}/password`, {
        cookie: vSecondCookie,
        body: { currentPassword: viewerPw, newPassword: 'viewer-password-2' },
    });
    check(changed.status === 200, 'the viewer can change their own password', changed.body);
    check(Number(changed.body.sessionsRevoked) >= 1, 'the change revoked at least one other session', changed.body);

    const oldSession = await call('GET', '/api/me', { cookie: vCookie });
    check(oldSession.body.authenticated === false, 'the OTHER session is dead', oldSession.body);
    const keptSession = await call('GET', '/api/me', { cookie: vSecondCookie });
    check(keptSession.body.authenticated === true, 'the session that made the change survives', keptSession.body);

    const wrongCurrent = await call('POST', `/api/users/${viewer}/password`, {
        cookie: vSecondCookie, body: { currentPassword: 'not-it', newPassword: 'another-password' },
    });
    check(wrongCurrent.status === 403, 'changing your own password requires the current one', wrongCurrent.status);

    // --- audit --------------------------------------------------------------
    console.log('\naudit');
    const auditRes = await call('GET', '/api/audit?limit=50', { cookie: adminCookie });
    check(auditRes.status === 200, 'an admin can read the audit trail', auditRes.status);
    const entries = (auditRes.body.entries ?? []) as Array<{ actor: string; action: string; target: string | null }>;

    const created = entries.find((e) => e.action === 'user.create' && e.target === viewer);
    check(created !== undefined && created.actor === ADMIN,
        'the audit records WHO created the viewer', created);
    const pwChange = entries.find((e) => e.action === 'user.setPassword' && e.target === viewer);
    check(pwChange !== undefined && pwChange.actor === viewer,
        'the audit records the password change and its actor', pwChange);
    const failedLogin = entries.find((e) => e.action === 'login.failed');
    check(failedLogin !== undefined, 'failed logins are audited', failedLogin);

    // --- logout -------------------------------------------------------------
    console.log('\nlogout');
    const out = await call('POST', '/api/logout', { cookie: vSecondCookie });
    check(out.status === 200, 'logout succeeds', out.status);
    const afterOut = await call('GET', '/api/me', { cookie: vSecondCookie });
    check(afterOut.body.authenticated === false, 'the session is dead after logout', afterOut.body);

    // --- cleanup ------------------------------------------------------------
    const removed = await call('DELETE', `/api/users/${viewer}`, { cookie: adminCookie });
    check(removed.status === 200, 'admin can delete the test viewer', removed.body);
    const sessionsAfter = await OPS.findSession(
        crypto.createHash('sha256').update(vSecondCookie.split('=')[1] as string).digest('hex'),
    );
    check(sessionsAfter.ok && sessionsAfter.rows.length === 0,
        'deleting a user leaves no sessions behind (ON DELETE CASCADE)');

    await closeAll();
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
    console.error('auth test failed:', err);
    void closeAll();
    process.exit(1);
});
