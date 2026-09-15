#!/usr/bin/env node
// Pin a symbol's call sites, so a structural claim stays a property.
//
// WHY THIS EXISTS. BOARD-EXPOSURE.md rests on a sentence: "principalForToken
// is called in exactly one route, so the display principal only exists inside
// the route that constructs it. Nothing else has to remember to refuse it."
// That was TRUE WHEN WRITTEN AND UNENFORCED FOREVER AFTER. A future route
// importing that function widens the display surface silently, every test
// still passes, and the document keeps making a claim the code stopped
// honouring. An observation about the code is not a property of it.
//
// This is the same promotion `check-write-loops` and `check-dom-sinks` already
// made for their rules, and it borrows the former's BIDIRECTIONAL ratchet: a
// NEW call site fails, and a PINNED site that disappears also fails. The
// second direction is the one people forget, and it is what stops the list
// rotting into a description of code that has moved on - the same reason
// check-write-loops asserts its key FORMAT rather than its membership.
//
// WHAT IT CHECKS AND WHAT IT CANNOT. This is syntactic, like its siblings. It
// counts lexical call sites per file; it cannot tell you that the one call in
// main.ts sits inside the display route rather than somewhere else in the
// file, and it cannot see a call made through a re-exported alias. So it is a
// FLOOR: it catches the realistic regression - somebody adds
// `principalForToken` to a second route - and it does not pretend to catch a
// determined circumvention. Stated rather than implied, because a checker
// whose limits are unwritten gets trusted for things it never did.
//
// KNOWN NUISANCE, from the 2026-08-13 review: stripNoise removes WHOLE-LINE
// comments only, so a trailing comment mentioning a pinned symbol -
// `foo(); // principalForToken(x)` - counts as a call site. It fails CLOSED
// (an over-count fires the pin and someone investigates), so it is noise
// rather than a hole, and it is left rather than fixed because a smarter
// comment stripper is a small parser and this file's whole value is being
// simple enough to trust.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// THE PINS. Each is a claim made somewhere in prose, with the document that
// makes it, so a failure tells you what belief just broke rather than only
// which regex fired.
const PINS = [
    {
        pattern: /\bisPermittedEnvRef\s*\(/g,
        name: 'isPermittedEnvRef',
        // main.ts twice (the picker's filter and the resolution reporter),
        // collector.ts once (resolveCommunity - the only site that reads
        // process.env by an operator-supplied name and puts the answer on the
        // wire). Definition and import lines are stripped by stripNoise.
        sites: { 'src/main.ts': 2, 'src/workers/collector.ts': 1 },
        claim: 'profiles.ts ENV_REF_RE: only SNMP_COMMUNITY* may be resolved from the '
            + 'process environment. The rule previously existed as three copies and the '
            + 'one that RESOLVES - the collector - did not have it, which let an admin '
            + 'send RSCANVAS_SECRET to a host of their choosing as a community string. '
            + 'A resolving site that stops consulting it reopens that hole silently.',
    },
    {
        pattern: /\bnormalizeExplicitName\s*\(/g,
        name: 'normalizeExplicitName',
        // main.ts three times: the add route's explicit-name override, the
        // rename route, and the Force Add arm (2026-09-01) - every site
        // that lands a name in the devices.name column, each consulting the
        // one definition, which is exactly what the pin demands of any new
        // arrival. For one day the first two were copies of the rule with
        // byte-identical messages - minted by the very commit that was
        // fixing an instance of the two-definitions class, which is why
        // this pin exists (AUDIT-2026-09-01 finding 3, and the
        // isPermittedEnvRef pin is the precedent: added after the same
        // shape, for the same reason).
        sites: { 'src/main.ts': 3 },
        claim: 'onboard.ts normalizeExplicitName: ONE definition of what a device name '
            + 'may be (trim, 120-char cap, no control characters). A name-accepting '
            + 'route that stops consulting it grows its own copy next, and the copies '
            + 'drift - the rename route and the add override must both resolve here.',
    },
    {
        pattern: /\bprincipalForToken\s*\(/g,
        name: 'principalForToken',
        // Excludes its own definition and any import line - see stripNoise.
        sites: { 'src/main.ts': 1 },
        claim: 'BOARD-EXPOSURE.md: a display principal only exists inside the one '
            + 'route that constructs it, so no other route has to remember to refuse it.',
    },
    {
        // CONSTRUCTION, not comparison. `kind: 'display'` builds a display
        // principal; `=== 'display'` merely asks whether one is in hand, and
        // authorize.ts must be free to ask. The distinction is the whole
        // value of this pin: anything that CONSTRUCTS the principal has
        // bypassed token resolution and is therefore a credential path.
        pattern: /kind\s*:\s*'display'/g,
        name: "construction of a display principal (kind: 'display')",
        sites: { 'src/auth/tokens.ts': 1, 'src/auth/authorize.ts': 1 },
        claim: 'A display principal may only be built by resolving a token. The '
            + 'authorize.ts entry is the TYPE DECLARATION in the Principal union, '
            + 'not a construction - if that file ever grows a real one, this fires.',
    },
    {
        // THE OPERATOR-ASSIGNED INVARIANT, made checkable. `location` and
        // `application` may be written by exactly one op, called from exactly
        // one route. The failure this prevents is specific and plausible: a
        // future rediscovery path, or an import, writing sys_location into
        // `location` because it is right there and looks like the same thing.
        // That would let a monitored device choose which group its own outage
        // is counted in - see sql/slice11.sql.
        pattern: /\bsetDeviceGrouping\s*\(/g,
        name: 'setDeviceGrouping',
        sites: { 'src/main.ts': 1 },
        claim: 'sql/slice11.sql: location and application are OPERATOR-ASSIGNED. No '
            + 'machine path may write them, or a device could decide which group its '
            + 'own outage falls into. AND THE SECOND HALF, which this pin exists to '
            + 'keep next to the first: operator-assigned is a PROVENANCE fact, not a '
            + 'safety waiver. These fields get the same escaping and CSV formula guard '
            + 'as any device string on the way out - an operator can type =HYPERLINK() '
            + 'or paste something they did not read. Provenance decides who may write; '
            + 'it never decides how a value is treated when it leaves.',
    },
    {
        // The other half of the same invariant, from the opposite direction:
        // sys_location is a machine-written column, and it must never be
        // ASSIGNED to the operator-owned ones. Counting the identifier is a
        // crude proxy - it appears legitimately in reads - so this pins the
        // files it may appear in at all, which is the tightest syntactic
        // check available without parsing.
        pattern: /sys_location/g,
        name: 'sys_location (machine-written; must not reach location/application)',
        // MEASURED, not guessed: two occurrences, both on the single line
        // `sys_location = coalesce($5, sys_location)` in the collector's
        // device-refresh op. That is the one legitimate machine write, and
        // pinning it to that file means adding the column to any other
        // statement fires this. My first attempt guessed 3 here and 1 in
        // poll.ts; the ratchet caught both, which is what it is for.
        // 3 since U6: the two on the collector's refresh statement, plus
        // insertDeviceWithEntities writing the probed value into the
        // machine-owned column at onboarding. Checked when the ratchet fired -
        // that statement writes sys_location and does NOT touch location or
        // application, so the invariant holds and only the count moved.
        sites: { 'src/store/ops.ts': 3 },
        claim: 'sql/slice11.sql: sysLocation is SNMP-reported, so the monitored device '
            + 'controls it. Its one sanctioned use is an import-time SUGGESTION a human '
            + 'confirms - never a direct write into a grouping column.',
    },
    {
        // THE REASON U6'S RULES CAME OUT OF THE ROUTE. They lived inline in a
        // handler that cannot be imported without starting a server and four
        // workers, so the only way to check them was to drive a live instance
        // by hand - which is how the "boards" miscount survived being read
        // twice. Now they are pure functions with an offline suite, and this
        // pin is what stops them growing a second home: a route that recomputes
        // the gate rather than calling it would pass every test in
        // test-onboarding.ts while shipping a different sentence.
        pattern: /\bgateRemoval\s*\(/g,
        name: 'gateRemoval',
        sites: { 'src/main.ts': 1 },
        claim: 'The destructive gate has ONE implementation, in src/devices/removal.ts, '
            + 'asserted offline by tools/test-onboarding.ts. A second caller is fine; a '
            + 'second COPY of the rule is not, and inline arithmetic in a route is how '
            + 'the first version came to report devices-on-a-board as "boards".',
    },
    {
        // The same argument for the half that decides what may be WRITTEN.
        // "A device that did not answer cannot be added" is U6's central
        // claim, and it is enforced in two places: the route accepts a probe
        // token rather than an address (needs a live server to check), and
        // selectForAdd refuses any result that did not answer (checked
        // offline). This pins the second one to a single call site.
        pattern: /\bselectForAdd\s*\(/g,
        name: 'selectForAdd',
        sites: { 'src/main.ts': 1 },
        claim: 'U6: a device that did not answer its probe cannot be added. The refusal '
            + 'is one function with one caller - a route that filtered probe results '
            + 'itself would be a second, unasserted answer to the same question.',
    },
];

/**
 * Remove the things that look like call sites and are not: line and block
 * comments, and import statements. Without this, the function's own import in
 * main.ts counts as a use and the pin is off by one forever.
 */
function stripNoise(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*import\s[\s\S]*?from\s+'[^']*';/gm, '')
        // The definition itself. `export async function principalForToken(`
        // is not a call, and counting it would pin the wrong file.
        .replace(/^\s*(export\s+)?(async\s+)?function\s+\w+\s*\(/gm, 'FNDEF(');
}

function countIn(src, pattern) {
    const m = stripNoise(src).match(pattern);
    return m === null ? 0 : m.length;
}

function walk(dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (full.endsWith('.ts')) out.push(full.split('\\').join('/'));
    }
    return out;
}

function check(root) {
    const files = walk(root);
    const problems = [];
    for (const pin of PINS) {
        const seen = {};
        for (const file of files) {
            const n = countIn(readFileSync(file, 'utf8'), new RegExp(pin.pattern.source, 'g'));
            if (n > 0) seen[file] = n;
        }
        for (const [file, n] of Object.entries(seen)) {
            const want = pin.sites[file];
            if (want === undefined) {
                problems.push(`NEW call site for ${pin.name}: ${file} (${n})\n    ${pin.claim}`);
            } else if (want !== n) {
                problems.push(
                    `${pin.name} in ${file}: expected ${want} site(s), found ${n}\n    ${pin.claim}`);
            }
        }
        for (const [file, want] of Object.entries(pin.sites)) {
            if (seen[file] === undefined) {
                problems.push(
                    `PINNED site vanished for ${pin.name}: ${file} (expected ${want})\n`
                    + '    If this moved deliberately, update PINS - a stale pin is a checker '
                    + 'describing code that no longer exists.');
            }
        }
    }
    return problems;
}

// --- self-test ----------------------------------------------------------------
//
// Over source STRINGS, so it needs no fixture files and cannot be broken by
// the repo reaching its own success state - the mistake check-write-loops made
// when its KNOWN list emptied and its self-test failed on the empty set.
function selfTest() {
    let pass = 0;
    let fail = 0;
    const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
    const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };
    const P = /\bprincipalForToken\s*\(/g;

    const call = "const p = await principalForToken(secret);";
    if (countIn(call, P) === 1) ok('counts a real call'); else bad('missed a real call');

    const imp = "import { principalForToken } from './auth/tokens.ts';\nfoo();";
    if (countIn(imp, P) === 0) ok('an import is not a call site'); else bad('counted an import');

    const def = "export async function principalForToken(secret) { return null; }";
    if (countIn(def, P) === 0) ok('the definition is not a call site'); else bad('counted the definition');

    const cmt = "// principalForToken(x) is called once\nbar();";
    if (countIn(cmt, P) === 0) ok('a mention in a comment is not a call site'); else bad('counted a comment');

    const block = "/* principalForToken(x) */\nbaz();";
    if (countIn(block, P) === 0) ok('a mention in a block comment is not a call site'); else bad('counted a block comment');

    const two = "await principalForToken(a);\nif (x) await principalForToken(b);";
    if (countIn(two, P) === 2) ok('counts a SECOND call site - the regression this exists for');
    else bad('did not count a second call');

    const K = /kind\s*:\s*'display'/g;
    if (countIn("return { kind: 'display', tokenId: 1 };", K) === 1) {
        ok("counts a display principal CONSTRUCTION");
    } else bad('missed a construction');
    if (countIn("if (principal.kind === 'display') {", K) === 0) {
        ok("a comparison (=== 'display') is NOT a construction - authorize.ts must stay free to ask");
    } else bad('confused a comparison for a construction');

    // The pin list itself must be well-formed, asserted on FORMAT rather than
    // on contents, so this test does not have to change every time a pin does.
    const shaped = PINS.every((p) => typeof p.name === 'string' && p.claim.length > 20
        && Object.keys(p.sites).every((f) => f.startsWith('src/') && f.endsWith('.ts')));
    if (shaped) ok('every pin names a claim and points at src/*.ts paths');
    else bad('a pin is malformed');

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);

const root = args[args.indexOf('--check') + 1] ?? 'src';
const problems = check(root);
if (problems.length > 0) {
    console.error('call-site pins violated:\n');
    for (const p of problems) console.error(`  ${p}\n`);
    process.exit(1);
}
console.log(`ok - call-site pins hold (${PINS.length} pinned)`);
