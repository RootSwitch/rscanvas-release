// TLS on the web port: the pair loader's refusals, and the one-port dispatch.
//
//   node tools/test-tls.ts
//
// Mints a throwaway self-signed pair with openssl in a temp dir, the same
// command shape the installer's --tls uses, so what is tested is what ships.
// No openssl on PATH is a FAIL, not a skip: a test that cannot run must say
// so, and every box this runs on (dev, lab, install) has it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { loadTlsPair, createWebServer, TlsConfigError } from '../src/http/tls.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? (pass++, console.log(`  ok   ${l}`))
        : (fail++, console.log(`  FAIL ${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
};
const throwsTls = (l: string, fn: () => unknown): void => {
    try { fn(); eq(l, 'no throw', 'TlsConfigError'); } catch (err) {
        eq(l, err instanceof TlsConfigError ? 'TlsConfigError' : String(err), 'TlsConfigError');
    }
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rscanvas-tls-'));
const certPath = path.join(dir, 'cert.pem'), keyPath = path.join(dir, 'key.pem');
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-keyout', keyPath, '-out', certPath, '-subj', '/CN=rscanvas-test',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });

console.log('loading the pair:');
eq('neither set is null (plain http)', loadTlsPair('', ''), null);
throwsTls('cert without key is refused', () => loadTlsPair(certPath, ''));
throwsTls('key without cert is refused', () => loadTlsPair('', keyPath));
throwsTls('a missing cert file is refused', () => loadTlsPair(path.join(dir, 'nope.pem'), keyPath));
throwsTls('a missing key file is refused', () => loadTlsPair(certPath, path.join(dir, 'nope.pem')));
const pair = loadTlsPair(certPath, keyPath);
eq('the real pair loads', pair !== null && pair.cert.length > 0 && pair.key.length > 0, true);

const handler: http.RequestListener = (req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`hello ${req.url} encrypted=${(req.socket as { encrypted?: boolean }).encrypted === true}`);
};
const listen = (s: net.Server): Promise<number> => new Promise((r) => {
    s.listen(0, '127.0.0.1', () => r((s.address() as net.AddressInfo).port));
});
const get = (mod: typeof http | typeof https, port: number, p: string): Promise<{ status: number; location: string | undefined; body: string }> =>
    new Promise((resolve, reject) => {
        const req = mod.request({ host: '127.0.0.1', port, path: p, method: 'GET', rejectUnauthorized: false }, (res) => {
            let body = '';
            res.on('data', (c: Buffer) => { body += c.toString(); });
            res.on('end', () => resolve({ status: res.statusCode ?? 0, location: res.headers.location, body }));
        });
        req.on('error', reject);
        req.end();
    });
const raw = (port: number, text: string): Promise<string> => new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(text));
    let out = '';
    s.on('data', (c: Buffer) => { out += c.toString(); });
    s.on('end', () => resolve(out));
    s.on('close', () => resolve(out));
    s.on('error', reject);
});

console.log('\nplain server (no pair):');
const plain = createWebServer(null, handler);
const pp = await listen(plain);
const r0 = await get(http, pp, '/a');
eq('answers http', r0.status, 200);
eq('and the socket is not encrypted', r0.body, 'hello /a encrypted=false');
plain.close();

console.log('\none port, both protocols (pair set):');
const both = createWebServer(pair, handler);
const bp = await listen(both);
const r1 = await get(https, bp, '/b');
eq('https answers from the handler', r1.status, 200);
eq('over an encrypted socket', r1.body, 'hello /b encrypted=true');
const r2 = await get(http, bp, '/c?d=1');
eq('plain http on the same port is a 301', r2.status, 301);
eq('to https at the SAME host and port, path kept', r2.location, `https://127.0.0.1:${bp}/c?d=1`);
eq('and the body says why in words', r2.body.includes('this port serves https'), true);
const r3 = await raw(bp, 'GET / HTTP/1.0\r\n\r\n');
eq('no Host header cannot be redirected and says so', r3.startsWith('HTTP/1.1 400'), true);
const r4 = await get(https, bp, '/e');
eq('https still answers after plain traffic (dispatch is per connection)', r4.status, 200);
both.close();

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
// If close() left a handle behind this process would hang here instead of
// exiting; the test runner's exit IS the assertion that shutdown is clean.
process.exitCode = fail === 0 ? 0 : 1;
