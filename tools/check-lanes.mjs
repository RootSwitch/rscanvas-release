// Lane conformance: every lane declared in lanes.ts has at least one
// caller, or says in writing that it is reserved.
//
// The class this guards (2026-09-01 review finding 8): the alerts lane was
// declared and SIZED - max 2, a 15s statement timeout, a written rationale
// ending "a later slice adding a caller should not also be re-litigating
// the sizing" - and then sat with zero callers for the fork's whole life
// while the scan ran on the jobs lane's null timeout, queueing behind
// rollup. The declaration was a promise nobody checked; ~30 slices passed
// before an archaeology pass noticed. A build failure the day a lane loses
// its last caller (or ships without one) turns that from archaeology into
// a diff comment.
//
// "Used" means the lane's literal is the first argument of laneQuery() or
// onLane() - the two acquisition paths - or, for `interactive`, a
// timedInteractive() call, which is that lane's dedicated wrapper. A lane
// that is deliberately dormant carries `// LANE-OK: <reason>` on the line
// above its entry in lanes.ts.
//
//   node tools/check-lanes.mjs --self-test
//   node tools/check-lanes.mjs --check src

import fs from 'node:fs';
import path from 'node:path';

function walkDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p, out);
        else if (/\.ts$/.test(e.name)) out.push(p);
    }
    return out;
}

export function declaredLanes(rawText) {
    // Entries of the LANES object: an identifier key at one indent level
    // followed by an open brace. The marker rides the line above.
    //
    // CR stripped first: a Windows checkout carries \r\n, `{\r` defeats an
    // end-anchored match, and this function's own blind-checker guard fired
    // on exactly that the first time it met a real checkout - which is why
    // the guard exists.
    const lanesText = rawText.replace(/\r/g, '');
    const out = [];
    const lines = lanesText.split('\n');
    // The object ends `};` or `} as const;` - both forms real, the second
    // the one actually shipped, and assuming the first is what made this
    // function blind on its first live run (the guard below caught it).
    const body = /export const LANES[\s\S]*?\n\}(?: as const)?;/.exec(lanesText);
    if (!body) return out;
    const start = lanesText.slice(0, body.index).split('\n').length;
    const end = start + body[0].split('\n').length;
    for (let i = start; i < end; i++) {
        const m = /^    ([a-z]+): \{/.exec(lines[i] ?? '');
        if (m) out.push({ lane: m[1], reserved: /LANE-OK/.test(lines[i - 1] ?? '') });
    }
    return out;
}

export function usedLanes(files) {
    const used = new Set();
    for (const { text } of files) {
        for (const m of text.matchAll(/\b(?:laneQuery|onLane)\s*(?:<[^>]*>)?\s*\(\s*'([a-z]+)'/g)) {
            used.add(m[1]);
        }
        if (/\btimedInteractive\s*(?:<[^>]*>)?\s*\(/.test(text)) used.add('interactive');
    }
    return used;
}

function check(dir) {
    const files = walkDir(dir).map((f) => ({ name: f, text: fs.readFileSync(f, 'utf8') }));
    const lanesFile = files.find((f) => f.name.endsWith(path.join('store', 'lanes.ts')));
    if (!lanesFile) { console.error('FAIL - src/store/lanes.ts not found'); process.exit(1); }
    const declared = declaredLanes(lanesFile.text);
    if (declared.length === 0) {
        console.error('FAIL - no lanes parsed from lanes.ts; the checker is blind, which is a failure');
        process.exit(1);
    }
    const used = usedLanes(files);
    const orphans = declared.filter((d) => !d.reserved && !used.has(d.lane));
    for (const o of orphans) {
        console.error(`  lane '${o.lane}' is declared and sized in lanes.ts and NOTHING acquires it - `
            + 'the alerts-lane shape. Route a caller onto it, or mark the entry LANE-OK with the reason '
            + 'it waits');
    }
    if (orphans.length > 0) { console.error(`FAIL - ${orphans.length} orphaned lane(s)`); process.exit(1); }
    console.log(`ok - every declared lane has a caller (${declared.length} lanes, `
        + `${[...used].sort().join(', ')})`);
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };

    const lanes = `export const LANES: Readonly<Record<Lane, LaneSpec>> = {
    collector: {
        max: 8,
    },
    // LANE-OK: reserved for the replication follow-on
    future: {
        max: 1,
    },
    alerts: {
        max: 2,
    },
};`;
    const decl = declaredLanes(lanes);
    if (decl.length === 3 && decl[1].reserved === true) ok('declarations and the LANE-OK marker parse');
    else bad('declaration parse broke', JSON.stringify(decl));

    // The planted defect is the finding-8 shape verbatim: alerts declared,
    // every caller on another lane.
    const code = `const a = laneQuery('collector', 'SELECT 1');
        const b = laneQuery<{ x: number }>('collector', 'SELECT 2');`;
    const used1 = usedLanes([{ name: 'ops.ts', text: code }]);
    if (!used1.has('alerts') && used1.has('collector')) ok('the zero-caller lane is visible');
    else bad('missed the orphan', [...used1].join(','));

    const withCaller = code + `\nconst c = onLane('alerts', async () => {});`;
    if (usedLanes([{ name: 'ops.ts', text: withCaller }]).has('alerts')) {
        ok('onLane counts as acquisition - the export lane is not an orphan');
    } else bad('onLane not counted');

    if (usedLanes([{ name: 'x.ts', text: 'timedInteractive(`SELECT 1`)' }]).has('interactive')) {
        ok('timedInteractive claims the interactive lane');
    } else bad('wrapper not counted');

    console.log(`${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--check') check(process.argv[3] ?? 'src');
else { console.error('usage: check-lanes.mjs --self-test | --check <dir>'); process.exit(2); }
