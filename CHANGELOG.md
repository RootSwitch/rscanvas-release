# Changelog

## 0.1.0-alpha.3 - 2026-09-28

The third alpha: backup and restore, an uninstall, burn-in guards for the
wall, and the fixes from ten drills run on clean servers before release -
reboots and power loss, a database outage, no internet, a real SNMP agent,
notifications, the live server's surface, SIGTERM, a full disk, sizing, and
a new user's first fifteen minutes. Neither earlier alpha could be built
from its own instructions outside this project's own workstation; this one
can, on Linux or Windows.

### Upgrading

Unpack the bundle over the install and re-run the installer, as `INSTALL.md`
section 4 describes (`sudo tar`, then `sudo ./rscanvas-setup.sh`). There is
no schema change. Take a backup first; `rscanvas-backup.sh` is new in this
bundle. Reload open browser tabs afterwards.

- **Retention on an existing install stays as it was, which was a dry run.**
  After upgrading, the health page turns red once the dry run is keeping
  data past its keep date, and says so. Set `RETENTION_DRY_RUN=0` in
  `/etc/rscanvas/rscanvas.env` and restart the service; the next hourly run
  drops what is past its date. New installs have retention on.
- The installer keeps the database name, ports, service user and directory
  the install already uses. An upgrade with no flags no longer resets them.
- The installer gives PostgreSQL a restart-on-failure policy (a systemd
  drop-in), so it returns by itself after a full disk is cleared.

### New

- **Backup and restore**: `rscanvas-backup.sh`, beside the installer. One
  file holds the database and `/etc/rscanvas` (with `RSCANVAS_SECRET`, without
  which stored SNMP credentials cannot be read), taken while the service
  runs. Raw samples and messages are left out unless `--full`; the hourly
  rollup always travels. Every table is counted inside the snapshot the dump
  comes from, and the dump is refused if it does not match. `--test` proves
  a backup restores without touching anything live. `--restore` sets the
  current database and configuration aside rather than deleting them,
  compares the restore row for row, and re-runs the installer. Drilled
  across two machines; INSTALL.md section 5 has the procedure.
- **Uninstall**: `rscanvas-setup.sh --uninstall` removes the service, the
  application, node's port capability and the kernel buffer setting, and
  keeps the database, its roles, `/etc/rscanvas` and the service account, so
  installing again resumes where it left off. `--uninstall --purge` removes
  those too, after you type the database name. Neither touches backups or
  the shared packages. The application directory is removed only if it
  holds an RSCanvas install and is not a git checkout. INSTALL.md section 6.

- **Burn-in guards on the wall**, both in its settings panel and both as
  address-bar parameters under the Canvas Suite kiosk's names, so a kiosk URL
  carries across:
  - **Theme rotation** (`?themes=`, `?themeInterval=`, `?themeOrder=`), which
    existed but only for someone who knew the parameters. Rotate every theme
    or one group (Paper, Warm, Cool, Night, Screen), in order or shuffled,
    every 1 to 60 minutes; 5 minutes unless told otherwise. A mixed list
    such as `?themes=night,blueprint` works item by item.
  - **Screen shift** (`?shift=`, `?shiftInterval=`): every few minutes the
    whole wall jumps to a random offset within a few pixels, so tile
    outlines and the header's edge never sit on the same line of pixels for
    long. A margin that wide is kept clear, so nothing is ever cut off. Off
    unless asked; with it off the wall renders exactly as before.

### Fixed

- **A second agent on the same address could not be added.** The probe
  table called a host "already known" when any device had its address,
  whatever the port, and greyed the row out: 198.18.50.2 on port 16100 went
  in, and 16101 on the same address could not. A device is now its address
  and port together. The same table also called a device "already known"
  when another address already used the name it reports; it now says
  "name taken", names the device that owns it, and takes a name of its own.
  Found in the operator's first-15-minutes walkthrough of this release.
- **The install steps extracted the bundle without `sudo`** into the
  directory the step before had created as root, so the documented command
  failed. INSTALL.md, the README, the installer's own hint and the bundle
  builder's printout now all say `sudo tar`.
- **Retention never deleted anything on an installed box.** The application
  defaults to a dry run, and the installer never turned it off: every box
  installed the documented way kept everything and would have grown until
  its disk was full, with the health page green. New installs now get
  retention on (raw samples 14 days, messages 30, the hourly rollup kept).
  Existing installs keep their setting. The health page now turns red when a
  dry run is keeping data past its keep date, and says how to switch it.
- **A database outage was invisible to monitoring.** With PostgreSQL stopped
  for three minutes, `/api/health/work`, the status a monitor polls, answered
  200 throughout, because the collector was still polling on time. It now
  answers 503 once the database has refused the alert scan, or ingest's
  writes, for a minute, and says for how long, why, and how many messages
  are held.
- **Upgrades and restores on an air-gapped box looked hung.** Re-running
  the installer always refreshed the package lists; where outbound traffic
  is silently dropped, that sat for over three minutes with no output before
  carrying on. When everything it needs is already installed, the installer
  no longer contacts the package mirrors at all: an offline upgrade took 10
  seconds, and an offline backup and restore 11.
- **Traps lost their identity, and their device.** Drilled with a real
  net-snmp agent sending to an installed box:
  - A v1 trap was stored as its varbinds alone, without the enterprise,
    generic and specific numbers that say which trap it is, so no rule could
    tell a UPS's "on battery" from its "battery restored". They are kept now.
  - Standard traps are named (linkDown, coldStart and so on), with their
    trap OID, and a v1 trap carries the same OID as its v2 equivalent.
  - A trap's alert was attached to its bare source address, so the device's
    maintenance window, mute and notify policy did not apply to it. It now
    belongs to the device at that address.
  - The varbinds follow as before, so existing rules still match. An open
    trap alert keyed by address will age out, and the next one is keyed by
    the device.
- **RFC 5424 syslog from rsyslog kept a leading space** in every message,
  so a rule anchored at the start matched a line forwarded one way and not
  the other.
- **A wrong v2c community read only "Request timed out"**, the same as a
  dead device. The message now says it also fits a wrong community, as the
  SNMPv3 messages already did for keys. Changing a device's credential was
  also drilled live, wrong and back: down within one poll, up at the next.
- **INSTALL.md now says what hardware to use, measured.** A 4-vCPU, 4 GB
  virtual machine polled the full 30,000-entity test fleet with most of its
  CPU and memory to spare. Disk is what to size, and the guide gives the
  cost of each kind of data.
- **After a full disk, PostgreSQL stayed down until someone started it.**
  With the disk full, PostgreSQL stops, correctly, and RSCanvas holds
  incoming messages in memory. But freeing the space brought nothing back:
  the distribution's unit does not restart it. The installer now gives it a
  restart-on-failure policy, and it came back by itself within 10 seconds
  of the space returning. Uninstall removes the policy.
- **A brand-new install showed red health for its first hour**, because
  the hourly rollup cannot run before the first complete hour. It is green
  until the first pass is due.
- **A malformed request could rewrite a board.** Three board settings routes
  read a body they could not parse as an empty one, and acted on it: a
  truncated request turned a glance-grid board into a drawn one and erased
  the group it was generated from. Every route now refuses a body it cannot
  read. Found by a new sweep of the live server (`tools/live-surface.mjs`),
  which also fixed:
  - a NUL character in a parameter or body, and a numeric id too large for
    the database, each answering 500 instead of 400/404;
  - a fractional `history` count reaching the database as a query limit;
  - log export checking its parameters before checking you may export, so
    a signed-out caller learned which parameters it wanted.

  Signed out, every route now answers 401 or 403, apart from the five
  documented public ones.
- **A notification channel could fail every delivery with health green.**
  Email pointed at a relay that could not do the STARTTLS it requires
  refused every alert (correctly: it never falls back to plaintext), and the
  health status stayed ok. After three failures in a row the health page now
  turns red, naming the channel and when it last delivered.
- **The device-down alert said "unreachable or powered off"** of a box that
  still answered ping, and used "status feed", a term from Canvas Suite.
  It now says the device is not answering SNMP polls, and how the ping
  column tells a dead agent from a dead box.
- **A database outage flooded the log.** Ingest kept every message through
  the outage and wrote them all within seconds of the database returning,
  but it retried once per arriving message and logged each failure: 8,701
  lines in three minutes. Retries now back off to one every 2 seconds, and
  the log says so a handful of times and once more when it recovers.
- **Building a bundle from the repository, as INSTALL.md described it, did
  not work** for anyone outside this project's own Windows workstation. Found
  by building both public alphas the documented way on a Linux machine and
  in a fresh Windows clone, then trying the bundles on a clean server:
  - The dependency step was missing: a fresh clone has no `node_modules`,
    the build failed at the archive step and left a partial file with the
    bundle's name. INSTALL.md now says `npm ci` first, and the builder says
    so itself.
  - On Linux the builder's own verification failed every bundle: a pipe
    check reported every file missing once the file list outgrew the pipe.
  - Git for Windows' default settings gave a fresh clone Windows line
    endings, and the installer built from it failed on Linux with
    `'bash\r': No such file or directory`, even though the build had
    passed. The repository now pins Unix line endings, and the builder
    refuses a script that has Windows ones.
  - The installer arrived non-executable from a Linux clone (see below),
    and the bundle's manifest readable only by root.
- **Upgrading was drilled from 0.1.0-alpha.1 through alpha.2 to this
  release** on a clean server, the way INSTALL.md describes it. Every
  setting, account, device, board and display token came through exactly,
  and no table lost a row.
- **Re-running the installer forgot the flags it was installed with.** An
  upgrade as INSTALL.md describes it (no flags) reset `--db`, `--http-port`,
  `--high-ports` and `--user` to their defaults: a box installed with `--db`
  came back healthy on a new, empty database. They are now kept from the
  existing install unless given again, as `--tls` already was.
- **The installer was not executable in git**, so a bundle built from a
  Linux clone would have answered `sudo ./rscanvas-setup.sh` with "command
  not found". The bundle builder now refuses a bundle where it is not.
- **The wall's "NOT UPDATING" banner was hidden behind the tiles** on glance
  grid boards: the first row painted over it and only slivers of red showed.
  It now sits above the board, as does the "shapes pulled in" note. The
  wall's window title now reads "RSCanvas Wall".
- **The wall no longer overwrites the app's saved theme** in the browser it
  runs in. A rotating wall used to save each palette in turn, so the next
  person to open the app on that machine inherited whatever the wall showed.

## 0.1.0-alpha.2 - 2026-09-26

The second alpha: the collector's stalls at the design ceiling found and
fixed, syslog and trap ingest measured and raised, and a round of the
operator's own usability requests, including a Dashboard.

### New

- **Dashboard**, the page every sign-in lands on: open alerts first (active,
  pending and clearing), then the top 10 interfaces by traffic received and
  sent and by errors and discards, and the top 10 CPU and memory, over 6
  hours, 24 hours or 7 days. Each row shows its change against the window
  before, per hour of data on each side, and opens the device on that
  interface's or sensor's chart.
- **Interface traffic report**: pick interfaces from any devices and a period
  in your own time zone; get GB in and out per day, the peak each way, and
  the share of each day the samples covered, with a total per interface - on
  the page or as CSV. Checked against the raw samples: 0.011% apart.
- **Device mute**: nothing on a muted device raises - down, interfaces,
  sensors - from its page or for a selection on the device list. Operators
  and admins can mute.
- **Per-interface mute**, and the rule that governs each interface shown on
  its row.
- **Controls follow the role.** The page asks the server what the signed-in
  role may do and shows only those controls: viewers no longer meet forms
  the server refuses, and operators get the ones they were always allowed.
- **My account**: everyone can change their own password (the current one
  is required; your other sessions are signed out). Click your name.
- **Device page**: transient and muted as badges beside the name, location
  and application on the same line, and the edit controls folded behind
  Modify. Ping-only devices open on their latency chart.
- **Device list**: a sensors column beside interfaces (each counts only what
  its header says), and a transient device reads "transient" in its status,
  green present and red away.
- **System tab**: every section folds to its header, keeping its summary.
  The syslog and trap alert rules moved here, named for what they do, and
  operators can read them.
- **Logs** opens on the 50 newest messages until you search.
- The Canvas Suite mark as the favicon and header logo, with a real
  `favicon.ico` so Firefox shows it too.

### Fixed

- **The collector thread's stalls at 30,000 entities.** Database rows went to
  the socket one at a time, two writes each, and a timing summary was sorted
  four times a second; the health page read red at the design ceiling. Now
  under one stall in five minutes, health green. Garbage collection was
  measured and ruled out.
- **Ingest throughput.** Message rows had the same one-at-a-time shape; in
  64 KB chunks the lab box takes about 16,400 syslog or 13,700 trap messages a
  second, a fifth more, and the ingest thread no longer stalls under load.
- **Kernel drops under load.** The installer now persists a 16 MB UDP receive
  buffer cap, and the trap socket is sized like the syslog one; without them
  a burst was dropped by the kernel before the application saw it.
- **Message text was trigram-indexed twice**, which cost about a fifth of
  the write ceiling and 108 bytes a message. The duplicate is dropped on
  upgrade.
- **A flush timer firing during a running flush** could leave the last rows
  of a burst in memory until more traffic arrived.
- **Upgrading a TLS install** by the documented steps locked the service out
  of its own certificate.
- **Two devices onboarded at once** could race for the same short code.
- **Table rows out of line** wherever a badge sat beside other content in a
  cell (the device list's transient rows among them).
- **Chart and back navigation**: a chart no longer follows you to the next
  device, and Back sits beside Add device.
- nodemailer 9.1.1 (a high-severity advisory), and the bundle's audit step
  now refuses a bundle with one instead of reading it as "offline".

### Upgrading

Unpack the bundle over the install and re-run `rscanvas-setup.sh`, as
`INSTALL.md` describes. The schema step adds one column and, with the
installer's `--with-retention`, drops the duplicate index (under a 10-second
lock timeout, so it waits rather than stalls ingest). Reload open browser
tabs afterwards.

## 0.1.0-alpha.1 - 2026-09-15

The first public alpha.
