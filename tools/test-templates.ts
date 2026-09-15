// The notification formatter, ported with its test.
//
//   node tools/test-templates.ts
//
// Ported from alertcanvas/tools/test-templates.js alongside
// src/alerts/templates.ts. The parent's cases come across unchanged - they
// encode the bug that produced the module, which is that value-less alarms used
// to read "value -- (threshold --)" instead of plain English.
//
// AND A DIFFERENTIAL TEST, which the parent had no need for and this port does.
// "Ported, not rewritten" is a claim, and the syslog parser proved the claim is
// worth checking: the same wording was used about `filter.js`, whose port
// silently dropped the parent's LIKE escaping because the ported file read fine
// on its own merits. So the last section here runs the PARENT'S OWN JavaScript
// against this TypeScript over the same inputs and requires identical output.
//
// That is the parent-diff rule expressed as a test rather than as a review
// note: a behavioural difference cannot survive it unless someone deletes the
// comparison.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import { render, varsFor, fmtDuration, VARS, type Alert, type AlertEvent } from '../src/alerts/templates.ts';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};
const eq = (actual: string, expected: string, label: string): void => {
    if (actual === expected) ok(label);
    else bad(label, `\n         got:      ${actual}\n         expected: ${expected}`);
};

const BODY_RAISE = '{{label}} is {{severity}}: {{detail}}.';
const BODY_CLEAR = '{{label}} returned to normal after {{duration}}.{{reading}}';
const raiseBody = (a: Alert): string => render(BODY_RAISE, varsFor(a, 'raise'));

console.log('notification formatter\n');

// --- the parent's cases, unchanged -------------------------------------------

eq(raiseBody({ kind: 'temp', label: 'sw1 Temp', severity: 'crit', value: 58, threshold: 55, unit: 'C' }),
    'sw1 Temp is crit: value 58C (threshold 55C).',
    'a metric breach keeps "value X (threshold Y)"');

{
    const body = raiseBody({
        kind: 'device-down', label: 'U7-Pro-XG (a.b.c.d) device',
        severity: 'crit', value: null, threshold: null, unit: '',
    });
    eq(body, 'U7-Pro-XG (a.b.c.d) device is crit: not reporting in the status feed (unreachable or powered off).',
        'a down device reads as a plain statement');
    if (!body.includes('--')) ok('and carries no "--" placeholders - the bug this module exists for');
    else bad('the -- placeholder came back', body);
}

eq(raiseBody({ kind: 'if-down', label: 'sw1 Gi0/1 link', severity: 'crit', value: null, threshold: null, unit: '' }),
    'sw1 Gi0/1 link is crit: link is down.',
    'a downed link reads "link is down"');

eq(raiseBody({ kind: 'state', label: 'ups1 Power On battery', severity: 'crit', value: 1, threshold: 1 }),
    'ups1 Power On battery is crit: reporting an alarm condition.',
    'a binary state alarm does not say "value 1 (threshold 1)"');

// --- unknown variables must stay visible -------------------------------------
//
// The parent's rule, and worth an explicit case: a typo in a user-edited
// template has to appear in the mail rather than silently becoming blank.
eq(render('{{label}} / {{hsot}}', varsFor({ kind: 'temp', label: 'x', severity: 'warn' }, 'raise')),
    'x / {{hsot}}',
    'an unknown variable renders as itself, so a template typo is visible');

// --- fmtDuration boundaries ---------------------------------------------------
eq(fmtDuration(null), '-', 'a null duration is "-"');
eq(fmtDuration(-5), '-', 'a negative duration is "-"');
eq(fmtDuration(45), '45s', 'seconds');
eq(fmtDuration(605), '10m 5s', 'minutes and seconds');
eq(fmtDuration(7325), '2h 2m', 'hours and minutes');
eq(fmtDuration(180_000), '2d 2h', 'days and hours');

// --- reading suppression ------------------------------------------------------
{
    const clear = (a: Alert): string => render(BODY_CLEAR, varsFor(a, 'clear'));
    const withValue = clear({
        kind: 'temp', label: 'sw1 Temp', severity: 'crit', value: 41, unit: 'C',
        raised_ts: 1000, cleared_ts: 1060,
    });
    if (withValue.endsWith(' (now 41C)')) ok('a clear with a numeric value reports the recovered reading');
    else bad('the recovered reading is missing', withValue);

    const noValue = clear({
        kind: 'device-down', label: 'sw1 device', severity: 'crit', value: null,
        raised_ts: 1000, cleared_ts: 1060,
    });
    if (noValue.endsWith('.')) ok('and a value-less clear ends cleanly, with no "(now --)"');
    else bad('a value-less clear emitted a reading', noValue);
}

// --- the variable list is the editor's contract -------------------------------
{
    const produced = Object.keys(varsFor({ kind: 'temp', label: 'x', severity: 'warn' }, 'raise'));
    const missing = VARS.filter((v) => !produced.includes(v));
    if (missing.length === 0) ok(`every one of the ${VARS.length} advertised variables is actually produced`);
    else bad('VARS advertises variables varsFor does not produce', missing.join(', '));
}

// --- THE DIFFERENTIAL: the parent's own JavaScript, same inputs ---------------
//
// The control that makes "ported, not rewritten" checkable rather than
// asserted. Skips with a NAMED reason if the parent tree is not present, rather
// than passing quietly - an absent comparison must not look like a matching one.
console.log('');
{
    const PARENT = 'C:/Workspace/alertcanvas/server/templates.js';
    if (!fs.existsSync(PARENT)) {
        console.log(`  skip differential: ${PARENT} not present on this machine`);
    } else {
        const req = createRequire(import.meta.url);
        const parent = req(PARENT) as {
            render: (t: string, v: Record<string, string>) => string;
            varsFor: (a: unknown, e: string) => Record<string, string>;
            fmtDuration: (s: number) => string;
        };

        const cases: Array<{ alert: Alert; event: AlertEvent }> = [
            { alert: { kind: 'temp', label: 'sw1 Temp', severity: 'crit', value: 58, threshold: 55, unit: 'C' }, event: 'raise' },
            { alert: { kind: 'device-down', label: 'r1 device', severity: 'crit', value: null, threshold: null }, event: 'raise' },
            { alert: { kind: 'if-down', label: 'sw1 Gi0/1 link', severity: 'warn' }, event: 'raise' },
            { alert: { kind: 'ping-down', label: 'h1 ping', severity: 'warn', value: 312 }, event: 'raise' },
            { alert: { kind: 'ping-down', label: 'h1 ping', severity: 'crit', value: null }, event: 'escalate' },
            { alert: { kind: 'reboot', label: 'sw2 uptime', severity: 'warn' }, event: 'raise' },
            { alert: { kind: 'watchdog', label: 'feed', severity: 'crit' }, event: 'raise' },
            { alert: { kind: 'state', label: 'ups1 Power On battery', severity: 'crit', value: 1, threshold: 1 }, event: 'raise' },
            { alert: { kind: 'cpu', host: 'sw1', label: 'sw1 CPU', severity: 'warn', value: 91, threshold: 90, unit: '%', raised_ts: 100, cleared_ts: 8000 }, event: 'clear' },
            { alert: { kind: 'mystery', label: 'odd', severity: 'warn', value: 7 }, event: 'renotify' },
            { alert: { kind: 'mystery', label: 'odd', severity: 'warn' }, event: 'test' },
        ];
        const TEMPLATE = '{{label}}|{{host}}|{{metric}}|{{kind}}|{{code}}|{{value}}|{{unit}}'
            + '|{{threshold}}|{{severity}}|{{event}}|{{duration}}|{{detail}}|{{reading}}';

        let mismatches = 0;
        for (const c of cases) {
            // `time` is excluded: both sides call Date.now() independently and a
            // second boundary between them would be a false difference. Every
            // other variable is compared.
            const mine = render(TEMPLATE, varsFor(c.alert, c.event));
            const theirs = parent.render(TEMPLATE, parent.varsFor(c.alert, c.event));
            if (mine !== theirs) {
                mismatches++;
                bad(`differential mismatch on ${c.alert.kind}/${c.event}`,
                    `\n         fork:   ${mine}\n         parent: ${theirs}`);
            }
        }
        if (mismatches === 0) ok(`${cases.length} alert shapes render IDENTICALLY to the parent's JavaScript`);

        let durMismatch = 0;
        for (const s of [0, 1, 59, 60, 61, 3599, 3600, 3601, 86399, 86400, 90061, 1_000_000]) {
            if (fmtDuration(s) !== parent.fmtDuration(s)) {
                durMismatch++;
                bad(`fmtDuration(${s}) differs`, `${fmtDuration(s)} vs ${parent.fmtDuration(s)}`);
            }
        }
        if (durMismatch === 0) ok('fmtDuration matches the parent across every unit boundary');
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
