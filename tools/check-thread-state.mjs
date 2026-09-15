// Module-level mutable state, reachable from more than one thread, silently forks.
//
//   node tools/check-thread-state.mjs --self-test
//   node tools/check-thread-state.mjs --check src            # enforce, exit 1 on a violation
//   node tools/check-thread-state.mjs <dir> [more dirs...]    # report only, for the parents
//
// THE CLASS. In one process, `require('./poller')` from an HTTP handler reaches
// the same module instance the poll loop is mutating. Move the poll loop to a
// worker thread and that require loads a SECOND COPY, with its own empty Maps
// and its own initial counters. No error. No type failure. `health()` just
// reports green forever, `deviceRemoved()` has no effect, and `settingsChanged()`
// clears a cache in the wrong thread.
//
// ---------------------------------------------------------------------------
// WHY THIS FILE OPENS WITH A SELF-TEST, and why "assert the fault occurred" was
// not enough.
//
// The falsification rule this project runs on is: make the instrument prove the
// fault ARRIVED, or a pass means nothing. That works for a TEST, which has a
// specific fault to inject. It does not work for a SCANNER, whose output is
// "here is everything of type X" - there is no fault to assert, and **"found
// nothing" is indistinguishable from "cannot see anything."**
//
// This tool proved that on itself. Pointed at RSCanvas it reported clean, and it
// was wrong: `src/auth/index.ts` holds the per-IP login rate limiter and the
// import matcher was `\./${base}`, which only matched same-directory imports.
// `main.ts` imports './auth/index.ts', so the pattern looked for './index' and
// missed. It was caught only because there was an INDEPENDENT PREDICTION to
// check against - someone had named the rate limiter specifically. Without that,
// "clean" would have been believed, and the tool would have gone on reporting
// clean forever on every project that uses directories.
//
// So the scanner equivalent of the falsification rule is: **validate against a
// known positive it is expected to find.** `--self-test` plants a crossing
// through a subdirectory in a temp fixture and asserts this tool reports it.
// That check would have failed on the day the tool was written.
//
// Same principle as the control at the top of tools/test-emitters.ts: if a bare
// emitter did not throw, every other assertion in that file would pass for the
// wrong reason.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Modules whose state is per-thread ON PURPOSE.
 *
 * Everything else that is reachable from more than one thread is a violation,
 * not a judgement call. This list is the whole judgement, in one place, and
 * adding to it is a decision someone has to write down.
 *
 * - safety.ts   `installed` guards against installing the process handler twice
 *               WITHIN a thread. Every thread needs its own.
 * - store/pool.ts `runtimes` is the per-thread connection pools. Each thread
 *               owning its own pools IS the architecture; sharing them would be
 *               the bug.
 */
// credentials/crypto.ts caches a scrypt-DERIVED key per thread. Every thread
// derives the identical key from the identical RSCANVAS_SECRET, so two copies
// are two copies of the same value and neither can drift - the source of truth
// is the environment, not the cache. main encrypts on write, the collector
// decrypts on read; neither needs the other's cache to agree because both are
// pure functions of the same input.
// credentials/v3.ts caches whether THIS PROCESS's OpenSSL can perform single
// DES (slice 38). Every thread runs inside one process and asks one OpenSSL,
// so the per-thread copies are copies of the same immutable process fact and
// cannot drift. Caching at all is only to keep a createCipheriv attempt out of
// a validator that runs on every profile save; the answer cannot change
// without a restart, which is also when the caches vanish.
const PER_THREAD_BY_DESIGN = ['safety.ts', 'store/pool.ts', 'credentials/crypto.ts', 'credentials/v3.ts'];

/** Module-level mutable bindings: `let`/`var` at column 0, and mutable const containers. */
const STATE = /^(?:let|var)\s+([A-Za-z_$][\w$]*)|^const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new Map|new Set|new WeakMap|\[\]|\{\})/;

const rel = (root, f) => path.relative(root, f).replace(/\\/g, '/');

function scan(dir) {
    const out = [];
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
            if (e.name === 'node_modules' || e.name === '.git' || e.name === 'public') continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (/\.(js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
        }
    };
    walk(dir);
    return out;
}

/** Files this file imports, resolved to absolute paths that exist in `files`. */
function importsOf(file, files) {
    const src = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    const out = [];
    for (const m of src.matchAll(/(?:require\(|from\s*)['"](\.[^'"]+)['"]/g)) {
        const base = path.resolve(dir, m[1]);
        for (const cand of [base, `${base}.ts`, `${base}.js`, `${base}.mjs`,
            path.join(base, 'index.ts'), path.join(base, 'index.js')]) {
            if (files.includes(cand)) { out.push(cand); break; }
        }
    }
    return out;
}

/** Which module-level mutable bindings each file holds. */
function statefulMap(files) {
    const m = new Map();
    for (const f of files) {
        const names = [];
        for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
            const g = STATE.exec(line);
            if (g) names.push(g[1] || g[2]);
        }
        if (names.length > 0) m.set(f, names);
    }
    return m;
}

/** Everything reachable from an entry point, transitively. */
function reachable(entry, files) {
    const seen = new Set();
    const stack = [entry];
    while (stack.length > 0) {
        const f = stack.pop();
        if (seen.has(f)) continue;
        seen.add(f);
        for (const d of importsOf(f, files)) stack.push(d);
    }
    return seen;
}

// --- report mode, for the parent repos ----------------------------------------

function report(roots) {
    let findings = 0;
    for (const root of roots) {
        console.log(`\n=== ${root} ===`);
        const files = scan(root);
        const stateful = statefulMap(files);
        for (const [f, names] of stateful) {
            const importers = [];
            for (const other of files) {
                if (other === f) continue;
                if (!importsOf(other, files).includes(f)) continue;
                const src = fs.readFileSync(other, 'utf8');
                const spec = rel(path.dirname(other), f).replace(/\.(js|mjs|ts)$/, '')
                    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const aliasRe = new RegExp(`import\\s+\\*\\s+as\\s+([A-Za-z_$][\\w$]*)\\s+from\\s*['"]\\.?/?${spec}`);
                const alias = aliasRe.exec(src)?.[1] ?? path.basename(f).replace(/\.(js|mjs|ts)$/, '');
                const calls = new Set();
                for (const m of src.matchAll(new RegExp(`\\b${alias}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g'))) calls.add(m[1]);
                importers.push({ file: rel(root, other), calls: [...calls] });
            }
            if (importers.length === 0) continue;
            findings++;
            console.log(`\n  ${rel(root, f)}`);
            console.log(`    holds ${names.length} module-level mutable binding(s): ${names.slice(0, 8).join(', ')}`);
            for (const i of importers) {
                console.log(`    <- ${i.file}: ${i.calls.length > 0 ? i.calls.join('(), ') + '()' : '(imported, no direct calls)'}`);
            }
        }
    }
    console.log(`\n${findings} stateful module(s) imported across a module boundary.`);
    console.log('Each is a silent fork if the two sides land in different threads.');
    return 0;
}

// --- check mode: enforce the documented invariant ------------------------------
//
// The constraint written down after the last audit was: the rate limiter and the
// export queue are safe BECAUSE HTTP handling is main-thread only, and a future
// slice that moves request handling into a worker breaks both silently.
//
// That was a documented invariant with no enforcement, which is the exact shape
// this project spent a day auditing out of its own docs. This is the enforcement.

function check(root) {
    const files = scan(root);
    const entries = files.filter((f) => {
        const r = rel(root, f);
        return r === 'main.ts' || /^workers\/[^/]+\.ts$/.test(r);
    });
    if (entries.length === 0) {
        console.error(`no thread entry points found under ${root} - expected main.ts and workers/*.ts`);
        return 2;
    }

    const perThread = new Map();
    for (const e of entries) perThread.set(rel(root, e), reachable(e, files));

    const stateful = statefulMap(files);
    const violations = [];
    console.log(`thread entry points: ${[...perThread.keys()].join(', ')}\n`);

    for (const [f, names] of stateful) {
        const r = rel(root, f);
        const threads = [...perThread.entries()].filter(([, set]) => set.has(f)).map(([t]) => t);
        if (threads.length < 2) continue;

        if (PER_THREAD_BY_DESIGN.some((a) => r === a || r.endsWith(`/${a}`))) {
            console.log(`  ok   ${r} is reachable from ${threads.length} threads, and is per-thread BY DESIGN`);
            continue;
        }
        violations.push({ file: r, names, threads });
    }

    if (violations.length === 0) {
        console.log('\nok - no stateful module is reachable from more than one thread,');
        console.log('     except the ones declared per-thread by design.');
        return 0;
    }

    console.error('\nREFUSING: stateful modules are reachable from more than one thread.\n');
    for (const v of violations) {
        console.error(`  ${v.file}`);
        console.error(`    holds: ${v.names.join(', ')}`);
        console.error(`    reachable from: ${v.threads.join(', ')}`);
    }
    console.error('\nEach thread gets its OWN copy of that state. Nothing errors; the two');
    console.error('sides simply stop being the same object. If this is intentional, add the');
    console.error('module to PER_THREAD_BY_DESIGN with the reason. If it is not, the state');
    console.error('belongs in the store or behind a typed message on workers/protocol.ts.');
    return 1;
}

// --- self-test: the known positive ---------------------------------------------

function selfTest() {
    console.log('scanner self-test: a planted crossing must be FOUND\n');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-scan-'));
    let pass = 0;
    let fail = 0;
    const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
    const bad = (l) => { fail++; console.log(`  FAIL ${l}`); };

    try {
        // THE CROSSING GOES THROUGH A SUBDIRECTORY, deliberately. That is the
        // exact shape the tool could not see, and a fixture that imports from
        // the same directory would have passed against the broken version.
        fs.mkdirSync(path.join(dir, 'auth'), { recursive: true });
        fs.mkdirSync(path.join(dir, 'workers'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'auth', 'index.ts'),
            'const failures = new Map();\nexport function loginAllowed() { return failures.size === 0; }\n');
        fs.writeFileSync(path.join(dir, 'main.ts'),
            "import * as auth from './auth/index.ts';\nauth.loginAllowed();\n");
        fs.writeFileSync(path.join(dir, 'workers', 'jobs.ts'),
            "import * as auth from '../auth/index.ts';\nauth.loginAllowed();\n");

        const files = scan(dir);
        const stateful = statefulMap(files);
        const target = files.find((f) => rel(dir, f) === 'auth/index.ts');

        if (stateful.has(target)) ok('the planted module is recognised as stateful');
        else bad('the planted module was not recognised as stateful');

        const mainReach = reachable(files.find((f) => rel(dir, f) === 'main.ts'), files);
        if (mainReach.has(target)) ok('reachable from main.ts THROUGH A SUBDIRECTORY - the case that was invisible');
        else bad('main.ts -> auth/index.ts was not resolved: subdirectory imports are invisible again');

        const workerReach = reachable(files.find((f) => rel(dir, f) === 'workers/jobs.ts'), files);
        if (workerReach.has(target)) ok('reachable from workers/jobs.ts via ../ as well');
        else bad('workers/jobs.ts -> ../auth/index.ts was not resolved');

        const code = check(dir);
        if (code === 1) ok('and check mode REFUSES it - the tool fails on a real crossing');
        else bad(`check mode returned ${code} for a genuine two-thread crossing`);

        // The control: a module reachable from only ONE thread must NOT fail,
        // or the check would refuse everything and prove nothing.
        fs.rmSync(path.join(dir, 'workers', 'jobs.ts'));
        if (check(dir) === 0) ok('and it PASSES once the second thread no longer reaches it');
        else bad('check mode still refused with only one thread reaching the state');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }

    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    return fail === 0 ? 0 : 1;
}

// --- entry ---------------------------------------------------------------------

const argv = process.argv.slice(2);
if (argv[0] === '--self-test') process.exit(selfTest());
else if (argv[0] === '--check') process.exit(check(path.resolve(argv[1] ?? 'src')));
else if (argv.length > 0) process.exit(report(argv));
else {
    console.error('usage: check-thread-state.mjs --self-test | --check <dir> | <dir> [...]');
    process.exit(2);
}
