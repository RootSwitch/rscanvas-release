#!/usr/bin/env bash
# rscanvas-backup.sh
#
# Back up an RSCanvas install to ONE file, and restore one onto a box.
#
#   sudo ./rscanvas-backup.sh                  back up (to /var/backups/rscanvas)
#   sudo ./rscanvas-backup.sh --full           ...including raw samples and messages
#   sudo ./rscanvas-backup.sh --test FILE      restore FILE into a scratch database
#                                              on THIS box, compare, drop it
#   sudo ./rscanvas-backup.sh --restore FILE   make this box the one in FILE
#   ./rscanvas-backup.sh --list FILE           print what FILE holds
#
#   --out DIR    where the backup is written     (default: /var/backups/rscanvas)
#   --dir DIR    the installed application       (default: this script's directory)
#   --yes        do not prompt before a restore
#
# WHAT A BACKUP HOLDS. The database, taken as one consistent snapshot while
# the service keeps running, and /etc/rscanvas - the env file and the TLS
# pair. The second half is not optional: the env file holds RSCANVAS_SECRET,
# without which every stored SNMP credential is ciphertext nobody can read,
# and a restore that brings the database back without it looks complete
# until the first poll. The archive therefore holds SECRETS: it is written
# 0600 root, and belongs wherever your other secrets live.
#
# By default the raw per-poll samples and the syslog/trap messages are left
# out. They are the bulk - tens of gigabytes on a busy install - and the
# cheapest thing to lose: raw samples age out after days anyway, and the
# hourly rollup that keeps the long-term trend (samples_hourly) IS kept.
# --full takes everything.
#
# A RESTORE is: install the same RSCanvas (or newer) on the target first,
# then --restore. The current database is RENAMED aside and the current
# /etc/rscanvas MOVED aside - nothing is deleted - the backup goes in, and
# the installer runs again to bring the schema forward, re-apply the role
# hardening and restart the service. What it prints at the end says how to
# drop the set-aside copies once you are satisfied.
#
# Every step is checked by reading the data back, never by an exit code: this
# project's own restore drills caught three dumps that exited 0 while losing
# data (a dependency not followed, a table pattern that also matched the
# rollup, a table list gone stale within hours), so a backup here counts
# every table inside the same snapshot it dumps, and a restore is compared
# against those counts, row for row, before the service starts on it.

set -euo pipefail

OUT_DIR=/var/backups/rscanvas
APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
MODE=backup
FILE=""
FULL=0
ASSUME_YES=0
ENV_DIR=/etc/rscanvas
ENV_FILE=$ENV_DIR/rscanvas.env
UNIT=rscanvas
FORMAT=1

# THE BULK, as pg_dump --exclude-table-data patterns, and the ONE place they
# are written: is_bulk below matches with the same glob, and the dump's own
# table of contents is checked against both afterwards. `samples*` would be
# the obvious shorthand and is the trap the runbook recorded - it also
# matches samples_hourly, the rollup nothing can regenerate.
BULK_PATTERNS=(messages 'messages_2*' samples 'samples_2*')

B=$'\033[1m'; Y=$'\033[33m'; R=$'\033[31m'; G=$'\033[32m'; N=$'\033[0m'
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s==> %s%s\n' "$B" "$*" "$N"; }
warn() { printf '%s  ! %s%s\n' "$Y" "$*" "$N"; }
good() { printf '%s  ok%s %s\n' "$G" "$N" "$*"; }
die()  { printf '%sFATAL: %s%s\n' "$R" "$*" "$N" >&2; exit 1; }

# ----- the pure half, which --self-test holds --------------------------------

is_bulk() {
    local t="$1" p
    for p in "${BULK_PATTERNS[@]}"; do
        # shellcheck disable=SC2254 - the pattern IS meant to glob
        case "$t" in $p) return 0 ;; esac
    done
    return 1
}

# The database a DATABASE_URL names: the last path segment, before any query.
db_from_url() {
    local u="${1##*/}"
    printf '%s' "${u%%\?*}"
}

# The highest schema slice a tree carries - the version of the schema it
# expects. A backup records its own, so a restore can refuse a backup taken
# by NEWER code than the code about to run on it.
max_slice() {
    local d="$1" n best=0 f
    for f in "$d"/sql/slice*.sql; do
        [ -e "$f" ] || continue
        n="${f##*/slice}"; n="${n%%[!0-9]*}"
        [ -n "$n" ] && [ "$n" -gt "$best" ] && best=$n
    done
    printf '%s' "$best"
}

# A BACKUP IS INPUT, NOT A SCRIPT (2026-10-01, review F5). SHA256SUMS lives
# inside the archive, so it proves the file is whole, not that this script
# wrote it - a manifest edited along with its checksum passed. Its values then
# reached root's shell and superuser SQL: `heap_bytes: a[$(cmd)]` ran cmd as
# root through $(( )) on --test, before any prompt. So every manifest line must
# have the shape this script writes, and an archive with any other line is
# refused before a single value is read.
manifest_line_ok() {
    local l="$1" re
    for re in \
        '^format: [0-9]{1,3}$' \
        '^created: [0-9]{8}T[0-9]{6}Z$' \
        '^host: [A-Za-z0-9._-]{0,253}$' \
        '^addresses: [0-9A-Za-z:. ]*$' \
        '^mode: (full \(everything\)|standard \(raw samples and messages left out\))$' \
        '^database: [a-z_][a-z0-9_]{0,62}$' \
        '^postgres: [A-Za-z0-9 ._()+~-]{0,128}$' \
        '^app_version: [A-Za-z0-9.+-]{0,64}$' \
        '^app_commit: [A-Za-z0-9-]{0,64}$' \
        '^schema_slice: [0-9]{1,4}$' \
        '^heap_bytes: [0-9]{1,15}$' \
        '^dump_seconds: [0-9]{1,9}$' \
        '^rows [a-z0-9_]{1,63} [0-9]{1,15}$' \
        '^skipped [a-z0-9_]{1,63} ~[0-9]{1,15}$'; do
        [[ "$l" =~ $re ]] && return 0
    done
    return 1
}
# The whole manifest: every line of a known shape, and the fields a restore
# reads present exactly once (a second `database:` would make one value two).
manifest_ok() {
    local f="$1" l k
    while IFS= read -r l || [ -n "$l" ]; do
        manifest_line_ok "$l" || { printf 'unexpected manifest line: %q' "${l:0:80}"; return 1; }
    done < "$f"
    for k in format database schema_slice heap_bytes; do
        [ "$(grep -c "^$k: " "$f")" = 1 ] || { printf 'the manifest must say %s exactly once' "$k"; return 1; }
    done
}

# The configuration archive's listing (tar -tv), member by member: only plain
# files and directories, under the one top directory it was taken from, with
# no set-id or sticky bits, no links and no '..'. tar -xpf as root restored
# whatever the archive said, wherever it said - `cron.d/x` or `sudoers.d/x`
# landed in /etc (review F5).
etc_listing_ok() {
    local top="$1" perms owner size day time name extra
    while read -r perms owner size day time name extra; do
        [ -z "$perms" ] && continue
        [ -z "$extra" ] || { printf 'a member with a space, or a link: %q' "$name $extra"; return 1; }
        case "$perms" in -*|d*) ;; *) printf 'not a plain file or directory: %q (%s)' "$name" "$perms"; return 1 ;; esac
        case "$perms" in *[sStT]*) printf 'a set-id or sticky member: %q (%s)' "$name" "$perms"; return 1 ;; esac
        [[ "$name" =~ ^$top(/[A-Za-z0-9._-]+)*/?$ ]] || { printf 'a member outside %s/: %q' "$top" "$name"; return 1; }
        case "/$name/" in */../*|*/./*) printf 'a member with a dot path: %q' "$name"; return 1 ;; esac
    done
}

self_test() {
    local fail=0
    t() { if [ "$2" = "$3" ]; then echo "  ok   $1"; else echo "  FAIL $1: got '$2', wanted '$3'"; fail=1; fi; }
    b() { if is_bulk "$1"; then echo yes; else echo no; fi; }
    echo "is_bulk - the four patterns, and the trap they must not fall into:"
    t 'the messages parent is bulk'             "$(b messages)" yes
    t 'a daily messages partition is bulk'      "$(b messages_20260927)" yes
    t 'the samples parent is bulk'              "$(b samples)" yes
    t 'a daily samples partition is bulk'       "$(b samples_20260927)" yes
    t 'the hourly rollup is NOT bulk'           "$(b samples_hourly)" no
    t 'a rollup partition is NOT bulk'          "$(b samples_hourly_202609)" no
    t 'ping history is kept'                    "$(b ping_samples)" no
    t 'users are kept'                          "$(b users)" no
    echo "db_from_url:"
    t 'the last path segment'                   "$(db_from_url 'postgres://rscanvas:x@localhost:5432/rscanvas')" rscanvas
    t 'a query string is not the name'          "$(db_from_url 'postgres://a:b@h:5432/rsc_lab?sslmode=disable')" rsc_lab
    echo "max_slice:"
    local d; d="$(mktemp -d)"; mkdir -p "$d/sql"
    touch "$d/sql/slice9.sql" "$d/sql/slice54.sql" "$d/sql/slice53-retention.sql" "$d/sql/bootstrap.sql"
    t 'numeric, not lexical, and suffixes ignored' "$(max_slice "$d")" 54
    rm -rf "${d:?}"
    t 'an empty tree is slice 0'                "$(max_slice /nonexistent)" 0
    echo "manifest_line_ok - what this script writes, and what it must refuse (review F5):"
    m() { if manifest_line_ok "$1"; then echo ok; else echo refused; fi; }
    t 'a heap size'                             "$(m 'heap_bytes: 123456789')" ok
    t 'the arithmetic injection'                "$(m 'heap_bytes: a[$(echo pwned >&2)]')" refused
    t 'a database name'                         "$(m 'database: rscanvas')" ok
    t 'a quote in a database name'              "$(m "database: x'; DROP DATABASE postgres; --")" refused
    t 'a rows line'                             "$(m 'rows samples_hourly_202609 12345')" ok
    t 'a rows line with SQL in the name'        "$(m 'rows a"b 1')" refused
    t 'a skipped line'                          "$(m 'skipped samples_20260924 ~38191623')" ok
    t 'a skipped line with a comment trick'     "$(m 'skipped x/**/ ~1')" refused
    t 'the standard mode'                       "$(m 'mode: standard (raw samples and messages left out)')" ok
    t 'the full mode'                           "$(m 'mode: full (everything)')" ok
    t 'the server version'                      "$(m 'postgres: 18.6 (Ubuntu 18.6-1.pgdg24.04+2)')" ok
    t 'an empty commit (a bundle-less tree)'    "$(m 'app_commit: ')" ok
    t 'a line of no known shape'                "$(m 'restore_hook: rm -rf /')" refused
    local mf; mf="$(mktemp)"
    printf 'format: 1\ndatabase: rscanvas\nschema_slice: 56\nheap_bytes: 100\nrows users 3\n' > "$mf"
    t 'a whole manifest'                        "$(manifest_ok "$mf" >/dev/null && echo ok || echo refused)" ok
    printf 'database: other\n' >> "$mf"
    t 'database given twice'                    "$(manifest_ok "$mf" >/dev/null && echo ok || echo refused)" refused
    rm -f "$mf"
    echo "etc_listing_ok - the configuration archive's members:"
    e() { if printf '%s\n' "$1" | etc_listing_ok rscanvas >/dev/null; then echo ok; else echo refused; fi; }
    t 'the env file'                            "$(e '-rw------- root/root 1234 2026-09-27 10:00 rscanvas/rscanvas.env')" ok
    t 'the tls directory'                       "$(e 'drwxr-x--- root/rscanvas 0 2026-09-27 10:00 rscanvas/tls/')" ok
    t 'a file outside it'                       "$(e '-rw-r--r-- root/root 10 2026-09-27 10:00 cron.d/x')" refused
    t 'a dot-dot path'                          "$(e '-rw-r--r-- root/root 10 2026-09-27 10:00 rscanvas/../sudoers.d/x')" refused
    t 'a symbolic link'                         "$(e 'lrwxrwxrwx root/root 0 2026-09-27 10:00 rscanvas/x -> /etc/shadow')" refused
    t 'a hard link'                             "$(e 'hrw-r--r-- root/root 0 2026-09-27 10:00 rscanvas/x link to rscanvas/y')" refused
    t 'a setuid file'                           "$(e '-rwsr-xr-x root/root 10 2026-09-27 10:00 rscanvas/x')" refused
    t 'a device'                                "$(e 'crw-r--r-- root/root 0,0 2026-09-27 10:00 rscanvas/x')" refused
    [ "$fail" = 0 ] && echo "PASS" || { echo "FAIL"; exit 1; }
}

# ----- options ----------------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --full)      FULL=1 ;;
        --out)       OUT_DIR="$2"; shift ;;
        --dir)       APP_DIR="$2"; shift ;;
        --test)      MODE=test; FILE="${2:-}"; shift ;;
        --restore)   MODE=restore; FILE="${2:-}"; shift ;;
        --list)      MODE=list; FILE="${2:-}"; shift ;;
        --yes|-y)    ASSUME_YES=1 ;;
        --self-test) self_test; exit 0 ;;
        -h|--help)   sed -n '2,42p' "$0"; exit 0 ;;
        *)           echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

if [ "$MODE" = list ]; then
    [ -r "$FILE" ] || die "cannot read $FILE"
    tar -xOf "$FILE" MANIFEST.txt
    exit 0
fi

[ "$(id -u)" = 0 ] || die "run with sudo (reads /etc/rscanvas and the database as postgres)"

pg()    { sudo -u postgres psql -qAtX -v ON_ERROR_STOP=1 "$@"; }
pgdb()  { local d="$1"; shift; pg -d "$d" "$@"; }
env_get() { sed -n "s/^$1=//p" "$2" | head -1; }
db_exists() { [ "$(pg -c "SELECT 1 FROM pg_database WHERE datname = '$1'")" = 1 ]; }
# THE RESTORED DATABASE IS READ AS rscanvas_admin, NEVER AS THE SUPERUSER
# (review F5). A dump is SQL, and a tampered one restored or even counted as
# postgres runs with everything postgres can do - COPY ... TO PROGRAM is a
# shell, and a "table" the counts read can be a view over any function.
# rscanvas_admin is the installer's schema role, a member of the owner, so
# owners and grants restore as before; pg_trgm is a trusted extension it may
# create. Over TCP with the box's own credential, which restore_preflight reads.
RESTORE_PW=""
pg_admin() {
    local d="$1"; shift
    PGPASSWORD="$RESTORE_PW" psql -qAtX -v ON_ERROR_STOP=1 -h localhost -p 5432 -U rscanvas_admin -w -d "$d" "$@"
}

# Leaf tables (the ones that hold rows; a partitioned parent holds none) with
# their exact counts, as "name count" lines. Names are checked before they are
# put into SQL: they come from the catalog, but a restore reads them from a
# file somebody may have handed over.
count_tables() {
    local db="$1"; shift
    local sql="" t
    for t in "$@"; do
        [[ "$t" =~ ^[a-z0-9_]+$ ]] || die "unexpected table name '$t'"
        sql+="${sql:+ UNION ALL }SELECT '$t', count(*) FROM public.\"$t\""
    done
    [ -n "$sql" ] || return 0
    pg_admin "$db" -F' ' -c "$sql"
}

# Unpack an archive into a private directory and prove it is whole before
# anything reads it: every file's checksum, and a manifest this script wrote.
unpack() {
    [ -r "$FILE" ] || die "cannot read $FILE"
    STAGE="$(mktemp -d /var/tmp/rscanvas-restore.XXXXXX)"
    trap 'rm -rf "${STAGE:?}"' EXIT
    local need have
    need=$(( $(stat -c %s "$FILE") / 1048576 + 64 ))
    have=$(df --output=avail -BM /var/tmp | tail -1 | tr -dc 0-9)
    [ "$have" -ge "$need" ] || die "unpacking needs ${need} MB in /var/tmp and ${have} MB are free"
    tar -xf "$FILE" -C "$STAGE" || die "$FILE is not a readable archive"
    [ -f "$STAGE/MANIFEST.txt" ] && [ -f "$STAGE/SHA256SUMS" ] || die "$FILE is not an RSCanvas backup (no manifest)"
    (cd "$STAGE" && sha256sum --quiet -c SHA256SUMS) || die "$FILE is damaged - a checksum does not match; do not restore it"
    local why
    why="$(manifest_ok "$STAGE/MANIFEST.txt")" || die "$FILE was not written by this script ($why) - refusing to read it further"
    [ "$(sed -n 's/^format: *//p' "$STAGE/MANIFEST.txt")" = "$FORMAT" ] || die "$FILE was written by a different version of this script"
    good "$FILE is whole ($(du -h "$FILE" | cut -f1), every checksum matches)"
    say "  taken      $(sed -n 's/^created: *//p' "$STAGE/MANIFEST.txt") on $(sed -n 's/^host: *//p' "$STAGE/MANIFEST.txt")"
    say "  contents   $(sed -n 's/^mode: *//p' "$STAGE/MANIFEST.txt"), database $(sed -n 's/^database: *//p' "$STAGE/MANIFEST.txt"), RSCanvas $(sed -n 's/^app_version: *//p' "$STAGE/MANIFEST.txt") ($(sed -n 's/^app_commit: *//p' "$STAGE/MANIFEST.txt"))"
}

# Everything a restore needs from this box, asked BEFORE anything changes, so
# a refusal leaves the box exactly as it was. Space is the table data twice
# over: the dump carries no indexes, and the restore builds them all.
restore_preflight() {
    local have need r
    need=$(( $(sed -n 's/^heap_bytes: *//p' "$STAGE/MANIFEST.txt") * 2 / 1048576 + 256 ))
    have=$(df --output=avail -BM "$(pg -c 'SHOW data_directory')" | tail -1 | tr -dc 0-9)
    [ "$have" -ge "$need" ] || die "the restored database needs about ${need} MB and ${have} MB are free where PostgreSQL keeps its data"
    for r in rscanvas_owner rscanvas rscanvas_admin; do
        [ "$(pg -c "SELECT 1 FROM pg_roles WHERE rolname = '$r'")" = 1 ] \
            || die "role $r does not exist - install RSCanvas on this box first (rscanvas-setup.sh), then restore"
    done
    RESTORE_PW="$(env_get RSCANVAS_ADMIN_DB_PASSWORD "$ENV_FILE")"
    [ -n "$RESTORE_PW" ] || die "no RSCANVAS_ADMIN_DB_PASSWORD in $ENV_FILE - the restore runs as rscanvas_admin; re-run rscanvas-setup.sh on this box first"
    [ "$(pg_admin postgres -c 'SELECT 1' 2>/dev/null)" = 1 ] \
        || die "cannot sign in to PostgreSQL as rscanvas_admin with the password in $ENV_FILE - re-run rscanvas-setup.sh on this box first"
    good "room for it (${need} MB needed, ${have} MB free), and the installer's roles exist"
}

# Restore the unpacked dump into a NEW database and compare it, table by
# table, with the counts taken inside the snapshot it was dumped from.
# As postgres, keeping owners and grants: the roles are the installer's and
# must exist first, and the grants ARE the permission model - restoring
# without them hands the application a database it cannot read. Returns 1
# rather than dying, so the caller can undo what it set aside.
restore_into() {
    local target="$1"
    if db_exists "$target"; then warn "database $target already exists - refusing to restore over it"; return 1; fi
    pg -c "CREATE DATABASE \"$target\" OWNER rscanvas_owner" || return 1
    local t0=$SECONDS log="$STAGE/pg_restore.log"
    # ONE TRANSACTION: a restore that fails halfway leaves an empty database,
    # never a plausible-looking partial one. stdin is the file itself, so
    # pg_restore can still seek in it. As rscanvas_admin (pg_admin says why).
    if ! PGPASSWORD="$RESTORE_PW" pg_restore -h localhost -p 5432 -U rscanvas_admin -w \
            --dbname="$target" --single-transaction --exit-on-error \
            < "$STAGE/rscanvas.dump" > "$log" 2>&1; then
        sed 's/^/    /' "$log" | tail -15
        pg -c "DROP DATABASE IF EXISTS \"$target\"" || true
        return 1
    fi
    good "restored into $target in $((SECONDS - t0))s"

    local tables=() diff=0 name want got
    mapfile -t tables < <(sed -n 's/^rows \([a-z0-9_]*\) .*/\1/p' "$STAGE/MANIFEST.txt")
    declare -A restored=()
    while read -r name got; do restored[$name]=$got; done < <(count_tables "$target" "${tables[@]}")
    while read -r _ name want; do
        got="${restored[$name]:-MISSING}"
        if [ "$got" != "$want" ]; then warn "$name: backup has $want rows, restored $got"; diff=1; fi
    done < <(grep '^rows ' "$STAGE/MANIFEST.txt")
    # And the bulk that was left out is left out, rather than half-present.
    while read -r _ name _; do
        got=$(pg_admin "$target" -c "SELECT count(*) FROM public.\"$name\"" 2>/dev/null || echo MISSING)
        [ "$got" = 0 ] || { warn "$name should be empty in a restore of this backup and holds $got rows"; diff=1; }
    done < <(grep '^skipped ' "$STAGE/MANIFEST.txt")
    if [ "$diff" != 0 ]; then
        pg -c "DROP DATABASE IF EXISTS \"$target\"" || true
        return 1
    fi
    good "every table matches the backup, row for row (${#tables[@]} tables, $(awk '/^rows /{s+=$3} END{print s+0}' "$STAGE/MANIFEST.txt") rows)"
}

# ----- backup -----------------------------------------------------------------

if [ "$MODE" = backup ]; then
    [ -f "$ENV_FILE" ] || die "no $ENV_FILE - is RSCanvas installed on this box?"
    DB="$(db_from_url "$(env_get DATABASE_URL "$ENV_FILE")")"
    [ -n "$DB" ] || die "no DATABASE_URL in $ENV_FILE"
    db_exists "$DB" || die "database $DB (from $ENV_FILE) does not exist here"

    step "what to take from $DB"
    mapfile -t LEAVES < <(pgdb "$DB" -F' ' -c "
        SELECT relname, pg_table_size(oid), greatest(reltuples, 0)::bigint
          FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'
         ORDER BY relname")
    [ "${#LEAVES[@]}" -gt 0 ] || die "$DB has no tables - nothing to back up"
    KEEP=(); SKIP=(); HEAP=0; SKIPPED_BYTES=0
    for line in "${LEAVES[@]}"; do
        read -r name bytes est <<< "$line"
        if [ "$FULL" = 0 ] && is_bulk "$name"; then
            SKIP+=("$name $est"); SKIPPED_BYTES=$((SKIPPED_BYTES + bytes))
        else
            KEEP+=("$name"); HEAP=$((HEAP + bytes))
        fi
    done
    say "  keeping    ${#KEEP[@]} tables, $((HEAP / 1048576)) MB before compression"
    [ "$FULL" = 0 ] && say "  leaving    ${#SKIP[@]} raw sample and message tables, $((SKIPPED_BYTES / 1048576)) MB (--full takes them)"

    # Room for the dump AND the archive it is packed into, bounded by the
    # uncompressed size - a compressed dump is several times smaller, so this
    # errs toward refusing. Filling a disk the database shares is how a
    # backup takes down the thing it protects.
    # CREATED 0700 WHEN ABSENT, LEFT ALONE WHEN NOT (2026-10-03, review L12).
    # `install -d -m 0700` also re-modes a directory that exists, so
    # `--out /tmp` turned /tmp into 0700 root - sticky bit and every other
    # user's access gone. The backup does not need its directory private:
    # the archive is written 0600 under umask 077 and staged in a mktemp -d
    # directory, which is 0700 by itself.
    [ -d "$OUT_DIR" ] || install -d -m 0700 "$OUT_DIR"
    AVAIL=$(df --output=avail -BM "$OUT_DIR" | tail -1 | tr -dc 0-9)
    [ "$AVAIL" -ge $((HEAP / 1048576 + 64)) ] \
        || die "$OUT_DIR has ${AVAIL} MB free and this backup could need $((HEAP / 1048576 + 64)) MB - choose another place with --out"

    STAGE="$(mktemp -d "$OUT_DIR/.rscanvas-backup.XXXXXX")"
    trap 'rm -rf "${STAGE:?}"' EXIT
    STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
    NAME="rscanvas-backup-$(hostname -s)-${STAMP}$([ "$FULL" = 1 ] && echo -full || true).tar"

    step "one snapshot: count every table, then dump from the same instant"
    # The counts and the dump must describe the SAME database, on a service
    # that keeps writing throughout. So one transaction exports its snapshot,
    # counts inside it, and pg_dump reads that snapshot while it stays open:
    # the manifest's numbers are exactly what the dump holds, and a restore
    # can be held to them row for row.
    coproc SNAPQ { sudo -u postgres psql -qAtX -v ON_ERROR_STOP=1 -F' ' -d "$DB" 2>&1; }
    sq() {
        printf '%s\n\\echo __rscanvas_end__\n' "$1" >&"${SNAPQ[1]}"
        local l
        while IFS= read -r l <&"${SNAPQ[0]}"; do
            [ "$l" = __rscanvas_end__ ] && return 0
            printf '%s\n' "$l"
        done
        return 1
    }
    sq "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;" >/dev/null || die "could not open the snapshot transaction"
    SNAP="$(sq "SELECT pg_export_snapshot();")" || die "could not export a snapshot"
    [[ "$SNAP" =~ ^[0-9A-F-]+$ ]] || die "unexpected snapshot id: $SNAP"
    COUNT_SQL=""
    for t in "${KEEP[@]}"; do
        [[ "$t" =~ ^[a-z0-9_]+$ ]] || die "unexpected table name '$t'"
        COUNT_SQL+="${COUNT_SQL:+ UNION ALL }SELECT '$t', count(*) FROM public.\"$t\""
    done
    COUNTS="$(sq "$COUNT_SQL;")" || die "counting failed: $COUNTS"
    EXCL=()
    if [ "$FULL" = 0 ]; then for p in "${BULK_PATTERNS[@]}"; do EXCL+=("--exclude-table-data=public.$p"); done; fi
    T0=$SECONDS
    sudo -u postgres pg_dump --dbname="$DB" --snapshot="$SNAP" --format=custom "${EXCL[@]}" \
        > "$STAGE/rscanvas.dump" 2> "$STAGE/pg_dump.log" \
        || { cat "$STAGE/pg_dump.log" >&2; die "pg_dump failed"; }
    sq "COMMIT;" >/dev/null || true
    printf '\\q\n' >&"${SNAPQ[1]}" || true
    wait "$SNAPQ_PID" 2>/dev/null || true
    good "dumped in $((SECONDS - T0))s, $(du -h "$STAGE/rscanvas.dump" | cut -f1)"

    step "check the dump holds what the counts say"
    # The runbook's lesson, as code: read the dump's own table of contents.
    # Every kept table with rows must have its data in there, and no left-out
    # table may - if the patterns above and pg_dump ever disagree about a
    # name, this is where it shows, not at a restore.
    TOC="$(pg_restore --list "$STAGE/rscanvas.dump")"
    BAD=0
    while read -r name n; do
        if [ "$n" -gt 0 ] && ! grep -qE "TABLE DATA public ${name} " <<< "$TOC"; then
            warn "$name has $n rows and its data is NOT in the dump"; BAD=1
        fi
    done <<< "$COUNTS"
    for s in "${SKIP[@]}"; do
        name="${s%% *}"
        if grep -qE "TABLE DATA public ${name} " <<< "$TOC"; then warn "$name was to be left out and its data IS in the dump"; BAD=1; fi
    done
    [ "$BAD" = 0 ] || die "the dump does not match its own counts - not writing a backup that cannot be trusted"
    good "every table with rows is in the dump$([ "$FULL" = 0 ] && echo ', and the raw bulk is not')"

    step "configuration and secrets"
    tar -C "$(dirname "$ENV_DIR")" -cf "$STAGE/etc-rscanvas.tar" "$(basename "$ENV_DIR")"
    good "$ENV_DIR ($(tar -tf "$STAGE/etc-rscanvas.tar" | grep -vc '/$') files)"

    {
        echo "format: $FORMAT"
        echo "created: $STAMP"
        echo "host: $(hostname)"
        echo "addresses: $(hostname -I 2>/dev/null | xargs)"
        echo "mode: $([ "$FULL" = 1 ] && echo 'full (everything)' || echo 'standard (raw samples and messages left out)')"
        echo "database: $DB"
        echo "postgres: $(pg -c 'SHOW server_version')"
        echo "app_version: $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" 2>/dev/null | head -1)"
        echo "app_commit: $(sed -n 's/^commit: *//p' "$APP_DIR/BUNDLE-MANIFEST.txt" 2>/dev/null | head -1)"
        echo "schema_slice: $(max_slice "$APP_DIR")"
        echo "heap_bytes: $HEAP"
        echo "dump_seconds: $((SECONDS - T0))"
        while read -r name n; do echo "rows $name $n"; done <<< "$COUNTS"
        for s in "${SKIP[@]}"; do echo "skipped ${s% *} ~${s#* }"; done
    } > "$STAGE/MANIFEST.txt"
    (cd "$STAGE" && sha256sum rscanvas.dump etc-rscanvas.tar MANIFEST.txt > SHA256SUMS)
    rm -f "$STAGE/pg_dump.log"
    (umask 077 && tar -C "$STAGE" -cf "$OUT_DIR/$NAME.part" MANIFEST.txt SHA256SUMS rscanvas.dump etc-rscanvas.tar)
    # Renamed into place only when whole, so a half-written file never looks
    # like a backup to whatever copies this directory off the box.
    mv "$OUT_DIR/$NAME.part" "$OUT_DIR/$NAME"
    chmod 0600 "$OUT_DIR/$NAME"

    count_of() { awk -v t="$1" '$1 == t {print $2}' <<< "$COUNTS"; }
    printf '\n%s================ backup written ================%s\n' "$B" "$N"
    say "  file       $OUT_DIR/$NAME ($(du -h "$OUT_DIR/$NAME" | cut -f1))"
    say "  holds      $(count_of users) users, $(count_of devices) devices, $(count_of entities) entities, $(count_of alerts) alerts,"
    say "             $(awk '$1 ~ /^samples_hourly/ {s+=$2} END{print s+0}' <<< "$COUNTS") hourly rollup rows$([ "$FULL" = 1 ] && echo ", $(awk '$1 ~ /^samples_2/ {s+=$2} END{print s+0}' <<< "$COUNTS") raw samples, $(awk '$1 ~ /^messages_2/ {s+=$2} END{print s+0}' <<< "$COUNTS") messages" || true)"
    say ""
    printf '  %sTHIS FILE HOLDS SECRETS%s - the database password, the first admin'"'"'s password and\n' "$Y" "$N"
    say "  RSCANVAS_SECRET. Keep it off this box, and as carefully as those."
    say "  Prove it restores:  sudo $APP_DIR/rscanvas-backup.sh --test $OUT_DIR/$NAME"
    exit 0
fi

# ----- test: restore into a scratch database here, compare, drop --------------

if [ "$MODE" = test ]; then
    step "check the archive"
    unpack
    DB="$(sed -n 's/^database: *//p' "$STAGE/MANIFEST.txt")"
    SCRATCH="${DB}_restore_test"
    step "restore into $SCRATCH, a scratch database beside the live one"
    # The name is the guard: ending in _restore_test marks it disposable, the
    # same convention the rest of this project's destructive tools demand.
    case "$SCRATCH" in *_restore_test) ;; *) die "refusing: $SCRATCH is not a disposable name" ;; esac
    restore_preflight
    db_exists "$SCRATCH" && pg -c "DROP DATABASE \"$SCRATCH\""
    if restore_into "$SCRATCH"; then
        pg -c "DROP DATABASE \"$SCRATCH\""
        printf '\n%sThis backup restores.%s The scratch database is dropped; nothing live was touched.\n' "$G" "$N"
        exit 0
    fi
    die "this backup did NOT restore cleanly - see above"
fi

# ----- restore: make this box the one in the backup ---------------------------

step "check the archive"
unpack
M() { sed -n "s/^$1: *//p" "$STAGE/MANIFEST.txt"; }
# The configuration archive is checked now, before anything changes, member
# by member (etc_listing_ok): it is extracted as root into /etc.
WHY="$(LC_ALL=C tar -tvf "$STAGE/etc-rscanvas.tar" | etc_listing_ok "$(basename "$ENV_DIR")")" \
    || die "the configuration in $FILE is not what this script writes ($WHY) - nothing was changed"
DB="$(M database)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

step "check this box"
[ -f "$APP_DIR/package.json" ] && [ -x "$APP_DIR/rscanvas-setup.sh" ] \
    || die "no RSCanvas install at $APP_DIR - install the same version (or newer) with rscanvas-setup.sh first, then restore"
[ -n "$(pg -c 'SELECT 1' 2>/dev/null)" ] || die "PostgreSQL is not answering here"
HERE_SLICE="$(max_slice "$APP_DIR")"
if [ "$(M schema_slice)" -gt "$HERE_SLICE" ]; then
    die "this backup is from a NEWER RSCanvas (schema slice $(M schema_slice)) than the one installed here (slice $HERE_SLICE) - install that version or newer first"
fi
good "RSCanvas $(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$APP_DIR/package.json" | head -1) at $APP_DIR, schema slice $HERE_SLICE$([ "$(M schema_slice)" -lt "$HERE_SLICE" ] && echo " - the backup's slice $(M schema_slice) will be brought forward" || true)"
restore_preflight

ASIDE_DB="${DB}_pre_restore_${STAMP}"
ASIDE_ETC="${ENV_DIR}.pre-restore-${STAMP}"
say ""
say "  This will:"
say "    stop the $UNIT service"
db_exists "$DB" && say "    rename the database $DB to $ASIDE_DB (kept, not dropped)"
[ -d "$ENV_DIR" ] && say "    move $ENV_DIR to $ASIDE_ETC (kept)"
say "    restore database $DB and $ENV_DIR from the backup"
say "    re-run rscanvas-setup.sh to bring the schema forward, harden the roles and start the service"
if [ "$ASSUME_YES" != 1 ]; then
    read -r -p "  continue? [y/N] " a
    case "$a" in y|Y) ;; *) die "stopped - nothing was changed" ;; esac
fi

step "stop the service"
systemctl stop "$UNIT" 2>/dev/null || true
good "$UNIT is $(systemctl is-active "$UNIT" 2>/dev/null || true)"

step "set the current database aside"
ASIDE_DONE=0
if db_exists "$DB"; then
    pg -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$DB' AND pid <> pg_backend_pid()" >/dev/null
    pg -c "ALTER DATABASE \"$DB\" RENAME TO \"$ASIDE_DB\""
    ASIDE_DONE=1
    good "$DB is now $ASIDE_DB"
else
    say "  no database named $DB here - nothing to set aside"
fi
# Any failure from here puts the box back as it was.
undo_db() {
    warn "putting the database back as it was"
    pg -c "DROP DATABASE IF EXISTS \"$DB\"" || true
    [ "$ASIDE_DONE" = 1 ] && pg -c "ALTER DATABASE \"$ASIDE_DB\" RENAME TO \"$DB\"" || true
    systemctl start "$UNIT" 2>/dev/null || true
}

step "restore the database"
restore_into "$DB" || { undo_db; die "the restore failed and was undone - this box is as it was"; }

step "restore $ENV_DIR"
[ -d "$ENV_DIR" ] && mv "$ENV_DIR" "$ASIDE_ETC"
# Without the archive's owners and modes: root's, private, and the installer
# re-run below gives the service user back exactly what it needs (the env
# file stays 0600 root:root; the TLS pair is root:<service> 0640/0644).
if ! (umask 077 && tar -xf "$STAGE/etc-rscanvas.tar" --no-same-owner --no-same-permissions -C "$(dirname "$ENV_DIR")"); then
    rm -rf "${ENV_DIR:?}"; [ -d "$ASIDE_ETC" ] && mv "$ASIDE_ETC" "$ENV_DIR"
    undo_db; die "could not unpack $ENV_DIR from the backup - undone"
fi
chown -R root:root "$ENV_DIR"; chmod -R go-rwx "$ENV_DIR"
[ "$(db_from_url "$(env_get DATABASE_URL "$ENV_FILE")")" = "$DB" ] \
    || warn "the restored $ENV_FILE names a different database than the backup's manifest ($DB)"
good "$ENV_DIR from the backup$([ -d "$ASIDE_ETC" ] && echo "; this box's own is in $ASIDE_ETC" || true)"

step "re-run the installer on the restored state"
# The installer is the one place that knows how this version's box must look:
# it re-applies every schema slice (bringing an older backup forward), sets
# the database roles' passwords to the ones in the restored env file,
# re-hardens, rewrites the unit, restarts and verifies. It keeps the
# database name and ports the restored env file names.
if ! "$APP_DIR/rscanvas-setup.sh" --yes --dir "$APP_DIR" 2>&1 | sed 's/^/  | /'; then
    die "the installer reported failures above - the restored database and $ENV_DIR are in place; fix and re-run rscanvas-setup.sh"
fi

# A self-signed pair names the addresses of the box that minted it. On a
# different box the browser warning comes back, and a kiosk pinned to the
# old certificate stops trusting this one - said here rather than found.
CERT="$(env_get TLS_CERT "$ENV_FILE")"
if [ -n "$CERT" ] && [ -r "$CERT" ]; then
    SANS="$(openssl x509 -in "$CERT" -noout -ext subjectAltName 2>/dev/null | tail -n +2)"
    MATCH=0
    for ip in $(hostname -I); do grep -q "IP Address:$ip\b" <<< "$SANS" && MATCH=1; done
    grep -q "DNS:$(hostname)\b" <<< "$SANS" && MATCH=1
    if [ "$MATCH" = 0 ]; then
        warn "the restored TLS certificate is for $(xargs <<< "$SANS"), not this box ($(hostname), $(hostname -I | xargs))"
        warn "browsers will warn until it is replaced; to mint one for this box:"
        warn "  sudo mv $(dirname "$CERT") $(dirname "$CERT").old && sudo $APP_DIR/rscanvas-setup.sh --tls"
    fi
fi

printf '\n%s================ restored ================%s\n' "$B" "$N"
say "  from       $FILE"
say "  taken      $(M created) on $(M host), $(M mode)"
say "  sign in with the accounts and passwords of that install."
say ""
say "  Kept aside until you are satisfied, then remove them yourself:"
[ "$ASIDE_DONE" = 1 ] && say "    sudo -u postgres dropdb $ASIDE_DB"
[ -d "$ASIDE_ETC" ] && say "    sudo rm -r $ASIDE_ETC"
exit 0
