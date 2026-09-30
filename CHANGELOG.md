# Changelog

## 0.1.0-alpha.4 - 2026-09-30

The fourth alpha: group alerts, device health on the Dashboard, and IPMI
hardware traps decoded, with the fixes from two days of running the third on
a real network and on the 30,000-entity lab. Interfaces were recorded that
nobody tracked while tracked ones of other types were never read, the poll
schedule ran a second late every cycle, a board's catch-up buttons had never
worked, and the pages' cost at scale was measured and cut.

### Upgrading

Unpack the bundle over the install and re-run the installer, as `INSTALL.md`
section 4 describes. Take a backup first with `rscanvas-backup.sh`, and
reload open browser tabs afterwards.

- **Two schema changes**, both applied by the installer: a table for group
  alert rules, and a column holding each device's poll schedule.
- **Untracked interfaces stop recording history.** What they recorded
  before ages out with retention, and the page no longer shows it. If you
  relied on one's history, track it on its device page.
- **Tracked interfaces that are not Ethernet or link aggregates start
  recording** - a Wi-Fi adapter, a tunnel, a VLAN interface someone ticked
  and that was never actually read. Untrack any you do not want.
- **The Boards panel no longer shows the controls for hand-placed
  layouts.** `BOARDS_MANUAL_LAYOUT=1` in `/etc/rscanvas/rscanvas.env`, and
  a service restart, brings them back; a board already drawn by hand renders
  either way.
- **Syslog from a sender that names no host now carries the device's
  name**, so an event rule matching `host:` can start matching messages it
  never saw a host on before.

### New

- **Boards are laid out from the start, and the Boards panel shows only
  that.** Generate makes a board from a group that already fits each
  display's screen; it used to arrive as a set of coordinates waiting for
  someone to find the grid setting. The controls for hand-placed layouts -
  the CrossCanvas layout export and import, empty boards, and drawing from
  coordinates - are off the panel. They are kept, not deleted:
  `BOARDS_MANUAL_LAYOUT=1` in the environment file brings them back, and a
  board already drawn by hand still renders either way.
- **Group alerts.** Tick a location or application on the System tab's
  Group alerts panel, and when enough of its devices are down at once it
  raises one alert instead of an email per device. Each group has a percent
  (of its devices whose status is known) and a minimum count, 50% and 3
  unless changed, so a small group cannot trip on one failure. The
  devices' own alerts still raise and show on the Alerts page and the wall,
  marked "held - group alert"; only their emails wait. The group's email
  names the devices that are down, and any still down when the group
  recovers are emailed then. A maintenance window or notify policy on the
  location or application holds its group alert too. Transient and muted
  devices are not counted. Off for every group until ticked.
- **Device health on the Dashboard.** Between the alerts and the top 10,
  every location and every application with its devices up and down, so
  the Dashboard says how the whole environment stands at a glance.
  Transient devices are left out, pending ones are counted rather than
  dropped, and devices with no location or application are a group of
  their own. The counts use the same status the device list shows and are
  taken on the server, so they stay right past the device list's 5,000-row
  page. Up counts are green and down counts red when not zero. A row opens
  the device list on that group; a down count opens just the ones that are
  down.
- **`location:NAME` and `application:NAME`** in the device list's filter
  match one group exactly (a plain word still matches names, addresses and
  groups by substring). `location:` alone lists the devices with none set.
- **`transient:` and `muted:`** in the same filter list the devices declared
  so, and `transient:no` and `muted:no` the rest - the overview those two
  declarations lacked, when each showed only on its own row. They combine
  with a word or a group: `muted: PAM`, `transient: location:Lab`.
- **IPMI Platform Event Traps are decoded.** A BMC reports a hardware event
  (a fan below its threshold, a power supply failing, a chassis opened) as
  a trap whose meaning is packed into its specific-trap number and one
  binary varbind, which was stored as a hex string no one could read or
  write a rule for. It is now stored as what happened (sensor type and
  event, asserted or deasserted, severity), where (sensor, entity), the raw
  reading and threshold, and when by the BMC's clock, ahead of the trap
  header and varbinds as before. Its severity becomes the message's. Two
  departures from the specification seen on real BMCs are handled and said:
  a manufacturer ID sent low byte first, and a timestamp written as Unix
  time.

### Fixed

- **Devices are polled on their interval, not a second later each time.**
  A device was due one interval after its last poll finished, so every
  cycle added the poll's own length and the wait for the next scheduling
  tick: a 30-second device was polled every 31 seconds, 3% fewer readings
  than configured, and a traffic report showed 97% coverage for an
  interface that answered every poll. The schedule now steps by exactly the
  interval from when each poll was due. A poll that starts well behind
  schedule (after a restart, or a backlog) starts a fresh schedule instead
  of catching up in a burst. This release adds one column to the devices
  table; the installer applies it.
- **The device page says where its lists stop, and lists interfaces in
  order.** The interface table stopped at 100 rows while its heading counted
  them all, and nothing said so; it now says "showing the first 100 of 260"
  and points at the filter. Interfaces were listed 1, 10, 11 ... 19, 2, 20 on
  any device with ten or more; they are in number order now, and a device
  past the server's 500-entity limit says that too instead of being counted
  short. A device's open alerts show the ten worst, with a button to the
  rest on the Alerts page: a site outage used to put forty rows between the
  device's name and its interfaces. In a narrow window a wide table scrolls
  in its own box instead of carrying the whole panel sideways.
- **The alert list and the device roster are sent gzipped.** At 30,000
  entities each was about 1.4 MB, sent as it was every 10 seconds to every
  page showing it; gzipped they are about 60 and 80 KB, a twentieth, which
  matters over Wi-Fi or a VPN. The compression runs off the thread that
  serves the pages, so it costs that thread 2-3 ms. Short answers and
  clients that do not ask for gzip get plain JSON as before.
- **Untracked interfaces were recorded anyway.** Tracking decides which
  interfaces keep a history, and the poller never checked it: every
  interface of an Ethernet or link-aggregate type wrote a sample on every
  poll, tracked or not. On a 37-device network that was 232 untracked
  interfaces against 104 tracked, about 40% of all the rows written, and an
  access point's untracked virtual radio reached the Dashboard's top errors
  with a chart its own device page would not open. Untracked interfaces now
  write no history. Their counters and current state still update, so
  tracking one later starts from a correct first reading. A device with no
  tracked interface at all keeps one row per poll carrying its response
  time, so its response-time chart survives. The Dashboard ranks tracked
  interfaces only, which also hides what was already stored; the raw
  samples age out with retention.
- **Tracking a Wi-Fi adapter or a tunnel recorded nothing.** The poller read
  only the interface types discovery tracks by default (Ethernet and link
  aggregates) and skipped every other one even after someone ticked it: the
  tick was saved and nothing else happened. On a production network two
  laptops' Wi-Fi and a firewall's three OpenVPN interfaces had been tracked
  for a week without one reading. A tracked interface is now read whatever
  its type, and followed like any other when the agent renumbers it. A
  Wi-Fi adapter's speed moves with its signal, so its utilization is
  measured against a moving speed; its traffic and error counts are not
  affected.
- **An open page cost the server time whether or not anyone was looking at
  it.** Every 10 seconds, every open tab fetched the whole alert list and
  device roster - about 1.4 MB each on a 30,000-entity network, and 50-60 ms
  each of the thread that serves the pages - even on the System or Logs tab,
  and even in the background. Now each is fetched every 10 seconds only
  while a view that shows it is open, and once a minute otherwise (other
  views read them too); a tab in the background fetches nothing until it is
  looked at again, and then catches up at once.
- **The wide layout followed you to every tab with no sign of it.** Turned
  on in the Devices columns panel, it widened every page, and the only way
  back was that panel. A Width switch now sits beside Theme at the top right
  of every page; the checkbox in the columns panel is the same setting.
- **The Devices status column is centred**, so a "transient" badge and an
  "up" badge line up on their middles instead of reading ragged.
- **A power sensor's card showed a bare number** - a GPU drawing 287 W read
  "287.0". It says watts now, as its alerts always did.
- **Switching the Dashboard between 6 hours, 24 hours and 7 days was slow**
  on a large network: 1.1 seconds for a day and 3 seconds for a week at
  30,000 entities, on nearly every switch. The lists can only change when
  the hourly rollup moves, but the answer was thrown away after a minute.
  It is now kept until the rollup moves, and once anyone has opened the
  Dashboard the other windows are computed in the background, and again
  after each rollup - so a switch takes a few milliseconds. The first open
  after a restart still computes its window.
- **The Alerts list took most of a second to fetch at scale**, on every
  10-second refresh of every open page: 850 ms with 1,958 open alerts at
  30,000 entities. PostgreSQL was compiling the query to machine code (its
  JIT) for 730 ms to run it in 24 ms, because checks for maintenance
  windows, notify policies and group alerts made the query look expensive
  to the planner. It now answers in about 60 ms. JIT is turned off for the
  connections that run short, frequent queries (the page, alerting,
  notifications, polling, ingest) and left on for the Dashboard, reports
  and the hourly rollup, which measured faster with it. The same compile
  cost was hitting the notification queues at that scale, and would have
  eventually made the Alerts page time out as alerts grew.
- **A board's add, drop and rebuild buttons never worked.** The boards
  list has shown drift (devices missing from a group board, or moved away)
  with a button for each fix since 0.1.0-alpha.1, and every one answered
  "not found": the page sent its request as a GET with no body, and the
  route only answers a POST. The server side was right all along. A new
  check refuses that mistake anywhere in the page. Found adding three
  ping-only devices to a network with an all-devices board.
- **nodemailer 10.0.12**, from 9.1.1, for a moderate advisory
  (GHSA-6vj9-mwq6-2f5v: a process-wide DNS cache reusing one mail server's
  TLS name for another; RSCanvas talks to one relay, so it was not exposed).
  The new version also stops a bare CR ending a message early at a
  receiver that reads it as a line end (SMTP smuggling). Email was drilled
  again in every security mode against a real server before release.
- **A binary trap varbind was stored as mangled text** in the message's raw
  record. It is kept as hex, as the message text always showed it.
- **Syslog from a sender that names no host was nobody's.** A MikroTik with
  its remote logging action at the default sends bare text with no syslog
  header, so its messages were stored with an empty host: the Logs page's
  host column was blank, `host:` could not find them, and an event rule
  firing on one raised its alert against the bare address, outside the
  device's maintenance window, mute and notify policy. A message that names
  no host now takes the name of the device at its source address, when
  exactly one device has it, as traps do since 0.1.0-alpha.3. A message
  that names its host keeps it.

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
