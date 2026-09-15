# Known issues, as of the alpha

Written 2026-09-15, when the operator paused work. Everything here is known
and unbuilt; nothing here is hidden behind a feature that pretends to work.
Grouped by how much it would cost someone using the software.

## Rough edges you will meet

- **No uninstall or teardown path.** The installer is idempotent and serves
  upgrades; nothing removes what it made.
- **The installer's three questions are doctrine, not flags.** The runbook
  explains the choices (section 1); the script does not yet ask them.
- **SNMPv3 has code and tests, but no user-facing documentation.**
- **Backup and restore** has a private runbook being prepared for
  publication (`INSTALL.md` carries the minimum) and a restore drill script
  that has not been exercised end to end on a real box.
- **Changing a device's credential has never been live-tested** as a
  wrong-to-right swap on a real device. The bulk route exists and the poller
  reads the credential on every poll, so it should take one interval.
- **The device page is dense** and its long tables (audit, messages,
  reachability) are not capped; the settings page's order is historical.
- **A transient device is a per-device flag** with no overview; there is no
  table of them in settings and no column on the roster.

## Findings still open

- **At 30,000 entities the collector thread stalls 50 to 103 ms about sixty
  times an hour** on a 12 vCPU box, while the other threads never do. No
  device misses a poll; it is the thesis criterion's own zero that is
  missed. Not attributed; a GC trace on the collector under that load is
  the next measurement (`TESTING.md` has the summary; the full results
  record is private for now).
- **On a four-core box the current build polls a 400-device fleet with a
  median of about 140 ms** where the previous build read 26 ms, at the same
  cadence. Not attributed. The one-variable test is to run the old down-lane
  cap for a day.
- **The interactive-latency and syslog-volume criteria** were not exercised
  at the 30k scale.

## Decisions deferred, not built

- **Group alerts** (many devices down at once as one alert). Ruled out for
  now; the open word is raise versus suppress.
- **Per-board access rules** are described in three documents and enforced
  nowhere. Enforce or amend.
- **Board reconcile verbs.** Drift between a board and its device list is
  detected and named; add, drop and rebuild do not exist.
- **The stale-band fix for alerts** (a threshold that no longer matches its
  reading keeps its band).
- **Per-device polling backoff**, the complement to the proportional
  down-lane cap.
- **A try-all-credentials onboarding probe**, and hardening of interface
  identity on agents that report no physical address.

## Tests and drills owed

- Live: a SIGTERM drill through `tools/chaos.sh` across all four workers, an
  alerts-lane soak, dropping an interface mid-run to assert the stale
  marker, and a reconcile retag.
- Scratch database: non-UTC retention, event-alert upsert semantics, rollup
  weighting.
- Live server: the unauthenticated-surface assertion and the
  malformed-parameter matrix.

## Ideas, not promises

Reporting and a dashboard (top interfaces, a fleet-wide health table,
per-location traffic), the anomaly detector's next steps, an ARP and MAC
table scan companion, and the operator's own polish list for the settings,
board-controls and device pages.
