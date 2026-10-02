// A batch refused on its content is written around the rows the database
// cannot store (src/workers/copy-isolate.ts, review 2026-09-30 F4). Offline:
// the copy is a stand-in that refuses chosen rows the way PostgreSQL does,
// with a SQLSTATE class 22 error, and the whole batch the way it does when it
// is down.
//
//   node tools/test-copy-isolate.ts

import { copyIsolating, isDataError } from '../src/workers/copy-isolate.ts';

process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

/** A COPY that refuses any part containing a poison row, as PostgreSQL does:
 *  the whole statement fails and nothing in it is written. */
function stand(poison: Set<number>, opts: { downAfter?: number } = {}) {
    const stored: number[] = [];
    let calls = 0;
    const copy = async (part: number[]): Promise<{ ok: boolean; rowCount: number }> => {
        calls++;
        if (opts.downAfter !== undefined && calls > opts.downAfter) {
            throw Object.assign(new Error('terminating connection due to administrator command'), { code: '57P01' });
        }
        if (part.some((r) => poison.has(r))) {
            throw Object.assign(new Error('date/time field value out of range: "0000-01-01T00:00:00.000Z"'), { code: '22008' });
        }
        stored.push(...part);
        return { ok: true, rowCount: part.length };
    };
    return { copy, stored, calls: () => calls };
}

const batch = Array.from({ length: 2000 }, (_, i) => i);

console.log('what counts as the row\'s fault:');
eq('a data exception (22008) is', isDataError({ code: '22008' }), true);
eq('an invalid text representation (22P02) is', isDataError({ code: '22P02' }), true);
eq('an administrator shutdown (57P01) is not', isDataError({ code: '57P01' }), false);
eq('a missing partition (23514) is not', isDataError({ code: '23514' }), false);
eq('a thrown thing with no code is not', isDataError(new Error('reset')), false);
eq('null is not', isDataError(null), false);

console.log('\none poison row in 2,000:');
{
    const s = stand(new Set([1234]));
    const r = await copyIsolating(batch, s.copy);
    eq('the other 1,999 are written', r.written, 1999);
    eq('only the poison row is dropped', r.dropped, [1234]);
    eq('nothing is left to requeue', r.requeue.length, 0);
    eq('every good row is stored exactly once', s.stored.length === 1999 && new Set(s.stored).size === 1999, true);
    eq(`and it took a bounded number of copies (${s.calls()}, about 2 log2 n)`, s.calls() <= 2 * Math.ceil(Math.log2(2000)) + 2, true);
}

console.log('\nseveral, including the first and the last:');
{
    const s = stand(new Set([0, 7, 1999]));
    const r = await copyIsolating(batch, s.copy);
    eq('three dropped, in batch order', r.dropped, [0, 7, 1999]);
    eq('1,997 written', r.written, 1997);
}

console.log('\nthe database going away mid-search is NOT the rows\' fault:');
{
    const s = stand(new Set([1500]), { downAfter: 3 });
    const r = await copyIsolating(batch, s.copy);
    eq('nothing is dropped', r.dropped, []);
    eq('every row not yet written comes back for the queue', r.written + r.requeue.length, 2000);
    eq('in order', r.requeue.every((v, i, a) => i === 0 || (a[i - 1] as number) < v), true);
    eq('and none of them was also written', r.requeue.some((v) => s.stored.includes(v)), false);
}

console.log('\na lane refusal stops the search the same way:');
{
    let first = true;
    const copy = async (part: number[]): Promise<{ ok: boolean; rowCount: number }> => {
        if (first) { first = false; throw Object.assign(new Error('bad'), { code: '22008' }); }
        return { ok: false, rowCount: 0 };
    };
    const r = await copyIsolating([1, 2, 3, 4], copy);
    eq('all four come back, in order', r.requeue, [1, 2, 3, 4]);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
