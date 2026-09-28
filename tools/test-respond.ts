// Request bodies and hostile input (src/http/respond.ts), offline. The cases
// are the 2026-09-28 surface sweep's findings (tools/live-surface.mjs against
// rs-test-2): invalid JSON read as an empty body and acted on, and NUL
// characters reaching PostgreSQL as 500s.
//
//   node tools/test-respond.ts

import { Readable } from 'node:stream';
import type http from 'node:http';
import { readJsonBody, readBodyOr400, containsNul } from '../src/http/respond.ts';

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

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
