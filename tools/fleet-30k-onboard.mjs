// Onboard the 30k ceiling fleet through the REAL probe-then-add flow.
//
//   RSC_URL=http://127.0.0.1:18080 RSC_COOKIE=/tmp/c \
//     node tools/fleet-30k-onboard.mjs --host 192.0.2.70 --tier dense --dry-run
//
// WHY A SCRIPT AND NOT A PASTE. /api/devices/probe takes ONE port for the
// whole batch (`hosts.map(h => ({ host: h, port, ... }))`), and this fleet is
// 1,550 mock agents on distinct PORTS of a few hosts, so a tier cannot be one
// paste. It is one probe-then-add per port, run with a small amount of
// concurrency.
//
// IT USES THE PRODUCT'S OWN PATH ON PURPOSE. Inserting 1,550 rows with SQL
// would be faster and would prove nothing: onboarding is where the codes are
// minted, the entities enumerated, the tracked-ifType policy applied and the
// credential bound. A fleet built by hand around that path would be a fleet
// the product never actually accepted, and the run would be measuring
// something the operator can never reproduce. Slower, honest, and it exercises
// U6's central claim - a device that did not answer cannot be added - 1,550
// times before the run starts.
//
// THE DEAD TIER IS EXPECTED TO FAIL, and that is the point. Those ports have
// nothing listening, so probe refuses them and they are NOT added. To make a
// device that exists and does not answer, add it while its agent is running
// and then stop the agent - which is what a dead switch is. --tier dead
// therefore prints instructions rather than pretending, because a script that
// silently produced nothing here would read as success.

import fs from 'node:fs';

const args = Object.fromEntries(
    process.argv.slice(2).flatMap((a, i, all) =>
        a.startsWith('--') ? [[a.slice(2), all[i + 1]?.startsWith('--') !== false ? true : all[i + 1]]] : []),
);
const URL_BASE = process.env.RSC_URL ?? 'http://127.0.0.1:18080';
const COOKIE = process.env.RSC_COOKIE ?? '';
const DRY = args['dry-run'] === true;
const CONC = Number(args.concurrency ?? 8);

const TIERS = {
    dense:  { count: 292, base: 16100 },
    mid:    { count: 210, base: 16600 },
    sparse: { count: 1048, base: 17000 },
    dead:   { count: 78,  base: 17970 },
};

const host = args.host;
const tier = args.tier;
const credentialRef = args.credential ?? '';
if (typeof host !== 'string' || TIERS[tier] === undefined) {
    console.error('usage: --host <ip> --tier <dense|mid|sparse|dead> [--credential <ref>] [--dry-run] [--concurrency N]');
    process.exit(2);
}

// `#HttpOnly_` IS NOT A COMMENT, and treating it as one cost the first run of
// this script 330 straight 401s. curl writes HttpOnly cookies into the jar with
// that prefix, and RSCanvas's session cookie is HttpOnly by design - so the
// naive "skip lines starting with #" filter drops precisely the cookie that
// matters and keeps every one that does not.
const cookieHeader = COOKIE !== '' && fs.existsSync(COOKIE)
    ? fs.readFileSync(COOKIE, 'utf8').split('\n')
        .filter((l) => l.trim() !== '' && !l.startsWith('# '))
        .map((l) => l.replace(/^#HttpOnly_/, ''))
        .map((l) => { const f = l.split('\t'); return f.length >= 7 ? `${f[5]}=${f[6]}` : ''; })
        .filter((c) => c !== '').join('; ')
    : '';

async function api(path, body) {
    const res = await fetch(`${URL_BASE}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', ...(cookieHeader ? { cookie: cookieHeader } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
}

if (tier === 'dead') {
    const { count, base } = TIERS.dead;
    console.log(`The dead tier is the LAST ${count} sparse ports: ${host}:${base}-${base + count - 1}.`);
    console.log('It is not onboarded separately, and there is nothing here to run.');
    console.log('');
    console.log('  1. onboard the sparse tier normally - these ports answer, and must');
    console.log('  2. THEN kill those agents, so the devices go down having once been up');
    console.log('  3. confirm the roster shows them down, and leave them down for the run');
    console.log('');
    console.log('The order is the point. A device that never answered CANNOT be added -');
    console.log('U6 refuses it, correctly - so a dead device has to be one the product');
    console.log('accepted and then lost, not a row inserted around the check that would');
    console.log('have stopped it. Building it the other way would test an inventory the');
    console.log('product cannot produce, and 5% of the fleet would be fictional.');
    process.exit(0);
}

const { count, base } = TIERS[tier];
const ports = Array.from({ length: count }, (_, i) => base + i);
console.log(`${DRY ? '[DRY RUN] ' : ''}tier=${tier} host=${host} ports ${base}-${base + count - 1} (${count}) concurrency=${CONC}`);

let added = 0, known = 0, refused = 0, failed = 0;
const failures = [];
const collisions = [];

async function onboardPort(port) {
    if (DRY) return;
    const probe = await api('/api/devices/probe', {
        hosts: [host], port, version: '2c', ...(credentialRef ? { credentialRef } : {}),
    });
    const dev = (probe.body.devices ?? [])[0];
    if (probe.status !== 200 || dev === undefined) { failed++; failures.push(`${port}: probe http ${probe.status}`); return; }
    if (dev.ok !== true) { refused++; failures.push(`${port}: ${String(dev.error ?? 'did not answer').slice(0, 60)}`); return; }
    // `known` WAS HOST-SCOPED, and this fleet is one host: every mock agent
    // lives on the same IP at a different PORT, so the moment one device
    // existed on 127.0.0.1 the probe reported `known:true` for all 1,549
    // others - and an earlier version of this script duly "skipped" 90
    // devices it had never added. It was written off here as the harness
    // standing outside the flag's shape; it was an RSCanvas defect, which the
    // operator met in the UI (a greyed-out row for 198.18.50.2:16101) and
    // which was fixed on 2026-09-28: `known` now means the same address AND
    // port (probeStanding, src/devices/onboard.ts).
    //
    // The ADD still decides, not the probe. It is ON CONFLICT DO NOTHING
    // underneath and reports what it actually wrote, which makes a rerun safe
    // without needing a pre-check that cannot see ports.
    const add = await api('/api/devices', { probeToken: probe.body.probeToken, accept: [host] });
    if (add.status !== 200) { failed++; failures.push(`${port}: add http ${add.status}`); return; }
    if ((add.body.added ?? []).length > 0) { added++; return; }
    // AN ADD THAT WROTE NOTHING IS NOT AUTOMATICALLY BENIGN, and reading it as
    // benign is what wrecked the first attempt at this run. Devices are unique
    // by NAME - not by host:port - so a zero-row add means EITHER a genuine
    // rerun OR a different device that answers to the same sysName. The route
    // could not tell those apart for the fork's whole life ("already known"
    // for both); since 2026-09-01 (ruling 5) it CAN, and a collision comes
    // back naming the incumbent's host:port - which flows straight into the
    // report below, so a rerun of this harness now says WHICH device owns a
    // stolen name instead of a count of anonymous vanishings. The zero-must-
    // be-zero assertion stands unchanged: on a fresh fleet neither form of
    // zero-row add should occur at all.
    //
    // The generator used to name agents by their index WITHIN the process, so
    // eight processes all minted lab-node-001 upward. 1,235 devices collided,
    // every one came back "already known", and this script counted them as
    // fine and printed ALL TIERS COMPLETE over a third of a fleet. mock-fleet
    // now names by PORT, which is unique by construction - so on a fresh fleet
    // this counter must be ZERO, and any other number is the same bug back.
    known++;
    const why = (add.body.skipped ?? [])
        .map((s) => String((s ?? {}).why ?? '')).find((w) => w !== '') ?? 'add wrote nothing';
    collisions.push(`${port}: ${why}`);
}

const queue = [...ports];
await Promise.all(Array.from({ length: CONC }, async () => {
    for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
        await onboardPort(p);
        const done = added + known + refused + failed;
        if (done % 100 === 0 && done > 0) console.log(`  ${done}/${count}  added=${added} known=${known} refused=${refused} failed=${failed}`);
    }
}));

console.log('');
console.log(`${DRY ? '[DRY RUN] would probe ' + count + ' ports' : `added=${added} already-known=${known} refused=${refused} failed=${failed}`}`);
if (failures.length > 0) {
    console.log(`first ${Math.min(10, failures.length)} problems:`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f}`);
    // Named rather than summarised, because "1,550 devices, 43 failed" tells an
    // operator nothing about whether the run can start.
}
if (known > 0) {
    console.log('');
    console.log(`WARNING: ${known} add(s) wrote nothing. On a fresh fleet this must be 0.`);
    console.log('Each one is a device the product did NOT take, reported as if it had:');
    for (const c of collisions.slice(0, 10)) console.log(`  ${c}`);
    console.log('Check that every agent answers to a DISTINCT sysName before rerunning -');
    console.log('  snmpget -v2c -c public -Ovq <host>:<port> 1.3.6.1.2.1.1.5.0');
    console.log('and only ignore this if you meant to rerun over a fleet already added.');
}
// EXIT NON-ZERO ON SILENT DROPS TOO, so a chained `a && b` stops here rather
// than onboarding the next tier over a fleet the last one never built.
process.exit(failed > 0 || known > 0 ? 1 : 0);
