// A CPU profile of the app's MAIN thread plus a timestamped gap log, taken
// through the inspector (opened with SIGUSR1, closed again at the end).
//   kill -USR1 <app pid>; node tools/profile-main.mjs <minutes> <outdir>
// Then: node tools/profile-busy.mjs <outdir>/main.cpuprofile <outdir>/main-gaps.json
import fs from 'node:fs';
import path from 'node:path';

const MIN = Number(process.argv[2] ?? 15);
const OUT = process.argv[3] ?? '.';
const list = await (await fetch('http://127.0.0.1:9229/json/list')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const send = (method, params = {}) => new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
});
const evalIn = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
};

// The same measurement as src/heartbeat.ts (10 ms interval, delay past it),
// but keeping WHEN each gap ended.
const GAP = `(() => {
    if (globalThis.__gapTimer) clearInterval(globalThis.__gapTimer);
    let last = performance.now();
    globalThis.__gapLog = [];
    globalThis.__gapTimer = setInterval(() => {
        const now = performance.now();
        const gap = now - last - 10;
        last = now;
        if (gap > 40) globalThis.__gapLog.push([Date.now(), Math.round(gap)]);
    }, 10);
    globalThis.__gapTimer.unref();
    return Date.now();
})()`;

await send('Profiler.enable');
await send('Profiler.setSamplingInterval', { interval: 1000 });
await evalIn(GAP);
await send('Profiler.start');
const startWall = Date.now();
console.log(`profiling main for ${MIN} min from ${new Date(startWall).toISOString()}`);
await new Promise((r) => setTimeout(r, MIN * 60_000));
const stop = await send('Profiler.stop');
const endWall = Date.now();
const gaps = await evalIn(`(() => {
    clearInterval(globalThis.__gapTimer);
    const g = globalThis.__gapLog;
    delete globalThis.__gapLog; delete globalThis.__gapTimer;
    return g;
})()`);
fs.writeFileSync(path.join(OUT, 'main.cpuprofile'), JSON.stringify(stop.result.profile));
fs.writeFileSync(path.join(OUT, 'main-gaps.json'), JSON.stringify({ startWall, endWall, gaps }));
console.log(`gaps over 40 ms: ${gaps.length}`);
for (const [t, g] of gaps) console.log(`  +${((t - startWall) / 1000).toFixed(1)} s  ${new Date(t).toISOString().slice(11, 23)}  ${g} ms`);
await send('Profiler.disable');
// Close the inspector port again; the reply may not arrive once it closes.
ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate',
    params: { expression: `process.getBuiltinModule('node:inspector').close()` } }));
setTimeout(() => process.exit(0), 1000);
