// The collector's percentiles, offline: the same answers as the per-call
// copy-and-sort they replace, from one typed sort per window.
//
//   node tools/test-percentiles.ts
//
// src/collector/percentiles.ts records why it changed: four comparator sorts
// of a 10,000+ entry window every second were a third of the collector's
// stalls at 30k entities.

import { percentiles } from '../src/collector/percentiles.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};

// The implementation this replaces, verbatim, as the reference.
const pct = (arr: number[], p: number): number => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return Number((s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number).toFixed(1));
};

// A seeded generator, so a failure names a case that reproduces.
let seed = 20260925;
const rand = (): number => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

const PS = [50, 95, 99, 100, 1];
let mismatches = 0;
let firstMismatch = '';
for (let c = 0; c < 400; c++) {
    const n = c < 10 ? c : Math.floor(rand() * 25_000);
    const shape = c % 4;
    const arr = Array.from({ length: n }, () => {
        const r = rand();
        if (shape === 0) return Math.round(r * 50);            // many duplicates, like lag in ms
        if (shape === 1) return Number((r * 3000).toFixed(3)); // poll times with decimals
        if (shape === 2) return r < 0.9 ? r * 40 : 1000 + r * 5000; // a long tail
        return (r - 0.5) * 200;                                // negatives and zero crossings
    });
    const got = percentiles(arr, PS);
    PS.forEach((p, i) => {
        if (got[i] !== pct(arr, p)) {
            mismatches++;
            if (!firstMismatch) firstMismatch = `case ${c} n=${n} p${p}: ${got[i]} vs ${pct(arr, p)}`;
        }
    });
}
ok('the same answer as the per-call comparator sort on 400 windows up to 25,000 entries (p1, p50, p95, p99, p100)',
    mismatches === 0, firstMismatch);

ok('an empty window reads 0 for every percentile, as it did', percentiles([], [50, 95]).every((v) => v === 0));
ok('nearest rank on a known window', JSON.stringify(percentiles([5, 1, 4, 2, 3, 10, 9, 8, 7, 6], [50, 95])) === '[5,10]');
ok('rounded to one decimal, as it was', percentiles([1.26], [50])[0] === 1.3);

const input = [3, 1, 2];
percentiles(input, [50]);
ok('the window itself is not reordered - it is the live ring the collector keeps pushing to',
    input.join() === '3,1,2');

// The point of the change, as a sanity bound rather than a benchmark: one
// typed sort per window must not be slower than the four comparator sorts it
// replaces on a window the size the collector keeps at 30k.
const window = Array.from({ length: 20_000 }, () => rand() * 3000);
const t0 = performance.now();
for (let i = 0; i < 20; i++) { pct(window, 50); pct(window, 95); pct(window, 50); pct(window, 95); }
const oldMs = (performance.now() - t0) / 20;
const t1 = performance.now();
for (let i = 0; i < 20; i++) { percentiles(window, [50, 95]); percentiles(window, [50, 95]); }
const newMs = (performance.now() - t1) / 20;
console.log(`  (a 20,000 entry snapshot: ${oldMs.toFixed(1)} ms before, ${newMs.toFixed(1)} ms after)`);
ok('one typed sort per window is cheaper than the four comparator sorts it replaces', newMs < oldMs);

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
