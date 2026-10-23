#!/usr/bin/env node
// Screenshots of the web client for the README - rendered, not taken by hand.
//
//   node tools/make-screenshots.mjs              every shot, into docs/images/
//   node tools/make-screenshots.mjs dashboard    one of them
//
// RS-PROJECT-CONVENTIONS section 10: if a PNG ships in the repo, its source
// ships beside it, and every hero is shot at ONE canvas size. So nothing here
// is a screenshot anyone took. It serves THIS checkout's public/ - the real
// page - and answers its API from docs/src/screenshots/recording/: the demo
// network the online demo replays (Canvas Suite's company, polled by a real
// RSCanvas), each answer saved, scrubbed, as a capture asked for it. Then it
// drives headless Chrome or Edge over the DevTools protocol with Node's own
// WebSocket - no browser library, no dependency - at 1440x900, with the clock
// frozen at the capture's time and the zone fixed, so "2d ago" and "the 24
// hours to 10:00 PM" read the same on every run. Change the page, re-run
// this, and the README shows the page as it now is.
//
//   NODE_TLS_REJECT_UNAUTHORIZED=0 node tools/make-screenshots.mjs --capture https://<instance>:18080
//       render every shot THROUGH that instance, saving each answer, scrubbed,
//       to docs/src/screenshots/recording/ (tools/screenshot-recording.mjs)
//   node tools/make-screenshots.mjs
//       render from the recording - and fail on any request it has no answer for
//   --recording DIR, --out DIR    elsewhere than docs/src/screenshots/recording, docs/images
//
// The capture signs in as SHOTS_USER / SHOTS_PASSWORD (the demo account and
// the documented demo password unless set) - a lab instance, never a real one.
// Rendering from the recording signs in nowhere: /api/me answers as an admin,
// with that role's actions from src/auth/authorize.ts, and every write is
// refused. (Until 2026-10-23 a trimmed snapshot of the 30,000-entity lab,
// docs/src/screenshots/fixture/, stood in until the first recording; it went
// with that recording.)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionsFor } from '../src/auth/authorize.ts';
import { openCapture, openRecording } from './screenshot-recording.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const W = 1440, H = 900;
const ZONE = 'America/Chicago';

const ARGS = process.argv.slice(2);
const opt = (name) => { const i = ARGS.indexOf(name); return i === -1 ? null : ARGS[i + 1]; };
const OPTIONS = new Set(['--capture', '--recording', '--out']);
const WANTED = ARGS.filter((a, i) => !OPTIONS.has(a) && !(i > 0 && OPTIONS.has(ARGS[i - 1])));
const OUT = path.resolve(opt('--out') ?? path.join(ROOT, 'docs', 'images'));
const RECORDING = path.resolve(opt('--recording') ?? path.join(ROOT, 'docs', 'src', 'screenshots', 'recording'));
const CAPTURE = opt('--capture');

// Where the answers come from: a live instance being captured, or the
// recording of one.
if (!CAPTURE && !fs.existsSync(path.join(RECORDING, 'index.json'))) {
    console.error(`make-screenshots: no recording at ${RECORDING} - capture one with --capture https://<demo instance>:18080`);
    process.exit(1);
}
const SOURCE = CAPTURE
    ? await openCapture(CAPTURE.replace(/\/+$/, ''), RECORDING, {
        user: process.env.SHOTS_USER || 'demo', password: process.env.SHOTS_PASSWORD || 'rscanvas-demo-2026',
    })
    : openRecording(RECORDING);
const T = Date.parse(SOURCE.capturedAt);

// --- the page's server: the real client, the recording's answers -------------------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function serve(req, res) {
    const url = new URL(req.url ?? '/', 'http://x');
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const p = url.pathname;
    if (!p.startsWith('/api/')) {
        const name = p === '/' ? 'index.html' : path.basename(p);
        const file = path.join(PUBLIC, name);
        if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
        res.writeHead(200, { 'content-type': TYPES[path.extname(name)] ?? 'application/octet-stream' });
        res.end(fs.readFileSync(file));
        return;
    }
    if (req.method !== 'GET') { json(403, { ok: false, detail: 'screenshot server: read-only' }); return; }
    if (p === '/api/me') {
        json(200, { ok: true, authenticated: true, user: { username: 'admin', role: 'admin', can: actionsFor('admin') } });
        return;
    }
    try {
        const got = await SOURCE.answer(url);
        if (got) json(got.status, got.body);
        else json(404, { ok: false, detail: `screenshot server: the recording has no ${p}` });
    } catch (err) {
        SOURCE.missing.add(`${p}: ${err.message}`);
        json(502, { ok: false, detail: 'screenshot server: capture failed' });
    }
}

// --- a browser, and just enough of the DevTools protocol ----------------------------

const CANDIDATES = [
    process.env.CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

class Cdp {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map(); this.waiters = [];
        ws.addEventListener('message', (ev) => {
            const m = JSON.parse(String(ev.data));
            if (m.id && this.pending.has(m.id)) {
                const { ok, fail } = this.pending.get(m.id);
                this.pending.delete(m.id);
                if (m.error) fail(new Error(`${m.error.message} (${m.error.code})`)); else ok(m.result);
            } else if (m.method) {
                this.waiters = this.waiters.filter((w) => (w.method === m.method ? (w.ok(m.params), false) : true));
            }
        });
    }
    send(method, params = {}) {
        const id = ++this.id;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((ok, fail) => this.pending.set(id, { ok, fail }));
    }
    once(method) { return new Promise((ok) => this.waiters.push({ method, ok })); }
    /** Evaluate an expression in the page; awaits a returned promise. */
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
        return r.result.value;
    }
    async until(expression, what, ms = 20_000) {
        const end = Date.now() + ms;
        while (Date.now() < end) {
            if (await this.eval(`Boolean(${expression})`)) return;
            await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`timed out waiting for ${what}`);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The page's clock, frozen at the capture's time: every relative time
// on screen is computed against it, so a re-run renders the same words.
const freezeClock = `(() => {
    const T = ${T}; const Real = Date;
    function Frozen(...a) { if (!new.target) return new Real(T).toString(); return a.length ? new Real(...a) : new Real(T); }
    Frozen.prototype = Real.prototype; Frozen.now = () => T; Frozen.parse = Real.parse; Frozen.UTC = Real.UTC;
    window.Date = Frozen;
})();`;

// --- the shots -------------------------------------------------------------------------

const wait = 'const wait = (ms) => new Promise((r) => setTimeout(r, ms));';
// Scroll a panel to just under the sticky top bar - scrolling it to the very
// top left its heading behind the bar.
const under = (id) => `(() => { document.getElementById('${id}').scrollIntoView({ block: 'start' }); window.scrollBy(0, -(document.getElementById('topbar').offsetHeight + 12)); })()`;

// The demo network's pictures.
const SHOTS = [
    {
        name: 'dashboard', path: '/',
        ready: "document.querySelectorAll('#dash-rx tbody tr').length >= 10 && document.querySelectorAll('#dash-loc tbody tr').length > 0",
        setup: 'window.scrollTo(0, 0)',
    },
    {
        // Service health: the sites side by side, then the web and TCP checks.
        name: 'services', path: '/',
        ready: "document.querySelectorAll('#dash-sites tbody tr').length >= 3 && document.querySelectorAll('#dash-svcs tbody tr').length > 0",
        setup: under('dash-svc-panel'),
    },
    {
        // The services report: Branch 2's voice test over the last fortnight -
        // the spread that finds an intermittent site, one check in one screen.
        name: 'services-report', path: '/',
        ready: "document.querySelectorAll('#dash-sites tbody tr').length >= 3",
        setup: `(async () => {
            ${wait}
            const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('change')); };
            // The reports have their own tab since 2026-10-16.
            document.querySelector('.navbtn[data-section=reports]').click();
            for (let i = 0; i < 40 && document.getElementById('svc-report-panel').classList.contains('hidden'); i++) await wait(100);
            set('svc-report-kind', 'voice');
            const all = document.getElementById('svc-report-all');
            if (all.checked) { all.checked = false; all.dispatchEvent(new Event('change')); }
            for (let i = 0; i < 40 && !document.querySelector('#svc-report-pick input'); i++) await wait(100);
            const pick = [...document.querySelectorAll('#svc-report-pick label')].find((l) => l.textContent.includes('Voice to Branch 2'));
            const box = pick?.querySelector('input');
            if (box && !box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
            set('svc-report-period', 'last-14');
            // At the Wide width (2026-10-23): a fortnight's fourteen columns,
            // one line a row, are wider than the normal page, and the last
            // would be cut at the frame's edge. The class only - setWide()
            // would save it, and the shots after this one are normal width.
            document.body.classList.add('wide');
            document.getElementById('width-select').value = 'wide';
            document.getElementById('svc-report-run').click();
            for (let i = 0; i < 40 && !document.querySelector('#svc-report-table tbody tr'); i++) await wait(100);
            ${under('svc-report-panel')};
        })()`,
    },
    {
        // The GPU server, its first GPU's temperature chart open.
        name: 'device', path: '/#device=gpu-01',
        ready: "document.querySelectorAll('#sensor-cards .card').length >= 8",
        setup: `(async () => {
            ${wait}
            const card = [...document.querySelectorAll('#sensor-cards .card')].find((c) => c.textContent.includes('Temp: GPU0'));
            if (card) card.click();
            for (let i = 0; i < 60 && !document.querySelector('#chart-body svg'); i++) await wait(100);
            window.scrollTo(0, 0);
        })()`,
    },
    {
        name: 'devices', path: '/',
        ready: "document.querySelectorAll('#dash-rx tbody tr').length >= 10",
        setup: `(async () => {
            ${wait}
            document.querySelector('.navbtn[data-section=devices]').click();
            for (let i = 0; i < 40 && document.querySelectorAll('#devices tbody tr').length < 20; i++) await wait(100);
            window.scrollTo(0, 0);
        })()`,
    },
    {
        // The edge firewall's first two interfaces over the last week.
        name: 'report', path: '/',
        ready: "document.querySelectorAll('#dash-rx tbody tr').length >= 10 && document.getElementById('report-devices').childElementCount > 0",
        setup: `(async () => {
            ${wait}
            document.querySelector('.navbtn[data-section=reports]').click();
            for (let i = 0; i < 40 && document.getElementById('report-panel').classList.contains('hidden'); i++) await wait(100);
            const dev = document.getElementById('report-device');
            dev.value = 'edge-fw'; dev.dispatchEvent(new Event('change'));
            for (let i = 0; i < 40 && !document.querySelector('#report-pick input'); i++) await wait(100);
            for (const box of [...document.querySelectorAll('#report-pick input[type=checkbox]')].slice(0, 2)) {
                if (!box.checked) { box.checked = true; box.dispatchEvent(new Event('change')); }
            }
            const per = document.getElementById('report-period'); per.value = 'last-7'; per.dispatchEvent(new Event('change'));
            document.getElementById('report-run').click();
            for (let i = 0; i < 40 && !document.querySelector('#report-table tbody tr'); i++) await wait(100);
            ${under('report-panel')};
        })()`,
    },
    {
        // The NOC board: every location in its own section, the service
        // fields on the tiles that have checks.
        name: 'wall', path: '/wall.html?board=1',
        ready: "document.querySelectorAll('#wall .gtile').length >= 38",
        setup: 'window.scrollTo(0, 0)',
    },
    {
        name: 'system', path: '/',
        ready: "document.querySelectorAll('#dash-rx tbody tr').length >= 10",
        setup: `(async () => {
            ${wait}
            document.querySelector('.navbtn[data-section=system]').click();
            for (let i = 0; i < 40 && !document.getElementById('health-verdict').textContent; i++) await wait(100);
            window.scrollTo(0, 0);
        })()`,
    },
];

function pngSize(buf) {
    const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buf.length < 24 || SIG.some((b, i) => buf[i] !== b)) return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

async function main() {
    const ALL = SHOTS;
    const shots = WANTED.length ? ALL.filter((s) => WANTED.includes(s.name)) : ALL;
    if (shots.length === 0) throw new Error(`no such shot; have ${ALL.map((s) => s.name).join(', ')}`);
    const browser = CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch { return false; } });
    if (!browser) throw new Error('no Chrome or Edge found. Set CHROME=/path/to/browser');
    fs.mkdirSync(OUT, { recursive: true });

    const server = http.createServer(serve);
    await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${server.address().port}`;
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-shots-'));
    const chrome = spawn(browser, [
        '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
        '--no-default-browser-check', `--user-data-dir=${profile}`, '--remote-debugging-port=0', 'about:blank',
    ], { stdio: 'ignore' });
    try {
        const portFile = path.join(profile, 'DevToolsActivePort');
        for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
        // Read it once the browser has let go: on Windows the file can exist
        // and still be locked while Chrome writes it (EBUSY, 2026-10-23).
        let port = '';
        for (let i = 0; i < 50 && port === ''; i++) {
            try { port = fs.readFileSync(portFile, 'utf8').split('\n')[0]; } catch (err) {
                if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
                await sleep(100);
            }
        }
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        const pageTarget = targets.find((t) => t.type === 'page');
        const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
        await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = fail; });
        const cdp = new Cdp(ws);
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
        await cdp.send('Emulation.setTimezoneOverride', { timezoneId: ZONE });
        await cdp.send('Emulation.setLocaleOverride', { locale: 'en-US' });
        await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: freezeClock });

        for (const shot of shots) {
            // A blank page between shots, so each one is a fresh load of the
            // app rather than a hash change the page would treat as navigation.
            await cdp.send('Page.navigate', { url: 'about:blank' });
            const loaded = cdp.once('Page.loadEventFired');
            await cdp.send('Page.navigate', { url: base + shot.path });
            await loaded;
            try {
                await cdp.until(shot.ready, `${shot.name} to render`);
            } catch (err) {
                // Say what the page WAS showing: a timeout alone names the
                // wait, never the reason.
                const seen = await cdp.eval('document.body ? document.body.innerText.slice(0, 400) : "(no body)"').catch(() => '?');
                throw new Error(`${err.message}; the page said: ${JSON.stringify(seen)}`);
            }
            await cdp.eval(shot.setup);
            await sleep(500);
            const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
            const png = Buffer.from(data, 'base64');
            const size = pngSize(png);
            if (!size || size.w !== W || size.h !== H) {
                throw new Error(`${shot.name}: expected ${W}x${H}, got ${size ? `${size.w}x${size.h}` : 'not a PNG'}`);
            }
            fs.writeFileSync(path.join(OUT, `${shot.name}.png`), png);
            console.log(`  ${shot.name}.png  ${Math.round(png.length / 1024)} KB`);
        }
        ws.close();
    } finally {
        // Wait for the browser to be GONE before deleting its profile: on
        // Windows a killed Chrome holds its files for a moment, and a failed
        // delete thrown from here replaced whatever error the shots raised -
        // the first wall render reported EPERM on a temp folder instead of
        // what went wrong. Cleanup can warn; it must never mask the outcome.
        const exited = new Promise((ok) => chrome.once('exit', ok));
        chrome.kill();
        server.close();
        await Promise.race([exited, sleep(5000)]);
        try {
            fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
        } catch (err) {
            console.warn(`  (could not remove the browser profile ${profile}: ${err.message})`);
        }
    }
    if (SOURCE.missing.size > 0) {
        throw new Error(`the ${SOURCE.mode} could not answer ${SOURCE.missing.size} request(s):\n  ${[...SOURCE.missing].join('\n  ')}`);
    }
    SOURCE.finish();
    const from = `the ${SOURCE.mode === 'capture' ? 'capture' : 'recording'} at ${SOURCE.capturedAt}`;
    console.log(`done - ${shots.length} shot(s) at ${W}x${H} in ${path.relative(ROOT, OUT) || OUT}, from ${from}`);
}

main().catch((err) => { console.error(`make-screenshots: ${err.message}`); process.exit(1); });
