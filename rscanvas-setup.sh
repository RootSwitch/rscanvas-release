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
#   sudo ./rscanvas-setup.sh --uninstall     # remove the service, KEEP the data
#   sudo ./rscanvas-setup.sh --uninstall --purge   # ...and the data
#
#   --check          report what this box currently is and exit
#   --db NAME        database name              (default: rscanvas)
#   --dir DIR        application directory      (default: /opt/rscanvas)
#   --user NAME      service account            (default: rscanvas)
#   --http-port N    web port                   (default: 18080)
#   --high-ports     syslog 5514 / traps 15162, no privilege needed
#   --raw-days N     keep raw per-poll samples N days    (default 14, at least 7)
#   --message-days N keep syslog and trap messages N days (default 30, at least 7)
#   --no-service     stop before installing the systemd unit
#   --tls            https on the web port: a self-signed pair is minted ONCE
#                    into /etc/rscanvas/tls and reused on every re-run. Sticky:
#                    a later run without --tls does not turn it off (remove
#                    TLS_CERT and TLS_KEY from the env file by hand to do that)
#   --tls-cert PATH  use this PEM certificate instead of minting one
#   --tls-key PATH   ...and this key (both or neither; implies --tls)
#   --uninstall      stop and remove the service, the application directory,
#                    the node port capability and the kernel buffer setting;
#                    KEEP the database, its roles, /etc/rscanvas and the
#                    service account, so installing again resumes where it was
#   --purge          with --uninstall: also drop the database (and any copies
#                    rscanvas-backup.sh set aside), the roles, /etc/rscanvas and
#                    the service account. Backups and packages are never removed.
#   --yes            do not prompt
#
#   --raw-days and --message-days are written to the env file when given and
#   left as they are when not, so a re-run keeps whatever days the box keeps.
#
#   --db, --dir, --http-port, --high-ports and --user are STICKY too: a later
#   run without them keeps what the install already uses (read from the env
#   file and the unit). To change one, pass it again; to return from
#   --high-ports to 514/162, edit SYSLOG_PORT and TRAP_PORT in the env file
#   and re-run.
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
# Which choices were made on THIS command line - the rest are read back from
# the existing install below, so a re-run cannot quietly undo them.
SET_DB=0; SET_USER=0; SET_HTTP=0; SET_PORTS=0; SET_DIR=0
DO_UNINSTALL=0
DO_PURGE=0
RAW_DAYS=""
MSG_DAYS=""

while [ $# -gt 0 ]; do
    case "$1" in
        --check)       DO_CHECK=1 ;;
        --uninstall)   DO_UNINSTALL=1 ;;
        --purge)       DO_PURGE=1 ;;
        --db)          DB_NAME="$2"; SET_DB=1; shift ;;
        --dir)         APP_DIR="$2"; SET_DIR=1; shift ;;
        --user)        SVC_USER="$2"; SET_USER=1; shift ;;
        --http-port)   HTTP_PORT="$2"; SET_HTTP=1; shift ;;
        --high-ports)  SYSLOG_PORT=5514; TRAP_PORT=15162; SET_PORTS=1 ;;
        --raw-days)    RAW_DAYS="$2"; shift ;;
        --message-days) MSG_DAYS="$2"; shift ;;
        --no-service)  DO_SERVICE=0 ;;
        --tls)         DO_TLS=1 ;;
        --tls-cert)    DO_TLS=1; TLS_CERT_SRC="$2"; shift ;;
        --tls-key)     DO_TLS=1; TLS_KEY_SRC="$2"; shift ;;
        --yes|-y)      ASSUME_YES=1 ;;
        # Up to the first paragraph that is not usage, found by its heading
        # rather than a line number that every new flag used to invalidate.
        -h|--help)     sed -n '2,/^# WHY --check EXISTS/p' "$0" | sed '$d'; exit 0 ;;
        *)             echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done
# Alone, --purge is one mistyped word away from dropping a database while
# meaning something else entirely; it only ever qualifies --uninstall.
if [ "$DO_PURGE" = 1 ] && [ "$DO_UNINSTALL" = 0 ]; then
    echo "--purge only means something with --uninstall: sudo $0 --uninstall --purge" >&2
    exit 2
fi
# Checked before anything changes. Retention never keeps less than 7 days
# (RETENTION_MIN_KEEP_DAYS): a shorter horizon is refused by the retention
# function itself, so the service would keep everything and say so hourly.
check_days() {
    [ -z "$2" ] && return 0
    if [[ "$2" =~ ^[0-9]{1,4}$ ]] && [ "$2" -ge 7 ] && [ "$2" -le 3650 ]; then return 0; fi
    echo "--$1 takes a whole number of days from 7 to 3650 (retention never keeps less than 7), got: $2" >&2
    exit 2
}
check_days raw-days "$RAW_DAYS"
check_days message-days "$MSG_DAYS"

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

# WHERE THE DATA LIVES (2026-10-01, the three questions that belong to whoever
# installs). The database's disk, a WAL archive's, and the days kept, which
# together size the disk. The installer cannot move PostgreSQL's data after
# the fact - a separate disk has to be mounted at the data directory BEFORE
# PostgreSQL is installed - so the useful thing it can do is say, before it
# installs anything, where the data is going and what that disk holds, and
# ask once when the answer is the system disk and there is still time to
# choose. Reported by --check too.
pg_base() {   # where the distribution puts PostgreSQL's data
    if [ -d /var/lib/pgsql ] || [ -d /usr/pgsql-18 ]; then printf '/var/lib/pgsql'; else printf '/var/lib/postgresql'; fi
}
pg_data_dir() {
    local d
    d=$(q 'SHOW data_directory')
    if [ -n "$d" ]; then printf '%s' "$d"; else pg_base; fi
}
mount_of() {   # the filesystem a path is on - or will be, from its nearest existing parent
    local p="$1" m
    while [ "$p" != "/" ] && ! sudo -n test -e "$p" 2>/dev/null && [ ! -e "$p" ]; do p=$(dirname "$p"); done
    m=$(df -P "$p" 2>/dev/null | awk 'NR==2{print $6}')
    [ -n "$m" ] || m=$(sudo -n df -P "$p" 2>/dev/null | awk 'NR==2{print $6}')
    printf '%s' "${m:-?}"
}
keep_days() {   # the days a box keeps: this command line, else its env file, else the default
    local given="$1" key="$2" dflt="$3" v
    if [ -n "$given" ]; then printf '%s' "$given"; return; fi
    v="$(prev_env "$key")"
    if [[ "$v" =~ ^[0-9]{1,4}$ ]]; then printf '%s' "$v"; else printf '%s' "$dflt"; fi
}
ON_SYSTEM_DISK=0
storage_report() {
    local dir mnt free raw msg rawgb
    dir=$(pg_data_dir); mnt=$(mount_of "$dir")
    free=$(df -h -P "$mnt" 2>/dev/null | awk 'NR==2{printf "%s free of %s on %s (%s)", $4, $2, $6, $1}')
    ON_SYSTEM_DISK=0; [ "$mnt" = "/" ] && ON_SYSTEM_DISK=1
    say "  data       $dir"
    if [ "$ON_SYSTEM_DISK" = 1 ]; then
        warn "the database shares the system disk: ${free:-unmeasured}"
        warn "a full database then fills the system too; a separate disk mounted at $(pg_base) by UUID,"
        warn "before PostgreSQL is installed, keeps them apart (INSTALL.md, What you need)"
    else
        good "the database has a filesystem of its own: ${free:-unmeasured}"
    fi
    raw=$(keep_days "$RAW_DAYS" RAW_RETENTION_DAYS 14)
    msg=$(keep_days "$MSG_DAYS" MESSAGE_RETENTION_DAYS 30)
    rawgb=$(( (6 * raw + 7) / 14 ))
    say "  keeps      raw samples $raw days, syslog and traps $msg days, the hourly rollup for good (--raw-days, --message-days)"
    say "  sizing     about $rawgb GB of raw samples per 1,000 entities at $raw days, plus 1.6 GB of rollup per 1,000"
    say "             entities a year and about 0.6 KB per syslog or trap message for $msg days"
    say "  WAL        no archive (PostgreSQL's default); one that is turned on later belongs on another disk"
}

# ----- sticky choices: what the existing install already uses ------------------
#
# THE UPGRADE THAT MOVED A BOX TO AN EMPTY DATABASE (2026-09-27, found while
# building the restore). INSTALL.md's upgrade is "re-run with no flags", and
# TLS was already sticky for exactly that reason - but --db, --http-port,
# --high-ports and --user were not. A box installed with --db lab re-run
# without it had DATABASE_URL rewritten to a NEW, EMPTY database called
# rscanvas, created and schema'd on the spot, and the service came back
# healthy on nothing; --high-ports fell back to 514/162, --http-port to 18080
# under every bookmark, and --user to a second service account. So each is
# read back from the install when this command line does not say otherwise.
# Only values of the right shape are taken: a hand-edited env file should
# fall back to the default, never feed a malformed name into SQL.
prev_env() {
    local v=""
    if [ -r "$ENV_FILE" ]; then v=$(sed -n "s/^$1=//p" "$ENV_FILE" | head -1)
    else v=$(sudo -n sed -n "s/^$1=//p" "$ENV_FILE" 2>/dev/null | head -1 || true); fi
    printf '%s' "$v"
}
KEPT=""
if [ "$SET_DB" = 0 ]; then
    u="$(prev_env DATABASE_URL)"; u="${u##*/}"; u="${u%%\?*}"
    if [[ "$u" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] && [ "$u" != "$DB_NAME" ]; then DB_NAME="$u"; KEPT+=" database $u,"; fi
fi
if [ "$SET_HTTP" = 0 ]; then
    p="$(prev_env HTTP_PORT)"
    if [[ "$p" =~ ^[0-9]{1,5}$ ]] && [ "$p" != "$HTTP_PORT" ]; then HTTP_PORT="$p"; KEPT+=" web port $p,"; fi
fi
if [ "$SET_PORTS" = 0 ]; then
    s="$(prev_env SYSLOG_PORT)"; t="$(prev_env TRAP_PORT)"
    if [[ "$s" =~ ^[0-9]{1,5}$ ]] && [[ "$t" =~ ^[0-9]{1,5}$ ]] && { [ "$s" != "$SYSLOG_PORT" ] || [ "$t" != "$TRAP_PORT" ]; }; then
        SYSLOG_PORT="$s"; TRAP_PORT="$t"; KEPT+=" syslog $s and traps $t,"
    fi
fi
if [ "$SET_USER" = 0 ] && [ -f /etc/systemd/system/rscanvas.service ]; then
    s="$(sed -n 's/^User=//p' /etc/systemd/system/rscanvas.service | head -1)"
    if [[ "$s" =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] && [ "$s" != "$SVC_USER" ]; then SVC_USER="$s"; KEPT+=" service user $s,"; fi
fi
# --dir from the unit too (2026-09-28, with --uninstall): an uninstall that
# guessed /opt/rscanvas on a box installed elsewhere would remove the service
# and leave the application behind, and a re-run from /srv/rscanvas died
# "no application at /opt/rscanvas".
if [ "$SET_DIR" = 0 ] && [ -f /etc/systemd/system/rscanvas.service ]; then
    s="$(sed -n 's/^WorkingDirectory=//p' /etc/systemd/system/rscanvas.service | head -1)"
    if [[ "$s" =~ ^/[A-Za-z0-9._/-]+$ ]] && [ "$s" != "$APP_DIR" ]; then APP_DIR="$s"; KEPT+=" directory $s,"; fi
fi

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
    # The layout this installer has written since 2026-10-01 (review F6/F17).
    if [ -d "$APP_DIR" ]; then
        o="$(stat -c %U "$APP_DIR" 2>/dev/null)"
        if [ "$o" = root ]; then say "  app dir    $APP_DIR is root's"
        else warn "$APP_DIR is owned by $o - root runs scripts from it; re-run the installer to give it to root"; fi
    fi
    if [ -f /etc/systemd/system/rscanvas.service ]; then
        if grep -q '^NoNewPrivileges=yes' /etc/systemd/system/rscanvas.service; then say "  sandbox    the unit is hardened (NoNewPrivileges, ProtectSystem=strict)"
        else warn "the rscanvas unit predates its sandbox - re-run the installer"; fi
    fi
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
        exp=$(sudo -n openssl x509 -in "$crt" -noout -enddate 2>/dev/null | cut -d= -f2 || true)
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
        if ls /etc/systemd/system/postgresql*.service.d/60-rscanvas-restart.conf >/dev/null 2>&1; then
            say "  restarts   PostgreSQL restarts itself after a failure (the installer's drop-in)"
        else
            warn "PostgreSQL does not restart itself - after a disk-full it stays down until started by hand; re-run the installer"
        fi
        say "  disk       $(disk_for "$pgdata")"
    fi

    step "storage"
    storage_report

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

# What the application directory is allowed to be. `rm -rf` on a path nobody
# verified is how an uninstaller deletes /opt: a wrong --dir, or a hand-edited
# unit, must leave the directory alone and say why. The install uses it too
# (2026-10-01): it now makes the directory root's, recursively, and a chown -R
# on a wrong --dir is the same accident by another command.
app_dir_state() {
    case "$APP_DIR" in
        ""|/|/opt|/opt/|/usr|/usr/*|/home|/home/|/root|/etc|/etc/*|/var|/srv|/srv/|/bin|/sbin|/lib*|/boot*|/tmp|/tmp/)
            echo refuse; return ;;
    esac
    [[ "$APP_DIR" = /* ]] || { echo refuse; return; }
    [ -e "$APP_DIR" ] || { echo absent; return; }
    [ -d "$APP_DIR" ] && [ -z "$(ls -A "$APP_DIR" 2>/dev/null)" ] && { echo empty; return; }
    { [ -f "$APP_DIR/src/main.ts" ] && grep -q '"name": *"rscanvas"' "$APP_DIR/package.json" 2>/dev/null; } \
        || { echo foreign; return; }
    [ -d "$APP_DIR/.git" ] && { echo checkout; return; }
    echo ours
}

# Where the service may write, and nowhere else (review F6): systemd creates it
# from StateDirectory= and gives it to the service account. Exports go here.
STATE_DIR=/var/lib/rscanvas

# ----- uninstall: take RSCanvas off the box, keep (or purge) its data ----------
#
# KEEP IS THE DEFAULT (the operator's ruling, 2026-09-28). An uninstall is
# often the first half of something else - moving the application, clearing
# a broken install, an upgrade gone wrong - and the one step here that cannot
# be undone is dropping the database. So --uninstall removes what the bundle
# and the installer can put back (the service, the application, the
# capability, the kernel setting) and keeps what they cannot: the database,
# its roles, /etc/rscanvas with RSCANVAS_SECRET, and the service account the
# TLS files belong to. Installing again finds all of it and resumes.
# --purge removes those too, and still never touches backups (the one copy
# that exists for when everything else is gone) or packages (PostgreSQL may
# be holding other people's databases).
#
# Everything is decided and printed BEFORE anything changes, and every
# removal is checked afterwards by looking, the same rule as the install.
if [ "$DO_UNINSTALL" = 1 ]; then
    [ "$(id -u)" = 0 ] || die "run with sudo (removes a service, a directory and a capability)"
    [[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]{0,62}$ ]] || die "database name '$DB_NAME' is not one this installer would have made"
    UNIT_FILE=/etc/systemd/system/rscanvas.service
    SYSCTL_FILE=/etc/sysctl.d/60-rscanvas.conf
    NODE_BIN="$(command -v node || true)"
    BACKUP_DIR=/var/backups/rscanvas

    APP_STATE="$(app_dir_state)"
    PG_UP=0; [ -n "$(q 'SELECT 1')" ] && PG_UP=1
    [ "$DO_PURGE" = 1 ] && [ "$PG_UP" = 0 ] && \
        die "PostgreSQL is not answering, and --purge needs it to drop the database - start it, or run --uninstall alone"
    # The databases this install made: its own, plus the copies
    # rscanvas-backup.sh sets aside (<db>_pre_restore_<stamp>) or tests into.
    DBS=""
    [ "$PG_UP" = 1 ] && DBS="$(q "SELECT string_agg(datname, ' ' ORDER BY datname) FROM pg_database
        WHERE datname = '$DB_NAME' OR datname = '${DB_NAME}_restore_test' OR datname LIKE '${DB_NAME}\\_pre\\_restore\\_%'")"
    # `|| true` is load-bearing: with no match, ls exits 2, pipefail carries
    # that into the assignment, and set -e ended the whole uninstall there -
    # silently, on every box that had never been restored. The drill caught
    # it only on its second pass; the first box had a set-aside copy.
    ASIDE_ETC="$(ls -d /etc/rscanvas.pre-restore-* 2>/dev/null | xargs || true)"
    HAS_CAP=0
    [ -n "$NODE_BIN" ] && getcap "$NODE_BIN" 2>/dev/null | grep -q cap_net_bind_service && HAS_CAP=1
    NBACKUPS="$(ls "$BACKUP_DIR" 2>/dev/null | grep -c '\.tar$' || true)"

    step "what $( [ "$DO_PURGE" = 1 ] && echo 'a PURGE' || echo 'an uninstall' ) removes, and what it keeps"
    if [ -n "$KEPT" ]; then say "  found      the install uses${KEPT%,}"; fi
    [ -f "$UNIT_FILE" ] && say "  removes    the rscanvas service and its unit"
    case "$APP_STATE" in
        ours)     say "  removes    $APP_DIR, the application (the bundle you installed from puts it back)" ;;
        absent)   say "  already    $APP_DIR is not there" ;;
        empty)    say "  removes    $APP_DIR (empty)" ;;
        checkout) warn "$APP_DIR is a git checkout - left where it is" ;;
        foreign)  warn "$APP_DIR does not look like an RSCanvas install - left where it is" ;;
        refuse)   warn "$APP_DIR is not a directory an uninstaller should remove - left where it is" ;;
    esac
    [ "$HAS_CAP" = 1 ] && say "  removes    the port-binding capability the installer gave $NODE_BIN"
    [ -f "$SYSCTL_FILE" ] && say "  removes    $SYSCTL_FILE (the UDP receive buffer setting)"
    ls /etc/systemd/system/postgresql*.service.d/60-rscanvas-restart.conf >/dev/null 2>&1 \
        && say "  removes    the restart-on-failure policy it gave PostgreSQL's unit"
    if [ "$DO_PURGE" = 1 ]; then
        [ -n "$DBS" ] && say "  DROPS      database$( [ "$(wc -w <<< "$DBS")" -gt 1 ] && echo s) $DBS"
        say "  DROPS      the roles rscanvas_owner, rscanvas and rscanvas_admin, unless they own something else"
        [ -d /etc/rscanvas ] && say "  DELETES    /etc/rscanvas - the env file with its secrets, and the TLS pair"
        [ -d "$STATE_DIR" ] && say "  DELETES    $STATE_DIR - the service's working files (exports waiting to be downloaded)"
        [ -n "$ASIDE_ETC" ] && say "  DELETES    $ASIDE_ETC (set aside by a restore)"
        id -u "$SVC_USER" >/dev/null 2>&1 && say "  DELETES    the service account $SVC_USER"
    else
        [ -n "$DBS" ] && say "  keeps      database$( [ "$(wc -w <<< "$DBS")" -gt 1 ] && echo s) $DBS and the three roles"
        [ -d /etc/rscanvas ] && say "  keeps      /etc/rscanvas - RSCANVAS_SECRET, the database passwords, the TLS pair"
        [ -d "$STATE_DIR" ] && say "  keeps      $STATE_DIR - the service's working files"
        id -u "$SVC_USER" >/dev/null 2>&1 && say "  keeps      the service account $SVC_USER, which the TLS files belong to"
    fi
    say "  never      backups ($BACKUP_DIR: ${NBACKUPS:-0}) or packages"
    if [ "$ASSUME_YES" != 1 ]; then
        if [ "$DO_PURGE" = 1 ]; then
            read -r -p "  this cannot be undone - type the database name ($DB_NAME) to purge: " a
            [ "$a" = "$DB_NAME" ] || die "stopped - nothing was changed"
        else
            read -r -p "  continue? [y/N] " a
            case "$a" in y|Y) ;; *) die "stopped - nothing was changed" ;; esac
        fi
    fi

    step "the service"
    if [ -f "$UNIT_FILE" ]; then
        systemctl disable --now rscanvas >/dev/null 2>&1 || true
        rm -f "$UNIT_FILE"
        systemctl daemon-reload
        systemctl reset-failed rscanvas >/dev/null 2>&1 || true
        good "stopped, disabled and removed"
    else
        say "  no rscanvas unit"
    fi
    if [ "$HAS_CAP" = 1 ]; then
        setcap -r "$NODE_BIN"
        good "cap_net_bind_service removed from $NODE_BIN (grant it again if something else here needs node on ports below 1024)"
    fi
    for d in /etc/systemd/system/postgresql@18-main.service.d/60-rscanvas-restart.conf \
             /etc/systemd/system/postgresql-18.service.d/60-rscanvas-restart.conf; do
        if [ -f "$d" ]; then
            rm -f "$d"; rmdir --ignore-fail-on-non-empty "$(dirname "$d")"; systemctl daemon-reload
            good "$d removed - PostgreSQL's restart policy is the system's own again"
        fi
    done
    if [ -f "$SYSCTL_FILE" ]; then
        rm -f "$SYSCTL_FILE"
        good "$SYSCTL_FILE removed - net.core.rmem_max stays $(sysctl -n net.core.rmem_max) until the next reboot"
    fi
    if [ "$APP_STATE" = ours ]; then
        # This script may be running from inside it. Bash already holds the
        # file open, so removing it here does not cut the run short.
        rm -rf -- "$APP_DIR"
        good "$APP_DIR removed"
    elif [ "$APP_STATE" = empty ]; then
        rmdir -- "$APP_DIR" && good "$APP_DIR removed (it was empty)"
    fi

    if [ "$DO_PURGE" = 1 ]; then
        step "the data"
        for d in $DBS; do
            psql_su -c "DROP DATABASE \"$d\" WITH (FORCE)" >/dev/null && good "database $d dropped"
        done
        # rscanvas_admin first: it is a member of rscanvas_owner.
        for r in rscanvas_admin rscanvas rscanvas_owner; do
            [ -n "$(q "SELECT 1 FROM pg_roles WHERE rolname = '$r'")" ] || continue
            owned="$(q "SELECT string_agg(d.datname, ' ') FROM pg_database d JOIN pg_roles r ON r.oid = d.datdba WHERE r.rolname = '$r'")"
            if [ -n "$owned" ]; then warn "role $r kept - it still owns $owned"; continue; fi
            if psql_su -c "DROP ROLE \"$r\"" >/dev/null 2>&1; then good "role $r dropped"
            else warn "role $r kept - it still holds privileges somewhere else on this server"; fi
        done
        if [ -e /etc/rscanvas ]; then rm -rf -- /etc/rscanvas && good "/etc/rscanvas removed"; fi
        if [ -d "$STATE_DIR" ]; then rm -rf -- "$STATE_DIR" && good "$STATE_DIR removed"; fi
        for d in $ASIDE_ETC; do rm -rf -- "$d" && good "$d removed"; done
        rm -rf /var/tmp/rscanvas-restore.* 2>/dev/null || true
        # Only a SYSTEM account with no login shell, which is what this
        # installer creates - never a person's account named by a stray --user.
        if id -u "$SVC_USER" >/dev/null 2>&1; then
            uid="$(id -u "$SVC_USER")"; sh_="$(getent passwd "$SVC_USER" | cut -d: -f7)"
            if [ "$uid" -lt 1000 ] && [ "$uid" -gt 0 ] && [[ "$sh_" = */nologin || "$sh_" = */false ]]; then
                userdel "$SVC_USER" && good "service account $SVC_USER removed"
                getent group "$SVC_USER" >/dev/null 2>&1 && groupdel "$SVC_USER" 2>/dev/null || true
            else
                warn "$SVC_USER is not a system account with no login - left in place"
            fi
        fi
    fi

    step "verify, rather than assume"
    ok=1
    [ -f "$UNIT_FILE" ] && { bad "$UNIT_FILE is still there"; ok=0; }
    [ "$(systemctl is-active rscanvas 2>/dev/null || true)" = active ] && { bad "rscanvas is still running"; ok=0; }
    [ -n "$NODE_BIN" ] && getcap "$NODE_BIN" 2>/dev/null | grep -q cap_net_bind_service && { bad "$NODE_BIN still has cap_net_bind_service"; ok=0; }
    [ "$APP_STATE" = ours ] && [ -e "$APP_DIR" ] && { bad "$APP_DIR is still there"; ok=0; }
    if [ "$DO_PURGE" = 1 ]; then
        left="$(q "SELECT string_agg(datname, ' ') FROM pg_database WHERE datname = '$DB_NAME' OR datname LIKE '${DB_NAME}\\_pre\\_restore\\_%'")"
        [ -n "$left" ] && { bad "database(s) still present: $left"; ok=0; }
        [ -e /etc/rscanvas ] && { bad "/etc/rscanvas is still there"; ok=0; }
    elif [ -n "$DBS" ]; then
        [ -n "$(q "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'")" ] || { bad "database $DB_NAME is GONE - it should have been kept"; ok=0; }
        [ -f "$ENV_FILE" ] || { bad "$ENV_FILE is GONE - it should have been kept"; ok=0; }
    fi
    [ "$ok" = 1 ] && good "the service is gone$( [ "$DO_PURGE" = 1 ] && echo ' and so is its data' || echo ', and the data is where it was')"

    printf '\n%s================ RSCanvas is uninstalled ================%s\n' "$B" "$N"
    if [ "$DO_PURGE" = 0 ] && { [ -n "$DBS" ] || [ -d /etc/rscanvas ]; }; then
        say "  Kept, so installing again picks up where this left off:"
        [ -n "$DBS" ] && say "    database   $DBS"
        [ -d /etc/rscanvas ] && say "    config     /etc/rscanvas"
        say "  To install again: extract a bundle into $APP_DIR and run rscanvas-setup.sh."
        say "  To remove the data as well, from any extracted bundle:"
        say "    sudo ./rscanvas-setup.sh --uninstall --purge"
    fi
    [ "${NBACKUPS:-0}" -gt 0 ] && say "  $BACKUP_DIR holds $NBACKUPS backup(s) - yours to keep or delete."
    # INSTALL.md says to run this from inside the application directory,
    # which this just removed - so the caller's shell is now standing in it.
    case "$PWD/" in "$APP_DIR"/*) [ "$APP_STATE" = ours ] && say "  Your shell is still in $APP_DIR, which no longer exists: cd somewhere else." ;; esac
    say "  The installer also added packages, left in place because other software may use"
    say "  them: postgresql-18, nodejs and fping, with the PostgreSQL and NodeSource apt"
    say "  repositories. Removing postgresql-18 deletes EVERY database on this box."
    say ""
    [ "$ok" = 1 ] || die "uninstall finished with the failures above"
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
if [ -n "$KEPT" ]; then good "kept from the existing install:${KEPT%,}"; fi

if [ "$SYSLOG_PORT" -lt 1024 ] || [ "$TRAP_PORT" -lt 1024 ] || [ "$HTTP_PORT" -lt 1024 ]; then
    # No question any more: the capability is the SERVICE's, granted by its
    # systemd unit (AmbientCapabilities), not the node binary's - which gave
    # every local user's node programs the privileged ports (review F17).
    good "privileged ports (syslog $SYSLOG_PORT, traps $TRAP_PORT, web $HTTP_PORT): granted to the service by its unit, never root"
fi

step "storage"
storage_report
# Asked only while the answer can still change something: PostgreSQL not yet
# installed, so a data disk mounted now is where it will put the database.
if [ "$ON_SYSTEM_DISK" = 1 ] && [ ! -d "$(pg_base)" ] && [ "$ASSUME_YES" != 1 ]; then
    read -r -p "  install the database on the system disk? [Y/n] " a
    case "$a" in n|N) die "stopped - mount a data disk at $(pg_base), then run this again" ;; esac
fi

step "packages"
# NOTHING TO FETCH, NOTHING FETCHED (2026-09-28, the offline drill). Upgrades
# and restores re-run this script on a box that already has everything, and
# on a network that silently drops outbound traffic `apt-get update` waited
# out every mirror's timeout: 200 s of no output in this step, where a
# connected box takes 20, on exactly the boxes - air-gapped ones - where an
# installer that looks hung is the worst thing to meet. It did finish (apt
# only warns), but nothing it did was needed. So when every runtime piece is
# already here, the package manager is not touched at all. Anything missing,
# and it runs exactly as before - the network is then genuinely required.
have_everything() {
    local c
    for c in curl openssl setcap fping; do command -v "$c" >/dev/null || return 1; done
    command -v node >/dev/null && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || return 1
    command -v psql >/dev/null && q 'SHOW server_version' | grep -qE '^1[89]' || return 1
}
if have_everything; then
    good "Node 22+, PostgreSQL 18, fping and the tools are all installed - the package mirrors are not contacted"
elif [ "$PKG" = apt ]; then
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

step "postgresql restarts itself"
# THE DISK-FULL DRILL (2026-09-28, rs-test-2). With the root filesystem full,
# PostgreSQL PANICked writing WAL, its own crash recovery then failed for the
# same reason, and it shut down - correctly. Freeing the space brought
# nothing back: the distribution's unit has Restart=no, so a monitoring box
# stayed blind until a human noticed and ran systemctl start. This drop-in
# makes the cluster restart on failure every 10 s, for as long as it takes:
# harmless while the disk is still full (each attempt fails at once), and
# back within 10 s of the space returning. It changes nothing else about
# the unit, and --uninstall removes it.
PG_UNIT=postgresql@18-main.service
[ "$PKG" = dnf ] && PG_UNIT=postgresql-18.service
PG_DROPIN="/etc/systemd/system/${PG_UNIT}.d/60-rscanvas-restart.conf"
if systemctl cat "$PG_UNIT" >/dev/null 2>&1; then
    install -d "$(dirname "$PG_DROPIN")"
    cat > "$PG_DROPIN" <<'EOF'
# Written by rscanvas-setup.sh: restart the cluster when it dies, and never
# give up - a disk that fills and is then freed must not leave it down.
[Unit]
StartLimitIntervalSec=0
[Service]
Restart=on-failure
RestartSec=10s
EOF
    systemctl daemon-reload
    good "$PG_UNIT restarts itself after a failure (Restart=on-failure, every 10 s)"
else
    warn "no $PG_UNIT unit here - PostgreSQL's restart policy is left as the system has it"
fi

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
# THE CODE IS ROOT'S, THE SERVICE WRITES ONLY ITS STATE DIRECTORY (2026-10-01,
# review F6). The service account owned $APP_DIR, and root runs scripts from
# it - this installer on every upgrade, rscanvas-backup.sh from root's crontab.
# The service is the component that parses hostile input from the network, so
# code execution inside it could rewrite a script root would run, and become
# root within a day. Now root owns the code and the service can write only
# $STATE_DIR (exports); the systemd unit below enforces the same with
# ProtectSystem=strict. A wrong --dir must not be made root's recursively.
case "$(app_dir_state)" in
    refuse)  die "--dir $APP_DIR is not a directory this installer will take over - choose one of its own, such as /opt/rscanvas" ;;
    foreign) die "$APP_DIR holds something that is not RSCanvas - extract the bundle into an empty or new directory" ;;
    checkout) warn "$APP_DIR is a git checkout; it becomes root's like any install, so commit or pull there as root (or install from a bundle)" ;;
esac
if id -u "$SVC_USER" >/dev/null 2>&1; then
    # Its home was the application directory, which it no longer owns. With
    # the service running usermod refuses; the service step retries it with
    # the service stopped, just before the restart it makes anyway.
    if [ "$(getent passwd "$SVC_USER" | cut -d: -f6)" != "$STATE_DIR" ]; then
        usermod -d "$STATE_DIR" "$SVC_USER" 2>/dev/null && good "$SVC_USER's home is now $STATE_DIR"
    fi
else
    useradd --system --home-dir "$STATE_DIR" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
fi
install -d -o root -g root -m 0755 "$APP_DIR"
install -d -m 0700 /etc/rscanvas
good "$SVC_USER, $APP_DIR (root's), $STATE_DIR (the service's)"

step "secrets"
# NEVER REGENERATE. An existing value is read back and reused, so re-running
# this script cannot lock anyone out of an instance they already have. Only the
# absent ones are minted. This is the single most important idempotency
# property in the file.
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"; chown root:root "$ENV_FILE"
read_secret() { sed -n "s/^$1=//p" "$ENV_FILE" | head -1; }
# WRITTEN BY awk, WITH THE VALUE AS DATA (2026-10-01, review F5). This was
# `sed -i "s|^$k=.*|$k=$v|"`, which made the value part of a sed PROGRAM: a
# value of `x|e;#` ended the substitution and added sed's e flag, which runs
# the line as a shell command - as root. The values come back from the env
# file, and --restore puts a backup's env file in place before re-running
# this script, so a tampered backup was root by this door too. awk reads the
# key and value from its environment, where nothing is syntax.
set_secret() {
    local k="$1" v="$2" tmp
    case "$v" in *$'\n'*|*$'\r'*) die "refusing to write $k: its value contains a line break" ;; esac
    tmp="$(mktemp "$ENV_FILE.XXXXXX")"
    K="$k" V="$v" awk '
        BEGIN { k = ENVIRON["K"]; v = ENVIRON["V"]; n = length(k) + 1; seen = 0 }
        substr($0, 1, n) == k "=" { print k "=" v; seen = 1; next }
        { print }
        END { if (!seen) print k "=" v }' "$ENV_FILE" > "$tmp" || { rm -f "$tmp"; die "could not write $k to $ENV_FILE"; }
    chmod 600 "$tmp"; chown root:root "$tmp"
    mv "$tmp" "$ENV_FILE"
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
# The two database passwords go into superuser SQL ('...' below) and into a
# URL, so they must be of a shape that is neither (review F5: a restored env
# file is a backup's, and a backup is input). This installer only ever mints
# hex; anything else was edited in by hand or arrived in a backup.
for pw in "RSCANVAS_DB_PASSWORD:$DB_PASS" "RSCANVAS_ADMIN_DB_PASSWORD:$ADMIN_PASS_DB"; do
    [[ "${pw#*:}" =~ ^[A-Za-z0-9._~+=-]{12,128}$ ]] \
        || die "${pw%%:*} in $ENV_FILE is not a password this installer would write (12 to 128 of A-Z a-z 0-9 . _ ~ + = -) - fix or remove that line and re-run"
done
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
# WHERE EXPORTS ARE WRITTEN: the state directory (review F6). The code's
# default is ./data/exports, inside the application directory, which the
# service can no longer write - so it is always written here. A path an
# operator chose (a bigger disk) is kept, and the unit is told to allow it.
SPOOL_DIR="$(read_secret EXPORT_SPOOL_DIR)"
if [[ ! "$SPOOL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || [[ "$SPOOL_DIR" = "$APP_DIR"* ]]; then
    [ -n "$SPOOL_DIR" ] && warn "EXPORT_SPOOL_DIR=$SPOOL_DIR is inside $APP_DIR or not an absolute path - exports move to $STATE_DIR/exports"
    SPOOL_DIR="$STATE_DIR/exports"
    set_secret EXPORT_SPOOL_DIR "$SPOOL_DIR"
fi
if [ -n "$RAW_DAYS" ]; then set_secret RAW_RETENTION_DAYS "$RAW_DAYS"; good "raw samples kept $RAW_DAYS days (RAW_RETENTION_DAYS)"; fi
if [ -n "$MSG_DAYS" ]; then set_secret MESSAGE_RETENTION_DAYS "$MSG_DAYS"; good "syslog and traps kept $MSG_DAYS days (MESSAGE_RETENTION_DAYS)"; fi
# RETENTION ON, FOR NEW INSTALLS ONLY (the operator's ruling, 2026-09-28). The
# application defaults to a dry run - it reports what it would drop and drops
# nothing - and until now nothing ever changed that on an installed box, so
# every one of them grew until its disk was full. A NEW install (no database
# credential yet) gets real retention written down where the operator can
# see and change it. An existing install keeps whatever it has, set or not:
# switching a running box from keeping everything to deleting is its owner's
# decision, and /api/health now says when a dry run is keeping data past its
# date. Written only when absent, so a deliberate 1 is never overwritten.
if [ "$DB_NEW" = 1 ] && ! grep -q '^RETENTION_DRY_RUN=' "$ENV_FILE"; then
    set_secret RETENTION_DRY_RUN 0
    good "retention on: raw samples kept $(keep_days "$RAW_DAYS" RAW_RETENTION_DAYS 14) days, messages $(keep_days "$MSG_DAYS" MESSAGE_RETENTION_DAYS 30), the hourly rollup always (RETENTION_DRY_RUN=0)"
fi
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
# The pair the installer manages, readable by the service and nobody else,
# however it arrived - minted, supplied, kept, or put back by a restore, which
# extracts without the archive's owners (rscanvas-backup.sh, review F5).
tls_pair_perms() {
    install -d -m 0750 -o root -g "$SVC_USER" "$TLS_DIR"
    if [ -f "$TLS_DIR/key.pem" ]; then chown root:"$SVC_USER" "$TLS_DIR/key.pem"; chmod 0640 "$TLS_DIR/key.pem"; fi
    if [ -f "$TLS_DIR/cert.pem" ]; then chown root:"$SVC_USER" "$TLS_DIR/cert.pem"; chmod 0644 "$TLS_DIR/cert.pem"; fi
}
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
        tls_pair_perms
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
    [ "$(read_secret TLS_CERT)" = "$TLS_DIR/cert.pem" ] && tls_pair_perms
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
      sudo tar -xzf rscanvas-<stamp>-<commit>.tar.gz -C $APP_DIR
    then re-run. This script deliberately does not fetch code: an installer that
    chooses your version is an installer that can change it under you."
fi
# Root's, readable by everyone, writable by nobody else (the service account
# step says why). Recursive on every run, because a bundle extracted as root
# keeps its archive's owners, and an install from before this change left the
# service account owning every file.
chown -R root:root "$APP_DIR"
chmod -R u+rwX,go+rX,go-w "$APP_DIR"
# The spool that lived inside the code. Exports are held in memory, so its
# files were orphans the moment the service last restarted - nothing can
# serve them - and the directory is root's now.
if [ -d "$APP_DIR/data/exports" ]; then
    n="$(find "$APP_DIR/data/exports" -maxdepth 1 -type f -name '*.csv' | wc -l)"
    find "$APP_DIR/data/exports" -maxdepth 1 -type f -name '*.csv' -delete
    rmdir "$APP_DIR/data/exports" "$APP_DIR/data" 2>/dev/null || true
    good "the old export spool in $APP_DIR/data removed ($n orphaned file(s)); exports now go to $SPOOL_DIR"
fi
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

# PRESENT, NOT EXECUTABLE (2026-10-01, review F13a). The test was -x, and git
# stored the script 100644: a bundle built from a Linux clone skipped the
# hardening with a warning - a fresh install then failed later and less
# clearly, an upgrade silently skipped the repair. It runs through bash, so
# its mode never mattered; and a bundle without it is incomplete, not optional.
[ -f "$APP_DIR/tools/harden-roles.sh" ] \
    || die "tools/harden-roles.sh is missing from $APP_DIR - the bundle is incomplete; extract a whole one and re-run"
# PGPASSWORD is the app role's GENERATED credential, not the dev default.
# Without it the script's own verification cannot log in, and since that
# verification is the part which proves the permission model rather than
# asserting it, a silent skip would be worse than the failure.
PGPASSWORD="$DB_PASS" bash "$APP_DIR/tools/harden-roles.sh" "$DB_NAME"
good "roles hardened and verified"

if [ "$DO_SERVICE" = 1 ]; then
    step "service"
    # THE UNIT IS THE SANDBOX (2026-10-01, review F17; every line below was
    # measured on Ubuntu 24.04, systemd 255, before it was written).
    #
    # Capabilities: CAP_NET_BIND_SERVICE only when a port is below 1024, and
    # CAP_NET_RAW always - for fping, which the collector spawns. Both are
    # the SERVICE's (ambient), never a file capability on the system-wide
    # node, which gave every local user's node programs the privileged ports
    # and was dropped by any upgrade of the nodejs package.
    #
    # Why node holds CAP_NET_RAW at all: under NoNewPrivileges - which every
    # seccomp-based setting below implies anyway - a program can gain no
    # capability its parent did not hold, so fping's own file capability is
    # void when node spawns it ("can't create socket"). fping 5.1's
    # unprivileged ICMP mode, the alternative, gets no replies at all (also
    # measured). The trade is deliberate: NoNewPrivileges closes the setuid
    # route to root (sudo, pkexec and their bugs) for anything running as
    # the service, and raw IP sockets with no link layer (AF_PACKET is not
    # among RestrictAddressFamilies) add little to what the service already
    # does on the network.
    #
    # Filesystem: everything read-only (ProtectSystem=strict) except the
    # state directory, which systemd creates and gives to the service, and an
    # export spool an operator moved elsewhere. Not set, deliberately:
    # MemoryDenyWriteExecute (V8 compiles code at run time) and a system call
    # filter (libuv's io_uring use varies by kernel; not worth a mystery hang).
    CAPS="CAP_NET_RAW"
    if [ "$SYSLOG_PORT" -lt 1024 ] || [ "$TRAP_PORT" -lt 1024 ] || [ "$HTTP_PORT" -lt 1024 ]; then
        CAPS="CAP_NET_BIND_SERVICE CAP_NET_RAW"
    fi
    RW_SPOOL=""
    case "$SPOOL_DIR" in
        "$STATE_DIR"|"$STATE_DIR"/*) ;;
        *) install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$SPOOL_DIR"; RW_SPOOL="ReadWritePaths=$SPOOL_DIR" ;;
    esac
    PROTECT_HOME=yes
    case "$APP_DIR" in /home/*|/root/*) PROTECT_HOME=read-only ;; esac
    # The old way, undone: a capability this installer put on node.
    NODE_BIN="$(command -v node)"
    if getcap "$NODE_BIN" 2>/dev/null | grep -q cap_net_bind_service; then
        setcap -r "$NODE_BIN"
        good "the port capability an earlier install put on $NODE_BIN removed - the unit grants it to the service alone"
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

# The sandbox - rscanvas-setup.sh, the service step, says why each line is
# here and why two common ones are not.
AmbientCapabilities=$CAPS
CapabilityBoundingSet=$CAPS
NoNewPrivileges=yes
StateDirectory=rscanvas
StateDirectoryMode=0750
UMask=0027
ProtectSystem=strict
$RW_SPOOL
ProtectHome=$PROTECT_HOME
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectKernelLogs=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
RestrictNamespaces=yes
LockPersonality=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable rscanvas >/dev/null 2>&1
    # The home move the account step could not make: usermod refuses while
    # the account has a running process, and an upgrade runs this script with
    # the service up (production, 2026-10-01). It is restarted next anyway,
    # so stopping it first costs nothing.
    if [ "$(getent passwd "$SVC_USER" | cut -d: -f6)" != "$STATE_DIR" ]; then
        systemctl stop rscanvas 2>/dev/null || true
        if usermod -d "$STATE_DIR" "$SVC_USER" 2>/dev/null; then good "$SVC_USER's home is now $STATE_DIR"
        else warn "could not move $SVC_USER's home to $STATE_DIR (it has no login, so nothing depends on it)"; fi
    fi
    systemctl restart rscanvas
    good "rscanvas.service enabled and started"
fi

step "verify, rather than assume"
ok=1
sleep 8
if [ "$DO_SERVICE" = 1 ]; then
    [ "$(systemctl is-active rscanvas)" = active ] || { bad "rscanvas.service is $(systemctl is-active rscanvas)"; ok=0; }
    [ "$(systemctl show rscanvas -p NoNewPrivileges --value 2>/dev/null)" = yes ] \
        && good "the unit's sandbox is in force (no new privileges, read-only system, capabilities: $CAPS)" \
        || { bad "rscanvas.service is running without its sandbox"; ok=0; }
fi
if sudo -u "$SVC_USER" test -w "$APP_DIR" 2>/dev/null; then bad "$SVC_USER can write $APP_DIR - root runs scripts from there"; ok=0
else good "$APP_DIR is root's; $SVC_USER can write only $STATE_DIR$( [ -n "${RW_SPOOL:-}" ] && echo " and $SPOOL_DIR" )"; fi
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
say "  keeps      raw samples $(keep_days "$RAW_DAYS" RAW_RETENTION_DAYS 14) days, syslog and traps $(keep_days "$MSG_DAYS" MESSAGE_RETENTION_DAYS 30) days"
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
