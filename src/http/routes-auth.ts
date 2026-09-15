// Auth routes: login, logout, whoami, user administration, audit.
//
// Every mutation goes through enforce() and every mutation writes an audit row.
// Those two are the whole difference between this and the shared password the
// suite has: a decision that can be pointed at, and a record of who made it.

import type http from 'node:http';
import * as auth from '../auth/index.ts';
import { isRole, type Principal, type Role } from '../auth/authorize.ts';
import { sendJson, readJsonBody, str, clientIp, inetOrNull, enforce } from './respond.ts';

function fail(res: http.ServerResponse, status: number, detail: string): void {
    sendJson(res, status, { ok: false, detail });
}

export async function login(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const ip = clientIp(req);

    // Checked BEFORE the password is verified. The point of the limiter is to
    // bound how often the expensive path runs, and checking afterwards would
    // let an attacker spend our scrypt budget while locked out.
    if (!auth.loginAllowed(ip)) {
        fail(res, 429, 'Too many failed attempts. Try again in a minute.');
        return;
    }

    let body: Record<string, unknown>;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        fail(res, 400, (err as Error).message);
        return;
    }

    const username = str(body, 'username');
    const password = str(body, 'password');
    const user = await auth.checkLogin(username, password);

    if (!user) {
        auth.recordLoginFailure(ip);
        // One message for every failure mode: no such user, wrong password,
        // disabled account. Saying which would turn this into an account
        // enumeration endpoint, and the timing pad in checkLogin exists to stop
        // the clock saying it either.
        await auth.audit({ kind: 'anonymous' }, 'login.failed', username || null, undefined, inetOrNull(ip));
        fail(res, 401, 'Invalid username or password.');
        return;
    }

    auth.recordLoginSuccess(ip);
    const token = await auth.createSession(
        user.id,
        (req.headers['user-agent'] ?? '').slice(0, 256) || null,
        inetOrNull(ip),
    );
    const principal: Principal = { kind: 'user', id: Number(user.id), username: user.username, role: user.role };
    await auth.audit(principal, 'login.ok', user.username, undefined, inetOrNull(ip));

    sendJson(res, 200, {
        ok: true,
        user: { username: user.username, role: user.role },
    }, { 'set-cookie': auth.sessionCookie(token) });
}

export async function logout(
    req: http.IncomingMessage, res: http.ServerResponse, principal: Principal,
): Promise<void> {
    const token = auth.tokenFromRequest(req);
    await auth.destroySession(token);
    if (principal.kind === 'user') {
        await auth.audit(principal, 'logout', principal.username, undefined, inetOrNull(clientIp(req)));
    }
    sendJson(res, 200, { ok: true }, { 'set-cookie': auth.clearCookie() });
}

export function me(res: http.ServerResponse, principal: Principal): void {
    if (principal.kind !== 'user') {
        sendJson(res, 200, { ok: true, authenticated: false });
        return;
    }
    sendJson(res, 200, {
        ok: true,
        authenticated: true,
        user: { username: principal.username, role: principal.role },
    });
}

export async function listUsers(res: http.ServerResponse, principal: Principal): Promise<void> {
    if (!enforce(res, principal, 'user.read')) return;
    const users = await auth.listUsers();
    sendJson(res, 200, { ok: true, users });
}

export async function createUser(
    req: http.IncomingMessage, res: http.ServerResponse, principal: Principal,
): Promise<void> {
    if (!enforce(res, principal, 'user.create')) return;

    let body: Record<string, unknown>;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        fail(res, 400, (err as Error).message);
        return;
    }

    const roleRaw = str(body, 'role') || 'viewer';
    if (!isRole(roleRaw)) {
        fail(res, 400, 'role must be viewer, operator or admin');
        return;
    }

    try {
        const user = await auth.createUser(str(body, 'username'), str(body, 'password'), roleRaw);
        await auth.audit(principal, 'user.create', user.username, { role: roleRaw }, inetOrNull(clientIp(req)));
        sendJson(res, 201, { ok: true, user: { username: user.username, role: user.role } });
    } catch (err) {
        if (err instanceof auth.AuthError) { fail(res, 400, err.message); return; }
        throw err;
    }
}

export async function deleteUser(
    req: http.IncomingMessage, res: http.ServerResponse, principal: Principal, target: string,
): Promise<void> {
    if (!enforce(res, principal, 'user.delete', { type: 'user', id: target })) return;
    try {
        await auth.deleteUser(target);
        await auth.audit(principal, 'user.delete', target, undefined, inetOrNull(clientIp(req)));
        sendJson(res, 200, { ok: true });
    } catch (err) {
        if (err instanceof auth.AuthError) { fail(res, 400, err.message); return; }
        throw err;
    }
}

export async function setRole(
    req: http.IncomingMessage, res: http.ServerResponse, principal: Principal, target: string,
): Promise<void> {
    if (!enforce(res, principal, 'user.setRole', { type: 'user', id: target })) return;

    let body: Record<string, unknown>;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        fail(res, 400, (err as Error).message);
        return;
    }

    const role = str(body, 'role');
    if (!isRole(role)) { fail(res, 400, 'role must be viewer, operator or admin'); return; }

    try {
        await auth.setUserRole(target, role as Role);
        await auth.audit(principal, 'user.setRole', target, { role }, inetOrNull(clientIp(req)));
        sendJson(res, 200, { ok: true });
    } catch (err) {
        if (err instanceof auth.AuthError) { fail(res, 400, err.message); return; }
        throw err;
    }
}

export async function setPassword(
    req: http.IncomingMessage, res: http.ServerResponse, principal: Principal, target: string,
): Promise<void> {
    const own = principal.kind === 'user' && principal.username === target;
    // Two distinct actions, and which one applies is decided by whose account
    // it is rather than by which role the caller happens to hold. A viewer may
    // change their own password; only an admin may change anyone else's.
    const action = own ? 'user.setPasswordOwn' : 'user.setPasswordAny';
    if (!enforce(res, principal, action, { type: 'user', id: target })) return;

    let body: Record<string, unknown>;
    try {
        body = await readJsonBody(req);
    } catch (err) {
        fail(res, 400, (err as Error).message);
        return;
    }

    // Changing your own password requires the current one. An admin resetting
    // someone else's does not - they are not proving they are that person.
    if (own) {
        const current = str(body, 'currentPassword');
        const check = await auth.checkLogin(target, current);
        if (!check) { fail(res, 403, 'Current password is incorrect.'); return; }
    }

    try {
        // An admin resetting ANOTHER user's password revokes all of that user's
        // sessions. Changing your own keeps the session you are using, so you
        // are not logged out by your own action.
        const exceptToken = own ? auth.tokenFromRequest(req) : null;
        const { sessionsRevoked } = await auth.setUserPassword(target, str(body, 'newPassword'), exceptToken);
        await auth.audit(principal, 'user.setPassword', target, { sessionsRevoked, own }, inetOrNull(clientIp(req)));
        sendJson(res, 200, { ok: true, sessionsRevoked });
    } catch (err) {
        if (err instanceof auth.AuthError) { fail(res, 400, err.message); return; }
        throw err;
    }
}

export async function listAudit(
    res: http.ServerResponse, principal: Principal, params: URLSearchParams,
): Promise<void> {
    if (!enforce(res, principal, 'audit.read')) return;
    const limit = Math.min(Math.max(1, Number(params.get('limit') ?? 100)), 1000);
    const rows = await auth.listAuditRows(limit);
    sendJson(res, 200, { ok: true, entries: rows });
}
