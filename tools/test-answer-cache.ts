// The Dashboard's answer cache, offline: one answer per window per rollup
// hour, shared computations, refusals not kept - and forget(), which a device
// delete calls so the deleted device leaves the Dashboard at once.
//
//   node tools/test-answer-cache.ts
//
// src/reports/answer-cache.ts says why each rule exists. The one that needed
// care is forget() racing a computation already running: it read the fleet
// before the delete, so it must not refill the cache when it lands.

import { answerCache, type Answer } from '../src/reports/answer-cache.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};

/** A compute whose answers are released by hand, so the test decides what
 *  lands when. Each call's body names the fleet as it stood when it began. */
function harness() {
    let fleet = 'with gpu-01';
    const calls: { hours: number; hiMs: number; release: (r?: Answer<string>) => void }[] = [];
    const cache = answerCache<string>((hours, hiMs) => {
        const saw = fleet;
        return new Promise<Answer<string>>((resolve) => {
            calls.push({ hours, hiMs, release: (r) => resolve(r ?? { ok: true, body: `${hours}h@${hiMs} ${saw}` }) });
        });
    });
    return { cache, calls, setFleet: (f: string) => { fleet = f; } };
}
const tick = () => new Promise<void>((r) => setImmediate(r));
const H = 3600_000;

async function main(): Promise<void> {
    console.log('one answer per window per rollup hour');
    {
        const { cache, calls } = harness();
        const a = cache.answer(24, 10 * H);
        calls[0].release();
        const first = await a;
        const again = await cache.answer(24, 10 * H);
        ok('the second ask is answered from the cache', calls.length === 1 && again.ok && first.ok
            && again.body === first.body);
        ok('has() says so', cache.has(24, 10 * H) && !cache.has(168, 10 * H));
        const next = cache.answer(24, 11 * H);
        ok('the next rollup hour computes again', calls.length === 2 && !cache.has(24, 11 * H));
        calls[1].release();
        await next;
        ok('and replaces the window\'s answer', cache.has(24, 11 * H) && !cache.has(24, 10 * H));
    }

    console.log('\nconcurrent asks share one computation');
    {
        const { cache, calls } = harness();
        const a = cache.answer(24, 10 * H);
        const b = cache.answer(24, 10 * H);
        ok('two asks, one computation', calls.length === 1);
        calls[0].release();
        const [ra, rb] = await Promise.all([a, b]);
        ok('both get its answer', ra.ok && rb.ok && ra.body === rb.body);
    }

    console.log('\na refusal is not kept');
    {
        const { cache, calls } = harness();
        const a = cache.answer(24, 10 * H);
        calls[0].release({ ok: false, reason: 'heavy lane busy' });
        const r = await a;
        ok('the refusal is returned', !r.ok && r.reason === 'heavy lane busy');
        ok('and not cached', !cache.has(24, 10 * H));
        void cache.answer(24, 10 * H);
        ok('the next ask tries again', calls.length === 2);
        calls[1].release();
    }
    {
        const cache = answerCache<string>(() => Promise.reject(new Error('connection reset')));
        const r = await cache.answer(24, 10 * H);
        ok('a thrown computation becomes a refusal, not a rejection', !r.ok && r.reason === 'connection reset');
    }

    console.log('\nforget(): a deleted device leaves at once');
    {
        const { cache, calls, setFleet } = harness();
        const a = cache.answer(24, 10 * H);
        calls[0].release();
        await a;
        setFleet('without gpu-01');
        cache.forget();
        ok('every held answer is dropped', !cache.has(24, 10 * H));
        const b = cache.answer(24, 10 * H);
        ok('the same hour computes again', calls.length === 2);
        calls[1].release();
        const r = await b;
        ok('and the answer no longer names the device', r.ok && r.body.includes('without gpu-01'), JSON.stringify(r));
    }
    {
        // THE RACE: a warm-up was computing when the delete landed.
        const { cache, calls, setFleet } = harness();
        const stale = cache.answer(168, 10 * H);
        setFleet('without gpu-01');
        cache.forget();
        const fresh = cache.answer(168, 10 * H);
        ok('an ask after forget() does not join the computation from before it', calls.length === 2);
        calls[0].release();
        await stale;
        await tick();
        ok('the stale computation landing does not fill the cache', !cache.has(168, 10 * H));
        calls[1].release();
        const r = await fresh;
        await tick();
        ok('the fresh one does, and without the device', cache.has(168, 10 * H) && r.ok
            && r.body.includes('without gpu-01'), JSON.stringify(r));
        const held = await cache.answer(168, 10 * H);
        ok('so the next ask is answered from the fresh one', calls.length === 2 && held.ok
            && held.body.includes('without gpu-01'));
    }
    {
        const { cache, calls } = harness();
        const a = cache.answer(24, 10 * H);
        cache.forget();
        calls[0].release();
        const r = await a;
        ok('whoever asked before forget() still gets the answer they waited for', r.ok);
    }
}

main().then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exitCode = fail === 0 ? 0 : 1;
}).catch((err: unknown) => {
    console.log(`  FAIL the test threw: ${(err as Error).stack}`);
    process.exitCode = 1;
});
