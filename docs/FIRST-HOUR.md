# The first hour

From a fresh install to a few devices watched, alerts reaching you, a wall
on a screen and a backup running. It picks up where INSTALL.md section 2
leaves off: the installer has printed "RSCanvas is up", the admin password
and `RSCANVAS_SECRET`, and you have saved both.

Each step names where it is in the page. Tabs run along the top: Dashboard,
Alerts, Devices, Logs, Reports and System. On System every section folds;
click a heading to open it.

## 1. Sign in and change the password

Open `https://<box>:18080`. The certificate is self-signed, so the browser
warns once. Sign in as `admin` with the printed password, then click your
name at the top right: it opens **My account**, where the password changes.
Your other sessions are signed out when it does.

## 2. Look at System, Health

The Health section opens first. It should read "ok". Under it,
**Notification channels** reads "none set" on a new install: alerts are
raised and shown on the page, and nobody is told until step 7.

## 3. A credential for your devices

**System, Credentials, Create a profile.** Give it a name ("switches-ro"),
a version, and the community or the v3 user and keys. Use a read-only
community: RSCanvas only reads. The secret is stored encrypted under
`RSCANVAS_SECRET` and never shown again; "re-enter secret" replaces it.

The installer also leaves `SNMP_COMMUNITY=public` in
`/etc/rscanvas/rscanvas.env`. It is listed beside your profiles as an
env-named credential, and it is what the add form offers until you pick one.

## 4. Add devices

**Devices, + Add device.**

- **One device:** its IP address, the SNMP version, the port (161 unless
  the agent listens elsewhere), the credential, then **Test & discover**.
  RSCanvas adds a device by its address and does not look names up.
- **Many:** **Bulk add...** takes one address per line, a pasted CSV with
  an `ip` or `address` column, or **Scan** of a subnet, which pings it and
  fills the list with what answered.
- **No SNMP** (a printer, a camera, a phone, an internet address): set
  **monitor by** to ping only, and it is watched for reachability alone.
- **Several agents behind one address** are several devices: probe each
  port on its own.

The probe table lists what answered: its name, interfaces (and how many are
up), sensors, and the location the device reports about itself. Then
choose:

- **Locations:** tick the reported ones to keep, and correct the name in
  "save as" if it needs it. Nothing is applied unless ticked.
- **track:** "all ports", or "active ports only - up now" for a switch
  whose idle access ports you do not want watched. Untracked ports stay on
  the device page, one tick from being watched.
- **link-down alerts:** on for every tracked port, or manual, to turn them
  on port by port.
- **application:** optional, for every device added now.

**Add the selected devices.** A device that did not answer starts unticked;
ticking it adds it anyway (Force Add), and it reads pending until it first
answers.

## 5. The first poll

Within 30 seconds the device list shows each device up, with its tracked
interfaces and sensors counted, and the time of its last poll. Click a
device for its page: its interfaces, its sensors as cards, what it is
(operating system, model), and its timeline. Charts fill as polls land.
The Dashboard's Top 10 and the reports read the hourly rollup, so they
appear once the first full hour has been rolled up.

## 6. Locations and applications

On a device's page, **Modify** sets its location and application. Most of
what follows works by them: the Dashboard's device health, maintenance
windows, notify policies, group alerts, log rules limited to a group, and
boards. A location is where a device is ("HQ", "Branch 2"); an application
is what it serves ("Network", "Servers", "Point of sale").

## 7. Be told

Channels are set in `/etc/rscanvas/rscanvas.env`, followed by
`sudo systemctl restart rscanvas`. Any of the three, or all:

    # email: on once host, from and at least one recipient are set
    ALERT_SMTP_HOST=smtp.example.net
    ALERT_SMTP_PORT=587
    ALERT_SMTP_MODE=starttls        # tls for port 465; none for a plain LAN relay
    ALERT_SMTP_USER=rscanvas@example.net
    ALERT_SMTP_PASSWORD=...
    ALERT_SMTP_FROM=rscanvas@example.net
    ALERT_SMTP_TO=noc@example.net,oncall@example.net

    # ntfy
    ALERT_NTFY_SERVER=https://ntfy.sh
    ALERT_NTFY_TOPIC=your-topic
    ALERT_NTFY_TOKEN=...            # if the topic needs one

    # syslog, to a collector of yours
    ALERT_SYSLOG_HOST=10.0.0.20
    ALERT_SYSLOG_PORT=514

System, Health then lists each channel as set, and after the first message
how it went. A channel with some of its lines missing is called out there as
half set, since it would otherwise send nothing without a word.

To see it work without waiting for a fault: **System, Syslog and trap alert
rules**, add a rule named "test" matching `rscanvas test`, from syslog,
warn, clearing after 60 seconds. Within 30 seconds it is armed. From any
machine:

    logger -n <box> -P 514 rscanvas test

The alert opens on the Dashboard, the message goes out on every channel, and
it clears a minute later. Delete the rule when you are done.

## 8. Logs

Point your devices' syslog and SNMP traps at the box: UDP 514 and 162 (5514
and 15162 with `--high-ports`). **Logs** searches them; the `?` beside the
search box lists the words it understands (`host:`, `ip:`, `sev:`, `proto:trap`
and the rest). Nothing in a log alerts until a rule says so (step 7's form):
a rule hears every sender unless it is limited to one device, location or
application.

## 9. Quiet what should be quiet

docs/WHAT-IT-WATCHES.md lists every alert and its shipped default. In the
first days, a few things usually want a decision:

- **Laptops and PCs that are often off:** mark them **transient** on their
  page. Off is then a state, not a fault.
- **A device you do not want paged about:** **mute** it (nothing of it
  raises), or a **notify policy** on System for a device, location or
  application (alerts show, nothing is sent).
- **Planned work and nightly backups:** a **maintenance window** on System,
  once or repeating. Alerts still show, marked "in maintenance", and nothing
  is sent until the window closes.
- **A threshold that does not fit:** the cog on a sensor's card or a port's
  gear sets it for that one, its kind on that device, or everywhere.

## 10. A wall

**System, Boards and displays, Generate a board from a group:** group by
location or application and name the groups, or tick "every group". Then
**Displays** on its row makes a link for a screen that cannot sign in. Open
it on the screen's browser; whoever has the link sees that board, so treat it
like a password, and revoke it from the same place if it leaks. **View**
opens the board in your own session.

## 11. People

**System, Users.** Three roles:

- **viewer:** reads the Dashboard, devices, alerts, logs and boards, and
  changes nothing but their own password.
- **operator:** shift work - acknowledges alerts, opens maintenance windows,
  mutes, disables and groups devices, edits boards, exports logs.
- **admin:** everything: devices, credentials, rules, users, display links.

## 12. Backups

`rscanvas-backup.sh` takes the database and `/etc/rscanvas` into one file
(INSTALL.md section 5). Prove one restores once:

    sudo /opt/rscanvas/rscanvas-backup.sh
    sudo /opt/rscanvas/rscanvas-backup.sh --test /var/backups/rscanvas/<that file>

Then run it daily, keeping a month, in `/etc/cron.d/rscanvas-backup`:

    15 3 * * * root /opt/rscanvas/rscanvas-backup.sh >/dev/null && find /var/backups/rscanvas -name 'rscanvas-backup-*.tar' -mtime +30 -delete

The files hold the database passwords and `RSCANVAS_SECRET`: copy them off
the box to wherever your other secrets live.

That is the hour. KNOWN-ISSUES.md says what is known not to work yet, and
INSTALL.md section 7 where to look when something is wrong.
