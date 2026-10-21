# What RSCanvas watches, and what can alert

Everything RSCanvas collects or tests, the values it keeps, the alerts each can
raise and their shipped defaults, as of 0.1.0-alpha.10 (what that release
added is marked "alpha.10"). Thresholds are changed
per sensor, per kind on one device, or per kind everywhere - from a sensor
card's cog, a port's gear, or the Thresholds list on System - and an override
always beats the default.

Severities are **warn** and **crit**. An alert raises after its condition holds
for 2 scans (a scan runs every 30 s) and clears after 2 normal scans.

## 1. The device itself

| Alert | What it watches | Shipped default | Notes |
|---|---|---|---|
| **Device down** | SNMP devices: polls failing (down after 2 failed polls in a row). Ping-only devices: their reachability probe | crit, on | Never raises for a device marked **transient**; nothing at all raises for a **muted** device. While down, its interface and sensor alerts freeze rather than clear |
| **Restarted** | sysUpTime against the last reading plus the time between, so a restart quicker than a poll is caught; the 497-day wrap is told apart | warn, **off** (turn on per device or for all) | Stays raised 30 minutes and clears without an email. Never for a restart inside a maintenance window (recorded as planned) or a transient device. It is the SNMP agent's uptime, so an agent restart counts too |
| **Collector watchdog** | the newest poll older than 3 poll intervals, or no device ever polled | crit, on | "All quiet" and "not looking" never look the same |
| **Changed** (alpha.10) | its OS, hardware model or boot firmware moving from one value to another | warn, **off** (turn on per device or for all) | Every change is on the device's timeline either way. Stays raised 30 minutes and clears without an email; never inside a maintenance window or for a transient device |

**What it is** (alpha.10): the OS in words from the agent's own
description, read every poll, with a vendor's version where the description
lacks one (MIKROTIK-MIB); the device model from the vendor's own tree
(MikroTik, APC, UniFi, QNAP) or ENTITY-MIB, else the processor model; and a
MikroTik's boot firmware against the one its RouterOS offers. Read daily,
after a restart, and when the description changes.

**Reachability** is probed every 10 s by ICMP ping (or a TCP connect, per
device): up, **degraded** (round trip at or over 150 ms), or down. It drives
device-down for ping-only devices; for SNMP devices it is shown beside the poll
state, and degraded is shown, never alerted.

## 2. Interfaces (IF-MIB, 64-bit counters)

Kept per tracked port: traffic in and out (bits/s), errors in and out (/s),
discards in and out (/s), operational and admin status, speed.

| Alert | Fires when | Shipped default | Clears |
|---|---|---|---|
| **Link down** | admin up and operationally not up | crit, on (or **manual**: only on ports turned on) | on link up |
| **Errors** | the worse direction's error rate | warn 1/s, crit 10/s | below the level |
| **Discards** | the worse direction's discard rate | warn 5/s, crit 50/s | below the level |
| **Utilization** | the busier direction as a share of the port's speed | warn 80%, crit 95% | 5 points under the level |

A speed override replaces the advertised speed. A port measured more than 10%
over its advertised speed has that speed marked untrusted, and its utilization
is suspended rather than computed against a number the agent made up.

## 3. Sensors

| Kind | Where it comes from | Value | Alert | Shipped default | Clears |
|---|---|---|---|---|---|
| **CPU** | HOST-RESOURCES (average of cores); Cisco 5-minute CPU | % | cpu | warn 85, crit 95 | 5 points under |
| **Memory** | HOST-RESOURCES physical memory; Cisco memory pools | % used | mem | warn 85, crit 95 | 3 points under |
| **Filesystem** | HOST-RESOURCES fixed disks (pseudo and noise filesystems left untracked) | % used | disk | warn 85, crit 95 | 3 points under |
| **Temperature** | LM-SENSORS; Cisco ENVMON; MikroTik board and CPU; FS.COM/Ruijie; APC UPS battery and universal I/O probes; NET-SNMP `extend temp-*` | C | temp | **off** (a shipped override row; remove it for warn 45, crit 55 everywhere) | 2 C under |
| **Fan** | MikroTik; FS.COM/Ruijie; `extend fan-*` | rpm | fan (too fast); **fan stopped** (alpha.10) | fan: none. Fan stopped: warn, on - a tracked fan reading 0, two scans in a row. A graphics card's fan is left out by name, since it stops while the card is idle | fan: 200 rpm under; fan stopped: when it turns again |
| **Power** | APC rack PDU; `extend power-*` | W | power | none | - |
| **Load / utilization** | APC UPS output load; `extend util-*` (GPU utilization) | % | util | warn 70, crit 90 | 5 points under |
| **Battery** | APC UPS charge; `extend batt-*` | % | battery (low is bad) | warn 50, crit 20 | 5 points over |
| **Runtime** | APC UPS runtime remaining; `extend runtime-*` | s | runtime (low is bad) | warn 600, crit 300 | - |
| **Voltage** | APC UPS input and output; rack PDU line | V | meter | none | - |
| **Power source** | APC UPS output status; UPS-MIB (RFC 1628) for any other UPS | online / on battery | state | crit on battery (or boost, trim, bypass) | when online |

**Your own numbers**: a NET-SNMP `extend` line whose name starts with `temp-`,
`fan-`, `power-`, `util-`, `batt-` or `runtime-` becomes a sensor of that kind,
tracked as soon as it is discovered - how a GPU's temperature, utilization, fan
and power are published from `nvidia-smi`.

Sensors that read implausibly at discovery (a temperature of 0 or 110 C and
over, a fan at 0 rpm) are listed untracked rather than hidden, one click from
being watched.

## 4. Change from normal (temperatures)

Judged against each sensor's own last week (7 days of hourly means, from 72
hours of history), upward only. On by default.

| Alert | Fires when | Severity |
|---|---|---|
| **One sensor** | its last 20 minutes run more than 3 times its usual spread, and at least 8 C, above its week's median | warn |
| **A room** | in one location, 3 devices (or every device, in a location of 2) each have a sensor more than 3 times its spread, and at least 3 C, above its week for 10 minutes | warn |

Which temperatures take part is read from the name and the device type:
motherboard, network card, spinning disk, memory module, a switch's chip, inlet
and ambient sensors, a UPS's probes. CPUs, GPUs, NVMe drives and chipsets follow
the work, not the room, and take no part unless included on their card. A room's
alert holds its devices' own change alerts while open, and for 20 minutes after.

## 5. Service checks

Each runs on its own interval from RSCanvas and is attached to a device.

| Check | Measures | Alerts | Shipped default |
|---|---|---|---|
| **Web** (http/https) | answer, status code (expected codes configurable), response time, certificate days left; optionally a keyword present or absent, or one JSON field's value | **down** (no answer, refused, DNS, TLS problems, unexpected status) crit; **content** (answered, assertion failed) crit; **response time** warn 2 s, crit 5 s, on two slow runs in a row; **certificate** warn 14 days, crit 7 | all on |
| **TCP** | whether a port accepts a connection, and how fast | **down** crit; **response time** warn 2 s, crit 5 s, on two slow runs in a row | all on |
| **Voice** (to a responder) | loss, jitter each way, MOS | **no answer** warn; **loss** warn 1%, crit 3%; **jitter** warn 30 ms, crit 50 ms; **MOS** warn 3.6, crit 3.1 (low is bad) - on the worse direction | all on |
| **Throughput** (iperf3, to a responder) | Mbps each way | **no answer** warn; **rate** (low is bad) on the slower direction | rate: none until you set one |

A check whose device is down freezes with it; a check with no recent run, or
whose prober failed, freezes rather than reading as up.

## 6. Groups

| Alert | Fires when | Severity |
|---|---|---|
| **Location or application down** (opt-in per group) | at least the set share of its known devices (and at least the minimum count) are down | crit |
| **Outside services** (opt-in) | enough of the checks marked "outside" fail together - what losing RSCanvas's own internet looks like | crit |

While a group alert is open its members' own down emails are held - its email
names them - and a member still down when the group clears is emailed then.

## 7. Logs: syslog and traps

Syslog (UDP) and SNMP traps (v1 and v2c; standard traps and IPMI
Platform Event Traps decoded into words) are kept and searchable. They alert
only through **rules** you write: a text or regular-expression pattern, from
syslog, traps or either, at warn or crit, cleared automatically after a set time
with no new match (at least 60 s; 300 s unless set).

## 8. What decides whether, and when, an alert reaches you

These are not alerts; they shape them.

- **Mute** a device: nothing of it raises (syslog and trap rules still do).
- **Transient** device: off is a state, not a fault - no device-down, no restart alerts.
- **Maintenance windows**, one-off or repeating, on a device, location,
  application or everything: alerts still raise and show "in maintenance";
  nothing is sent until the window closes.
- **Notify policies**: a device, location or application whose alerts never page.
- **Acknowledge** an alert, with a note: stops its reminders.
- **Escalation**: a warn that reaches crit is emailed again.
- **Reminders**: re-sent for a crit still open after a set number of hours (off
  unless `ALERT_RENOTIFY_H` is set).
- **Sending budget**: 60 messages at once, then 60 a minute per channel; past
  it, alerts wait and go out together. Nothing is dropped.
- Channels: email (SMTP), ntfy, and syslog forwarding.

## Gaps worth knowing

- **A fan slowing down is not caught**, only one that stops: a fan's levels
  alarm on a HIGH reading, so a failing fan shows when it stops, or by the
  heat it leaves behind (change from normal).
- **An `extend fan-*` line is tracked even when it reads 0 at discovery**,
  because somebody wrote it on purpose. One that is off when the device is
  added raises a stopped-fan alert at once, unless its name says GPU;
  exclude it on its card if it is built to stop.
- **No default for fan, power, voltage or throughput**: only you know what
  those should read, so they alert once you set a level.
- **Temperature thresholds ship off**; change from normal is on in their place.
