// The scan's reading of one service check (slice 58): a stored row in, the
// engine's ScanService out. Pure, so tools/test-service-checks.ts holds the
// classification without a database - rules.ts judges, this decodes, and the
// outcome codes stay owned by src/checks/model.ts.

import type { ScanService } from './rules.ts';
import { ANSWERED_OUTCOMES, DOWN_OUTCOMES, OUTCOME_TEXT, outcomeName } from '../checks/model.ts';

export interface ServiceRow {
    code: string;
    name: string;
    kind: string;
    has_assertion: boolean;
    tls: boolean;
    lv_status: number | null;
    lv_v0: number | null;
    lv_v1: number | null;
    lv_v2: number | null;
    lv_v3: number | null;
    lv_v4: number | null;
    lv_v5: number | null;
    fresh: boolean;
    device_name: string;
    /** The run before the last, for web and TCP checks (2026-10-07): its
     *  response time and outcome, null when there was none. */
    prev_v0?: number | null;
    prev_v5?: number | null;
}

export function scanServiceOf(r: ServiceRow): ScanService {
    const outcome = outcomeName(r.lv_v5);
    // An outcome this build does not know is no evidence either way - a newer
    // build's code read by an older one must freeze, never page. So, for a
    // VOICE test, is iperf3 failing in words nobody classified (slice 60):
    // refused, timed out, unreachable, unresolved, a login, busy for good
    // are each named and each down; what is left is iperf3 itself having a
    // bad call - one in eleven under the drill's impairment, unexplained -
    // and that must not read as the responder gone.
    const unknown = outcome === null || outcome === 'ours'
        || ((r.kind === 'path-voice' || r.kind === 'path-tput') && outcome === 'error');
    const answered = outcome !== null && ANSWERED_OUTCOMES.has(outcome);
    let downReason: string | null = null;
    if (outcome !== null && DOWN_OUTCOMES.has(outcome)) {
        downReason = outcome === 'wrong-status' && r.lv_status !== null
            ? `${OUTCOME_TEXT[outcome]} ${r.lv_status}` : OUTCOME_TEXT[outcome];
    }
    // A voice test (slice 60) reads its own layout: loss and jitter both
    // ways and the MOS, present only when the call ran.
    const voice = r.kind !== 'path-voice' ? undefined
        : outcome === 'ok' && r.lv_v0 !== null && r.lv_v1 !== null && r.lv_v2 !== null && r.lv_v3 !== null
            ? { lossTo: r.lv_v0, lossFrom: r.lv_v1, jitterTo: r.lv_v2, jitterFrom: r.lv_v3, mos: r.lv_v4 }
            : null;
    // A throughput test (slice 61): Mbps each way, when the calls ran.
    const tput = r.kind !== 'path-tput' ? undefined
        : outcome === 'ok' && r.lv_v0 !== null && r.lv_v1 !== null ? { mbpsTo: r.lv_v0, mbpsFrom: r.lv_v1 } : null;
    return {
        code: r.code,
        kind: r.kind,
        host: r.device_name,
        name: r.name,
        fresh: r.fresh,
        unknown,
        downReason,
        answered,
        hasAssertion: r.has_assertion,
        contentFailed: !r.has_assertion || !answered ? null : outcome !== 'ok',
        httpStatus: r.lv_status,
        totalMs: r.lv_v0,
        // The run before, counted only if it answered - a response time is
        // a fact about an answer (two slow runs in a row, 2026-10-07).
        prevTotalMs: (() => {
            const p = outcomeName(r.prev_v5 ?? null);
            return p !== null && ANSWERED_OUTCOMES.has(p) && typeof r.prev_v0 === 'number' ? r.prev_v0 : null;
        })(),
        tls: r.tls,
        certDays: r.kind === 'svc-http' ? r.lv_v2 : null,
        ...(voice !== undefined ? { voice } : {}),
        ...(tput !== undefined ? { tput } : {}),
    };
}
