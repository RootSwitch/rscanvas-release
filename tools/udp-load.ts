// Syslog load generator. Runs on a SECOND HOST, not on the lab.
//
// Two reasons it has to be off-box, and the second matters more than the first.
//
//   1. CPU. The primary metric of every slice is the 10ms heartbeat's worst
//      gap, and a process pushing 5,000 datagrams a second competes for the
//      same 12 vCPU the measurement runs on. The lab already declines to
//      overcommit vCPUs for exactly this reason: a guest cannot tell its vCPU
//      being descheduled from its own event loop blocking, so noise on the box
//      injects false positives into the one number the run exists to produce.
//
//   2. The code path. Loopback is not a smaller version of a network, it is a
//      different mechanism: no NIC ring buffer, no driver, no MTU
//      fragmentation, effectively infinite bandwidth. What slice 1 is testing
//      is how fast the kernel drains a real interface into the socket receive
//      buffer, and loopback does not exercise that path at all. Generating
//      locally would measure something adjacent to the thing and report it as
//      the thing.
//
// Pure node builtins, so it can be copied to any host with Node and run with no
// install:
//
//   TARGET=192.0.2.50 node tools/udp-load.ts
//   TARGET=192.0.2.50 DURATION_S=300 RATE=500 BURST_RATE=5000 node tools/udp-load.ts
//
// Every datagram carries a run tag and a sequence number. That is what turns
// "zero dropped" from a claim about counters into an arithmetic check against
// the database: the rows bearing this run's tag can be counted, and the
// sequence numbers that are missing can be named.

import dgram from 'node:dgram';

const TARGET = process.env.TARGET || '127.0.0.1';
const PORT = Number(process.env.TARGET_PORT || 5514);
const RATE = Number(process.env.RATE || 500);
const BURST_RATE = Number(process.env.BURST_RATE || 5000);
const BURST_EVERY_S = Number(process.env.BURST_EVERY_S || 60);
const BURST_S = Number(process.env.BURST_S || 5);
const DURATION_S = Number(process.env.DURATION_S || 120);
const RUN_TAG = process.env.RUN_TAG || `rscrun-${Date.now().toString(36)}`;
const TICK_MS = 20;

// Deterministic, so a failing run can be replayed exactly.
function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0x100000000;
    };
}
const r = rng(Number(process.env.SEED || 20260726));
const pick = <T,>(a: T[]): T => a[Math.floor(r() * a.length)] as T;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const APPS = ['sshd', 'kernel', 'snmpd', 'bgpd', 'systemd', 'hostapd'];
const MNEMONICS = ['SYS-5-CONFIG_I', 'LINK-3-UPDOWN', 'ASA-6-302013', 'LINEPROTO-5-UPDOWN'];
const IFACES = ['Gi0/1', 'Gi0/24', 'Te1/1/1', 'Po12', 'Vlan200'];

const two = (n: number): string => String(n).padStart(2, '0');

// The shape mix. Weighted towards ordinary RFC 3164 because that is what a real
// fleet mostly emits, with a deliberate slice of datagrams that CANNOT be
// parsed - those exercise the never-drop invariant, which is a done-when
// criterion rather than a nicety.
type Shape = 'rfc5424' | 'rfc3164' | 'cisco-ios' | 'cisco-asa' | 'catos' | 'unparseable';
const MIX: Shape[] = [
    'rfc3164', 'rfc3164', 'rfc3164', 'rfc3164',
    'rfc5424', 'rfc5424', 'rfc5424',
    'cisco-ios', 'cisco-ios',
    'cisco-asa',
    'catos',
    'unparseable',
];

const sentByShape: Record<Shape, number> = {
    rfc5424: 0, rfc3164: 0, 'cisco-ios': 0, 'cisco-asa': 0, catos: 0, unparseable: 0,
};

function makeDatagram(seq: number): Buffer {
    const shape = pick(MIX);
    sentByShape[shape]++;

    const now = new Date();
    const mon = MONTHS[now.getUTCMonth()] as string;
    const day = now.getUTCDate();
    const hh = two(now.getUTCHours());
    const mm = two(now.getUTCMinutes());
    const ss = two(now.getUTCSeconds());
    const deviceId = 1 + Math.floor(r() * 600);
    const host = `sw-${String(deviceId).padStart(4, '0')}`;
    const app = pick(APPS);
    const pri = 8 * Math.floor(r() * 24) + Math.floor(r() * 8);
    const iface = pick(IFACES);
    // The tag rides in the body of every shape, including the unparseable ones,
    // so nothing is exempt from the arithmetic check.
    const tag = `${RUN_TAG} seq=${seq}`;

    let line: string;
    switch (shape) {
        case 'rfc5424':
            line = `<${pri}>1 ${now.toISOString()} ${host} ${app} ${1000 + (seq % 9000)} ID47 - ${tag} interface ${iface} state change`;
            break;
        case 'rfc3164':
            line = `<${pri}>${mon} ${day < 10 ? ' ' : ''}${day} ${hh}:${mm}:${ss} ${host} ${app}[${1000 + (seq % 9000)}]: ${tag} link on ${iface}`;
            break;
        case 'cisco-ios':
            line = `<${pri}>${seq % 999999}: ${host}: *${mon} ${day} ${hh}:${mm}:${ss}.${two(seq % 100)}0: %${pick(MNEMONICS)}: ${tag} Interface ${iface}, changed state`;
            break;
        case 'cisco-asa':
            line = `<${pri}>${mon} ${day} ${now.getUTCFullYear()} ${hh}:${mm}:${ss} ${host} : %ASA-6-302013: ${tag} Built outbound TCP connection for ${iface}`;
            break;
        case 'catos':
            line = `<${pri}>${mon} ${day} ${hh}:${mm}:${ss} %SYS-5-MOD_OK:${tag} Module ${1 + (seq % 9)} is online`;
            break;
        default:
            // Genuinely unparseable: no PRI, no timestamp, no tag structure.
            // Must still be stored whole with whatever fields did parse.
            line = `\x01\x02 GARBAGE ${tag} ${'é✓'} no structure here at all`;
            break;
    }
    return Buffer.from(line, 'utf8');
}

async function main(): Promise<void> {
    const socket = dgram.createSocket('udp4');
    // A send buffer large enough that the generator's own kernel is not the
    // bottleneck. If the SENDER drops, the measurement says nothing about the
    // receiver, and it would look identical in the results.
    socket.on('error', (err) => { console.error('socket error:', err.message); process.exit(1); });

    await new Promise<void>((resolve) => socket.bind(0, () => resolve()));
    socket.setSendBufferSize(4 * 1024 * 1024);

    console.log('syslog load generator');
    console.log(`  target        ${TARGET}:${PORT}`);
    console.log(`  baseline      ${RATE}/s`);
    console.log(`  burst         ${BURST_RATE}/s for ${BURST_S}s every ${BURST_EVERY_S}s`);
    console.log(`  duration      ${DURATION_S}s`);
    console.log(`  run tag       ${RUN_TAG}`);
    console.log(`  send buffer   requested ${4 * 1024 * 1024}, kernel reports ${socket.getSendBufferSize()}`);
    console.log('');

    let seq = 0;
    let sent = 0;
    let sendErrors = 0;
    let inFlight = 0;
    let bursts = 0;
    let wasBursting = false;
    let catchUpClamped = 0;
    const started = performance.now();

    // Pacing is driven by ELAPSED WALL TIME, not by counting ticks.
    //
    // The tick-counting version was an instrument that lied. It advanced its
    // clock by TICK_MS per callback and assumed the callback arrived on time;
    // on Windows, whose timer resolution is about 15.6ms, a 20ms interval
    // actually fires around 31ms, so a 10 second run took 15.6 seconds and
    // delivered 128/s against a 200/s target. Measured, not theorised.
    //
    // That failure has the shape this project keeps meeting: the run still
    // reports "sent 2,000, none dropped" and looks like a pass, while the
    // receiver was never driven at the rate the criterion names. An
    // under-driven burst test cannot fail, which makes it worthless.
    //
    // Integrating the rate schedule over real elapsed time self-corrects: a
    // late tick sends the datagrams the missed interval owed.
    const cumulativeTarget = (tSeconds: number): number => {
        if (BURST_EVERY_S <= 0 || BURST_S <= 0) return RATE * tSeconds;
        const cycle = BURST_EVERY_S;
        const whole = Math.floor(tSeconds / cycle);
        const rem = tSeconds - whole * cycle;
        const perCycle = BURST_RATE * BURST_S + RATE * (cycle - BURST_S);
        const partial = rem <= BURST_S
            ? BURST_RATE * rem
            : BURST_RATE * BURST_S + RATE * (rem - BURST_S);
        return whole * perCycle + partial;
    };

    // A stalled process must not discharge a huge catch-up burst that the
    // schedule never called for, so one tick may send at most this multiple of
    // its nominal share. Clamping is COUNTED and reported: silently dropping
    // owed datagrams would be the same class of lie as the bug above.
    const MAX_CATCHUP = 8;

    await new Promise<void>((resolve) => {
        const timer = setInterval(() => {
            const elapsedS = (performance.now() - started) / 1000;
            if (elapsedS >= DURATION_S) {
                clearInterval(timer);
                resolve();
                return;
            }

            const inBurst = BURST_EVERY_S > 0 && (elapsedS % BURST_EVERY_S) < BURST_S;
            if (inBurst && !wasBursting) bursts++;
            wasBursting = inBurst;

            const owed = Math.floor(cumulativeTarget(elapsedS)) - seq;
            const nominal = Math.ceil(((inBurst ? BURST_RATE : RATE) * TICK_MS) / 1000);
            let n = owed;
            if (n > nominal * MAX_CATCHUP) {
                catchUpClamped += n - nominal * MAX_CATCHUP;
                n = nominal * MAX_CATCHUP;
            }

            for (let i = 0; i < n; i++) {
                const buf = makeDatagram(seq++);
                inFlight++;
                socket.send(buf, PORT, TARGET, (err) => {
                    inFlight--;
                    if (err) sendErrors++; else sent++;
                });
            }
        }, TICK_MS);
    });

    // Let the last sends complete before reporting, or the totals under-report
    // and the receiver looks like it lost datagrams the sender never finished.
    const drainStart = Date.now();
    while (inFlight > 0 && Date.now() - drainStart < 5000) {
        await new Promise((res) => setTimeout(res, 20));
    }

    socket.close();
    const wallS = (performance.now() - started) / 1000;
    const intendedTotal = Math.floor(cumulativeTarget(DURATION_S));

    console.log('sent by shape:');
    for (const [shape, count] of Object.entries(sentByShape)) {
        console.log(`  ${shape.padEnd(14)} ${count.toLocaleString().padStart(9)}`);
    }
    console.log('');
    console.log(`  schedule owed ${intendedTotal.toLocaleString()} over ${DURATION_S}s`);
    console.log(`  generated     ${seq.toLocaleString()}`);
    console.log(`  sent ok       ${sent.toLocaleString()}`);
    console.log(`  send errors   ${sendErrors.toLocaleString()}`);
    console.log(`  catch-up clamped ${catchUpClamped.toLocaleString()}`);
    console.log(`  still queued  ${inFlight}`);
    console.log(`  bursts        ${bursts}`);
    console.log(`  wall clock    ${wallS.toFixed(1)}s (target ${DURATION_S}s)`);
    console.log(`  average rate  ${(sent / wallS).toFixed(0)}/s`);
    console.log('');

    // The generator has to prove it drove the load the criterion names. An
    // under-driven burst test cannot fail, so it is worth nothing, and it
    // looks exactly like a pass.
    const shortfall = intendedTotal === 0 ? 0 : (intendedTotal - seq) / intendedTotal;
    if (shortfall > 0.02) {
        console.error(`WARNING the generator fell ${(shortfall * 100).toFixed(1)}% short of its own schedule.`);
        console.error('The receiver was NOT driven at the stated rate. Do not read a pass into this run.');
    } else {
        console.log(`  rate fidelity ok - within ${(Math.abs(shortfall) * 100).toFixed(2)}% of the schedule`);
    }
    if (Math.abs(wallS - DURATION_S) > DURATION_S * 0.05) {
        console.error(`WARNING wall clock ${wallS.toFixed(1)}s differs from the ${DURATION_S}s target by more than 5%.`);
    }

    console.log(`RUN_TAG=${RUN_TAG}`);
    console.log(`SENT=${sent}`);
    console.log(`MAX_SEQ=${seq - 1}`);
    console.log('');
    console.log('Verify what landed with:');
    console.log(`  RUN_TAG=${RUN_TAG} EXPECT_SENT=${sent} node tools/verify-run.ts`);

    if (sendErrors > 0) {
        console.error(`\nWARNING ${sendErrors} send errors - the SENDER dropped these, so the receiver never saw them.`);
        console.error('Subtract them before reading anything into the receive side.');
    }
}

main().catch((err) => {
    console.error('load generator failed:', err);
    process.exit(1);
});
