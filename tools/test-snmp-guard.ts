// The polling session's socket guard (src/net/snmp-guard.ts, review
// 2026-09-30 F1b). Offline, on loopback: an "evil agent" answers the app's
// own createSession/get with a Report PDU in a v1 or v2c message, which threw
// inside net-snmp 3.26.3's message handler and ended the process. Without the
// guard this file dies before its verdict, so it fails by not finishing.
//
//   node tools/test-snmp-guard.ts

import dgram from 'node:dgram';
import { EventEmitter } from 'node:events';

// Short timeouts, set before the collector's config is first read.
process.env.SNMP_TIMEOUT_MS = '400';
process.env.SNMP_RETRIES = '0';
const { snmpVersion, communityPduTag, guardSession, PDU_REPORT } = await import('../src/net/snmp-guard.ts');
const { createSession, get } = await import('../src/collector/snmp.ts');

process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

// --- a little BER, enough to answer a GET -------------------------------------
const len = (n: number): number[] => (n < 128 ? [n] : n < 256 ? [0x81, n] : [0x82, n >> 8, n & 0xff]);
const tlv = (tag: number, body: number[]): number[] => [tag, ...len(body.length), ...body];
const int = (v: number): number[] => {
    const out: number[] = [];
    let x = v;
    do { out.unshift(x & 0xff); x = Math.floor(x / 256); } while (x > 0);
    if ((out[0] as number) & 0x80) out.unshift(0);
    return tlv(0x02, out);
};
const OID_SYSNAME = [0x06, 0x08, 0x2b, 0x06, 0x01, 0x02, 0x01, 0x01, 0x05, 0x00];
function response(version: number, reqId: number, pduTag: number): Buffer {
    const varbind = tlv(0x30, [...OID_SYSNAME, ...tlv(0x04, [...Buffer.from('evil-agent')])]);
    const pdu = tlv(pduTag, [...int(reqId), ...int(0), ...int(0), ...tlv(0x30, varbind)]);
    return Buffer.from(tlv(0x30, [...int(version), ...tlv(0x04, [...Buffer.from('public')]), ...pdu]));
}
/** The request id of a v1/v2c request: SEQ { version, community, PDU { id ... } }. */
function requestId(buf: Buffer): number {
    let i = 0;
    const skipHeader = (): number => { i++; const l = buf[i++] as number; if (l & 0x80) { const n = l & 0x7f; let v = 0; for (let k = 0; k < n; k++) v = v * 256 + (buf[i++] as number); return v; } return l; };
    // (Not `i += skipHeader()`: that reads i BEFORE the call moves it.)
    skipHeader();                       // message SEQUENCE
    const verLen = skipHeader(); i += verLen;      // version
    const commLen = skipHeader(); i += commLen;    // community
    skipHeader();                       // PDU
    const n = skipHeader();             // request-id INTEGER
    let v = 0;
    for (let k = 0; k < n; k++) v = v * 256 + (buf[i++] as number);
    return v;
}

console.log('reading the first bytes:');
eq('a v2c Report reads as version 1, PDU 0xA8', [snmpVersion(response(1, 7, 0xa8)), communityPduTag(response(1, 7, 0xa8))], [1, PDU_REPORT]);
eq('a v1 GetResponse reads as version 0, PDU 0xA2', [snmpVersion(response(0, 7, 0xa2)), communityPduTag(response(0, 7, 0xa2))], [0, 0xa2]);
eq('a request id past 2^31 survives the round trip', requestId(response(1, 2 ** 31 + 5, 0xa2)), 2 ** 31 + 5);
eq('junk has no PDU tag', communityPduTag(Buffer.from('not snmp at all')), null);
eq('a truncated message has none either', communityPduTag(Buffer.from([0x30, 0x10, 0x02, 0x01])), null);

// --- the evil agent ------------------------------------------------------------
async function poll(version: '1' | '2c', pduTag: number): Promise<{ outcome: string; ms: number; lastError: string | null }> {
    const agent = dgram.createSocket('udp4');
    agent.on('message', (msg, rinfo) => {
        agent.send(response(version === '1' ? 0 : 1, requestId(msg), pduTag), rinfo.port, rinfo.address);
    });
    await new Promise<void>((ok) => agent.bind(0, '127.0.0.1', () => ok()));
    const { port } = agent.address();
    const session = createSession({ host: '127.0.0.1', port, version, community: 'public' });
    const t0 = performance.now();
    let outcome: string;
    try {
        const values = await get(session, ['1.3.6.1.2.1.1.5.0']);
        outcome = `answered ${String(values.get('1.3.6.1.2.1.1.5.0'))}`;
    } catch (err) {
        outcome = `failed: ${(err as Error).message.slice(0, 40)}`;
    }
    const ms = performance.now() - t0;
    session.close();
    agent.close();
    return { outcome, ms, lastError: session.lastError?.message ?? null };
}

console.log('\nan agent answering a poll with a Report PDU (the crash):');
for (const v of ['1', '2c'] as const) {
    const r = await poll(v, PDU_REPORT);
    eq(`v${v}: the process is still here, and the poll failed rather than hanging`, r.outcome.startsWith('failed'), true);
    eq(`v${v}: within its timeout (${Math.round(r.ms)} ms)`, r.ms < 2000, true);
    eq(`v${v}: and the session says why`, (r.lastError ?? '').includes('Report PDU'), true);
}

console.log('\nan honest agent through the same guard:');
{
    const r = await poll('2c', 0xa2);
    eq('a GetResponse is answered as before', r.outcome, 'answered evil-agent');
    eq('with no session error', r.lastError, null);
}

console.log('\na throw nobody has seen yet still settles its request:');
{
    // A stand-in session: its handler unregisters the request (clearing its
    // timer, as net-snmp does) and THEN throws. Without the guard's second
    // half the request would never be answered and its poll would wait for ever.
    const answered: string[] = [];
    const problems: string[] = [];
    const sock = new EventEmitter() as unknown as dgram.Socket;
    const inner = { dgram: sock, reqs: { 42: { responseCb: (e: Error) => { answered.push(e.message); } } } as Record<string, { responseCb: (e: Error) => void }> };
    sock.on('message', () => { delete inner.reqs[42]; throw new TypeError('something new'); });
    eq('the stand-in is guarded', guardSession(inner, (e) => problems.push(e.message)), true);
    sock.emit('message', response(1, 42, 0xa2), { address: '127.0.0.1', port: 1, family: 'IPv4', size: 0 });
    eq('the orphaned request is answered with the error', answered.length === 1 && answered[0]?.includes('something new'), true);
    eq('and the problem is reported', problems.length, 1);
    eq('a session whose socket cannot be found is reported as unguarded', guardSession({}, () => {}), false);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
