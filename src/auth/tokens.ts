// Capability tokens for wall displays.
//
// A wall display cannot log in and the network segment is not an access
// control, so the token IS the credential. Read BOARD-EXPOSURE.md for what a
// token may reach; this file is only about proving one is genuine.
//
// THE THREAT MODEL, stated because it decides the shape below. A capability
// URL leaks through browser history, referrer headers, screenshots, shoulder
// surfing and the sticky note somebody put on the display. It WILL leak. The
// mitigations are therefore narrow scope (one board, rendered fields only)
// and revocation that works immediately - not secrecy, which cannot be
// maintained for a string that lives in a URL bar in a corridor.

import crypto from 'node:crypto';
import { OPS } from '../store/index.ts';
import type { Principal } from './authorize.ts';

/**
 * 32 bytes from the CSPRNG, base64url.
 *
 * Not a UUID: v4 gives 122 bits inside a recognisable shape, and more to the
 * point a UUID in a URL invites being treated as an identifier and logged,
 * pasted into tickets and stored in monitoring systems. This is a SECRET and
 * looking like one is a feature.
 */
export function mintSecret(): string {
    return crypto.randomBytes(32).toString('base64url');
}

/**
 * sha256, no salt, deliberately.
 *
 * A password needs a slow KDF and a per-row salt because it is human-chosen,
 * low-entropy and reused. This is 256 bits of CSPRNG output that exists in
 * exactly one place: there is no dictionary to attack and no other account to
 * reuse it against, so bcrypt would buy nothing and cost a hash on every
 * display poll. The salt would buy nothing either - its job is to stop one
 * rainbow table covering every row, and no table covers 2^256.
 *
 * What hashing DOES buy, and why it is not skipped: this table is what a
 * stolen backup or a SQL-injection yields, and a plaintext capability URL in
 * a backup is a working credential for as long as the token lives.
 */
export function hashToken(secret: string): string {
    return crypto.createHash('sha256').update(secret).digest('hex');
}

/**
 * Resolve a presented secret to a display principal, or null.
 *
 * Returns the principal built from what the DATABASE says the token is for -
 * never from anything the request supplied. That is BOARD-EXPOSURE clause 2
 * in code: the board id travels from the token outward, so a display cannot
 * ask for a board, only present a credential and be told which one it is.
 */
export async function principalForToken(secret: string): Promise<Principal | null> {
    // Length-checked before hashing so a malformed or empty value costs
    // nothing and cannot be probed for timing differences in the store.
    if (secret.length < 32 || secret.length > 128) return null;

    const res = await OPS.resolveToken(hashToken(secret));
    // A store refusal is NOT an authentication failure and must not be
    // reported as one. Returning null here would tell a display "your token
    // is bad" when the truth is "the database is busy" - the caller
    // distinguishes them, so this throws and the route answers 503.
    if (!res.ok) throw new Error(`token lookup refused (${res.reason})`);
    const row = res.rows[0];
    if (row === undefined) return null;

    // Fire and forget: a failed touch must never fail a render. The write is
    // conditional on being an hour stale (see ops.touchToken), so this is not
    // a write per poll.
    // ...but fire-and-forget still needs a handler. onLane rethrows anything
    // that is not lane-busy or statement-timeout, so this CAN reject, and
    // without a catch the safety net turns a database blip into
    // "ALARM unhandled rejection survived" on every wall poll for the
    // duration - the net correctly naming a real missing .catch. Both sibling
    // calls in auth/index.ts already carry one, and the comment on one of them
    // says why: a rejection there used to crash the main thread on any
    // database blip during a login. Found 2026-08-31 by an independent review.
    void OPS.touchToken(row.token_id).catch(
        (err: unknown) => console.error('[auth] touchToken failed:', (err as Error).message));

    return {
        kind: 'display',
        tokenId: Number(row.token_id),
        boardId: Number(row.board_id),
        label: row.label,
    };
}

/**
 * Where a display presents its token.
 *
 * A header is preferred and a query parameter is accepted, because a wall
 * display is usually a browser pointed at a URL by somebody with a remote
 * control and no way to set headers. Accepting the query form is a
 * concession to reality, not an endorsement - it is exactly the form that
 * leaks into history and referrers, which is why revocation is first-class.
 */
export function tokenFromRequest(
    headers: Record<string, string | string[] | undefined>, params: URLSearchParams,
): string | null {
    const auth = headers.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7);
    return params.get('token');
}
