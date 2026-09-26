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
- **The offline suite** (`npm test`): forty-five test files and sixteen
  static checkers that hold invariants the reviews kept finding one instance
  at a time - every query on a declared lane, no DOM injection sinks, no
  duplicate SQL definitions, every worker message type with a sender, and
  so on. Where a test needs a database it says so and refuses any database
  whose name does not say scratch.

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

## What was not tested

High availability, failover, multi-tenancy, 30,000 entities on anything
smaller than the 8-thread, 32 GB mini PC above, search latency under a heavy
query load at the 30k scale, how quickly the pages answer at the 30k scale,
and real-hardware SNMP beyond one operator's network of about forty devices.
Each is stated so that nothing above is read as covering it.
