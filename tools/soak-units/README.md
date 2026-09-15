# Supervising the soak instance

Written 2026-08-10, after the run was down for 3.5 hours and nothing said so.

A power outage stopped the lab VM. Postgres came back on reboot because it is
a packaged systemd service; **the app, the mock fleet and the load generator
did not, because nothing supervised them** - they were started detached by
`tools/demo-lab.sh` back on 2026-07-29 and their process died with the box.
The hourly cron kept firing into a dead application, and the stop was found
by accident three hours later.

Two fixes, and they are different in kind. **Both are wanted; neither
substitutes for the other.**

| | what it does | what it cannot do |
|---|---|---|
| these units | bring the instance back automatically | tell you it ever went away |
| `RULE:ingest_stalled` in `soak-check.sh` | announces a two-hour ingest stop | keep the run alive |

## Install

    sudo cp tools/soak-units/*.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now rscanvas-demo.target

Everything runs as `user` from `/home/user/rscanvas`, matching how
`demo-lab.sh` starts them, so the units are a supervision wrapper rather than
a second way of configuring the instance.

## What is deliberately NOT here

**No unit manages the VOLATILE fleet (the 50 devices on ports 16600+),
and this is a boundary, not an omission.** Its lifecycle belongs to
`soak-fault.sh`: the daily fault window KILLS it deliberately to
exercise device-down alerting, and a `Restart=always` unit would
resurrect it within seconds and quietly break the outage test - a
supervisor fighting the experiment. The cost of the boundary, learned
at install time on the lab host: anything that pkills `mock-fleet.js` broadly
takes the volatile fleet down too, systemd restores only the main
fleet, and the gap shows up as exactly 600 stale entities. If entities
freshness reads ~9,5xx/10,125, the volatile fleet is down - run
`bash tools/soak-fault.sh start`, and expect a few minutes of
down-device backoff before the last of them re-polls.

**No unit seeds the database or arms retention.** `demo-lab.sh` does both, and
duplicating its environment block here would create exactly the drift this
project keeps finding: two files claiming to define one instance, disagreeing
silently after the next edit. Run `demo-lab.sh` once to establish state; the
units keep that state running.

**`RETENTION_DRY_RUN=0` and the retention days live in `demo-lab.sh` alone.**
If a unit ever needs them, read them from a shared env file - do not copy
them.

## Verifying the fix rather than assuming it

The whole point is behaviour under an event nobody schedules, so test it:

    sudo systemctl stop rscanvas-app
    # expect: restarts within ~10s
    sudo reboot

**After the reboot, assert CONFIGURATION, not just liveness.** These units
deliberately do not carry `demo-lab.sh`'s environment as authority, so
"started with the wrong settings" looks exactly like healthy from a process
listing. Three checks, each against what the system SAYS rather than what the
unit file intends:

    # 1. Ingest is actually advancing at the expected rate (~100 msg/s):
    a=$(psql "$DB" -tAc 'SELECT count(*) FROM messages'); sleep 60
    b=$(psql "$DB" -tAc 'SELECT count(*) FROM messages')
    echo "$((b-a)) msgs/min"        # expect ~6,000; 0 or ~free-run means wrong instance

    # 2. Retention came up ARMED with the right days - from the app's own
    #    startup log line, not from the unit file:
    journalctl -u rscanvas-app --since -5min | grep 'retention every'
    # expect: dryRun=false; and the jobs log naming 9d messages / 8d samples

    # 3. The standing guard: the first hourly soak.sh line re-reads the pinned
    #    inputs FROM THE RUNNING PROCESS, so a settings drift trips the
    #    derivation-pin breach in soak-check within the hour. Confirm it ran:
    bash /home/user/rscanvas/tools/soak-status.sh | head -3

A supervision change that has never survived a reboot is a claim, not a fix -
the same standard the retention flag was held to. And a reboot test that only
proves the process exists would have passed on an app pointed at the wrong
database with retention disarmed, which is the failure these units make MORE
likely, not less, by duplicating the environment.
