'use strict';
// Multi-agent SNMP fleet for scale testing SNMPCanvas.
//
// Runs FLEET_SIZE fake devices in ONE process, on consecutive UDP ports, so a
// few hundred targets cost one node process instead of a few hundred VMs. The
// shape of each device is a knob, because entities-per-device drives the sample
// rate as hard as device count does: one 48-port switch with 8 filesystems is
// 56 tracked entities, so twenty of those outweigh two hundred trivial hosts.
//
//   FLEET_SIZE=50 IFACES_PER=24 node mock-fleet.js
//
// Env:
//   FLEET_SIZE    devices to serve            (default 25)
//   BASE_PORT     first UDP port              (default 16100)
//   IFACES_PER    interfaces per device       (default 8)
//   STORAGE_PER   filesystems per device      (default 3)
//   CPUS_PER      processors per device       (default 2)
//   DEAD_PCT      percent of the port range left UNBOUND (default 10)
//   TICK_MS       counter movement interval   (default 5000)
//   RENAME_PCT    percent of interfaces whose ifName/ifDescr differ (default 0)
//   RESPONSE_MS   slowest device's reply time in ms; the fleet is spread
//                 deterministically across 0..RESPONSE_MS   (default 0 = instant)
//   TEMPS_PER     LM-SENSORS temperature rows per device    (default 0 = none)
//   SENSOR_MODE   how sensor values move over time         (default 'drift')
//                   drift  wander inside a band that never crosses a default
//                          threshold - the boring, healthy fleet
//                   step   SENSOR_STEP_PCT percent of sensors JUMP by a large
//                          fixed amount at SENSOR_STEP_AFTER_S seconds after
//                          boot and STAY there - the dead-fan case
//                   flap   SENSOR_FLAP_PCT percent of sensors oscillate across
//                          the default warn threshold every few ticks - the
//                          raise/clear churn case
//   SENSOR_STEP_PCT / SENSOR_FLAP_PCT   which fraction of sensors misbehave
//                                       (default 10)
//   SENSOR_STEP_AFTER_S                 seconds after boot before the step
//                                       (default 300)
//   SHIFT_INDEXES N   every ifIndex is offset by N while ifName stays put -
//                     a PCIe re-enumeration. Seed a fleet at 0, restart at N:
//                     Gi0/1 that was ifIndex 1 now arrives on ifIndex 1+N.
//                     The OPPOSITE of RENAME_PCT (same index, new name), and
//                     the case where an index-only poller splices one port's
//                     history onto another. (default 0)
//
// WHY THE SENSOR KNOBS EXIST. For three weeks the soak's cpu jittered inside
// 2..27%, storage sat at a constant 16% and 38%, RAM at 38%, and there was no
// temperature at all - so no sensor value in the fleet could ever cross a
// default threshold, and every threshold rule for cpu/mem/disk/temp got its
// first exercise on a real estate, where the first thing it produced was three
// classes of false positive. A fleet that cannot alarm is a fleet that cannot
// test alerting. These knobs make the alert machine's raise, clear, flap and
// device-down-freeze paths reachable at 400 devices, and give the two-window
// step detector something with a KNOWN onset to be measured against.
//
// RENAME_PCT exists to exercise SNMPCanvas's `stale` flag, which nothing else
// in this harness can reach. Seed a fleet at 0, then restart at N: the same
// ifIndexes come back under new names, which is exactly what a module swap or
// a reindex-on-reboot looks like from the poller's side.
//
// DEAD_PCT is the important one. A fleet of uniformly healthy clones is an
// optimistic fiction: real estates always contain boxes that are powered off or
// firewalled, and those cost a full SNMP timeout per poll while holding one of
// the poller's few concurrency slots. Leaving ports unbound reproduces that
// exactly - the socket simply never answers.

const snmp = require('net-snmp');

const int = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : d; };
const SIZE     = int(process.env.FLEET_SIZE, 25);
const BASE     = int(process.env.BASE_PORT, 16100);
const IFACES   = int(process.env.IFACES_PER, 8);
const STORES   = int(process.env.STORAGE_PER, 3);
const CPUS     = int(process.env.CPUS_PER, 2);
const DEAD_PCT = int(process.env.DEAD_PCT, 10);
const TICK_MS  = int(process.env.TICK_MS, 5000);
const RENAME_PCT = int(process.env.RENAME_PCT, 0);
const RESPONSE_MS = int(process.env.RESPONSE_MS, 0);
const SHIFT    = int(process.env.SHIFT_INDEXES, 0);
const TEMPS    = int(process.env.TEMPS_PER, 0);
const SENSOR_MODE = (process.env.SENSOR_MODE || 'drift').toLowerCase();
const STEP_PCT = int(process.env.SENSOR_STEP_PCT, 10);
const FLAP_PCT = int(process.env.SENSOR_FLAP_PCT, 10);
const STEP_AFTER_MS = int(process.env.SENSOR_STEP_AFTER_S, 300) * 1000;
if (!['drift', 'step', 'flap'].includes(SENSOR_MODE)) {
    console.error(`SENSOR_MODE must be drift, step or flap - got ${JSON.stringify(SENSOR_MODE)}`);
    process.exit(2);
}

// MOCK_EVIL: serve hostile strings from the DEVICE-CONTROLLED fields, so the
// XSS invariant can be tested end to end instead of asserted. Ported in spirit
// from SNMPCanvas's mock-agent MOCK_EVIL=1: the fields an operator never types
// (sysName, ifName, ifAlias, ifDescr, sysLocation) are exactly the ones an
// attacker who owns a device CAN set, and they land in HTML, JSON and CSV. A
// leading `=` is the CSV-formula payload; the rest are markup and a quote
// breakout. Applied to the first device only (i === 0) so the rest of the
// fleet stays measurable - one poisoned agent is all a round-trip test needs,
// and a whole poisoned fleet would drown the throughput numbers.
const EVIL = process.env.MOCK_EVIL === '1';
const EVIL_STRINGS = {
    // Each names the sink it targets, so a failure points at the fix.
    sysName:     '<script>alert(1)</script>evil-node',       // HTML: script tag
    sysLocation: 'Rack " onmouseover="alert(2)',             // HTML: attribute breakout
    ifName:      '"><img src=x onerror=alert(3)>',           // HTML: tag-then-event
    ifAlias:     '=cmd|&#39;/c calc&#39;!A1',                // CSV: leading-= formula
    ifDescr:     "'; DROP TABLE messages; --",               // SQL-shaped (must survive as literal text)
};

const OT = snmp.ObjectType;
const RO = snmp.MaxAccess['read-only'];
const c64 = (big) => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(big)); return b; };

// Deterministic dead set, so a re-run reproduces the same fleet: every Nth port
// is left unbound rather than picking at random.
const deadEvery = DEAD_PCT > 0 ? Math.max(2, Math.round(100 / DEAD_PCT)) : 0;
const isDead = (i) => deadEvery > 0 && i % deadEvery === deadEvery - 1;

const devices = [];   // { port, mib, ifaces:[{idx,mbps,util,oper}], counters:Map, bootMs }
// THE STEP CLOCK IS THE FLEET'S, NOT EACH DEVICE'S. bootMs is backdated per
// device by i minutes so sysUpTime staggers realistically - which meant the
// step's "seconds since boot" was already past its threshold at the first tick
// for every device with i >= STEP_AFTER_S/60. On a 100-device fleet with a
// 600s step, 38 of 40 chosen sensors were hot from their FIRST sample and the
// detector, correctly, saw no step in them. A one-device test could not show
// this because device 0 is not backdated. Measured 2026-08-18.
const FLEET_START_MS = Date.now();

function buildDevice(i) {
    const port = BASE + i;
    const agent = snmp.createAgent({ port, disableAuthorization: false }, (err) => {
        if (err) console.error(`agent ${port}: ${err.message}`);
    });
    const auth = agent.getAuthorizer();
    auth.addCommunity('public');
    const mib = agent.getMib();

    // How long THIS device takes to answer a request. Every measurement before
    // this knob existed used agents replying in under a millisecond - i.e. a
    // fleet made entirely of Catalyst-class kit, which is not an estate anyone
    // owns. Real agents differ by orders of magnitude: a switch with a real CPU
    // answers instantly, a PDU is a microcontroller, and a BMC is famously the
    // slowest thing in the rack. Since the poll loop's ceiling is slot-SECONDS,
    // response time multiplies straight into capacity.
    //
    // Spread deterministically across 0..RESPONSE_MS so the fleet contains both
    // fast and poky members rather than one uniform speed, and so a restart
    // reproduces the same fleet.
    //
    // The handler defers done() instead of computing anything: net-snmp counts
    // completed varbinds and sends the response from inside done(), so delaying
    // it delays the reply while leaving the value the MIB would have returned
    // untouched. All varbinds of one PDU wait in parallel, so a request costs
    // `delay`, not delay x varbinds - which is how a real agent behaves.
    const devDelayMs = RESPONSE_MS > 0 ? Math.round(RESPONSE_MS * (((i * 37) % 100) + 1) / 100) : 0;
    const slow = devDelayMs > 0
        ? { handler: (req) => setTimeout(() => req.done(), devDelayMs) }
        : {};

    const evil = EVIL && i === 0;
    const name = evil ? EVIL_STRINGS.sysName : `lab-node-${String(i + 1).padStart(3, '0')}`;
    for (const [n, oid, type, value] of [
        ['sysDescr', '1.3.6.1.2.1.1.1', OT.OctetString, `SNMPCanvas fleet mock - Linux ${name} 6.8.0 x86_64`],
        ['sysObjectID', '1.3.6.1.2.1.1.2', OT.OID, '1.3.6.1.4.1.8072.3.2.10'],
        ['sysUpTime', '1.3.6.1.2.1.1.3', OT.TimeTicks, 0],
        ['sysContact', '1.3.6.1.2.1.1.4', OT.OctetString, 'lab@example.net'],
        ['sysName', '1.3.6.1.2.1.1.5', OT.OctetString, name],
        // sysLocation drives zone grouping on import, so spread the fleet over
        // a few sites to keep the resulting board readable.
        ['sysLocation', '1.3.6.1.2.1.1.6', OT.OctetString,
            evil ? EVIL_STRINGS.sysLocation : `Lab / Rack ${1 + (i % 4)}`],
        // THE FOUR SNMP-FRAMEWORK ENGINE SCALARS, which every real agent
        // serves and which sit lexically AFTER every enterprise subtree.
        // Without them a GETBULK that runs off the end of this agent's tree
        // is answered with NoSuchInstance at the requested oid rather than
        // endOfMibView, and a walker re-asks it until its deadline - the
        // probe's 8s stall on every mock device (found by RSFleet,
        // DEMO-FLEET-PLAN section 11; the walker now also stops itself).
        // With them, the walk steps into 1.3.6.1.6.3.10 and ends honestly.
        ['snmpEngineID', '1.3.6.1.6.3.10.2.1.1', OT.OctetString, Buffer.from([0x80, 0x00, 0x1f, 0x88, 0x80, i & 0xff, (i >> 8) & 0xff, 0x01])],
        ['snmpEngineBoots', '1.3.6.1.6.3.10.2.1.2', OT.Integer, 1],
        ['snmpEngineTime', '1.3.6.1.6.3.10.2.1.3', OT.Integer, 0],
        ['snmpEngineMaxMessageSize', '1.3.6.1.6.3.10.2.1.4', OT.Integer, 65507]
    ]) {
        mib.registerProvider({ name: n, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO, ...slow });
        mib.setScalarValue(n, value);
    }

    mib.registerProvider({
        ...slow,
        name: 'ifTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.2.2.1',
        tableColumns: [
            { number: 1, name: 'ifIndex', type: OT.Integer, maxAccess: RO },
            { number: 2, name: 'ifDescr', type: OT.OctetString, maxAccess: RO },
            { number: 3, name: 'ifType', type: OT.Integer, maxAccess: RO },
            { number: 5, name: 'ifSpeed', type: OT.Gauge, maxAccess: RO },
            { number: 7, name: 'ifAdminStatus', type: OT.Integer, maxAccess: RO },
            { number: 8, name: 'ifOperStatus', type: OT.Integer, maxAccess: RO },
            { number: 10, name: 'ifInOctets', type: OT.Counter, maxAccess: RO },
            { number: 13, name: 'ifInDiscards', type: OT.Counter, maxAccess: RO },
            { number: 14, name: 'ifInErrors', type: OT.Counter, maxAccess: RO },
            { number: 16, name: 'ifOutOctets', type: OT.Counter, maxAccess: RO },
            { number: 19, name: 'ifOutDiscards', type: OT.Counter, maxAccess: RO },
            { number: 20, name: 'ifOutErrors', type: OT.Counter, maxAccess: RO }
        ],
        tableIndex: [{ columnName: 'ifIndex' }]
    });
    mib.registerProvider({
        ...slow,
        name: 'ifXTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.31.1.1.1',
        tableColumns: [
            { number: 1, name: 'ifName', type: OT.OctetString, maxAccess: RO },
            { number: 6, name: 'ifHCInOctets', type: OT.Counter64, maxAccess: RO },
            { number: 10, name: 'ifHCOutOctets', type: OT.Counter64, maxAccess: RO },
            { number: 15, name: 'ifHighSpeed', type: OT.Gauge, maxAccess: RO },
            { number: 18, name: 'ifAlias', type: OT.OctetString, maxAccess: RO }
        ],
        tableAugments: 'ifTable'
    });

    const ifaces = [];
    const counters = new Map();
    for (let n = 1; n <= IFACES; n++) {
        // A tenth of the ports are administratively up but operationally down -
        // exactly the shape that leaves speedBps null, which is the case that
        // caused the un-unmutable-interface bug in AlertCanvas.
        const oper = (n % 10 === 0) ? 2 : 1;
        const mbps = (n % 8 === 0) ? 10000 : 1000;
        const util = oper === 1 ? 0.05 + ((n * 7) % 40) / 100 : 0;
        // The WIRE index is n + SHIFT; the name below stays Gi0/n. Everything
        // internal keys on the wire index so the tick loop needs no change.
        const wireIdx = n + SHIFT;
        ifaces.push({ idx: wireIdx, mbps, util, oper });
        counters.set(wireIdx, { in: 0n, out: 0n, inDisc: 0, inErr: 0 });
        // RENAME_PCT reproduces the ONE thing that makes an entity go stale in
        // SNMPCanvas: an ifIndex that starts reporting a DIFFERENT ifName than
        // the one recorded at discovery - a module swapped, a VLAN interface
        // deleted and recreated, a chassis reindexed on reboot. The index is
        // reused, so the poller keeps polling it and gets someone else's
        // counters under the old name.
        //
        // Deterministic, not random: the same ports rename on every restart, so
        // "seed clean, restart with RENAME_PCT=N" is a repeatable experiment
        // rather than a different fleet each run. ifDescr moves with ifName
        // because real hardware changes both.
        const renamed = RENAME_PCT > 0 && ((i * 131 + n * 17) % 100) < RENAME_PCT;
        const ifName  = evil ? EVIL_STRINGS.ifName  : renamed ? `Te1/${n}` : `Gi0/${n}`;
        const ifDescr = evil ? EVIL_STRINGS.ifDescr : renamed
            ? `Broadcom BCM57810 port ${n}` : `Intel I350 port ${n}`;
        const ifAlias = evil ? EVIL_STRINGS.ifAlias : `link ${n}`;
        mib.addTableRow('ifTable', [wireIdx, ifDescr, 6,
            Math.min(mbps * 1e6, 4294967295), 1, oper, 0, 0, 0, 0, 0, 0]);
        mib.addTableRow('ifXTable', [wireIdx, ifName, c64(0), c64(0), mbps, ifAlias]);
    }

    mib.registerProvider({
        ...slow,
        name: 'hrProcessorTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.25.3.3.1',
        tableColumns: [
            { number: 1, name: 'hrProcessorFrwID', type: OT.Integer, maxAccess: RO },
            { number: 2, name: 'hrProcessorLoad', type: OT.Integer, maxAccess: RO }
        ],
        tableIndex: [{ columnName: 'hrProcessorFrwID' }]
    });
    for (let c = 0; c < CPUS; c++) mib.addTableRow('hrProcessorTable', [196608 + c, 10 + (c % 15)]);

    mib.registerProvider({
        ...slow,
        name: 'hrStorageTable', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.25.2.3.1',
        tableColumns: [
            { number: 1, name: 'hrStorageIndex', type: OT.Integer, maxAccess: RO },
            { number: 2, name: 'hrStorageType', type: OT.OID, maxAccess: RO },
            { number: 3, name: 'hrStorageDescr', type: OT.OctetString, maxAccess: RO },
            { number: 4, name: 'hrStorageAllocationUnits', type: OT.Integer, maxAccess: RO },
            { number: 5, name: 'hrStorageSize', type: OT.Integer, maxAccess: RO },
            { number: 6, name: 'hrStorageUsed', type: OT.Integer, maxAccess: RO }
        ],
        tableIndex: [{ columnName: 'hrStorageIndex' }]
    });
    mib.addTableRow('hrStorageTable', [1, '1.3.6.1.2.1.25.2.1.2', 'Physical memory', 4096, 4194304, 1594884]);
    for (let s = 1; s < STORES; s++) {
        mib.addTableRow('hrStorageTable', [s + 2, '1.3.6.1.2.1.25.2.1.4',
            `/mnt/vol${s}`, 4096, 122070312, 20000000 + s * 9000000]);
    }

    // LM-SENSORS temperatures, on the OIDs RSCanvas's discoverSensors walks
    // (lmTempSensorsDevice / lmTempSensorsValue, milli-degrees). Names follow
    // the real coretemp shape so the tempNameValid gate admits them.
    //
    // WHICH SENSORS MISBEHAVE IS DETERMINISTIC - device index and sensor
    // index, never Math.random() - because a step with an unknown onset and
    // an unknown subject cannot be measured against. A test that plants
    // "10% of sensors step at +300s" has to be able to name which ten.
    const temps = [];
    if (TEMPS > 0) {
        mib.registerProvider({
            name: 'lmTempSensorsTable', type: snmp.MibProviderType.Table,
            oid: '1.3.6.1.4.1.2021.13.16.2.1',
            tableColumns: [
                { number: 1, name: 'lmTempSensorsIndex', type: OT.Integer, maxAccess: RO },
                { number: 2, name: 'lmTempSensorsDevice', type: OT.OctetString, maxAccess: RO },
                { number: 3, name: 'lmTempSensorsValue', type: OT.Gauge, maxAccess: RO },
            ],
            tableIndex: [{ columnName: 'lmTempSensorsIndex' }],
        });
        for (let t = 0; t < TEMPS; t++) {
            // A healthy band that never reaches the default warn of 45C:
            // 32..40C baseline per sensor, jitter of about +-1C on top.
            const base = 32 + ((i * 7 + t * 3) % 9);
            // A TRUE FRACTION of the fleet, not "global sensor number under
            // PCT": the first draft used (i*TEMPS+t) % 100 < PCT, which on a
            // 4-device fleet made every sensor misbehave at 34%, because the
            // global numbers 0..11 are all under 34. Spread the chosen ones
            // evenly instead - every k-th sensor - so 10% means one in ten
            // whatever the fleet size, and small fleets get a sane count.
            const pct = SENSOR_MODE === 'step' ? STEP_PCT : SENSOR_MODE === 'flap' ? FLAP_PCT : 0;
            const g = i * TEMPS + t;
            const misbehaves = pct > 0 && (Math.floor(g * pct / 100) !== Math.floor((g - 1) * pct / 100) || (g === 0 && pct > 0));
            temps.push({ idx: t + 1, base, misbehaves, stepped: false });
            mib.addTableRow('lmTempSensorsTable', [t + 1, `coretemp-isa-0000 Core ${t}`, base * 1000]);
        }
    }

    devices.push({ port, mib, ifaces, counters, temps, bootMs: Date.now() - (i * 60000), fleetIndex: i });
}

let live = 0, dead = 0;
for (let i = 0; i < SIZE; i++) {
    if (isDead(i)) { dead++; continue; }
    try { buildDevice(i); live++; }
    catch (e) { console.error(`port ${BASE + i}: ${e.message}`); }
}

// ONE timer for the whole fleet. N intervals would spend more time in timer
// bookkeeping than in the work, and would make the generator itself the thing
// under measurement.
setInterval(() => {
    const now = Date.now();
    for (const d of devices) {
        d.mib.setScalarValue('sysUpTime', Math.floor((now - d.bootMs) / 10) % 4294967296);
        for (const i of d.ifaces) {
            if (i.oper !== 1 || i.util === 0) continue;
            const c = d.counters.get(i.idx);
            const bps = i.mbps * 1e6 / 8 * i.util;
            const jitter = 0.5 + Math.random();
            c.in += BigInt(Math.floor(bps * (TICK_MS / 1000) * jitter));
            c.out += BigInt(Math.floor(bps * (TICK_MS / 1000) * jitter * 0.35));
            if (Math.random() < 0.05) c.inDisc += 1;
            if (Math.random() < 0.02) c.inErr += 1;
            d.mib.setTableSingleCell('ifXTable', 6, [i.idx], c64(c.in));
            d.mib.setTableSingleCell('ifXTable', 10, [i.idx], c64(c.out));
            d.mib.setTableSingleCell('ifTable', 10, [i.idx], Number(c.in % 4294967296n));
            d.mib.setTableSingleCell('ifTable', 16, [i.idx], Number(c.out % 4294967296n));
            d.mib.setTableSingleCell('ifTable', 13, [i.idx], c.inDisc);
            d.mib.setTableSingleCell('ifTable', 14, [i.idx], c.inErr);
        }
        for (let c = 0; c < CPUS; c++) {
            d.mib.setTableSingleCell('hrProcessorTable', 2, [196608 + c],
                Math.max(2, Math.min(98, 12 + Math.floor(Math.random() * 30 - 15))));
        }

        // SENSOR MOVEMENT, by mode. Values are milli-degrees on the wire.
        //
        //   drift  base +- ~1C. Never reaches the default warn of 45C, so a
        //          drift fleet is a fleet where no temperature alert can fire -
        //          which is the correct baseline, and the one that was missing
        //          from the soak for three weeks (there were no temps at all).
        //   step   the chosen sensors read base until STEP_AFTER_MS past boot,
        //          then base+30 forever. +30 is the dead-fan case: a Mellanox
        //          NIC whose 40mm fan stopped ran exactly that much hotter and
        //          stayed there. Crosses warn (45) and usually crit (55), and
        //          the ONSET IS KNOWN, which is what a step detector needs to
        //          be measured against.
        //   flap   the chosen sensors alternate 43C / 47C on a 3-tick period,
        //          straddling the 45C warn - the raise/clear churn seen live
        //          as five clears in 73 minutes on one sensor. Every other
        //          sensor drifts as normal so the fleet is otherwise quiet.
        const sinceStart = now - FLEET_START_MS;
        for (const t of d.temps) {
            let c;
            if (t.misbehaves && SENSOR_MODE === 'step') {
                if (!t.stepped && sinceStart >= STEP_AFTER_MS) t.stepped = true;
                c = t.stepped ? t.base + 30 : t.base;
            } else if (t.misbehaves && SENSOR_MODE === 'flap') {
                c = (Math.floor(now / TICK_MS / 3) % 2 === 0) ? 43 : 47;
            } else {
                c = t.base + (Math.random() * 2 - 1);
            }
            d.mib.setTableSingleCell('lmTempSensorsTable', 3, [t.idx], Math.round(c * 1000));
        }
    }
}, TICK_MS);

const perDevice = IFACES + STORES + CPUS + TEMPS;
console.log(`fleet up: ${live} live agents on udp/${BASE}-${BASE + SIZE - 1}, ${dead} dead ports (timeouts by design)`);
console.log(`per device: ${IFACES} interfaces + ${STORES} storage + ${CPUS} cpu + ${TEMPS} temps = ~${perDevice} pollable entities`);
if (TEMPS > 0) {
    // SAY WHICH SENSORS MISBEHAVE, so a test does not have to re-derive the
    // selection rule - it reads the same list the fleet used.
    const bad = [];
    for (const d of devices) for (const t of d.temps) if (t.misbehaves) bad.push(`${d.port}:${t.idx}`);
    console.log(`sensor mode: ${SENSOR_MODE}${SENSOR_MODE === 'step' ? ` (+30C at +${STEP_AFTER_MS / 1000}s)` : SENSOR_MODE === 'flap' ? ' (43/47C across warn 45)' : ' (32..40C, never alarms)'}`);
    // The WHOLE list, one line, however long: this is an answer key and a
    // truncated key scored a harness at 19 misses that were never in it.
    if (bad.length > 0) console.log(`misbehaving sensors (${bad.length}, port:index): ${bad.join(' ')}`);
}
console.log(`fleet total: ~${live * perDevice} entities if everything is tracked`);
if (SHIFT !== 0) console.log(`ifIndex SHIFT: +${SHIFT} (Gi0/1 is ifIndex ${1 + SHIFT}) - a re-enumeration`);
console.log('community "public"');
