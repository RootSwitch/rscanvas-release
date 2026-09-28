# RSCanvas

A converged, self-hosted network monitoring platform in one process: SNMP
polling with history and rollups, ICMP and TCP reachability, syslog and trap
collection with searchable history, threshold and event alerting with
maintenance windows, notify policies and escalation, and live wall boards
driven by your own network diagram. Node with TypeScript over PostgreSQL,
with each concern on its own runtime and its own bounded share of the
database, so a slow query cannot stall a poll.

**Status: alpha (0.1.0-alpha.3).** It works, and it is getting polished. One
operator has run it for a season on a home network of about forty devices of
mixed make, and it has been load-tested to 30,000 tracked entities - on a
12 vCPU virtual machine for two weeks, and on an 8-thread mini PC taking
15,000 syslog messages a second alongside that polling without losing one.
Before this release it was drilled on clean servers: install, upgrade from
each earlier alpha, backup and restore, uninstall, power loss, a database
outage, a full disk, and a new user's first fifteen minutes in the browser.
`KNOWN-ISSUES.md` says what is missing or untested; `TESTING.md` says what
was measured and how; `CHANGELOG.md` says what changed. This is public domain software
(`LICENSE`, the Unlicense); the device-icon artwork carries its own notices
(`NOTICE-ICONS.md`).

It began as a rebuild of the [Canvas Suite](https://github.com/RootSwitch/canvas-suite),
six separate applications that passed JSON files between themselves, as one
internally modular application.

## What it looks like

![The Dashboard: open alerts, then the top 10 interfaces by traffic each way, errors and discards, CPU and memory over the last 24 hours, each with its change against the day before](docs/images/dashboard.png)

The Dashboard, where every sign-in lands. The fleet in these pictures is
the synthetic 30,000-entity load-test fleet, so its links carry terabytes
a day.

| | |
|---|---|
| ![A device page: its open alerts, sensor cards, and an interface's traffic chart](docs/images/device.png) | ![The device list, with transient and muted devices marked in the status column](docs/images/devices.png) |
| A device: alerts, sensors, and an interface's chart | The device list |
| ![An interface traffic report: GB in and out per day, peaks and coverage, with a CSV download](docs/images/report.png) | ![The System tab: health by thread and lane, with each section folded to its header](docs/images/system.png) |
| A traffic report, by day, with its CSV | System: health first, the rest folded |

![A wall display: 45 devices as a glance grid fitted to the screen, each tile with its type icon, CPU, memory, top traffic and ping; five dead devices in red](docs/images/wall.png)

A wall display, as a screen in a NOC would show it: a glance grid that fits
its tiles to the screen. The load-test fleet gives every device five dead
links on purpose, which is why its healthy devices wear amber - each is
carrying five open interface alerts - and the five dead devices are red.

The pictures are rendered, not taken: `node tools/make-screenshots.mjs`
serves this checkout's web client with the data in
`docs/src/screenshots/fixture/` and photographs it in a headless browser,
so they show the page as the code now draws it.

## What it does

- **SNMP polling.** v1, v2c and v3 with credential profiles; interfaces,
  CPU, memory, storage and temperature sensors; counter discontinuity and
  speed handling; interface identity that survives an agent renumbering its
  indexes. Raw samples are partitioned by day and rolled up hourly, with
  retention that drops whole partitions inside a lock timeout.
- **Reachability.** ICMP through fping and TCP connect checks, on a separate
  schedule from polling, with ping latency history.
- **Syslog and traps.** UDP listeners with bounded ingest, full-text search
  over a trigram-indexed recent window, and event rules that raise alerts
  from message patterns.
- **Alerting.** Threshold rules per sensor kind with hysteresis, per-device
  overrides, device-down and interface-down conditions, a pending/active/
  clearing state machine, maintenance windows that withhold notification,
  notify policies by device, location or application, escalation debt, and
  delivery by email, ntfy or syslog with a ledger of what is owed. A whole
  device's alerts can be muted, one device or a selection at a time.
- **Dashboard and reports.** Open alerts first, then the top 10 interfaces
  by traffic received and sent and by errors and discards, and the top 10
  CPU and memory, over 6 hours, 24 hours or 7 days, each with its change
  against the window before. An interface traffic report gives GB in and
  out per day with peaks and coverage, on the page or as CSV.
- **Boards and the wall.** Diagram boards drawn from your own layout and
  glance grids generated from the device list, on a wall display that fits
  its tiles to the screen, with capability tokens for kiosks and burn-in
  guards for screens that never switch off: a timed theme rotation and a
  small random shift of the whole wall.
- **Operations.** Per-user accounts with roles and an audit trail - each
  role sees only the controls it may use, and everyone can change their own
  password - TLS, an OpenMetrics endpoint, a one-command installer with hardened database
  roles, a backup tool that proves its own backups restore, an uninstall that
  keeps your data unless told otherwise, and health reporting that names the
  thread or lane that is behind.

Two companions live in their own repositories: **RSNMPAgent**, a small
Windows SNMP agent with stable interface indexes, and **RSFleet**, synthetic
SNMP fleets for demonstrations and load tests.

## Requirements

- Linux. Ubuntu 24.04 is what the installer and the drills ran on.
- Node 22.18 or later. The TypeScript is run directly; there is no build step.
- PostgreSQL 16 or later; 18 is what was tested.
- `fping` for ICMP reachability (optional; TCP checks work without it).
- Four runtime dependencies and no native modules, so a bundle built on one
  platform runs on another.

## Install

The bundle path is the supported one. On a machine with the repository,
Node 22 and npm, from the top of the repository:

    npm ci
    bash tools/make-bundle.sh

produces one self-contained tarball. On the target box:

    sudo mkdir -p /opt/rscanvas
    sudo tar -xzf rscanvas-<stamp>-<commit>.tar.gz -C /opt/rscanvas
    cd /opt/rscanvas && sudo ./rscanvas-setup.sh --tls

The installer installs packages, creates the database roles, applies the
schema, hardens the roles, writes the systemd unit and environment file,
mints a self-signed certificate, and verifies the result. Re-running it is
safe by design and is how upgrades are applied. `INSTALL.md` has the whole
procedure, the flags, upgrades, backup and restore, uninstalling, and where
to look when something is wrong.

From source, for development:

    npm install
    createdb rscanvas
    DATABASE_URL=postgres://user:pass@localhost:5432/rscanvas node src/db/apply-schema.ts --with-retention
    DATABASE_URL=... ADMIN_PASSWORD=... node src/main.ts

The first start with no users creates an admin from `ADMIN_PASSWORD` (name
from `ADMIN_USERNAME`, default `admin`). `npm test` runs the offline suite:
forty-seven test files and sixteen static checkers, no database needed.

## Configuration

Everything is an environment variable, read once in `src/config.ts`, where
each one carries the reasoning behind its default. The ones that matter first:

| variable | meaning |
|---|---|
| `DATABASE_URL` | the application role's connection string |
| `RSCANVAS_ADMIN_DB_PASSWORD` | the maintenance role's password, needed on a hardened database for index DDL |
| `HTTP_PORT`, `BIND_ADDRESS` | the web port (18080) and bind address |
| `TLS_CERT`, `TLS_KEY` | PEM pair; when set, the session cookie is Secure by default |
| `RSCANVAS_SECRET` | the secret that signs sessions and capability tokens |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | first-boot admin, only when no users exist |
| `SNMP_COMMUNITY` | the default v2c community; v3 and per-device credentials are managed in the UI |
| `SYSLOG_PORT`, `TRAP_PORT` | UDP listeners (5514, 15162 by default; the privileged ports need a capability) |
| `POLL_CONCURRENCY`, `POLL_DOWN_CONCURRENCY` | in-flight polls, and how many of them may be retries of down devices (half the pool by default) |
| `RAW_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS` | how many days of samples and messages to keep |
| `ALERT_SMTP_*`, `ALERT_NTFY_*`, `ALERT_SYSLOG_*` | notification channels |
| `METRICS_TOKEN` | enables `/metrics` behind a bearer token |

## Reading the code

Three decisions shape everything: each concern (polling, ingest, jobs,
export, the web) runs on its own runtime with its own bounded share of the
database, so nothing can block anything else; PostgreSQL with native
partitioning, chosen against the retention volume and the four concurrent
writers this design reaches at its 30,000-entity ceiling; and per-user
accounts with roles, capability tokens for wall displays, and boards as
first-class resources. The design document and the plans each piece was
built from exist and are being prepared for publication; the code's own
comments carry the reasoning at the point where it applies, deliberately.

Layout: `src/` is the application (workers for collector, ingest, jobs and
export; `store/` for every SQL statement; `alerts/`, `boards/`, `devices/`,
`collector/` for the logic each worker runs), `sql/` is the schema in applied
order, `public/` is the web client, `tools/` is the test suite, the static
checkers, the load and soak instruments, and the installer's helpers.

## Name

RootSwitch Canvas. Read it as Router/Switch Canvas if you prefer, or
Route/Switch for anyone who sat that Cisco track. RS-232 also works, which is
fitting for a tool whose test fleet includes a switch with a serial console.
