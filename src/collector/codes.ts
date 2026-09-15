// Short codes. Ported from snmpcanvas/server/db.js, and FROZEN.
//
// A compact, human-typeable key for an entity, minted from
// md5("deviceName:entityName"). ARCHITECTURE.md lists this among the one-way
// doors, and it is the clearest example of the category:
//
//   "Short codes keep being minted from md5(device:entity), persisted,
//    collision checked and profanity screened. They live in .xcanvas files on
//    other people's disks, so how they are minted can never change."
//
// A board annotation binds by three keys - short code, Device:ifName, and
// Device:alias - and losing any one silently blanks a wall. So this file is a
// transcription, not a design. Every property below is load bearing:
//
//   * DERIVED from the name pair, so re-adding a device regenerates the same
//     code rather than orphaning every annotation that referenced it.
//   * PERSISTED, so nothing that happens later - un-export, rediscover,
//     rename - can change one that already exists.
//   * COLLISION CHECKED at mint time, the newcomer taking a longer window.
//   * NEVER CONTAINS ':', so a code cannot be confused with a
//     "Device:Interface" identifier string.
//   * The alphabet drops 0/O and 1/I, which are the pairs people mistype when
//     reading a code off a screen.

import crypto from 'node:crypto';

export const CODE_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Every candidate window, in preference order: shortest first, and within a
 * length, earliest start first.
 *
 * The md5 is read as one big integer and rendered in the 32-character
 * alphabet, then sliced. Sliding the window rather than rehashing is what
 * keeps a collision deterministic: the same name pair always yields the same
 * ordered candidate list, so two installations that mint in a different order
 * still agree on what a given name maps to when there is no contention.
 */
export function codeCandidates(deviceName: string, entityName: string): string[] {
    const digest = crypto.createHash('md5').update(`${deviceName}:${entityName}`).digest('hex');
    let n = BigInt('0x' + digest);
    let b32 = '';
    while (n > 0n) {
        b32 = (CODE_ALPHABET[Number(n % 32n)] as string) + b32;
        n /= 32n;
    }
    const out: string[] = [];
    for (let len = 4; len <= b32.length; len++) {
        for (let start = 0; start + len <= b32.length && start < 8; start++) {
            out.push(b32.slice(start, start + len));
        }
    }
    return out;
}

// A code is an opaque ID, but it ends up on screen (docs, screenshots, the
// {code} chip) and saved as plain text in the .xcanvas file - so skip the few
// candidate windows that would spell something unfortunate. The alphabet drops
// I and O, which rules out a lot, but keeps A/E/U, so real words are reachable.
//
// This is a short curated list, NOT a profanity engine. A hit just advances to
// the next hash window, exactly like a collision, so codes stay deterministic
// and this can never exhaust the candidate list.
export const CODE_DENY = [
    'FUCK', 'FUK', 'FCK', 'CUNT', 'CNT', 'SHT', 'ASS', 'AZZ', 'ARSE',
    'FART', 'CUM', 'FAG', 'RETARD',
];

export function codeIsUnfortunate(c: string): boolean {
    for (const bad of CODE_DENY) if (c.indexOf(bad) !== -1) return true;
    return false;
}

/**
 * Mint a code, avoiding anything already taken and anything unfortunate.
 *
 * `taken` is the set of codes already in use - passed in rather than queried
 * here, because minting happens in a batch during discovery and one round trip
 * per candidate would be absurd. The caller is responsible for it covering
 * BOTH entity codes and device uptime codes, which share a namespace.
 */
export function generateCode(
    deviceName: string, entityName: string, taken: ReadonlySet<string>,
): string {
    for (const c of codeCandidates(deviceName, entityName)) {
        if (!taken.has(c) && !codeIsUnfortunate(c)) return c;
    }
    // Unreachable in practice: the candidate list runs to hundreds of windows.
    // Kept because the parent had it and because returning undefined here would
    // be worse than an ugly code.
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}
