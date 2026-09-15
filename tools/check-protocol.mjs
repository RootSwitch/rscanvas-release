// Worker-protocol coverage: every handled message type must have a sender.
//
// The class this guards (2026-09-01 review finding 5, its test item 13):
// main posted `stop` to ONE of four workers for the fork's whole life, so
// three careful stop handlers - the collector's sample drain among them -
// were dead code, and one of them carried a live defect that nothing could
// reach until the wiring landed and made it real. A handler nobody sends to
// is prose wearing an if-statement: it documents an intention, verifies
// nothing, and rots invisibly.
//
// Direction is deliberate: HANDLED-needs-SENDER only. The reverse (sent but
// unhandled) false-positives on main's generic `if (msg.stats)` absorption
// of `ran`-style messages, and the cost of an unread message is noise where
// the cost of a dead handler is a drain that never runs.
//
// KNOWN LIMIT, stated rather than discovered: matching is by LITERAL, repo
// wide, not by recipient. Two workers sharing a type name mask each other -
// the jobs worker's `run` handler has no sender today and passes because
// the EXPORT worker's `run` does. Catching that needs sender-target
// analysis (which worker variable the postMessage rides), and the masked
// case is recorded here until the literal one has paid for the upgrade.
//
// A handler that is deliberately unsent carries `// PROTOCOL-OK: <reason>`
// on its line or the line above; the marker is the exception being
// justified in writing, same as WRITE-IN-LOOP-OK.
//
//   node tools/check-protocol.mjs --self-test
//   node tools/check-protocol.mjs --check src

import fs from 'node:fs';
import path from 'node:path';

const HANDLED = /msg\.type\s*===\s*'([a-z-]+)'/g;
const SENDER_CALL = /postMessage\s*\(/g;

function walkDir(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkDir(p, out);
        else if (/\.(ts|mjs|cjs)$/.test(e.name)) out.push(p);
    }
    return out;
}

export function analyse(files) {
    /** type -> [{file, line, marked}] */
    const handled = new Map();
    const sent = new Set();
    for (const { name, text } of files) {
        const lines = text.split('\n');
        for (const m of text.matchAll(HANDLED)) {
            const line = text.slice(0, m.index).split('\n').length;
            const marked = /PROTOCOL-OK/.test(lines[line - 1] ?? '')
                || /PROTOCOL-OK/.test(lines[line - 2] ?? '');
            const list = handled.get(m[1]) ?? [];
            list.push({ file: name, line, marked });
            handled.set(m[1], list);
        }
        for (const m of text.matchAll(SENDER_CALL)) {
            // The type rides within the argument's opening object; 160 chars
            // covers every formatting in the tree without reaching into the
            // next statement.
            const window = text.slice(m.index, m.index + 160);
            const t = /type:\s*'([a-z-]+)'/.exec(window);
            if (t) sent.add(t[1]);
        }
    }
    const dead = [];
    for (const [type, sites] of handled) {
        if (sent.has(type)) continue;
        for (const s of sites) if (!s.marked) dead.push({ type, ...s });
    }
    return { dead, handledCount: handled.size, sentCount: sent.size };
}

function check(dir) {
    const files = walkDir(dir).map((f) => ({ name: f, text: fs.readFileSync(f, 'utf8') }));
    const { dead, handledCount, sentCount } = analyse(files);
    for (const d of dead) {
        console.error(`  ${d.file}:${d.line} handles msg.type '${d.type}' and NOTHING sends it - `
            + 'a dead handler documents an intention and verifies nothing. Wire a sender, '
            + 'delete the handler, or justify it with a PROTOCOL-OK marker');
    }
    // THE BLIND GUARD, the house rule check-lanes learned on its first live
    // run and this checker shipped without (afternoon audit, finding 11): a
    // handler regex that no longer matches after a refactor produced "0
    // handled" in the transcript and exit 0 in the verdict. A checker that
    // parsed nothing has checked nothing, and must say so as a failure.
    if (handledCount === 0) {
        console.error('FAIL - no handled message types parsed; the checker is blind, which is a failure');
        process.exit(1);
    }
    if (dead.length > 0) { console.error(`FAIL - ${dead.length} dead handler(s)`); process.exit(1); }
    console.log(`ok - every unmarked handled type has a sender (${handledCount} handled, ${sentCount} sent)`);
}

function selfTest() {
    let pass = 0, fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l, d) => { fail++; console.log(`  FAIL ${l}`, d ?? ''); };

    // The planted defect is finding 5's exact shape: a stop handler in a
    // worker, no sender anywhere.
    const worker = `parentPort?.on('message', (msg) => {
        if (msg.type === 'stats') { post(); return; }
        if (msg.type === 'stop') { drain(); }
    });`;
    const mainOk = `w.postMessage({ type: 'stats' });`;
    const r1 = analyse([{ name: 'w.ts', text: worker }, { name: 'm.ts', text: mainOk }]);
    if (r1.dead.length === 1 && r1.dead[0].type === 'stop') ok('a dead stop handler is caught');
    else bad('missed the dead handler', JSON.stringify(r1.dead));

    const withSender = mainOk + `\nw.postMessage({\n    type: 'stop',\n});`;
    const r2 = analyse([{ name: 'w.ts', text: worker }, { name: 'm.ts', text: withSender }]);
    if (r2.dead.length === 0) ok('a multiline sender counts - formatting is not a protocol change');
    else bad('cried wolf on a real sender', JSON.stringify(r2.dead));

    const marked = `// PROTOCOL-OK: manual hook, wired by hand when needed
        if (msg.type === 'reset') { zero(); }`;
    const r3 = analyse([{ name: 'w.ts', text: marked }]);
    if (r3.dead.length === 0) ok('a PROTOCOL-OK marker is the written justification');
    else bad('marker ignored');

    console.log(`${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

const mode = process.argv[2];
if (mode === '--self-test') selfTest();
else if (mode === '--check') check(process.argv[3] ?? 'src');
else { console.error('usage: check-protocol.mjs --self-test | --check <dir>'); process.exit(2); }
