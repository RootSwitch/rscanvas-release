// SNMP trap load generator: the trap half of tools/udp-load.ts.
//
// Written 2026-09-24 for the ingest test on the new lab (lab-5 measured, lab-3
// generating). udp-load.ts has driven every ingest measurement since slice 1,
// and it only speaks syslog - so the trap socket, which the ingest worker owns
// beside the syslog socket, had never been driven at any rate at all.
//
// SAME RULES AS udp-load.ts, because they were learned there:
//
//   * Run it on a SECOND HOST. A generator on the measured box competes for the
//     CPU the heartbeat measures, and loopback skips the NIC path entirely.
//   * Pacing integrates the schedule over ELAPSED WALL TIME, never tick counts
//     (a tick-counting version once delivered 128/s against a 200/s target).
//   * Every trap carries RUN_TAG and a sequence number, in a varbind the
//     receiver renders into the stored message, so tools/verify-run.ts can
//     count what landed and name what did not - trusting no counter.
//   * It reports whether it actually drove the rate it was asked for. An
//     under-driven test cannot fail, so it is worth nothing.
//
// What a trap looks like here: SNMPv2c linkDown/linkUp (IF-MIB) with ifIndex,
// ifAdminStatus, ifOperStatus, plus ifDescr carrying "RUN_TAG seq=N". The
// ingest worker renders every varbind as oid=value into msg, so the tag lands
// where countRunTag's LIKE finds it. A small share are enterprise traps with a
// longer varbind list, because real trap storms are not uniform.
//
//   TARGET=198.18.50.3 TARGET_PORT=15162 RATE=500 DURATION_S=600 node tools/trap-load.ts
//
// Needs net-snmp (it encodes BER), so it runs from a checkout with
// node_modules, unlike udp-load.ts which is pure builtins.
import snmp, { type Varbind } from 'net-snmp';

const TARGET = process.env.TARGET || '127.0.0.1';
const PORT = Number(process.env.TARGET_PORT || 162);
const RATE = Number(process.env.RATE || 100);
const BURST_RATE = Number(process.env.BURST_RATE || RATE);
const BURST_EVERY_S = Number(process.env.BURST_EVERY_S || 0);
const BURST_S = Number(process.env.BURST_S || 0);
const DURATION_S = Number(process.env.DURATION_S || 60);
const COMMUNITY = process.env.COMMUNITY || 'public';
const RUN_TAG = process.env.RUN_TAG || `rsctrap-${Date.now().toString(36)}`;
const TICK_MS = 20;
const MAX_CATCHUP = 8;

const IF_MIB = {
    ifIndex: '1.3.6.1.2.1.2.2.1.1',
    ifDescr: '1.3.6.1.2.1.2.2.1.2',
    ifAdminStatus: '1.3.6.1.2.1.2.2.1.7',
    ifOperStatus: '1.3.6.1.2.1.2.2.1.8',
};
const LINK_DOWN = '1.3.6.1.6.3.1.1.5.3';
const LINK_UP = '1.3.6.1.6.3.1.1.5.4';
const ENTERPRISE = '1.3.6.1.4.1.9.9.41.2.0.1';   // a CISCO-SYSLOG-MIB clogMessageGenerated

function trapFor(seq: number): { oid: string; varbinds: Varbind[] } {
    const idx = 1 + (seq % 48);
    const tag = `${RUN_TAG} seq=${seq}`;
    const kind = seq % 10;
    if (kind === 9) {
        // One in ten: a wider enterprise trap, the kind a busy router emits.
        return {
            oid: ENTERPRISE,
            varbinds: [
                { oid: '1.3.6.1.4.1.9.9.41.1.2.3.1.2.1', type: snmp.ObjectType.OctetString, value: 'LINEPROTO' },
                { oid: '1.3.6.1.4.1.9.9.41.1.2.3.1.3.1', type: snmp.ObjectType.Integer, value: 5 },
                { oid: '1.3.6.1.4.1.9.9.41.1.2.3.1.4.1', type: snmp.ObjectType.OctetString, value: 'UPDOWN' },
                { oid: '1.3.6.1.4.1.9.9.41.1.2.3.1.5.1', type: snmp.ObjectType.OctetString,
                    value: `${tag} Line protocol on Interface Gi0/${idx}, changed state to down` },
                { oid: '1.3.6.1.4.1.9.9.41.1.2.3.1.6.1', type: snmp.ObjectType.TimeTicks, value: seq % 4294967295 },
            ],
        };
    }
    const down = seq % 2 === 0;
    return {
        oid: down ? LINK_DOWN : LINK_UP,
        varbinds: [
            { oid: `${IF_MIB.ifIndex}.${idx}`, type: snmp.ObjectType.Integer, value: idx },
            { oid: `${IF_MIB.ifDescr}.${idx}`, type: snmp.ObjectType.OctetString, value: `${tag} Gi0/${idx}` },
            { oid: `${IF_MIB.ifAdminStatus}.${idx}`, type: snmp.ObjectType.Integer, value: 1 },
            { oid: `${IF_MIB.ifOperStatus}.${idx}`, type: snmp.ObjectType.Integer, value: down ? 2 : 1 },
        ],
    };
}

async function main(): Promise<void> {
    const session = snmp.createSession(TARGET, COMMUNITY, {
        version: snmp.Version2c, trapPort: PORT, timeout: 1000, retries: 0,
    });

    console.log('snmp trap load generator');
    console.log(`  target        ${TARGET}:${PORT} (SNMPv2c, community ${COMMUNITY === 'public' ? 'public' : '(set)'})`);
    console.log(`  baseline      ${RATE}/s${BURST_EVERY_S > 0 ? `, burst ${BURST_RATE}/s for ${BURST_S}s every ${BURST_EVERY_S}s` : ''}`);
    console.log(`  duration      ${DURATION_S}s`);
    console.log(`  run tag       ${RUN_TAG}`);
    console.log('');

    let seq = 0;
    let sent = 0;
    let sendErrors = 0;
    let inFlight = 0;
    let catchUpClamped = 0;
    const started = performance.now();

    const cumulativeTarget = (t: number): number => {
        if (BURST_EVERY_S <= 0 || BURST_S <= 0) return RATE * t;
        const whole = Math.floor(t / BURST_EVERY_S);
        const rem = t - whole * BURST_EVERY_S;
        const perCycle = BURST_RATE * BURST_S + RATE * (BURST_EVERY_S - BURST_S);
        const partial = rem <= BURST_S ? BURST_RATE * rem : BURST_RATE * BURST_S + RATE * (rem - BURST_S);
        return whole * perCycle + partial;
    };

    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            const elapsedS = (performance.now() - started) / 1000;
            if (elapsedS >= DURATION_S) { clearInterval(timer); resolve(); return; }
            const inBurst = BURST_EVERY_S > 0 && (elapsedS % BURST_EVERY_S) < BURST_S;
            const owed = Math.floor(cumulativeTarget(elapsedS)) - seq;
            const nominal = Math.ceil(((inBurst ? BURST_RATE : RATE) * TICK_MS) / 1000);
            let n = owed;
            if (n > nominal * MAX_CATCHUP) { catchUpClamped += n - nominal * MAX_CATCHUP; n = nominal * MAX_CATCHUP; }
            for (let i = 0; i < n; i++) {
                const t = trapFor(seq++);
                inFlight++;
                // A v2c trap is unacknowledged: the callback fires when the
                // datagram has been handed to the socket, which is exactly the
                // sender-side fact this counter needs.
                session.trap(t.oid, t.varbinds, (err: Error | null) => {
                    inFlight--;
                    if (err) sendErrors++; else sent++;
                });
            }
        }, TICK_MS);
    });

    const drainStart = Date.now();
    while (inFlight > 0 && Date.now() - drainStart < 5000) await new Promise((r) => setTimeout(r, 20));
    session.close();

    const wallS = (performance.now() - started) / 1000;
    const intended = Math.floor(cumulativeTarget(DURATION_S));
    console.log(`  schedule owed ${intended.toLocaleString()} over ${DURATION_S}s`);
    console.log(`  generated     ${seq.toLocaleString()}`);
    console.log(`  sent ok       ${sent.toLocaleString()}`);
    console.log(`  send errors   ${sendErrors.toLocaleString()}`);
    console.log(`  catch-up clamped ${catchUpClamped.toLocaleString()}`);
    console.log(`  wall clock    ${wallS.toFixed(1)}s (target ${DURATION_S}s)`);
    console.log(`  average rate  ${(sent / wallS).toFixed(0)}/s`);
    const shortfall = intended === 0 ? 0 : (intended - seq) / intended;
    if (shortfall > 0.02) {
        console.error(`WARNING the generator fell ${(shortfall * 100).toFixed(1)}% short of its own schedule.`);
        console.error('The receiver was NOT driven at the stated rate. Do not read a pass into this run.');
    } else {
        console.log(`  rate fidelity ok - within ${(Math.abs(shortfall) * 100).toFixed(2)}% of the schedule`);
    }
    console.log(`RUN_TAG=${RUN_TAG}`);
    console.log(`SENT=${sent}`);
    console.log(`MAX_SEQ=${seq - 1}`);
}

main().catch((err) => { console.error('trap generator failed:', err); process.exit(1); });
