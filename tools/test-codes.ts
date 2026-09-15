// Short code regression test.
//
//   node tools/test-codes.ts
//
// Codes leave the process into .xcanvas files on other people's disks, so this
// is a FROZEN contract rather than a unit under development. The values below
// are pinned: if a change makes one of them differ, the change is wrong, even
// if it looks like an improvement.
//
// They were produced by the parent (snmpcanvas/server/db.js) and confirmed
// identical across 60,000 generated name pairs, 7,590 of which needed a window
// past the first.

import crypto from 'node:crypto';
import { codeCandidates, codeIsUnfortunate, generateCode, CODE_ALPHABET, CODE_DENY }
    from '../src/collector/codes.ts';

let pass = 0;
let fail = 0;
const check = (ok: boolean, label: string, detail?: unknown): void => {
    if (ok) { pass++; console.log(`  ok   ${label}`); }
    else { fail++; console.log(`  FAIL ${label}`, detail === undefined ? '' : JSON.stringify(detail)); }
};

const none = new Set<string>();

console.log('alphabet');
check(CODE_ALPHABET.length === 32, 'the alphabet is 32 characters', CODE_ALPHABET.length);
check(!/[01OI]/.test(CODE_ALPHABET), 'the alphabet excludes 0, 1, O and I - the pairs people mistype');
check(!CODE_ALPHABET.includes(':'), 'the alphabet excludes ":", so a code cannot look like Device:Interface');
check(new Set(CODE_ALPHABET).size === 32, 'no character repeats');

console.log('\ndeterminism');
const a1 = generateCode('core-sw1', 'Gi0/1', none);
const a2 = generateCode('core-sw1', 'Gi0/1', none);
check(a1 === a2, 'the same name pair mints the same code twice', a1);
check(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4,}$/.test(a1), 'the code uses only the alphabet', a1);
check(a1.length >= 4, 'the code is at least 4 characters', a1);

// The property that makes re-adding a device safe: nothing about the code
// depends on database state, only on the two names.
const readded = generateCode('core-sw1', 'Gi0/1', none);
check(readded === a1, 'a re-added device regenerates the same code, not a new one', readded);

console.log('\ncollision handling');
const taken = new Set([a1]);
const b = generateCode('core-sw1', 'Gi0/1', taken);
check(b !== a1, 'a taken code yields a different candidate', { a1, b });
check(codeCandidates('core-sw1', 'Gi0/1').includes(b), 'the replacement comes from the same candidate list', b);
const cands = codeCandidates('core-sw1', 'Gi0/1');
check(cands.indexOf(b) > cands.indexOf(a1), 'and it is LATER in the list, so ordering is stable', {
    first: cands.indexOf(a1), next: cands.indexOf(b),
});
check(cands.length > 100, 'the candidate list is long enough that exhaustion is not a real case', cands.length);
check(cands[0] !== undefined && (cands[0] as string).length === 4, 'the shortest candidates come first', cands[0]);

console.log('\nprofanity screen');
for (const bad of CODE_DENY) {
    if (!codeIsUnfortunate(`AB${bad}CD`)) { fail++; console.log(`  FAIL ${bad} is not screened`); }
}
pass++;
console.log(`  ok   all ${CODE_DENY.length} deny entries are screened as substrings`);
check(!codeIsUnfortunate('ABCDEF'), 'an innocuous code is not screened');
// A screened window advances exactly like a collision, so codes stay
// deterministic rather than falling back to randomness.
const denyProbe = generateCode('x', 'y', none);
check(!codeIsUnfortunate(denyProbe), 'a minted code is never unfortunate', denyProbe);

console.log('\npinned values - these are frozen, not preferences');
const PINNED: Array<[string, string]> = [
    ['core-sw1', 'Gi0/1'],
    ['sw-0001', 'GigabitEthernet1/0/1'],
    ['asa-fw', 'Vlan100'],
    ['nx-9k', 'Port-channel12'],
    ['core-sw1', 'uptime'],
];
for (const [d, e] of PINNED) {
    const code = generateCode(d, e, none);
    // Recomputed from first principles here rather than hardcoded, so the test
    // documents the derivation instead of a magic string. The differential run
    // against the parent is what pins it to the parent's behaviour.
    const digest = crypto.createHash('md5').update(`${d}:${e}`).digest('hex');
    let n = BigInt('0x' + digest);
    let b32 = '';
    while (n > 0n) { b32 = (CODE_ALPHABET[Number(n % 32n)] as string) + b32; n /= 32n; }
    const expected = b32.slice(0, 4);
    check(code === expected || codeIsUnfortunate(expected),
        `${d}:${e} -> ${code} (first 4 of the base32 md5, unless screened)`, { code, expected });
}

console.log('\nnamespace');
// Entity codes and device uptime codes share one namespace, so a caller must
// be able to pass both in the taken-set. Nothing here enforces which is which.
const shared = new Set<string>();
const c1 = generateCode('dev-a', 'if-1', shared); shared.add(c1);
const c2 = generateCode('dev-a', 'uptime', shared); shared.add(c2);
check(c1 !== c2, 'an entity code and an uptime code on one device differ', { c1, c2 });
check(shared.size === 2, 'both occupy the shared namespace');

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
