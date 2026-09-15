// The decision/mistake discrimination on notification channels.
//
// THE FAILURE THIS EXISTS FOR is silent and specific: set ALERT_SMTP_HOST and
// ALERT_SMTP_FROM, fat-finger ALERT_SMTP_TO, and email does not exist. The
// channel is off by the "half-configured is off rather than broken" rule,
// alerts settle as delivered by the no-phantom-backlog rule, and nothing
// anywhere says notifications went nowhere. Two individually correct rules
// meeting to produce fail-open-on-absent-data, in the notification path.
//
// So the rule is the one this project applies to every other absence:
//
//   ZERO of a channel's variables set   a DECISION - silent
//   SOME BUT NOT ALL set                a MISTAKE - loud, and unhealthy
//
// CONFIG is read at import, so each case runs in its OWN CHILD PROCESS with
// its own environment. Importing once and mutating process.env would test a
// config that had already been frozen - the test would pass while proving
// nothing, which is the shape this file is about.

import { spawnSync } from 'node:child_process';

let pass = 0;
let fail = 0;
const ok = (l: string): void => { pass++; console.log(`  ok   ${l}`); };
const bad = (l: string, d?: unknown): void => {
    fail++; console.log(`  FAIL ${l}`, d === undefined ? '' : String(d));
};

interface Result { enabled: string[]; incomplete: Record<string, string[]>; healthy: boolean; problem?: string }

const PROBE = `
import { channelConfig, isNotifyConfigSane } from './src/alerts/notify.ts';
const cfg = channelConfig();
console.log(JSON.stringify({ ...cfg, ...isNotifyConfigSane(cfg) }));
`;

function evaluate(env: Record<string, string>): Result {
    const clean: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const k of Object.keys(clean)) {
        if (k.startsWith('ALERT_')) delete clean[k];
    }
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE], {
        env: { ...clean, ...env }, encoding: 'utf8', cwd: process.cwd(),
    });
    const line = r.stdout.trim().split('\n').pop() ?? '';
    try {
        return JSON.parse(line) as Result;
    } catch {
        throw new Error(`probe produced no verdict:\n${r.stdout}\n${r.stderr}`);
    }
}

console.log('notification channels: a decision is silent, a mistake is loud\n');

// --- nothing configured: legitimate, and REPORTED ------------------------------
{
    const r = evaluate({});
    if (r.enabled.length === 0 && Object.keys(r.incomplete).length === 0 && r.healthy) {
        ok('no channels at all is HEALTHY - somebody may just watch the page');
    } else {
        bad('an unconfigured deployment was treated as broken', JSON.stringify(r));
    }
}

// --- fully configured ---------------------------------------------------------
{
    const r = evaluate({
        ALERT_SYSLOG_HOST: '127.0.0.1',
        ALERT_NTFY_SERVER: 'http://n', ALERT_NTFY_TOPIC: 't',
        ALERT_SMTP_HOST: 'mail', ALERT_SMTP_FROM: 'a@b', ALERT_SMTP_TO: 'c@d',
    });
    if (r.enabled.join() === 'syslog,ntfy,email' && r.healthy) {
        ok('all three fully configured are enabled and healthy');
    } else {
        bad('a complete configuration was misread', JSON.stringify(r));
    }
}

// --- THE CASE THIS FILE EXISTS FOR --------------------------------------------
{
    const r = evaluate({ ALERT_SMTP_HOST: 'mail', ALERT_SMTP_FROM: 'a@b' });
    if (!r.enabled.includes('email') && r.incomplete.email?.join() === 'ALERT_SMTP_TO') {
        ok('SMTP with no recipient is HALF-CONFIGURED, and the missing name is reported');
    } else {
        bad('the fat-fingered recipient was invisible', JSON.stringify(r));
    }
    if (!r.healthy && String(r.problem).includes('silently disabled')) {
        ok('and it is UNHEALTHY - a typo between an alert and the person who needs it');
    } else {
        bad('a half-configured channel passed health', JSON.stringify(r));
    }
}

// --- the negative control: the SAME channel, absent entirely -------------------
//
// Without this the check could pass by calling every unconfigured channel a
// mistake, which would make a bare deployment permanently unhealthy and train
// everyone to ignore the verdict.
{
    const r = evaluate({ ALERT_SYSLOG_HOST: '127.0.0.1' });
    if (r.enabled.join() === 'syslog' && r.incomplete.email === undefined && r.healthy) {
        ok('SMTP entirely absent is a DECISION - silent, healthy, not flagged');
    } else {
        bad('an absent channel was reported as a mistake', JSON.stringify(r));
    }
}

// --- the same discrimination on ntfy ------------------------------------------
{
    const half = evaluate({ ALERT_NTFY_SERVER: 'http://n' });
    if (half.incomplete.ntfy?.join() === 'ALERT_NTFY_TOPIC' && !half.healthy) {
        ok('ntfy with a server and no topic is caught the same way');
    } else {
        bad('the ntfy half-configuration was missed', JSON.stringify(half));
    }
    const none = evaluate({ ALERT_NTFY_TOPIC: '' });
    if (none.healthy && Object.keys(none.incomplete).length === 0) {
        ok('and an empty value counts as unset, not as half-configured');
    } else {
        bad('an empty string was read as a configured value', JSON.stringify(none));
    }
}

// --- more than one at once ----------------------------------------------------
{
    const r = evaluate({ ALERT_NTFY_SERVER: 'http://n', ALERT_SMTP_HOST: 'mail' });
    if (!r.healthy && String(r.problem).includes('ntfy') && String(r.problem).includes('email')) {
        ok('two half-configured channels are both named in one problem string');
    } else {
        bad('only one of two mistakes was reported', JSON.stringify(r));
    }
}

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
