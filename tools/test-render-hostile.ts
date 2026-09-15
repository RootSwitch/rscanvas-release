// The hostile round trip, U1's gate: device-controlled strings enter through a
// REAL SNMP agent, travel the real collector and the real database, and are
// then rendered by the SAME module the browser runs.
//
//   MOCK_EVIL=1 FLEET_SIZE=2 BASE_PORT=16900 node tools/mock-fleet.cjs &
//   (point a device at 127.0.0.1:16900, let it poll)
//   node tools/test-render-hostile.ts
//
// WHY A ROUND TRIP RATHER THAN A UNIT TEST OF AN ENCODER. ARCHITECTURE
// section 4 ties this to "the first module that renders or exports a device
// string", and the reason is that every layer between the wire and the screen
// is a chance to double-decode, re-encode, or hand the value to a different
// sink. tools/export-test.ts already has this shape for the CSV path -
// hostile datagrams through the real UDP socket, assertions on the bytes that
// come back out. This is its sibling for the render path.
//
// WHAT IT ASSERTS, and the two halves are different claims:
//
//   1. THE API RETURNS THE STRING INTACT. Not stripped, not HTML-encoded
//      server-side, not truncated at the first quote. Sanitising in the store
//      would be the WRONG fix - the string is data, the database is not a
//      display, and an operator looking at a compromised device's real
//      sysName needs to see what it actually says.
//   2. RENDERING IT PRODUCES TEXT, NEVER MARKUP. Every value reaches the DOM
//      through textContent; no element is ever constructed from a payload.
//
// HOW THE SECOND HALF IS CHECKED WITHOUT A BROWSER, stated plainly because the
// weakness would otherwise be hidden: node has no DOM, so this installs a
// RECORDING shim - createElement/appendChild/textContent that log what was
// done to them - and runs public/dom.js against it. A shim cannot prove that
// textContent refuses to parse HTML (that is the browser's guarantee, and
// asserting it here would only test the shim). What it CAN prove, and does,
// is that the shipped render path assigns through textContent and never
// through a parsing sink, and that the payload arrives at that assignment
// byte-identical. The other half of the guarantee is structural:
// check-dom-sinks.mjs refuses innerHTML and friends anywhere in public/, so
// there is no parsing sink for a value to reach. Two instruments, different
// failure modes, and neither alone is sufficient.

import { readFileSync } from 'node:fs';

const BASE = process.env.SOAK_BASE ?? 'http://127.0.0.1:18080';
const USER = process.env.UI_USER ?? 'admin';
const PASS = process.env.UI_PASS ?? 'rscanvas-demo-2026';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : JSON.stringify(d));
};

// --- the recording DOM shim ---------------------------------------------------

interface ShimNode {
    tag: string;
    className: string;
    children: ShimNode[];
    /** Every assignment, in order, with the sink that was used. */
    assigned: Array<{ sink: string; value: string }>;
}

const created: ShimNode[] = [];

function makeNode(tag: string): ShimNode {
    const node: ShimNode = { tag, className: '', children: [], assigned: [] };
    const proxy = new Proxy(node, {
        set(target, prop, value): boolean {
            if (prop === 'textContent') {
                target.assigned.push({ sink: 'textContent', value: String(value) });
                return true;
            }
            // Any OTHER string-ish sink is recorded under its own name, so an
            // innerHTML assignment would show up as one rather than being
            // silently accepted as if it were text.
            if (prop === 'innerHTML' || prop === 'outerHTML') {
                target.assigned.push({ sink: String(prop), value: String(value) });
                return true;
            }
            (target as unknown as Record<string, unknown>)[String(prop)] = value;
            return true;
        },
    });
    created.push(node);
    return proxy as unknown as ShimNode;
}

(globalThis as unknown as { document: unknown }).document = {
    createElement: (tag: string) => {
        const n = makeNode(tag) as unknown as ShimNode & {
            appendChild: (c: unknown) => void; classList: { add: () => void };
        };
        (n as unknown as Record<string, unknown>).appendChild = (c: ShimNode) => {
            n.children.push(c);
        };
        (n as unknown as Record<string, unknown>).classList = { add: () => {} };
        return n;
    },
    createTextNode: (text: string) => {
        const n = makeNode('#text');
        n.assigned.push({ sink: 'createTextNode', value: String(text) });
        return n;
    },
};

// --- the round trip -----------------------------------------------------------

let cookie = '';

async function req(path: string): Promise<{ status: number; body: any }> {
    const res = await fetch(`${BASE}${path}`, { headers: cookie ? { cookie } : {} });
    let body: any = null;
    try { body = await res.json(); } catch { /* null body */ }
    return { status: res.status, body };
}

const loginRes = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
});
const setCookie = loginRes.headers.get('set-cookie');
if (setCookie) cookie = setCookie.split(';')[0] as string;

if (loginRes.status !== 200) {
    console.log('  SKIP - could not log in (is the app running with the demo admin?)');
    process.exit(0);
}

// The payloads the poisoned agent serves, read from the harness itself so the
// two cannot drift apart: a test carrying its own copy of the strings would
// keep passing after somebody changed what the fleet sends.
const fleetSrc = readFileSync(new URL('./mock-fleet.cjs', import.meta.url), 'utf8');
const payloads = [...fleetSrc.matchAll(/^\s{4}(sysName|sysLocation|ifName|ifAlias|ifDescr):\s*(['"])(.*?)\2,/gm)]
    .map((m) => ({ field: m[1] as string, value: m[3] as string }));

if (payloads.length === 0) {
    bad('could not read EVIL_STRINGS out of tools/mock-fleet.js - the harness changed shape');
} else {
    ok(`read ${payloads.length} payload(s) from the fleet harness itself, not a local copy`);
}

// WHERE THE DEVICE-CONTROLLED STRINGS ACTUALLY LAND, corrected after the first
// run looked in the wrong place: `devices.name` is OPERATOR-assigned - it is
// what somebody typed when adding the device - so no payload can ever reach
// it. The fields an attacker who owns a device controls are the ENTITY ones,
// ifName / ifAlias / ifDescr, and those are exactly what the U1 drill-down
// renders. The version that searched the roster name would have passed
// forever without touching a hostile string: a test looking in the wrong
// place fails safe-looking, which is the worst way to fail.
const probe = process.env.EVIL_DEVICE ?? 'evil-probe';
const drill = await req(`/api/device?name=${encodeURIComponent(probe)}`);
const entities: Array<Record<string, unknown>> = drill.body?.entities ?? [];

if (entities.length === 0) {
    console.log(`  SKIP - device "${probe}" has no entities yet.`);
    console.log('         Start the fleet with MOCK_EVIL=1, add the device, restart the app');
    console.log('         (the collector caches its roster) and let a poll cycle complete.');
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

// 1. INTACT THROUGH THE API, each field against the payload the harness
//    actually serves for it.
const hostileEntity = entities[0] as Record<string, string | null>;
for (const [field, src] of [['name', 'ifName'], ['alias', 'ifAlias'], ['descr', 'ifDescr']] as const) {
    const want = payloads.find((p) => p.field === src);
    if (!want) continue;
    const got = String(hostileEntity[field] ?? '');
    if (got === want.value) {
        ok(`${src} survives the wire, the collector and the database BYTE-INTACT`);
    } else {
        bad(`${src} was altered in transit - something is sanitising DATA, the wrong layer`,
            { got, want: want.value });
    }
}

// 2. RENDERED AS TEXT.
// The SHIPPED module, imported rather than re-implemented - that is the whole
// point of extracting public/dom.js. Untyped (it is browser JS), so the shape
// is asserted by use rather than by the compiler.
// eslint-disable-next-line -- the module is browser JS with no .d.ts by design
const dom = await import('../public/dom.js' as string) as {
    cell: (t: string, c?: string) => unknown;
    pill: (t: string, c: string) => unknown;
    dotCell: (t: string, c: string) => unknown;
    rowEl: (cells: unknown[]) => unknown;
};
const { cell, pill, dotCell, rowEl } = dom;

created.length = 0;
rowEl([
    dotCell(String(hostileEntity.name ?? ''), 'ok'),
    cell(String(hostileEntity.alias ?? '')),
    cell(String(hostileEntity.descr ?? '')),
    pill(String(hostileEntity.name ?? ''), 'badge'),
]);

const allAssignments = created.flatMap((n) => n.assigned);
const parsingSinks = allAssignments.filter((a) => a.sink !== 'textContent' && a.sink !== 'createTextNode');
if (parsingSinks.length === 0) {
    ok(`every one of the ${allAssignments.length} value assignments went through textContent`);
} else {
    bad('a value reached a PARSING sink in the shipped render path', parsingSinks);
}

const rendered = allAssignments.map((a) => a.value);
for (const p of payloads) {
    if (!rendered.some((r) => r.includes(p.value))) continue;
    ok(`${p.field}'s payload reaches the DOM as TEXT, unmangled`);
}
const ifNameP = payloads.find((p) => p.field === 'ifName');
if (ifNameP && !rendered.some((r) => r.includes(ifNameP.value))) {
    bad('the ifName payload never reached a text assignment - the render path skipped it');
}

// No element was ever constructed FROM a payload: every created node's tag is
// one this code asked for, never one the payload named (img, script).
const forgedTags = created.filter((n) => !['td', 'tr', 'span', '#text'].includes(n.tag));
if (forgedTags.length === 0) {
    ok('no element was constructed from payload content - tags are code-controlled only');
} else {
    bad('an element tag came from data', forgedTags.map((n) => n.tag));
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
