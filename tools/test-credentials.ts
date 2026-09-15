// Credential profiles, offline: the cipher and the name rule.
//
//   node tools/test-credentials.ts
//
// SLICE-CREDENTIALS-PLAN done-when 1, and the half of 2 that needs no
// database. The store and route tests need Postgres and live in the drill.

import { encrypt, decrypt, credentialStoreReady, CredentialKeyMissing, _resetKeyCacheForTests } from '../src/credentials/crypto.ts';
import { validateProfile, NAME_RE, isPermittedEnvRef } from '../src/credentials/profiles.ts';

let pass = 0, fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string): void => { fail++; console.log(`  FAIL ${l}`); };
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? ok(l) : bad(`${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
};

console.log('without a key:');
delete process.env.RSCANVAS_SECRET; _resetKeyCacheForTests();
eq('the store reports not ready', credentialStoreReady(), false);
try { encrypt('public'); bad('encrypt without a key must throw'); }
catch (e) { e instanceof CredentialKeyMissing ? ok('encrypt without a key REFUSES, naming RSCANVAS_SECRET') : bad('wrong error type'); }
eq('decrypt without a key returns null, not garbage', decrypt('x:y:z'), null);

console.log('\nwith a key:');
process.env.RSCANVAS_SECRET = 'test-secret-one'; _resetKeyCacheForTests();
eq('the store reports ready', credentialStoreReady(), true);
const ct = encrypt('public');
eq('ciphertext has the iv:tag:ct shape', ct.split(':').length, 3);
if (!ct.includes('public')) ok('the plaintext does not appear in the ciphertext'); else bad('plaintext leaked into ciphertext');
eq('round trip', decrypt(ct), 'public');
if (encrypt('public') !== ct) ok('two encryptions of one value differ - random IV per value'); else bad('IV is not random');
eq('an empty string round-trips too', decrypt(encrypt('')), '');
eq('unicode round-trips', decrypt(encrypt('cömmunity ✓')), 'cömmunity ✓');

console.log('\ntamper and wrong key:');
{
    const [iv, tag, body] = ct.split(':') as [string, string, string];
    const flipped = Buffer.from(body, 'base64'); flipped[0] = (flipped[0] as number) ^ 0x01;
    eq('a flipped ciphertext byte is REJECTED (GCM tag), not decrypted to garbage',
        decrypt(`${iv}:${tag}:${flipped.toString('base64')}`), null);
    eq('a flipped tag byte is rejected', decrypt(`${iv}:${'A'.repeat(tag.length)}:${body}`), null);
    eq('a malformed value (no colons) is null, not a throw', decrypt('notciphertext'), null);
    eq('a value with the wrong IV length is null', decrypt(`AAAA:${tag}:${body}`), null);
}
process.env.RSCANVAS_SECRET = 'a-different-secret'; _resetKeyCacheForTests();
eq('a value encrypted under one secret does NOT decrypt under another', decrypt(ct), null);
process.env.RSCANVAS_SECRET = 'test-secret-one'; _resetKeyCacheForTests();
eq('and decrypts again under the right one', decrypt(ct), 'public');

console.log('\nthe name rule - operator-chosen, never derived:');
eq('a plain name is fine', validateProfile({ name: 'switches', version: '2c', community: 'x' }).ok, true);
eq('dots, dashes, underscores are fine', validateProfile({ name: 'lab-ro.v2_c', version: '2c', community: 'x' }).ok, true);
eq('empty is refused', validateProfile({ name: '', version: '2c', community: 'x' }).ok, false);
eq('whitespace-only is refused', validateProfile({ name: '   ', version: '2c', community: 'x' }).ok, false);
eq('a name with spaces is refused', validateProfile({ name: 'my switches', version: '2c', community: 'x' }).ok, false);
eq('a name that looks like a hostname with a slash is refused', validateProfile({ name: 'sw/1', version: '2c', community: 'x' }).ok, false);
eq('65 chars is refused', validateProfile({ name: 'a'.repeat(65), version: '2c', community: 'x' }).ok, false);
eq('64 chars is fine', validateProfile({ name: 'a'.repeat(64), version: '2c', community: 'x' }).ok, true);
eq('the regex is what the route uses', NAME_RE.test('ok-name'), true);

console.log('\nversion rules:');
eq('v2c without a community is refused', validateProfile({ name: 'x', version: '2c' }).ok, false);
eq('an unknown version is refused', validateProfile({ name: 'x', version: '4', community: 'c' }).ok, false);
eq('v3 without a user is refused', validateProfile({ name: 'x', version: '3', v3Level: 'authPriv' }).ok, false);
eq('v3 authNoPriv without an auth key is refused', validateProfile({ name: 'x', version: '3', v3User: 'u', v3Level: 'authNoPriv' }).ok, false);
eq('v3 authPriv without a priv key is refused', validateProfile({ name: 'x', version: '3', v3User: 'u', v3Level: 'authPriv', v3AuthKey: 'a' }).ok, false);
eq('v3 noAuthNoPriv needs only a user', validateProfile({ name: 'x', version: '3', v3User: 'u', v3Level: 'noAuthNoPriv' }).ok, true);
eq('v3 authPriv with both keys is fine', validateProfile({ name: 'x', version: '3', v3User: 'u', v3Level: 'authPriv', v3AuthKey: 'a', v3PrivKey: 'p' }).ok, true);
{
    const v = validateProfile({ name: '  trimmed  ', version: '2c', community: 'c' });
    eq('the name is trimmed', v.ok ? v.profile.name : null, 'trimmed');
}

// ---- the environment-reference allowlist (2026-08-31) ---------------------
// Until this date the rule existed in main.ts twice and at the site that
// RESOLVES not at all, so any environment variable could be sent as a
// community string. These assert the boundary in both directions: the names
// that must keep working, and the ones whose acceptance was the vulnerability.
console.log('\nenvironment-reference allowlist:');
eq('the onboarding default resolves - onboard.ts sends this literal when no ref is given',
    isPermittedEnvRef('SNMP_COMMUNITY'), true);
eq('a suffixed community variable resolves', isPermittedEnvRef('SNMP_COMMUNITY_EDGE'), true);
eq('digits and underscores are allowed', isPermittedEnvRef('SNMP_COMMUNITY_SITE_2'), true);

for (const secret of [
    'RSCANVAS_SECRET', 'ADMIN_PASSWORD', 'DATABASE_URL',
    'RSCANVAS_ADMIN_DB_PASSWORD', 'ALERT_SMTP_PASSWORD', 'ALERT_NTFY_TOKEN',
]) {
    eq(`${secret} is REFUSED - this exact name was the exfiltration path`,
        isPermittedEnvRef(secret), false);
}

// Shape edges. The pattern is anchored at both ends on purpose: a prefix or
// suffix match would re-admit the whole environment through a name that
// merely contains the permitted one.
eq('a name merely CONTAINING the prefix is refused',
    isPermittedEnvRef('X_SNMP_COMMUNITY'), false);
eq('a lowercase near-miss is refused, not coerced',
    isPermittedEnvRef('snmp_community'), false);
eq('the empty string is refused', isPermittedEnvRef(''), false);
eq('a dash is not an environment-variable character here',
    isPermittedEnvRef('SNMP_COMMUNITY-EDGE'), false);
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
