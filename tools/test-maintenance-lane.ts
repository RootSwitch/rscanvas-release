// The maintenance lane's credential substitution (slice 19).
//
//   node tools/test-maintenance-lane.ts
//
// Index DDL runs as the owning role through a URL derived from DATABASE_URL.
// A substitution that silently half-applied would reproduce the exact failure
// the lane exists to remove ("must be owner"), so the derivation is pinned
// here: substituted when a password is set, untouched when it is not, encoded
// when the password carries URL-significant characters, and loud when the base
// cannot be parsed.

import { maintenanceConnectionString } from '../src/store/pool.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? (pass++, console.log(`  ok   ${l}`))
        : (fail++, console.log(`  FAIL ${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
};
const throws = (l: string, fn: () => unknown): void => {
    try { fn(); eq(l, 'no throw', 'throw'); } catch { eq(l, 'throw', 'throw'); }
};

const base = 'postgres://rscanvas:apppw@db.example:5432/rscanvas_demo';

console.log('substitution:');
eq('role and password replace the app credential, nothing else moves',
    maintenanceConnectionString(base, 'rscanvas_admin', 'adminpw'),
    'postgres://rscanvas_admin:adminpw@db.example:5432/rscanvas_demo');
eq('an empty password leaves the base untouched (unhardened fallback)',
    maintenanceConnectionString(base, 'rscanvas_admin', ''), base);
const tricky = maintenanceConnectionString(base, 'rscanvas_admin', 'p@ss:w/rd?x#y');
eq('URL-significant characters in the password are encoded',
    new URL(tricky).password, 'p%40ss%3Aw%2Frd%3Fx%23y');
eq('and decode back to the password that was given',
    decodeURIComponent(new URL(tricky).password), 'p@ss:w/rd?x#y');
eq('the database and host survive the substitution',
    (() => { const u = new URL(tricky); return `${u.host}${u.pathname}`; })(), 'db.example:5432/rscanvas_demo');
eq('a socket-style base (no host) with no password stays as given',
    maintenanceConnectionString('postgresql:///rscanvas_demo?host=/var/run/postgresql', 'rscanvas_admin', ''),
    'postgresql:///rscanvas_demo?host=/var/run/postgresql');

console.log('\nrefusals:');
throws('a base that is not a URL throws rather than half-substituting',
    () => maintenanceConnectionString('not a url', 'rscanvas_admin', 'x'));
throws('a hostless base with a password throws - there is nothing to substitute into',
    () => maintenanceConnectionString('postgresql:///rscanvas_demo', 'rscanvas_admin', 'x'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
