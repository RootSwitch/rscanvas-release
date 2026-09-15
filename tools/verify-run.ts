// Verify a load-generator run against what is actually in the database.
//
// This is the done-when check for "zero dropped datagrams", and it deliberately
// trusts NO counter. A datagram can be lost in three places, each with its own
// counter that is blind to the other two:
//
//   the sender's socket        - reported by udp-load.ts as send errors
//   the receiver's kernel      - /proc/net/udp drops, per socket
//   our own queue              - shed under backpressure
//
// All three can read zero while datagrams are missing, which is exactly the
// shape of the five flattering failures this project has already had: a
// too-narrow measurement looks identical to a healthy subject. Counting the
// rows that actually landed, and naming the sequence numbers that did not, is
// the only check that spans all three.
//
//   RUN_TAG=rscrun-abc EXPECT_SENT=61234 node tools/verify-run.ts

import { OPS, closeAll } from '../src/store/index.ts';

const RUN_TAG = process.env.RUN_TAG;
const EXPECT_SENT = process.env.EXPECT_SENT ? Number(process.env.EXPECT_SENT) : null;
const MAX_SEQ = process.env.MAX_SEQ ? Number(process.env.MAX_SEQ) : null;
// The window to search. Generous by default, and bounded because the store
// requires a window: free-text with no device filter is only permitted inside
// the trigram window, which is what this is.
const WINDOW_HOURS = Number(process.env.WINDOW_HOURS || 2);

async function main(): Promise<void> {
    if (!RUN_TAG) {
        console.error('RUN_TAG is required - it is printed at the end of a udp-load.ts run');
        process.exit(2);
    }

    const to = new Date(Date.now() + 60_000); // a minute of slack for clock skew
    const from = new Date(Date.now() - WINDOW_HOURS * 3_600_000);

    console.log(`verifying run ${RUN_TAG}`);
    console.log(`  window ${from.toISOString()} .. ${to.toISOString()}`);
    if (EXPECT_SENT !== null) console.log(`  sender reported ${EXPECT_SENT.toLocaleString()} datagrams sent ok`);
    console.log('');

    const counted = await OPS.countRunTag(RUN_TAG, from, to);
    if (!counted.ok) {
        console.error(`count failed: lane refused (${counted.reason})`);
        process.exit(1);
    }
    const row = counted.rows[0];
    if (!row) {
        console.error('count returned no rows');
        process.exit(1);
    }

    const landed = Number(row.n);
    const distinctSeq = Number(row.distinct_seq);
    console.log(`  rows in database    ${landed.toLocaleString()}`);
    console.log(`  distinct seq        ${distinctSeq.toLocaleString()}`);
    console.log(`  seq range           ${row.min_seq ?? '-'} .. ${row.max_seq ?? '-'}`);
    console.log(`  count query         waitMs ${counted.timing.waitMs} execMs ${counted.timing.execMs}`);

    const byProto = await OPS.runTagByProto(RUN_TAG, from, to);
    if (byProto.ok) {
        console.log('  by proto:');
        for (const p of byProto.rows) console.log(`    ${(p.proto ?? 'null').padEnd(8)} ${Number(p.n).toLocaleString()}`);
    }

    const failures: string[] = [];

    if (EXPECT_SENT !== null && landed !== EXPECT_SENT) {
        const missing = EXPECT_SENT - landed;
        failures.push(
            missing > 0
                ? `${missing.toLocaleString()} datagrams sent but not stored (${((missing / EXPECT_SENT) * 100).toFixed(3)}%)`
                : `${(-missing).toLocaleString()} MORE rows than were sent - the tag is colliding with an earlier run`,
        );
    }
    if (landed !== distinctSeq) {
        failures.push(`${(landed - distinctSeq).toLocaleString()} duplicate sequence numbers stored`);
    }

    // Name the gaps. A dropped datagram is far easier to reason about when you
    // can see whether the losses are one contiguous burst or scattered.
    const maxSeq = MAX_SEQ ?? (row.max_seq === null ? null : Number(row.max_seq));
    if (maxSeq !== null && (EXPECT_SENT === null || landed !== EXPECT_SENT)) {
        const gaps = await OPS.missingSequences(RUN_TAG, from, to, maxSeq, 50);
        if (gaps.ok && gaps.rows.length > 0) {
            const list = gaps.rows.map((g) => g.seq);
            console.log('');
            console.log(`  missing sequences (first ${list.length}): ${list.join(', ')}`);
            const nums = list.map(Number);
            let contiguous = true;
            for (let i = 1; i < nums.length; i++) {
                if ((nums[i] as number) !== (nums[i - 1] as number) + 1) { contiguous = false; break; }
            }
            console.log(contiguous
                ? '  the listed gaps are CONTIGUOUS, which reads like one overflow rather than steady loss'
                : '  the listed gaps are SCATTERED, which reads like sustained pressure rather than one burst');
        }
    }

    // The unparseable datagrams are a done-when criterion of their own: stored
    // whole with whatever fields did parse.
    const garbage = await OPS.runTagUnparseable(RUN_TAG, from, to, 3);
    console.log('');
    if (garbage.ok && garbage.rows.length > 0) {
        console.log(`  unparseable datagrams stored: ${garbage.rows.length} sampled`);
        for (const g of garbage.rows) {
            console.log(`    raw      ${JSON.stringify(g.raw.slice(0, 90))}`);
            console.log(`    parsed   host=${JSON.stringify(g.host)} app=${JSON.stringify(g.app)} facility=${g.facility} severity=${g.severity}`);
            if (g.raw.length === 0) failures.push('an unparseable datagram was stored with an empty raw');
        }
    } else {
        failures.push('no unparseable datagrams found - the never-drop invariant is untested by this run');
    }

    await closeAll();

    console.log('');
    if (failures.length > 0) {
        for (const f of failures) console.error(`FAIL - ${f}`);
        process.exit(1);
    }
    console.log(`PASS - ${landed.toLocaleString()} datagrams sent, ${landed.toLocaleString()} stored, none missing, unparseable ones kept whole`);
}

main().catch((err) => {
    console.error('verify failed:', err);
    void closeAll();
    process.exit(1);
});
