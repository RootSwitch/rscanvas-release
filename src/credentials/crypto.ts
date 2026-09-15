// Encryption at rest for credential profiles.
//
// PORTED FROM SNMPCANVAS server/db.js, format verbatim: AES-256-GCM, a
// scrypt-derived key, a random 12-byte IV per value, stored as
// iv:tag:ciphertext in base64. Ported because it is authenticated encryption
// with per-value nonces and a real KDF, and a format that is already known and
// deployed is worth more than one that is marginally tidier.
//
// TWO DEPARTURES FROM THE PARENT, both deliberate:
//
//   1. The parent stores PLAINTEXT when its secret is unset. This module
//      refuses instead: encrypt() throws when there is no key, and the route
//      above it turns that into a refusal naming RSCANVAS_SECRET. Same posture
//      as resolveCommunity refusing an unresolvable env name - an
//      unconfigured secret store must not silently become a plaintext one.
//   2. The scrypt salt is 'rscanvas-cred-v1', not the parent's, so a copied
//      SNMPCANVAS_SECRET cannot decrypt an RSCanvas store or vice versa. The
//      -v1 suffix is the format version: a future change to cipher or KDF
//      bumps it and reads both.
//
// Encryption, not hashing, and that is not a weakness: the community is sent
// on the wire every poll, so it must be recoverable. What the key protects
// against is a stolen pg_dump - which already carries every device's name,
// address and topology - ALSO carrying the strings that read them.

import crypto from 'node:crypto';

const SALT = 'rscanvas-cred-v1';
const KEY_LEN = 32;
const IV_LEN = 12;

let cachedKey: Buffer | null | undefined;

/** The derived key, or null when RSCANVAS_SECRET is unset or empty. Cached:
 *  scrypt is deliberately slow and the secret does not change at runtime. */
export function credentialKey(): Buffer | null {
    if (cachedKey !== undefined) return cachedKey;
    const secret = process.env.RSCANVAS_SECRET;
    cachedKey = secret === undefined || secret === '' ? null
        : crypto.scryptSync(secret, SALT, KEY_LEN);
    return cachedKey;
}

/** True when a secret store can be used at all. */
export const credentialStoreReady = (): boolean => credentialKey() !== null;

export class CredentialKeyMissing extends Error {
    constructor() {
        super('RSCANVAS_SECRET is not set, so credentials cannot be stored. Set it in the service '
            + 'environment (/etc/rscanvas/rscanvas.env) and restart. Env-named credential '
            + 'references (SNMP_COMMUNITY_*) keep working without it.');
    }
}

export function encrypt(plain: string): string {
    const key = credentialKey();
    if (key === null) throw new CredentialKeyMissing();
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt, or return null when it CANNOT - wrong key, tampered ciphertext,
 * malformed value. Null rather than a throw, because the caller's job is to
 * name the profile that failed and carry on with the others; one bad row must
 * not take the collector down or hide the ninety-nine good ones.
 */
export function decrypt(stored: string): string | null {
    const key = credentialKey();
    if (key === null) return null;
    const parts = stored.split(':');
    if (parts.length !== 3) return null;
    try {
        const [iv, tag, ct] = parts.map((s) => Buffer.from(s, 'base64')) as [Buffer, Buffer, Buffer];
        if (iv.length !== IV_LEN) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
        return null;   // GCM tag mismatch is the wrong-key and tampered case
    }
}

/** For tests only: forget the cached key so a changed RSCANVAS_SECRET is seen. */
export function _resetKeyCacheForTests(): void { cachedKey = undefined; }
