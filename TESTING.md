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
- **The offline suite** (`npm test`): sixty-two test files and eighteen
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

## Since the fifth alpha: the installer end to end, and the passwords

Run 2026-10-02 and 10-03 on two clean Ubuntu 24.04 VMs and the lab boxes,
for the installer changes behind the sixth alpha.

| measurement | what it found |
|---|---|
| the build an outsider makes | the public tree, cloned on a Linux box, `npm ci`, `tools/make-bundle.sh`: the three scripts executable, no carriage returns, the dependency audit clean, 1,133 entries |
| a fresh install from that bundle | on a VM reverted to its factory snapshot: every step through, the three roles created through stdin (the owner without a login, the application and maintenance roles with passwords, maintenance a member of the owner), the service up with no restarts, health 200, sign-in working, and no password on any line sudo logged or the journal kept |
| `--rotate-db-passwords` | on the fresh box and on an upgraded one: the three env values and both roles' stored passwords changed, each role signed in with its new one, the service back at once; a planted refusal of the second change put the env file back byte for byte with no restart; nothing password-bearing in sudo's log |
| backup, rotate, restore, rotate | restoring a backup taken before a rotation brought the old passwords back, as INSTALL.md says, and the service with them; rotating again gave new ones. The backup, written into an existing 1777 directory, left it 1777 and wrote the archive 0600 |
| `--uninstall --purge` beside lookalikes | with `rscanvas_pre_restore_x postgres`, a prefix-only name and a set-aside directory with a space beside a real copy: the install and the real copy gone, `postgres` and every lookalike kept and named. The first run's own verify step still used the old prefix match and failed a correct purge; fixed and re-run clean |
| the installer's flags | `--user root`, `--user` naming a person's account, `--dir /`, `--db postgres` and `--http-port 0` refused on an installed box before any change; root's home and `/etc/passwd` untouched |
| health's 15-minute window at 30k | 21 hours, 253 samples, nothing red but the 15 minutes after a deliberate 1.5-second pause of the whole process |
| the collector's failure log at 30k | 20 lines in the ten minutes before the change, from devices dead by design; none in the nine after, the same devices still failing every 30 seconds |

## Since the sixth alpha: service checks

Run 2026-10-05 to 10-08 on the 30,000-entity lab box, for the service
checks, and on a lab box and a test VM for the seventh alpha's build and
upgrade.

| measurement | what it found |
|---|---|
| the entity `source` column | every one of 30,140 rows read `snmp` after the upgrade; the sensor and interface samples in the two minutes after it matched the two minutes before, count for count |
| eighteen checks every 30 seconds | each outcome as designed, against Google, GitHub, Microsoft's sign-in, badssl.com's expired, wrong-name and self-signed certificates, and a local server answering 500, the wrong JSON, the wrong page, two gigabytes, or nothing: thirteen alerts, all the right ones, none for a healthy check; health 200 throughout, nothing in the log |
| the spacing | in the suite, 120 checks against a server that never answers finished in about the 3.4 seconds the arithmetic allows, not the 120 a serial prober would take, with at most 52 connections open |
| an internal CA | trusted from the operating system's store on Ubuntu 24.04's Node 22.23, untrusted without it |
| the outside-services alert | with checks failing by design: at 4 of 8 failing, one alert, naming the four; the members' own alerts raised and held; once they recovered, the group cleared and the held ones were never sent |
| throughput tests and the stagger | on the lab's 1 Gb client: headroom held its cap to 0.04 Mbps; uncapped read 941/928 Mbps with the 30k lab's poll failure rate unchanged (2.4%, 2.0% during, 2.4%); behind a 200 Mbit inbound bottleneck with a deep queue, loaded latency 82 ms for both ping streams, and with an EF priority band 131 ms unmarked against 3.9 ms marked; two throughput tests and a voice test pressed together ran one after another with the gap; an over-budget schedule refused at save |
| voice tests against a responder with known impairment | iperf3 on the lab, 2% loss and 40 +/- 10 ms injected on the way back only: 1.0 to 2.8% lost (mean 1.9%) and 5.7 to 6.9 ms of jitter reported from the site, toward it clean, the loss alert raised and cleared with it; busy retried and recorded as gaps; a stopped responder warned and recovered. iperf3 3.16 crashed on 3 of 10 both-ways calls, so each test is two one-way calls |
| ... under a real outage | the lab's internet blocked at the router, then its DNS too: one group alert, steady through the DNS block, cleared seconds after the internet came back - and two members emailed before the group formed, because checks find an outage one schedule at a time. With the settling window, re-drilled with checks failing on their own schedules: three raised early and were held, four still failing when the group cleared settled silently - two messages in all; a check failing alone was held 45 s, then sent |
| ... under a second real outage (2026-10-06) | DNS blocked 21 minutes, the internet 20: two messages for the incident, every member held, the name-based checks reading as DNS failures. And about a hundred lab devices raising and clearing device-down once a minute, for as long as DNS was blocked: the checks' unanswered lookups held both of the process's lookup slots, the database connects to "localhost" timed out behind them (93 times), and polls that could not write were recorded as device failures |
| the lookup starvation, reproduced | one process on the lab box, in a private mount namespace whose resolver never answers, five name-based checks stuck: a lookup of "localhost" (what each new database connection did) took 19.5 s before the fix and 1 ms after; a connect by address took 3 ms throughout |
| a database that refuses, for three minutes | the app's role capped four connections under what it held, so new connects were refused on and off: 1,471 polls could not be recorded and none was written against its device - no device-down raised, poll rate unchanged (about 2,800 a minute), two devices briefly stale and back within a minute, health red with the count and the database's words; 87 log lines in all. Before the in-memory hold, the same drill logged 697 lines of schedule writes refused |
| two slow runs in a row | a local page answering every other request 2.6 s late, checked every 30 s: three slow runs in three minutes, each beside a fast one, and no alert; then every answer late: the warning raised on the second slow run in a row |
| the build an outsider makes | the public tree, cloned on a Linux box, `npm ci`, `tools/make-bundle.sh`: the three scripts executable, no carriage returns, the dependency audit clean, 1,150 entries |
| alpha.6 to alpha.7 in one step | on a VM running alpha.6 with 41 devices and 31 million raw samples, by INSTALL.md section 4: backup, unpack, the installer with no flags. Slices 57 to 59 applied in 3 to 5 ms, iperf3 3.16 installed with its daemon off, the service up with no restarts, both health routes 200; the row counts of all 21 tables and the users, devices and entities unchanged, polling straight on, and no password literal or credential URL in the journal. Re-run on the upgraded box, it changed nothing |
| a restart with a ping sweep in flight | on that VM's second restart, all 41 devices recorded up to unknown at the signal's millisecond and back ten seconds later: systemd's stop reached fping, which prints only as it exits. The operator's history held the same at five restarts in two weeks. Fixed, and shown with the real fping: a sweep sent SIGTERM mid-flight came back empty before the fix, and as nothing to apply after |

## Since the eighth alpha: a deleted device's history, windows that repeat, restarts, acknowledgement, the device timeline, availability, notes and change from normal

Run 2026-10-09 and 10-10 on the 30,000-entity lab box: first after the demo
network showed a deleted device's hourly history staying for good and the
device staying on the Dashboard for up to an hour; then for repeating
maintenance windows, after production's nightly 03:00 backup of a domain controller sent
fourteen emails in eight nights. And on 10-15 for restarts and
acknowledgement, both found half-built in a review of the digest: the
parent's reboot detector ported and never called, and an acknowledgement
column read by renotify that nothing could set. And on 10-16 for the
device timeline and the links from alerts to their logs, then the
availability report and device notes; and on 10-16 for change from normal,
built from the operator's two incidents - a closet whose AC failed while
every switch stayed in its limits, and a NIC whose fan died.

| measurement | what it found |
|---|---|
| the history deletes had left behind | 10.8 million hourly rows over two months held 52 belonging to 50 entities deleted earlier (the demo network: 2,712). The census read them out at about a second a month of rollup; in a transaction rolled back afterwards, the drain removed all 52 in batches of 20, and none was left |
| a delete through the app | one device of 56 entities: all 56 queued in the delete's own statement, their 20,776 hourly rows held until the rollup passes the hour of the delete. The Dashboard had answered from its held copy in 6 ms just before; the next visit recomputed in 1.6 s without the device. Added back by probe and add, all 56 entities again |
| what must not be purged | an id put in the queue by hand while its entity lived left the queue with its 20,776 rows untouched. On a scratch database with the full schema, the app's own statements: a removed check and a deleted device queue their entities, the drain takes only what the rollup is an hour past, and a delete made a minute ago keeps its rows until it is (`tools/test-scratch-db.ts`, section 13) |
| when a repeating window is open | on a scratch database: "every day at 03:00 for 10 min" in Chicago is open from 08:00Z for exactly ten minutes in October and from 09:00Z in January; a Saturday 23:30 hour runs past midnight into Sunday and not from Friday or Sunday; weekdays only means closed on a Saturday; in London the same 03:00 is 02:00Z. Daylight saving as PostgreSQL resolves it: 02:30 on the night spring skips it opens at 03:30 on the clock, and 01:30 on the night autumn repeats it opens for the second, standard-time one (`tools/test-scratch-db.ts`, section 14) |
| what it holds, and what it lets through | through the app's own statements, with an occurrence open: a device-down raised inside it was owed no page and read "in maintenance", its clear was settled without one, and a second outage still active was owed its page the moment the schedule was removed. On the lab box through the API: a schedule open now marked an existing device-down alert in maintenance and removing it unmarked it; all six bad requests refused (everything, 13 hours, an unknown zone, a bare offset, "3am", a device that does not exist); both forms add one in the browser's zone, and the System list and device page show it in words with its next occurrence. A rename carries it (`tools/test-rename-cascade.ts`) |
| restarts, at fleet scale | one of the lab's mock fleets restarted, 70 agents: all 70 recorded on their next poll, as restarts after about 21.5 days up, and not one of the box's other 1,480 devices. On the poll that found each one all six interface rates were blank, and the next was measured as usual - one device's interface read nothing at 19:53:37 and 120 Mb/s thirty seconds later |
| the judgement itself | offline, sixteen cases (`tools/test-restart.ts`): an ordinary poll; a restart in a minute's gap; up ten minutes, gone an hour and back up twenty - more uptime than before, and a restart, which comparing two readings misses; a month-long outage that ended in one; a day-long outage on a clock 500 ppm slow, which is not one; the 497-day wrap, even with the gap understated by a poll's length, which is not one; and nothing judged when a reading or the gap is missing |
| what a restart writes | on a scratch database through the app's own statements: the poll's write records the restart, its uptime before and its boot time, and the device row carries it; one recorded while a window is open is planned; a failed poll records nothing whatever it is handed; and deleting the device takes its restarts (`tools/test-scratch-db.ts`, section 15) |
| restart alerts | off by default: the 70 restarts raised nothing. Turned on for one device from the API, its restart six minutes earlier raised one warn - "restarted after 21d 12h up" - and no other device's. Turned on for every device from the device page, the 70 then inside their 30 minutes raised 70 and nothing else did. When their 30 minutes ran out all 70 cleared inside half a minute and every clear was settled without a message: the notifications log holds their 70 raises and no clear. The rule offline: held to the second, never for a planned, muted or transient device, the narrower override wins (`tools/test-rules.ts`). The device page's switch wrote the device's own row, and switching it back deleted the row rather than keeping an "off" one |
| acknowledgement | through the API and then the alert page's own form: who, when and the note shown on the alert, as "acked" with the note on hover in the Alerts list and on the device page; again replaces it; taken back clears it; a malformed id 400, an unknown one 404, taking back what nobody acknowledged 409; every change in the audit log naming the alert. On a scratch database: renotify skips an acknowledged crit and owes it again once taken back, and a cleared alert refuses one (section 16) |
| what the pages cost | the device page now spends five queries, each one statement whatever the entity count: its budget of 2 (`tools/test-page-budgets.ts`) had stood since 08-13 while the page grew to four, and now names all five. The Alerts list and the alert page spend three each against budgets of 2 - the same drift, from the flap report and threshold provenance, left for a ruling |
| the device timeline | on a scratch database through the app's own statement: every kind of row newest first - an incident's raise, escalation, acknowledgement and clear, ping lost and back, a restart at the time it came back, windows on the device and on its location, and the one occurrence of its application's daily schedule in the window, each with its end - and nothing of another device, no alert that never raised, no acknowledgement's audit line (it is the alert row's), audit rows only with the permission, the window and the limit kept (`tools/test-scratch-db.ts`, section 17). On the lab box it read back the previous day's restart drill in order: the restart, the alert switched on, raised, acknowledged with its note, cleared, switched off |
| what it costs | one statement for any window: the page-budget test counts one query at 24 hours and at 30 days. The first version took 2.2 s for a month on the lab box under EXPLAIN - it looked up the device's entity codes again for each of 10,600 audit rows - and 140 ms once the codes were read once |
| logs in one click | in the browser on the lab box: an alert's "around the raise" opened Logs ten minutes before to five after its raise, the window rounded up to the minute, the search already run, filtered to the device's address and saying so under the field panel; a timeline row's link the same around its moment. The device's charts drew its restart and its restart alert's raise and clear, and the hover named both |
| the ping roll-up | on a scratch database: from the oldest probe, each hour's probes and misses, the hour a window covered planned whole, and rolled again over the same hours nothing counted twice; ping retention never deletes a probe the roll-up has not taken; deleting a device takes its hours (`tools/test-scratch-db.ts`, section 18). On the lab box, a day of 1,556 devices' probes - about 2.2 million - rolled in 9.8 s, so the three weeks on disk took about half an hour of five-minute runs |
| the availability report | offline (`tools/test-availability-report.ts`): probes in maintenance left out of the share and counted; groups pooled, so a location of a device 90% up for a day and one 100% up for an hour is 90.4%, not the 95% an average says; nothing outside maintenance is no figure rather than 100%; the unassigned group named; transient devices left out and named; worst first; the CSV the same figures. On a scratch database the statement counted an outage carried in from before the period, a two-minute outage, a 30-second blip, ten minutes inside a window as planned, and degraded as up (section 18). Two queries for 1,549 devices on the lab box, 186 ms over the five days rolled at the time |
| on production's own week | the report's statement run READ ONLY over production's raw minute probes for the last seven days, before anything was deployed: a WAN ping target 99.296% with its two outages (15 minutes on 10-16, 6 on 10-11) and 160 blips - the target's dropped pings, as found on 10-10; the four VMs on the operator's desktop five outages of about three and a half minutes each, the desktop restarting; the domain controller 100%, its 768 s of nightly backup down inside its window counted apart and 65 pings left out; a transient PC at 3.5% - which is why transient devices are left out |
| notes | on a scratch database: stored with their line breaks, trailing blank lines trimmed, blank stored as none, carried by the roster (section 19). In the browser on the lab box: saved from the form, shown as written, the device list's filter found the device by the asset tag in them; 2,001 characters refused with the count, 2,000 kept, blank cleared it |
| change from normal, chosen on production's history | the rules and their windows came from replays over production's own readings, exported read only before anything was built: hourly over 24.9 days, then raw 30-second readings over eight judged days (IDEAS-ANOMALY.md). On the room-following sensors, one sensor at max(3 x spread, 8 C) over 20 minutes and a room at max(3 x spread, 3 C) over 10 raised nothing false, and saw a planted dead NIC fan in 14 minutes and a planted closet AC failure in 14 to 38 |
| which sensors take part | offline (`tools/test-tempchange.ts`, 92 cases): every temperature name production had, by class - boards, NICs, disks, DIMMs and a CRS's "CPU temperature" in, CPU packages, GPUs, NVMe and the chipset out; the stencil deciding a CPU-named sensor; a UPS's probes in and its battery out; the sensor's own include or exclude first, a device switched off taking all of it out, a device switched on not sweeping its CPU in. The lab's own fleet - 1,556 devices of coretemp cores - takes no part, and raised nothing |
| the rules at their edges | offline: +8 C is not past the gate and +8.1 is; a noisy sensor's three spreads outrank the floor; a fall is never judged; short of readings, or its device down, a sensor freezes; muted, transient and still-learning sensors take no part; a room needs min(3, n) of n >= 2, counts a device once however many sensors it has, and FREEZES rather than clears when its servers go quiet - an AC failure that shuts them down must not clear its own alert |
| the statements | on a scratch database through the app's own SQL (`tools/test-scratch-db.ts`, section 20): each tracked temperature's week from the hourly rollup - 100 hours, median 40.75, quartiles 40.375 and 41.125, the current hour and day eight left out, a stale row dropped; the last 10 and 20 minutes from raw readings; the scan's verdict on four devices in one room and one in another; a down witness, a mute and an include; the week read with the device page's entities, still five queries; the room's alert held by a window and a policy on its location, holding its members, for 20 minutes after it clears, and their clears settled with it; the cascade on delete. 125/125 |
| a closet AC failure, live | on the lab box, four mock devices in one location serving a SYSTIN and an mlx5 sensor each, a week of history behind them: every sensor 5 C warmer at 01:52:34 raised the room's alert at 01:57:45 - one warn naming all four, one syslog message, "at least 5 C each - the room, not one device: check its cooling". No sensor's own alert: 5 C is under their 8 |
| a dead fan under it | the same eight sensors 20 C warmer from 02:00:17: each raised its own warn at 02:10:15, "+20 C, gate 8", and all eight read "held - room alert" on the Alerts page with nothing sent |
| the room cooling | back to normal at 02:16:12, the room cleared at 02:21:46 and sent its clear, and the eight sensors at 02:26:46, five minutes later. FOUND HERE: as first built, those five minutes would have released all eight as owed - a raise each for sensors already coming back, then a clear each. Fixed (7439b6d): a member stays held for 20 minutes after its room clears. Run again with the fix, the whole incident sent two messages, the room's raise and its clear |
| the card and the device row | in the browser: each temperature card says whether it takes part and why, its week, its spread and where it stands now; exclude wrote the sensor's own row and the card said so; include deleted the row rather than keeping an "on" one that only repeated the name's verdict |

## What was not tested

High availability, failover, multi-tenancy, 30,000 entities on anything
smaller than the 8-thread, 32 GB mini PC above, search latency under a heavy
query load at the 30k scale, how quickly the pages answer to many people at
once at the 30k scale (one operator used them), and real-hardware SNMP beyond one operator's network of about forty devices.
Each is stated so that nothing above is read as covering it.
