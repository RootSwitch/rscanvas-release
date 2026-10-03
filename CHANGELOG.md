# Changelog

## 0.1.0-alpha.6 - 2026-10-03

The sixth alpha. Every earlier installer wrote both database passwords into
the system's logs, on every install and upgrade; this one does not, and
`rscanvas-setup.sh --rotate-db-passwords` makes the copies already written
worthless. The health page stops holding one stall against the service
until a restart. Adding a device now asks whether to track all its ports or
only those up, and whether link-down alerts start on or manual - so a switch
with idle ports no longer raises an alert per idle port. Rediscover clears
sensors whose hardware has left, and their history opens without tracking
them again. The rest of the outside review's smaller findings are fixed.
All of it was drilled on a factory-fresh VM, installed from a bundle built
out of the public tree on a fresh Linux clone.

### Upgrading

Unpack the bundle over the install and re-run the installer, as `INSTALL.md`
section 4 describes. Take a backup first with `rscanvas-backup.sh`, and
reload open browser tabs afterwards. There is no schema change.

- **Then change the database passwords**, once, on any install made before
  this release: `sudo ./rscanvas-setup.sh --rotate-db-passwords`. The old
  ones are in `/var/log/auth.log` and the journal until those rotate. The
  service restarts once; nothing else changes. A backup taken before the
  rotation brings the old passwords back if restored - rotate again after.
- **A stall now shows on the health page for fifteen minutes and clears.**
  A VM paused by its host's nightly backup reads red for a quarter of an
  hour after each pause, where it used to stay red until a restart.
- **Adding a device asks two things**: track all ports or only those up,
  and link-down alerts on or manual. The defaults are what adding did
  before; the add step remembers your last choice per browser.
- **Rediscover untracks a sensor the agent no longer serves** and that has
  no reading - a GPU's fan after the card was swapped, say. Its history
  stays and its chart still opens.
- **The installer refuses flags it used to take**: `--user` naming an
  account that can log in (or root), `--db postgres`, `--dir /` and the
  like, and a `--http-port` outside 1-65535 - before changing anything.
  An install that already uses its own account is unaffected.
- **`--uninstall --purge` keeps databases that only look like its copies**
  and says so; it drops `<db>`, `<db>_restore_test` and
  `<db>_pre_restore_<stamp>` alone.
- **Scripts calling the API**: the traffic report takes IANA zone names
  only (`tz=+05` is refused - use `Etc/GMT-5`), an empty search parameter
  means no filter, and `facility` and `severityAtMost` must be on their
  scales.
- **Log lines escape control characters** (`\n`, `\u001b`) inside the line,
  and a device that stays down is logged when it fails and then about
  hourly, not every poll.

### New

- **Choose what a new device tracks and alerts on.** Adding a device used
  to track every ethernet port and alert on every one that was enabled but
  not linked, so a 48-port switch with idle ports raised a critical alert
  per idle port on its first scans. The add step now asks two things for
  the batch: track all ports or only those up now (the report shows "48
  (12 up)" beside the interface count to choose against), and link-down
  alerts on, or manual. Manual writes one device-wide link-down mute; each
  port is then turned on from its row on the device page ("alert on"),
  which outranks the device's setting, and the device's Modify block
  switches it back. Errors,
  discards and utilization are unaffected. An add that names neither gets
  today's behaviour, and a value that is neither choice is refused. An
  existing device can be made manual from Modify the same way.
- **Rediscover untracks sensors the agent no longer serves.** It only
  ever added, so a sensor whose hardware left - a GPU's fan after the card
  was swapped - stayed tracked with no reading forever. A sensor is now
  untracked when the probe no longer lists it AND its poll has no reading;
  both, because sensor discovery skips a section silently when a walk
  fails, and absence alone would let one flaky answer untrack live
  sensors. One that is unlisted but still reads is named and left alone.
  The report and the audit name each one, the history stays, and a tick on
  the device page undoes it. Plain Rediscover does this; "Rediscover +
  reset tracking" is not needed.
- **An untracked sensor or interface opens its history chart.** Only
  tracked ones did, so reading the history of a sensor whose hardware left
  meant tracking it again - which also restarted polling something that is
  not there. Its chart now opens, saying "not watched now: recorded while
  it was", or that nothing was recorded in the range.
- **A link-down override can be "on".** The alert-rule route refused an
  enabled override with no levels, which left the engine's per-port
  enable unreachable for the two yes/no rules (link down, device down);
  it now accepts one, and refuses levels for them instead of storing
  numbers the engine ignores.

### Security

- **The installer no longer writes the database passwords into the
  system's logs.** It set the two role passwords with `psql -c "...
  PASSWORD '...'"` and ran the schema step as `sudo env
  DATABASE_URL=postgres://rscanvas_admin:<password>@...`, so both
  passwords were on a command line - in `ps` while it ran, and in sudo's
  log (`auth.log` and the journal) on every install and upgrade. The
  passwords now go to psql on stdin as a quoted variable, and the admin URL
  in the environment (review F18). Lines written by earlier runs stay until
  the logs rotate; `rscanvas-setup.sh --rotate-db-passwords` (below) makes
  them dead text.
- **`rscanvas-setup.sh --rotate-db-passwords`** gives the `rscanvas` and
  `rscanvas_admin` roles new random passwords, writes them to the env file
  (both password keys and `DATABASE_URL`), proves each logs in, restarts the
  service and waits for `/api/health/work` - nothing else changes. If
  PostgreSQL refuses either change, the roles and the env file are put back
  as they were. Run it once after upgrading an install made before this
  release (INSTALL.md, section 4).
- **`--uninstall --purge` drops only the databases it made, by exact name**
  (review L11). It matched set-aside copies by prefix and split the list on
  spaces, so on a shared PostgreSQL server a database named
  `rscanvas_pre_restore_x postgres` would have dropped `postgres`. Only the
  backup tool's own names (`_restore_test`, `_pre_restore_<stamp>`) are taken
  now, walked as an array; set-aside config directories likewise.
- **The installer checks its flags before changing anything** (review L10).
  `--db` reached SQL as typed; `--dir /` was refused only after packages
  and the kernel setting had changed; and `--user` named any existing
  account - `--user root` would have moved root's home to
  `/var/lib/rscanvas` and run the service as root. Each is refused up front.
- **One log line per log call** (review L9). Device strings - an interface
  name, an agent's error text - could carry a line break into the log and
  forge the next line; every log helper now escapes control characters
  (`\n`, `\u001b`) on the line they belong to.
- **Confirm dialogs show names on one line** (review L7). Board, device and
  credential names were interpolated raw into "are you sure?" dialogs, so
  embedded line breaks could rewrite what an admin agreed to.

### Fixed

- **Signed-in sessions stay signed in** (review L1). The session's
  database row slid its expiry on use but the browser cookie kept the
  30-day Max-Age it got at sign-in, so a daily user was signed out every
  month. The cookie is re-sent whenever the row slides.
- **The page keeps rendering on a slow server** (review L4). Each 10-second
  refresh superseded the one still loading, so a server slower than that
  rendered nothing and took a fresh set of requests every tick. The timer
  now waits for its own round (up to a minute); actions still refresh at
  once.
- **`rscanvas-backup.sh --out` leaves an existing directory's mode alone**
  (review L12). It set 0700 on whatever it was given, so `--out /tmp`
  removed /tmp's sticky bit.
- **Search inputs that passed checks and then failed in the database**
  (review L16): `sev:<=99999` and out-of-range facilities are search text,
  `ip:10.0.0.0/0x18` and other non-decimal prefix lengths do not parse, and
  an empty `sourceIp=` or `facility=` means no filter instead of a 500 or
  facility 0.
- **The traffic report refuses bare UTC offsets** (review L17). `+05` was
  accepted and PostgreSQL reads it as a POSIX zone, west of UTC - days
  summed ten hours off. IANA names only.
- **A device that stays down is not re-logged every poll.** The failure log
  was limited per error kind, fleet-wide, every 30 s - the poll interval -
  so one switched-off transient device logged 2,300 lines a day. A device's
  first failed poll is logged, then a reminder about hourly while it lasts.

- **"credential profiles loaded" is logged when it changes**, not on every
  30-second reload - 2,880 identical lines a day on production. The first
  load and any change (a profile turning undecryptable among them) are
  still logged.

- **One stall no longer holds health red until a restart.** The heartbeat
  verdict read each thread's worst gap since the service started, and a
  maximum never falls: on production the VM host's 06:00 backup held every
  poll up to 2.2 s, and the health page said "stalled" from then until the
  next restart, every morning after one. The verdict now reads the last 15
  minutes, both the single-stall bound (500 ms) and the sustained rate
  (0.1% of ticks); the rate since start also hid a bad day after weeks of
  uptime. The health page shows the 15-minute worst beside the worst since
  start, which keeps its time, and `/metrics` gains
  `rscanvas_heartbeat_recent_worst_gap_ms`
  (`tools/test-heartbeat-window.ts`).

### Documentation

- INSTALL.md names the settings read outside `src/config.ts` (review D5),
  instead of claiming every one is listed there.
- The public tree no longer reads "the the operator workstation" where the
  source said "the" before a host name (review P4).
- The System screenshot shows the health table as it is now: the worst gap
  in the last 15 minutes beside the worst since start, and when.

## 0.1.0-alpha.5 - 2026-10-01

The fifth alpha, and a security release. An outside review of the fourth
found three ways for one packet or one request to stop the service - an
SNMP Inform to the trap port, a crafted answer from any polled device, a
malformed web request - and a backup that could become root on the box
that restored it, along with a list of smaller holes; all of them are
fixed here, each with a test that fails without its fix. The service now
runs in a systemd sandbox with code it cannot change. And the first
retention drop on the 30,000-entity lab found that syslog would never have
been expired at all.

### Upgrading

Unpack the bundle over the install and re-run the installer, as `INSTALL.md`
section 4 describes. Take a backup first with `rscanvas-backup.sh`, and
reload open browser tabs afterwards. There is no schema change; the
installer replaces the retention function.

- **The layout changes, and the installer makes the change.**
  `/opt/rscanvas` becomes root's and the service can no longer write it;
  exports move to `/var/lib/rscanvas/exports` (an `EXPORT_SPOOL_DIR` you set
  yourself is kept), and any export files left in `/opt/rscanvas/data` are
  removed - they were unreachable after a restart anyway. The service
  account's home moves to `/var/lib/rscanvas`.
- **The service runs in a sandbox.** If you added anything to the systemd
  unit by hand, it is rewritten as before; check that a program you run
  from the service, if any, still works with a read-only filesystem.
- **`node` loses the port capability an earlier installer gave it.** The
  unit grants it to the service alone. Anything else on the box that ran
  node on a port below 1024 needs its own arrangement.
- **`BIND_ADDRESS`, if you set it, now binds the web port and traps too**,
  not only syslog.
- **Event rules with two `.*` (or `.+`) in a row are refused** - at
  creation, and an existing one when the rules load, which the log names.
  Keep one wildcard, or split the rule in two.
- **Accounts lock as well as addresses**: five failed sign-ins lock the
  account for a minute, doubling to fifteen.
- **More than 60 alerts at once on a channel** are sent together as one
  message a minute rather than one each.
- **Wall links minted from now on carry the token after `#`.** Displays
  already pointed at a `?token=` link keep working.

### Security

From the 2026-09-30 review. Each fix lands with a regression test that fails
without it.

- **One UDP datagram to the trap port stopped the process.** An SNMP Inform
  carrying a BIT STRING, or an INTEGER outside 32 bits, decoded fine and then
  threw when the SNMP library re-encoded it as the acknowledgement - outside
  its own error handling, so the ingest worker died and the service with it,
  under any community string and from a spoofable source. The trap socket's
  handler is now wrapped; such an Inform is still recorded and only its
  acknowledgement is lost.
- **One SNMP response from any polled v1 or v2c device stopped the
  process.** A device answering a poll - or an onboarding probe - with a
  Report PDU made the SNMP library read v3 security fields a v1/v2c message
  does not have, outside its own error handling, and the collector died and
  the service with it: the weakest device on the watch list could take the
  monitor down. The polling session's socket is now guarded too; such an
  answer is dropped and the poll fails with a reason. A failure not yet
  known still settles its request, which the library would otherwise have
  left waiting for ever. Present in net-snmp up to 3.29.1, the latest.
- **One HTTP request stopped the process.** A `Host` header of `a b`, or a
  request target of `//[`, both accepted by the HTTP parser, threw while the
  request's URL was parsed, before any route's error handling. The URL is
  parsed against a fixed base, and an unparseable target is a 400.
- **SNMPv3 traps were accepted.** With authorization off - the receiver has
  no v3 users - a noAuthNoPriv v3 trap under any user name was delivered,
  and v3 discovery requests were answered. Version 3 is now refused from the
  datagram's first bytes, before it is parsed, as the documentation already
  said. Refused and failed traps are counted and logged at most once a
  minute, with control characters removed: a user name with a line break in
  it had forged a log line.
- **A syslog line could switch off an event rule, or hold ingest for
  seconds.** A rule over its 50 ms budget is disarmed until edited, and
  `.*error` took 54 ms on an 8 KB line, so one line from anyone disarmed
  it; `.*(error|fail).*(timeout|refused).*` took 22.7 s. A leading or
  trailing `.*` - which never changes what a rule matches - is now dropped
  before the rule is compiled, a regex tests at most the first 4,096
  characters of a message, and a pattern with two unbounded wildcards in a
  row (`a.*b.*c`, cubic in the line) is refused when it is created. The
  measured lines now take under 10 ms.
- **A syslog timestamp in year 0 stopped message storage.** It parsed, and
  PostgreSQL refused it, so its 2,000-row batch failed, went back to the
  head of the queue, and nothing was stored until the queue overflowed. A
  message time outside years 1 to 9999 is now no message time, and a batch
  PostgreSQL refuses on its content is written around the refused rows
  rather than retried whole; those rows are counted (`rowsRefused`).
- **One device's value could cost the whole fleet's samples, or stop the
  rollup.** An `ifOperStatus` of 70000 failed the shared sample write for
  every device; a sensor reading of `1e200` made the hourly rollup's average
  overflow, which stopped the rollup and, with it, retention; an absurd
  summary value failed a device's own poll write and showed an answering
  device as down. Values a device reports are now bounded to what their
  columns and the rollup hold before they are written, and statuses to
  their RFC 2863 domains.
- **A backup could give root to whoever could change it.** A manifest value
  reached root's shell arithmetic on `--test`; the configuration archive was
  extracted into `/etc` as root with whatever paths and owners it named; the
  dump was restored, and its tables counted, as the PostgreSQL superuser;
  and a restored environment file's values reached a `sed` program run as
  root. Every manifest line must now have the shape the backup tool writes,
  the configuration archive may hold only plain files under `rscanvas/` and
  is extracted without its owners, the dump is restored and read as the
  installer's `rscanvas_admin` role, the installer writes its environment
  file with `awk` (values as data), and a database password that is not of
  the shape the installer mints stops the installer.
- **A host name could slip past the per-rule event alert cap.** A sender
  naming itself `*|1`, `*|2`, ... made keys that each read as the overflow
  row and opened an alert each. `|`, `*` and `%` in a host are escaped in
  the key, the overflow is one exact key, and the matches waiting for the
  database are bounded too.
- **The service could rewrite scripts that root runs.** The service account
  owned `/opt/rscanvas`, and root runs the installer and the backup tool
  from there, so code execution inside the service - the part that parses
  syslog, traps and SNMP answers from the network - could become root. The
  code is now root's, the service writes only `/var/lib/rscanvas` (where
  exports moved), and the systemd unit is a sandbox: no new privileges, a
  read-only filesystem apart from that directory, private `/tmp` and
  devices, kernel settings out of reach, and two capabilities. The port
  capability is the service's, granted by the unit, instead of being set
  on the system-wide `node`, where every local user's node programs had it
  and a `nodejs` package upgrade silently took it away. Upgrading applies
  all of it; `--check` reports it. Bundles are packed as root's.
- **Nothing limited how many notifications went out.** Each rule caps its
  own alerts, but an outage across many rules - or a flood a sender drives -
  sent one message per alert per channel as fast as they arrived, and mail
  providers throttle well below that. Each channel now sends up to 60 at
  once and then one a second (`ALERT_NOTIFY_BURST`,
  `ALERT_NOTIFY_PER_MINUTE`); anything past that waits and goes out as one
  message a minute listing what is waiting. Nothing is dropped: a waiting
  alert's notification stays owed exactly as an undelivered one does, and
  the System page's notify line says how many are waiting.
- **The application's database role could delete all history and rewrite
  the audit trail.** The retention function's safety limits were arguments
  its caller chose, so the role could ask it, with every limit zeroed, to
  drop every partition; and it could update and delete audit rows. The
  function now enforces its own limits - settings can make retention
  stricter, never looser - the audit trail is append-only for the
  application, and only RSCanvas's own roles may connect to its database.
- **A page on another port or a sibling host could act as a signed-in
  user.** The session cookie's `SameSite=Lax` keeps it off requests from
  another site, but another port on the same box, or another host under the
  same domain, is the same site. A request that changes anything is now
  refused when the browser says it came from anywhere but this page
  (`Sec-Fetch-Site`, or `Origin` from older browsers). Tools that send
  neither, like curl, are unaffected.
- **The sign-in limit could be raced, reset, and sidestepped.** Concurrent
  attempts all passed the check before the first failure counted; a
  successful sign-in cleared its address's count; and only addresses were
  counted, so one account could be guessed at from many. Attempts are now
  reserved before the password is checked, a success clears only its own
  account, IPv6 addresses count by their /64, and each account is counted
  too: five failures lock it for a minute, doubling to fifteen. Changing
  your own password goes through the same limit; it had none.
- **A display's token no longer travels to the server in its URL.** Links
  minted for a wall now carry it after `#`, which the browser keeps to
  itself, instead of `?token=`, which reached proxy logs; a display already
  pointed at a `?token=` link keeps working.
- **`BIND_ADDRESS` bound only the syslog socket.** The web port and the trap
  receiver listened everywhere whatever it said. It now binds all three;
  unset, the web port still listens on every address, IPv6 included.
- **`X-Forwarded-For` was read from the wrong end.** With `TRUST_PROXY=1`
  the client address was the header's first entry, which the client
  chooses even through a proxy that appends; it is now the last, the one
  the proxy wrote, and only when it is an address (junk had been a 500).
- **An `ALERT_SMTP_MODE` typo meant strippable STARTTLS.** `STARTTLS` or
  `ssl` turned off both TLS settings, leaving nodemailer's opportunistic
  upgrade. Case is now ignored, and an unknown value is `starttls` - upgrade
  or fail - with a warning at startup.
- **Smaller:** a malformed `%` escape in a user route was a 500 with a
  stack trace before any check (now 400); device removal read its body
  before authorising (now after); `?theme=constructor` stopped a wall from
  polling; a trap's text had no size limit (now cut like a syslog line);
  and a bundle built from a Linux clone skipped role hardening, because
  `tools/harden-roles.sh` was stored without its executable bit and the
  installer tested for it.

### Documentation

- `RSCANVAS_SECRET` does not sign sessions or tokens, as the README said: it
  encrypts stored credential profiles, and changing it revokes nothing.
- The ports' defaults differ between the installer and a run from source,
  and the README now gives both; `TRUST_PROXY` and `COOKIE_SECURE` are
  documented; the troubleshooting `curl` used a route that needs a session.

### New

- **The installer says where the data lives, and takes the days kept.**
  Before installing anything it reports where PostgreSQL's data is going,
  what that disk holds and how much is free, warns when it is the system
  disk - and on a fresh install, while a data disk can still be mounted
  first, asks once. It prints the days each kind of data is kept with a
  size estimate for them, and `--raw-days` and `--message-days` set those
  days (at least 7; written when given, kept on later runs when not).
  `--check` reports the same.

- **Errors and discards are separate lists on the Dashboard**, each ranked
  and trended on its own, so a link discarding for want of buffers no
  longer hides among links taking bad frames, or the other way round. Six
  top-10 lists now: received, transmitted, errors, discards, CPU, memory.

- **`INGEST_QUEUE_MAX`** sets how many syslog and trap messages may wait in
  memory for the database, 50,000 as before unless set. It is a ceiling,
  not an allocation: the queue fills only during a burst above what the
  database writes, or while the database is down. `INSTALL.md` section 3
  has what a queued message costs, measured (about 770 bytes for a typical
  line), so a site expecting bursts can size it.
- **Operators have the Boards and Thresholds panels** on the System tab,
  which were shown to admins alone although the server has always let
  operators change boards and read thresholds. An operator generates,
  edits, catches up and deletes boards, revokes display tokens, and reads
  every threshold override and default. Minting a display token and
  changing a threshold stay with admins.

### Fixed

- **Syslog retention would never have run.** The samples and messages
  retention jobs fired in the same instant every hour, and the cleanup lets
  one run at a time: messages lost to samples, and its skip reported
  success. Found on the 30,000-entity lab the first night anything was old
  enough to drop - the samples partition went in under a second, the
  messages one stayed. They now take turns. On an install keeping syslog 30
  days, the first syslog drop - the one that would have been skipped, and
  every one after it - is a month after the data began.
- **The docs said a device mute covered its syslog and trap alerts.** It
  never did - a mute silences what the device's polling raises - and now it
  does not by decision: a syslog or trap rule is written on purpose, and a
  BGP peer dropping on a muted router should still be heard. `INSTALL.md`
  and two entries below said otherwise and are corrected.
- **An event rule could open an alert per forged host name.** A syslog
  message's host is whatever its sender says, and an event rule raises one
  alert per host, so a sender that varied the name could open an alert, and
  send a notification, for every name it invented - 500 names were 500
  alerts in a test. A rule now holds at most 20 per-host alerts open
  (`EVENT_ALERT_HOSTS_MAX`); past that, new hosts share one "<rule>: more
  than 20 hosts" alert. Hosts already alerting keep their own, and room
  reopens as they clear.
- **IPMI events say what the BMC said.** A maker's own event types - a
  Supermicro's power-on, its LAN link - decoded as "OEM sensor type 0xc8:
  offset 0". A BMC that sends its own description beside the event now has
  it lead the line ("IPMI: [PWR-0020] First AC Power on"), and a standard
  event quotes it, which names the sensor ("CPU_FAN1"). Every entity the IPMI
  specification names is named now; a sub-chassis printed as a number.
- **An alert could never clear after its threshold was loosened.** An alert
  clears once its reading falls a margin below the threshold it crossed,
  and it kept judging that against the threshold it fired at. Loosen the
  rule mid-incident - an override at 30% deleted so the default 45%
  applies - and a reading of 32%, normal by the new rule, sat inside the
  margin of the old one for good: the alert you changed the threshold to
  silence stayed open, and the way out was to mute the threshold and
  unmute it. It now clears against the more lenient of the two, so it
  clears within the usual few scans. Nothing else changes: with the rule
  unchanged the two are the same line.

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
  device's maintenance window and notify policy. A message that names
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
    maintenance window and notify policy did not apply to it. It now belongs
    to the device at that address.
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
