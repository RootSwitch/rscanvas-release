# Known issues, as of 0.1.0-alpha.7

Written 2026-09-15 for the first alpha and revised 2026-09-26, 2026-09-28,
2026-09-30, 2026-10-01, 2026-10-03 and 2026-10-08 for the second to the seventh. Everything here is
known, and apart from the section that records what was fixed and measured,
unbuilt; nothing here is hidden behind a feature that pretends to work. Grouped by
how much it would cost someone using the software. `CHANGELOG.md` lists
what each alpha fixed.

## Rough edges you will meet

- **The installer cannot move the database to another disk.** It says
  where PostgreSQL's data is going and how full that disk is, asks once when
  it is the system disk, and takes the days kept (`--raw-days`,
  `--message-days`); but a separate data disk has to be mounted at
  `/var/lib/postgresql` before the first install, and moving an existing
  database is PostgreSQL's own procedure. WAL archiving is never turned on.
- **SNMPv3 traps are not accepted, and not planned** (2026-10-01). v1 and
  v2c traps are; a v3 trap is refused before it is parsed, and counted
  (until 2026-10-01 a noAuthNoPriv one was accepted). Receiving v3 means a user
  and keys per sending device, configured on both ends, for little a v2c
  trap does not already say. SNMPv3 polling is supported and documented in
  INSTALL.md section 3.
- **A device mute silences its polled alerts only** - device-down,
  interfaces, sensors - by design (2026-10-01). A syslog or trap rule is
  written on purpose and keeps alerting on a muted device; to quiet one,
  disable the rule or open a maintenance window on the device.
- **A device that stops answering is polled on its full schedule** until
  the half of the polling slots kept for silent devices fills (about 36
  devices at the defaults); past that they are polled less often, and the
  devices that answer are never slowed. INSTALL.md section 3 says what it
  costs. A per-device polling backoff was considered and not built
  (2026-09-30): the down-lane cap already keeps the cost where it belongs.
- **A group alert holds its devices' device-down emails only**, by design
  (2026-10-01). Interface, CPU, temperature and UPS alerts on the group's
  devices still email on their own, and so does a syslog rule matching a
  link-down: which of those belong with an outage, and which are worth
  hearing anyway, is not one answer, so a group alert is about devices up
  and down.
- **Board access is by role, not per board.** Anyone signed in sees the
  boards their role allows, and an operator may change any of them; a
  screen or a person who should see one board is given a display token
  for it. Per-board rules for people were considered and not built
  (2026-09-30).
- **The Dashboard reads the hourly rollup**, so its windows end at the last
  complete hour and can be up to an hour behind, and the 7-day trend is
  blank until a little over ten days of history exist. The services report
  reads the same rollup, so its last day ends at the last complete hour.
  Memory percentages are only as good as the device's own accounting; some
  devices count caches as used.
- **A traffic report covers an interface's tracked history only.** An
  interface the discovery defaults leave untracked (some sub-interface
  types) has none until it is tracked.
- **"Active ports only" is decided once, when a device is added**
  (2026-10-02). Ports that appear later, a Rediscover, and a device added
  before it ever answered are tracked by the usual discovery rule; a port
  is ticked or unticked by hand on the device page after that.
- **Manual link-down alerts are set one device at a time**, at the add
  step or in the device's Modify block; there is no roster-wide switch. It
  covers link down only - errors, discards and utilization still alert on
  every tracked port. Switching a device back to "on" leaves the ports
  that were turned on with their own setting, which then says the same as
  the device's.
- **A stall shows on the health page for fifteen minutes** (2026-10-02).
  The heartbeat verdict judges the last fifteen minutes, so a VM paused by
  its host - a nightly backup, say - reads red for a quarter of an hour
  after each pause and then clears; the worst stall since start, and when,
  stays in the thread table. Before, one stall held it red until a restart.

## Findings still open

- **The alert list and the device roster are about 1.4 MB each at 30,000
  entities** (with about 2,000 open alerts; 60 and 80 KB gzipped, which is
  how a browser receives them), and each takes the server's page thread
  50-60 ms to build. A view showing one
  refreshes it every 10 seconds, which the health report shows as pauses of
  40-90 ms on that thread, inside its limits. Other views fetch them once a
  minute, and a tab in the background not at all.

## Security findings still open

From the 2026-09-30 review. The ones a single packet or request could use
are fixed (`CHANGELOG.md`, 0.1.0-alpha.5); these remain, and each needs a
decision or a drill before it is changed.

- **Database passwords from earlier installs are in the system's logs.**
  Before 0.1.0-alpha.6 the installer put both database passwords on a command
  line - `psql -c "... PASSWORD '...'"` and the schema step's admin URL - so
  every install and upgrade wrote them into sudo's log (`/var/log/auth.log`
  and the journal, readable by root and the `adm` group) and showed them in
  `ps` while it ran. The installer now passes them on stdin and in the
  environment, but the lines already written stay until the logs rotate.
  Changing the two passwords after upgrading turns them into dead text:
  `sudo ./rscanvas-setup.sh --rotate-db-passwords` (INSTALL.md, section 4).

- **The service holds the raw-socket capability**, for `fping`. Under the
  unit's `NoNewPrivileges` a program cannot gain a capability its parent
  lacks, so `fping` started by the service cannot use its own; and fping
  5.1's unprivileged mode (`ping_group_range`) receives no replies, measured
  on Ubuntu 24.04. Raw sockets without link-layer access add little to what
  the service already does on the network.
- **Anyone can keep an account locked** by failing to sign in as it five
  times a minute, by design (2026-10-01): accounts lock as well as
  addresses, and the remedy for a sustained attempt is outside the
  application - a firewall rule, or a proxy in front of it.
- **A viewer can hold the database's interactive lane** with a search whose
  "did you mean" hint scans every retained partition.
- **The hardened database roles limit SQL misuse, not a compromised
  service.** The retention function now enforces its own floors and the
  audit trail is append-only for the application (2026-10-01), but the
  service holds the maintenance role's password, for trigram index upkeep,
  so code running inside it can change the schema; and the rollup's
  progress marker, which retention trusts before dropping raw data, is
  writable by the application role.
- **A hostile device can still cost polling time and memory**: there is no
  per-device cap on interfaces or sensors and no deadline on one device's
  poll. (Its values no longer reach the database unbounded.)

## Fixed and measured since the first alpha

`TESTING.md` has the numbers; in short:

- **The collector's stalls at 30,000 entities are fixed.** It used to cross
  50 ms on about 0.25% of its ticks - two and a half times the health
  report's limit, so the health page read red at the design ceiling. A CPU
  profile and a garbage-collection trace attributed it: not garbage
  collection, but database rows handed over one at a time (two socket writes
  each) and a timing summary sorted four times a second. After the fix: under
  one stall in five minutes, health green.
- **Syslog and trap ingest was measured at scale** alongside the 30k fleet:
  nothing lost below 15,000 syslog or 12,500 traps a second, a ceiling near
  16,400 and 13,700 on a mini PC, the ingest thread never stalling, and any
  loss above the ceiling counted by the application rather than hidden in
  the kernel.
- **The pages at 30,000 entities** were exercised on 2026-09-29, the
  operator using every page against the lab box. Two answers were slow: the
  Alerts refresh (about 0.85 s, nearly all of it PostgreSQL compiling a 24 ms
  query to machine code) and switching the Dashboard window (1.6 s for a
  day, 2.9 s for a week). They now take about 60 ms and, once warm, a few
  milliseconds. The same compile cost was behind the notify job logging
  "still running, skipping this one" every five seconds at that scale: 720
  lines an hour before, none since.
- **The slower median poll time** seen on a four-core box after an upgrade
  was attributed on two identical boxes: mostly the test fleet sharing the
  poller's CPU, and the rest the sensors and counters the newer build reads.

## Decisions deferred, not built

- **Hardening of interface identity** on agents that report no physical
  address.
- **Service checks, as built.** A check cannot send an authorization header yet, so an
  endpoint behind a token is out of reach - and a token in the URL's query
  is stored and shown like the rest of the URL, so do not put one there.
  Every check runs
  from the RSCanvas box only - by design, so nothing at a site takes
  orders - which means it answers "can RSCanvas reach it", not "can that
  site". A response-time alert needs two slow runs in a row (2026-10-07),
  so a one-off spike is quiet - the lab's first day had two, at 2.65 and
  2.9 s against medians of 24 and 151 ms - but a page that hovers at its
  threshold can still raise and clear with it; there is no band between
  raising and clearing yet.
- **Voice tests, as built.** A voice test places its two
  calls one after the other, so it holds the responder twice as long as
  the plan meant: iperf3 3.16 (Ubuntu 24.04's) crashed on 3 of 10
  both-ways-at-once calls under loss, the very case the test is for. Its
  chart draws loss; jitter and the MOS are on its card and in its alerts,
  not charted. A responder that requires a login cannot be used yet. Under
  2% injected loss, one test in eleven ended in an iperf3 error whose words
  were not captured; such an error now freezes the test's rules rather
  than reading as the responder down, and every change of a check's
  outcome is logged with its reason, so the next one will say what it was.
- **Throughput tests, as built.** One TCP stream each way:
  a path faster than one stream can fill reads low, and there is no
  setting for more yet. Nothing measures past the RSCanvas box's own link.
  An uncapped test on the lab's 1 Gb LAN did not move the 30,000-entity
  lab's poll failure rate, but what one does to polls and pings ACROSS a
  slow WAN link - where the test and the site's polling share the
  bottleneck - is unmeasured, and a site's devices could read degraded
  for the length of the test; the intended answer (hold degraded during
  the window) waits for that measurement. A paused throughput test resumed
  later is not re-judged against the hour's budget. Latency under load is
  on the card, not charted, and raises no alert of its own.

## Tests and drills owed

- **The lookup ration and the by-address database connects under a real
  DNS block**. The operator's second real outage (2026-10-06)
  confirmed the settling window and the DNS naming - two messages for the
  whole incident, every name-based check reading as a DNS failure - and
  found database connects starving behind unanswered lookups (CHANGELOG,
  Fixed). The fix was measured in a process whose DNS never answers, in a
  private namespace on the lab box; it has not yet met a real outage.

## Ideas, not promises

A fleet-wide health table (every sensor of one kind across the fleet),
per-location traffic, the anomaly detector's next steps, an ARP and MAC
table scan companion, and the operator's own polish list for the settings
and board-controls pages.
