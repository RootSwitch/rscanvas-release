// The path gate (slice 61): THE STAGGER, which is the whole of step 4.
//
// The operator met it in the field: bandwidth tests started by many agents
// could not be kept apart, and a voice test was crushed by the hourly
// bandwidth test. Here one process starts every test, so the rule is one
// lock in one worker:
//
//  * ONE THROUGHPUT TEST AT A TIME, everywhere, with a gap after each. Every
//    one leaves through RSCanvas's own link and, on a hub-and-spoke WAN, the
//    hub's - so serialising them is correct, not cautious, and it is what
//    makes both directions safe: no two sites ever send to the hub at once.
//  * NO VOICE TEST STARTS WHILE A THROUGHPUT TEST RUNS - or waits: a waiting
//    throughput test is let in as soon as the voice tests already running
//    finish, so a stream of overlapping voice tests cannot starve it. A
//    voice test is two short calls, so the wait is bounded.
//  * VOICE TESTS RUN BESIDE EACH OTHER: two calls' worth of traffic per site
//    cannot crowd a link.
//
// A readers-writer lock with the writer preferred, and the gap. Pure apart
// from the injected clock and timer, so the suite drives it.

export type Release = () => void;

export class PathGate {
    private voices = 0;
    private throughput = false;
    private lastThroughputEndMs = -Infinity;
    private readonly waitingThroughput: Array<(r: Release) => void> = [];
    private readonly waitingVoice: Array<(r: Release) => void> = [];
    private pumpTimer: unknown = null;
    private readonly gapMs: number;
    private readonly now: () => number;
    private readonly after: (fn: () => void, ms: number) => unknown;

    constructor(gapMs: number, now: () => number, after: (fn: () => void, ms: number) => unknown) {
        this.gapMs = gapMs;
        this.now = now;
        this.after = after;
    }

    /** Resolves when a voice test may start; call the release when it ends. */
    acquireVoice(): Promise<Release> {
        return new Promise((resolve) => { this.waitingVoice.push(resolve); this.pump(); });
    }

    /** Resolves when a throughput test may start, alone. */
    acquireThroughput(): Promise<Release> {
        return new Promise((resolve) => { this.waitingThroughput.push(resolve); this.pump(); });
    }

    /** What the stats say: who is running, who is waiting. */
    get state(): { throughput: boolean; voices: number; waitingThroughput: number; waitingVoice: number } {
        return {
            throughput: this.throughput, voices: this.voices,
            waitingThroughput: this.waitingThroughput.length, waitingVoice: this.waitingVoice.length,
        };
    }

    private pump(): void {
        if (this.throughput) return;
        if (this.waitingThroughput.length > 0) {
            if (this.voices > 0) return;          // let the running calls finish; admit no more
            const wait = this.lastThroughputEndMs + this.gapMs - this.now();
            if (wait > 0) {
                if (this.pumpTimer === null) {
                    this.pumpTimer = this.after(() => { this.pumpTimer = null; this.pump(); }, wait);
                }
                return;
            }
            const next = this.waitingThroughput.shift() as (r: Release) => void;
            this.throughput = true;
            let released = false;
            next(() => {
                if (released) return;
                released = true;
                this.throughput = false;
                this.lastThroughputEndMs = this.now();
                this.pump();
            });
            return;
        }
        while (this.waitingVoice.length > 0) {
            const next = this.waitingVoice.shift() as (r: Release) => void;
            this.voices++;
            let released = false;
            next(() => {
                if (released) return;
                released = true;
                this.voices--;
                this.pump();
            });
        }
    }
}
