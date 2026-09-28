// SNMPv3: the protocol vocabulary and the error vocabulary.
//
// Pure, so tools/test-v3.ts holds it without a database or a network - the
// same reason speedtrust.ts and counters.ts are their own modules.
//
// TWO JOBS, and the second is the one that pays for v3 sooner than the
// cryptography does.
//
// 1. NAME NORMALIZATION. An operator configures the agent with whatever
//    spelling that agent uses - net-snmp's snmpd.conf says "SHA-256",
//    RouterOS's dropdown says "SHA256", a BMC's web form says "HMAC-SHA1",
//    the RFC says "usmHMACSHAAuthProtocol". They then type one of those into
//    RSCanvas. Rejecting "SHA-256" because the library's key is "sha256"
//    would be the product being pedantic about a difference that does not
//    exist. So: normalize aggressively, accept every spelling that is
//    unambiguous, and refuse only what is genuinely unknown - by name, with
//    the list.
//
// 2. THE REPORT PDU IS THE POINT. v2c answers a wrong community with
//    SILENCE, which is why the operator workstation read as a timeout for a day (TESTING
//    BATCHES, the credential-mismatch lesson). v3 answers with a usmStats
//    REPORT naming the fault, and net-snmp surfaces all six verbatim. So
//    "unknown user", "wrong key" and "not in time window" become three
//    different operator sentences instead of one shrug. This is a
//    diagnosability win that arrives with v3 whether or not anyone wanted
//    the encryption.

import crypto from 'node:crypto';

export type V3Level = 'noAuthNoPriv' | 'authNoPriv' | 'authPriv';

/**
 * What a RESOLVED credential is (slice 29): a community, or a v3 identity.
 *
 * A discriminated union rather than a string, and that is the load-bearing
 * choice: the day v3 arrived, "the credential" stopped being expressible as
 * a string, and every consumer that assumed one became a COMPILE ERROR
 * rather than a silent wrong-secret poll. The alternative - passing v3
 * fields alongside a dummy community - is how a device ends up probed with
 * "public" while the operator believes it is authenticated.
 */
export type Credential =
    | { version: string; community: string }
    | {
        version: '3'; user: string; level: V3Level;
        authProto: string | null; authKey: string | null;
        privProto: string | null; privKey: string | null;
    };

/**
 * The VERSION half of the same rule, shared for the same reason: THE
 * CREDENTIAL DECIDES THE VERSION when it is a v3 profile (slice 29). A
 * device row saying 2c while its profile holds a v3 identity is the
 * operator having pointed it at a v3 profile, and honouring the stale
 * column would build a v2c session with the empty community below - a
 * timeout forever, indistinguishable from down. The row still decides
 * between 1 and 2c, which a community credential cannot express.
 *
 * The poll carried this rule from slice 29; the probe built its Target
 * from the caller's version verbatim - and REDISCOVER sends the device
 * row's STORED version, so a device polling happily through its v3
 * profile failed rediscover with timeouts (2026-09-01 review). The
 * comment on credentialFields below promised the two sites could never
 * disagree about what v3 means; it covered the credential half and not
 * this one. Now both halves live here.
 */
export function sessionVersion(
    rowVersion: string | undefined, cred: Credential,
): '1' | '2c' | '3' {
    if (cred.version === '3') return '3';
    return rowVersion === '1' ? '1' : rowVersion === '3' ? '3' : '2c';
}

/** The credential half of a Target - one shaping, both call sites (the poll
 *  and the probe), so the two can never disagree about what v3 means. */
export function credentialFields(
    cred: Credential,
): { community: string; v3: NonNullable<import('../collector/snmp.ts').Target['v3']> | null } {
    if (cred.version === '3' && 'user' in cred) {
        return {
            // Never read on the v3 path; empty rather than a plausible
            // string, so a bug that ignores v3 fails loudly instead of
            // quietly probing with "public".
            community: '',
            v3: {
                user: cred.user, level: cred.level,
                authProto: cred.authProto, authKey: cred.authKey,
                privProto: cred.privProto, privKey: cred.privKey,
            },
        };
    }
    return { community: 'community' in cred ? cred.community : '', v3: null };
}

/**
 * Canonical protocol keys are the net-snmp library's own, so the mapping to
 * snmp.AuthProtocols[key] is an index rather than a switch.
 *
 * `weak` is recorded rather than refused. MD5 and DES are broken and the UI
 * says so - but the operator's ASRock Rack BMCs are SNMPv3-ONLY devices that
 * may speak nothing else, and a fork that refuses them monitors nothing
 * instead of monitoring something with a caveat. Refusing here would be
 * choosing our comfort over their fleet; naming it is the honest middle.
 */
export const AUTH_PROTOS: ReadonlyArray<{ key: string; label: string; weak: boolean; aliases: string[] }> = [
    { key: 'sha256', label: 'SHA-256', weak: false, aliases: ['sha256', 'sha-256', 'hmac-sha-256', 'hmacsha256', 'usmhmac192sha256authprotocol'] },
    { key: 'sha512', label: 'SHA-512', weak: false, aliases: ['sha512', 'sha-512', 'hmac-sha-512', 'hmacsha512', 'usmhmac384sha512authprotocol'] },
    { key: 'sha384', label: 'SHA-384', weak: false, aliases: ['sha384', 'sha-384', 'hmac-sha-384', 'hmacsha384'] },
    { key: 'sha224', label: 'SHA-224', weak: false, aliases: ['sha224', 'sha-224', 'hmac-sha-224', 'hmacsha224'] },
    { key: 'sha', label: 'SHA-1', weak: false, aliases: ['sha', 'sha1', 'sha-1', 'hmac-sha', 'hmac-sha1', 'hmacsha', 'usmhmacshaauthprotocol'] },
    { key: 'md5', label: 'MD5', weak: true, aliases: ['md5', 'hmac-md5', 'hmacmd5', 'usmhmacmd5authprotocol'] },
];

export const PRIV_PROTOS: ReadonlyArray<{ key: string; label: string; weak: boolean; aliases: string[] }> = [
    { key: 'aes', label: 'AES-128', weak: false, aliases: ['aes', 'aes128', 'aes-128', 'cfb128-aes-128', 'usmaescfb128protocol'] },
    // THE TWO AES-256s, and why the plain spelling maps to Blumenthal.
    //
    // AES-192/256 for SNMPv3 were never standardised: two drafts (Blumenthal
    // and Reeder) extend a too-short auth digest into a 32-byte cipher key
    // DIFFERENTLY, and an agent using one is silent against a manager using
    // the other. Measured against net-snmp 5.9.4 (slice 38c), by reading the
    // OIDs it stores and then breaking each combination on purpose:
    //
    //   net-snmp -x AES-256    -> .1.3.6.1.4.1.14832.1.4  (14832 = Blumenthal)
    //   net-snmp -x AES-256-C  -> .1.3.6.1.4.1.9.12.6.1.2 (9 = Cisco, Reeder)
    //
    // So bare "AES-256" is BLUMENTHAL, and an operator mirroring a working
    // snmpwalk gets the right one by typing what they already typed. The
    // "-C" spellings are aliased onto Reeder for the same reason: being
    // refused for copying the command that just worked is the product being
    // pedantic about a difference the operator cannot see.
    { key: 'aes256b', label: 'AES-256 (Blumenthal, net-snmp "AES-256")', weak: false, aliases: ['aes256', 'aes-256', 'aes256b', 'aes-256-b', 'cfb128-aes-256', 'aes256blumenthal'] },
    { key: 'aes256r', label: 'AES-256 (Reeder, net-snmp "AES-256-C")', weak: false, aliases: ['aes256r', 'aes-256-r', 'aes256reeder', 'aes256c', 'aes-256-c', 'aes256cisco', 'aes256ccisco'] },
    { key: 'des', label: 'DES', weak: true, aliases: ['des', 'cbc-des', 'usmdesprivprotocol'] },
];

// Strip EVERY separator, not just whitespace: the spellings in the wild
// differ only in where they put dashes ("HMAC-SHA-256", "HMAC-SHA256",
// "hmac_sha256"), and keeping dashes meant accepting two of those three -
// which is worse than accepting none, because the operator cannot tell
// which rule they broke. Caught by the test's own spelling table.
const norm = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * CAN THIS RUNTIME ACTUALLY DO DES? (slice 38)
 *
 * net-snmp encrypts usmDESPrivProtocol with Node's `des-cbc`, and OpenSSL 3
 * moved single DES into the LEGACY PROVIDER - so on a stock modern Node the
 * cipher does not exist and the failure surfaces deep inside the library as
 * an "unsupported" envelope error, on a poll, at whatever hour the device
 * was added. Measured here on Node 24 / OpenSSL 3.5.7: des-cbc unavailable,
 * des-ede3-cbc and both AES modes fine.
 *
 * Found because the operator noticed their own snmpwalk had stopped
 * accepting -x DES "despite mentioning it in the man file" - the same
 * squeeze, one layer up. Offering a protocol the runtime cannot perform is
 * the product promising something it will fail at later, so the check runs
 * once and the refusal names both the cause and the two ways out.
 *
 * The result is cached: it cannot change without a restart, and probing
 * OpenSSL on every profile save would be a syscall in a validator.
 */
let desCache: boolean | null = null;
export function desUsable(): boolean {
    if (desCache !== null) return desCache;
    try {
        crypto.createCipheriv('des-cbc', Buffer.alloc(8), Buffer.alloc(8));
        desCache = true;
    } catch {
        desCache = false;
    }
    return desCache;
}

export interface ProtoResolution { ok: true; key: string; label: string; weak: boolean }
export type ProtoRefusal = { ok: false; detail: string };

function resolve(
    table: typeof AUTH_PROTOS, raw: string | null | undefined, fallback: string, what: string,
): ProtoResolution | ProtoRefusal {
    const wanted = raw === null || raw === undefined || raw.trim() === '' ? fallback : norm(raw);
    const hit = table.find((p) => p.key === wanted || p.aliases.some((a) => norm(a) === wanted));
    if (hit === undefined) {
        return {
            ok: false,
            detail: `"${raw}" is not an SNMPv3 ${what} protocol this build knows. Accepted: `
                + table.map((p) => p.label).join(', ')
                + ' (spelling is flexible - SHA-256, sha256 and HMAC-SHA-256 are the same thing).',
        };
    }
    return { ok: true, key: hit.key, label: hit.label, weak: hit.weak };
}

/** DEFAULTS ARE THE MOST COMPATIBLE, NOT THE STRONGEST, and that is a
 *  deliberate inversion of the usual instinct: a default nobody typed should
 *  be the one most likely to match an agent already configured, because the
 *  failure it avoids ("wrong digest") costs an operator an afternoon while
 *  the one it accepts (SHA-1 rather than SHA-256) is a choice they can see
 *  and change on the page. Both are offered; neither is imposed. */
export const DEFAULT_AUTH = 'sha';
export const DEFAULT_PRIV = 'aes';

export const resolveAuthProto = (raw: string | null | undefined): ProtoResolution | ProtoRefusal =>
    resolve(AUTH_PROTOS, raw, DEFAULT_AUTH, 'auth');
/**
 * `available` is a parameter so the test can drive BOTH branches on a machine
 * that only has one of them - the refusal text is the whole point of this
 * check and an untestable message is a message nobody proofread.
 */
export const resolvePrivProto = (
    raw: string | null | undefined, available: boolean = desUsable(),
): ProtoResolution | ProtoRefusal => {
    const r = resolve(PRIV_PROTOS as typeof AUTH_PROTOS, raw, DEFAULT_PRIV, 'privacy');
    if (r.ok && r.key === 'des' && !available) {
        return {
            ok: false,
            detail: 'DES is in this build\'s protocol list but THIS RUNTIME CANNOT PERFORM IT: '
                + 'SNMP privacy uses single DES (des-cbc), and OpenSSL 3 moved single DES into '
                + 'the legacy provider, so the cipher is absent unless that provider is enabled. '
                + 'Refusing here rather than at poll time, because the failure would otherwise '
                + 'surface hours later as an unexplained silence from the device. Two ways out: '
                + 'switch the agent to AES (correct - DES is broken cryptography, and some '
                + 'net-snmp builds now refuse "-x DES" outright while still listing it in '
                + 'their own help text, so the CLI you would debug with may not do it either), '
                + 'or start the server with node --openssl-legacy-provider if the device '
                + 'genuinely speaks nothing else.',
        };
    }
    return r;
};

/**
 * Turn net-snmp's USM report text into a sentence naming the operator's
 * actual mistake. The library passes usmStats report types through verbatim
 * (index.js userSecurityModelError), so these strings are its contract.
 *
 * Returns null when the message is not a USM report - the caller then keeps
 * whatever error it already had, rather than this function inventing a v3
 * explanation for a plain timeout.
 */
export function explainV3Error(message: string): string | null {
    const m = message.toLowerCase();
    if (m.includes('unknown user name')) {
        return 'the agent does not know this v3 USER. The name is case-sensitive and is the '
            + 'name the agent was configured with (net-snmp: createUser <name> ...), not a login.';
    }
    if (m.includes('wrong digest')) {
        return 'the agent rejected the AUTH key - wrong passphrase, or the right passphrase with '
            + 'the wrong auth protocol (SHA-1 vs SHA-256 hash the same words differently).';
    }
    if (m.includes('decryption error')) {
        return 'auth succeeded and PRIVACY failed - the priv passphrase or the priv protocol '
            + '(AES vs DES) does not match the agent. Auth being fine is the clue: the user and '
            + 'auth key are right.';
    }
    if (m.includes('unsupported security level')) {
        return 'the agent refuses this security LEVEL for this user - it was likely created '
            + 'authNoPriv while this profile asks for authPriv, or the reverse.';
    }
    if (m.includes('not in time window')) {
        return 'the agent rejected the message as out of its time window. This is a CLOCK '
            + 'problem, not a credential one: v3 binds messages to the agent boot time and a '
            + 'skew past 150 seconds is refused. Check NTP on both ends.';
    }
    if (m.includes('unknown engine id')) {
        return 'engine discovery did not complete - the agent answered but did not accept the '
            + 'discovered engine ID. Usually a v3 proxy or a agent restarting mid-exchange; '
            + 'a retry on the next poll normally settles it.';
    }
    return null;
}

/**
 * THE TIMEOUT THAT IS NOT A TIMEOUT, measured 2026-08-28 against a real
 * net-snmp agent: a wrong PRIVACY passphrase produces SILENCE, not a
 * decryption-error report. The agent cannot decrypt the request, so it has
 * nothing to reply to and drops the packet - net-snmp's own snmpget shows
 * the same "Timeout: No Response".
 *
 * So on an authPriv session a timeout has a suspect that a v2c timeout does
 * not, and saying so is the difference between "check the firewall" (wrong,
 * expensive) and "check the priv passphrase" (right, thirty seconds). The
 * hint is only offered where it applies: a noAuthNoPriv timeout involves no
 * key at all and really is reachability, and dressing that up would be
 * inventing a story - the same discipline explainV3Error keeps by returning
 * null.
 *
 * WIDENED TO authNoPriv AND TO THE AUTH KEY (slice 38), because the original
 * "authNoPriv timeouts really are reachability" was measured on net-snmp
 * ONLY, and it does not hold. Deliberately-wrong-key controls run against
 * three agents:
 *
 *   net-snmp (Linux, FreeBSD/TrueNAS)  wrong auth key -> "Wrong Digest"
 *   RouterOS (two MikroTiks)           wrong auth key -> SILENCE
 *
 * So on RouterOS a wrong AUTH key looks exactly like a dead switch, at any
 * level that has a key. The report-PDU diagnosability that justifies v3 is
 * real on net-snmp and simply absent there - which makes this hint the only
 * thing standing between the operator and an afternoon spent on a switch
 * that was answering fine.
 */
/**
 * The v1/v2c half (2026-09-28, the real-agent drill): net-snmp's snmpd drops a
 * request with a wrong community without a word, exactly as it drops one from
 * an address its rocommunity line does not list - so a probe with the wrong
 * community read "Request timed out" and nothing else, the same sentence a
 * powered-off switch produces. The v3 timeouts below already said this about
 * keys; a community is a key too.
 */
export function explainCommunityTimeout(): string {
    return 'on SNMP v1/v2c a timeout ALSO fits a wrong community, or an agent that only answers '
        + 'certain source addresses: agents drop such requests silently rather than refusing them '
        + '(net-snmp, measured). If it answers ping, suspect the community and the agent\'s allowed '
        + 'addresses before the network.';
}

export function explainV3Timeout(level: V3Level | null): string | null {
    if (level === 'authPriv') {
        return 'on an authPriv session a timeout ALSO fits a wrong privacy OR auth passphrase: '
            + 'an agent that cannot decrypt or authenticate a request usually drops it silently '
            + 'rather than reporting, and RouterOS does exactly that (measured), so silence here '
            + 'is not proof the host is unreachable. If it answers ping, suspect the keys before '
            + 'the network - priv first, since a wrong auth key is the one some agents do report.';
    }
    if (level === 'authNoPriv') {
        return 'on an authNoPriv session a timeout ALSO fits a wrong auth passphrase or protocol: '
            + 'net-snmp answers that with a "Wrong Digest" report, but RouterOS drops it silently '
            + '(measured), so on a MikroTik this is indistinguishable from a dead device. If it '
            + 'answers ping, suspect the auth key before the network.';
    }
    return null;
}

