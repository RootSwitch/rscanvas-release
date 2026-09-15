// The credential reload must not yield (slice 42).
//
// loadProfiles() empties the profile map and refills it:
//
//     profiles.clear(); undecryptable.clear();
//     for (const p of r.rows) { ... profiles.set(p.name, ...) }
//
// That is safe TODAY for exactly one reason: everything between those two
// points is synchronous, so no poll can observe the map while it is empty.
// `decrypt` is a synchronous function over a cached scrypt key, and the loop
// contains no await.
//
// PUT AN AWAIT IN THERE AND THE FAILURE IS FLEET-WIDE AND BAFFLING. Every
// poll that resolves a credential during the gap gets `profiles.get(ref) ===
// undefined`, falls through to the environment lookup, finds nothing, and is
// refused with "credential X is neither a profile on the Credentials page nor
// an environment variable on this server" - a message that is precisely wrong,
// naming a configuration error for a profile that exists and is correct. It
// would clear itself within milliseconds and recur on every reload, which is
// the worst shape a bug can have: intermittent, self-healing, and accusing the
// operator of something they did not do.
//
// The plausible way it gets introduced is not carelessness. It is moving the
// key to something asynchronous - a KMS, an agent socket, a file read - which
// is a reasonable thing to want. This check is here so that change fails
// loudly at the gate instead of quietly at 3am, and the fix is equally
// mechanical: build the new map in a local, then assign it in one statement.

import fs from 'node:fs';
import path from 'node:path';

const START = 'profiles.clear()';
const END = 'credential profiles loaded';

/** Returns the offending token, or null when the span is clean. */
export function scanReloadSpan(src) {
    const a = src.indexOf(START);
    if (a === -1) return { ok: false, detail: `no ${START} found - has loadProfiles been renamed?` };
    const b = src.indexOf(END, a);
    if (b === -1) return { ok: false, detail: `no "${END}" line after ${START} - the span cannot be bounded` };
    const span = src.slice(a, b);
    // Comments are stripped first: this file's own explanation contains the
    // word await, and a checker that trips on prose about itself is a checker
    // people disable.
    const code = span.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const m = /\bawait\b/.exec(code);
    if (m === null) return { ok: true };
    const line = span.slice(0, m.index).split('\n').length;
    return { ok: false, detail: `await found ${line} line(s) into the reload span - the profile map is observably EMPTY while it resolves` };
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };

    const clean = `profiles.clear(); undecryptable.clear();
    for (const p of r.rows) { profiles.set(p.name, decrypt(p.community)); }
    log(\`credential profiles loaded: \${profiles.size}\`);`;
    const r1 = scanReloadSpan(clean);
    if (r1.ok) ok('a synchronous reload passes'); else bad('a clean reload was refused', r1);

    const dirty = `profiles.clear(); undecryptable.clear();
    for (const p of r.rows) { profiles.set(p.name, await decryptFromKms(p.community)); }
    log(\`credential profiles loaded: \${profiles.size}\`);`;
    const r2 = scanReloadSpan(dirty);
    if (!r2.ok && r2.detail.includes('EMPTY')) ok('an awaited decrypt is REFUSED, naming the empty window');
    else bad('an awaiting reload was accepted', r2);

    // The check must survive its own documentation.
    const commented = `profiles.clear(); // we must not await here
    /* nor await in a block comment */
    for (const p of r.rows) { profiles.set(p.name, decrypt(p.community)); }
    log(\`credential profiles loaded\`);`;
    const r3 = scanReloadSpan(commented);
    if (r3.ok) ok('the word "await" in a COMMENT does not trip it');
    else bad('a comment tripped the checker', r3);

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

function check(dir) {
    const file = path.join(dir, 'workers', 'collector.ts');
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch {
        console.error(`REFUSING: cannot read ${file}`);
        return 1;
    }
    const r = scanReloadSpan(src);
    if (r.ok) {
        console.log('ok - the credential reload does not yield; the profile map is never observably empty.');
        return 0;
    }
    console.error('\nREFUSING: the credential reload can yield.\n');
    console.error(`  ${r.detail}\n`);
    console.error('While it yields, every poll resolving a credential gets an empty map, falls');
    console.error('through to the environment lookup, and is refused with a message blaming the');
    console.error('operator for a profile that is present and correct. Build the replacement map');
    console.error('in a local and assign it in ONE synchronous statement instead.');
    return 1;
}

const arg = process.argv[2];
if (arg === '--self-test') process.exit(selfTest());
else if (arg === '--check') process.exit(check(process.argv[3] ?? 'src'));
else {
    console.error('usage: check-credential-reload.mjs --self-test | --check <srcdir>');
    process.exit(2);
}
