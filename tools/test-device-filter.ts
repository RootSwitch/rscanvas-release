// The device list's filter box (public/parse.js), offline. The exact group
// form is what the Dashboard's health tables open the list with; the case
// that made it necessary is the first one below.
//
//   node tools/test-device-filter.ts

const { parseDeviceFilter, deviceMatches } = await import('../public/parse.js' as string) as {
    parseDeviceFilter: (text: string) => unknown;
    deviceMatches: (d: Record<string, unknown>, f: unknown) => boolean;
};

// House rule since test-walk: fail unless the run reaches its verdict.
process.exitCode = 1;
let pass = 0;
let fail = 0;
const eq = (label: string, got: unknown, want: unknown): void => {
    if (JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  ok   ${label}`); } else {
        fail++; console.log(`  FAIL ${label}\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`);
    }
};

const devices = [
    { name: 'lab-node-16100', host: '198.18.50.1', location: 'HQ / Floor 2', application: 'PAM Prod', transient: true },
    { name: 'lab-node-16101', host: '198.18.50.1', location: 'Lab', application: 'PAM Dev', alerts_muted: true },
    { name: 'core-sw1', host: '192.0.2.1', location: '  lab ', application: null, transient: false, alerts_muted: false },
    { name: 'nas', host: '192.0.2.9', location: null, application: 'Storage', transient: true, alerts_muted: true },
    { name: 'printer', host: '192.0.2.20', location: '', application: '' },
];
const names = (text: string): string[] => {
    const f = parseDeviceFilter(text);
    return devices.filter((d) => deviceMatches(d, f)).map((d) => d.name);
};

console.log('a group opened from the Dashboard is an exact match:');
eq('location:Lab is the Lab group, not every device named lab-node-...',
    names('location:Lab'), ['lab-node-16101', 'core-sw1']);
eq('the plain word Lab still matches by substring, names included',
    names('Lab'), ['lab-node-16100', 'lab-node-16101', 'core-sw1']);
eq('case and surrounding spaces are ignored, on both sides', names('  LOCATION: lab  '), ['lab-node-16101', 'core-sw1']);
eq('application:PAM Prod is that application alone', names('application:PAM Prod'), ['lab-node-16100']);
eq('while the plain word PAM still finds both', names('PAM'), ['lab-node-16100', 'lab-node-16101']);
eq('location: with nothing after it is the devices with no location', names('location:'), ['nas', 'printer']);
eq('application: likewise, blank and unset alike', names('application:'), ['core-sw1', 'printer']);

console.log('\nwhat stays plain text:');
eq('an empty box matches everything', names('').length, devices.length);
eq('an address matches by substring', names('192.0.2.2'), ['printer']);
eq('an unknown prefix is just text', parseDeviceFilter('site:HQ'), { kind: 'text', q: 'site:hq', flags: {} });
eq('a prefix not at the start is just text', names('x location:Lab'), []);

console.log('\ntransient: and muted: list the declared devices, and narrow the rest:');
eq('transient: alone is every transient device', names('transient:'), ['lab-node-16100', 'nas']);
eq('muted: alone is every muted device', names('muted:'), ['lab-node-16101', 'nas']);
eq(':yes says the same', names('transient:yes'), names('transient:'));
eq('transient:no is the rest, unset counted as no', names('transient:no'), ['lab-node-16101', 'core-sw1', 'printer']);
eq('both at once is both', names('muted: transient:'), ['nas']);
eq('with a word, the word narrows them', names('muted: PAM'), ['lab-node-16101']);
eq('and in either order', names('PAM muted:'), ['lab-node-16101']);
eq('before a group, the group still reads whole', names('transient: location:HQ / Floor 2'), ['lab-node-16100']);
eq('after a group too', names('location:HQ / Floor 2 transient:'), ['lab-node-16100']);
eq('case is ignored', names('MUTED:NO'), ['lab-node-16100', 'core-sw1', 'printer']);
eq('an unknown value is just text, so it matches nothing', names('transient:maybe'), []);
eq('glued to another word it is just text', parseDeviceFilter('xmuted:'), { kind: 'text', q: 'xmuted:', flags: {} });

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail === 0) process.exitCode = 0;
