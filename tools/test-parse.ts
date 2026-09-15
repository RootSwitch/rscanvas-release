// Parser regression test, ported from syslogcanvas/tools/test-parse.js.
//
// Exercises the RFC 3164 / 5424 extraction against a corpus of real device
// shapes, including the edge cases that have bitten before (nil structured
// data, nil host, an empty message body, no PRI) and the Cisco family, which
// is where the actual work in this parser went.
//
// It also covers BUILD-PLAN slice 1's done-when criterion "an unparseable
// datagram is stored whole with whatever fields did parse" on the parse side.
// The storage side of that criterion needs the database and is checked by the
// live run.
//
//   node tools/test-parse.ts

import { parse } from '../src/syslog/parse.ts';
import { copyEscape, copyLine, stripNul } from '../src/store/copy.ts';

type Case = [
    label: string,
    raw: string,
    expMsg: string,
    expHost?: string | null,
    expApp?: string | null,
    expProcid?: string | null,
];

// The pid-bearing cases assert app AND procid, and the assertion is the point:
// the first parser read the protocol's separate APP-NAME and PROCID fields and
// concatenated them back together ('sshd[1234]'), and no case here noticed,
// because none asserted app on a line that carried a pid. That flattening
// exploded app's cardinality (45,140 distinct values on the demo corpus) and
// broke exact app: - `app:sshd` silently missed every sshd[1234] row, a
// PARTIAL answer reading as a complete one. app must come back BARE and the
// pid in its own field, both forms of the wire syntax.
const CASES: Case[] = [
    ['5424 nil SD',          '<34>1 2003-10-11T22:14:15.003Z host.example.com su - ID47 - message here', 'message here', 'host.example.com', 'su', null],
    ['5424 nil SD short',    '<13>1 2026-07-18T12:00:00Z fw app 1234 msgid - the message', 'the message', 'fw', 'app', '1234'],
    ['5424 with SD',         '<165>1 2026-07-18T12:00:00Z host app 42 ID [exampleSDID@0 x="y"] real msg', 'real msg', 'host', 'app', '42'],
    ['5424 nil host',        '<13>1 2026-07-18T12:00:00Z - app - - - just msg', 'just msg', null, 'app', null],
    ['5424 empty message',   '<13>1 2026-07-18T12:00:00Z host app - - -', '', 'host', 'app', null],
    ['3164 basic',           '<34>Oct 11 22:14:15 mymachine su: msg body', 'msg body', 'mymachine', 'su', null],
    ['3164 no PRI',          'Oct 11 22:14:15 host kernel: something', 'something', 'host', 'kernel', null],
    ['3164 tag with pid',    '<38>Jul 18 09:00:00 gw sshd[1234]: accepted', 'accepted', 'gw', 'sshd', '1234'],

    // --- Cisco. None of these are RFC 3164 and none agree with each other.
    // Before the %FACILITY-SEVERITY-MNEMONIC anchor existed they did not merely
    // parse incompletely, they parsed WRONG: CatOS put its message body in the
    // HOST column and IOS put its sequence number in APP, which quietly poisons
    // host:/app: filtering for very common gear. Nothing was ever lost - raw
    // always held the datagram - but the columns lied.
    ['IOS seq + host + *clock',
     '<190>1234: cube-01: *Jul 25 14:30:00.456: %SYS-5-CONFIG_I: Configured from console by admin',
     '%SYS-5-CONFIG_I: Configured from console by admin', 'cube-01', 'SYS'],
    ['IOS seq, no hostname',
     '<187>000123: *Jul 25 14:30:00.456 UTC: %LINK-3-UPDOWN: Interface Gi0/1, changed state to down',
     '%LINK-3-UPDOWN: Interface Gi0/1, changed state to down', null, 'LINK'],
    ['CatOS, no hostname at all',
     '<189>Jul 25 14:30:00 %SYS-5-MOD_OK:Module 3 is online',
     '%SYS-5-MOD_OK:Module 3 is online', null, 'SYS'],
    ['ASA, year inside the timestamp',
     '<166>Jul 25 2026 14:30:00 asa-fw : %ASA-6-302013: Built outbound TCP connection 12345',
     '%ASA-6-302013: Built outbound TCP connection 12345', 'asa-fw', 'ASA'],
    // The zone must not eat a hostname: a lax [A-Za-z]{2,5} matches the "asa"
    // of "asa-fw". A real zone abuts its colon; a hostname does not.
    ['ASA with an uppercase timezone',
     '<166>Jul 25 2026 14:30:00 CDT: %ASA-4-106023: Deny tcp src outside:10.1.1.1/443',
     '%ASA-4-106023: Deny tcp src outside:10.1.1.1/443', null, 'ASA'],
    // A % pattern deep in prose is NOT a Cisco header - the anchor only counts
    // when the whole header is accounted for, or ordinary text would be shredded.
    ['prose mentioning a mnemonic late',
     '<13>Jul 25 14:30:00 host app: operator note about %SYS-5-CONFIG_I: seen earlier today',
     'operator note about %SYS-5-CONFIG_I: seen earlier today', 'host', 'app'],
];

let pass = 0;
let fail = 0;

for (const [label, raw, expMsg, expHost, expApp, expProcid] of CASES) {
    const row = parse(raw, '203.0.113.9');
    const msgOk = row.msg === expMsg;
    const hostOk = expHost === undefined || row.host === expHost;
    const appOk = expApp === undefined || row.app === expApp;
    const procidOk = expProcid === undefined || row.procid === expProcid;
    const leaked = /^- /.test(row.msg);
    // Carried into every case rather than tested once: the datagram survives
    // whatever the parser made of it.
    const rawOk = row.raw === raw;

    if (msgOk && hostOk && appOk && procidOk && !leaked && rawOk) {
        pass++;
    } else {
        fail++;
        console.log('FAIL |', label);
        console.log('     msg      got', JSON.stringify(row.msg), 'expected', JSON.stringify(expMsg));
        if (expHost !== undefined) console.log('     host     got', JSON.stringify(row.host), 'expected', JSON.stringify(expHost));
        if (expApp !== undefined) console.log('     app      got', JSON.stringify(row.app), 'expected', JSON.stringify(expApp));
        if (expProcid !== undefined) console.log('     procid   got', JSON.stringify(row.procid), 'expected', JSON.stringify(expProcid));
        if (leaked) console.log('     leaked a "- " prefix');
        if (!rawOk) console.log('     raw was not preserved verbatim');
    }
}

// --- RFC 3164 year inference, BOTH directions across New Year ----------------
//
// Finding 12. The parent corrected only the future case: a Dec 31 stamp read on
// Jan 1 moved back a year. The mirror case had no rule - a device clock a few
// minutes fast, sending "Jan 1 00:03" while the server is at Dec 31 23:59,
// constructed Jan 1 of the CURRENT year, roughly 365 days in the past, and
// stayed a year wrong until midnight.

interface YearCase { label: string; raw: string; now: string; expectYear: number; expectMonth: number }

const YEARS: YearCase[] = [
    {
        label: 'Dec 31 stamp read on Jan 1 goes BACK a year',
        raw: '<13>Dec 31 23:58:00 host app: late',
        now: '2027-01-01T00:02:00Z', expectYear: 2026, expectMonth: 11,
    },
    {
        label: 'Jan 1 stamp from a fast clock read on Dec 31 goes FORWARD a year',
        raw: '<13>Jan  1 00:03:00 host app: early',
        now: '2026-12-31T23:59:00Z', expectYear: 2027, expectMonth: 0,
    },
    {
        label: 'an ordinary mid-year stamp stays in the current year',
        raw: '<13>Jul 15 12:00:00 host app: ordinary',
        now: '2026-07-20T00:00:00Z', expectYear: 2026, expectMonth: 6,
    },
    {
        label: 'a stamp months old is NOT dragged forward',
        raw: '<13>Mar 03 08:00:00 host app: old',
        now: '2026-07-20T00:00:00Z', expectYear: 2026, expectMonth: 2,
    },
];

for (const c of YEARS) {
    const row = parse(c.raw, '203.0.113.9', Date.parse(c.now));
    const ts = row.msgTs;
    if (ts !== null && ts.getUTCFullYear() === c.expectYear && ts.getUTCMonth() === c.expectMonth) {
        pass++;
    } else {
        fail++;
        console.log('FAIL | year inference:', c.label);
        console.log('      got', ts?.toISOString(), 'expected year', c.expectYear, 'month', c.expectMonth);
    }
}

// Zone pinning: identical bytes must derive identical msg_ts wherever the
// server runs. The parent used the local-time Date constructor, which is
// finding 10 one layer up.
{
    const row = parse('<13>Jul 15 12:00:00 host app: x', null, Date.parse('2026-07-20T00:00:00Z'));
    if (row.msgTs?.toISOString() === '2026-07-15T12:00:00.000Z') {
        pass++;
    } else {
        fail++;
        console.log('FAIL | msg_ts is not interpreted as UTC:', row.msgTs?.toISOString());
    }
}

// --- never drop a datagram ---------------------------------------------------
// The invariant that outranks correct parsing. Anything unparseable is stored
// whole with whatever fields did parse.

interface Unparseable {
    label: string;
    raw: string;
    check: (r: ReturnType<typeof parse>) => string | null;
}

const UNPARSEABLE: Unparseable[] = [
    {
        label: 'total garbage, no PRI, no timestamp, no tag',
        raw: 'zzzz not a syslog message at all',
        check: (r) => r.msg === 'zzzz not a syslog message at all' ? null : `msg was ${JSON.stringify(r.msg)}`,
    },
    {
        label: 'PRI out of range is not a PRI',
        raw: '<999>Jul 25 14:30:00 host app: body',
        // 999 > 191, so the PRI is left in place and the line parses as prose.
        check: (r) => r.facility === null && r.severity === null && r.raw === '<999>Jul 25 14:30:00 host app: body'
            ? null : `facility ${r.facility} severity ${r.severity}`,
    },
    {
        label: 'valid PRI, nothing else parseable',
        raw: '<34>!!!! truncated',
        check: (r) => r.facility === 4 && r.severity === 2 && r.msg === '!!!! truncated'
            ? null : `facility ${r.facility} severity ${r.severity} msg ${JSON.stringify(r.msg)}`,
    },
    {
        label: 'malformed 5424 header, too few fields',
        raw: '<13>1 2026-07-18T12:00:00Z fw',
        check: (r) => r.msg === '1 2026-07-18T12:00:00Z fw' ? null : `msg was ${JSON.stringify(r.msg)}`,
    },
    {
        label: 'empty-ish datagram',
        raw: '<13>',
        check: (r) => r.raw === '<13>' && r.msg === '' ? null : `msg ${JSON.stringify(r.msg)} raw ${JSON.stringify(r.raw)}`,
    },
];

for (const u of UNPARSEABLE) {
    const row = parse(u.raw, '198.51.100.7');
    const problem = u.check(row);
    const rawKept = row.raw === u.raw;
    if (problem === null && rawKept) {
        pass++;
    } else {
        fail++;
        console.log('FAIL | never-drop:', u.label);
        if (problem) console.log('     ', problem);
        if (!rawKept) console.log('      raw was not preserved:', JSON.stringify(row.raw));
    }
}

// --- hostile input through the COPY encoder ----------------------------------
// A syslog body is typed by a device, not an operator. ARCHITECTURE.md section
// 4 treats those strings as hostile all the way to HTML, JSON and CSV; the COPY
// stream is one more place they can do damage, and a different one from
// escaping for display. An unescaped tab shifts every later column of the row;
// an unescaped newline ends the row early. Either breaks the never-drop
// invariant using nothing but a legal datagram.

const NUL = String.fromCharCode(0);

const ENCODING: Array<[label: string, input: string, expected: string]> = [
    ['tab does not become a column break',   'a\tb',   'a\\tb'],
    ['newline does not end the row',         'a\nb',   'a\\nb'],
    ['carriage return is escaped',           'a\rb',   'a\\rb'],
    ['backslash is escaped first',           'a\\b',   'a\\\\b'],
    ['a literal \\N is not a null marker',   '\\N',    '\\\\N'],
    ['a crafted row break is inert',         'x\n1\t2', 'x\\n1\\t2'],
];

for (const [label, input, expected] of ENCODING) {
    const got = copyEscape(input);
    if (got === expected) {
        pass++;
    } else {
        fail++;
        console.log('FAIL | copy encoding:', label);
        console.log('      got', JSON.stringify(got), 'expected', JSON.stringify(expected));
    }
}

// A real null must still encode as the COPY null marker, distinct from the
// two-character text "\N" above.
if (copyEscape(null) === '\\N') {
    pass++;
} else {
    fail++;
    console.log('FAIL | copy encoding: null is not the \\N marker');
}

// One row per line, no matter what the device put in it.
{
    const line = copyLine(['host', 'app\twith\ttabs', 'msg\nwith\nnewlines']);
    const newlines = (line.match(/\n/g) ?? []).length;
    if (newlines === 1 && line.endsWith('\n') && line.split('\t').length === 3) {
        pass++;
    } else {
        fail++;
        console.log('FAIL | copy encoding: a hostile row did not stay one row');
        console.log('      got', JSON.stringify(line));
    }
}

// NUL cannot be stored in a Postgres text column at all, escaped or not, and
// would abort the whole batch - taking every other message in the flush with
// it. Stripping is the only option that keeps the never-drop invariant, and it
// is counted rather than silently absorbed.
{
    const { text, stripped } = stripNul(`before${NUL}after${NUL}`);
    if (text === 'beforeafter' && stripped === 2) {
        pass++;
    } else {
        fail++;
        console.log('FAIL | stripNul:', JSON.stringify(text), 'stripped', stripped);
    }
}
{
    const { text, stripped } = stripNul('clean');
    if (text === 'clean' && stripped === 0) {
        pass++;
    } else {
        fail++;
        console.log('FAIL | stripNul altered a clean string');
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
