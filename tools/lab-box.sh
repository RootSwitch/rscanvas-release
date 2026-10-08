#!/usr/bin/env bash
# Build a bare Ubuntu 24.04 box into an RSCanvas soak node, the same way on
# every box, so two boxes differ ONLY in the code tree they are given.
#
# Written 2026-09-23 for the lab-1/lab-3 comparison: two identical N150 boxes,
# one running an old build and one running HEAD, to reproduce (or fail to
# reproduce) the minipc's unexplained median poll time - 26 ms on its old
# build, 141 ms on HEAD, same box, same fleet file. A comparison is only as
# good as the sameness of everything else, so everything else is in this one
# file: packages from the installer's own sources, PostgreSQL settings, the
# lab fixture database, the mock fleet, the units, and the sampler. Nothing
# is typed by hand on one box and not the other.
#
# Phases, each run as root ON the box (ssh user@box 'sudo bash -s -- PHASE ARGS' < this):
#
#   packages                 pgdg postgres 18, node 22 (the installer's sources), fping,
#                            jq, sysstat; the needrestart override the old lab learned
#   postgres SHARED_BUFFERS  settings file + the lab fixture role and database
#   app TARBALL              unpack a code tree (git archive) to /home/user/rscanvas,
#                            npm ci --omit=dev, apply its schema --with-retention
#   fleet FLEETFILE          install one mock-fleet file, write the units, seed the fleet
#   start                    enable and start everything
#   sampler                  install the 5-minute health sampler (cron, as user)
#   sample                   one sample (what the cron runs)
#
# THE FIXTURE CREDENTIALS ARE THE REPO'S DOCUMENTED DEMO VALUES (tools/soak-units,
# tools/demo-lab.sh): database role rscanvas/rscanvas, admin / rscanvas-demo-2026.
# These boxes are disposable lab nodes on a private segment; nothing here is
# a production pattern, and the installer (rscanvas-setup.sh) is the path for
# anything real.
#
# THE UNITS ARE WRITTEN HERE, not copied from the tree, on purpose: an old
# tree's tools/soak-units could carry a different environment than HEAD's,
# and then the comparison would be measuring the unit files. One environment,
# written once, for both builds - the same rule tools/soak-units/README.md
# states about demo-lab.sh being the authority.
set -euo pipefail

LAB_USER="${LAB_USER:-user}"
HOME_DIR="/home/${LAB_USER}"
APP_DIR="${HOME_DIR}/rscanvas"
LAB_DIR="${HOME_DIR}/lab"
DB_NAME="${DB_NAME:-rscanvas_demo}"
DB_URL="postgres://rscanvas:rscanvas@localhost:5432/${DB_NAME}"
PHASE="${1:-}"; shift || true

need_root() { [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }; }

case "$PHASE" in
packages)
    need_root
    export DEBIAN_FRONTEND=noninteractive
    # The needrestart override FIRST (HANDOFF 5l): an unattended libc upgrade
    # restarted the minipc's app mid-run on 09-12. Order matters - the
    # override has to exist before the first upgrade that would trigger it.
    install -d /etc/needrestart/conf.d
    echo '$nrconf{override_rc}{qr(^rscanvas)} = 0;' > /etc/needrestart/conf.d/50-rscanvas.conf
    apt-get update -qq
    echo "iperf3 iperf3/start_daemon boolean false" | debconf-set-selections
    apt-get install -y -qq curl ca-certificates gnupg openssl git fping jq sysstat rsync iperf3 >/dev/null
    # PGDG and NodeSource exactly as rscanvas-setup.sh adds them.
    if ! command -v psql >/dev/null; then
        . /etc/os-release
        install -d /usr/share/postgresql-common/pgdg
        curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
            -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
        echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt ${VERSION_CODENAME}-pgdg main" \
            > /etc/apt/sources.list.d/pgdg.list
        apt-get update -qq
        apt-get install -y -qq postgresql-18 >/dev/null
    fi
    if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
        curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
        apt-get install -y -qq nodejs >/dev/null
    fi
    # sysstat's 10-minute CPU/IO history, so a slow hour can be put next to
    # what the box was doing without having been watched live.
    sed -i 's/^ENABLED=.*/ENABLED="true"/' /etc/default/sysstat 2>/dev/null || true
    systemctl enable --now sysstat >/dev/null 2>&1 || true
    echo "node $(node -v), $(psql --version), fping $(fping -v 2>&1 | head -1)"
    ;;

postgres)
    need_root
    SB="${1:?shared_buffers, e.g. 3GB}"
    ECS="${2:-$(awk '/MemTotal/ {printf "%dMB", $2/1024*0.6}' /proc/meminfo)}"
    # The floor run's methodology knobs (SLICE-6-PLAN, 2026-08-13): 900 s
    # checkpoints, lz4 WAL, pg_stat_statements tracking everything, and a
    # one-second slow-statement log - scaled to this box's memory.
    cat > /etc/postgresql/18/main/conf.d/50-lab.conf <<EOF
# written by tools/lab-box.sh - identical on every lab box of one size class
shared_buffers = ${SB}
effective_cache_size = ${ECS}
maintenance_work_mem = 512MB
checkpoint_timeout = 900
max_wal_size = 8GB
wal_compression = lz4
shared_preload_libraries = 'pg_stat_statements'
pg_stat_statements.track = all
log_min_duration_statement = 1000
track_io_timing = on
EOF
    systemctl restart postgresql
    sleep 2
    # The fixture role OWNS its database and is not a superuser - the minipc's
    # arrangement (never hardened; apply-schema runs as the app role, which
    # pg_trgm permits because it is a trusted extension).
    su - postgres -c "psql -qtAc \"SELECT 1 FROM pg_roles WHERE rolname='rscanvas'\"" | grep -q 1 \
        || su - postgres -c "psql -qc \"CREATE ROLE rscanvas LOGIN PASSWORD 'rscanvas'\""
    su - postgres -c "psql -qtAc \"SELECT 1 FROM pg_database WHERE datname='rscanvas_demo'\"" | grep -q 1 \
        || su - postgres -c "createdb -O rscanvas rscanvas_demo"
    su - postgres -c "psql -qtAc 'SHOW shared_buffers'"
    ;;

app)
    need_root
    TARBALL="${1:?code tree tarball (git archive output)}"
    LABEL="${2:?a label for the tree, e.g. the commit}"
    systemctl stop rscanvas-demo.target rscanvas-app 2>/dev/null || true
    rm -rf "${APP_DIR}.new"
    install -d -o "$LAB_USER" -g "$LAB_USER" "${APP_DIR}.new" "$LAB_DIR"
    tar -xzf "$TARBALL" -C "${APP_DIR}.new"
    echo "$LABEL" > "${APP_DIR}.new/DEPLOYED_COMMIT"
    chown -R "$LAB_USER:$LAB_USER" "${APP_DIR}.new"
    if [ -d "$APP_DIR" ]; then rm -rf "${APP_DIR}.old"; mv "$APP_DIR" "${APP_DIR}.old"; fi
    mv "${APP_DIR}.new" "$APP_DIR"
    su - "$LAB_USER" -c "cd '$APP_DIR' && npm ci --omit=dev --no-audit --no-fund --loglevel=error >/dev/null"
    su - "$LAB_USER" -c "cd '$APP_DIR' && DATABASE_URL='$DB_URL' node src/db/apply-schema.ts --with-retention" | tail -4
    echo "tree: $(cat "$APP_DIR/DEPLOYED_COMMIT"), net-snmp $(node -p "require('$APP_DIR/node_modules/net-snmp/package.json').version")"
    ;;

fleet)
    need_root
    FLEETFILE="${1:?mock fleet file}"
    install -d -o "$LAB_USER" -g "$LAB_USER" "$LAB_DIR"
    install -o "$LAB_USER" -g "$LAB_USER" -m 644 "$FLEETFILE" "$LAB_DIR/mock-fleet.js"
    # The mock needs net-snmp beside it; the app's copy is the same version
    # on every tree this compares (net-snmp 3.26.3 in both lockfiles).
    ln -sfn "$APP_DIR/node_modules" "$LAB_DIR/node_modules"
    cat > /etc/systemd/system/rscanvas-app.service <<EOF
[Unit]
Description=RSCanvas lab: the application
PartOf=rscanvas-demo.target
After=postgresql.service network-online.target
Wants=postgresql.service

[Service]
Type=simple
User=${LAB_USER}
WorkingDirectory=${APP_DIR}
# The minipc's soak environment (tools/soak-units/rscanvas-app.service), plus
# the demo admin so a session can read /api/health. Identical on every box.
Environment=DATABASE_URL=${DB_URL}
Environment=COLLECTOR_ENABLED=1 JOBS_ENABLED=1 SNMP_COMMUNITY=public
Environment=HTTP_PORT=18080 SYSLOG_PORT=5514 TRAP_PORT=15162
Environment=ALERT_SCAN_INTERVAL_MS=5000
Environment=MESSAGE_RETENTION_DAYS=9 RAW_RETENTION_DAYS=8
Environment=ALERT_SYSLOG_HOST=127.0.0.1 ALERT_SYSLOG_PORT=5514
Environment=RETENTION_DRY_RUN=0
Environment=ADMIN_USERNAME=admin ADMIN_PASSWORD=rscanvas-demo-2026
EnvironmentFile=-/etc/rscanvas/lab-extra.env
ExecStart=/usr/bin/node src/main.ts
Restart=always
RestartSec=10

[Install]
WantedBy=rscanvas-demo.target
EOF
    for spec in "fleet:400:16100:mock fleet (400 devices x 25 interfaces)" "volatile:50:16600:volatile fleet (50 devices x 25 interfaces)"; do
        IFS=: read -r name size port desc <<<"$spec"
        cat > "/etc/systemd/system/rscanvas-${name}.service" <<EOF
[Unit]
Description=RSCanvas lab: ${desc}
PartOf=rscanvas-demo.target
Before=rscanvas-app.service

[Service]
Type=simple
User=${LAB_USER}
WorkingDirectory=${LAB_DIR}
Environment=FLEET_SIZE=${size} IFACES_PER=25 BASE_PORT=${port}
EnvironmentFile=-/etc/rscanvas/lab-fleet.env
ExecStart=/usr/bin/node ${LAB_DIR}/mock-fleet.js
Restart=always
RestartSec=5

[Install]
WantedBy=rscanvas-demo.target
EOF
    done
    cat > /etc/systemd/system/rscanvas-load.service <<EOF
[Unit]
Description=RSCanvas lab: syslog volume feeder (100/s)
PartOf=rscanvas-demo.target
After=rscanvas-app.service

[Service]
Type=simple
User=${LAB_USER}
WorkingDirectory=${APP_DIR}
Environment=RATE=100 BURST_RATE=100 DURATION_S=2592000
Environment=TARGET=127.0.0.1 TARGET_PORT=5514 RUN_TAG=soak
ExecStart=/usr/bin/node tools/udp-load.ts
Restart=always
RestartSec=10

[Install]
WantedBy=rscanvas-demo.target
EOF
    cat > /etc/systemd/system/rscanvas-demo.target <<EOF
[Unit]
Description=RSCanvas lab instance (app + fleets + load)
Wants=rscanvas-app.service rscanvas-fleet.service rscanvas-volatile.service rscanvas-load.service

[Install]
WantedBy=multi-user.target
EOF
    install -d /etc/rscanvas
    systemctl daemon-reload
    su - "$LAB_USER" -c "cd '$APP_DIR' && FLEET_SIZE=400 BASE_PORT=16100 DATABASE_URL='$DB_URL' node tools/seed-fleet.ts" | tail -1
    su - "$LAB_USER" -c "cd '$APP_DIR' && FLEET_SIZE=50 BASE_PORT=16600 FLEET_PREFIX=volatile DATABASE_URL='$DB_URL' node tools/seed-fleet.ts" | tail -1
    echo "fleet file md5 $(md5sum "$LAB_DIR/mock-fleet.js" | cut -c1-12)"
    ;;

shard)
    # Split the 400-device main fleet across N mock processes (2026-09-23).
    # WHY: the first A/B read showed HEAD's polls waiting on the ONE mock
    # process that answers for all 450 devices - at equal queue depth it
    # served both builds equally fast, but HEAD's extra requests per poll
    # pushed it past a knee (seconds over 100% CPU on the N150). Real devices
    # never share a queue; a fleet in one event loop invents one. Needs a
    # fleet file with INDEX_OFFSET, so every shard serves exactly the devices
    # (sysName, interfaces, dead ports) the single process served.
    need_root
    N="${1:?number of shards, dividing 400}"
    [ -n "${2:-}" ] && install -o "$LAB_USER" -g "$LAB_USER" -m 644 "$2" "$LAB_DIR/mock-fleet.js"
    grep -q INDEX_OFFSET "$LAB_DIR/mock-fleet.js" || { echo "fleet file has no INDEX_OFFSET"; exit 1; }
    PER=$((400 / N))
    [ $((PER * N)) = 400 ] || { echo "$N does not divide 400"; exit 1; }
    cat > /etc/systemd/system/rscanvas-shard@.service <<EOF
[Unit]
Description=RSCanvas lab: mock fleet shard at index %i (${PER} devices x 25 interfaces)
PartOf=rscanvas-demo.target
Before=rscanvas-app.service

[Service]
Type=simple
User=${LAB_USER}
WorkingDirectory=${LAB_DIR}
Environment=FLEET_SIZE=${PER} IFACES_PER=25 BASE_PORT=16100 INDEX_OFFSET=%i
EnvironmentFile=-/etc/rscanvas/lab-fleet.env
ExecStart=/usr/bin/node ${LAB_DIR}/mock-fleet.js
Restart=always
RestartSec=5

[Install]
WantedBy=rscanvas-demo.target
EOF
    systemctl disable --now rscanvas-fleet.service >/dev/null 2>&1 || true
    for u in $(systemctl list-units --all --plain --no-legend 'rscanvas-shard@*' | awk '{print $1}'); do
        systemctl disable --now "$u" >/dev/null 2>&1 || true
    done
    WANTS="rscanvas-app.service rscanvas-volatile.service rscanvas-load.service"
    for k in $(seq 0 $((N - 1))); do WANTS="$WANTS rscanvas-shard@$((k * PER)).service"; done
    sed -i "s|^Wants=.*|Wants=${WANTS}|" /etc/systemd/system/rscanvas-demo.target
    systemctl daemon-reload
    for k in $(seq 0 $((N - 1))); do systemctl enable --now "rscanvas-shard@$((k * PER)).service" >/dev/null 2>&1; done
    sleep 2
    systemctl list-units --plain --no-legend 'rscanvas-shard@*' | awk '{print $1, $3}' | tr '\n' ' '; echo
    ;;

serve-fleets)
    # Run mock fleets for OTHER boxes to poll (2026-09-23). WHY: with the
    # fleet on the polling box, HEAD's bursts of collector and database work
    # at poll start and end landed on the same four cores as the mock, and
    # the mock's answers waited - a cost no real network has, because real
    # devices never share the poller's CPU. Each SPEC is name:base:offset:size;
    # the shardable fleet file serves device indexes offset..offset+size-1 on
    # base+index, so two pollers can be given byte-identical fleets on
    # separate ports and never share a queue.
    need_root
    FLEETFILE="${1:?fleet file with INDEX_OFFSET}"; shift
    grep -q INDEX_OFFSET "$FLEETFILE" || { echo "fleet file has no INDEX_OFFSET"; exit 1; }
    install -d -o "$LAB_USER" -g "$LAB_USER" "$LAB_DIR" /etc/rscanvas
    install -o "$LAB_USER" -g "$LAB_USER" -m 644 "$FLEETFILE" "$LAB_DIR/mock-fleet-remote.js"
    [ -e "$LAB_DIR/node_modules" ] || ln -sfn "$APP_DIR/node_modules" "$LAB_DIR/node_modules"
    cat > /etc/systemd/system/rscanvas-remote@.service <<EOF
[Unit]
Description=RSCanvas lab: remote mock fleet %i

[Service]
Type=simple
User=${LAB_USER}
WorkingDirectory=${LAB_DIR}
Environment=IFACES_PER=25
EnvironmentFile=/etc/rscanvas/remote-%i.env
ExecStart=/usr/bin/node ${LAB_DIR}/mock-fleet-remote.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    for spec in "$@"; do
        IFS=: read -r name base off size <<<"$spec"
        printf 'BASE_PORT=%s\nINDEX_OFFSET=%s\nFLEET_SIZE=%s\n' "$base" "$off" "$size" > "/etc/rscanvas/remote-${name}.env"
        systemctl enable --now "rscanvas-remote@${name}.service" >/dev/null 2>&1
    done
    sleep 2
    systemctl list-units --plain --no-legend 'rscanvas-remote@*' | awk '{print $1, $3}' | tr '\n' ' '; echo
    ;;

point)
    # Point this box's seeded devices at a remote fleet host, shifting every
    # port by DELTA, and stop the local fleets. Peer auth as postgres - no
    # credential on the command line. Reversible: point 127.0.0.1 -DELTA.
    need_root
    RHOST="${1:?fleet host address}"; DELTA="${2:-0}"
    for u in $(systemctl list-units --all --plain --no-legend 'rscanvas-shard@*' 'rscanvas-fleet.service' 'rscanvas-volatile.service' | awk '{print $1}'); do
        systemctl disable --now "$u" >/dev/null 2>&1 || true
    done
    su - postgres -c "psql -d rscanvas_demo -qtAc \"UPDATE devices SET host = '${RHOST}'::inet, snmp_port = snmp_port + (${DELTA}) RETURNING 1\"" | wc -l | sed 's/^/devices re-pointed: /'
    WANTS="rscanvas-app.service rscanvas-load.service"
    sed -i "s|^Wants=.*|Wants=${WANTS}|" /etc/systemd/system/rscanvas-demo.target
    systemctl daemon-reload
    su - postgres -c "psql -d rscanvas_demo -qtAc \"SELECT host(host), min(snmp_port), max(snmp_port), count(*) FROM devices GROUP BY 1\""
    ;;

bisect-step)
    # One commit of a bisect (2026-09-24): its tree, a FRESH database of its
    # own (never dropped - each step creates the next name, so no step can
    # destroy another's evidence), its own schema and seed, pointed at a
    # remote fleet so the harness is held constant across every step.
    # The app unit reads DATABASE_URL from lab-extra.env, which systemd lets
    # override the unit's own Environment= line.
    need_root
    TARBALL="${1:?tree tarball}"; LABEL="${2:?label}"; FHOST="${3:?fleet host}"
    BASE="${4:?main fleet base port}"; VBASE="${5:?volatile fleet base port}"
    [ "$DB_NAME" != rscanvas_demo ] || { echo "set DB_NAME to a fresh name for a bisect step"; exit 1; }
    systemctl stop rscanvas-app
    su - postgres -c "psql -qtAc \"SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'\"" | grep -q 1 \
        && { echo "${DB_NAME} already exists - pick a fresh name"; exit 1; }
    su - postgres -c "createdb -O rscanvas ${DB_NAME}"
    DB_NAME="$DB_NAME" bash "$0" app "$TARBALL" "$LABEL" | tail -n 1
    su - "$LAB_USER" -c "cd '$APP_DIR' && FLEET_HOST=$FHOST FLEET_SIZE=400 BASE_PORT=$BASE DATABASE_URL='$DB_URL' node tools/seed-fleet.ts" | tail -n 1
    su - "$LAB_USER" -c "cd '$APP_DIR' && FLEET_HOST=$FHOST FLEET_SIZE=50 BASE_PORT=$VBASE FLEET_PREFIX=volatile DATABASE_URL='$DB_URL' node tools/seed-fleet.ts" | tail -n 1
    echo "DATABASE_URL=${DB_URL}" > /etc/rscanvas/lab-extra.env
    systemctl start rscanvas-demo.target rscanvas-app
    sleep 4
    date -u +%FT%TZ
    journalctl -u rscanvas-app --since "-10s" --no-pager -o cat | grep -E "collector\] ready|ALARM|Error" | head -n 3
    ;;

start)
    need_root
    systemctl enable --now rscanvas-demo.target >/dev/null 2>&1
    sleep 5
    systemctl is-active rscanvas-app rscanvas-fleet rscanvas-volatile rscanvas-load | tr '\n' ' '; echo
    ;;

sampler)
    need_root
    install -o "$LAB_USER" -g "$LAB_USER" -m 755 "$0" "$LAB_DIR/lab-box.sh" 2>/dev/null \
        || echo "copy this script to $LAB_DIR/lab-box.sh by hand (it was piped in)"
    # A user with no crontab yet makes `crontab -l` exit 1, and under set -e
    # plus pipefail that killed the subshell before the echo - an empty
    # crontab installed silently on the first run. Each piece tolerates
    # "nothing there yet" explicitly.
    { { crontab -u "$LAB_USER" -l 2>/dev/null || true; } | { grep -v 'lab-box.sh sample' || true; }; \
      echo "*/5 * * * * bash $LAB_DIR/lab-box.sh sample >/dev/null 2>&1"; } | crontab -u "$LAB_USER" -
    crontab -u "$LAB_USER" -l | grep sample
    ;;

sample)
    # One line of JSON per call to lab/health.jsonl: the whole /api/health
    # body under a timestamp, plus load average. Whole, not picked: the two
    # builds name some fields differently, and a sampler that chose fields
    # would have chosen for one of them. Picking happens at analysis time.
    CJ="$(mktemp)"; H="$(mktemp)"; trap 'rm -f "$CJ" "$H"' EXIT
    curl -s -m 10 -c "$CJ" -X POST http://127.0.0.1:18080/api/login -H 'content-type: application/json' \
         -d '{"username":"admin","password":"rscanvas-demo-2026"}' -o /dev/null || true
    curl -s -m 20 -b "$CJ" http://127.0.0.1:18080/api/health -o "$H" || echo '{}' > "$H"
    jq -c --arg ts "$(date -u +%FT%TZ)" --arg load "$(cut -d' ' -f1-3 /proc/loadavg)" \
       '{ts: $ts, load: $load, health: .}' "$H" >> "$LAB_DIR/health.jsonl" 2>/dev/null \
       || echo "{\"ts\":\"$(date -u +%FT%TZ)\",\"health\":null}" >> "$LAB_DIR/health.jsonl"
    ;;

*)
    sed -n '2,40p' "$0"; exit 1 ;;
esac
