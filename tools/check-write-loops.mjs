#!/usr/bin/env node
// Refuse an awaited per-item database call inside a loop.
//
// WHY THIS EXISTS, and it is not a style rule. Three instances of one
// anti-pattern were found in the collector on 2026-08-10, by measurement
// rather than by review:
//
//   poll.ts:154      refreshEntity   331 transactions/s
//   collector.ts:217 saveCounters    331 transactions/s
//   ops.ts (alerts)  per-alert UPDATE 171 transactions/s
//
// Together they were 867 write transactions/s producing 534 fsyncs/s and 426
// GB/day of device writes against 8-9 GB/day of logical data - a 50x
// amplification, of which the WAL path alone was 6.6x because each fsync
// flushed one partially-filled 8 KB block.
//
// TWO OF THE THREE SAT DIRECTLY BESIDE A COMMENT WARNING ABOUT THIS EXACT
// SHAPE. `updateLastValuesBatch` reads "ONE statement for the whole device,
// not one per interface. The per-entity loop is 24 round trips on a typical
// switch, which is the N+1 shape that made the parent's /api/devices cost
// 5,200 queries" - and the loop it warns about is the line above it. The
// lesson was learned, written down, applied to the neighbouring call, and not
// applied here.
//
// THEY SURVIVED THREE WEEKS OF A SOAK BECAUSE NOTHING COUNTED TRANSACTIONS.
// The heartbeat, the lane wait times, the row counters and the database size
// were all healthy throughout - every instrument pointed at the symptom's
// neighbours and none at the symptom. The GB/day is a one-time win; this file
// is the part that stops the next one.
//
// WHAT THIS CHECKS AND WHAT IT CANNOT. It is a SYNTACTIC proxy: an awaited
// store call lexically inside a loop body. All three known instances have
// that shape. It will NOT catch a per-item write hidden behind a helper that
// is itself called in a loop somewhere else, so it is a floor rather than a
// guarantee - the complement is a runtime assertion on xact_commit per poll
// cycle, which needs a database and therefore belongs in the floor run rather
// than in `npm test` (see SLICE-6-PLAN).
//
// TO ALLOW ONE DELIBERATELY: put `WRITE-IN-LOOP-OK: <reason>` on the call's
// line or anywhere in the comment block above it. A reason is required - the
// marker alone does not satisfy it, because "somebody typed the magic word" is
// not an argument.
//
// HOW THE KNOWN LIST IS KEYED, since the wrong answer makes a checker cry
// wolf: FILE PLUS CALLED SYMBOL (`src/alerts/scan.ts:deleteAlert`), never a
// line number. An unrelated refactor above one of these sites must not
// produce a false failure, because the natural response to a checker that
// fires on innocent edits is to loosen it, and a loosened checker is worse
// than none. The trade is stated rather than hidden: this key does NOT
// distinguish two different loops calling the same function in one file, and
// it does not survive a file rename - a rename shows up as one entry gone
// stale and one new violation, which fails loudly and is fixed by editing one
// line. That is the right failure to have.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// THE RATCHET. Known violations, tracked and shrinking. A NEW one fails the
// build; these three are listed so the build stays honest about what is
// already broken rather than green because nobody looked. Delete each line as
// its fix lands - and the list may never grow.
// EMPTY as of 2026-08-13, and that is the ratchet's success state: all five
// original sites are fixed (refreshEntity skips when nothing changed,
// saveCounters and the alert-scan updates are batched) or carry a reasoned
// marker (the scan's insert/delete are state transitions, not per-scan
// writes). The list may hold future entries briefly while a fix is in
// flight - it may never grow quietly.
const KNOWN = new Set([]);

const CALL = /\bawait\s+(?:OPS|store|client|db)\s*\.\s*([A-Za-z_$][\w$]*)/;
const LOOP = /\b(for|while)\s*\(|\.\s*(forEach|map|flatMap)\s*\(\s*(async|\()/;
const OK = /WRITE-IN-LOOP-OK:\s*\S/;
// The fan-out form, and it matters MORE than the loop form because it is what
// the tooling ecosystem trains people to write. ESLint's `no-await-in-loop`
// fires on the loop shape, and its canonical remedy is
//
//     await Promise.all(items.map((i) => OPS.saveCounters(i.id, i.ts, i.c)));
//
// which silences both that rule and the loop check above, and FIXES NOTHING:
// N concurrent transactions is still N transactions, N tuple versions and N
// WAL records. Group commit shares some fsyncs, so the number improves a
// little - which is worse than no improvement at all, because it is enough to
// look like the fix worked. A collection-scaled fan-out of store calls is the
// same finding as the loop, and is reported as such.
const MAPPED = /\.\s*(map|flatMap|forEach)\s*\(/;
const STORE = /\b(?:OPS|store|client|db)\s*\.\s*([A-Za-z_$][\w$]*)/;

// True if the marker appears on `i` or in the contiguous comment block above.
function allowedAt(lines, i) {
    if (OK.test(lines[i])) return true;
    for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j].trim();
        if (!(prev.startsWith('//') || prev.startsWith('*') || prev.startsWith('/*'))) return false;
        if (OK.test(lines[j])) return true;
    }
    return false;
}

// Promise.all(<collection>.map(... OPS.x() ...)) - see MAPPED above.
function scanFanOut(src, lines, rel) {
    const hits = [];
    for (let idx = src.indexOf('Promise.all('); idx !== -1; idx = src.indexOf('Promise.all(', idx + 1)) {
        let depth = 0, end = idx;
        for (let k = src.indexOf('(', idx); k < src.length; k++) {
            if (src[k] === '(') depth++;
            else if (src[k] === ')') { depth--; if (depth === 0) { end = k; break; } }
        }
        const region = src.slice(idx, end + 1);
        // A fixed literal set - Promise.all([a(), b()]) - does not scale with
        // anything and is not this finding.
        if (!MAPPED.test(region)) continue;
        const m = STORE.exec(region);
        if (!m) continue;
        const line = src.slice(0, idx).split(/\r?\n/).length;
        const endLine = src.slice(0, end).split(/\r?\n/).length;
        if (!allowedAt(lines, line - 1)) {
            hits.push({ line, endLine, fn: m[1], rel, key: `${rel}:${m[1]}`, fanOut: true });
        }
    }
    return hits;
}

function scan(src, rel) {
    const lines = src.split(/\r?\n/);
    const hits = [];
    let depth = 0;
    const loopDepths = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const bare = line.replace(/\/\/.*$/, '');
        // A BRACELESS SINGLE-LINE LOOP HAS NO CLOSING BRACE TO POP ON, so
        // pushing it would leave the scanner believing every later line in the
        // enclosing block is inside a loop. That bug flagged the CORRECTLY
        // batched `updateLastValuesBatch` ten lines below the very loop this
        // file exists to catch - an instrument reporting its own neighbour.
        // Braceless loops therefore mark only their own line and push nothing.
        const at = bare.search(LOOP);
        const loopHere = at >= 0;
        const braced = loopHere && bare.slice(at).includes('{');
        if (braced) loopDepths.push(depth);
        const m = CALL.exec(bare);
        if (m && (loopDepths.length > 0 || (loopHere && !braced))) {
            // allowedAt looks at the call's line and the CONTIGUOUS COMMENT
            // BLOCK above it, not merely one line up: this codebase explains
            // itself in paragraphs, and requiring the marker to be the last
            // line of an explanation would place it to serve the checker
            // rather than the reader, which is backwards.
            if (!allowedAt(lines, i)) hits.push({ line: i + 1, fn: m[1], rel, key: `${rel}:${m[1]}` });
        }
        for (const ch of bare) {
            if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                while (loopDepths.length > 0 && loopDepths[loopDepths.length - 1] >= depth) {
                    loopDepths.pop();
                }
            }
        }
    }
    // ONE SITE, ONE FINDING. The multi-line fan-out matches BOTH passes -
    // `.map(async (r) => {` is a loop shape and the awaited call sits inside
    // it - so the loop hits enclosed by a fan-out region are dropped in favour
    // of the fan-out hit, whose message names the actual mistake. Reporting a
    // site twice trains people to skim the output, which is how the next real
    // finding gets missed.
    const fan = scanFanOut(src, lines, rel);
    const kept = hits.filter((x) => !fan.some((f) => x.line >= f.line && x.line <= f.endLine));
    return [...kept, ...fan];
}

function walk(dir, out = []) {
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p, out);
        else if (/\.(ts|mts)$/.test(name)) out.push(p);
    }
    return out;
}

function selfTest() {
    let pass = 0, fail = 0;
    const cases = [
        ['flags an awaited store call in a for loop',
            'for (const c of xs) {\n  await OPS.saveThing(c.id);\n}\n', 1],
        ['flags the single-line form',
            'for (const c of xs) await OPS.saveThing(c.id);\n', 1],
        ['does NOT flag a call outside any loop',
            'await OPS.saveThing(id);\n', 0],
        ['does NOT flag a batched call after a loop has closed',
            'for (const c of xs) { total += c; }\nawait OPS.saveBatch(ids);\n', 0],
        ['honours the marker WITH a reason on the same line',
            'for (const c of xs) await OPS.saveThing(c.id); // WRITE-IN-LOOP-OK: bounded to 3\n', 0],
        ['honours the marker on the preceding line',
            'for (const c of xs) {\n  // WRITE-IN-LOOP-OK: retry path, at most once\n  await OPS.saveThing(c.id);\n}\n', 0],
        ['REFUSES a bare marker with no reason',
            'for (const c of xs) await OPS.saveThing(c.id); // WRITE-IN-LOOP-OK:\n', 1],
        ['flags inside forEach(async',
            'xs.forEach(async (c) => {\n  await OPS.saveThing(c.id);\n});\n', 1],
        ['honours a marker anywhere in the comment block above the call',
            'for (const c of xs) {\n  // WRITE-IN-LOOP-OK: bounded by batch size\n  // and the alternative materialises everything.\n  await OPS.saveThing(c.id);\n}\n', 0],
        ['does NOT reach past a non-comment line to find a marker',
            '// WRITE-IN-LOOP-OK: unrelated, far above\nconst x = 1;\nfor (const c of xs) {\n  await OPS.saveThing(c.id);\n}\n', 1],
        // THE CONTROL FOR THIS FILE'S OWN BUG. A braceless loop followed by a
        // legitimate batched call must produce exactly ONE hit, not two - the
        // first version produced two and pointed the second at correct code.
        // THE NEAR-MISS WORTH PINNING: the canonical ESLint remedy for
        // no-await-in-loop, which silences every syntactic check and keeps
        // every transaction. This is the failure that would have looked
        // like success.
        ['flags Promise.all over a mapped store call - the fake fix',
            'await Promise.all(items.map((i) => OPS.saveCounters(i.id, i.ts, i.c)));\n', 1],
        ['flags the multi-line fan-out form',
            'await Promise.all(\n  rows.map(async (r) => {\n    await OPS.saveThing(r.id);\n  }),\n);\n', 1],
        ['does NOT flag Promise.all over a fixed literal set',
            'await Promise.all([OPS.a(1), OPS.b(2)]);\n', 0],
        ['does NOT flag a mapped call with no store access',
            'await Promise.all(items.map((i) => transform(i)));\n', 0],
        ['honours the marker on the fan-out form',
            '// WRITE-IN-LOOP-OK: three fixed lanes, not fleet-scaled\nawait Promise.all(lanes.map((l) => OPS.ping(l)));\n', 0],
        ['a braceless loop does not swallow the lines after it',
            'for (const c of xs) await OPS.saveThing(c.id);\nawait OPS.saveBatch(ids);\n', 1],
    ];
    for (const [name, src, want] of cases) {
        const got = scan(src, 'fixture.ts').length;
        if (got === want) { pass++; console.log(`  ok   ${name}`); }
        else { fail++; console.log(`  FAIL ${name} - expected ${want} hit(s), got ${got}`); }
    }
    // The ratchet's KEY FORMAT must match what the scanner emits, or a future
    // entry silently excuses nothing and the check fails on code it was told
    // about. Asserted against the format itself rather than against KNOWN's
    // contents - the first version required membership, which broke the day
    // the list legitimately emptied (its success state failing its own test).
    const shape = scan('for (const c of xs) await OPS.saveCounters(c.id);\n',
        'src/workers/collector.ts')[0];
    if (shape && shape.key === 'src/workers/collector.ts:saveCounters') {
        pass++; console.log('  ok   ratchet key format matches the scanner');
    } else { fail++; console.log(`  FAIL ratchet key format drifted - scanner produced '${shape?.key}'`); }
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0;
}

const args = process.argv.slice(2);
if (args.includes('--self-test')) {
    process.exit(selfTest() ? 0 : 1);
}

const root = args[args.indexOf('--check') + 1] ?? 'src';
const found = [];
for (const file of walk(root)) {
    const rel = file.replace(/\\/g, '/');
    found.push(...scan(readFileSync(file, 'utf8'), rel));
}
const fresh = found.filter((h) => !KNOWN.has(h.key));
const stale = [...KNOWN].filter((k) => !found.some((h) => h.key === k));

if (fresh.length > 0) {
    console.error('\nREFUSING: awaited per-item database call inside a loop.\n');
    console.error('This is the shape that cost 426 GB/day of device writes and hid for');
    console.error('three weeks behind healthy-looking instruments. Batch it into one');
    console.error('statement, or skip it when nothing changed - a statement that modifies');
    console.error('no rows assigns no transaction id, writes no WAL, and never fsyncs.\n');
    for (const h of fresh) console.error(`  ${h.rel}:${h.line}  await ...${h.fn}()`);
    console.error('\nIf it is genuinely correct, add WRITE-IN-LOOP-OK: <reason> beside it.');
    process.exit(1);
}
if (stale.length > 0) {
    console.error('\nREFUSING: the known-violations list names sites that no longer exist:');
    for (const k of stale) console.error(`  ${k}`);
    console.error('\nA fix landed - delete the line from KNOWN so the ratchet cannot slip back.');
    process.exit(1);
}
console.log(`ok - no new per-item writes in loops (${found.length} known, tracked)`);
