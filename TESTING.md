# How RSCanvas was tested

What was measured, on what, for how long, and what held. Every campaign
below was pre-registered - its pass criteria written before the run - and
graded against those criteria afterwards, including the rows that failed.
The primary records - the pre-registered plans, the results files and the
day-by-day lab ledgers - are private for now; this file is their summary,
and the instruments that produced every number are in `tools/`.

## The instruments

- **A heartbeat on every thread.** Each runtime ticks every 10 ms and
  records the gap; a gap over 50 ms on a latency-sensitive thread (main,
  ingest, collector) is the one number the architecture is judged by.
- **An idle control.** A separate process that does nothing but the same
  heartbeat, so a gap it reports is the hypervisor descheduling the guest,
  not the application. Its verdict voids the subject's numbers for that hour.
- **The hourly soak line** (`tools/soak.sh`): database size, row counts,
  rollup frontier, partition runway, RSS, heartbeat worst and p99, lane
  waits, job failures, live writers - one line an hour, evaluated by
  `tools/soak-check.sh` against per-run pins, with every rule required to
  fire in the checker's own self-test.
- **A daily fault window** (`tools/soak-fault.sh`): a slice of the fleet
  taken away for ten minutes each night, so alerting and recovery are
  exercised every day of a run rather than assumed.
- **The offline suite** (`npm test`): fifty-six test files and sixteen
  static checkers that hold invariants the reviews kept finding one instance
  at a time - every query on a declared lane, no DOM injection sinks, no
  duplicate SQL definitions, every worker message type with a sender, and
  so on. Where a test needs a database it says so, and the destructive ones
  refuse any database but `rscanvas_test` (or one named in
  `DESTRUCTIVE_TEST_DB`) unless `ALLOW_FIXTURE_DROPS=1`.

## The campaigns

| campaign | fleet | box | duration | outcome |
|---|---|---|---|---|
| storage spike | corpora to 1.3 billion rows, four storage backends | lab VM | July 2026 | settled PostgreSQL with native partitioning; write rate 1,002 rows/s at 30k measured |
| slice results 1 to 4 | 100 mock devices (90 live, 10 dead by design), plus a seeded 30,000-entity fixture | lab VM | per slice, July | each slice's done-when criteria met before the next began |
| the 10k soak | 405 mock devices, 10,125 entities, syslog at 100 messages a second, query load | 12 vCPU VM | 268 hours | PASS 2026-08-08: zero event-loop gaps over 50 ms on the latency-sensitive threads |
| the 30k ceiling run | 1,550 mock devices, 29,988 entities, 78 dead by design, daily fault window | 12 vCPU, 31 GB RAM, PostgreSQL 18 | 14 days, 2026-08-31 to 09-14 | did not fall over; the thesis row not held on one thread - below |
| the floor run | 400 mock devices, 10,128 entities (11,748 on the current build), syslog at 100 a second | a 4-core mini PC | 28 days on the previous build, continuing on the current one | clean nightly sawtooth, flat memory - below |
| fresh install | the installer on a factory-new Ubuntu 24.04 | a scratch VM | 2026-09-01 | end to end, zero breaks; every finding was a documentation defect, fixed the same day |

## What the 30k run found, in one paragraph

The box did not fall over, and the pre-registered thesis did not hold on one
thread of three. Over fourteen days at 29,988 entities the fleet was polled
on time (every due device within two intervals, zero slot-starved
dispatches), samples were written at 966 rows a second with nothing pending,
nine nightly retention drops each removed exactly the partition's own row
count, the database plateaued at about 70 GB with a named creep, memory sat
flat under a ceiling for eight days, and the daily fault window recovered
every night. The collector thread crossed 50 ms about sixty times an hour
for the whole run - 0.020% of its ticks, worst 103 ms - while the idle
control was clean in every hour and the other two threads never crossed
once. The plan's own wording does not allow that to be called a pass, so it
is not. The cause was attributed and fixed afterwards - it was not garbage
collection - and the section below has the measurement. Two criteria were not
exercised at that scale, syslog volume and search under load, and the record
says so rather than borrowing credit from the 10k soak.

The drive under the run took 169 GB of writes a day against 10.8 GB of data
kept, about sixteen times amplification, and 7 GB of reads a day because the
working set lived in the page cache. At that rate a 300 TBW drive lasts about
five years.

## What the floor run found

A four-core mini PC held 400 devices with syslog for four weeks on the
previous build with a clean nightly sawtooth, a flat 450 MB process, and a
collector that sat at the health report's 0.10% stall edge throughout. On the
current build it polls the same fleet with a slower median and the same
cadence - since attributed on two identical boxes, below.

## Since the first alpha: three measurements

These were investigations and measurement ladders on a rebuilt lab of three
mini PCs, not pre-registered campaigns, and are reported as such. The fleet
for all three was the 30k ceiling run's: 1,550 mock devices, 29,988
entities, 78 dead by design, served from its own box.

| measurement | box under test | what it found |
|---|---|---|
| the slower median, A/B | two identical 4-core Intel N150 mini PCs, one per build | the gap was mostly the test fleet: one mock process answering for 450 devices on the poller's own CPU. With the fleet moved to another box as ten-device processes, 55 against 31 ms, and that remainder is the sensors and 32-bit counters the newer build reads |
| syslog and traps at scale | an 8-thread Ryzen mini PC, 32 GB, NVMe, polling the 30k fleet throughout, a generator on a second box | nothing lost below 15,000 syslog or 12,500 traps a second; write ceiling about 16,400 syslog rows and 13,700 traps a second; the ingest thread never over 50 ms at any rate; every loss above the ceiling counted by the application, the kernel dropping nothing once its receive buffer was sized |
| the collector's stalls | the same Ryzen box at 30k | a CPU profile of every thread and a garbage-collection trace: not garbage collection (2% of the stall time, no pause over 25 ms), but rows handed to the database one at a time and a timing summary sorted four times a second. Fixed; 70 stalls in five minutes before, under one after, health green at the design ceiling |

The ingest ladder ran the same build twice, identical but for how message
rows reached the socket, so the one-row-at-a-time cost was measured rather
than inferred: a fifth of the ceiling, and the ingest thread's stalls.

## Since the third alpha: the pages at scale, and the schedule

Found by using the third alpha: the operator on every page of the 30k lab,
and two days of its own network. Each is a measurement before and after a
fix, on the Ryzen box above unless it says otherwise.

| measurement | what it found |
|---|---|
| the pages at 30k | everything answered promptly but two. The Alerts refresh took 850 ms, 730 of them PostgreSQL compiling a 24 ms query to machine code (JIT); with JIT off for short queries, 60 ms. Switching the Dashboard's window took 1.6 s for a day and 2.9 s for a week; kept until the hourly rollup moves and warmed in the background, a few milliseconds |
| the page thread's pauses | a CPU profile of the main thread, taken through the inspector without a restart, put every pause of 40-90 ms on an open tab's 10-second refresh: 52 and 58 ms of that thread's CPU to build the alert list and the roster, 1.4 MB each, fetched whatever the tab showed. Fetched now only where shown, and gzipped to 60 and 77 KB: ten minutes with a tab open on System, no pause over 50 ms, against about twenty in fifteen minutes before |
| the poll cadence | 31.01 s between polls of a 30-second device, over 1,973 polls on the operator's network; each poll counted from when the last one finished. On a fixed schedule: 30.009 s on a 41-device box, and 30.005 s across 1,472 devices at 30k (30.574 before) |
| retention's first drops at 30k, 2026-10-01 | samples_20260924 (about 38 million rows) dropped in 0.74 s on the hourly run; the collector's 30-second write bursts before, during and after it the same size (about 22,500 rows), no write failures, the threads inside their limits. The messages partition the same hour was SKIPPED - the two retention jobs fired in the same instant and the second lost the advisory lock, reporting success (fixed: they queue, 9980065). Redeployed with the fix under 1,000 syslog datagrams a second off-box: messages_20260924 (about 55 million rows) dropped in 2.7 s, ingest held 983-1,016 a second through it, every datagram from the socket's bind on written (159,180 of 159,180), flush max 98 ms, kernel drops 0 |
| the collector at 30k, a week | single pauses of 150 to 320 ms every day or two (426 ms once), a handful of ticks among millions, the other threads undisturbed and nothing logged. Under the health report's 500 ms acute limit; accepted as measured (2026-10-01), to be reopened if longer runs say otherwise |
| the alert scan at 30k, six days | about 109,000 scans of 102,903 conditions every five seconds across 25 process runs, no failures but nine during a lab deployment that missed a schema slice; typical scan 0.42 s, slowest sample 1.2 s |
| an interface that disappears | a tracked interface deleted from a Linux host is marked stale on the first poll that no longer sees it, and when it returns at a new index it is followed by name to the same record, history kept, the stale mark cleared. On Linux net-snmp a removed interface reads down, not gone, until snmpd restarts |
| a board after retagging | a board generated from a location reports one missing and one moved away when devices change location, and its add and drop actions bring it back to none of either |
| the database itself | on a disposable database with the full schema: retention picks the same UTC days from sessions in UTC+14 and UTC-11, the rollup writes whole hours and the Dashboard weights them by readings (150, not the 250 of a mean of means), event alerts fold, keep their severity and are born again after clearing, and every installed function is its newest definition (`tools/test-scratch-db.ts`, `tools/test-apply-convergence.ts`) |
| interface tracking | on the operator's network 232 untracked interfaces were sampled every poll beside 104 tracked ones, and five tracked Wi-Fi and tunnel interfaces had never been read. After the fix, no untracked rows, and the five started recording |

## What was not tested

High availability, failover, multi-tenancy, 30,000 entities on anything
smaller than the 8-thread, 32 GB mini PC above, search latency under a heavy
query load at the 30k scale, how quickly the pages answer to many people at
once at the 30k scale (one operator used them), and real-hardware SNMP beyond one operator's network of about forty devices.
Each is stated so that nothing above is read as covering it.
