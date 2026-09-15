// Every EventEmitter this code creates must have an 'error' listener BEFORE it
// can emit, and for the WHOLE time it can emit.
//
//   node tools/test-emitters.ts
//
// THE RULE IS LANGUAGE-LEVEL, not a library quirk: an 'error' event with no
// registered listener is THROWN by Node, never dropped. In a worker thread that
// throw reaches `worker.on('error')` in main, which treats a dead worker as
// fatal and exits the process - so an emitter nobody listened to is a
// whole-application outage reached from wherever that emitter gets its input.
//
// Four instances so far, which is why this file exists rather than a comment:
//
//   1. The export spool WriteStream, listener attached only AFTER streaming
//      finished. Attached-too-late is the same defect as never-attached and it
//      is the one that reads as correct.
//   2. `createReadStream(...).pipe(res)` on the download path.
//   3. A CHECKED-OUT pg client - `pool.on('error')` covers idle connections and
//      nothing covered working ones. Cost: the process exited with ~22,000
//      accepted datagrams still queued.
//   4. The per-poll SNMP session, which emits 'error' on an undecodable
//      response. Reachable by any device on the network.
//
// What is checked here is the SHAPE that makes those crashes possible, against
// the real emitters where that is cheap, and against a stand-in where creating
// the real one needs a network or a database. A stand-in is honest for this
// property specifically, because the property is Node's, not the library's.

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSession } from '../src/collector/snmp.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

console.log('emitters must have an error listener before they can emit\n');

// --- the control: prove the rule, so the assertions below mean something -----
//
// If this did not throw, every other check here would pass for the wrong
// reason - the whole file rests on Node actually behaving this way.
{
    const bare = new EventEmitter();
    let threw = false;
    try {
        bare.emit('error', new Error('nobody is listening'));
    } catch {
        threw = true;
    }
    if (threw) ok('an emitter with NO error listener THROWS - the rule this file is about');
    else bad('emitting error without a listener did not throw - the premise is wrong');

    const watched = new EventEmitter();
    watched.on('error', () => { /* consumed */ });
    let threw2 = false;
    try {
        watched.emit('error', new Error('handled'));
    } catch {
        threw2 = true;
    }
    if (!threw2) ok('and the same emit with a listener attached does not');
    else bad('an emitter WITH a listener still threw');
}

// --- the SNMP session, which is created per poll against untrusted devices ---
//
// net-snmp's Session extends EventEmitter and emits 'error' from `onMsg` when a
// response cannot be decoded (3.26.3, index.js:2417). Creating a session opens
// a UDP socket but sends nothing, so this needs no device and no network.
console.log('');
{
    const session = createSession({
        host: '127.0.0.1', port: 16100, version: '2c', community: 'public',
    });
    const inner = session.inner as EventEmitter;

    if (inner.listenerCount('error') > 0) {
        ok(`the SNMP session has an error listener from creation (${inner.listenerCount('error')})`);
    } else {
        bad('the SNMP session has NO error listener - one malformed response kills the collector');
    }

    // The listener must actually consume the event, not merely exist.
    let threw = false;
    try {
        inner.emit('error', new Error('undecodable response'));
    } catch {
        threw = true;
    }
    if (!threw) ok('an undecodable response does not throw out of the session');
    else bad('the SNMP session still throws on an error event');

    // And it must be RECORDED, or the poll reports a bare timeout and the
    // difference between "device is off" and "device sent nonsense" is lost.
    if (session.lastError !== null && /undecodable/.test(session.lastError.message)) {
        ok('and the error is recorded on the session, so the poll can explain itself');
    } else {
        bad('the session error was swallowed without being recorded', session.lastError);
    }
    session.close();
}

// --- a WriteStream, the shape of finding 9 ------------------------------------
//
// Attached-too-late is the defect that reads as correct, so what is asserted is
// that a listener exists BEFORE anything is written.
console.log('');
{
    const p = path.join(os.tmpdir(), `rscanvas-emitter-test-${process.pid}`);
    const sink = fs.createWriteStream(p);
    if (sink.listenerCount('error') === 0) {
        ok('a bare WriteStream starts with NO error listener - the state finding 9 shipped in');
    } else {
        bad('a bare WriteStream already has a listener, so this control proves nothing');
    }
    sink.on('error', () => { /* as src/workers/export.ts does, before any row */ });
    let threw = false;
    try {
        sink.emit('error', new Error('ENOSPC'));
    } catch {
        threw = true;
    }
    if (!threw) ok('with the listener attached first, a mid-stream write failure is survivable');
    else bad('the WriteStream threw despite a listener');
    sink.destroy();
    fs.rmSync(p, { force: true });
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
