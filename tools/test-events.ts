// Slice 10's pure half, asserted offline: rule compilation, matching, the
// accumulator that makes the upsert a rate limiter, and the key shape the
// TTL clear parses back out. Same standing as test-machine and test-reach.
//
// PROVEN ABLE TO FAIL, 2026-08-14 - six defects planted in the shipped
// module, every one caught after the sweep itself fixed this suite once:
//
//   accumulator inserts per match (the 10k limiter gone)  -> 2
//   broken regex accepted (throws on the ingest thread)   -> 2
//   null host folds fleet-wide, not source-IP fallback    -> 1
//   source scoping dropped (trap rules hear syslog)       -> 1
//   the sample follows the LAST line, not the first       -> 1
//   the g flag sneaks in (stateful regex)                 -> 1
//
// The fifth was NOT CAUGHT on the first sweep: the assertion was vacuous,
// 10,000 identical prefixes unable to tell first-kept from last-kept. The
// planted defect found the weak test before the weak test missed a real
// defect - which is the entire argument for running the sweep.

import {
    compileRule, matchMessage, eventLabel, MAX_PATTERN_LENGTH, NOTIFIER_APP,
    nestedQuantifier, RULE_BUDGET_MS, searchForm, wildcardRuns, MATCH_TEXT_MAX, keyHost, overflowKey,
    type EventRule, type CompiledRule, type PendingEvent, type MessageForMatch,
} from '../src/alerts/events.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};
const eq = (l: string, got: unknown, want: unknown): void => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g === w) ok(l); else bad(l, `got ${g}, wanted ${w}`);
};

const rule = (over: Partial<EventRule> = {}): EventRule => ({
    id: '7', name: 'link flap', pattern: 'link state changed', isRegex: false,
    source: 'any', severity: 'warn', ...over,
});

const msg = (over: Partial<MessageForMatch> = {}): MessageForMatch => ({
    msg: 'link state changed to down on Gi0/4', host: 'core-sw-01',
    sourceIp: '10.0.0.1', proto: 'syslog', app: 'sshd',
    ts: new Date('2026-08-14T22:00:00Z'), ...over,
});

function compiled(over: Partial<EventRule> = {}): CompiledRule {
    const r = compileRule(rule(over));
    if (!r.ok) throw new Error(`fixture rule failed to compile: ${r.detail}`);
    return r.compiled;
}

function main(): void {
    console.log('slice 10 offline: event alerting decisions\n');

    console.log('compilation');
    eq('a substring rule compiles', compileRule(rule()).ok, true);
    eq('a regex rule compiles', compileRule(rule({ pattern: 'Gi0/\\d+', isRegex: true })).ok, true);
    {
        const r = compileRule(rule({ pattern: '(unclosed', isRegex: true }));
        eq('a broken regex is refused AT COMPILE, never per-message', r.ok, false);
        if (!r.ok && r.detail.includes('does not compile')) ok('and the refusal says why');
        else bad('the refusal does not explain itself');
    }
    eq('an empty pattern is refused', compileRule(rule({ pattern: '' })).ok, false);
    eq(`a pattern past ${MAX_PATTERN_LENGTH} chars is refused - the cheap half of the ReDoS posture`,
        compileRule(rule({ pattern: 'x'.repeat(MAX_PATTERN_LENGTH + 1) })).ok, false);
    {
        // The same regex object serves every message; with a g flag,
        // RegExp.test would carry lastIndex between calls and alternate
        // true/false on identical input. The compiler must not accept flags
        // from anywhere - the pattern IS the whole input.
        const c = compiled({ pattern: 'down', isRegex: true });
        eq('a compiled regex is stateless across calls',
            [c.test('link down'), c.test('link down'), c.test('link down')],
            [true, true, true]);
    }

    console.log('\nmatching and the accumulator');
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg());
        eq('a match lands under the DESIGNED key shape', [...pending.keys()], ['event|7|core-sw-01']);
        const p = pending.get('event|7|core-sw-01') as PendingEvent;
        eq('with the rule and host aboard', [p.ruleId, p.host, p.severity], ['7', 'core-sw-01', 'warn']);
    }
    {
        // THE RATE LIMITER'S FIRST STAGE - the 10k requirement in miniature.
        const pending = new Map<string, PendingEvent>();
        const c = [compiled()];
        for (let i = 0; i < 10_000; i++) {
            matchMessage(c, pending, msg({ ts: new Date(1786744800000 + i) }));
        }
        eq('10,000 matching messages fold into ONE pending entry', pending.size, 1);
        const p = [...pending.values()][0] as PendingEvent;
        eq('which counted every one of them', p.count, 10_000);
        eq('and kept the newest timestamp', p.lastTs.getTime(), 1786744800000 + 9_999);
    }
    {
        // DISTINGUISHABLE lines, because the sweep caught the first version
        // of this assertion being vacuous: 10,000 identical prefixes cannot
        // tell first-line-kept from last-line-kept. The marker can.
        const pending = new Map<string, PendingEvent>();
        const c = [compiled()];
        matchMessage(c, pending, msg({ msg: 'link state changed FIRST-7391' }));
        matchMessage(c, pending, msg({ msg: 'link state changed LAST-4408' }));
        const p = [...pending.values()][0] as PendingEvent;
        if (p.sample.includes('FIRST-7391') && !p.sample.includes('LAST-4408')) {
            ok('the sample is the FIRST line - the one that raised it; later lines add count, not information');
        } else bad('the sample drifted from the first match', p.sample);
    }
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg({ host: 'sw-a' }));
        matchMessage([compiled()], pending, msg({ host: 'sw-b' }));
        eq('two hosts are two alerts - per-device granularity, the product ethos', pending.size, 2);
    }
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg({ host: null, sourceIp: '192.0.2.9', proto: 'trap' }));
        eq('the trap gap: a null host falls back to the source IP, never fleet-wide null',
            [...pending.keys()], ['event|7|192.0.2.9']);
    }
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled({ source: 'trap' })], pending, msg({ proto: 'syslog' }));
        eq('a trap-scoped rule ignores syslog', pending.size, 0);
        matchMessage([compiled({ source: 'trap' })], pending, msg({ proto: 'trap' }));
        eq('and hears traps', pending.size, 1);
    }
    {
        const pending = new Map<string, PendingEvent>();
        const two = [compiled(), compiled({ id: '8', name: 'oid watch', pattern: '1.3.6.1.6.3.1.1.5.3' })];
        matchMessage(two, pending, msg({ msg: 'trap 1.3.6.1.6.3.1.1.5.3 link state changed oid=ifIndex.4' }));
        eq('one message can feed two rules - they are independent alarms', pending.size, 2);
    }
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg({ msg: 'nothing relevant here' }));
        eq('a non-match writes nothing at all', pending.size, 0);
    }
    {
        // THE SELF-FEEDING LOOP, broken and pinned. On any box whose alert
        // syslog channel points at its own ingest, a notification carries the
        // alert's label, the label carries the sample, the sample contains
        // the pattern - and without this guard the notification matches its
        // own rule and the alert never TTL-clears. The notifier's line and
        // this guard share the NOTIFIER_APP constant, so they cannot drift.
        const pending = new Map<string, PendingEvent>();
        const n = matchMessage([compiled()], pending,
            msg({ app: NOTIFIER_APP, msg: 'RAISE link flap: link state changed to down on Gi0/4' }));
        eq('the product\'s own notifications never match a rule', [n, pending.size], [0, 0]);
    }

    console.log('\nthe label');
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg());
        const p = [...pending.values()][0] as PendingEvent;
        eq('rule name plus the evidence line, server-composed',
            eventLabel(p), 'link flap: link state changed to down on Gi0/4');
    }
    {
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg({ msg: 'link state changed ' + 'x'.repeat(500) }));
        const p = [...pending.values()][0] as PendingEvent;
        if (p.sample.length <= 200) ok('the sample is capped - a flood line must not become a 4KB label');
        else bad('sample uncapped', p.sample.length);
    }

    console.log('\nthe key round-trips for the TTL clear');
    {
        // The clear pass parses split_part(alert_key, '|', 2) - assert the
        // shape from this side so the two ends cannot drift silently.
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled({ id: '42' })], pending, msg({ host: 'a|b' }));
        const key = [...pending.keys()][0] as string;
        eq('the rule id sits in field 2 whatever the host contains',
            key.split('|')[1], '42');
    }

    console.log('\na host cannot make a key that reads as the overflow (review F11)');
    {
        // `*|1`, `*|2`, ... read as `event|<rule>|*` in field 3, so each was
        // kept as its own row past the 20-host cap and owed its own raise.
        const pending = new Map<string, PendingEvent>();
        for (let i = 0; i < 5; i++) matchMessage([compiled({ id: '42' })], pending, msg({ host: `*|${i}` }));
        const keys = [...pending.keys()];
        eq('five invented hosts are five keys', keys.length, 5);
        eq('none splits to a third field of *', keys.some((k) => k.split('|')[2] === '*'), false);
        eq('and each splits into exactly three fields', keys.every((k) => k.split('|').length === 3), true);
        eq('the escaped form', keys[0], 'event|42|%2A%7C0');
        const p = pending.get('event|42|%2A%7C0') as PendingEvent;
        eq('the alert row keeps the host as it was sent', p.host, '*|0');
        eq('a host of exactly * is not the overflow key', keyHost('*'), '%2A');
        eq('a percent sign is escaped too, so escapes cannot collide', keyHost('%2A'), '%252A');
        eq('an ordinary host is untouched', keyHost('core-sw-01.example.net'), 'core-sw-01.example.net');
    }

    console.log('\nthe pending map is bounded while the database cannot be asked (review F11)');
    {
        const pending = new Map<string, PendingEvent>();
        for (let i = 0; i < 50; i++) matchMessage([compiled({ id: '9' })], pending, msg({ host: `h-${i}` }), undefined, 10);
        eq('ten per-host keys and one overflow, not fifty', pending.size, 11);
        const o = pending.get(overflowKey('9')) as PendingEvent;
        eq('the overflow carries the other forty matches', o.count, 40);
        eq('and the overflow host, not one of the names', o.host, '*');
        matchMessage([compiled({ id: '9' })], pending, msg({ host: 'h-3' }), undefined, 10);
        eq('a host already pending still folds into its own key', (pending.get('event|9|h-3') as PendingEvent).count, 2);
    }

    console.log('\nthe host is bounded (2026-09-01 review)');
    {
        // HOSTNAME arrives from unauthenticated UDP with no upstream cap, and
        // it becomes the alert_key: unbounded, a flood of long invented
        // hostnames is a flood of unbounded alert rows. RFC 5424 allows 255.
        const pending = new Map<string, PendingEvent>();
        matchMessage([compiled()], pending, msg({ host: 'h'.repeat(10_000) }));
        const p = [...pending.values()][0] as PendingEvent;
        eq('a 10,000-char hostname is capped at 255 in the pending event', p.host.length, 255);
        const key = [...pending.keys()][0] as string;
        if (key.length <= 255 + 'event||'.length + 8) ok('and the key is bounded with it');
        else bad(`key uncapped at ${key.length} chars`);
        // Two messages whose invented hostnames agree only past the cap must
        // FOLD, not mint two rows - the cap is what restores the rate limiter.
        matchMessage([compiled()], pending, msg({ host: 'h'.repeat(12_000) }));
        eq('two hosts identical up to the cap fold into one pending event', pending.size, 1);
    }

    // ---- ReDoS: refuse at compile, disarm at run (2026-08-31, review S3) ------
    // MAX_PATTERN_LENGTH bounded how LONG a pattern is and said nothing about how
    // long it RUNS. Measured before the fix, /(a+)+$/ against a non-matching
    // subject: 45ms at 22 characters, 180ms at 24, 718ms at 26 - clean doubling,
    // and a syslog line may be 8,192 bytes. It runs per message on the ingest
    // thread, which owns the UDP sockets and the never-drop invariant.
    console.log('\nReDoS:');
    const redosRule = (pattern: string, isRegex = true): EventRule => ({
        id: 'r1', name: 'test rule', pattern, isRegex,
        source: 'any', severity: 'warn',
    });
    for (const p of ['(a+)+$', '(a*)*b', '([a-z]+)+$', '((x+))+y', '([a-zA-Z]+){2,}$']) {
        eq(`REFUSED at compile: ${p}`, compileRule(redosRule(p)).ok, false);
    }
    // The false-positive side decides whether this guard survives contact: one
    // that refuses real rules gets an exception added and then gets ignored.
    for (const p of [
        'link (up|down)', 'neighbor.*Down', 'CPU utilization is [0-9]+%',
        'Interface Gi[0-9]+/[0-9]+', 'temp=[0-9]{1,3}C', '(warning|critical) threshold',
        '.*(error|fail).*', 'a{3}', 'path\(s\)', '([a-z]+){2}',
        // A QUANTIFIED GROUP WHOSE BODY DOES NOT REPEAT is safe and common,
        // and these are here because a planted defect proved the list needed
        // them: dropping the inner-quantifier test made the scanner refuse
        // every quantified group, and nothing above noticed. Same failure the
        // header records from 2026-08-14 - the weak assertion found first.
        '(up|down)+', '(ab)*', '(GigabitEthernet)+', '(\w)+', '(node-[0-9])+',
    ]) {
        eq(`still armed, no false positive: ${p}`, compileRule(redosRule(p)).ok, true);
    }
    {
        const sub = compileRule(redosRule('anything', false));
        eq('a substring rule is not risky, so the budget never times it',
            sub.ok && sub.compiled.risky, false);
        const rex = compileRule(redosRule('link (up|down)'));
        eq('a regex rule is risky and therefore timed', rex.ok && rex.compiled.risky, true);
    }
    // The RUNTIME half. matchMessage REPORTS a rule over budget; the worker owns
    // the disarm, so the pure module stays pure.
    {
        const slow: Array<{ name: string; over: boolean }> = [];
        const stall: CompiledRule = {
            rule: redosRule('stand-in'),
            risky: true,
            // Stands in for a pathological regex without needing one - the budget
            // is what is under test here, not the engine.
            test: () => { const end = performance.now() + RULE_BUDGET_MS + 5; while (performance.now() < end); return false; },
        };
        matchMessage([stall], new Map(), {
            msg: 'x', host: 'h', sourceIp: '1.1.1.1', proto: 'syslog', app: null, ts: new Date(),
        }, (rule, ms) => { slow.push({ name: rule.name, over: ms >= RULE_BUDGET_MS }); });
        eq('a rule over budget is reported, with the rule and a time above it',
            slow.length === 1 && slow[0]?.over === true, true);
    }
    {
        const fired: string[] = [];
        const r = compileRule(redosRule('link (up|down)'));
        matchMessage(r.ok ? [r.compiled] : [], new Map(), {
            msg: 'link down', host: 'h', sourceIp: '1.1.1.1', proto: 'syslog', app: null, ts: new Date(),
        }, (rule) => { fired.push(rule.name); });
        eq('ordinary work does NOT trip the budget', fired.length, 0);
    }

    // ---- the polynomial half (2026-10-01, review F3) --------------------------
    // The review's measurements, before: `.*(error|fail).*(timeout|refused).*`
    // 22.7 s on an 8 KB line of "error ", and `.*error` 54 ms on an 8 KB line
    // with no match - over the budget, so one datagram disarmed the rule.
    console.log('\nReDoS, the polynomial half (review F3):');
    {
        eq('a leading .* is dropped', searchForm('.*error'), 'error');
        eq('and a trailing one', searchForm('.*(error|fail).*(timeout|refused).*'), '(error|fail).*(timeout|refused)');
        eq('lazy ones too', searchForm('.*?x.*?'), 'x');
        eq('an escaped dot is a full stop, kept', searchForm('a\\.*'), 'a\\.*');
        eq('an anchored pattern is left alone', searchForm('^.*x'), '^.*x');
        eq('a pattern that is only .* keeps it', searchForm('.*'), '.*');
        // Equivalence on real lines: the search form finds what the pattern
        // as written finds. A rule is tested, never anchored, so it must.
        const lines = ['', 'error', 'an error occurred', 'fail then timeout', 'x\nerror', 'timeout before fail',
            'link down', 'a.b', 'aaa', '...'];
        for (const p of ['.*error', '.*error.*', '.*(error|fail).*(timeout|refused).*', '.*?down', 'a\\.*', '.*a|b.*']) {
            const asWritten = new RegExp(p);
            const c = compileRule(redosRule(p));
            const same = c.ok && lines.every((l) => c.compiled.test(l) === asWritten.test(l));
            eq(`the search form of ${p} matches exactly the lines the pattern does`, same, true);
        }
    }
    {
        eq('one wildcard is armed', compileRule(redosRule('(error|fail).*(timeout|refused)')).ok, true);
        eq('one per alternative is armed', compileRule(redosRule('a.*b|c.*d')).ok, true);
        const two = compileRule(redosRule('BGP.*neighbor.*Down'));
        eq('two in one alternative are REFUSED (cubic: 258 ms on a crafted 4 KB line)', two.ok, false);
        eq('and the refusal says what to write instead', !two.ok && two.detail.includes('Keep one wildcard'), true);
        eq('x.*y.*z is refused (5.9 s on 4 KB, measured)', compileRule(redosRule('x.*y.*z')).ok, false);
        eq('.+ counts as a wildcard', compileRule(redosRule('a.+b.+c')).ok, false);
        eq('a wildcard inside a character class is not one', wildcardRuns('[.*]x[.+]'), 0);
        eq('nor an escaped dot', wildcardRuns('a\\.*b\\.+c'), 0);
    }
    {
        // The review's own suggested regression: an 8 KB line against `.*error`
        // must not disarm the rule. Plus the 22.7 s case and a 130 KB trap.
        const slow: string[] = [];
        const onSlow = (r: EventRule, ms: number): void => { slow.push(`${r.pattern} ${ms.toFixed(0)}ms`); };
        const cases: Array<[string, string]> = [
            ['.*error', 'a'.repeat(8186)],
            ['.*(error|fail).*(timeout|refused).*', 'error '.repeat(1364)],
            ['.*(error|fail).*(timeout|refused).*', 'error ' + 'ab'.repeat(65000)],
            ['x.*y', 'x'.repeat(8192)],
        ];
        for (const [p, line] of cases) {
            const c = compileRule(redosRule(p));
            if (!c.ok) { bad(`${p} should compile`, c.detail); continue; }
            matchMessage([c.compiled], new Map(), {
                msg: line, host: 'h', sourceIp: '1.1.1.1', proto: 'syslog', app: null, ts: new Date(),
            }, onSlow);
        }
        eq('none of the measured lines trips the budget any more', slow, []);
    }
    {
        // The trade, stated as a test: a regex looks at the first
        // MATCH_TEXT_MAX characters; a substring rule at all of them.
        const far = 'x'.repeat(MATCH_TEXT_MAX + 10) + ' link down';
        const rex = compileRule(redosRule('link (up|down)'));
        const sub = compileRule(redosRule('link down', false));
        eq('a regex does not see past MATCH_TEXT_MAX', rex.ok && rex.compiled.test(far), false);
        eq('a substring rule does', sub.ok && sub.compiled.test(far), true);
        eq('and within it a regex sees everything', rex.ok && rex.compiled.test('x'.repeat(4000) + ' link down'), true);
    }
    console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
}

main();
