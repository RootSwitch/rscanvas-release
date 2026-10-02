// Accounts, sessions and the login path.
//
// Ported from launchcanvas/server/auth.js, which already had most of this
// right: users, scrypt with the parameters recorded in the stored string,
// sessions stored as sha256 of the token, sliding expiry, per-user session
// revocation on password change, a timing-equalised login path, and per-IP
// login rate limiting with a bounded failure map. What it lacked was roles.
//
// Three deliberate changes:
//
//   1. scrypt is ASYNC (src/auth/password.ts). This is ARCHITECTURE.md rule 4
//      and the whole reason auth is slice 2 rather than later.
//   2. Sessions key on user_id with ON DELETE CASCADE rather than on username,
//      so deleting a user cannot leave a live session behind.
//   3. Every mutation writes an audit row. Attribution is the point of leaving
//      a shared password behind.
//
// SUITE_SECRET appears nowhere. The HMAC token existed only to pass identity
// between separate processes; one application means one session, and the whole
// SSO surface stops existing. That is the strongest security argument for the
// merge and it is discharged by absence.

import crypto from 'node:crypto';
import type http from 'node:http';
import { OPS } from '../store/index.ts';
import { hashPassword, verifyPassword, DUMMY_HASH } from './password.ts';
import { isRole, type Principal, type Role } from './authorize.ts';

const SESSION_TTL_S = 30 * 24 * 3600;      // 30 days, sliding
const SESSION_REFRESH_S = 15 * 24 * 3600;  // refresh when less than this remains

// Namespaced, like the parent's. Cookies ignore ports, so apps on one host
// would clobber each other's sessions with a generic name.
const COOKIE_NAME = 'rscanvas_session';

const USERNAME_RE = /^[A-Za-z0-9._-]{2,32}$/;
const MIN_PASSWORD = 8;

const sha256 = (s: string): string => crypto.createHash('sha256').update(s).digest('hex');

function log(...args: unknown[]): void {
    console.log(new Date().toISOString(), '[auth]', ...args);
}

export class AuthError extends Error {}

// --- users -------------------------------------------------------------------

export interface UserRow {
    id: string;
    username: string;
    role: Role;
    disabled: boolean;
    createdTs: Date;
    lastLoginTs: Date | null;
}

function requireOk<T extends { ok: boolean }>(res: T, what: string): T & { ok: true } {
    if (!res.ok) throw new AuthError(`${what}: store refused (${(res as { reason?: string }).reason})`);
    return res as T & { ok: true };
}

export function validateUsername(username: string): string {
    const name = String(username ?? '').trim();
    if (!USERNAME_RE.test(name)) {
        throw new AuthError('Username: 2-32 characters, letters, digits, dot, dash or underscore.');
    }
    return name;
}

export function validatePassword(password: string): string {
    const p = String(password ?? '');
    if (p.length < MIN_PASSWORD) {
        throw new AuthError(`Password must be at least ${MIN_PASSWORD} characters.`);
    }
    return p;
}

export async function userCount(): Promise<number> {
    const res = requireOk(await OPS.countUsers(), 'countUsers');
    return Number(res.rows[0]?.n ?? 0);
}

export async function createUser(
    username: string, password: string, role: Role,
): Promise<UserRow> {
    const name = validateUsername(username);
    validatePassword(password);

    const hash = await hashPassword(password);
    try {
        const res = requireOk(await OPS.insertUser(name, hash, role), 'insertUser');
        const id = res.rows[0]?.id;
        if (id === undefined) throw new AuthError('user was not created');
        return {
            id, username: name, role, disabled: false,
            createdTs: new Date(), lastLoginTs: null,
        };
    } catch (err) {
        // 23505 is unique_violation. Caught rather than pre-checked, because a
        // SELECT-then-INSERT is a race that two concurrent signups can lose.
        if ((err as { code?: string }).code === '23505') {
            throw new AuthError('That username already exists.');
        }
        throw err;
    }
}

export async function listUsers(): Promise<UserRow[]> {
    const res = requireOk(await OPS.listUsers(), 'listUsers');
    return res.rows.map((r) => ({
        id: r.id,
        username: r.username,
        role: isRole(r.role) ? r.role : 'viewer',
        disabled: r.disabled,
        createdTs: r.created_ts,
        lastLoginTs: r.last_login_ts,
    }));
}

export async function deleteUser(username: string): Promise<void> {
    const res = requireOk(await OPS.deleteUser(username), 'deleteUser');
    if (res.rows.length === 0) {
        // Either no such user, or the last-admin guard in the statement fired.
        // Distinguished by a second lookup rather than by guessing, because
        // "no such user" and "you would lock everyone out" are very different
        // things to tell someone.
        const found = requireOk(await OPS.findUserByName(username), 'findUserByName');
        throw new AuthError(found.rows.length === 0
            ? 'No such user.'
            : 'Cannot delete the last enabled admin.');
    }
}

export async function setUserRole(username: string, role: Role): Promise<void> {
    const res = requireOk(await OPS.setUserRole(username, role), 'setUserRole');
    if (res.rows.length === 0) {
        const found = requireOk(await OPS.findUserByName(username), 'findUserByName');
        throw new AuthError(found.rows.length === 0
            ? 'No such user.'
            : 'Cannot demote the last enabled admin.');
    }
}

/**
 * Change a password and revoke that user's other sessions.
 *
 * The revocation is the point. Without it, changing a password after a laptop
 * is stolen leaves the thief signed in, and the user believes they have fixed
 * the problem.
 */
export async function setUserPassword(
    username: string, password: string, exceptToken: string | null,
): Promise<{ sessionsRevoked: number }> {
    validatePassword(password);
    const hash = await hashPassword(password);
    const res = requireOk(await OPS.setUserPassword(username, hash), 'setUserPassword');
    const userId = res.rows[0]?.id;
    if (userId === undefined) throw new AuthError('No such user.');

    const revoked = requireOk(
        await OPS.deleteUserSessions(userId, exceptToken === null ? null : sha256(exceptToken)),
        'deleteUserSessions',
    );
    return { sessionsRevoked: revoked.rows.length };
}

// --- login -------------------------------------------------------------------

/**
 * Returns the user on success, null on failure.
 *
 * Verifies against a dummy hash when the user does not exist, so the cost of a
 * login attempt does not reveal which usernames are real. That pad is why
 * there is no cheap path through this endpoint, which is exactly why it must
 * not be synchronous.
 */
export async function checkLogin(
    username: string, password: string,
): Promise<{ id: string; username: string; role: Role } | null> {
    const name = String(username ?? '').trim();
    const found = requireOk(await OPS.findUserByName(name), 'findUserByName');
    const row = found.rows[0];

    const stored = row ? row.password : await DUMMY_HASH;
    const ok = await verifyPassword(String(password ?? ''), stored);

    if (!row || !ok) return null;
    // Checked after the hash, not before, so a disabled account costs the same
    // as an enabled one and cannot be probed for by timing.
    if (row.disabled) return null;

    // Fire and forget, but never unhandled: a rejection here used to crash
    // the MAIN thread on any database blip during a login.
    OPS.touchLastLogin(row.id).catch((err: unknown) => log('touchLastLogin failed:', (err as Error).message));
    return {
        id: row.id,
        username: row.username,
        role: isRole(row.role) ? row.role : 'viewer',
    };
}

// --- sessions ----------------------------------------------------------------

export async function createSession(
    userId: string, userAgent: string | null, sourceIp: string | null,
): Promise<string> {
    const token = crypto.randomBytes(32).toString('base64url');
    requireOk(
        await OPS.insertSession(sha256(token), userId, SESSION_TTL_S, userAgent, sourceIp),
        'insertSession',
    );
    return token;
}

export async function validateSession(token: string | null): Promise<Principal> {
    if (!token) return { kind: 'anonymous' };
    const res = requireOk(await OPS.findSession(sha256(token)), 'findSession');
    const row = res.rows[0];
    if (!row || row.expired) return { kind: 'anonymous' };
    // A disabled account's sessions stop working immediately rather than at
    // expiry. Disabling someone has to mean something now, not in 30 days.
    if (row.disabled) return { kind: 'anonymous' };

    const remainingS = (row.expires_ts.getTime() - Date.now()) / 1000;
    if (remainingS < SESSION_REFRESH_S) {
        // Same: a blip during any session refresh must not be fatal.
        OPS.refreshSession(row.token_hash, SESSION_TTL_S)
            .catch((err: unknown) => log('session refresh failed:', (err as Error).message));
    }

    return {
        kind: 'user',
        id: Number(row.user_id),
        username: row.username,
        role: isRole(row.role) ? row.role : 'viewer',
    };
}

export async function destroySession(token: string | null): Promise<void> {
    if (token) requireOk(await OPS.deleteSession(sha256(token)), 'deleteSession');
}

export async function pruneSessions(): Promise<number> {
    const res = await OPS.pruneSessions();
    return res.ok ? res.rows.length : 0;
}

// --- audit -------------------------------------------------------------------

export async function audit(
    actor: Principal, action: string, target: string | null,
    detail?: unknown, sourceIp?: string | null,
): Promise<void> {
    const actorId = actor.kind === 'user' ? String(actor.id) : null;
    const actorName = actor.kind === 'user' ? actor.username
        : actor.kind === 'display' ? `display:${actor.label}`
        : 'anonymous';
    const res = await OPS.insertAudit(
        actorId, actorName, action, target, detail, sourceIp ?? null,
    );
    // An audit write that fails is loud. It is not worth failing the action the
    // user asked for, but it must never be silent: an audit trail with holes
    // is worse than none, because it is trusted.
    if (!res.ok) log(`ALARM audit write refused (${res.reason}) for ${actorName} ${action} ${target ?? ''}`);
}

export interface AuditEntry {
    id: string;
    ts: Date;
    actor: string;
    action: string;
    target: string | null;
    detail: unknown;
    sourceIp: string | null;
}

export async function listAuditRows(limit: number): Promise<AuditEntry[]> {
    const res = requireOk(await OPS.listAudit(limit), 'listAudit');
    return res.rows.map((r) => ({
        id: r.id,
        ts: r.ts,
        actor: r.actor_username,
        action: r.action,
        target: r.target,
        detail: r.detail,
        sourceIp: r.source_ip,
    }));
}

// --- first-run bootstrap ------------------------------------------------------

/**
 * Create the first admin from the environment, once, when no users exist.
 *
 * The alternative the parent suite used elsewhere is an unclaimed setup page,
 * which is worse: an application that is reachable and has no accounts hands
 * itself to whoever finds it first.
 */
export async function bootstrapFromEnv(): Promise<boolean> {
    if (await userCount() > 0) return false;

    const password = process.env.ADMIN_PASSWORD;
    if (!password) {
        log('no users exist and ADMIN_PASSWORD is not set - nobody can sign in.');
        log('  set ADMIN_PASSWORD and restart to create the first admin.');
        return false;
    }
    if (password.length < MIN_PASSWORD) {
        // Seeded anyway - an application nobody can administer is worse - but
        // said out loud, because the UI would reject this same password.
        log(`WARNING ADMIN_PASSWORD is shorter than the ${MIN_PASSWORD} character minimum the UI enforces`);
    }

    const name = process.env.ADMIN_USERNAME || 'admin';
    const hash = await hashPassword(password);
    const res = requireOk(await OPS.insertUser(validateUsername(name), hash, 'admin'), 'insertUser');
    const id = res.rows[0]?.id ?? null;
    await OPS.insertAudit(id, 'system', 'user.create', name, { role: 'admin', via: 'bootstrap' }, null);
    log(`created first admin "${name}" from ADMIN_PASSWORD`);
    return true;
}

// --- cookies ------------------------------------------------------------------

export function parseCookies(req: http.IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const eq = part.indexOf('=');
        if (eq > 0) {
            // A malformed value (Cookie: x=%) makes decodeURIComponent throw;
            // skip the pair rather than let it take down the request.
            try {
                out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
            } catch {
                // ignore undecodable cookie
            }
        }
    }
    return out;
}

export function sessionCookie(token: string): string {
    const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
    return `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_S}${secure}`;
}

export function clearCookie(): string {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function tokenFromRequest(req: http.IncomingMessage): string | null {
    return parseCookies(req)[COOKIE_NAME] ?? null;
}

// --- login rate limiting (in-memory, per source address AND per account) ------
//
// THREE HOLES, CLOSED 2026-10-01 (review F8, and the operator's ruling that
// accounts lock too):
//
//  * THE RACE. The address was checked once, then the handler awaited the
//    body, the user lookup and scrypt before counting a failure - so a burst
//    of concurrent attempts all passed the check, and hundreds reached scrypt
//    where five were meant to. An attempt now RESERVES its slot before the
//    first await (beginLoginAttempt), and the check counts attempts in
//    flight as well as failures.
//  * THE RESET. A successful sign-in cleared its address's count, so anyone
//    with one valid account could guess four times at another, sign in, and
//    guess four more. A success now clears only its own account; an
//    address's count lapses after FAILURE_WINDOW_MS without failures.
//  * THE ACCOUNT. Counting only by address left an account open to guesses
//    from many addresses. Each username is counted too, whether or not it
//    exists (so a lockout says nothing about which names are real), and its
//    lockouts double, 1 minute to LOCKOUT_MAX_MS. An attacker can therefore
//    keep an account locked; the operator's position is that this is handled
//    outside the application (a firewall, a proxy), and a locked account
//    loses nothing it had.
//
// Changing one's own password checks the current one through the same
// limiter - it was unlimited, so a stolen session could brute-force it.

interface Failure {
    count: number;
    lockedUntil: number;
    /** When the current count began; it lapses after FAILURE_WINDOW_MS. */
    since: number;
    /** Lockouts so far, for the doubling; forgotten after a quiet day. */
    lockouts: number;
    /** Attempts admitted and not yet finished - the race's half of the check. */
    inFlight: number;
}
const failures = new Map<string, Failure>();
const MAX_FAILURES = 5;
const LOCKOUT_MS = 60 * 1000;
const LOCKOUT_MAX_MS = 15 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUTS_FORGOTTEN_MS = 24 * 3600 * 1000;

/** How long the nth lockout lasts: 1, 2, 4, 8 minutes, then 15. */
export function lockoutMs(nth: number): number {
    return Math.min(LOCKOUT_MS * 2 ** Math.max(0, nth - 1), LOCKOUT_MAX_MS);
}

/**
 * The limiter's key for a client address. IPv6 by its /64: one host is
 * routinely given a whole /64, so per-address keying handed an IPv6 attacker
 * eighteen quintillion fresh buckets.
 */
export function addressKey(ip: string): string {
    const v4mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (v4mapped) return `ip:${v4mapped[1]}`;
    if (!ip.includes(':')) return `ip:${ip}`;
    const [head = '', tail] = ip.split('::');
    const h = head === '' ? [] : head.split(':');
    const t = tail === undefined || tail === '' ? [] : tail.split(':');
    const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    return `ip6:${groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** The limiter's key for an account: the name as typed, case folded, bounded. */
export function accountKey(username: string): string {
    return `user:${username.trim().toLowerCase().slice(0, 128)}`;
}
/**
 * A HARD cap, and the word is load bearing.
 *
 * The first version swept only entries that were expired or not yet locked,
 * so entries CURRENTLY locked out survived it - and the real bound became
 * "the attack rate times the 60s lockout window" rather than this constant.
 * Still bounded, and honest once you knew, but THE CODE SAID 10,000 AND MEANT
 * SOMETHING ELSE. The next person reasoning about this process's memory would
 * have used the number written down, because it is the number written down -
 * which is the comment-versus-behaviour gap in miniature.
 *
 * So the cap is now real: expired entries go first, and if that is not
 * enough, LOCKED entries are evicted too, oldest first. Map iteration is
 * insertion order, so the oldest lockout is also the one closest to expiring
 * anyway.
 *
 * WHAT IT COSTS AN ATTACKER: exactly one free retry, and only after they have
 * put 10,000 distinct addresses into simultaneous lockout - about 50,000
 * attempts a minute. That is a far better trade than a bound nobody can state
 * in one sentence, and this one can: THE MAP NEVER HOLDS MORE THAN
 * MAX_TRACKED_IPS ENTRIES.
 */
const MAX_TRACKED_IPS = 10_000;

/** The entry for a key, with whatever has lapsed brought up to now. */
function current(key: string, now: number): Failure | undefined {
    const f = failures.get(key);
    if (!f) return undefined;
    if (f.lockedUntil && f.lockedUntil <= now) f.lockedUntil = 0;
    if (!f.lockedUntil && f.count > 0 && now - f.since > FAILURE_WINDOW_MS) f.count = 0;
    if (!f.lockedUntil && f.lockouts > 0 && now - f.since > LOCKOUTS_FORGOTTEN_MS) f.lockouts = 0;
    if (!f.lockedUntil && f.count === 0 && f.lockouts === 0 && f.inFlight === 0) { failures.delete(key); return undefined; }
    return f;
}

/** May an attempt under this key go ahead now? Failures and attempts in
 *  flight both count, so concurrent attempts cannot all pass together. */
export function loginAllowed(key: string): boolean {
    const f = current(key, Date.now());
    if (!f) return true;
    return !f.lockedUntil && f.count + f.inFlight < MAX_FAILURES;
}

/** One sign-in attempt's reservation, held from before the first await. */
export interface LoginAttempt { keys: string[] }

/**
 * Reserve an attempt against every key it counts under - the address and the
 * account - or refuse it. Synchronous on purpose: nothing can interleave
 * between the check and the reservation. Every admitted attempt must be
 * finished with endLoginAttempt, success or not.
 */
export function beginLoginAttempt(ip: string, username: string): LoginAttempt | null {
    const keys = [addressKey(ip), accountKey(username)];
    if (!keys.every(loginAllowed)) return null;
    const now = Date.now();
    for (const k of keys) {
        const f = current(k, now) ?? { count: 0, lockedUntil: 0, since: now, lockouts: 0, inFlight: 0 };
        f.inFlight++;
        failures.set(k, f);
    }
    return { keys };
}

/** Finish an attempt: a failure counts under every key; a success clears the
 *  account only - never the address (see the header: THE RESET). */
export function endLoginAttempt(attempt: LoginAttempt, succeeded: boolean): void {
    for (const k of attempt.keys) {
        const f = failures.get(k);
        if (f) f.inFlight = Math.max(0, f.inFlight - 1);
    }
    if (succeeded) {
        const account = attempt.keys.find((k) => k.startsWith('user:'));
        if (account) failures.delete(account);
        return;
    }
    for (const k of attempt.keys) recordLoginFailure(k);
}

export function recordLoginFailure(ip: string): void {
    // THIS ADDRESS'S STATE IS READ FIRST, before any eviction.
    //
    // The first version evicted and then read, so eviction could delete the
    // entry it was about to update - and the caller's count restarted at
    // zero, meaning THE ATTACKER FILLING THE MAP NEVER LOCKED OUT AT ALL. A
    // memory bound that switches off the protection is worse than no bound.
    // Caught by the control asserting the newest offender stays locked.
    const now = Date.now();
    const f = current(ip, now) ?? { count: 0, lockedUntil: 0, since: now, lockouts: 0, inFlight: 0 };
    if (f.count === 0) f.since = now;
    f.count++;
    if (f.count >= MAX_FAILURES) {
        f.count = 0;
        f.lockouts++;
        f.lockedUntil = now + lockoutMs(f.lockouts);
        f.since = now;
    }

    // Keyed by client IP, so the map is attacker-growable. Two passes, and
    // the second is what makes MAX_TRACKED_IPS true rather than aspirational.
    if (failures.size >= MAX_TRACKED_IPS) {
        const now = Date.now();
        // 1. The free ones: expired lockouts and counts that never locked.
        for (const [k, v] of failures) {
            if (k !== ip && v.inFlight === 0 && (!v.lockedUntil || v.lockedUntil <= now)) failures.delete(k);
        }
        // 2. Still full, so evict LIVE lockouts, oldest first. Insertion
        //    order means the oldest is nearest to expiring, so the attacker
        //    buys one retry against the entry that was about to free itself -
        //    and never against their own, which is the point of the skip.
        if (failures.size >= MAX_TRACKED_IPS) {
            for (const k of failures.keys()) {
                if (k === ip) continue;
                failures.delete(k);
                if (failures.size < MAX_TRACKED_IPS) break;
            }
        }
    }
    failures.set(ip, f);
}

export function recordLoginSuccess(ip: string): void {
    failures.delete(ip);
}

export function rateLimitState(): { tracked: number; lockedOut: number } {
    let lockedOut = 0;
    const now = Date.now();
    for (const v of failures.values()) if (v.lockedUntil > now) lockedOut++;
    return { tracked: failures.size, lockedOut };
}

export { COOKIE_NAME, SESSION_TTL_S, MIN_PASSWORD };
