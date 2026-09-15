// Duplicate keys in object literals: later silently wins, and the dead copy
// keeps taking edits.
//
// The live case that earned this checker (2026-09-01 review, client
// findings): DEVICE_SORTS in app.js carried `reach` twice and `application`
// twice, sixty lines apart. The two `reach` comparators DISAGREED about
// where a missing reach_state sorts (rank 2 vs rank 9), JavaScript kept
// whichever came last, and an edit to the first copy would have changed
// nothing while looking like it did. No eslint config exists in this repo
// and adding one for a single rule would add a dependency for a job the
// TypeScript compiler - already a devDependency, already in npm test's
// first command - can do exactly: parse, walk object literals, compare
// keys. Zero new packages, one honest parser instead of a regex that would
// cry wolf on computed keys.
//
// Spread elements, computed keys and getter/setter pairs are left alone -
// only two IDENTICAL static keys in one literal are the defect.
//
//   node tools/check-dupe-keys.mjs --self-test
//   node tools/check-dupe-keys.mjs --check public src

import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

function walkDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p, out);
        else if (/\.(ts|js|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

/** Every duplicate static key in every object literal of one source text. */
export function findDupeKeys(fileName, text) {
    const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
    const dupes = [];
    const visit = (node) => {
        if (ts.isObjectLiteralExpression(node)) {
            const seen = new Map();
            for (const prop of node.properties) {
                // Only plain properties and methods with STATIC names count;
                // spreads merge deliberately, computed keys are unknowable
                // here, and get/set pairs share a name by design.
                if (ts.isSpreadAssignment(prop)) continue;
                if (ts.isGetAccessor(prop) || ts.isSetAccessor(prop)) continue;
                const name = prop.name;
                if (name === undefined || ts.isComputedPropertyName(name)) continue;
                const key = ts.isStringLiteral(name) || ts.isNumericLiteral(name)
                    ? name.text : ts.isIdentifier(name) ? name.text : null;
                if (key === null) continue;
                const line = sf.getLineAndCharacterOfPosition(prop.getStart(sf)).line + 1;
                const prev = seen.get(key);
                if (prev !== undefined) {
                    dupes.push({ key, first: prev, second: line });
                } else {
                    seen.set(key, line);
                }
            }
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return dupes;
}

function check(dirs) {
    let bad = 0;
    let examined = 0;
    for (const dir of dirs) {
        for (const f of walkDir(dir)) {
            examined++;
            const dupes = findDupeKeys(f, fs.readFileSync(f, 'utf8'));
            for (const d of dupes) {
                bad++;
                console.error(`  ${f}: key "${d.key}" defined at line ${d.first} and again at `
                    + `line ${d.second} - the second silently wins and the first takes edits`);
            }
        }
    }
    // THE BLIND GUARD (afternoon audit, finding 11): zero files walked was
    // indistinguishable from a clean tree. A checker that examined nothing
    // has checked nothing, and says so as a failure - the same words as
    // check-lanes, which learned the rule first.
    if (examined === 0) {
        console.error('FAIL - no files examined; the checker is blind, which is a failure');
        process.exit(1);
    }
    if (bad > 0) {
        console.error(`FAIL - ${bad} duplicate object key(s)`);
        process.exit(1);
    }
    console.log(`ok - no duplicate object keys under ${dirs.join(', ')} (${examined} files)`);
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };

    // The planted defect is the LIVE one this checker was written for,
    // verbatim shape: two comparators under one key, sixty lines apart in
    // spirit, disagreeing about a fallback.
    const planted = `const S = {
        reach: (a, b) => (r[a.x] ?? 2) - (r[b.x] ?? 2),
        other: 1,
        reach: (a, b) => (r[a.x] ?? 9) - (r[b.x] ?? 9),
    };`;
    const d1 = findDupeKeys('planted.js', planted);
    if (d1.length === 1 && d1[0].key === 'reach') ok('the DEVICE_SORTS shape is caught');
    else bad('missed the planted duplicate', JSON.stringify(d1));

    const strings = 'const a = { "x-y": 1, "x-y": 2 };';
    if (findDupeKeys('s.js', strings).length === 1) ok('string-literal keys are compared too');
    else bad('string keys missed');

    // The false-positive half decides whether this survives contact.
    const fine = `const a = { x: 1, y: { x: 2 }, ...rest, [k]: 3, get z() { return 1; }, set z(v) {} };
        const b = { x: 5 };`;
    if (findDupeKeys('fine.js', fine).length === 0) {
        ok('nesting, spreads, computed keys and accessor pairs are NOT duplicates');
    } else bad('cried wolf', JSON.stringify(findDupeKeys('fine.js', fine)));

    const ts2 = 'interface Q { x: number }\nconst c: Q = { x: 1 };';
    if (findDupeKeys('t.ts', ts2).length === 0) ok('typescript parses as typescript');
    else bad('typescript false positive');

    console.log(`${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--check') check(process.argv.slice(3));
else { console.error('usage: check-dupe-keys.mjs --self-test | --check <dir>...'); process.exit(2); }
