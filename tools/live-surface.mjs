#!/usr/bin/env node
// The live server's surface, checked from outside (KNOWN-ISSUES "tests owed":
// the unauthenticated-surface assertion and the malformed-parameter matrix;
// first run 2026-09-28 against rs-test-2).
//
//   node tools/live-surface.mjs --self-test
//   NODE_TLS_REJECT_UNAUTHORIZED=0 RSCANVAS_PASSWORD=... \
//       node tools/live-surface.mjs --url https://127.0.0.1:18080 --src src/main.ts [--user admin]
//
// The routes are READ FROM main.ts, not listed here, so a route added next
// month is covered without anyone remembering - and a parse that finds too
// few routes fails rather than passing on nothing (the blind-guard rule
// every checker in this repository follows).
//
// 1. SIGNED OUT, every route with GET, POST and DELETE: only the documented
//    public routes may answer anything but 401/403 (or 404/405 for a path or
//    method that does not exist), and the two sessionless health routes may
//    say nothing beyond {ok}.
// 2. SIGNED IN, every query parameter a GET route reads gets hostile values -
//    empty, junk, negative, huge, SQL, a NUL, 10,000 characters. Any 5xx, any
//    stack trace in a body, or any answer slower than 5 s is a finding.
// 3. SIGNED IN, every POST route gets invalid JSON and an oversized body -
//    the two inputs that cannot act, because they must fail before any
//    handler logic. Anything but a 4xx is a finding; a 200 means malformed
//    input was quietly read as something. Routes that remove, delete or log
//    out are skipped outright, and nothing sends a body that could parse.
//
// Exit 0 with no findings, 1 with any. The password comes from the
// environment, never the command line.
import fs from 'node:fs';

// --- reading the routes out of main.ts -----------------------------------------

export function extractRoutes(src) {
    const paths = new Set();
    for (const m of src.matchAll(/path === '(\/[a-z0-9/_-]*)'/g)) paths.add(m[1]);
    // Regex routes: const x = /^\/api\/boards\/([0-9]{1,19})\/tokens$/.exec(path)
    for (const m of src.matchAll(/\/\^((?:\\\/[^$]+))\$\/\.exec\(path\)/g)) {
        const sample = m[1].replace(/\\\//g, '/').replace(/\((?:[^()]|\([^()]*\))*\)\??/g, '1');
        paths.add(sample);
    }
    // Query parameters, per literal route: the searchParams names read between
    // a route's test and the next route's.
    const params = new Map();
    const marks = [...src.matchAll(/if \(path === '(\/[a-z0-9/_-]*)'([^\n]*)/g)];
    for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
        const block = src.slice(m.index, Math.min(end, m.index + 20000));
        const isGet = /method === 'GET'/.test(m[2]) || !/method ===/.test(m[2]);
        if (!isGet) continue;
        const names = new Set();
        for (const q of block.matchAll(/searchParams\.get\('([A-Za-z0-9_]+)'\)/g)) names.add(q[1]);
        if (names.size > 0) params.set(m[1], [...names]);
    }
    return { paths: [...paths].sort(), params };
}

// The documented public surface (ARCHITECTURE section 3; the startup banner).
// /api/me answers everyone: it is how the page learns whether it is signed
// in - and signed out it must say exactly that and nothing about anyone.
const PUBLIC = new Set(['/api/login', '/api/health/live', '/api/health/work', '/metrics', '/api/logout', '/api/me']);
// Never sent a body, whatever it is: they act on an empty one or end the session.
const NO_BODY = /remove|delete|logout|revoke/;

function selfTest() {
    const src = fs.readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
    const { paths, params } = extractRoutes(src);
    let fail = 0;
    const t = (label, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}`); if (!cond) fail++; };
    t(`reads the routes (${paths.length}), not a handful - a blind parse must fail`, paths.length >= 60);
    t('literal routes', paths.includes('/api/devices') && paths.includes('/api/report/traffic'));
    t('regex routes become sample paths', paths.includes('/api/boards/1/tokens'));
    t('query parameters are read per GET route', (params.get('/api/report/traffic') ?? []).includes('codes'));
    t('the public list names only real routes', [...PUBLIC].every((p) => paths.includes(p)));
    // The first sweep's worst finding, pinned where it would come back: a
    // route that turns an unreadable body into {} and acts on it.
    t('no route reads a failed body as {} (readJsonBody(...).catch)', !/readJsonBody\([^)]*\)\.catch\(/.test(src));
    const empty = extractRoutes('nothing here');
    t('an empty source yields nothing (and the live run refuses it)', empty.paths.length === 0);
    console.log(fail === 0 ? 'PASS' : 'FAIL');
    process.exit(fail === 0 ? 0 : 1);
}

// --- the live run --------------------------------------------------------------

const HOSTILE = ['', 'abc', '-1', '0', '1.5', 'NaN', '1e309', '99999999999999999999',
    "' OR 1=1 --", '%00', '\u0000', 'ΩΩΩ', '[]', 'x'.repeat(10000)];
const STACK = /\bat [A-Za-z_$][\w$.]* \(|\.ts:\d+:\d+|node:internal/;

async function main() {
    const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
    if (process.argv.includes('--self-test')) return selfTest();
    const base = arg('--url');
    const srcPath = arg('--src');
    const user = arg('--user') ?? 'admin';
    const password = process.env.RSCANVAS_PASSWORD;
    if (!base || !srcPath) { console.error('usage: --url https://host:port --src path/to/src/main.ts (RSCANVAS_PASSWORD in env)'); process.exit(2); }
    const { paths, params } = extractRoutes(fs.readFileSync(srcPath, 'utf8'));
    if (paths.length < 60) { console.error(`only ${paths.length} routes read from ${srcPath} - refusing to report on a blind parse`); process.exit(2); }

    const findings = [];
    const find = (what) => { findings.push(what); console.log(`  FINDING ${what}`); };
    const req = async (method, path, { cookie, body, type } = {}) => {
        const t0 = performance.now();
        try {
            const r = await fetch(base + path, {
                method, redirect: 'manual', signal: AbortSignal.timeout(15000),
                headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { 'content-type': type ?? 'application/json' } : {}) },
                ...(body !== undefined ? { body } : {}),
            });
            const text = await r.text();
            return { status: r.status, text, ms: performance.now() - t0 };
        } catch (err) {
            return { status: 0, text: String(err), ms: performance.now() - t0 };
        }
    };

    console.log(`1. signed out: ${paths.length} routes x GET, POST, DELETE`);
    let checked = 0;
    for (const p of paths) {
        for (const method of ['GET', 'POST', 'DELETE']) {
            if (method !== 'GET' && NO_BODY.test(p)) continue;
            const r = await req(method, p, method === 'POST' ? { body: '{}' } : {});
            checked++;
            if (r.status >= 500 || r.status === 0) { find(`${method} ${p} signed out -> ${r.status} ${r.text.slice(0, 120)}`); continue; }
            if (PUBLIC.has(p)) {
                const json = (() => { try { return JSON.parse(r.text); } catch { return null; } })();
                if ((p === '/api/health/live' || p === '/api/health/work') && r.status < 400 || p === '/api/health/work' && r.status === 503) {
                    const keys = json === null ? ['<not json>'] : Object.keys(json);
                    if (keys.some((k) => k !== 'ok')) find(`${method} ${p} signed out says more than {ok}: ${keys.join(',')}`);
                }
                if (p === '/api/me' && r.status === 200 && (json?.authenticated !== false || json?.user !== undefined)) {
                    find(`${method} /api/me signed out says more than "not signed in": ${r.text.slice(0, 120)}`);
                }
                continue;
            }
            if (![401, 403, 404, 405].includes(r.status)) find(`${method} ${p} signed out -> ${r.status} ${r.text.slice(0, 120)}`);
            if (STACK.test(r.text)) find(`${method} ${p} signed out shows a stack trace`);
        }
    }
    console.log(`   ${checked} requests`);

    if (!password) { console.log('RSCANVAS_PASSWORD not set - the signed-in half is skipped'); return done(findings); }
    const login = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    if (login.status !== 200 || cookie === '') { console.error(`sign-in as ${user} failed (${login.status})`); process.exit(2); }

    console.log(`2. signed in: ${[...params.values()].flat().length} query parameters on ${params.size} GET routes x ${HOSTILE.length} values`);
    checked = 0;
    let slowest = { ms: 0, what: '' };
    for (const [p, names] of params) {
        for (const name of names) {
            for (const v of HOSTILE) {
                const r = await req('GET', `${p}?${name}=${encodeURIComponent(v)}`, { cookie });
                checked++;
                const what = `GET ${p}?${name}=${JSON.stringify(v.length > 20 ? `${v.slice(0, 12)}...(${v.length})` : v)}`;
                if (r.ms > slowest.ms) slowest = { ms: r.ms, what };
                if (r.status >= 500 || r.status === 0) find(`${what} -> ${r.status} ${r.text.slice(0, 140)}`);
                else if (STACK.test(r.text)) find(`${what} -> a stack trace in the body`);
                else if (r.ms > 5000) find(`${what} took ${Math.round(r.ms)} ms`);
            }
        }
    }
    console.log(`   ${checked} requests, slowest ${Math.round(slowest.ms)} ms (${slowest.what})`);

    const posts = paths.filter((p) => p.startsWith('/api/') && !NO_BODY.test(p) && !PUBLIC.has(p));
    console.log(`3. signed in: ${posts.length} routes x POST {invalid JSON, 5 MB body}`);
    checked = 0;
    for (const p of posts) {
        for (const [label, body] of [['invalid JSON', '{"a": '], ['5 MB body', JSON.stringify({ x: 'y'.repeat(5_000_000) })]]) {
            const r = await req('POST', p, { cookie, body });
            checked++;
            if (r.status === 404 || r.status === 405) continue;
            // Refusing an oversized upload by closing the connection before it
            // finishes is a refusal too - the safe one, since draining a body
            // the server will not read is work an attacker chooses the size of.
            if (r.status === 0 && label === '5 MB body') continue;
            if (r.status >= 500 || r.status === 0) find(`POST ${p} with ${label} -> ${r.status} ${r.text.slice(0, 140)}`);
            else if (r.status < 400) find(`POST ${p} with ${label} -> ${r.status}: malformed input was accepted as something`);
            if (STACK.test(r.text)) find(`POST ${p} with ${label} -> a stack trace in the body`);
        }
    }
    console.log(`   ${checked} requests`);
    return done(findings);
}

function done(findings) {
    console.log(findings.length === 0 ? '\nPASS - no findings' : `\nFAIL - ${findings.length} finding(s)`);
    process.exit(findings.length === 0 ? 0 : 1);
}

main();
