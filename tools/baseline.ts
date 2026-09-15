// Record and re-check the fixture baseline.
//
// Slice 1 measures against the spike corpus in rscanvas_spike, because the
// done-when envelope was measured there and a different corpus makes the
// criteria unfalsifiable. The corpus costs 90 minutes to rebuild, so drift in
// it should be VISIBLE rather than discovered later, when a search figure
// comes back flattering and nobody can say whether the fixture moved.
//
//   node tools/baseline.ts record     # write tools/baseline.json
//   node tools/baseline.ts check      # compare against it, exit 1 on drift
//
// A note on what this can and cannot see. reltuples is the PLANNER'S ESTIMATE,
// refreshed by autovacuum rather than maintained per row, so it lags live
// ingest and is not a row count. That is deliberate: an exact count(*) across
// 55 million rows on a disk-bound 124GB corpus is minutes of heavy scanning
// every time, which is a worse cure than the disease. What this is built to
// catch is a partition disappearing, a partition being emptied, or the corpus
// changing size by a lot. It will not notice a handful of rows, and it should
// not be read as if it would.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OPS, closeAll } from '../src/store/index.ts';
import { CONFIG } from '../src/config.ts';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'tools', 'baseline.json');

interface PartitionRow {
    /** The partitioned parent: messages, samples, and whatever comes later. */
    parent: string;
    partition: string;
    estRows: number;
    bytes: number;
    pretty: string;
    hasTrgm: boolean;
    /**
     * The host trigram index, tracked since 2026-07-27 when free text became
     * `msg OR host`. OPTIONAL because a baseline recorded before that date has
     * no opinion about it, and treating "absent from the file" as "was missing"
     * would report drift on every partition at once. `check` says so out loud
     * rather than quietly comparing against nothing.
     */
    hasHostTrgm?: boolean;
}

interface PlainRow {
    name: string;
    estRows: number;
    bytes: number;
    pretty: string;
}

interface Baseline {
    recordedAt: string;
    database: string;
    partitions: PartitionRow[];
    /** samples_hourly, entities, devices: not partitioned, still losable. */
    tables: PlainRow[];
    totals: { partitions: number; estRows: number; bytes: number };
}

// Anything beyond this on an existing partition is drift worth stopping for.
// Live ingest during slice 1 adds to TODAY's partition and to no other, so a
// closed partition moving at all is the interesting signal.
const TOLERANCE = 0.02;

async function snapshot(): Promise<Baseline> {
    const res = await OPS.partitionStats();
    if (!res.ok) throw new Error(`could not read partition stats: lane refused (${res.reason})`);
    const plain = await OPS.plainTableStats();
    if (!plain.ok) throw new Error(`could not read table stats: lane refused (${plain.reason})`);

    const partitions: PartitionRow[] = res.rows.map((r) => ({
        parent: r.parent,
        partition: r.partition_name,
        estRows: Number(r.est_rows),
        bytes: Number(r.bytes),
        pretty: r.pretty,
        hasTrgm: r.has_trgm,
        hasHostTrgm: r.has_host_trgm,
    }));

    const tables: PlainRow[] = plain.rows.map((r) => ({
        name: r.name,
        estRows: Number(r.est_rows),
        bytes: Number(r.bytes),
        pretty: r.pretty,
    }));

    return {
        recordedAt: new Date().toISOString(),
        database: CONFIG.databaseUrl.replace(/:[^:@/]*@/, ':***@'),
        partitions,
        tables,
        totals: {
            partitions: partitions.length,
            estRows: partitions.reduce((a, p) => a + p.estRows, 0),
            bytes: partitions.reduce((a, p) => a + p.bytes, 0),
        },
    };
}

function print(b: Baseline): void {
    let lastParent = '';
    console.log(`  ${'partition'.padEnd(20)} ${'est rows'.padStart(14)} ${'size'.padStart(9)}  trgm msg/host`);
    for (const p of b.partitions) {
        if (p.parent !== lastParent) {
            lastParent = p.parent;
            console.log(`  -- ${p.parent}`);
        }
        console.log(
            `  ${p.partition.padEnd(20)} ${p.estRows.toLocaleString().padStart(14)} `
            + `${p.pretty.padStart(9)}  ${p.hasTrgm ? 'yes' : '-'} / ${p.hasHostTrgm ? 'yes' : '-'}`,
        );
    }
    if (b.tables.length > 0) {
        console.log('  -- unpartitioned');
        for (const t of b.tables) {
            console.log(`  ${t.name.padEnd(20)} ${t.estRows.toLocaleString().padStart(14)} ${t.pretty.padStart(9)}`);
        }
    }
    console.log(
        `  ${'TOTAL'.padEnd(20)} ${b.totals.estRows.toLocaleString().padStart(12)} ${(b.totals.bytes / 1024 ** 3).toFixed(1).padStart(7)}GB`,
    );
}

async function main(): Promise<void> {
    const mode = process.argv[2] ?? 'record';
    const now = await snapshot();

    if (mode === 'record') {
        fs.writeFileSync(FILE, JSON.stringify(now, null, 2) + '\n', 'utf8');
        console.log(`fixture baseline recorded ${now.recordedAt}`);
        console.log(`  ${path.relative(ROOT, FILE)}\n`);
        print(now);
        console.log('\n  (est rows is the planner estimate, not a count - see the header of this file)');
        return;
    }

    if (mode !== 'check') {
        console.error(`unknown mode ${JSON.stringify(mode)} - use "record" or "check"`);
        process.exit(2);
    }

    if (!fs.existsSync(FILE)) {
        console.error(`no baseline at ${path.relative(ROOT, FILE)} - run "node tools/baseline.ts record" first`);
        process.exit(2);
    }

    const before = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Baseline;
    console.log(`comparing against baseline recorded ${before.recordedAt}\n`);
    print(now);

    const drift: string[] = [];
    const expected: string[] = [];
    const beforeByName = new Map(before.partitions.map((p) => [p.partition, p]));
    const nowByName = new Map(now.partitions.map((p) => [p.partition, p]));

    // Ingest writes into the partition for the CURRENT day and no other, so
    // growth there is the burst test working rather than the fixture moving.
    // Treating it as drift would make this check fail after every run, and a
    // gate that always fails gets ignored, which is worse than not having one.
    //
    // The asymmetry is the point: a live partition may GROW and must never
    // SHRINK, and a closed partition must not move at all.
    //
    // WHICH DAY IS LIVE IS DECIDED FROM THE BASELINE'S DATE, NOT TODAY'S. The
    // first version used the date at check time and was wrong the moment the
    // clock passed midnight: a partition that grew legitimately while it was
    // the live day became, at 00:00, a closed partition that had moved, and
    // the check failed permanently against correct data. It did exactly that
    // 2026-07-27 at 00:11.
    //
    // Any partition dated on or after the baseline was, at baseline time, one
    // that ingest could still be writing to. Anything older was already closed
    // and must not have moved. That test does not rot.
    const baselineDay = before.recordedAt.slice(0, 10).replace(/-/g, '');
    const dayOf = (name: string): string | null => /_(\d{8})$/.exec(name)?.[1] ?? null;
    const couldStillGrow = (name: string): boolean => {
        const d = dayOf(name);
        return d !== null && d >= baselineDay;
    };

    for (const [name, was] of beforeByName) {
        const is = nowByName.get(name);
        if (!is) {
            drift.push(`partition ${name} is GONE (had ${was.estRows.toLocaleString()} rows, ${was.pretty})`);
            continue;
        }
        if (was.estRows > 0) {
            const signed = (is.estRows - was.estRows) / was.estRows;
            const grew = signed > 0;
            if (Math.abs(signed) > TOLERANCE) {
                if (couldStillGrow(name) && grew) {
                    expected.push(
                        `${name} grew ${(signed * 100).toFixed(1)}% (${was.estRows.toLocaleString()} -> ${is.estRows.toLocaleString()}, +${(is.estRows - was.estRows).toLocaleString()}) - ingest writes here`,
                    );
                } else {
                    drift.push(
                        `partition ${name} moved ${(signed * 100).toFixed(1)}%: ${was.estRows.toLocaleString()} -> ${is.estRows.toLocaleString()}`
                        + (couldStillGrow(name) ? ' - a live partition SHRANK, which ingest cannot do' : ''),
                    );
                }
            }
        }
        if (was.hasTrgm && !is.hasTrgm) {
            drift.push(`partition ${name} lost its msg trigram index`);
        }
        if (was.hasHostTrgm === true && is.hasHostTrgm !== true) {
            drift.push(`partition ${name} lost its host trigram index - free text is `
                + '`msg OR host`, so this half of every search has fallen back to a scan');
        }
    }
    for (const name of nowByName.keys()) {
        if (!beforeByName.has(name)) console.log(`  note: partition ${name} is new since the baseline`);
    }

    // Unpartitioned tables. samples_hourly is 64.8M rows the rollup job in
    // slice 5 writes to, and entities carries codes that can never be
    // regenerated - both are losable in ways no partition check would see.
    const beforeTables = new Map((before.tables ?? []).map((t) => [t.name, t]));
    const nowParents = new Set(now.partitions.map((p) => p.parent));
    for (const [name, was] of beforeTables) {
        const is = now.tables.find((t) => t.name === name);
        if (!is) {
            // A plain table that is now a partitioned PARENT has not been lost,
            // it has been converted - which is what tools/partition-rollup.ts
            // does to samples_hourly. Reported as a structural change so the
            // rows can still be accounted for, rather than as a loss.
            if (nowParents.has(name)) {
                const rows = now.partitions
                    .filter((p) => p.parent === name)
                    .reduce((a, p) => a + p.estRows, 0);
                const delta = was.estRows > 0 ? (rows - was.estRows) / was.estRows : 0;
                if (Math.abs(delta) > TOLERANCE) {
                    drift.push(`table ${name} became partitioned and its rows moved `
                        + `${(delta * 100).toFixed(1)}%: ${was.estRows.toLocaleString()} -> ${rows.toLocaleString()}`);
                } else {
                    expected.push(`${name} is now PARTITIONED, `
                        + `${rows.toLocaleString()} rows accounted for across its partitions`);
                }
                continue;
            }
            drift.push(`table ${name} is GONE`);
            continue;
        }
        if (was.estRows > 0) {
            const signed = (is.estRows - was.estRows) / was.estRows;
            // Unlike a live partition, these have no legitimate reason to
            // SHRINK. Growth is the collector and the rollup doing their jobs.
            if (signed < -TOLERANCE) {
                drift.push(`table ${name} SHRANK ${(signed * 100).toFixed(1)}%: `
                    + `${was.estRows.toLocaleString()} -> ${is.estRows.toLocaleString()}`);
            } else if (signed > TOLERANCE) {
                expected.push(`${name} grew ${(signed * 100).toFixed(1)}% `
                    + `(${was.estRows.toLocaleString()} -> ${is.estRows.toLocaleString()})`);
            }
        }
    }

    console.log('');
    for (const e of expected) console.log(`expected - ${e}`);
    if (drift.length > 0) {
        if (expected.length > 0) console.log('');
        for (const d of drift) console.error(`DRIFT - ${d}`);
        console.error('\nThe corpus the done-when criteria are measured against has changed.');
        process.exit(1);
    }
    // Counted from the partitions that did NOT move, rather than by
    // subtracting the expected list - which now also holds table growth, and
    // would have quietly understated the count.
    const movedOrGrew = new Set(expected.map((e) => e.split(' ')[0]));
    const unchanged = [...beforeByName.keys()].filter((n) => !movedOrGrew.has(n)).length;
    // A baseline older than 2026-07-27 recorded no opinion about the host
    // index, so this run cannot say anything about it. Said out loud, because a
    // check that silently narrows what it covers is the failure this project
    // has now found in four separate instruments.
    const hostTracked = before.partitions.some((p) => p.hasHostTrgm !== undefined);
    console.log(`ok - fixture intact: ${unchanged} partitions unchanged across `
        + `${new Set(before.partitions.map((p) => p.parent)).size} tables, `
        + `${beforeTables.size} unpartitioned tables intact, none lost, `
        + `no ${hostTracked ? 'msg or host ' : 'msg '}trigram index dropped`);
    if (!hostTracked) {
        console.log('  note: this baseline predates host trigram tracking, so a DROPPED HOST '
            + 'INDEX would not have been seen. Re-record to cover it.');
    }
}

main()
    .catch((err) => {
        console.error('baseline failed:', err);
        process.exitCode = 1;
    })
    .finally(() => closeAll());
