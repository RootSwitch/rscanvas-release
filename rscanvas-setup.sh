#!/usr/bin/env bash
# rscanvas-setup.sh
#
# One-shot install of RSCanvas onto a fresh Linux box, and a --check mode that
# answers "what is this box actually running" without changing anything.
#
# Modelled on canvas-suite-setup.sh, which earns its keep by being SAFE TO
# RE-RUN: it never regenerates a secret, never overwrites data, and prints the
# generated credentials once at the end where a console session log catches
# them. That last part is the whole access story - every credential this
# creates is complex and random, shown once, and changed from the UI afterwards.
#
#   ./rscanvas-setup.sh --check              # report, change nothing
#   sudo ./rscanvas-setup.sh                 # install or reconcile
#   sudo ./rscanvas-setup.sh --high-ports    # syslog 5514 / traps 15162
#
#   --check          report what this box currently is and exit
#   --db NAME        database name              (default: rscanvas)
#   --dir DIR        application directory      (default: /opt/rscanvas)
#   --user NAME      service account            (default: rscanvas)
#   --http-port N    web port                   (default: 18080)
#   --high-ports     syslog 5514 / traps 15162, no privilege needed
#   --no-service     stop before installing the systemd unit
#   --tls            https on the web port: a self-signed pair is minted ONCE
#                    into /etc/rscanvas/tls and reused on every re-run. Sticky:
#                    a later run without --tls does not turn it off (remove
#                    TLS_CERT and TLS_KEY from the env file by hand to do that)
#   --tls-cert PATH  use this PEM certificate instead of minting one
#   --tls-key PATH   ...and this key (both or neither; implies --tls)
#   --yes            do not prompt
#
# WHY --check EXISTS, AND WHY IT IS FIRST IN THE FILE. On 2026-08-15 three
# deployments went wrong on this lab's own boxes, and all three had one cause:
# acting on box state that was assumed rather than read. One box was three
# slices behind and took a HEAD main.ts that imported modules it did not have;
# one was under systemd when it was assumed to be hand-started; one had a file
# truncated by `cat missing > file`, which empties the destination BEFORE
# discovering the source is gone. An installer that cannot describe a box is an
# installer that will eventually do that to one.

set -euo pipefail

# ----- options --------------------------------------------------------------
DB_NAME=rscanvas
APP_DIR=/opt/rscanvas
SVC_USER=rscanvas
HTTP_PORT=18080
SYSLOG_PORT=514
TRAP_PORT=162
DO_CHECK=0
DO_SERVICE=1
ASSUME_YES=0
DO_TLS=0
TLS_CERT_SRC=""
TLS_KEY_SRC=""
ENV_FILE=/etc/rscanvas/rscanvas.env

while [ $# -gt 0 ]; do
    case "$1" in
        --check)       DO_CHECK=1 ;;
        --db)          DB_NAME="$2"; shift ;;
        --dir)         APP_DIR="$2"; shift ;;
        --user)        SVC_USER="$2"; shift ;;
        --http-port)   HTTP_PORT="$2"; shift ;;
        --high-ports)  SYSLOG_PORT=5514; TRAP_PORT=15162 ;;
        --no-service)  DO_SERVICE=0 ;;
        --tls)         DO_TLS=1 ;;
        --tls-cert)    DO_TLS=1; TLS_CERT_SRC="$2"; shift ;;
        --tls-key)     DO_TLS=1; TLS_KEY_SRC="$2"; shift ;;
        --yes|-y)      ASSUME_YES=1 ;;
        -h|--help)     sed -n '2,38p' "$0"; exit 0 ;;
        *)             echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

B=$'\033[1m'; Y=$'\033[33m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
warn() { printf '%s  ! %s%s\n' "$Y" "$*" "$N"; }
bad()  { printf '%s  x %s%s\n' "$R" "$*" "$N"; }
good() { printf '%s  ok%s %s\n' "$G" "$N" "$*"; }
die()  { printf '%sFATAL: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

psql_su() { sudo -u postgres psql -v ON_ERROR_STOP=1 "$@"; }
# -n so a box without passwordless sudo FAILS rather than hanging --check on a
# password prompt. The caller then has to distinguish that from "no database",
# which is what SUDO_OK below is for.
q()       { sudo -n -u postgres psql -tAq -c "$1" 2>/dev/null || true; }
qd()      { sudo -n -u postgres psql -tAq -d "$1" -c "$2" 2>/dev/null || true; }

# DF, AND THE DIFFERENCE BETWEEN EMPTY AND UNMEASURED.
#
# On lab-stresstest /var/lib/postgresql is 0700 postgres, so an unprivileged df
# cannot traverse to the data directory and exits 1; on minipc the same path is
# 0755 and it works. The first version of this script printed a BLANK LINE for
# the first case, which reads as "no disk" rather than "could not look" - the
# exact failure mode this file complains about elsewhere, committed inside it.
#
# So: try direct, then sudo, then the nearest ancestor that can be stat'd while
# SAYING that is what happened, and only then admit defeat in words. -P keeps
# df on one line, which a long device name would otherwise wrap.
disk_for() {
    local p="$1" out up
    fmt() { awk 'NR==2{printf "%s used of %s (%s) on %s", $3, $2, $5, $6}'; }
    out=$(df -h -P "$p" 2>/dev/null | fmt)
    [ -n "$out" ] || out=$(sudo -n df -h -P "$p" 2>/dev/null | fmt)
    if [ -z "$out" ]; then
        up="$p"
        while [ "$up" != "/" ]; do
            up=$(dirname "$up")
            out=$(df -h -P "$up" 2>/dev/null | fmt)
            [ -n "$out" ] && { printf '%s  [measured at %s - %s is not readable]' "$out" "$up" "$p"; return; }
        done
        printf 'COULD NOT MEASURE - permission denied on %s and every parent' "$p"
        return
    fi
    printf '%s' "$out"
}

# ----- --check: read the box, change nothing --------------------------------
#
# Every line here is a QUESTION SOMEONE GOT WRONG. Kept in the order that makes
# a deployment decision: what is it, what is running, what version, how is it
# managed, and is the database in the state the app expects.
if [ "$DO_CHECK" = 1 ]; then
    step "identity"
    say "  host       $(hostname)"
    say "  os         $(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME")"
    say "  kernel     $(uname -r)"
    say "  cpu/ram    $(nproc) cores, $(free -g 2>/dev/null | awk 'NR==2{print $2"GB"}')"
    say "  uptime     $(uptime -p 2>/dev/null || true)"
    say "  load       $(cut -d' ' -f1-3 /proc/loadavg)"

    step "runtime"
    say "  node       $(command -v node >/dev/null && node -v || echo 'NOT INSTALLED')"
    if command -v fping >/dev/null; then say "  fping      $(fping -v 2>&1 | head -1 | grep -oE '[0-9][0-9.]*' | head -1)"
    else bad "fping NOT INSTALLED - reachability is off, every device reads unknown"; fi
    rmem=$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)
    if [ "$rmem" -ge 8388608 ]; then say "  rmem_max   $rmem (the 8 MB syslog and trap buffers fit)"
    else warn "net.core.rmem_max is $rmem - the syslog and trap sockets are CLAMPED to it; rerun the installer or raise it"; fi
    # Present or absent, NEVER the value: --check output gets pasted into
    # tickets and chat.
    if sudo -n test -f "$ENV_FILE" 2>/dev/null && sudo -n grep -qE '^RSCANVAS_SECRET=.+' "$ENV_FILE" 2>/dev/null; then
        say "  cred key   RSCANVAS_SECRET is set (credential profiles can be stored)"
    else
        warn "RSCANVAS_SECRET not set - credential profiles cannot be created; env-named refs still work"
    fi
    if sudo -n test -f "$ENV_FILE" 2>/dev/null && sudo -n grep -qE '^RSCANVAS_ADMIN_DB_PASSWORD=.+' "$ENV_FILE" 2>/dev/null; then
        say "  maint cred RSCANVAS_ADMIN_DB_PASSWORD is set (index maintenance runs as the owning role)"
    else
        warn "RSCANVAS_ADMIN_DB_PASSWORD not set - on a hardened database trigram index drops will fail with 'must be owner'"
    fi
    if sudo -n test -f "$ENV_FILE" 2>/dev/null && sudo -n grep -qE '^TLS_CERT=.+' "$ENV_FILE" 2>/dev/null; then
        crt=$(sudo -n sed -n 's/^TLS_CERT=//p' "$ENV_FILE" | head -1)
        exp=$(sudo -n openssl x509 -in "$crt" -noout -enddate 2>/dev/null | cut -d= -f2)
        say "  tls        on - $crt (expires ${exp:-UNREADABLE - the service will not start})"
    else
        say "  tls        off - web port is plain http (opt in with --tls)"
    fi
    # SAID ONCE, UP FRONT. Without this every database line below prints an
    # empty answer that reads like a finding - "no databases", "no roles" - when
    # the truth is that nothing was asked.
    if ! sudo -n true 2>/dev/null; then
        bad "cannot sudo without a password on this box"
        bad "every postgres and disk line below is UNMEASURED, not empty - re-run with sudo"
    fi
    pgv=$(q "SHOW server_version" | head -1)
    say "  postgres   ${pgv:-NOT REACHABLE}"
    if [ -n "$pgv" ]; then
        pgdata=$(q 'SHOW data_directory')
        say "  data dir   $pgdata"
        say "  disk       $(disk_for "$pgdata")"
    fi

    step "application"
    if [ -d "$APP_DIR" ]; then
        say "  dir        $APP_DIR"
        if command -v git >/dev/null && [ -d "$APP_DIR/.git" ]; then
            say "  commit     $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null) $(git -C "$APP_DIR" status --porcelain 2>/dev/null | wc -l) file(s) dirty"
        elif [ -f "$APP_DIR/BUNDLE-MANIFEST.txt" ]; then
            say "  bundle     $(grep -m1 -i commit "$APP_DIR/BUNDLE-MANIFEST.txt" 2>/dev/null || echo 'manifest present')"
        else
            # THE CASE THAT BIT US. A hand-copied tree has no commit and no
            # manifest, so the only honest answer is a fingerprint of what is
            # actually there - and which recent modules are missing from it.
            warn "no git checkout and no bundle manifest - vintage is UNKNOWN"
            for f in src/devices/removal.ts src/collector/sensors.ts \
                     src/collector/reach.ts public/charts.js src/alerts/events.ts; do
                [ -e "$APP_DIR/$f" ] || bad "missing $f"
            done
            command -v git >/dev/null && say "  main.ts    $(git hash-object "$APP_DIR/src/main.ts" 2>/dev/null || echo '?')"
        fi
    else
        say "  dir        $APP_DIR NOT PRESENT"
    fi

    step "process management"
    units=$(systemctl list-unit-files --no-legend 2>/dev/null | grep -iE '^rscanvas' || true)
    if [ -n "$units" ]; then
        printf '%s\n' "$units" | awk '{printf "  unit       %s (%s)\n", $1, $2}'
        for u in $(printf '%s\n' "$units" | awk '{print $1}'); do
            say "             $u: $(systemctl is-active "$u"), $(systemctl show -p NRestarts --value "$u" 2>/dev/null) restart(s)"
        done
    else
        warn "no rscanvas systemd units - anything running was started by hand and dies with a reboot"
    fi
    hand=$(ps -eo pid,args | awk '/node .*src\/main\.ts/ && !/awk/ {print $1}' | head -3)
    [ -n "$hand" ] && say "  processes  $(printf '%s ' $hand)"

    step "database"
    if [ -n "$pgv" ]; then
        say "  databases  $(q "SELECT string_agg(datname,' ' ORDER BY datname) FROM pg_database WHERE datname LIKE 'rscanvas%'")"
        say "  roles      $(q "SELECT string_agg(rolname,' ' ORDER BY rolname) FROM pg_roles WHERE rolname LIKE 'rscanvas%'")"
        if [ -n "$(q "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'")" ]; then
            say "  size       $(q "SELECT pg_size_pretty(pg_database_size('$DB_NAME'))")"
            say "  tables     $(qd "$DB_NAME" "SELECT count(*) FROM pg_class WHERE relkind IN ('r','p') AND relnamespace='public'::regnamespace")"
            # HARDENING STATE, which is invisible until a backup fails. Break 6
            # in RUNBOOK section 5: a table the app cannot SELECT aborts the
            # whole pg_dump, and nobody finds out until a restore.
            owner=$(qd "$DB_NAME" "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tableowner <> 'rscanvas_owner'")
            if [ "${owner:-0}" = 0 ]; then good "hardened - every public table owned by rscanvas_owner"
            else warn "$owner table(s) NOT owned by rscanvas_owner - hardening did not take, or was never run"; fi
            unreadable=$(qd "$DB_NAME" "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND NOT has_table_privilege('rscanvas', schemaname||'.'||quote_ident(tablename), 'SELECT')")
            if [ "${unreadable:-0}" = 0 ]; then good "app role can SELECT every table (pg_dump will not abort)"
            else bad "$unreadable table(s) the app role cannot SELECT - pg_dump WILL fail on this database"; fi
        else
            say "  $DB_NAME   NOT PRESENT"
        fi
    fi

    step "ports"
    for p in "$HTTP_PORT/tcp" "$SYSLOG_PORT/udp" "$TRAP_PORT/udp"; do
        n=${p%/*}; proto=${p#*/}
        if ss -lnu 2>/dev/null | grep -q ":$n " || ss -lnt 2>/dev/null | grep -q ":$n "; then
            good "$p listening"
        else
            say "  $p not listening"
        fi
    done
    say ""
    exit 0
fi

# ----- install --------------------------------------------------------------
[ "$(id -u)" = 0 ] || die "run with sudo (installs packages, creates a service account and a unit)"

step "preflight"
. /etc/os-release 2>/dev/null || die "cannot read /etc/os-release"
case "${ID:-}${ID_LIKE:-}" in
    *debian*|*ubuntu*) PKG=apt ;;
    *rhel*|*fedora*)   PKG=dnf ;;
    *) die "unsupported distribution: ${PRETTY_NAME:-unknown}" ;;
esac
good "$PRETTY_NAME, package manager $PKG"

if [ "$SYSLOG_PORT" -lt 1024 ] || [ "$TRAP_PORT" -lt 1024 ]; then
    warn "syslog udp/$SYSLOG_PORT and traps udp/$TRAP_PORT are privileged ports."
    warn "This installer grants the capability to the node binary rather than running as root."
    warn "A daemon parsing hostile input from the network is the wrong thing to hand root to."
    warn "Use --high-ports for 5514/15162 with an iptables redirect instead."
    if [ "$ASSUME_YES" != 1 ]; then
        read -r -p "  continue with setcap on node? [y/N] " a
        case "$a" in y|Y) ;; *) die "stopped - re-run with --high-ports" ;; esac
    fi
fi

step "packages"
if [ "$PKG" = apt ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    # fping IS A DEPENDENCY, not an option. Without it the collector logs one
    # ALARM at startup and reachability is silently OFF: every reach_state
    # stays "unknown", the ping column is blank, and "answers ping but the
    # agent is dead" - the diagnosis that separates a credential fault from an
    # outage - is unavailable. The first real deployment ran without it and
    # nobody noticed, because unknown looks like nothing is wrong.
    apt-get install -y -qq curl ca-certificates gnupg openssl libcap2-bin git fping >/dev/null
    # Postgres 18 is not in Ubuntu 24.04, so PGDG or nothing. Adding the repo is
    # idempotent; installing over an existing 18 is a no-op.
    if ! command -v psql >/dev/null || [ -z "$(q 'SHOW server_version' | grep -E '^1[89]')" ]; then
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
else
    dnf install -y -q curl openssl git libcap fping postgresql18-server nodejs >/dev/null || \
        die "install postgresql 18 and node 22+ by hand on this distribution, then re-run"
    [ -d /var/lib/pgsql/18/data ] || /usr/pgsql-18/bin/postgresql-18-setup initdb
    systemctl enable --now postgresql-18
fi
good "node $(node -v), postgres $(q 'SHOW server_version')"

[ -n "$(q 'SELECT 1')" ] || die "postgres is installed but not answering - start it and re-run"

step "kernel receive buffers"
# THE APP ASKS, THE KERNEL DECIDES (2026-09-24, the lab-5 ingest test). The
# ingest worker requests an 8 MB receive buffer on its syslog and trap
# sockets (RCVBUF_BYTES), and the kernel silently clamps any request to
# net.core.rmem_max - 212,992 bytes on a stock Ubuntu box. So every install
# before this step ran its UDP sockets at 5% of the buffer the code was
# designed around, and the only sign was one "CLAMPED" line in the journal
# at startup. Raised, never lowered: an administrator's larger value stays.
#
# PERSISTED EVERY RUN, NOT ONLY WHEN LOW (the 2026-09-24 upgrade drill). The
# first version wrote the file only when the RUNNING value was below the
# target, so a value raised by hand with `sysctl -w` - or already raised in a
# shared kernel, as the drill's WSL instance was - skipped the file and would
# fall back to 212,992 at the next reboot. The file now always records the
# larger of the running value and the target, so it can never lower anything
# and always survives a reboot.
RMEM_WANT=16777216
RMEM_NOW=$(sysctl -n net.core.rmem_max 2>/dev/null || echo 0)
RMEM_SET=$RMEM_WANT
if [ "$RMEM_NOW" -gt "$RMEM_WANT" ]; then RMEM_SET=$RMEM_NOW; fi
cat > /etc/sysctl.d/60-rscanvas.conf <<EOF
# Written by rscanvas-setup.sh. The RSCanvas ingest worker requests an 8 MB
# receive buffer (RCVBUF_BYTES) on its syslog and trap sockets; the kernel
# clamps every request to net.core.rmem_max, which ships at 212992.
net.core.rmem_max = ${RMEM_SET}
EOF
if [ "$RMEM_NOW" -lt "$RMEM_WANT" ]; then
    sysctl -q -p /etc/sysctl.d/60-rscanvas.conf || warn "could not apply /etc/sysctl.d/60-rscanvas.conf - UDP buffers stay clamped"
    good "net.core.rmem_max $(sysctl -n net.core.rmem_max) (was ${RMEM_NOW}) - persisted in /etc/sysctl.d/60-rscanvas.conf"
else
    good "net.core.rmem_max ${RMEM_NOW} - already enough; persisted in /etc/sysctl.d/60-rscanvas.conf so a reboot keeps it"
fi

step "service account and directories"
id -u "$SVC_USER" >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin "$SVC_USER"
install -d -o "$SVC_USER" -g "$SVC_USER" "$APP_DIR"
install -d -m 0700 /etc/rscanvas
good "$SVC_USER, $APP_DIR"

step "secrets"
# NEVER REGENERATE. An existing value is read back and reused, so re-running
# this script cannot lock anyone out of an instance they already have. Only the
# absent ones are minted. This is the single most important idempotency
# property in the file.
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
read_secret() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
set_secret() {
    local k="$1" v="$2"
    if grep -q "^$k=" "$ENV_FILE"; then
        sed -i "s|^$k=.*|$k=$v|" "$ENV_FILE"
    else
        printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
    fi
    # ASSERT READABLE. Writing a secret and not reading it back is how an
    # install reports success over a file the service cannot use.
    [ "$(read_secret "$k")" = "$v" ] || die "wrote $k but could not read it back from $ENV_FILE"
}

DB_PASS="$(read_secret RSCANVAS_DB_PASSWORD)"
DB_NEW=0
if [ -z "$DB_PASS" ]; then DB_PASS="$(openssl rand -hex 24)"; DB_NEW=1; fi
ADMIN_PW="$(read_secret ADMIN_PASSWORD)"
ADMIN_NEW=0
if [ -z "$ADMIN_PW" ]; then ADMIN_PW="$(openssl rand -hex 16)"; ADMIN_NEW=1; fi
# THE CREDENTIAL STORE KEY. Encrypts every SNMP community and v3 key held in
# credential_profiles (SLICE-CREDENTIALS-PLAN). Same rule as every secret
# here: read what exists, mint only when absent, NEVER regenerate - a
# regenerated key silently turns every stored profile into ciphertext nobody
# can read. Losing it is recoverable (re-enter the profiles), and the operator
# has said that is acceptable; regenerating it by accident is the same loss
# with no warning, which is not.
CRED_KEY="$(read_secret RSCANVAS_SECRET)"
CRED_KEY_NEW=0
if [ -z "$CRED_KEY" ]; then CRED_KEY="$(openssl rand -base64 32)"; CRED_KEY_NEW=1; fi
ADMIN_PASS_DB="$(read_secret RSCANVAS_ADMIN_DB_PASSWORD)"
[ -n "$ADMIN_PASS_DB" ] || ADMIN_PASS_DB="$(openssl rand -hex 24)"
COMMUNITY="$(read_secret SNMP_COMMUNITY)"
[ -n "$COMMUNITY" ] || COMMUNITY=public

set_secret RSCANVAS_DB_PASSWORD "$DB_PASS"
set_secret RSCANVAS_ADMIN_DB_PASSWORD "$ADMIN_PASS_DB"
set_secret ADMIN_PASSWORD "$ADMIN_PW"
set_secret RSCANVAS_SECRET "$CRED_KEY"
set_secret ADMIN_USERNAME admin
set_secret SNMP_COMMUNITY "$COMMUNITY"
set_secret DATABASE_URL "postgres://rscanvas:$DB_PASS@localhost:5432/$DB_NAME"
set_secret HTTP_PORT "$HTTP_PORT"
set_secret SYSLOG_PORT "$SYSLOG_PORT"
set_secret TRAP_PORT "$TRAP_PORT"
set_secret COLLECTOR_ENABLED 1
set_secret JOBS_ENABLED 1
good "$ENV_FILE (0600 root:root), $( [ "$DB_NEW" = 1 ] && echo 'new' || echo 'existing') database credential"

# ----- tls: opt in once, sticky after ----------------------------------------
#
# Same rule as every secret above, applied twice: a re-run WITHOUT --tls does
# not strip https from a box that has it (the env keys simply stay), and a
# re-run WITH it does not remint a pair that exists - a browser keeps its
# accepted-warning exception only while the certificate stays the same, so
# reminting on every run would mean a fresh warning on every run. The suite
# ran one nginx and one self-signed cert PER APP, one warning each; this is
# one port, one cert, at most one warning. Turning TLS off is a deliberate
# hand edit: remove TLS_CERT and TLS_KEY from the env file and restart.
TLS_DIR=/etc/rscanvas/tls
if [ "$DO_TLS" = 1 ]; then
    step "tls"
    [ -n "$TLS_CERT_SRC" ] && [ -z "$TLS_KEY_SRC" ] && die "--tls-cert without --tls-key: half a pair must not fall back to plaintext OR to a minted key that does not match"
    [ -z "$TLS_CERT_SRC" ] && [ -n "$TLS_KEY_SRC" ] && die "--tls-key without --tls-cert"
    # /etc/rscanvas is 0700 root:root because only systemd (root) ever read
    # from it. The pair changes that: the APP opens these two files as the
    # service user, so the parent needs traversal - 0710, execute-only, which
    # lets the service user step THROUGH the directory without being able to
    # list it. The env file inside stays 0600 root:root either way. Found
    # live: the first container drill died here with EACCES on cert.pem.
    chgrp "$SVC_USER" /etc/rscanvas; chmod 0710 /etc/rscanvas
    install -d -m 0750 -o root -g "$SVC_USER" "$TLS_DIR"
    if [ -n "$TLS_CERT_SRC" ]; then
        # A hand-supplied pair is COPIED, not referenced, so the service never
        # depends on read access into somebody's home directory.
        [ -s "$TLS_CERT_SRC" ] || die "--tls-cert $TLS_CERT_SRC: not readable or empty"
        [ -s "$TLS_KEY_SRC" ]  || die "--tls-key $TLS_KEY_SRC: not readable or empty"
        openssl x509 -in "$TLS_CERT_SRC" -noout 2>/dev/null || die "--tls-cert $TLS_CERT_SRC is not a PEM certificate"
        install -m 0644 -o root -g "$SVC_USER" "$TLS_CERT_SRC" "$TLS_DIR/cert.pem"
        install -m 0640 -o root -g "$SVC_USER" "$TLS_KEY_SRC" "$TLS_DIR/key.pem"
        good "installed the supplied pair into $TLS_DIR"
    elif [ -s "$TLS_DIR/cert.pem" ] && [ -s "$TLS_DIR/key.pem" ]; then
        good "existing pair kept - $(openssl x509 -in "$TLS_DIR/cert.pem" -noout -enddate 2>/dev/null | cut -d= -f2 | sed 's/^/expires /')"
    else
        # One self-signed cert named for EVERY address this box answers on,
        # so the warning is accepted once and stays accepted whichever way
        # the operator reaches it.
        SAN="DNS:$(hostname),IP:127.0.0.1"
        for ip in $(hostname -I); do SAN="$SAN,IP:$ip"; done
        openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
            -keyout "$TLS_DIR/key.pem" -out "$TLS_DIR/cert.pem" \
            -subj "/CN=$(hostname)" -addext "subjectAltName=$SAN" 2>/dev/null \
            || die "openssl could not mint the pair"
        chown root:"$SVC_USER" "$TLS_DIR/key.pem" "$TLS_DIR/cert.pem"
        chmod 0640 "$TLS_DIR/key.pem"; chmod 0644 "$TLS_DIR/cert.pem"
        good "minted a self-signed pair, 10 years, $SAN"
    fi
    set_secret TLS_CERT "$TLS_DIR/cert.pem"
    set_secret TLS_KEY "$TLS_DIR/key.pem"
fi
# TLS IS STICKY, AND SO IS WHAT IT NEEDS (2026-09-24, the upgrade drill). A
# box installed with --tls serves https on every later run without the flag -
# the scheme is read from the env file, and INSTALL.md's upgrade says to
# re-run with no flags - but the directories step resets /etc/rscanvas to
# 0700 on EVERY run, and only the tls step above gave the service user its
# traversal back. So the documented upgrade of any TLS install left the
# service unable to open its own certificate: FATAL EACCES on cert.pem,
# restarting forever. Found by upgrading a 374ef7a --tls install to the next
# bundle exactly as INSTALL.md says; production never met it only because its
# upgrades always passed --tls. The permission now follows the env file, as
# the scheme does.
if [ "$DO_TLS" != 1 ] && [ -n "$(read_secret TLS_CERT)" ]; then
    chgrp "$SVC_USER" /etc/rscanvas; chmod 0710 /etc/rscanvas
    good "tls kept from a previous run ($(read_secret TLS_CERT))"
fi

step "roles and database"
# THE THREE-ROLE SPLIT. rscanvas_owner owns and cannot log in; rscanvas is the
# application and gets DML only, so `DROP TABLE` comes back "must be owner"
# from Postgres itself before any guard in this repo is consulted;
# rscanvas_admin is a member of the owner, for schema changes.
q "SELECT 1 FROM pg_roles WHERE rolname='rscanvas_owner'" | grep -q 1 || \
    psql_su -c "CREATE ROLE rscanvas_owner NOLOGIN"
if q "SELECT 1 FROM pg_roles WHERE rolname='rscanvas'" | grep -q 1; then
    psql_su -c "ALTER ROLE rscanvas LOGIN PASSWORD '$DB_PASS'"
else
    psql_su -c "CREATE ROLE rscanvas LOGIN PASSWORD '$DB_PASS'"
fi
if q "SELECT 1 FROM pg_roles WHERE rolname='rscanvas_admin'" | grep -q 1; then
    psql_su -c "ALTER ROLE rscanvas_admin LOGIN PASSWORD '$ADMIN_PASS_DB'"
else
    psql_su -c "CREATE ROLE rscanvas_admin LOGIN PASSWORD '$ADMIN_PASS_DB' IN ROLE rscanvas_owner"
fi
q "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 || \
    psql_su -c "CREATE DATABASE $DB_NAME OWNER rscanvas_owner"
psql_su -d "$DB_NAME" \
    -c "ALTER SCHEMA public OWNER TO pg_database_owner" \
    -c "GRANT CREATE ON SCHEMA public TO pg_database_owner" >/dev/null
good "rscanvas_owner / rscanvas / rscanvas_admin, database $DB_NAME"

step "code"
if [ ! -f "$APP_DIR/package.json" ]; then
    die "no application at $APP_DIR - extract the bundle there first:
      tar -xzf rscanvas-<stamp>-<commit>.tar.gz -C $APP_DIR
    then re-run. This script deliberately does not fetch code: an installer that
    chooses your version is an installer that can change it under you."
fi
chown -R "$SVC_USER:$SVC_USER" "$APP_DIR"
good "$APP_DIR ($( [ -f "$APP_DIR/BUNDLE-MANIFEST.txt" ] && head -c 60 "$APP_DIR/BUNDLE-MANIFEST.txt" | tr '\n' ' ' || echo 'no manifest'))"

step "schema - BUILD, then HARDEN, never the other way round"
# Reversed these two are circular: harden-roles makes four functions SECURITY
# DEFINER and those functions are created by the slice files, while
# apply-schema needs a CREATE privilege hardening has just revoked. The cycle
# was never in the tools, only in the sequence. INSTALL.md carries the order.
sudo -u "$SVC_USER" env \
    DATABASE_URL="postgres://rscanvas_admin:$ADMIN_PASS_DB@localhost:5432/$DB_NAME" \
    node "$APP_DIR/src/db/apply-schema.ts" --with-retention
good "schema applied as rscanvas_admin, with retention"

if [ -x "$APP_DIR/tools/harden-roles.sh" ]; then
    # PGPASSWORD is the app role's GENERATED credential, not the dev default.
    # Without it the script's own verification cannot log in, and since that
    # verification is the part which proves the permission model rather than
    # asserting it, a silent skip would be worse than the failure.
    PGPASSWORD="$DB_PASS" bash "$APP_DIR/tools/harden-roles.sh" "$DB_NAME"
    good "roles hardened and verified"
else
    warn "tools/harden-roles.sh not present - the app role still owns its tables and can DROP them"
fi

if [ "$DO_SERVICE" = 1 ]; then
    step "service"
    if [ "$SYSLOG_PORT" -lt 1024 ] || [ "$TRAP_PORT" -lt 1024 ]; then
        setcap 'cap_net_bind_service=+ep' "$(command -v node)"
        good "cap_net_bind_service granted to $(command -v node) - NOT running as root"
    fi
    cat > /etc/systemd/system/rscanvas.service <<UNIT
[Unit]
Description=RSCanvas
Documentation=file:$APP_DIR/INSTALL.md
After=network-online.target postgresql.service
Wants=network-online.target postgresql.service
# Deliberately NOT Requires= - a postgres blip should let the app keep retrying,
# not stop it. Stopping silently is the failure mode a monitor must not have.
StartLimitIntervalSec=0

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$(command -v node) $APP_DIR/src/main.ts
Restart=always
RestartSec=10
SyslogIdentifier=rscanvas

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable rscanvas >/dev/null 2>&1
    systemctl restart rscanvas
    good "rscanvas.service enabled and started"
fi

step "verify, rather than assume"
ok=1
sleep 8
if [ "$DO_SERVICE" = 1 ]; then
    [ "$(systemctl is-active rscanvas)" = active ] || { bad "rscanvas.service is $(systemctl is-active rscanvas)"; ok=0; }
fi
# THE SCHEME IS READ FROM THE ENV FILE, NOT FROM THE FLAG. A box that got
# --tls on a previous run serves https on THIS run too, flag or no flag, and
# a verify that probed http would report a healthy box as broken. Verify the
# cargo: what the service actually loads decides what gets probed.
SCHEME=http; CURL_K=""
[ -n "$(read_secret TLS_CERT)" ] && { SCHEME=https; CURL_K="-k"; }
# No "|| echo 000" here: curl -w prints 000 ITSELF when the connection
# fails while exiting nonzero, so the fallback appended a second 000 and the
# resulting "000000" matched neither case arm - a dead port fell through to
# the warn branch and the install reported success over a service that was
# not answering. Found live in a container drill on 2026-08-19.
code=$(curl -s $CURL_K -o /dev/null -w '%{http_code}' --max-time 10 "$SCHEME://127.0.0.1:$HTTP_PORT/api/devices" || true)
[ -n "$code" ] || code=000
case "$code" in
    401) good "$SCHEME $HTTP_PORT answering, auth required" ;;
    000) bad "nothing answering $SCHEME on $HTTP_PORT"; ok=0 ;;
    *)   warn "$SCHEME $HTTP_PORT returned $code (expected 401)" ;;
esac
if [ "$SCHEME" = https ]; then
    r=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://127.0.0.1:$HTTP_PORT/" || true)
    if [ "$r" = 301 ]; then good "plain http on $HTTP_PORT redirects to https - a stale bookmark still lands"
    else warn "plain http on $HTTP_PORT returned $r (expected a 301 to https)"; fi
fi
unreadable=$(qd "$DB_NAME" "SELECT count(*) FROM pg_tables WHERE schemaname='public' AND NOT has_table_privilege('rscanvas', schemaname||'.'||quote_ident(tablename), 'SELECT')")
if [ "${unreadable:-0}" = 0 ]; then good "app role can SELECT every table - pg_dump will not abort"
else bad "$unreadable table(s) unreadable by the app role - BACKUPS WILL FAIL"; ok=0; fi
if [ "$TRAP_PORT" -lt 1024 ] && ! ss -lnu 2>/dev/null | grep -q ":$TRAP_PORT "; then
    warn "nothing listening on udp/$TRAP_PORT - the trap receiver reports its error and the app runs on regardless, so confirm with snmptrap rather than assuming"
fi

printf '\n%s================ RSCanvas is up ================%s\n' "$B" "$N"
say "  web        $SCHEME://$(hostname -I | awk '{print $1}'):$HTTP_PORT$( [ "$SCHEME" = https ] && echo '   (self-signed: the browser warns once)' )"
say "  syslog     udp/$SYSLOG_PORT      traps  udp/$TRAP_PORT"
say "  database   $DB_NAME     config  $ENV_FILE"
say "  service    systemctl status rscanvas    journalctl -u rscanvas -f"
say ""
if [ "$ADMIN_NEW" = 1 ]; then
    printf '  %sSAVE THIS - RSCanvas admin password (user: admin):%s\n' "$Y" "$N"
    printf '      %s%s%s\n' "$B" "$ADMIN_PW" "$N"
    say "  It is shown once, here, so a console session log captures it."
    say "  Change it from the UI once you are in."
else
    say "  Admin password unchanged from the existing install."
    say "  Recover it with:  sudo grep ADMIN $ENV_FILE"
fi
if [ "$CRED_KEY_NEW" = 1 ]; then
    say ""
    printf '  %sSAVE THIS TOO - the credential store key (RSCANVAS_SECRET):%s
' "$Y" "$N"
    printf '      %s%s%s
' "$B" "$CRED_KEY" "$N"
    say "  It encrypts every SNMP credential profile at rest. If it is lost the profiles"
    say "  cannot be read and must be re-entered - so keep it with your other secrets,"
    say "  and never edit it in $ENV_FILE by hand."
fi
say ""
[ "$ok" = 1 ] || die "install completed with failures above - do not treat this instance as working"
