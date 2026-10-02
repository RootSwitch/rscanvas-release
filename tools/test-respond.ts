// Request bodies and hostile input (src/http/respond.ts), offline. The cases
// are the 2026-09-28 surface sweep's findings (tools/live-surface.mjs against
// rs-test-2): invalid JSON read as an empty body and acted on, and NUL
// characters reaching PostgreSQL as 500s.
//
//   node tools/test-respond.ts

import { Readable } from 'node:stream';
import http from 'node:http';
import zlib from 'node:zlib';
import {
    readJsonBody, readBodyOr400, containsNul, acceptsGzip, sendJsonGzip, GZIP_MIN_BYTES, clientIp, crossSiteRefusal,
} from '../src/http/respond.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};
const NUL = String.fromCharCode(0);
const body = (text: string): http.IncomingMessage =>
    Readable.from([Buffer.from(text, 'utf8')]) as unknown as http.IncomingMessage;
function fakeRes(): { res: http.ServerResponse; status: () => number; json: () => Record<string, unknown> } {
    let status = 0;
    let out = '';
    const res = {
        writeHead: (s: number) => { status = s; return res; },
        end: (b: Buffer) => { out = b.toString('utf8'); },
    } as unknown as http.ServerResponse;
    return { res, status: () => status, json: () => JSON.parse(out) as Record<string, unknown> };
}

console.log('containsNul - PostgreSQL cannot store one, so none may reach it:');
ok('a plain string is clean', !containsNul('rs-test-1'));
ok('a string holding NUL is caught', containsNul(`a${NUL}b`));
ok('deep in an object', containsNul({ a: [{ b: ['x', `y${NUL}`] }] }));
ok('in a key', containsNul({ [`k${NUL}`]: 1 }));
ok('a literal backslash-u text is NOT a NUL', !containsNul('\\u0000'));
ok('numbers, booleans and null are clean', !containsNul({ n: 0, t: true, z: null }));

console.log('\nreadJsonBody:');
{
    const good = await readJsonBody(body('{"name":"rack"}'));
    ok('a JSON object is read', good.name === 'rack');
    const nulBody = `{"label":"a${'\\'}u0000b"}`;
    let refused = '';
    try { await readJsonBody(body(nulBody)); } catch (err) { refused = (err as Error).message; }
    ok('an escaped NUL in a string is refused, with a reason', /NUL/.test(refused), refused);
    let arr = '';
    try { await readJsonBody(body('[]')); } catch (err) { arr = (err as Error).message; }
    ok('an array is refused', /JSON object/.test(arr), arr);
}

console.log('\nreadBodyOr400 - a body that cannot be read is refused, never reinterpreted:');
{
    const bad = fakeRes();
    const r = await readBodyOr400(body('{"cols": '), bad.res);
    ok('invalid JSON answers 400 and returns null - the drill\'s board was rewritten from {} instead',
        r === null && bad.status() === 400);
    ok('and the reason says what was wrong', /request body refused/.test(String(bad.json().detail)));
    const big = fakeRes();
    const r2 = await readBodyOr400(body(JSON.stringify({ x: 'y'.repeat(2000) })), big.res, 1000);
    ok('over the route\'s limit answers 400, naming the limit', r2 === null && big.status() === 400
        && /1000-byte limit/.test(String(big.json().detail)));
    const fine = fakeRes();
    const r3 = await readBodyOr400(body('{"cols":0}'), fine.res);
    ok('a good body passes through and nothing is written', r3 !== null && r3.cols === 0 && fine.status() === 0);
}

console.log('\nacceptsGzip - what a browser sends, and the refusals:');
ok('a browser\'s list', acceptsGzip('gzip, deflate, br, zstd'));
ok('case and spaces', acceptsGzip(' GZip ;q=0.5'));
ok('q=0 refuses it', !acceptsGzip('gzip;q=0, deflate'));
ok('q=0.000 refuses it too', !acceptsGzip('gzip; q=0.000'));
ok('x-gzip is the same thing', acceptsGzip('x-gzip'));
ok('no header, no gzip', !acceptsGzip(undefined));
ok('* is not taken as a yes', !acceptsGzip('*'));
ok('br alone is not gzip', !acceptsGzip('br'));
ok('a repeated header is read whole', acceptsGzip(['deflate', 'gzip']));

console.log('\nsendJsonGzip - through a real server:');
{
    const big = { ok: true, rows: Array.from({ length: 3000 }, (_, i) => ({ id: i, name: `lab-node-${i}`, status: 'up' })) };
    const small = { ok: true, rows: [] };
    const server = http.createServer((req, res) => sendJsonGzip(req, res, 200, req.url === '/big' ? big : small));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const get = (path: string, ae?: string) => new Promise<{ headers: http.IncomingHttpHeaders; raw: Buffer }>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path, headers: ae === undefined ? {} : { 'accept-encoding': ae } }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => resolve({ headers: res.headers, raw: Buffer.concat(chunks) }));
        }).on('error', reject);
    });
    const plainLen = Buffer.byteLength(JSON.stringify(big));
    ok('the test body is over the threshold', plainLen > GZIP_MIN_BYTES, String(plainLen));
    const gz = await get('/big', 'gzip, deflate, br');
    const unzipped = zlib.gunzipSync(gz.raw).toString('utf8');
    ok('asked for gzip: it comes gzipped', gz.headers['content-encoding'] === 'gzip');
    ok('content-length is the compressed length', Number(gz.headers['content-length']) === gz.raw.length);
    ok('and it unzips to the same JSON', unzipped === JSON.stringify(big));
    ok('much smaller', gz.raw.length < plainLen / 5, `${gz.raw.length} of ${plainLen}`);
    ok('it says it varies by accept-encoding', gz.headers.vary === 'accept-encoding');
    ok('the JSON headers are all still there', gz.headers['content-type'] === 'application/json; charset=utf-8'
        && gz.headers['cache-control'] === 'no-store' && gz.headers['x-content-type-options'] === 'nosniff');
    const plain = await get('/big');
    ok('not asked: plain JSON', plain.headers['content-encoding'] === undefined && plain.raw.toString('utf8') === JSON.stringify(big));
    ok('and it varies all the same', plain.headers.vary === 'accept-encoding');
    const refused = await get('/big', 'gzip;q=0');
    ok('refused with q=0: plain', refused.headers['content-encoding'] === undefined);
    const tiny = await get('/small', 'gzip');
    ok('a short answer goes as it is', tiny.headers['content-encoding'] === undefined && tiny.raw.toString('utf8') === JSON.stringify(small));
    server.close();
    server.closeAllConnections();
}

console.log('\nclientIp behind a proxy (review F9):');
{
    const req = (xff: string | string[] | undefined, peer = '127.0.0.1'): http.IncomingMessage => ({
        headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
        socket: { remoteAddress: peer },
    }) as unknown as http.IncomingMessage;
    const was = process.env.TRUST_PROXY;
    process.env.TRUST_PROXY = '1';
    ok('the address the nearest proxy appended, not the one the client sent',
        clientIp(req('6.6.6.6, 203.0.113.9')) === '203.0.113.9');
    ok('a single entry is that entry', clientIp(req('203.0.113.9')) === '203.0.113.9');
    ok('repeated headers read as one list, last entry wins', clientIp(req(['6.6.6.6', '203.0.113.9'])) === '203.0.113.9');
    ok('an IPv6 client', clientIp(req('2001:db8::7')) === '2001:db8::7');
    ok('junk is not an address: the socket peer instead (it reached inet as a 500)',
        clientIp(req("x'; drop table audit;--")) === '127.0.0.1');
    ok('an empty header is the socket peer', clientIp(req('')) === '127.0.0.1');
    process.env.TRUST_PROXY = '0';
    ok('untrusted, the header is ignored entirely', clientIp(req('203.0.113.9', '198.51.100.4')) === '198.51.100.4');
    if (was === undefined) delete process.env.TRUST_PROXY; else process.env.TRUST_PROXY = was;
}

console.log('\na request from another origin cannot change anything (review F12):');
{
    const r = (method: string, headers: Record<string, string>): http.IncomingMessage =>
        ({ method, headers: { host: 'monitor:18080', ...headers } }) as unknown as http.IncomingMessage;
    ok('this page\'s own POST (Sec-Fetch-Site: same-origin) passes',
        crossSiteRefusal(r('POST', { 'sec-fetch-site': 'same-origin' })) === null);
    ok('a page on another port of the box (same-site) is refused - Lax lets its cookie through',
        crossSiteRefusal(r('POST', { 'sec-fetch-site': 'same-site' })) !== null);
    ok('a cross-site DELETE is refused', crossSiteRefusal(r('DELETE', { 'sec-fetch-site': 'cross-site' })) !== null);
    ok('a typed or bookmarked request (none) passes', crossSiteRefusal(r('POST', { 'sec-fetch-site': 'none' })) === null);
    ok('a GET is never refused - nothing changes on one', crossSiteRefusal(r('GET', { 'sec-fetch-site': 'cross-site' })) === null);
    ok('an old browser: Origin naming this host passes',
        crossSiteRefusal(r('POST', { origin: 'https://monitor:18080' })) === null);
    ok('an old browser: Origin naming another port is refused',
        crossSiteRefusal(r('POST', { origin: 'https://monitor:8443' })) !== null);
    ok('Origin: null (a sandboxed frame) is refused', crossSiteRefusal(r('POST', { origin: 'null' })) !== null);
    ok('neither header - curl, a test tool - passes: CSRF is done to browsers',
        crossSiteRefusal(r('POST', {})) === null);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
