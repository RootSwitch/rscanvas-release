// The search grammar, offline: what each token PARSES TO.
//
// What rows those clauses match is the live half, covered by
// test-search-semantics (semantics) and test-engine-differential (row-for-row
// against the parent's filter.js). This file pins the parse itself, including
// the two rules easiest to lose in a refactor: FORGIVENESS (anything the
// grammar cannot digest is search text, never an error) and the trailing-dot
// ip habit reading as the CIDR it always meant.

import { readFileSync } from 'node:fs';
import {
    tokenize, parseQuery, parseIpValue, parseWhen, type Clause,
} from '../src/search/grammar.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

const one = (q: string): Clause => {
    const c = parseQuery(q);
    if (c.length !== 1) throw new Error(`expected one clause from ${JSON.stringify(q)}`);
    return c[0]!;
};

const expect = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) ok(label);
    else bad(label, `got ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`);
};

console.log('search grammar: what each token parses to\n');

// --- tokenizing, the parent's exact behaviour ---------------------------------
expect('quoted phrase is one token', tokenize('a "link down" b'), ['a', 'link down', 'b']);
expect('negated quoted phrase keeps its minus', tokenize('-"link down"'), ['-link down']);
expect('a bare minus is dropped', tokenize('a - b'), ['a', 'b']);

// --- free text and forgiveness ------------------------------------------------
expect('a plain word is text', one('error'),
    { kind: 'text', value: 'error', negate: false });
expect('a time-of-day is text, not a failed filter - the forgiveness rule', one('12:30:05'),
    { kind: 'text', value: '12:30:05', negate: false });
expect('an unknown key is text', one('nosuchkey:value'),
    { kind: 'text', value: 'nosuchkey:value', negate: false });
expect('an unknown ~key is text too', one('speed~fast'),
    { kind: 'text', value: 'speed~fast', negate: false });
expect('negation applies to text', one('-noise'),
    { kind: 'text', value: 'noise', negate: true });

// --- host and app: exact vs substring is the OPERATOR, never a guess ----------
expect('host: is exact', one('host:core-sw'),
    { kind: 'host', op: 'exact', value: 'core-sw', negate: false });
expect('host~ is substring', one('host~core'),
    { kind: 'host', op: 'substring', value: 'core', negate: false });
expect('app: is exact', one('app:sshd'),
    { kind: 'app', op: 'exact', value: 'sshd', negate: false });
expect('app~ is substring', one('app~ssh'),
    { kind: 'app', op: 'substring', value: 'ssh', negate: false });
expect('negated host: keeps exactness', one('-host:core-sw'),
    { kind: 'host', op: 'exact', value: 'core-sw', negate: true });
// procid gets no ~ form: a pid is opaque and a substring of one means nothing.
// The clause exists because procid is its own column now (sql/slice7.sql) -
// app:sshd finds every sshd whatever its pid, and the pid is asked for by name.
expect('procid: is exact', one('procid:1234'),
    { kind: 'procid', value: '1234', negate: false });
expect('pid: is the short alias', one('pid:1234'),
    { kind: 'procid', value: '1234', negate: false });
expect('negated procid:', one('-procid:1234'),
    { kind: 'procid', value: '1234', negate: true });
expect('procid~ is not an operator, so it is text - the forgiveness rule', one('procid~12'),
    { kind: 'text', value: 'procid~12', negate: false });
expect('the earliest separator wins: host~a:b substrings "a:b"', one('host~a:b'),
    { kind: 'host', op: 'substring', value: 'a:b', negate: false });

// --- ip: containment, with the trailing-dot habit kept ------------------------
expect('a full address is /32', parseIpValue('10.0.0.9'), '10.0.0.9/32');
expect('an explicit CIDR passes through', parseIpValue('10.0.0.0/24'), '10.0.0.0/24');
expect('three octets and a dot read as /24 - the parent habit, now meaning containment',
    parseIpValue('10.0.0.'), '10.0.0.0/24');
expect('two octets and a dot read as /16', parseIpValue('10.0.'), '10.0.0.0/16');
expect('one octet and a dot reads as /8', parseIpValue('10.'), '10.0.0.0/8');
expect('an IPv6 address is /128', parseIpValue('2001:db8::1'), '2001:db8::1/128');
expect('a 999 octet does not parse', parseIpValue('999.0.0.'), null);
expect('a bare partial without the dot does not parse - genuinely ambiguous', parseIpValue('10.0'), null);
expect('an out-of-range mask does not parse', parseIpValue('10.0.0.0/40'), null);
expect('ip: with a parseable value is a containment clause', one('ip:10.0.0.'),
    { kind: 'ip', cidr: '10.0.0.0/24', negate: false });
expect('ip: with an unparseable value is TEXT, not an error', one('ip:banana'),
    { kind: 'text', value: 'ip:banana', negate: false });

// --- severity and facility ----------------------------------------------------
expect('sev:err resolves the name, exact by default', one('sev:err'),
    { kind: 'severity', op: '=', value: 3, negate: false });
expect('sev:<=3 carries the operator', one('sev:<=3'),
    { kind: 'severity', op: '<=', value: 3, negate: false });
expect('severity: is an alias', one('severity:warning'),
    { kind: 'severity', op: '=', value: 4, negate: false });
expect('fac:daemon resolves', one('fac:daemon'),
    { kind: 'facility', op: '=', value: 3, negate: false });
expect('fac:local0 resolves', one('fac:local0'),
    { kind: 'facility', op: '=', value: 16, negate: false });
expect('sev:nonsense is text - forgiveness again', one('sev:nonsense'),
    { kind: 'text', value: 'sev:nonsense', negate: false });

// --- proto, after, before -----------------------------------------------------
expect('proto:trap parses', one('proto:trap'),
    { kind: 'proto', value: 'trap', negate: false });
expect('proto:carrier-pigeon is text', one('proto:carrier-pigeon'),
    { kind: 'text', value: 'proto:carrier-pigeon', negate: false });
{
    const c = one('after:2026-07-01T14:30');
    const want = new Date(2026, 6, 1, 14, 30, 0);
    if (c.kind === 'after' && c.ts.getTime() === want.getTime()) {
        ok('after: parses local wall-clock time, like the parent');
    } else {
        bad('after: parsed wrong', JSON.stringify(c));
    }
}
expect('a malformed date is text', one('after:whenever'),
    { kind: 'text', value: 'after:whenever', negate: false });
// THE PARENT ROLLS THESE OVER. Verified against the pinned copy:
// buildWhere('after:2026-99-99') binds epoch 2033269200 = 2034-06-07, so a
// typo'd month silently filters out everything and reads as "no data".
expect('a 99th month is rejected, not rolled into 2034', parseWhen('2026-99-99'), null);
expect('and February 30th is rejected rather than becoming March 2nd', parseWhen('2026-02-30'), null);
expect('an hour of 25 is rejected', parseWhen('2026-07-01T25:00'), null);
{
    const leap = parseWhen('2024-02-29');
    if (leap !== null && leap.getMonth() === 1 && leap.getDate() === 29) {
        ok('while a real leap day still parses - the check is round-trip, not a calendar guess');
    } else {
        bad('the round-trip check rejected a valid leap day', JSON.stringify(leap));
    }
}

// --- a whole query ------------------------------------------------------------
expect('a realistic query parses clause by clause',
    parseQuery('sev:<=3 host~core -"link flap" ip:10.0.0. proto:syslog'),
    [
        { kind: 'severity', op: '<=', value: 3, negate: false },
        { kind: 'host', op: 'substring', value: 'core', negate: false },
        { kind: 'text', value: 'link flap', negate: true },
        { kind: 'ip', cidr: '10.0.0.0/24', negate: false },
        { kind: 'proto', value: 'syslog', negate: false },
    ]);


// --- the help panel is pinned to the parser ----------------------------------
//
// public/app.js carries a GRAMMAR_HELP array and, until the 2026-08-13 review,
// a comment claiming this file pinned it. IT DID NOT. Nothing read app.js, so
// the help text was a hand-written copy of the grammar free to drift into
// describing operators that do not exist - the exact shape check-call-sites
// was built to prevent: an observation about the code is not a property of it.
//
// So it is a property now. The array is READ OUT OF THE SHIPPED FILE and every
// operator token in it is put through the real parser. A line describing
// `hostx:` would fail here rather than mislead an operator forever.
//
// Deliberately loose about the PROSE: these lines are documentation, and
// asserting on their wording would make the test a spellchecker that fires on
// every rewrite. It asserts only the thing that can be wrong in a way that
// matters - that each operator shown is one the parser actually implements.
{
    const src = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const m = src.match(/const GRAMMAR_HELP = \[([\s\S]*?)\];/);
    if (m === null) {
        bad('could not find GRAMMAR_HELP in public/app.js - has it been renamed?');
    } else {
        const lines = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1] as string);
        if (lines.length === 0) bad('GRAMMAR_HELP parsed as empty');
        else ok(`read ${lines.length} help lines out of public/app.js`);

        // Every "word:" or "word~" token the panel shows, deduplicated.
        const shown = new Set<string>();
        for (const line of lines) {
            for (const t of line.matchAll(/\b([a-z]+)([:~])/g)) shown.add(t[1] + t[2]);
        }
        for (const token of [...shown].sort()) {
            const key = token.slice(0, -1);
            const kind = token.slice(-1);
            // A value the parser will accept for this operator, so the clause
            // is exercised rather than the key alone.
            const sample = key === 'sev' ? '<=3'
                : key === 'ip' ? '10.0.0.'
                : key === 'after' || key === 'before' ? '2026-08-01'
                : key === 'proto' ? 'trap'
                : key === 'fac' ? 'daemon' : 'x';
            const clauses = parseQuery(`${key}${kind}${sample}`);
            // The parser turns an UNKNOWN key into free text, deliberately, so
            // "did it stay text" is exactly the test for "does this operator
            // exist".
            const isText = clauses.length === 1 && clauses[0]?.kind === 'text';
            if (isText) {
                bad(`the help panel advertises "${token}" but the parser treats it as free text`);
            } else {
                ok(`help panel operator ${token} parses to a real clause`);
            }
        }
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
