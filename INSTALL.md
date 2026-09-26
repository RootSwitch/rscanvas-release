# Installing RSCanvas

The procedure, without the history. One machine, one process, one
PostgreSQL. Ubuntu 24.04 is what the installer was drilled on; a dnf path
exists and is less exercised.

## What you need

- A Linux box you have root on. Anything from a 4-core mini PC upward; the
  ceiling test used 12 vCPU and 31 GB for 30,000 tracked entities.
- Outbound package access during install. The installer adds the PostgreSQL
  and NodeSource repositories and installs PostgreSQL 18, Node 22, fping and
  a few utilities.
- Network reach from the box to the devices: UDP 161 to poll, UDP 514 and
  162 inbound for syslog and traps, ICMP for reachability.

## 1. Get a bundle

On any machine with this repository and Node installed:

    bash tools/make-bundle.sh

That produces `rscanvas-<stamp>-<commit>.tar.gz`: the source, its four
runtime dependencies, the schema, and the installer. There is no build step;
Node runs the TypeScript directly, and there are no native modules, so a
bundle built on one platform runs on another. Copy it to the target box.

## 2. Run the installer

    sudo mkdir -p /opt/rscanvas
    tar -xzf rscanvas-<stamp>-<commit>.tar.gz -C /opt/rscanvas
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

## 3. Add devices

Settings holds credential profiles (v2c communities and v3 users, stored
encrypted under `RSCANVAS_SECRET`). Devices are added by address or by
probing a CIDR range; a device that does not answer can still be added with
Force Add and will be polled until it does. Interfaces and sensors are
discovered on the first poll. Point your devices' syslog and traps at the
box, and the messages and event alerts follow.

## 4. Upgrade

Untar the new bundle over the same directory and run the installer again:

    tar -xzf rscanvas-<newer>.tar.gz -C /opt/rscanvas
    cd /opt/rscanvas && sudo ./rscanvas-setup.sh

It applies any new schema slices before restarting the service, which is the
order that matters: the new code expects the new columns. Re-running it on
an unchanged box changes nothing.

## 5. Back up

Two things must survive: the database, and `/etc/rscanvas`, because the
env file holds the database password and `RSCANVAS_SECRET`. A whole-cluster
backup (`pg_basebackup`, or a snapshot of the machine) is the right shape;
a logical `pg_dump` of individual tables does not follow the partition and
function dependencies this schema relies on, and a dump that exits 0 can
still be missing the data. Whatever you choose, restore it once onto a
scratch box before you need to. A fuller backup and restore procedure is
being prepared for publication.

## 6. If something is wrong

    sudo ./rscanvas-setup.sh --check
    systemctl status rscanvas
    journalctl -u rscanvas -n 200
    curl -sk https://localhost:18080/api/health

The health report names the worker or database lane that is behind, and
every startup failure names its own fix in the journal: a missing
capability for port 514, a database still starting, a schema behind the
code.

## From source, for development

    npm install
    createdb rscanvas
    DATABASE_URL=postgres://user:pass@localhost:5432/rscanvas node src/db/apply-schema.ts --with-retention
    DATABASE_URL=... ADMIN_PASSWORD=... node src/main.ts

The first start with no users creates an admin from `ADMIN_PASSWORD`.
`npm test` runs the offline suite with no database. Everything the
application reads from the environment is listed in `src/config.ts` with
the reasoning behind each default.
