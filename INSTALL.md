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
- **Disk is what to size**, from the data you keep (the retention days in
  section 2 set it):
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

**It prints the generated credentials once, at the end.** The database
password, the first admin's password, and `RSCANVAS_SECRET`, the key that
encrypts stored credential profiles. Save all three from that screen. The
installer never regenerates a secret on a later run, so a lost
`RSCANVAS_SECRET` means stored credential profiles cannot be read again.

Flags worth knowing:

| flag | effect |
|---|---|
| `--check` | report what the box is running and change nothing; run it first on any box you did not just build |
| `--tls` | https on the web port with a self-signed pair; sticky across re-runs; `--tls-cert` and `--tls-key` use your own pair instead |
| `--high-ports` | syslog on 5514 and traps on 15162, so the service needs no privilege; otherwise the installer grants `cap_net_bind_service` to node for 514 and 162 |
| `--http-port N`, `--db NAME`, `--dir DIR`, `--user NAME` | the obvious overrides; defaults 18080, `rscanvas`, `/opt/rscanvas`, `rscanvas` |
| `--yes` | no prompts |

Then open `https://<box>:18080`, sign in as `admin` with the printed
password, and change it.

**Retention is on.** Raw per-poll samples are kept 14 days and syslog and
trap messages 30; the hourly rollup behind the charts, the Dashboard and the
reports is kept for good. Change the days with `RAW_RETENTION_DAYS` and
`MESSAGE_RETENTION_DAYS` in `/etc/rscanvas/rscanvas.env` and restart the
service. `RETENTION_DRY_RUN=1` there makes retention report what it would
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
the device's maintenance window, mute and notify policy apply to alerts it
raises. SNMPv3 traps are not accepted yet: they are refused and logged.

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

## 4. Upgrade

Untar the new bundle over the same directory and run the installer again:

    sudo tar -xzf rscanvas-<newer>.tar.gz -C /opt/rscanvas
    cd /opt/rscanvas && sudo ./rscanvas-setup.sh

On the default ports it asks once more about the port capability for
`node` (answer y, or add `--yes`). It applies any new schema slices before
restarting the service, which is the order that matters: the new code
expects the new columns. Re-running it on
an unchanged box changes nothing. It keeps what the install already uses -
the database name, ports, service user and TLS - unless you pass a flag
again. Take a backup first (section 5).

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
capability the installer gave `node` for ports 514 and 162, and its kernel
buffer setting. It **keeps the data**: the database and its roles,
`/etc/rscanvas` (with `RSCANVAS_SECRET` and the TLS pair) and the service
account. Installing again from any bundle finds them and resumes where it
left off, with the same accounts, devices, history and certificate.

    sudo ./rscanvas-setup.sh --uninstall --purge

This also drops the database (and any copies `rscanvas-backup.sh` set aside),
the three roles, `/etc/rscanvas` and the service account. It asks you to type
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
    curl -sk https://localhost:18080/api/health

The health report names the worker or database lane that is behind, and
every startup failure names its own fix in the journal: a missing
capability for port 514, a database still starting, a schema behind the
code.

**If the disk fills,** the health report says so first, in its problem
list. When it runs out entirely, PostgreSQL stops. RSCanvas keeps receiving
syslog and traps and holds up to 50,000 messages in memory until the
database returns. Past that it drops the oldest and counts them. Free some
space and PostgreSQL restarts by itself within 10 seconds: the installer
gives its unit a restart policy for exactly this. Nothing else needs doing.
Retention days (section 2) are how to stop it happening again.

## From source, for development

    npm install
    createdb rscanvas
    DATABASE_URL=postgres://user:pass@localhost:5432/rscanvas node src/db/apply-schema.ts --with-retention
    DATABASE_URL=... ADMIN_PASSWORD=... node src/main.ts

The first start with no users creates an admin from `ADMIN_PASSWORD`.
`npm test` runs the offline suite with no database. Everything the
application reads from the environment is listed in `src/config.ts` with
the reasoning behind each default.
