# Known issues, as of 0.1.0-alpha.3

Written 2026-09-15 for the first alpha and revised 2026-09-26 and
2026-09-28 for the second and third. Everything here is known and unbuilt;
nothing here is hidden behind a feature that pretends to work. Grouped by
how much it would cost someone using the software. `CHANGELOG.md` lists
what each alpha fixed.

## Rough edges you will meet

- **The installer does not ask where the data lives.** Three decisions
  belong to whoever installs: which disk holds the database (a separate
  data disk, mounted at `/var/lib/postgresql` by UUID before PostgreSQL is
  installed, is the sound choice), where a WAL archive would go if one is
  ever enabled, and how many days are kept, which sets the disk (INSTALL.md,
  "What you need"). The installer takes the distribution's defaults and
  asks none of them.
- **SNMPv3 traps are not accepted.** v1 and v2c traps are; a v3 trap is
  refused and logged. SNMPv3 polling is supported and documented in
  INSTALL.md section 3.
- **The device page's long tables** (audit, messages, reachability) are not
  capped, and in a narrow window the device panel scrolls sideways under its
  interface table.
- **Transient and muted devices have no overview.** Each shows on its own
  row of the device list and on its device page; there is no filter or table
  of them.
- **A device mute covers polled alerts only** - device-down, interfaces,
  sensors. Syslog and trap rule alerts are governed by their rules.
- **The Boards and Thresholds panels are admin-only** in the page, although
  the server lets operators edit boards and read thresholds.
- **The Dashboard reads the hourly rollup**, so its windows end at the last
  complete hour and can be up to an hour behind, and the 7-day trend is
  blank until a little over ten days of history exist. Memory percentages
  are only as good as the device's own accounting; some devices count
  caches as used.
- **A traffic report covers an interface's tracked history only.** An
  interface the discovery defaults leave untracked (some sub-interface
  types) has none until it is tracked.
- **At tens of thousands of entities the notify job logs "still running,
  skipping this one" every scan.** Nothing is behind - its own counters show
  every run completing - but it fills the log.

## Findings still open

- **The interactive-latency criterion** - how quickly the pages answer - was
  not exercised at the 30,000-entity scale.
- **One 426 ms gap on the collector thread**, once, a few minutes after a
  restart, with the other threads undisturbed and nothing logged. It is
  under the health report's 500 ms acute limit, has not recurred, and is
  being watched rather than chased.

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
- **The slower median poll time** seen on a four-core box after an upgrade
  was attributed on two identical boxes: mostly the test fleet sharing the
  poller's CPU, and the rest the sensors and counters the newer build reads.

## Decisions deferred, not built

- **Group alerts** (many devices down at once as one alert). Ruled out for
  now; the open word is raise versus suppress.
- **Per-board access rules** are described in three documents and enforced
  nowhere. Enforce or amend.
- **The stale-band fix for alerts** (a threshold that no longer matches its
  reading keeps its band).
- **Per-device polling backoff**, the complement to the proportional
  down-lane cap.
- **A try-all-credentials onboarding probe**, and hardening of interface
  identity on agents that report no physical address.
- **The ingest queue bound for bursts.** 50,000 rows in memory; a burst of
  20,000 messages a second for five seconds outruns it and the excess is
  shed and counted. Holding such a burst needs roughly three times that.

## Tests and drills owed

- Live: an alerts-lane soak, dropping an interface mid-run to assert the
  stale marker, a reconcile after retagging devices, and a nightly retention
  drop at the 30,000-entity scale on the current schema.
- Scratch database: non-UTC retention, event-alert upsert semantics, rollup
  weighting.

## Ideas, not promises

A fleet-wide health table (every sensor of one kind across the fleet),
per-location traffic, the anomaly detector's next steps, an ARP and MAC
table scan companion, and the operator's own polish list for the settings
and board-controls pages.
