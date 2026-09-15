// The impure half of reachability: spawn fping, feed it targets, collect the
// answers. Everything decided ABOUT the output lives in reach.ts where the
// offline suite can reach it; this module only moves bytes.
//
// ONE PROCESS PER SWEEP for the whole fleet, never one per host - fping's
// internal scheduler is the fire-together-bounded-wait pattern the parent
// poller converged on, natively: probes go out at a send spacing, per-target
// waits OVERLAP, and a sweep costs about N x spacing + one timeout tail
// TOTAL. The down-fraction is nearly free, which is the property the suite's
// TCP scale test measured the batched parent NOT having (a breach near
// N~1,700 from batch-poisoning). Detection cadence must not degrade exactly
// when the fleet is broken.
//
// -r 0 IS LOAD-BEARING: fping's default 3-retries-with-backoff is a second
// debouncer hiding in a flag, and debounce belongs to the alert machine's
// raiseScans alone.
//
// Targets go on STDIN, not argv: the enterprise ceiling is 30k devices and
// argv has a limit somewhere between here and there. Stdin does not.

import { spawn } from 'node:child_process';
import { parseFpingLine, type ProbeReading } from './reach.ts';

/**
 * Is fping present at all? Checked ONCE at worker startup, loudly - the plan
 * forbids a silent degrade to no-reachability. A fleet whose reach_state sits
 * at 'unknown' forever because a package was missing must say why in the log
 * and in the stats, not read as a quiet fleet.
 */
export function fpingAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
        const p = spawn('fping', ['-v'], { stdio: ['ignore', 'ignore', 'ignore'] });
        p.on('error', () => resolve(false));
        p.on('exit', (code) => resolve(code === 0));
    });
}

/**
 * One sweep. Returns a reading per host that produced a per-target line;
 * hosts absent from the map fall through to `unknown` in applySweep - which
 * is also where an UNRESOLVABLE name lands, because fping 5.1 emits NO
 * per-target line for one (verified live on the sandbox, not assumed from
 * the manual).
 *
 * Never rejects on fping's exit code: fping exits 1 when any host was
 * unreachable and 2 on other errors, and an unreachable host is a RESULT.
 * The only failure this propagates is failing to spawn at all.
 */
export function runFpingSweep(
    hosts: string[], timeoutMs: number,
): Promise<Map<string, ProbeReading | null>> {
    return new Promise((resolve, reject) => {
        const readings = new Map<string, ProbeReading | null>();
        if (hosts.length === 0) { resolve(readings); return; }

        const p = spawn(
            'fping',
            ['-C', '1', '-q', '-r', '0', '-t', String(timeoutMs)],
            { stdio: ['pipe', 'ignore', 'pipe'] },
        );
        let stderr = '';
        p.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
        p.on('error', (err) => reject(err));
        p.on('exit', () => {
            for (const line of stderr.split('\n')) {
                const parsed = parseFpingLine(line);
                if (parsed !== null) readings.set(parsed.host, parsed.reading);
            }
            resolve(readings);
        });
        p.stdin.on('error', () => { /* fping exited early; exit handler owns the outcome */ });
        p.stdin.write(hosts.join('\n') + '\n');
        p.stdin.end();
    });
}
