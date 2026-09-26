# Changelog

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
