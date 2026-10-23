// The README screenshots' answers, captured from a running instance by
// rendering the shots THROUGH it, then replayed without one.
//
// Capture (tools/make-screenshots.mjs --capture <url>): every API request the
// shots make is passed to the instance, signed in, and its answer is scrubbed
// and saved under the request's key - path and sorted query. So the recording
// holds exactly what the pictures ask for, and nobody maintains a route list.
// Replay (the default once docs/src/screenshots/recording/ exists): answers
// come from the files; a request with no answer is collected, and the run
// fails naming it rather than photographing an error.
//
// THE SCRUB. The demo network's own addresses are fiction (its ranges
// below), so any OTHER private address in an answer came from the lab around
// it - the box, the machine capturing - and refuses the capture. Named rules
// that rewrite the lab's own names live in tools/screenshots.local.mjs, never
// committed (shape in tools/screenshots.local.example.mjs); capture refuses
// to run without it. The same two rules the demo site's recorder applies.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** How far ahead of the capture's start the pictures' clock stands. */
const MARGIN_MS = 45_000;

const DEMO_RANGES = [['10.20.0.0', 16], ['10.31.0.0', 16], ['172.16.0.0', 16], ['172.31.0.0', 16], ['127.0.0.0', 8]];
// The 192.168/16 range is built from its parts ON PURPOSE: the public tree
// rewrites every literal 192.168 address and refuses any that remain, so a
// literal here would scan for a different range there.
const PRIVATE = [['10.0.0.0', 8], ['172.16.0.0', 12], [[192, 168, 0, 0].join('.'), 16], ['100.64.0.0', 10]];
const toInt = (ip) => ip.split('.').reduce((a, o) => a * 256 + Number(o), 0);
const inRange = (n, [base, bits]) => Math.floor(n / 2 ** (32 - bits)) === Math.floor(toInt(base) / 2 ** (32 - bits));

/** Private addresses in the text that are not the demo network's. */
export function foreignAddresses(text) {
    const out = new Set();
    for (const m of text.matchAll(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b/g)) {
        if (m.slice(1).some((o) => Number(o) > 255)) continue;
        const n = toInt(m[0]);
        if (PRIVATE.some((r) => inRange(n, r)) && !DEMO_RANGES.some((r) => inRange(n, r))) out.add(m[0]);
    }
    return [...out];
}

/** The request's key: its path and its query, sorted. */
export function keyOf(url) {
    const q = [...url.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return url.pathname + (q.length > 0 ? `?${q.map(([k, v]) => `${k}=${v}`).join('&')}` : '');
}
const fileOf = (key) => `${createHash('sha1').update(key).digest('hex').slice(0, 14)}.json`;

/** Replay a recording. answer() resolves null for a request it lacks. */
export function openRecording(dir) {
    const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    const missing = new Set();
    return {
        mode: 'recording', capturedAt: index.capturedAt, missing,
        async answer(url) {
            const file = index.routes[keyOf(url)];
            if (!file) { missing.add(keyOf(url)); return null; }
            return JSON.parse(fs.readFileSync(path.join(dir, 'r', file), 'utf8'));
        },
        finish() { /* nothing to write */ },
    };
}

/** Capture from a running instance into dir (emptied first). */
export async function openCapture(base, dir, { user, password }) {
    const LOCAL = path.join(import.meta.dirname, 'screenshots.local.mjs');
    if (!fs.existsSync(LOCAL)) {
        throw new Error('tools/screenshots.local.mjs is missing - it names the lab being captured (see screenshots.local.example.mjs)');
    }
    const local = await import(pathToFileURL(LOCAL).href);
    const login = await fetch(`${base}/api/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password }),
    });
    if (login.status !== 200) throw new Error(`sign-in to ${base} refused (${login.status})`);
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, 'r'), { recursive: true });
    // The pictures' clock: a little on from the start, so every answer
    // captured during the run is already in the past when they are rendered
    // - "30s ago", never "in 20s". 45 s, not the 90 it was (2026-10-23):
    // a device polled every 30 s read "last poll 2m ago" and its page said
    // STALE (three intervals, 90 s) in the README's own pictures. A run
    // takes about 16 s; finish() refuses one that outlasted the margin.
    const capturedAt = new Date(Date.now() + MARGIN_MS).toISOString();
    const routes = {};
    return {
        mode: 'capture', capturedAt, missing: new Set(),
        async answer(url) {
            const key = keyOf(url);
            const res = await fetch(base + url.pathname + url.search, { headers: { cookie } });
            let text = JSON.stringify({ status: res.status, body: JSON.parse(await res.text()) },
                (_k, v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(6)) : v));
            for (const [re, to] of local.SCRUB ?? []) text = text.replace(re, to);
            const left = [...(local.LEFTOVER ?? []).filter((re) => re.test(text)).map(String), ...foreignAddresses(text)];
            if (left.length > 0) throw new Error(`${key}: the lab shows through - ${left.join(', ')}`);
            routes[key] = fileOf(key);
            fs.writeFileSync(path.join(dir, 'r', routes[key]), text);
            return JSON.parse(text);
        },
        finish() {
            if (Date.now() > Date.parse(capturedAt)) {
                throw new Error(`the capture outlasted its clock's ${MARGIN_MS / 1000} s margin - some answers are later `
                    + 'than the time the pictures show and would read "in Ns"; run it again on a quieter box');
            }
            const sorted = Object.fromEntries(Object.entries(routes).sort(([a], [b]) => (a < b ? -1 : 1)));
            fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({
                capturedAt, source: 'the demo network, polled by a real RSCanvas', routes: sorted,
            }, null, 1) + '\n');
        },
    };
}
