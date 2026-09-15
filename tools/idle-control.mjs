// The idle control for the 30k ceiling run: a heartbeat that does NO WORK.
//
//   node tools/idle-control.mjs >> /home/user/lab/idle-control.log 2>&1
//
// WHY THIS EXISTS. At 30k entities the mock fleet is three times larger than
// the one the 10k soak carried, and the lab's own rule says a guest cannot
// distinguish being descheduled by the hypervisor from blocking its own event
// loop. The heartbeat is the instrument the whole architecture is judged by,
// so at this scale the apparatus can quietly invalidate the verdict.
//
// This process is the control. It holds one 10ms interval and otherwise does
// nothing at all - no database, no sockets, no timers but the one, and one
// tiny append per hour. It therefore has NO event loop of its own to block.
// **Any gap it reports is the machine, not the application.**
//
// The pre-registered rule from SLICE-30K-CEILING-PLAN section 4: an hour in
// which this control gaps over 50ms is an hour whose subject heartbeat
// numbers are VOID, reported as void rather than averaged away. That is the
// echo test applied to the instrument - the control could disagree with the
// subject, which is the only thing that makes their agreement worth quoting.
//
// ERROR SIGN, stated because this project requires it of any instrument:
// worst-gap is a monotone high-water within its window, so it can only be set
// by the worst event it saw. It is an UPPER BOUND on lateness and can never
// under-report a stall it observed - but it CAN miss one entirely if the
// process is not scheduled at all, which is the same blindness it exists to
// detect. That is why ticks are counted too: a window with a clean worst-gap
// AND a short tick count is a window where this process itself was starved,
// and it is reported rather than passed.
//
// Deliberately standalone. It imports nothing from src/, so it keeps working
// when the subject is broken, restarted, or absent - a control that shares a
// dependency with its subject is not a control.

import fs from 'node:fs';

const TICK_MS = 10;
const GAP_THRESHOLD_MS = 50;      // the plan's pre-registered void threshold
const LOG = process.env.IDLE_CONTROL_LOG ?? '';

let last = process.hrtime.bigint();
let hourWorst = 0;
let hourTicks = 0;
let hourStart = Date.now();
let hourOverCount = 0;

/** Whole hours since the epoch, so lines join to soak.log by timestamp. */
const hourKey = (ms) => new Date(ms).toISOString().slice(0, 13).replace('T', 'T') + ':00';

function emit() {
    const elapsedMs = Date.now() - hourStart;
    // Expected ticks is derived from ELAPSED time, not from the nominal hour,
    // so a partial first window reports honestly instead of looking starved.
    const expected = Math.round(elapsedMs / TICK_MS);
    const missing = Math.max(0, expected - hourTicks);
    const verdict = hourWorst > GAP_THRESHOLD_MS ? 'VOID' : 'ok';
    const line = [
        hourKey(hourStart),
        `worst_ms=${hourWorst.toFixed(1)}`,
        `over_${GAP_THRESHOLD_MS}ms=${hourOverCount}`,
        `ticks=${hourTicks}`,
        `expected=${expected}`,
        `missing=${missing}`,
        `verdict=${verdict}`,
    ].join(' ');
    console.log(line);
    if (LOG !== '') {
        // The ONLY io this process does, once an hour. Append, never rewrite,
        // so a crash cannot cost the series it exists to keep.
        try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {
            console.log(`idle-control: could not append to ${LOG}: ${e.message}`);
        }
    }
    hourWorst = 0; hourTicks = 0; hourOverCount = 0; hourStart = Date.now();
}

setInterval(() => {
    const now = process.hrtime.bigint();
    const gapMs = Number(now - last) / 1e6 - TICK_MS;
    last = now;
    hourTicks++;
    if (gapMs > hourWorst) hourWorst = gapMs;
    if (gapMs > GAP_THRESHOLD_MS) hourOverCount++;
    if (Date.now() - hourStart >= 3600_000) emit();
}, TICK_MS);

// A first line at start, so "the control was running" is a fact in the log
// rather than an assumption. A missing series is then unambiguous.
console.log(`idle-control started pid=${process.pid} tick=${TICK_MS}ms threshold=${GAP_THRESHOLD_MS}ms log=${LOG || '(stdout only)'}`);

for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
        // Emit the partial window before leaving. A control that dies quietly
        // takes its own last hour with it, which is the one most likely to
        // matter.
        emit();
        console.log(`idle-control stopping on ${sig}`);
        process.exit(0);
    });
}
