// One at a time (src/workers/serial.ts), the queue the two retention jobs
// share since the 30k drop check on lab-5 (2026-10-01): fired in the same
// instant, the second lost the database's retention lock to the first and
// reported success having dropped nothing - "skipped-locked: messages".
//
//   node tools/test-serial.ts

import { serial } from '../src/workers/serial.ts';

process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

console.log('two jobs fired in the same instant:');
{
    const one = serial();
    const log: string[] = [];
    let inside = 0;
    let most = 0;
    const job = (name: string, ms: number) => async (): Promise<string> => {
        inside++; most = Math.max(most, inside); log.push(`${name} start`);
        await wait(ms);
        log.push(`${name} end`); inside--;
        return name;
    };
    const [a, b] = await Promise.all([one(job('samples', 40)), one(job('messages', 5))]);
    eq('never both at once', most, 1);
    eq('in the order they were asked for', log, ['samples start', 'samples end', 'messages start', 'messages end']);
    eq('each gets its own answer', [a, b], ['samples', 'messages']);
}

console.log('\na failure does not stop the queue:');
{
    const one = serial();
    const first = one(async () => { throw new Error('lane refused'); });
    const second = one(async () => 'ran anyway');
    const outcome = await first.then(() => 'resolved', (e: Error) => e.message);
    eq('the failing one rejects to its own caller', outcome, 'lane refused');
    eq('and the next one still runs', await second, 'ran anyway');
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
