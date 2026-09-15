// SNMPv3 (slice 29): the protocol vocabulary, the profile rules, and the
// error vocabulary. No database, no network - the same posture as
// test-speedtrust and test-counters.
//
// The cases that matter most are the SPELLING ones. An operator types what
// their agent's own config called the protocol, and every one of those
// spellings is the same algorithm; a product that accepts "sha256" and
// refuses "SHA-256" is being pedantic about a difference that does not
// exist, and the failure it produces (wrong digest, on a correct agent) is
// the most expensive kind to debug.

import {
    resolveAuthProto, resolvePrivProto, explainV3Error, explainV3Timeout, credentialFields,
    sessionVersion, type Credential,
    AUTH_PROTOS, PRIV_PROTOS, DEFAULT_AUTH, DEFAULT_PRIV,
} from '../src/credentials/v3.ts';
import { validateProfile } from '../src/credentials/profiles.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

console.log('snmpv3\n');

// --- spelling ------------------------------------------------------------------
for (const spelling of ['SHA-256', 'sha256', 'SHA256', 'hmac-sha-256', 'HMAC-SHA256', 'hmac_sha256', ' sha-256 ']) {
    const r = resolveAuthProto(spelling);
    if (r.ok && r.key === 'sha256') continue;
    bad(`auth spelling "${spelling}" did not resolve to sha256`, r);
}
ok('seven spellings of SHA-256 all resolve to the library key');

for (const spelling of ['AES', 'aes128', 'AES-128', 'CFB128-AES-128']) {
    const r = resolvePrivProto(spelling);
    if (r.ok && r.key === 'aes') continue;
    bad(`priv spelling "${spelling}" did not resolve to aes`, r);
}
ok('four spellings of AES-128 all resolve to the library key');

// --- the two AES-256s, mapped by measurement (slice 38c) -----------------------
// Bare "AES-256" MUST be Blumenthal and "AES-256-C" MUST be Reeder, because
// that is what net-snmp stores (14832.1.4 vs 9.12.6.1.2) and an operator
// mirrors a working snmpwalk. Getting this pair backwards is silent: the
// wrong one times out with nothing naming the cause.
for (const spelling of ['AES-256', 'aes256', 'AES256', 'aes-256-b']) {
    const r = resolvePrivProto(spelling);
    if (r.ok && r.key === 'aes256b') continue;
    bad(`"${spelling}" must be Blumenthal - that is what net-snmp's -x AES-256 is`, r);
}
for (const spelling of ['AES-256-C', 'aes256c', 'AES256C', 'aes-256-r', 'aes256reeder']) {
    const r = resolvePrivProto(spelling);
    if (r.ok && r.key === 'aes256r') continue;
    bad(`"${spelling}" must be Reeder - net-snmp spells that variant AES-256-C`, r);
}
ok('AES-256 resolves Blumenthal and AES-256-C resolves Reeder, as net-snmp stores them');

{
    const r = resolveAuthProto('SHA');
    if (r.ok && r.key === 'sha') ok('bare SHA is SHA-1, the universal one');
    else bad('SHA did not resolve to sha', r);
}

// --- refusal names the typo AND the list ---------------------------------------
{
    const r = resolveAuthProto('SHA-3');
    if (!r.ok && r.detail.includes('SHA-256') && r.detail.includes('SHA-3')) {
        ok('an unknown auth protocol is refused BY NAME, listing what exists');
    } else bad('unknown auth protocol refusal was unhelpful', r);
}

// --- defaults are the compatible ones, not the strongest -----------------------
{
    const a = resolveAuthProto(null);
    const p = resolvePrivProto('');
    if (a.ok && a.key === DEFAULT_AUTH && p.ok && p.key === DEFAULT_PRIV) {
        ok(`unspecified protocols default to ${DEFAULT_AUTH}/${DEFAULT_PRIV} - most compatible, not strongest`);
    } else bad('defaults wrong', { a, p });
}

// --- weak is NAMED, never refused ----------------------------------------------
{
    const md5 = resolveAuthProto('MD5');
    const des = resolvePrivProto('DES', true);
    if (md5.ok && md5.weak && des.ok && des.weak) {
        ok('MD5 and DES resolve and are marked weak - the v3-only BMC still gets monitored');
    } else bad('weak protocols were refused or unmarked', { md5, des });
}

// --- WEAK IS NAMED, BUT IMPOSSIBLE IS REFUSED (slice 38) -----------------------
// Different rule from the one above, and the distinction is the point: MD5 is
// bad cryptography we will still perform, DES on an OpenSSL 3 runtime is
// cryptography we CANNOT perform. Accepting the second would be promising a
// poll that must fail. Measured on Node 24 / OpenSSL 3.5.7: des-cbc absent.
{
    const des = resolvePrivProto('DES', false);
    if (!des.ok && des.detail.includes('legacy provider') && des.detail.includes('AES')
        && des.detail.includes('--openssl-legacy-provider')) {
        ok('DES on a runtime without it is REFUSED, naming the cause and both ways out');
    } else bad('unusable DES was accepted, or the refusal did not say what to do', des);
}
{
    const v = validateProfile({
        name: 'bmc', version: '3', v3User: 'monitor', v3Level: 'authPriv',
        v3AuthProto: 'MD5', v3AuthKey: 'a', v3PrivProto: 'DES', v3PrivKey: 'p',
    }, false);
    if (!v.ok && v.detail.includes('legacy provider')) {
        ok('the write path refuses an undeliverable DES profile - not at 3am, at save time');
    } else bad('an undeliverable DES profile was stored', v);
}
{
    const v = validateProfile({
        name: 'bmc', version: '3', v3User: 'monitor', v3Level: 'authPriv',
        v3AuthProto: 'MD5', v3AuthKey: 'secret-auth', v3PrivProto: 'DES', v3PrivKey: 'secret-priv',
    }, true);
    if (v.ok && v.warning !== undefined && v.warning.includes('MD5') && v.warning.includes('DES')) {
        ok('a weak profile is ACCEPTED with a warning naming both algorithms');
    } else bad('weak profile handling wrong', v);
}

// --- the profile rules ---------------------------------------------------------
{
    const v = validateProfile({ name: 'p', version: '3', v3User: 'u', v3Level: 'authPriv', v3AuthKey: 'a', v3PrivKey: 'p', v3AuthProto: 'SHA-256', v3PrivProto: 'AES' });
    if (v.ok && v.profile.v3AuthProto === 'sha256' && v.profile.v3PrivProto === 'aes') {
        ok('the STORED protocol is the library key, resolved at the write path');
    } else bad('protocols not normalized on the way in', v);
}
{
    const v = validateProfile({ name: 'p', version: '3', v3User: 'u', v3Level: 'authNoPriv', v3AuthKey: 'a', v3PrivProto: 'AES' });
    if (v.ok && v.profile.v3PrivProto === null) ok('authNoPriv stores no priv protocol even when one is offered');
    else bad('authNoPriv kept a priv protocol', v);
}
{
    const v = validateProfile({ name: 'p', version: '3', v3User: 'u', v3Level: 'authPriv', v3AuthKey: 'a', v3PrivKey: 'p', v3AuthProto: 'nonsense' });
    if (!v.ok && v.detail.includes('nonsense')) ok('a typo in the protocol is refused at the WRITE path, not at 3am');
    else bad('typo accepted', v);
}
{
    const v = validateProfile({ name: 'p', version: '3', v3User: 'u', v3Level: 'authPriv', v3AuthKey: 'a' });
    if (!v.ok && v.detail.includes('priv key')) ok('authPriv without a priv key is refused');
    else bad('authPriv accepted without priv key', v);
}
{
    const v = validateProfile({ name: 'p', version: '2c', community: 'public' });
    if (v.ok && v.profile.version === '2c' && v.warning === undefined) ok('v2c profiles are untouched by any of this');
    else bad('v2c validation changed', v);
}

// --- the REPORT PDU vocabulary - v3's diagnosability win -----------------------
//
// v2c answers a wrong community with silence (the the operator workstation lesson). These six
// are what v3 says instead, and each must map to a DIFFERENT operator action.
{
    const cases: Array<[string, string]> = [
        ['Unknown User Name', 'user'],
        ['Wrong Digest (incorrect password, community or key)', 'AUTH key'],
        ['Decryption Error', 'PRIVACY'],
        ['Unsupported Security Level', 'LEVEL'],
        ['Not In Time Window', 'CLOCK'],
        ['Unknown Engine ID', 'engine discovery'],
    ];
    const seen = new Set<string>();
    let allOk = true;
    for (const [msg, wanted] of cases) {
        const e = explainV3Error(msg);
        // Case-insensitive: the sentences SHOUT the noun that names the
        // operator's mistake, and the test cares that the right noun is
        // there, not how it is cased.
        if (e === null || !e.toLowerCase().includes(wanted.toLowerCase())) {
            bad(`"${msg}" did not explain (wanted "${wanted}")`, e); allOk = false; continue;
        }
        seen.add(e);
    }
    if (allOk && seen.size === cases.length) {
        ok('all six usmStats reports produce SIX DISTINCT operator sentences');
    } else if (allOk) bad('two USM reports produced the same sentence', { distinct: seen.size });
}
{
    if (explainV3Error('Request timed out') === null) {
        ok('a plain timeout gets NO v3 explanation - the function does not invent one');
    } else bad('timeout was given a v3 story');
}

// --- the timeout hint, widened by measurement (slice 38) -----------------------
// A wrong key is SILENT on RouterOS at every level that has one, so the hint
// has to cover authNoPriv too - "authNoPriv timeouts are reachability" was
// true of net-snmp and false of the switches. See the controls in
// SLICE-SNMPV3-PLAN.md.
{
    const none = explainV3Timeout('noAuthNoPriv');
    const nul = explainV3Timeout(null);
    if (none === null && nul === null) {
        ok('a noAuthNoPriv timeout gets no key hint - there IS no key, it is reachability');
    } else bad('a keyless session was given a key story', { none, nul });
}
{
    const p = explainV3Timeout('authPriv');
    const a = explainV3Timeout('authNoPriv');
    if (p !== null && a !== null && p !== a
        && p.includes('priv') && p.includes('auth')
        && a.includes('auth') && a.includes('RouterOS')) {
        ok('authPriv and authNoPriv timeouts each name the keys THAT LEVEL has, differently');
    } else bad('the timeout hints are missing, identical, or name the wrong keys', { p, a });
}

// --- credentialFields: the shaping both call sites share -----------------------
{
    const f = credentialFields({
        version: '3', user: 'monitor', level: 'authPriv',
        authProto: 'sha256', authKey: 'ak', privProto: 'aes', privKey: 'pk',
    });
    if (f.v3 !== null && f.v3.user === 'monitor' && f.community === '') {
        ok('a v3 credential yields an EMPTY community - a bug that ignores v3 fails loudly');
    } else bad('v3 credential shaping wrong', f);
}
{
    const f = credentialFields({ version: '2c', community: 'public' });
    if (f.v3 === null && f.community === 'public') ok('a v2c credential yields no v3 block');
    else bad('v2c credential shaping wrong', f);
}

// --- the registries are usable as UI vocabularies -------------------------------
{
    const dupAuth = new Set(AUTH_PROTOS.map((p) => p.key)).size !== AUTH_PROTOS.length;
    const dupPriv = new Set(PRIV_PROTOS.map((p) => p.key)).size !== PRIV_PROTOS.length;
    // Every alias must be unique across its table, or resolution is ambiguous.
    const authAliases = AUTH_PROTOS.flatMap((p) => p.aliases);
    const privAliases = PRIV_PROTOS.flatMap((p) => p.aliases);
    const ambiguous = new Set(authAliases).size !== authAliases.length
        || new Set(privAliases).size !== privAliases.length;
    if (!dupAuth && !dupPriv && !ambiguous) ok('protocol keys and aliases are unique - resolution cannot be ambiguous');
    else bad('duplicate keys or aliases', { dupAuth, dupPriv, ambiguous });
}

console.log('\nsession version - the credential decides, one rule, both call sites');
{
    // The full (row version x credential kind) table, pinned because the rule
    // lived only at the poll site for three months while the probe - and
    // therefore REDISCOVER, which sends the row's stored version - built its
    // session from the caller's version verbatim (2026-09-01 review). A v3
    // profile over a stale 2c row is the operator having pointed the device
    // at a v3 profile; honouring the row builds a v2c session with an empty
    // community and every probe times out.
    const v2c: Credential = { version: '2c', community: 'public' };
    const v3: Credential = {
        version: '3', user: 'u', level: 'authPriv',
        authProto: 'sha256', authKey: 'k'.repeat(8), privProto: 'aes128', privKey: 'k'.repeat(8),
    };
    const table: Array<[string | undefined, Credential, string]> = [
        ['1', v2c, '1'], ['2c', v2c, '2c'], ['3', v2c, '3'],
        ['1', v3, '3'], ['2c', v3, '3'], ['3', v3, '3'],
        [undefined, v2c, '2c'], [undefined, v3, '3'],
    ];
    for (const [row, cred, want] of table) {
        const got = sessionVersion(row, cred);
        if (got === want) ok(`row=${row ?? 'absent'} + ${cred.version === '3' ? 'v3 profile' : 'community'} -> ${want}`);
        else bad(`row=${row ?? 'absent'} + ${cred.version} -> ${got}, wanted ${want}`);
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
