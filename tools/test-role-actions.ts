// The role table the web client now gates its controls on, offline.
//
//   node tools/test-role-actions.ts
//
// Since 2026-09-25 /api/me carries `can` (actionsFor(role)) and the page shows
// a control only to a role holding the action its route enforces. So the
// table in src/auth/authorize.ts decides what every role SEES as well as what
// it may do, and a change to it now moves buttons. This pins:
//
//   1. actionsFor agrees with authorize() for every action in the union - the
//      page and the server cannot disagree about a role;
//   2. the per-role facts the page relies on, written out as a matrix a
//      reviewer can read (a viewer holds no write action at all; mute and
//      maintenance are operator work; rename, move, create, delete and rule
//      writing are admin);
//   3. every action in the union is held by SOME role - one added to the
//      union but granted to nobody is unreachable, and its control would
//      never appear for anyone.

import fs from 'node:fs';
import { actionsFor, authorize, ROLES, type Action, type Role } from '../src/auth/authorize.ts';

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0, fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
    if (cond) { pass++; console.log(`  ok   ${label}`); } else { fail++; console.log(`  FAIL ${label}${detail ? ` - ${detail}` : ''}`); }
};

// The union's members, read from the source - the same parse
// check-can-attrs.mjs uses (comments stripped first: they carry semicolons).
const src = fs.readFileSync(new URL('../src/auth/authorize.ts', import.meta.url), 'utf8');
const rest = src.slice(src.indexOf('export type Action =')).replace(/\/\/[^\n]*/g, '');
const UNION = [...rest.slice(0, rest.indexOf(';')).matchAll(/'([a-z][a-zA-Z]*\.[a-zA-Z]+)'/g)].map((m) => m[1] as Action);
ok(`read the Action union (${UNION.length} actions)`, UNION.length >= 30);

const principal = (role: Role) => ({ kind: 'user' as const, id: 1, username: 'u', role });
// Resource-scoped actions are judged on a resource the role could hold them
// for: setPasswordOwn on the caller's own account.
const resourceFor = (a: Action) => (a === 'user.setPasswordOwn' ? { type: 'user' as const, id: 'u' } : undefined);

for (const role of ROLES) {
    const listed = new Set(actionsFor(role));
    const disagree = UNION.filter((a) => listed.has(a) !== authorize(principal(role), a, resourceFor(a)).allowed);
    ok(`${role}: the page's action list is exactly what authorize() allows`, disagree.length === 0, disagree.join(' '));
}

const WRITES: Action[] = [
    'device.create', 'device.delete', 'device.rename', 'device.address', 'device.disable', 'device.track',
    'device.speed', 'device.group', 'device.mute', 'alert.suppress', 'alertrule.write', 'credential.write',
    'syslog.export', 'board.write', 'token.mint', 'token.revoke', 'user.create', 'user.delete', 'user.setRole',
];
const MATRIX: Array<[Action, Role[]]> = [
    ['device.mute', ['operator', 'admin']],
    ['device.track', ['operator', 'admin']],
    ['device.group', ['operator', 'admin']],
    ['device.disable', ['operator', 'admin']],
    ['device.speed', ['operator', 'admin']],
    ['alert.suppress', ['operator', 'admin']],
    ['syslog.export', ['operator', 'admin']],
    ['device.rename', ['admin']],
    ['device.address', ['admin']],
    ['device.create', ['admin']],
    ['device.delete', ['admin']],
    ['alertrule.write', ['admin']],
    ['credential.read', ['admin']],
];
const viewer = new Set(actionsFor('viewer'));
ok('a viewer holds no write action at all', WRITES.every((a) => !viewer.has(a)),
    WRITES.filter((a) => viewer.has(a)).join(' '));
for (const [action, roles] of MATRIX) {
    const holders = ROLES.filter((r) => actionsFor(r).includes(action));
    ok(`${action}: ${roles.join(', ')}`, holders.join() === roles.join(), `held by ${holders.join(', ') || 'nobody'}`);
}
const orphans = UNION.filter((a) => !ROLES.some((r) => actionsFor(r).includes(a)));
ok('every action in the union is held by some role - none is unreachable', orphans.length === 0, orphans.join(' '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
