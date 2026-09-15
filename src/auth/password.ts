// Password hashing. The crypto is ported from launchcanvas/server/auth.js
// unchanged; what changes is that it no longer blocks the event loop.
//
// THE DEFECT THIS EXISTS TO NOT REPRODUCE. All four parent apps call
// `crypto.scryptSync` in `hashPassword` and `verifyPassword`
// (server/auth.js:19 and :33 in SNMPCanvas and SyslogCanvas, :20 and :34 in
// AlertCanvas and LaunchCanvas). At the configured N=16384, r=8, p=1 that is a
// measured 30ms of blocked event loop per call, median of nine on a Xeon
// W-1290. `verifyPassword` runs on POST /api/login, which an unauthenticated
// caller can drive, and the timing pad against DUMMY_HASH means a request for a
// non-existent user costs exactly the same by design, so there is no cheap
// path. In SNMPCanvas the loop it blocks is also the poll loop.
//
// It is the same bug class as the 2026-07-25 blocking sweep and it was not
// among the five found then. ARCHITECTURE.md rule 4 forbids it here.
//
// The async callback form runs the work on the libuv threadpool instead, so the
// event loop stays free. That is not the same as free: the threadpool has
// UV_THREADPOOL_SIZE threads (4 by default) shared with fs and dns, so
// concurrent logins queue against each other and against unrelated file IO.
// Queueing on a worker pool is a latency problem for the people logging in;
// blocking the loop is an outage for everyone else. See CONFIG note below.

import crypto from 'node:crypto';

// Unchanged from the parent. Recorded in the stored string so they can be
// raised later without invalidating existing passwords.
const SCRYPT = { N: 16384, r: 8, p: 1 } as const;
const KEY_LEN = 32;

// scrypt needs maxmem above the default 32MB for these parameters in some Node
// builds: 128 * N * r is 16MB, and Node's check is against 32MB with overhead.
// Stated explicitly rather than relying on the default happening to be enough.
const MAX_MEM = 64 * 1024 * 1024;

function scryptAsync(
    password: string, salt: Buffer, keylen: number, opts: crypto.ScryptOptions,
): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, { ...opts, maxmem: MAX_MEM }, (err, derived) => {
            if (err) reject(err);
            else resolve(derived);
        });
    });
}

export async function hashPassword(password: string): Promise<string> {
    const salt = crypto.randomBytes(16);
    const hash = await scryptAsync(password, salt, KEY_LEN, SCRYPT);
    return `scrypt$N=${SCRYPT.N},r=${SCRYPT.r},p=${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    try {
        const [scheme, params, saltB64, hashB64] = stored.split('$');
        if (scheme !== 'scrypt') return false;
        if (params === undefined || saltB64 === undefined || hashB64 === undefined) return false;

        const opts: crypto.ScryptOptions = {};
        for (const kv of params.split(',')) {
            const [k, v] = kv.split('=');
            if (k === undefined || v === undefined) continue;
            const n = parseInt(v, 10);
            if (!Number.isFinite(n)) return false;
            if (k === 'N') opts.N = n;
            else if (k === 'r') opts.r = n;
            else if (k === 'p') opts.p = n;
        }

        const expected = Buffer.from(hashB64, 'base64');
        const actual = await scryptAsync(password, Buffer.from(saltB64, 'base64'), expected.length, opts);
        // Lengths must match or timingSafeEqual throws rather than returning
        // false, which would turn a malformed record into a 500.
        if (actual.length !== expected.length) return false;
        return crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

/**
 * A hash to verify against when the username does not exist, so a login attempt
 * for a real account and one for an invented account cost the same.
 *
 * Built once at module load and awaited by the login path. The parent computed
 * it at require() time with the synchronous call, which blocked startup for
 * 30ms - harmless there, but it cannot be done that way here without
 * reintroducing a synchronous scrypt.
 */
export const DUMMY_HASH: Promise<string> = hashPassword('no-such-user-timing-pad');

export { SCRYPT };
