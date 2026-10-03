// The heartbeat's fifteen-minute window (src/heartbeat.ts gapWindow), which
// the health verdict reads since 2026-10-02. Before it, the acute bound read
// the since-start maximum: production's VM host ran its 06:00 backup, polls
// slipped up to 2.2 s, and health said "stalled" until the next restart.
//
//   node tools/test-heartbeat-window.ts
//
// The window is driven through a simulated morning on a clock this test
// owns, then handed to isHeartbeatHealthy, so "the stall clears" is asserted
// end to end rather than inferred from the ring's arithmetic.

import { gapWindow, startHeartbeat, HEARTBEAT_WINDOW_MS, type HeartbeatStats } from '../src/heartbeat.ts';
import { isHeartbeatHealthy } from '../src/workers/protocol.ts';

process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};
const MIN = 60_000;

// A collector heartbeat as main would receive it, built around a window read.
const asStats = (recent: HeartbeatStats['recent']): HeartbeatStats => ({
    thread: 'collector', ticks: 1_000_000, worstGapMs: 2213.4, worstGapAt: '2026-10-02T11:00:41.000Z',
    p50GapMs: 0, p99GapMs: 1, thresholdMs: 50, overThresholdCount: 1, recent,
});

console.log('one 2.2 s stall at 06:00:41, then quiet 10 ms ticks:');
{
    const w = gapWindow(50);
    const t0 = 6 * 60 * MIN;            // 06:00 on a clock this test owns
    let now = t0;
    const tick = (until: number): void => {
        for (; now < until; now += 10) w.record(0.4, now);
    };
    tick(t0 + 41_000);
    w.record(2213.4, now);
    eq('the stall is in the window at once', w.read(now).worstGapMs, 2213.4);
    eq('and counted as over the threshold', w.read(now).overThresholdCount, 1);

    tick(t0 + 14 * MIN);
    eq('still there at 06:14 - reported while it is news', w.read(now).worstGapMs, 2213.4);
    const at14 = isHeartbeatHealthy([asStats(w.read(now))]);
    eq('health at 06:14 names it', at14.healthy ? 'healthy' : at14.problem,
        'collector stalled 2213.4ms in one tick in the last 15 min (limit 500ms)');

    tick(t0 + 16 * MIN);
    eq('gone at 06:16', w.read(now).worstGapMs, 0.4);
    eq('its over-threshold count left with it', w.read(now).overThresholdCount, 0);
    eq('health at 06:16 is green, the record kept on the since-start fields',
        isHeartbeatHealthy([asStats(w.read(now))]).healthy, true);

    const ticks = w.read(now).ticks;
    // Whole minutes: the current one (empty at 06:16:00.000) and the fourteen before.
    eq('the window holds 14 to 15 minutes of ticks', [ticks >= 14 * 6000, ticks <= 15 * 6000], [true, true]);
    eq('and says how long it is', w.read(now).windowMs, HEARTBEAT_WINDOW_MS);
}

console.log('\nthe ring reuses a slot only for its own minute:');
{
    const w = gapWindow(50);
    for (let i = 0; i < 100; i++) w.record(80, 5 * MIN + i);         // minute 5: 100 over
    w.record(1, 20 * MIN);                                             // minute 20, same ring slot
    eq('a slot fifteen minutes on starts empty', w.read(20 * MIN),
        { windowMs: HEARTBEAT_WINDOW_MS, ticks: 1, worstGapMs: 1, overThresholdCount: 0 });

    const v = gapWindow(50);
    v.record(700, 3 * MIN);
    eq('a minute older than the window is skipped on read, ticking or not', v.read(40 * MIN).ticks, 0);
    eq('a slot from the future is not counted either', v.read(2 * MIN).ticks, 0);
}

console.log('\na rate judged now, not diluted by uptime:');
{
    const w = gapWindow(50);
    let now = 0;
    for (; now < 15 * MIN; now += 10) w.record(now % 1000 === 0 ? 120 : 0.4, now);
    const r = w.read(now - 10);
    eq('one 120 ms gap a second for 15 min is 1% of ticks', [r.overThresholdCount, r.ticks], [900, 90_000]);
    const v = isHeartbeatHealthy([asStats(r)]);
    eq('and fails as sustained', !v.healthy && /1\.00% of ticks in the last 15 min/.test(v.problem), true);
}

console.log('\nclear() is the soak hook\'s reset:');
{
    const w = gapWindow(50);
    w.record(900, 10);
    w.clear();
    eq('nothing survives it', w.read(10), { windowMs: HEARTBEAT_WINDOW_MS, ticks: 0, worstGapMs: 0, overThresholdCount: 0 });
}

console.log('\nthe live heartbeat publishes the window:');
{
    const hb = startHeartbeat('main', 5, 50);
    const ref = setInterval(() => undefined, 1000);   // the heartbeat timer is unref'd
    await new Promise((r) => setTimeout(r, 120));
    const s = hb.stats();
    hb.stop();
    clearInterval(ref);
    eq('recent rides on stats() with a tick count', s.recent.ticks > 0 && s.recent.ticks <= s.ticks, true);
    eq('worstGapAt is a time once any gap was seen', s.worstGapMs > 0 ? typeof s.worstGapAt : 'string', 'string');
    eq('the verdict accepts it', isHeartbeatHealthy([s]).healthy || /stalled|sustained/.test(
        (isHeartbeatHealthy([s]) as { problem: string }).problem), true);
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
