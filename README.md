# RSCanvas

A converged, self-hosted network monitoring platform in one process: SNMP
polling with history and rollups, ICMP and TCP reachability, syslog and trap
collection with searchable history, threshold and event alerting with
maintenance windows, notify policies and escalation, and live wall boards
driven by your own network diagram. Node with TypeScript over PostgreSQL,
with each concern on its own runtime and its own bounded share of the
database, so a slow query cannot stall a poll.

**Status: alpha (0.1.0-alpha.8).** It works, and it is getting polished. One
operator has run it for a season on a home network of about forty devices of
mixed make, and it has been load-tested to 30,000 tracked entities - on a
12 vCPU virtual machine for two weeks, and on an 8-thread mini PC taking
15,000 syslog messages a second alongside that polling without losing one.
Before the third alpha it was drilled on clean servers: install, upgrade
from each earlier alpha, backup and restore, uninstall, power loss, a
database outage, a full disk, and a new user's first fifteen minutes in the
browser. The fourth fixes what running the third on that network and on the
30,000-entity lab turned up. The seventh adds service checks: web pages,
TCP ports, and voice and throughput tests to your sites.
`KNOWN-ISSUES.md` says what is missing or untested; `TESTING.md` says what
was measured and how; `CHANGELOG.md` says what changed. This is public domain software
(`LICENSE`, the Unlicense); the device-icon artwork carries its own notices
(`NOTICE-ICONS.md`).

It began as a rebuild of the [Canvas Suite](https://github.com/RootSwitch/canvas-suite),
six separate applications that passed JSON files between themselves, as one
internally modular application.

## What it looks like

![The Dashboard: open alerts, then every location and application with its devices up and down, then the top 10 interfaces by traffic each way, errors and discards, CPU and memory over the last 24 hours, each with its change against the day before](docs/images/dashboard.png)

The Dashboard, where every sign-in lands. The pictures come from the
synthetic 30,000-entity load-test fleet, whose links carry terabytes a day,
with its devices dressed as a network would look - a mix of kinds, most of
them clean - since the fleet itself is one mock device repeated
(`docs/src/screenshots/` says exactly what is composed).

| | |
|---|---|
| ![A render workstation's device page: a warm GPU's alert, sensor cards for its CPU, memory, disks and two GPUs, and an interface's traffic chart](docs/images/device.png) | ![The device list, problems first: a transient virtual machine that is away, two devices down, three with an alert, then the clean ones](docs/images/devices.png) |
| A device: its alert, sensors including GPUs, and an interface's chart | The device list, problems first |
| ![An interface traffic report: GB in and out per day, peaks and coverage, with a CSV download](docs/images/report.png) | ![The System tab: health by thread and lane, with each section folded to its header](docs/images/system.png) |
| A traffic report, by day, with its CSV | System: health first, the rest folded |

![A wall display: 45 devices as a glance grid fitted to the screen, each tile with its type icon, CPU, memory, top traffic and ping; most green, three amber with an alert each, two down in red, and one away transient dimmed](docs/images/wall.png)

A wall display, as a screen in a NOC would show it: a glance grid that fits
its tiles to the screen, each with the device's type. Green is clean, amber
carries an alert, red is down, and a transient device that is away is
dimmed rather than alarming.

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
- **Service checks.** Run from the RSCanvas box on a schedule: web pages
  and endpoints (the status code, response time and certificate expiry,
  and if you ask, a word or one JSON field in the answer), TCP ports, and
  against an iperf3 responder at a site, a voice test - one G.711-shaped
  call each way, scored as loss, jitter and a MOS - and a throughput test
  that proves a capped rate or fills the link, at any hour or only in the
  hours you choose, measuring the latency the load causes. Each alerts on
  its own and charts like a sensor; throughput tests run one at a time and
  never beside a voice test, and when every outside check fails at once,
  one alert says so instead of one per check.
- **Syslog and traps.** UDP listeners with bounded ingest, full-text search
  over a trigram-indexed recent window, and event rules that raise alerts
  from message patterns.
- **Alerting.** Threshold rules per sensor kind with hysteresis, per-device
  overrides, device-down and interface-down conditions, a pending/active/
  clearing state machine, maintenance windows that withhold notification,
  notify policies by device, location or application, escalation debt, and
  delivery by email, ntfy or syslog with a ledger of what is owed. A
  device's polled alerts (down, interfaces, sensors) can be muted, one device
  or a selection at a time; its syslog and trap rules still alert. Adding a
  device asks whether to track all its ports or only those up now, and
  whether link-down alerts start on or manual - manual alerts only on the
  ports turned on from the device page, such as a switch's uplinks and host
  ports. A location or application can raise one
  group alert when enough of its devices are down, holding their own emails
  while it is open.
- **Dashboard and reports.** Open alerts first, then the top 10 interfaces
  by traffic received and sent and by errors and discards, and the top 10
  CPU and memory, over 6 hours, 24 hours or 7 days, each with its change
  against the window before. Service health by site: the last voice and
  throughput tests against the run before and the day's lowest, and every
  web and TCP check. An interface traffic report gives GB in and out per
  day with peaks and coverage, and a services report each check's average,
  worst and standard deviation per day and over the period - on the page or
  as CSV.
- **Boards and the wall.** Boards generated from the device list by location
  or application - one group, several, or the whole fleet - laid out
  automatically to fit each screen, on a wall display with capability
  tokens for kiosks and burn-in guards for screens that never switch off: a
  timed theme rotation and a small random shift of the whole wall. A board
  notices when its group gains or loses devices and offers to catch up, and
  a tile can show its device's MOS, bandwidth and checks.
- **Operations.** Per-user accounts with roles and an audit trail - each
  role sees only the controls it may use, and everyone can change their own
  password - TLS, an OpenMetrics endpoint, a one-command installer with hardened database
  roles, a backup tool that checks every dump against its row counts and with
  `--test` proves it restores, an uninstall that
  keeps your data unless told otherwise, and health reporting that names the
  thread or lane that is behind.

Two companions live in their own repositories: **RSNMPAgent**, a small
Windows SNMP agent with stable interface indexes, and **RSFleet**, synthetic
SNMP fleets for demonstrations and load tests.

## Requirements

- Linux. Ubuntu 24.04 is what the installer and the drills ran on.
- Node 22.18 or later. The TypeScript is run directly; there is no build step.
- PostgreSQL 16 or later from source; the installer installs 18, which is
  what was tested.
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
    DATABASE_URL=... ADMIN_PASSWORD=... COLLECTOR_ENABLED=1 JOBS_ENABLED=1 \n        RSCANVAS_SECRET=... node src/main.ts

The first start with no users creates an admin from `ADMIN_PASSWORD` (name
from `ADMIN_USERNAME`, default `admin`). Without `COLLECTOR_ENABLED=1`
nothing is polled and without `JOBS_ENABLED=1` nothing is rolled up or
expired; retention stays a dry run until `RETENTION_DRY_RUN=0`, and with no
`RSCANVAS_SECRET` credential profiles are off. The installer sets all four.
`npm test` runs the offline suite: sixty-two test files, eighteen static
checkers and a type check, no database needed.

## Configuration

Everything is an environment variable, most of them read once in
`src/config.ts`, where each one carries the reasoning behind its default.
The ones that matter first:

| variable | meaning |
|---|---|
| `DATABASE_URL` | the application role's connection string |
| `RSCANVAS_ADMIN_DB_PASSWORD` | the maintenance role's password, needed on a hardened database for index DDL |
| `HTTP_PORT` | the web port: 18080 from the installer, 8080 when run from source |
| `BIND_ADDRESS` | the address the web port, syslog and traps listen on; unset, they listen on every address (the web port on IPv6 as well) |
| `TLS_CERT`, `TLS_KEY` | PEM pair; when set, the session cookie is Secure by default |
| `RSCANVAS_SECRET` | the key that encrypts stored SNMP credential profiles. Sessions and display tokens do not use it: changing it revokes nothing, and makes every stored profile unreadable |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | first-boot admin, only when no users exist |
| `SNMP_COMMUNITY` | the default v2c community; v3 and per-device credentials are managed in the UI |
| `SYSLOG_PORT`, `TRAP_PORT` | UDP listeners: 514 and 162 from the installer (15162 for traps and 5514 for syslog with `--high-ports`), 5514 and 5162 when run from source |
| `TRUST_PROXY` | `1` behind a reverse proxy: the client address is the last `X-Forwarded-For` entry, which the proxy wrote. Set it only when every connection comes through the proxy - `BIND_ADDRESS=127.0.0.1` with the proxy on the same box |
| `COOKIE_SECURE` | the session cookie's Secure flag: on by default with `TLS_CERT`; set `1` behind a proxy that terminates TLS |
| `POLL_CONCURRENCY`, `POLL_DOWN_CONCURRENCY` | in-flight polls, and how many of them may be retries of down devices (half the pool by default) |
| `RAW_RETENTION_DAYS`, `MESSAGE_RETENTION_DAYS` | how many days of samples and messages to keep |
| `ALERT_SMTP_*`, `ALERT_NTFY_*`, `ALERT_SYSLOG_*` | notification channels |
| `ALERT_NOTIFY_BURST`, `ALERT_NOTIFY_PER_MINUTE` | how many alerts a channel sends one by one: 60 at once, then 60 a minute; past that they wait and go out together as one message a minute, never dropped |
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
