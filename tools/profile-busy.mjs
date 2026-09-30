// Busy stretches in a .cpuprofile: consecutive samples that are not (idle),
// longer than a floor, each with where its time went.
//   node tools/profile-busy.mjs main.cpuprofile [main-gaps.json] [floorMs]
import fs from 'node:fs';

const prof = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const gapsFile = process.argv[3] && fs.existsSync(process.argv[3]) ? JSON.parse(fs.readFileSync(process.argv[3], 'utf8')) : null;
const FLOOR = Number(process.argv[4] ?? 30);

const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const short = (u) => (u || '').replace(/^file:\/\/.*?\/(src|node_modules)\//, '$1/');
const frame = (n) => `${n.callFrame.functionName || '(anon)'} ${short(n.callFrame.url)}:${n.callFrame.lineNumber + 1}`;
const stackOf = (id) => {
    const out = [];
    for (let cur = id; cur !== undefined; cur = parent.get(cur)) {
        const n = byId.get(cur);
        if (n.callFrame.functionName === '(root)') break;
        out.push(n);
    }
    return out; // leaf first
};
const isIdle = (id) => byId.get(id).callFrame.functionName === '(idle)';

// Sample i happened at t[i] (ms from start) and is charged the time until i+1.
const t = [];
let acc = 0;
for (const d of prof.timeDeltas) { acc += d; t.push(acc / 1000); }
const total = (prof.endTime - prof.startTime) / 1000;
const runs = [];
let s = -1;
for (let i = 0; i <= prof.samples.length; i++) {
    const busy = i < prof.samples.length && !isIdle(prof.samples[i]);
    if (busy && s < 0) s = i;
    if (!busy && s >= 0) {
        const end = i < prof.samples.length ? t[i] : total;
        if (end - t[s] >= FLOOR) runs.push({ from: s, to: i, at: t[s], ms: end - t[s] });
        s = -1;
    }
}
console.log(`profile ${(total / 1000).toFixed(0)} s, ${prof.samples.length} samples; busy stretches >= ${FLOOR} ms: ${runs.length}`);
if (gapsFile) console.log(`gap log: ${gapsFile.gaps.length} gaps over 40 ms`);

for (const r of runs) {
    const leaf = new Map();
    const app = new Map();
    for (let i = r.from; i < r.to; i++) {
        const w = (i + 1 < t.length ? t[i + 1] : total) - t[i];
        const st = stackOf(prof.samples[i]);
        const lf = frame(st[0]);
        leaf.set(lf, (leaf.get(lf) ?? 0) + w);
        // The innermost frame in our own code says which feature it was.
        const mine = st.find((n) => /\/src\//.test(n.callFrame.url) && !/node:/.test(n.callFrame.url));
        const key = mine ? stackOf(mine.id).filter((n) => /\/src\//.test(n.callFrame.url)).slice(0, 4).map(frame).join(' < ') : '(no app frame: ' + frame(st.at(-1)) + ')';
        app.set(key, (app.get(key) ?? 0) + w);
    }
    const top = (m, k) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([f, ms]) => `      ${ms.toFixed(0).padStart(5)} ms  ${f}`).join('\n');
    let near = '';
    if (gapsFile) {
        const endWall = gapsFile.startWall + r.at + r.ms;
        const g = gapsFile.gaps.filter(([w]) => Math.abs(w - endWall) < 400);
        near = g.length ? `  (gap log: ${g.map((x) => x[1] + ' ms').join(', ')})` : '';
    }
    console.log(`\n+${(r.at / 1000).toFixed(1)} s  busy ${r.ms.toFixed(0)} ms${near}`);
    console.log('   leaf frames:\n' + top(leaf, 5));
    console.log('   our code:\n' + top(app, 4));
}
