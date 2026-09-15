// CIDR expansion for the subnet scan.
//
//   node tools/test-cidr.ts

import { expandCidr, SCAN_MAX_PREFIX } from '../src/devices/cidr.ts';

let pass = 0, fail = 0;
const eq = (l: string, got: unknown, want: unknown): void => {
    JSON.stringify(got) === JSON.stringify(want) ? (pass++, console.log(`  ok   ${l}`))
        : (fail++, console.log(`  FAIL ${l} - wanted ${JSON.stringify(want)}, got ${JSON.stringify(got)}`));
};
const hosts = (s: string): string[] | string => { const r = expandCidr(s); return r.ok ? r.hosts : r.detail; };

console.log('shape:');
eq('a /24 is 254 hosts', (hosts('192.0.2.0/24') as string[]).length, 254);
eq('first host is .1, not .0', (hosts('192.0.2.0/24') as string[])[0], '192.0.2.1');
eq('last host is .254, not .255', (hosts('192.0.2.0/24') as string[])[253], '192.0.2.254');
eq('a host address inside the block is normalised to the block', (hosts('192.0.2.77/24') as string[])[0], '192.0.2.1');
eq('a /30 is 2 hosts', hosts('10.0.0.0/30'), ['10.0.0.1', '10.0.0.2']);
eq('a /31 is both addresses - point to point has no broadcast', hosts('10.0.0.0/31'), ['10.0.0.0', '10.0.0.1']);
eq('a /32 is the one address', hosts('10.0.0.5/32'), ['10.0.0.5']);
eq('a bare address is a /32', hosts('10.0.0.5'), ['10.0.0.5']);
eq('the /22 ceiling is 1022 hosts', (hosts('10.0.0.0/22') as string[]).length, 1022);
eq('and spans the four /24s', (hosts('10.0.0.0/22') as string[])[1021], '10.0.3.254');

console.log('\nrefusals:');
eq('/21 is over the cap and says so', String(hosts('10.0.0.0/21')).includes(`capped at /${SCAN_MAX_PREFIX}`), true);
eq('/8 is refused, not attempted', String(hosts('10.0.0.0/8')).includes('16777216 addresses'), true);
eq('an octet over 255 is refused', String(hosts('10.0.0.300/24')).includes('over 255'), true);
eq('garbage is refused', String(hosts('switch-core')).includes('not an IPv4'), true);
eq('/33 is refused', String(hosts('10.0.0.0/33')).includes('not a valid prefix'), true);
eq('whitespace around the input is tolerated', (hosts('  192.0.2.0/24  ') as string[]).length, 254);

console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} - ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
