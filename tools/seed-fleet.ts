// Register the lab's mock SNMP fleet as devices, so the collector has
// something to poll.
//
//   FLEET_SIZE=100 BASE_PORT=16100 node tools/seed-fleet.ts
//
// The fleet (~/lab/mock-fleet.js on lab-stresstest) serves FLEET_SIZE synthetic
// agents from ONE process on consecutive UDP ports, which is what makes a
// few hundred targets cost one node process instead of a few hundred VMs.
//
// Devices are named mock-NNNN and allocate ids from devices_id_seq, which
// starts at 10000 - so everything this creates is distinguishable from the
// spike's seeded 1..600 by id alone, and a measurement can be scoped to one or
// the other without a flag column.

import { OPS, closeAll } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';

const FLEET_SIZE = Number(process.env.FLEET_SIZE || 100);
const BASE_PORT = Number(process.env.BASE_PORT || 16100);
const HOST = process.env.FLEET_HOST || '127.0.0.1';
/**
 * Device name prefix. Exists so a SECOND fleet can be registered alongside
 * the first without colliding on names - the soak's fault window runs a
 * separate "volatile" fleet process that gets killed and restored on a
 * schedule, and it needs its own device names to do that.
 */
const PREFIX = process.env.FLEET_PREFIX || 'mock';
const INTERVAL_S = Number(process.env.POLL_INTERVAL_S || 30);

async function main(): Promise<void> {
    if (INTERVAL_S < CONFIG.pollIntervalFloorS) {
        // The floor is enforced in three places and this is one of them. Fail
        // rather than silently raising it, so a caller who asked for 10s finds
        // out they cannot have it.
        console.error(`POLL_INTERVAL_S=${INTERVAL_S} is below the ${CONFIG.pollIntervalFloorS}s floor`);
        process.exit(2);
    }

    console.log(`registering ${FLEET_SIZE} ${PREFIX} devices at ${HOST}:${BASE_PORT}..${BASE_PORT + FLEET_SIZE - 1}`);
    console.log(`  poll interval ${INTERVAL_S}s`);

    let created = 0;
    let existing = 0;

    for (let i = 0; i < FLEET_SIZE; i++) {
        const name = `${PREFIX}-${String(i).padStart(4, '0')}`;
        const found = await OPS.findDeviceByName(name);
        if (found.ok && found.rows.length > 0) { existing++; continue; }

        const res = await OPS.upsertDevice(name, HOST, BASE_PORT + i, '2c', 'SNMP_COMMUNITY', INTERVAL_S);
        if (!res.ok) {
            console.error(`  failed to create ${name}: ${res.reason}`);
            continue;
        }
        created++;
    }

    console.log(`  ${created} created, ${existing} already present`);
    await closeAll();
}

main().catch((err) => {
    console.error('seed-fleet failed:', err);
    void closeAll();
    process.exit(1);
});
