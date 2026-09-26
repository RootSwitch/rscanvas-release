// COPY chunking, offline: the rows that reach Postgres are the same, and the
// socket writes that carry them are a handful per flush instead of two per row.
//
//   node tools/test-copy-chunks.ts
//
// src/store/copy.ts (COPY_CHUNK_CHARS) records the defect: pg-copy-streams
// writes every chunk as a header and a body, and both COPY writers yielded one
// row per chunk, so the collector's one-second flush of ~1,000 sample rows was
// ~2,000 socket writes without a yield - 40% of its 30k-entity stalls.
//
// The wire half drives the REAL pg-copy-streams CopyStreamQuery through the
// same Readable.from -> pipeline path ops.ts uses, against a fake connection
// that counts writes, so the number asserted is the number the socket sees.

import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import copyFrom from 'pg-copy-streams';
import { COPY_CHUNK_CHARS, copyChunks, copyLine } from '../src/store/copy.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};

// A sample-shaped row, and a message-shaped one carrying every character the
// escaping exists for, so "the same rows" is tested on the hostile case.
type Row = { id: number; text: string };
const rows: Row[] = Array.from({ length: 1000 }, (_, i) => ({
    id: i,
    text: i % 7 === 0 ? `tab\there nl\nthere cr\r back\\slash ${i}` : `interface ${i} ok`,
}));
const toLine = (r: Row): string => copyLine([r.id, '2026-09-25T00:00:00.000Z', 1, 12.5, r.text, null]);
const perRow = rows.map(toLine);

// --- the generator ----------------------------------------------------------------

const chunks = [...copyChunks(rows, toLine)];
ok('the chunks concatenate to exactly the per-row COPY text', chunks.join('') === perRow.join(''));
ok('every chunk ends on a row boundary', chunks.every((c) => c.endsWith('\n')));
ok(`1,000 rows are ${chunks.length} chunk(s), not 1,000`, chunks.length >= 1 && chunks.length <= 3);
ok('no chunk runs past the target by more than one row',
    chunks.every((c) => c.length < COPY_CHUNK_CHARS + Math.max(...perRow.map((l) => l.length))));

let calls = 0;
const order: number[] = [];
[...copyChunks(rows, (r) => { calls++; order.push(r.id); return toLine(r); })];
ok('toLine runs exactly once per row, in order (NUL counting depends on it)',
    calls === rows.length && order.every((v, i) => v === i));

ok('no rows yield no chunks - the COPY sends no data, as before', [...copyChunks([], toLine)].length === 0);
const big = { id: 1, text: 'x'.repeat(COPY_CHUNK_CHARS * 2) };
const alone = [...copyChunks([rows[1] as Row, big, rows[2] as Row], toLine)];
ok('a row longer than the target is yielded whole, never split',
    alone.join('') === [rows[1] as Row, big, rows[2] as Row].map(toLine).join('')
    && alone.some((c) => c.includes(big.text)) && alone.every((c) => c.endsWith('\n')));

let pulled = 0;
const lazy = copyChunks(rows, (r) => { pulled++; return toLine(r); }, 2_000);
lazy.next();
ok('lazy: taking the first chunk builds only the rows in it', pulled > 0 && pulled < 100, `${pulled} built`);

// --- the wire -------------------------------------------------------------------------

interface CopySink {
    submit(connection: unknown): void;
    handleCopyInResponse(connection: unknown): void;
    handleReadyForQuery(): void;
}

async function onTheWire(source: Iterable<string>): Promise<{ dataWrites: number; payload: string }> {
    const writes: Buffer[] = [];
    const connection = {
        stream: {
            write: (b: Buffer | string): boolean => { writes.push(Buffer.isBuffer(b) ? b : Buffer.from(b)); return true; },
            once: (): void => {},
        },
        query: (): void => {},
    };
    const stream = copyFrom.from('COPY t FROM STDIN');
    const sink = stream as unknown as CopySink;
    sink.submit(connection);
    const done = pipeline(Readable.from(source), stream);
    sink.handleCopyInResponse(connection);
    // _final writes CopyDone ('c', length 4) and then waits for the server's
    // ReadyForQuery, which this fake plays once CopyDone is on the wire.
    const isDone = (w: Buffer): boolean => w.length === 5 && w[0] === 0x63;
    for (let i = 0; i < 1000 && !writes.some(isDone); i++) await new Promise((r) => setImmediate(r));
    sink.handleReadyForQuery();
    await done;

    let payload = '';
    let dataWrites = 0;
    for (let i = 0; i < writes.length; i++) {
        const w = writes[i] as Buffer;
        if (w.length === 5 && w[0] === 0x64) {          // CopyData header: 'd' + length
            const body = writes[i + 1] as Buffer;
            if (w.readUInt32BE(1) !== body.length + 4) throw new Error('CopyData length does not match its body');
            payload += body.toString('utf8');
            dataWrites += 2;
            i++;
        }
    }
    return { dataWrites, payload };
}

const before = await onTheWire(perRow);
const after = await onTheWire(copyChunks(rows, toLine));
ok(`one row per chunk cost ${before.dataWrites} socket writes for 1,000 rows (the defect, measured)`,
    before.dataWrites === 2 * rows.length);
ok(`chunked, the same flush is ${after.dataWrites} socket writes`, after.dataWrites === 2 * chunks.length);
ok('and Postgres receives byte-for-byte the same COPY data', after.payload === before.payload
    && after.payload === perRow.join(''));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
