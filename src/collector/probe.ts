// Probe one device: does it answer, and what is on it.
//
// PORTED IN SHAPE from snmpcanvas/server/api.js's two-step add, because its
// central property is worth more than the code: the ADD route accepts a probe
// TOKEN, not an address, so **a device that did not answer cannot be added**.
// A typo'd address is refused here rather than sitting in the roster rendering
// "down" forever - which is exactly the litter that makes a 200-device
// onboarding session unreviewable.
//
// WHY THIS RUNS IN THE COLLECTOR WORKER. ARCHITECTURE puts HTTP on the main
// thread with one condition: no unbounded work on it. A probe is network I/O
// with timeouts, two hundred at a time, and the collector is already "the only
// worker that reaches out to the network on its own initiative". Probing from
// main would put two hundred sockets and their timers on the loop that serves
// every other operator.
//
// It is deliberately LIGHTER than a poll: identity, and enough of the ifTable
// to count and name interfaces. No counters, no last values, nothing written.
// A probe answers "is this the device you meant" and nothing else.

import { createSession, get, walk, asString, asNumber, SnmpError, type Target } from './snmp.ts';
import { SYS, HR, IF, IFX, defaultTracked } from './oids.ts';
import {
    matchVendor, pickRamRow, fsTracked, plausibleC, fanTracked, tempNameValid,
    decodeExtendName, extendKind, sensorRaw,
    HR_SENSORS, HR_STORAGE_RAM, HR_STORAGE_FIXEDDISK, LM_TEMP,
    NSEXTEND_OUTPUT, UPS_OUTPUT_SOURCE,
    type Vendor, type RamRow, type SensorExtra,
} from './sensors.ts';

export interface ProbeEntity {
    kind: string;
    snmpIndex: string;
    name: string;
    descr: string | null;
    alias: string | null;
    speedBps: number | null;
    /** Whether the DEFAULT policy would track this one - see oids.ts, and
     *  for sensors the ported gates in sensors.ts (FS_NOISE, plausibleC,
     *  the spinning-fan rule). */
    tracked: boolean;
    /** Sensor polling instruction (slice14) - null for interfaces, whose
     *  polling derives from ifIndex as it always has. */
    extra: SensorExtra | null;
}

export interface ProbeResult {
    host: string;
    ok: boolean;
    sysName: string | null;
    sysDescr: string | null;
    sysLocation: string | null;
    entities: ProbeEntity[];
    /** Of those, how many the default policy tracks. The number that matters. */
    trackedCount: number;
    error: string | null;
    errorKind: 'timeout' | 'auth' | 'other' | null;
}

/**
 * Sensor discovery, the parent's sequence ported in order (SNMPCanvas
 * discover.js, read in full before this was written - SLICE-SENSORS-PLAN):
 * vendor CPU, vendor memory pools, hrStorage (filesystems and the RAM row),
 * the HOST-RESOURCES CPU fallback with its cold-cache retry, vendor
 * temperatures and fans and metric scalars, LM-SENSORS temperatures.
 * ENTITY-SENSOR, NET-SNMP-EXTEND and the ASRock BMC styles are ported in
 * sensors.ts's data and deliberately not walked yet - each is another walk
 * per probe, and none is exercisable against hardware this lab has.
 *
 * The SELECTION rules all live in sensors.ts where the offline suite holds
 * them; this function only walks and applies.
 */
export async function discoverSensors(
    session: ReturnType<typeof createSession>, sysObjectID: string | null,
    sysDescr: string | null,
): Promise<ProbeEntity[]> {
    const out: ProbeEntity[] = [];
    const vendor: Vendor | null = matchVendor(sysObjectID, sysDescr);

    // EVERY DISCOVERY WALK IS DEADLINE-BOUNDED, and the reason was measured,
    // not imagined: walking an UNSERVED subtree against the lab's own mock
    // agent hangs forever - no response, no error, no library timeout. The
    // interface probe never met this because it only walks core MIB-2
    // subtrees every agent serves; sensor discovery walks vendor and
    // LM-SENSORS space that a given agent may simply not answer. A probe
    // against a half-broken agent must degrade to FEWER SENSORS, never hang
    // the batch - the timeout returns an empty map, and the abandoned walk
    // dies with the session in probeTarget's finally.
    const boundedWalk = (oid: string): Promise<Awaited<ReturnType<typeof walk>>> =>
        Promise.race([
            walk(session, oid),
            new Promise<Awaited<ReturnType<typeof walk>>>((resolve) =>
                setTimeout(() => resolve(new Map()), 8_000).unref()),
        ]);
    const push = (kind: string, snmpIndex: string, name: string,
        tracked: boolean, extra: SensorExtra): void => {
        out.push({ kind, snmpIndex, name, descr: null, alias: null, speedBps: null, tracked, extra });
    };

    // 1. CPU, vendor first. ONE entity, cores averaged - never a row per core.
    let cpuFound = false;
    if (vendor?.cpu !== undefined) {
        if (vendor.cpu.style === 'walk-gauge-pct') {
            let rows = await boundedWalk(vendor.cpu.oid);
            let base = vendor.cpu.oid;
            if (rows.size === 0 && vendor.cpu.fallback !== undefined) {
                rows = await boundedWalk(vendor.cpu.fallback);
                base = vendor.cpu.fallback;
            }
            if (rows.size > 0) {
                push('cpu', 'cpu', 'CPU', true,
                    { style: 'gauge-avg', oids: [...rows.keys()].map((i) => `${base}.${i}`) });
                cpuFound = true;
            }
        } else {
            const v = await get(session, [vendor.cpu.oid]);
            if (v.get(vendor.cpu.oid) !== undefined && v.get(vendor.cpu.oid) !== null) {
                push('cpu', 'cpu', 'CPU', true, { style: 'gauge-avg', oids: [vendor.cpu.oid] });
                cpuFound = true;
            }
        }
    }

    // 2. Memory: vendor pools first, hrStorage RAM as the fallback.
    //    Filesystems always come from hrStorage FixedDisk.
    let memFound = false;
    if (vendor?.mem !== undefined) {
        const pools = await boundedWalk(vendor.mem.nameOid);
        for (const [idx, poolName] of pools) {
            push('mem', idx, `Memory: ${asString(poolName) ?? idx}`, true, {
                style: 'used-free',
                usedOid: `${vendor.mem.usedOid}.${idx}`,
                freeOid: `${vendor.mem.freeOid}.${idx}`,
            });
            memFound = true;
        }
    }
    const hrType = await boundedWalk(HR_SENSORS.hrStorageType);
    if (hrType.size > 0) {
        const [hrDescr, hrAlloc, hrSize] = await Promise.all([
            boundedWalk(HR_SENSORS.hrStorageDescr),
            boundedWalk(HR_SENSORS.hrStorageAllocationUnits),
            boundedWalk(HR_SENSORS.hrStorageSize),
        ]);
        const ramRows: RamRow[] = [];
        for (const [idx, type] of hrType) {
            const typeStr = asString(type) ?? '';
            const isRam = typeStr === HR_STORAGE_RAM;
            const isDisk = typeStr === HR_STORAGE_FIXEDDISK;
            if (!isRam && !isDisk) continue;
            const alloc = asNumber(hrAlloc.get(idx) ?? null) ?? 1;
            const sizeUnits = asNumber(hrSize.get(idx) ?? null) ?? 0;
            if (sizeUnits <= 0) continue;
            const descr = asString(hrDescr.get(idx) ?? null) ?? (isRam ? 'RAM' : `storage ${idx}`);
            if (isRam) {
                if (!memFound) ramRows.push({ idx, descr, alloc, bytes: sizeUnits * alloc });
                continue;
            }
            push('fs', idx, descr, fsTracked(descr), {
                style: 'hr-storage', allocUnits: alloc,
                usedOid: `${HR_SENSORS.hrStorageUsed}.${idx}`,
                sizeOid: `${HR_SENSORS.hrStorageSize}.${idx}`,
            });
        }
        const best = pickRamRow(ramRows);
        if (best !== null) {
            push('mem', best.idx, `Memory: ${best.descr}`, true, {
                style: 'hr-storage', allocUnits: best.alloc,
                usedOid: `${HR_SENSORS.hrStorageUsed}.${best.idx}`,
                sizeOid: `${HR_SENSORS.hrStorageSize}.${best.idx}`,
            });
        }
    }

    // 3. CPU, HOST-RESOURCES fallback - AFTER the storage walk on purpose, so
    //    hrType tells a cold hrProcessorLoad cache apart from a device that
    //    genuinely lacks HOST-RESOURCES. net-snmp computes hrProcessorLoad
    //    lazily after an snmpd restart, so the first walk can come back empty
    //    while every static table answers fine: if storage answered and CPU
    //    did not, retry once (the first walk warms the cache). No
    //    HOST-RESOURCES at all means genuinely no CPU here - no retry.
    if (!cpuFound) {
        let hrCpu = await boundedWalk(HR.hrProcessorLoad);
        if (hrCpu.size === 0 && hrType.size > 0) {
            hrCpu = await boundedWalk(HR.hrProcessorLoad);
        }
        if (hrCpu.size > 0) {
            push('cpu', 'cpu', `CPU (${hrCpu.size} core${hrCpu.size > 1 ? 's' : ''})`, true,
                { style: 'gauge-avg', oids: [...hrCpu.keys()].map((i) => `${HR.hrProcessorLoad}.${i}`) });
        }
    }

    // 4. Temperatures: vendor styles, then LM-SENSORS. Implausible readings
    //    discover UNTRACKED rather than hidden - lmsensors exposes plenty of
    //    junk (unconnected headers reading 0, wrapped negatives).
    if (vendor?.temp !== undefined) {
        if (vendor.temp.style === 'scalars') {
            const got = await get(session, vendor.temp.sensors.map((t) => t.oid));
            for (const t of vendor.temp.sensors) {
                const raw = asNumber(got.get(t.oid) ?? null);
                if (raw === null) continue;
                push('temp', `v-${t.oid.split('.').slice(-2).join('.')}`, `Temp: ${t.name}`,
                    plausibleC(raw / t.div), { style: 'div', valueOid: t.oid, div: t.div });
            }
        } else if (vendor.temp.style === 'walk-tenthF') {
            const rows = await boundedWalk(vendor.temp.oid);
            for (const [idx, raw] of rows) {
                const n = asNumber(raw ?? null);
                const c = n === null ? null : ((n / 10) - 32) * 5 / 9;
                push('temp', `v-${idx}`, `Temp: Sensor ${idx}`, plausibleC(c),
                    { style: 'tenthF', valueOid: `${vendor.temp.oid}.${idx}` });
            }
        } else {
            const div = vendor.temp.div;
            const [tNames, tVals] = await Promise.all([
                boundedWalk(vendor.temp.descrOid),
                boundedWalk(vendor.temp.valueOid),
            ]);
            for (const [idx, nameRaw] of tNames) {
                const nm = (asString(nameRaw) ?? '').trim();
                if (!tempNameValid(nm)) continue;
                const val = asNumber(tVals.get(idx) ?? null);
                push('temp', `v-${idx}`, `Temp: ${nm}`,
                    plausibleC(val === null ? null : val / div),
                    { style: 'div', valueOid: `${vendor.temp.valueOid}.${idx}`, div });
            }
        }
    }
    // LM-SENSORS (net-snmp with lmsensors): names beside milli-degree values.
    {
        const [lmNames, lmVals] = await Promise.all([
            boundedWalk(LM_TEMP.device),
            boundedWalk(LM_TEMP.value),
        ]);
        // THE CORE-DUP RULE, ported 2026-08-27 after the cross-reference
        // against the suite found the fork tracking exactly TWICE the temp
        // sensors on every Intel box (MPCs 8 vs 4, SuperServer 28 vs 17):
        // when a "Package id N" sensor exists, the per-core clones carry the
        // same die temperature with less meaning, so they are discovered
        // but untracked - visible, one click to enable, not driving the
        // sample rate or the roster's max-of-N temp column.
        const hasPackage = [...lmNames.values()]
            .some((n) => /^Package id/i.test((asString(n) ?? '').trim()));
        for (const [idx, nameRaw] of lmNames) {
            const nm = (asString(nameRaw) ?? '').trim();
            if (!tempNameValid(nm)) continue;
            const val = asNumber(lmVals.get(idx) ?? null);
            // Milli-degrees in practice; a value under 200 is already degrees
            // (some agents pre-divide), the parent's same heuristic.
            const div = val !== null && Math.abs(val) >= 200 ? 1000 : 1;
            const coreDup = hasPackage && /^Core \d+$/i.test(nm);
            push('temp', `lm-${idx}`, `Temp: ${nm}`,
                plausibleC(val === null ? null : val / div) && !coreDup,
                { style: 'div', valueOid: `${LM_TEMP.value}.${idx}`, div });
        }
    }

    // 5. Fans, vendor tach tables: only spinning fans track at discovery; a
    //    tracked fan later reading 0 still polls and can alarm.
    if (vendor?.fan !== undefined) {
        const rows = await boundedWalk(vendor.fan.rpmOid);
        let n = 0;
        for (const [idx, raw] of rows) {
            n += 1;
            push('fan', `v-${idx}`, `Fan ${n}`, fanTracked(asNumber(raw ?? null)),
                { style: 'div', valueOid: `${vendor.fan.rpmOid}.${idx}`, div: 1 });
        }
    }

    // 6. Vendor scalar metrics (battery, runtime, load, voltage, state) -
    //    one GET; a sensor the device lacks reads null and is skipped.
    if (vendor?.metrics !== undefined && vendor.metrics.length > 0) {
        const got = await get(session, vendor.metrics.map((m) => m.oid));
        for (const m of vendor.metrics) {
            const raw = got.get(m.oid);
            if (raw === undefined || raw === null) continue;
            if (m.kind === 'state') {
                push('state', `v-${m.oid}`, m.name, true, {
                    style: 'state', valueOid: m.oid,
                    okValues: m.ok ?? [], unknownValues: m.unknown ?? [],
                    // The display texts ride to the card: "On battery" beats
                    // "ALARM" at 3 a.m.
                    okText: m.okText, alarmText: m.alarmText,
                });
            } else if (m.kind === 'fan') {
                push('fan', `v-${m.oid}`, m.name, fanTracked(asNumber(raw ?? null)),
                    { style: 'div', valueOid: m.oid, div: m.div });
            } else if (m.kind === 'temp') {
                const v = asNumber(raw ?? null);
                push('temp', `v-${m.oid}`, m.name,
                    plausibleC(v === null ? null : v / m.div),
                    { style: 'div', valueOid: m.oid, div: m.div });
            } else {
                push(m.kind, `v-${m.oid}`, m.name, true,
                    { style: 'div', valueOid: m.oid, div: m.div, unit: m.unit, max: m.max });
            }
        }
    }

    // 7. NET-SNMP-EXTEND outputs: the agent owner publishes numbers with
    //    one-line `extend` directives in snmpd.conf, named by the convention
    //    that picks the kind. EXPLICIT CONFIGURATION IS INTENT - somebody
    //    wrote that line on purpose - so a numeric output defaults to
    //    TRACKED, unlike the discovered-junk cases the plausibility gates
    //    exist for.
    {
        const rows = await boundedWalk(NSEXTEND_OUTPUT);
        for (const [idx, raw] of rows) {
            const extName = decodeExtendName(idx);
            if (extName === null) continue;
            const spec = extendKind(extName);
            if (spec === null) continue;
            const extra: SensorExtra = { style: 'extend', valueOid: `${NSEXTEND_OUTPUT}.${idx}` };
            // The reading is parsed by the SAME sensorRaw the poller uses -
            // first numeric line, banners skipped - so tracked-at-discovery
            // and the value polled a minute later cannot disagree.
            push(spec.kind, `ext-${extName}`, spec.name,
                sensorRaw(extra, raw) !== null, extra);
        }
    }

    // 8. UPS-MIB (RFC 1628) power source: any network-managed UPS answers
    //    this, vendor entry or not. SKIPPED when a vendor metric already
    //    supplied a state - APC NMCs answer both trees, and two "Power"
    //    cards saying the same thing is worse than one.
    if (!out.some((e) => e.kind === 'state')) {
        try {
            const got = await get(session, [UPS_OUTPUT_SOURCE]);
            const raw = got.get(UPS_OUTPUT_SOURCE);
            if (raw !== undefined && raw !== null) {
                const rv = asNumber(raw);
                push('state', 'v-upsmib-source', 'Power', rv !== null && rv !== 1, {
                    style: 'state', valueOid: UPS_OUTPUT_SOURCE,
                    okValues: [3], unknownValues: [1],
                    okText: 'Online', alarmText: 'On battery',
                });
            }
        } catch { /* probing a non-UPS: a flaky agent must not sink discovery */ }
    }

    return out;
}

/**
 * One device. Never throws - a failed probe is a RESULT, not an exception.
 *
 * That matters for the bulk case above all: one unreachable host in a list of
 * two hundred must not take the other hundred and ninety-nine with it, and a
 * caller that has to try/catch per item writes a loop that hides which one
 * failed.
 */
export async function probeTarget(target: Target): Promise<ProbeResult> {
    const result: ProbeResult = {
        host: target.host, ok: false, sysName: null, sysDescr: null, sysLocation: null,
        entities: [], trackedCount: 0, error: null, errorKind: null,
    };
    const session = createSession(target);
    try {
        const sys = await get(session, [SYS.sysName, SYS.sysDescr, SYS.sysLocation, SYS.sysObjectID]);
        result.sysName = asString(sys.get(SYS.sysName) ?? null);
        result.sysDescr = asString(sys.get(SYS.sysDescr) ?? null);
        result.sysLocation = asString(sys.get(SYS.sysLocation) ?? null);
        const sysObjectID = asString(sys.get(SYS.sysObjectID) ?? null);

        const [names, descrs, types, aliases, highSpeed, speed, connector] = await Promise.all([
            walk(session, IFX.ifName),
            walk(session, IF.ifDescr),
            walk(session, IF.ifType),
            walk(session, IFX.ifAlias),
            walk(session, IFX.ifHighSpeed),
            walk(session, IF.ifSpeed),
            // One more ifXTable column, walked at DISCOVERY only. An agent
            // that does not implement it returns nothing and every value
            // reads null, which defaultTracked treats as "no opinion".
            walk(session, IFX.ifConnectorPresent),
        ]);

        // Index off ifDescr rather than ifName: ifName is in the ifXTable and
        // an older agent may not answer it at all, while ifDescr is IF-MIB and
        // effectively always present. The same fallback the poller uses.
        // walk() RETURNS SUFFIXES, not full OIDs - it strips the base itself.
        // The first version sliced the base off again and every lookup missed,
        // so a probe reported a device with zero interfaces. The lab caught it
        // in one run because the mock fleet has interfaces; the identical bug
        // in the hrDeviceDescr read went unseen for a day because it does not
        // have HOST-RESOURCES. Same mistake, opposite fixture luck.
        const indices = new Set<string>([...descrs.keys(), ...names.keys()]);

        for (const idx of indices) {
            const name = asString(names.get(idx) ?? null)
                ?? asString(descrs.get(idx) ?? null);
            if (name === null) continue;
            const ifType = asNumber(types.get(idx) ?? null);
            // ifHighSpeed is Mbps and is the one to trust past 4.29G; ifSpeed
            // is bits and saturates. Same precedence as the poller.
            const hs = asNumber(highSpeed.get(idx) ?? null);
            const sp = asNumber(speed.get(idx) ?? null);
            result.entities.push({
                kind: 'if',
                snmpIndex: idx,
                name,
                descr: asString(descrs.get(idx) ?? null),
                alias: asString(aliases.get(idx) ?? null),
                speedBps: hs !== null && hs > 0 ? hs * 1_000_000 : sp,
                // THREE TESTS NOW, NOT TWO, and all three live in
                // defaultTracked so this path and the poll cannot drift.
                // The ifType set came across from SNMPCanvas at slice 4 and
                // its name-based twin did not, so a Pi running Docker
                // onboarded with 18 tracked interfaces of which 2 were real.
                // The third test - ifConnectorPresent - arrived 2026-08-25
                // and is the one that answers for Windows, where the whole
                // pseudo-interface zoo claims ethernetCsmacd.
                tracked: defaultTracked(ifType, name, asString(descrs.get(idx) ?? null), asNumber(connector.get(idx) ?? null)),
                extra: null,
            });
        }
        result.entities.sort((a, b) => Number(a.snmpIndex) - Number(b.snmpIndex));

        // Sensors (the sensors slice): discovered here so probe-then-add
        // creates them beside the interfaces, with the polling instruction
        // decided NOW and stored on the entity. A sensor discovery that
        // fails must not fail the probe - the interfaces are the contract,
        // the sensors are the bonus - so it has its own catch.
        try {
            result.entities.push(...await discoverSensors(session, sysObjectID, result.sysDescr));
        } catch { /* sensor walk died; the interface probe stands */ }

        result.trackedCount = result.entities.filter((e) => e.tracked).length;
        result.ok = true;
    } catch (err) {
        const m = (err as Error).message ?? String(err);
        result.error = m;
        // The three kinds an operator acts on differently: a timeout is an
        // address or a firewall, an auth failure is the wrong community or
        // credential ref, and everything else needs the message.
        //
        // TRUST SnmpError's OWN KIND when there is one (slice 29). Re-deriving
        // it from the message string here classified "Unknown User Name" as
        // 'other' purely because that sentence contains no substring "auth" -
        // a v3 credential failure filed under the kind that means "nobody
        // knows". The transport already decided, from the wire, what kind of
        // failure it was; asking the prose again was the duplication.
        result.errorKind = err instanceof SnmpError ? err.kind
            : /timeout|timed out/i.test(m) ? 'timeout'
                : /auth|community|security|credential/i.test(m) ? 'auth' : 'other';
    } finally {
        session.close();
    }
    return result;
}

/**
 * Many devices, with a concurrency bound.
 *
 * Bounded because two hundred simultaneous SNMP sessions is a burst the
 * network notices and the collector's own poll budget does not account for -
 * onboarding must not stall the fleet it is joining. 16 is the poll loop's own
 * order of magnitude and is deliberately not tunable from a request.
 */
export async function probeAll(targets: Target[], limit = 16): Promise<ProbeResult[]> {
    const out: ProbeResult[] = new Array(targets.length);
    let next = 0;
    const runner = async (): Promise<void> => {
        for (;;) {
            const i = next++;
            if (i >= targets.length) return;
            out[i] = await probeTarget(targets[i] as Target);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, targets.length) }, runner));
    return out;
}
