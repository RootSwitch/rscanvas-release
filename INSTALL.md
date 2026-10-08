# Installing RSCanvas

The procedure, without the history. One machine, one process, one
PostgreSQL. Ubuntu 24.04 is what the installer was drilled on; a dnf path
exists and is less exercised.

## What you need

- A Linux box you have root on. Processor and memory go a long way: a
  virtual machine with 4 vCPUs and 4 GB of memory (on a Xeon W-1290 host)
  polled the full 30,000-entity test fleet every 30 seconds using under a
  tenth of its CPU. RSCanvas itself used about 400 MB, and 2.9 GB of memory
  stayed free. The lab's 4-core N150 mini PCs run the same fleet too.
- **A disk for the database**, ideally its own: mount it at
  `/var/lib/postgresql` (by UUID, in `/etc/fstab`) BEFORE running the
  installer, which then puts PostgreSQL's data there. On the system disk, a
  database that fills its disk fills the system's too. The installer says
  which disk the data is going to, and asks once when it is the system disk.
  If you ever turn on PostgreSQL's WAL archiving, give the archive another
  disk again.
- **Disk is what to size**, from the data you keep (the retention days in
  section 2 set it, and the installer prints the estimate for them):
  - raw samples, kept 14 days by default: about 6 GB per 1,000 entities;
  - the hourly rollup behind charts and reports, kept for good: about 1.6 GB
    per 1,000 entities per year;
  - syslog and traps, kept 30 days: roughly 0.4 to 0.8 KB per message.

  10,000 entities and a modest syslog feed want about 80 GB to start and
  16 GB more a year. An entity is one tracked interface or sensor; a switch
  is usually tens of them.
- Outbound package access during install. The installer adds the PostgreSQL
  and NodeSource repositories and installs PostgreSQL 18, Node 22, fping and
  a few utilities.
- Network reach from the box to the devices: UDP 161 to poll, UDP 514 and
  162 inbound for syslog and traps, ICMP for reachability.

## 1. Get a bundle

On any machine with this repository, Node 22 and npm, from the top of the
repository:

    npm ci
    bash tools/make-bundle.sh

`npm ci` fetches the dependencies into the repository, and the bundle ships
them from there. The result is `rscanvas-<stamp>-<commit>.tar.gz`: the
source, its four runtime dependencies, the schema, and the installer. There is no build step;
Node runs the TypeScript directly, and there are no native modules, so a
bundle built on one platform runs on another. Copy it to the target box.

## 2. Run the installer

    sudo mkdir -p /opt/rscanvas
    sudo tar -xzf rscanvas-<stamp>-<commit>.tar.gz -C /opt/rscanvas
    cd /opt/rscanvas
    sudo ./rscanvas-setup.sh --tls

What it does, in order: installs packages; raises `net.core.rmem_max` to
16 MB in `/etc/sysctl.d/60-rscanvas.conf` (never lowering a larger value), so
the 8 MB receive buffers the syslog and trap sockets ask for are not clamped
to the kernel's 208 KB default; creates three database roles
(`rscanvas` for the application, `rscanvas_owner` for the schema,
`rscanvas_admin` for maintenance DDL); creates the database and applies every
schema slice; hardens the roles so the application role owns nothing it does
not need; writes the service account, `/etc/rscanvas/rscanvas.env` (root only)
and `rscanvas.service`; mints a self-signed TLS pair into `/etc/rscanvas/tls`
when `--tls` is given; starts the service; and verifies the result rather
than assuming it.

**Where things live.** The code in `/opt/rscanvas` belongs to root, and the
service cannot change it - root runs the installer and the backup tool from
there, so a service that could rewrite them could become root. The
configuration and secrets are in `/etc/rscanvas`. The only place the service
writes is `/var/lib/rscanvas` (exports waiting to be downloaded);
`EXPORT_SPOOL_DIR` in the env file can point exports at a bigger disk
instead. The service runs in a systemd sandbox: no way to gain privileges,
the rest of the filesystem read-only, and only two capabilities - binding
ports below 1024, which the unit grants to the service rather than to the
`node` program, and raw sockets, which `fping` needs for ping checks.

**It prints the generated credentials once, at the end.** The first
admin's password, and `RSCANVAS_SECRET`, the key that encrypts stored
credential profiles. Save both from that screen; the database passwords
are in `/etc/rscanvas/rscanvas.env`. The
installer never regenerates a secret on a later run, so a lost
`RSCANVAS_SECRET` means stored credential profiles cannot be read again.

Flags worth knowing:

| flag | effect |
|---|---|
| `--check` | report what the box is running and change nothing; run it first on any box you did not just build |
| `--tls` | https on the web port with a self-signed pair; sticky across re-runs; `--tls-cert` and `--tls-key` use your own pair instead |
| `--high-ports` | syslog on 5514 and traps on 15162, so the service needs no privilege; otherwise the installer grants `cap_net_bind_service` to node for 514 and 162 |
| `--raw-days N`, `--message-days N` | how many days raw per-poll samples and syslog/trap messages are kept; defaults 14 and 30, at least 7; written to the env file when given and kept on later runs when not |
| `--http-port N`, `--db NAME`, `--dir DIR`, `--user NAME` | the obvious overrides; defaults 18080, `rscanvas`, `/opt/rscanvas`, `rscanvas` |
| `--rotate-db-passwords` | on its own: new random passwords for the `rscanvas` and `rscanvas_admin` database roles, written to the env file, then the service restarted - nothing else changes (section 4 says when) |
| `--yes` | no prompts |

Then open `https://<box>:18080`, sign in as `admin` with the printed
password, and change it.

**Retention is on.** Raw per-poll samples are kept 14 days and syslog and
trap messages 30; the hourly rollup behind the charts, the Dashboard and the
reports is kept for good. Change the days by re-running the installer
with `--raw-days` and `--message-days`, or by editing `RAW_RETENTION_DAYS`
and `MESSAGE_RETENTION_DAYS` in `/etc/rscanvas/rscanvas.env` and restarting
the service. `RETENTION_DRY_RUN=1` there makes retention report what it would
delete without deleting anything. Boxes installed before 0.1.0-alpha.3 were
left in that dry run by the installer; set `RETENTION_DRY_RUN=0` on them. The
health page says so once the dry run is keeping data past its date.

## 3. Add devices

Settings holds credential profiles (v2c communities and v3 users, stored
encrypted under `RSCANVAS_SECRET`). Devices are added by address or by
probing a CIDR range; a device that does not answer can still be added with
Force Add and will be polled until it does. Interfaces and sensors are
discovered on the first poll. Point your devices' syslog and traps at the
box, and the messages and event alerts follow.

A device is its address and port together. Several agents behind one
address (a gateway forwarding ports to the boxes behind it, one agent per
container) are several devices: probe each port on its own. Names are
unique, so when a probed device reports a name another device already has,
the probe table says which device owns it and gives you a box to type a name
of its own. Nothing is renamed for you.

**SNMPv3.** A profile names the user, the security level (noAuthNoPriv,
authNoPriv or authPriv), and the protocols: authentication SHA-1, SHA-224,
SHA-256, SHA-384, SHA-512 or MD5; privacy AES-128, either AES-256 variant
(Blumenthal, which net-snmp calls AES-256, or Reeder, which Cisco uses; an
agent answers only the one it was built with), or DES where the system
allows it. MD5 and DES work but are labelled weak. A device's credential can
be changed on the device list, and the collector uses the new one at the
next poll.

**When a probe fails, the message says what it can.** A wrong v3 auth key
on a net-snmp agent comes back at once as "Wrong Digest". A wrong privacy
key, or a wrong v2c community, gets no answer at all; the agent drops the
request silently. So a timeout from a device that answers ping usually
means a credential, or an agent that only answers certain addresses, and
the message says so.

**Devices that are down cost polling time.** A device that does not answer
SNMP holds a polling slot for the whole timeout on every poll: 5 seconds,
tried twice. RSCanvas keeps half of its polling slots (12 of the default
24) for devices that are not answering, so the ones that answer are never
kept waiting by them. With the defaults that half polls about 36 silent
devices every 30 seconds; past that, the silent devices themselves are
polled less often. A few dozen devices that are often off - laptops, guest
PCs - are nothing to worry about: mark them transient on the device page,
and their absence raises no alert while their graphs resume whenever they
are back. Hundreds of devices that are gone for good are worth disabling or
removing. A ping-only device costs almost nothing when it is down.
`POLL_CONCURRENCY` and `POLL_DOWN_CONCURRENCY` change the split
(`src/config.ts` says how).

**Bursts of syslog and traps wait in memory.** Messages are written to the
database every 0.3 seconds, and the few hundred in between wait in memory.
When they arrive faster than the database can write them - a burst above
about 15,000 a second on a mini PC, or the database down - they queue, up
to `INGEST_QUEUE_MAX` (50,000 by default); past that the oldest are dropped
and counted on the health report. The ceiling is not memory set aside: it
is used only while the queue is full and returned as it drains. What a
queued message costs, measured:

| message | per message | 50,000 (default) | 150,000 |
|---|---|---|---|
| short (a link-state line) | about 530 B | 26 MB | 79 MB |
| typical (a firewall log line) | about 770 B | 39 MB | 116 MB |
| long (600 characters) | about 1,650 B | 82 MB | 247 MB |

150,000 holds five seconds at 20,000 a second above what the database
writes. Raising it helps bursts and outages; a flood that never slows still
drops messages, only later. Set it in `/etc/rscanvas/rscanvas.env` and
restart the service.

**Syslog** is accepted in RFC 3164 and RFC 5424 format on UDP 514. A
message's host is the hostname its header names; a message that names none
takes the name of the device at its source address, when exactly one device
has it. Some senders send no header at all (a MikroTik's remote logging
action does unless its BSD syslog format is turned on), and then the
message has no severity either, so turn the sender's header on where it
has one. The source address is kept on every message, and `ip:` finds it.
**Traps** are accepted as SNMP v1 and v2c on UDP 162, with any community.
They are stored with the trap's name where it is a standard one (linkDown,
coldStart and so on) and its trap OID, followed by the varbinds. A v1 trap
also keeps its enterprise, generic and specific numbers, and carries the
same trap OID as its v2 equivalent. An event rule matching
`1.3.6.1.6.3.1.1.5.3` therefore catches a linkDown in either version. A trap
from an address that belongs to one device is attributed to that device, so
the device's maintenance window and notify policy apply to alerts it raises.
A device mute does not: it silences what the device's polling raises, and a
syslog or trap rule, written on purpose, still alerts - a BGP peer dropping
on a muted router is heard. SNMPv3 traps are not accepted, and not planned:
they are refused before they are read, and counted.

**An event rule raises one alert per host it matches**, and holds at most
20 of them open at once (`EVENT_ALERT_HOSTS_MAX`). A message's host is
whatever its sender says, so past the limit new hosts share a single alert,
"<rule>: more than 20 hosts", rather than each opening one and sending its
own notification. Hosts already alerting keep their own alerts, and room
reopens as they clear.

**IPMI Platform Event Traps** (from a server's BMC) are decoded: a stored
one reads like `IPMI Fan: Lower Critical going low, asserted - severity
critical; sensor 0x41 on fan; raw reading 10, raw threshold 2; logged
2025-10-07 16:21:17 by the BMC clock; seq 102; Supermicro`, followed by
the trap header and its varbinds as for any trap, and its severity is kept
as the message's, so `sev:` finds it. Readings stay raw, because turning
them into RPM or degrees needs the sensor's record, which only the BMC
holds. The time is the BMC's own clock. A BMC is rarely worth polling, but
adding its address as a ping-only device gives its traps a device name and
tells you when the BMC itself stops answering.

**Service checks and voice tests** are added from a device's page, under
Services, by an admin. Every one runs from the RSCanvas box and nowhere
else - nothing at a site takes orders from it - so a check answers "can
RSCanvas reach it", not "can that site".

- An https check trusts Node's roots plus the operating system's, so an
  internal CA installed on the RSCanvas box (`update-ca-certificates`) is
  trusted without unticking verification.
- **A voice test** places one G.711-shaped call (64 kbps, 50 packets a
  second, marked EF) to an **iperf3 responder** at the site, toward it and
  then back, and reports loss and jitter each way and a MOS estimate. The
  installer puts the iperf3 client on the RSCanvas box, with its daemon off.
  The responder is yours to run, on a wired box at the site - a small Linux
  machine, or a container on a host already there, run with
  `--network host` so Docker's NAT is not in the measured path. (ESnet does
  not support iperf3 on Windows.) On Ubuntu or Debian:

      sudo apt install iperf3      # answer Yes to starting it as a daemon

  An iperf3 server answers anyone who can reach port 5201 and lets them
  fill the site's link, so allow only the RSCanvas box:

      sudo ufw allow from <RSCanvas address> to any port 5201 proto tcp
      sudo ufw allow from <RSCanvas address> to any port 5201 proto udp

  and cap what any client may ask for (`sudo systemctl edit iperf3`, then
  add `--server-bitrate-limit` to the `ExecStart` line: `1M` if the
  responder serves voice tests only - a call needs 64 kbps - or the rate
  your throughput tests prove, and no limit for an uncapped one). Add the
  responder to RSCanvas as a device with ping at least: the MOS takes its
  delay from the device's ping round trip. A responder that requires a
  login is not supported yet.
- **The MOS** (mean opinion score) is the 1-to-5 rating a panel of
  listeners would give a call. Here it is estimated from the network, not
  heard: iperf3 reports only loss and jitter, and RSCanvas works out the
  score with the simplified E-model of ITU-T G.107. That model starts a
  G.711 call at a rating of 93.2 and takes points off:

  - **Delay** costs 1 point for every 40 ms up to 160 ms, then 1 for
    every 10 ms past it - the point where people start talking over each
    other. The delay counted is the one-way delay (half the responder's
    ping round trip), plus twice the jitter, plus 10 ms for the codec.
  - **Loss** costs 2.5 points for each 1% of packets lost.

  The remaining rating becomes a MOS on a fixed curve. Each direction is
  scored, and the worse one is shown.

  A perfect network scores about 4.4, not 5: that is the best a G.711
  call can score at all, and it is where the "4.41 is good" people quote
  comes from. ITU-T G.109 gives these bands:

  | MOS          | Listeners               |
  |--------------|-------------------------|
  | 4.34 or more | very satisfied          |
  | 4.03 or more | satisfied               |
  | 3.6 or more  | some dissatisfied       |
  | 3.1 or more  | many dissatisfied       |
  | 2.58 or more | nearly all dissatisfied |
  | under 2.58   | not recommended         |

  The alert defaults are 3.6 (warning) and 3.1 (critical).

  For a site 10 ms away with 3 ms of jitter:

  | Loss | MOS  |
  |------|------|
  | none | 4.40 |
  | 1%   | 4.34 |
  | 3%   | 4.20 |
  | 9%   | 3.60 |

  Delay or jitter alone needs far more to do the same: about 337 ms one
  way (a satellite hop) or 167 ms of jitter to reach 3.6. So on a
  terrestrial network it is loss that moves the score, and the loss
  alerts (1% and 3%) and jitter alerts (30 and 50 ms) fire long before
  the MOS one. Treat those as the warnings and the MOS as the summary.

  The estimate covers the network's share of call quality only. A bad
  headset, echo, or another codec is outside it (G.729's best is about
  4.1). A test whose responder has no ping round trip shows no MOS.
- **A throughput test** sends TCP to the same kind of responder for ten
  seconds each way (after two of slow start), hourly by default. CAPPED,
  the default, holds each way to a rate you give - it proves the site can
  still get that much without taking the link from the people using it.
  UNCAPPED fills the link for those seconds, so the form then asks when it
  runs: at any hour, or only between two hours of this box's clock (01:00
  to 05:00 unless you change them; a window may wrap past midnight).
  Outside its hours an uncapped test is simply not run. Beside each call
  two streams of pings measure the
  latency the load causes - unmarked, which is bufferbloat, and marked EF,
  which is whether your QoS keeps voice out of that queue. Throughput
  tests run ONE AT A TIME across the whole install, ten seconds apart, and
  no voice test runs beside one; a set of them that cannot fit in an hour
  is refused when you save it, with the numbers. The test cannot measure
  past the RSCanvas box's own link - a box on 1 Gb tops out near 940 Mbps.

## 4. Upgrade

Untar the new bundle over the same directory and run the installer again:

    sudo tar -xzf rscanvas-<newer>.tar.gz -C /opt/rscanvas
    cd /opt/rscanvas && sudo ./rscanvas-setup.sh

It applies any new schema slices before
restarting the service, which is the order that matters: the new code
expects the new columns. Re-running it on
an unchanged box changes nothing. It keeps what the install already uses -
the database name, ports, service user and TLS - unless you pass a flag
again. Take a backup first (section 5).

**From an install made before 0.1.0-alpha.6, change the database passwords
afterwards.** Installers before then put both database passwords on a
command line, so sudo wrote them into `/var/log/auth.log` and the journal on
every install and upgrade; the current one does not, but what was written
stays until the logs rotate. Once the upgrade is done:

    sudo ./rscanvas-setup.sh --rotate-db-passwords

It gives both roles new passwords, writes them to the env file, proves each
logs in, restarts the service and waits for it to answer; if PostgreSQL
refuses either change, it puts everything back as it was. The service is
down for the restart only, as in an upgrade. A backup taken before the
rotation still carries the old passwords in its copy of the env file, and
restoring it brings them back, so rotate again after such a restore.

## 5. Back up and restore

Two things must survive: the database, and `/etc/rscanvas`. The env file in
there holds `RSCANVAS_SECRET`, and a database restored without it comes back
with every stored SNMP credential unreadable. `rscanvas-backup.sh`, beside
the installer, takes both into one file while the service keeps running:

    cd /opt/rscanvas
    sudo ./rscanvas-backup.sh                  # to /var/backups/rscanvas
    sudo ./rscanvas-backup.sh --test <file>    # prove it restores
    sudo ./rscanvas-backup.sh --restore <file> # make this box the one in <file>

**What it holds.** Everything except the raw per-poll samples and the syslog
and trap messages, which are the bulk of the database and the cheapest part
to lose: raw samples age out after days anyway, and the hourly rollup behind
the Dashboard, the reports and the long chart ranges is kept. `--full` takes
everything. The file holds secrets (the database password, the first admin's
password and `RSCANVAS_SECRET`), is written readable by root only, and
belongs off the box, wherever your other secrets live. It is small without
`--full`: a few hundred kilobytes for a small network. Run it daily from
root's crontab, and copy the file away.

**It checks its own work.** Every table is counted inside the same database
snapshot the dump is taken from, and the dump is refused if its contents do
not match those counts. `--test` restores into a scratch database beside the
live one, compares every table row for row, and drops it; nothing live is
touched. Run it once after you set backups up, and whenever you change
PostgreSQL versions.

**Restoring onto a new box.** Install the same RSCanvas version, or a newer
one, with the installer as in section 2. Then:

    sudo ./rscanvas-backup.sh --restore rscanvas-backup-<host>-<stamp>.tar

It stops the service, renames the new box's database aside and moves its
`/etc/rscanvas` aside (both kept, never deleted), restores the database and
compares it row for row, puts the backed-up `/etc/rscanvas` in place, and runs
the installer again. That brings an older backup's schema forward, sets the
database roles to the restored passwords and restarts the service. You sign
in with the old install's accounts. The restored box keeps the old TLS pair,
so if its address differs, browsers warn again; the script says so and
prints the two commands that mint a pair for the new box. When you are
satisfied, it tells you how to drop the set-aside copies.

A whole-machine snapshot, or `pg_basebackup`, is also a sound backup. Like
any backup, it is only proven once it has been restored.

## 6. Uninstall

    cd /opt/rscanvas
    sudo ./rscanvas-setup.sh --uninstall

This stops and removes the service, the application directory, the
port capability an older install gave `node` (if it is still there), and its
kernel buffer setting. It **keeps the data**: the database and its roles,
`/etc/rscanvas` (with `RSCANVAS_SECRET` and the TLS pair), `/var/lib/rscanvas`
and the service account. Installing again from any bundle finds them and resumes where it
left off, with the same accounts, devices, history and certificate.

    sudo ./rscanvas-setup.sh --uninstall --purge

This also drops the database (and any copies `rscanvas-backup.sh` set aside),
the three roles, `/etc/rscanvas`, `/var/lib/rscanvas` and the service account. It asks you to type
the database name first, unless you pass `--yes`. To purge after a plain
uninstall has removed `/opt/rscanvas`, run it from any extracted bundle.

Neither ever removes backups in `/var/backups/rscanvas`, or the packages the
installer added (PostgreSQL 18, Node 22, fping and their repositories),
because other software may use them. Removing the PostgreSQL package deletes
every database on the machine.

## 7. If something is wrong

    sudo ./rscanvas-setup.sh --check
    systemctl status rscanvas
    journalctl -u rscanvas -n 200
    curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:18080/api/health/work

The last line answers without signing in: 200 when the workers are
working, 503 when one is starved. The full health report, which names the
worker or database lane that is behind, is the System page (or
`/api/health`, signed in). Every startup failure names its own fix in the journal: a missing
capability for port 514, a database still starting, a schema behind the
code.

**If the disk fills,** the health report says so first, in its problem
list. When it runs out entirely, PostgreSQL stops. RSCanvas keeps receiving
syslog and traps and holds up to 50,000 messages in memory (`INGEST_QUEUE_MAX`,
section 3) until the database returns. Past that it drops the oldest and counts them. Free some
space and PostgreSQL restarts by itself within 10 seconds: the installer
gives its unit a restart policy for exactly this. Nothing else needs doing.
Retention days (section 2) are how to stop it happening again.

## From source, for development

    npm install
    createdb rscanvas
    DATABASE_URL=postgres://user:pass@localhost:5432/rscanvas node src/db/apply-schema.ts --with-retention
    DATABASE_URL=... ADMIN_PASSWORD=... node src/main.ts

The first start with no users creates an admin from `ADMIN_PASSWORD`.
`npm test` runs the offline suite with no database. Nearly everything the
application reads from the environment is in `src/config.ts`, with the
reasoning behind each default. A few are read where they are used instead:
`RSCANVAS_SECRET` (`src/credentials/crypto.ts`), `ADMIN_USERNAME` and
`ADMIN_PASSWORD` (`src/auth/index.ts`, first start only), `COOKIE_SECURE`
(`src/auth/index.ts`), `TRUST_PROXY` (`src/http/respond.ts`),
`SNMP_COMMUNITY` and any variable a device's credential reference names
(the collector), `PARTITION_LOOKAHEAD_DAYS` and
`PARTITION_RUNWAY_ALARM_DAYS` (the collector and ingest workers, which keep
their partitions ahead), `DATA_DEVICE` (`src/residency.ts`, the cache
residency check), and the test-only `DESTRUCTIVE_TEST_DB` and
`ALLOW_FIXTURE_DROPS`.
