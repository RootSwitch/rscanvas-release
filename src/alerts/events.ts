// Event-driven alerting: the pure half. Rule compilation, per-message
// matching, and the flush accumulator. No database, no sockets, no timers -
// the ingest worker owns the I/O, tools/test-events.ts owns these decisions.
//
// THE CENTRAL PROPERTY, from the decided design (SLICE-6-PLAN, 2026-08-02):
// an edge never raises through a scan-counting machine. A matching message
// births an alert ACTIVE in one step, and the upsert keyed by
// event|<ruleId>|<host> IS the rate limiter - the pre-registered requirement
// is 10,000 matching messages producing ONE row and ONE notification. The
// first stage of that limiter lives here: matches accumulate in memory per
// key, and a flush emits ONE row per key however many messages fed it.

export interface EventRule {
    id: string;
    name: string;
    pattern: string;
    isRegex: boolean;
    source: 'any' | 'syslog' | 'trap';
    severity: 'warn' | 'crit';
}

export interface CompiledRule {
    rule: EventRule;
    /** True when this message text matches. Never throws. */
    test: (msg: string) => boolean;
    /** Can this test backtrack at all? Only regex rules can; a substring
     *  match is linear, so only these are worth timing. */
    risky: boolean;
}

/** Patterns longer than this are refused at compile - a length cap is the
 *  cheap half of the ReDoS posture recorded in SLICE-10-PLAN item 4. */
export const MAX_PATTERN_LENGTH = 512;

/**
 * NESTED-QUANTIFIER REFUSAL, the half of the ReDoS posture that was missing
 * (2026-08-31, independent review S3).
 *
 * `MAX_PATTERN_LENGTH` bounds how LONG a pattern is and says nothing about
 * how long it RUNS. `(a+)+$` is seven characters. The subject can be a whole
 * datagram - `MAX_DATAGRAM_BYTES` is 8192 - and `test` runs per message on
 * the INGEST thread, the one thread in the system that owns the UDP sockets
 * and carries the never-drop invariant. A stall there costs
 * accepted-but-unwritten datagrams.
 *
 * THE TRIGGER IS ORDINARY, NOT ADVERSARIAL, which is what makes this worth
 * refusing rather than merely counting. `.*(error|fail).*(timeout|refused).*`
 * is a rule an admin writes at 3am while debugging; the messages arrive from
 * unauthenticated sources by design. The rule was authored honestly and the
 * thread stops.
 *
 * WHY REFUSE AT COMPILE RATHER THAN TIME IT AT RUN. JavaScript cannot
 * interrupt a regex - there is no preemption, no timeout, no way back until
 * the engine returns. So a budget can only ever notice AFTER the stall it was
 * meant to prevent. Refusal happens at authoring time, in front of the person
 * who can fix it, before it has run once. The runtime budget below is the
 * backstop for what this misses, not the primary control.
 *
 * WHAT IT CATCHES: a quantifier applied to a group whose body already
 * contains one - `(a+)+`, `(a*)*`, `([a-z]+){2,}`, `((x+))+`. That is the
 * classic exponential shape and the one that shows up in real incidents.
 *
 * WHAT IT DOES NOT CATCH, stated because a checker with unwritten limits gets
 * trusted for things it never did: overlapping alternations like `(a|a)*`,
 * and polynomial cases like `.*.*=.*`. Deciding those needs real analysis of
 * the automaton rather than a scan. This is a floor, and the runtime disarm
 * is what covers the rest.
 */
export function nestedQuantifier(pattern: string): { at: number; group: string } | null {
    // A tiny scanner rather than a regex over a regex: escapes and character
    // classes both contain characters that would otherwise read as syntax,
    // and getting THAT wrong is how a guard starts refusing valid rules.
    const stack: Array<{ start: number; hasQuant: boolean }> = [];
    let topHasQuant = false;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === '[') {
            while (i < pattern.length && pattern[i] !== ']') {
                if (pattern[i] === '\\') i += 1;
                i += 1;
            }
            continue;
        }
        if (ch === '(') { stack.push({ start: i, hasQuant: topHasQuant }); topHasQuant = false; continue; }
        if (ch === ')') {
            const g = stack.pop();
            const bodyHadQuant: boolean = topHasQuant;
            // Does a quantifier follow the group?
            const next = pattern[i + 1];
            let quantified = next === '*' || next === '+';
            if (next === '{') {
                // {n} is bounded and safe; {n,} and {n,m} with a large m are
                // the repeat that matters.
                const close = pattern.indexOf('}', i + 1);
                const body = close === -1 ? '' : pattern.slice(i + 2, close);
                quantified = body.includes(',');
            }
            if (quantified && bodyHadQuant && g !== undefined) {
                return { at: g.start, group: pattern.slice(g.start, Math.min(i + 2, pattern.length)) };
            }
            // A quantified group is itself a quantifier as far as ITS parent
            // is concerned, so `((a+))+` is caught at the outer level too.
            topHasQuant = (g?.hasQuant ?? false) || bodyHadQuant || quantified;
            continue;
        }
        if (ch === '*' || ch === '+') { topHasQuant = true; continue; }
        if (ch === '{' && pattern.slice(i + 1, pattern.indexOf('}', i) + 1).includes(',')) {
            topHasQuant = true;
        }
    }
    return null;
}

/**
 * A single rule test slower than this on ONE message is not slow, it is
 * pathological: a normal test is microseconds. Used by the ingest worker to
 * disarm the rule rather than keep paying it - see matchMessage's onSlow.
 */
export const RULE_BUDGET_MS = 50;

/**
 * Compile one rule, or say exactly why not.
 *
 * A BROKEN RULE MUST NOT BREAK THE OTHERS: the ingest path compiles what it
 * can and reports what it cannot, the same per-item isolation the probe and
 * the parent's poller both converged on. A regex that fails to compile is
 * refused HERE, at arm time - never discovered per-message on the latency
 * thread.
 */
export function compileRule(rule: EventRule): { ok: true; compiled: CompiledRule } | { ok: false; detail: string } {
    if (rule.pattern.length === 0) return { ok: false, detail: 'empty pattern' };
    if (rule.pattern.length > MAX_PATTERN_LENGTH) {
        return { ok: false, detail: `pattern longer than ${MAX_PATTERN_LENGTH} characters` };
    }
    if (!rule.isRegex) {
        const needle = rule.pattern;
        return { ok: true, compiled: { rule, risky: false, test: (msg) => msg.includes(needle) } };
    }
    const nested = nestedQuantifier(rule.pattern);
    if (nested !== null) {
        return {
            ok: false,
            detail: `"${nested.group}" repeats a group that already repeats, at position `
                + `${nested.at}. On a long line that can take exponential time and this `
                + 'pattern runs per message on the ingest thread, so it is refused rather '
                + 'than armed. Drop the outer repeat, or match the part that identifies '
                + 'the line rather than the whole of it.',
        };
    }
    let re: RegExp;
    try {
        re = new RegExp(rule.pattern);
    } catch (err) {
        return { ok: false, detail: `regex does not compile: ${(err as Error).message}` };
    }
    // re.test carries lastIndex state only with the g/y flags, which user
    // patterns here never get - the constructor above adds none.
    // `risky` is what the runtime budget times: a substring rule is linear
    // and cannot backtrack, so timing it would be pure overhead on the
    // latency thread for a case that cannot occur.
    return { ok: true, compiled: { rule, risky: true, test: (msg) => re.test(msg) } };
}

/**
 * The APP-NAME the notify layer stamps on its own syslog datagrams - ONE
 * constant, imported by notify.ts, so the loop-breaker below and the line
 * builder cannot drift apart.
 *
 * THE LOOP IT BREAKS, found while writing the live test rather than in
 * production: on any box whose alert-syslog channel points at its own ingest
 * (the lab and the sandbox both do), a notification for an event alert
 * carries the alert's label, the label carries the sample line, and the
 * sample contains the pattern - so the notification MATCHES ITS OWN RULE,
 * refreshes last_seen_ts, and the alert can never TTL-clear. Self-sustaining
 * by construction. The cost of the fix is stated plainly: the product cannot
 * event-alert on its own notification stream, which is the correct trade.
 */
export const NOTIFIER_APP = 'rscanvas';

export interface MessageForMatch {
    msg: string;
    host: string | null;
    sourceIp: string;
    proto: string;
    app: string | null;
    ts: Date;
}

/** One accumulated alert-to-be, the flush's unit of work. */
export interface PendingEvent {
    alertKey: string;
    ruleId: string;
    ruleName: string;
    severity: 'warn' | 'crit';
    host: string;
    /** Messages folded into this key since the last flush. */
    count: number;
    lastTs: Date;
    /** The FIRST matching line of the window, as the label's evidence - the
     *  first is the one that raised it, and a flood's later lines add count,
     *  not information. */
    sample: string;
}

/**
 * The accumulator: match one message against the compiled set, folding hits
 * into the pending map. Called on the ingest hot path - the work is N cheap
 * tests and a map upsert, and N is the number of ENABLED rules, expected in
 * the dozens.
 *
 * The alert_key's host component falls back to the SOURCE IP when the parser
 * produced no hostname - the recorded trap gap: traps carry host = null
 * until an IP-to-device resolution exists, and a null host would fold every
 * trap-sourced match fleet-wide into one alert, which is the wrong
 * granularity in the common case.
 */
export function matchMessage(
    compiled: CompiledRule[], pending: Map<string, PendingEvent>, m: MessageForMatch,
    onSlow?: (rule: EventRule, ms: number) => void,
): number {
    // The loop-breaker's recorded cost, stated where it is paid: a sender
    // spoofing APP-NAME as the notifier's own name exempts itself from ALL
    // event alerting. Accepted - the alternative is the self-feeding loop -
    // but it is an exemption an attacker can claim, not only the notifier.
    if (m.app === NOTIFIER_APP) return 0;
    let matched = 0;
    for (const c of compiled) {
        if (c.rule.source !== 'any' && c.rule.source !== m.proto) continue;
        // THE BACKSTOP, and it can only ever report a stall that already
        // happened - JavaScript cannot interrupt a regex. Its value is that
        // the SECOND message does not pay it too: the worker disarms the rule
        // by id and names it. Timed only for regex rules, because a substring
        // match is linear and clock reads on the latency thread are not free.
        let hit: boolean;
        if (c.risky && onSlow !== undefined) {
            const t0 = performance.now();
            hit = c.test(m.msg);
            const ms = performance.now() - t0;
            if (ms >= RULE_BUDGET_MS) onSlow(c.rule, ms);
        } else {
            hit = c.test(m.msg);
        }
        if (!hit) continue;
        matched += 1;
        // BOUNDED, because HOSTNAME arrives from unauthenticated UDP and
        // nothing upstream caps it - RFC 5424 allows 255 octets, an 8KB
        // datagram allows far more, and this value becomes the alert_key and
        // the alert row's host. An unbounded attacker-controlled key is how
        // the one-row-per-incident upsert stops being a rate limiter. The
        // stored MESSAGE keeps the full host (never-drop applies to the
        // record, not to identity minted from it).
        const host = (m.host ?? m.sourceIp).slice(0, 255);
        const key = `event|${c.rule.id}|${host}`;
        const existing = pending.get(key);
        if (existing === undefined) {
            pending.set(key, {
                alertKey: key,
                ruleId: c.rule.id,
                ruleName: c.rule.name,
                severity: c.rule.severity,
                host,
                count: 1,
                lastTs: m.ts,
                sample: m.msg.slice(0, 200),
            });
        } else {
            existing.count += 1;
            if (m.ts > existing.lastTs) existing.lastTs = m.ts;
        }
    }
    return matched;
}

/**
 * The label an alert row carries: rule name plus the evidence line. Built
 * here so the UI renders what was decided, not what it recomposes - the same
 * server-writes-the-sentence rule as the removal gate.
 */
export function eventLabel(p: PendingEvent): string {
    return `${p.ruleName}: ${p.sample}`;
}
