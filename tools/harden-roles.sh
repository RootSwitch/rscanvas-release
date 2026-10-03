#!/usr/bin/env bash
# Take DROP away from the role the application and the tools connect as.
#
#   sudo tools/harden-roles.sh rscanvas_spike
#   sudo tools/harden-roles.sh rscanvas_spike --revert
#
# THE ARGUMENT THIS CLOSES.
#
# Every fix to the three fixture losses has been a better guard on a call: a
# floor, a max_drop, a dry_run, a named target, an interlock. Guards are worth
# having and every one of them was correct. But they all share a defect that the
# incidents keep demonstrating - they protect the paths anyone thought to
# protect, and the loss arrives through the one nobody enumerated. The 158GB
# went through the retention function. The 22GB went through the same function
# with different parameters. The third came within five weeks through a
# different table the newest guard did not cover.
#
# `DROP TABLE` is not a path. It is a PRIVILEGE, and Postgres already knows how
# to withhold it: only an object's owner may drop it. The corpus was owned by
# `rscanvas`, the same role every tool connects as, so every guard in this repo
# was reasoning about a capability the database was handing out unconditionally.
#
# After this script:
#
#   rscanvas_owner   owns every table. NOLOGIN - nothing connects as it.
#   rscanvas         the application and the tools. SELECT/INSERT/UPDATE/DELETE
#                    and nothing else. `DROP TABLE samples_20260718` comes back
#                    "must be owner of table", from the database, before any
#                    guard in this repo is consulted.
#   rscanvas_admin   a member of rscanvas_owner, for schema changes and
#                    migrations. A different credential, not a different flag.
#
# The three functions that legitimately need ownership become SECURITY DEFINER,
# so partition creation and guarded retention keep working while the caller
# stays unprivileged. That inverts the relationship the losses depended on:
# drop_partitions_guarded stops being the recommended path to a DROP and becomes
# the ONLY one, with its five guards and the layer-3 interlock unavoidable
# rather than merely present.
#
# What this does NOT do: protect rscanvas_test. Destructive tests need to drop
# things, which is the entire reason that database exists.

set -euo pipefail

DB="${1:-}"
REVERT="${2:-}"
APP_ROLE="${APP_ROLE:-rscanvas}"
OWNER_ROLE="${OWNER_ROLE:-rscanvas_owner}"
ADMIN_ROLE="${ADMIN_ROLE:-rscanvas_admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-rscanvas_admin}"

if [ -z "$DB" ]; then
    echo "usage: $0 <database> [--revert]" >&2
    exit 1
fi

S() { sudo -n -u postgres psql -v ON_ERROR_STOP=1 -q -d "$DB" "$@"; }

# The functions that must keep working from an unprivileged caller. Each one
# needs ownership for a reason the application cannot avoid: two create
# partitions (ACCESS EXCLUSIVE on the parent, owner-only), one drops them.
#
# THE SQL FILES ARE THE SOURCE OF TRUTH FOR THIS, not the ALTERs below.
# Declaring the attribute in each CREATE OR REPLACE is what makes it survive;
# the first version of this script applied it here only, and the next routine
# `apply-schema --with-retention` reverted all three to SECURITY INVOKER
# because CREATE OR REPLACE resets every attribute the definition does not
# restate. It held for eleven minutes.
#
# The ALTERs remain as a repair for a database whose functions predate that fix,
# and src/db/apply-schema.ts now refuses to finish if any of them comes back
# INVOKER on a hardened database.
#
# search_path is pinned on every one of them. A SECURITY DEFINER function
# without it can be hijacked by a caller who puts their own schema first and
# shadows a table name - which would hand back, with interest, exactly the
# privilege this script exists to remove.
# Mirrors PRIVILEGED_FUNCTIONS in src/db/apply-schema.ts, which is what actually
# enforces this on every apply.
DEFINER_FUNCS=(
    "ensure_daily_partitions(text, date, date)"
    "ensure_monthly_partitions(text, date, date)"
    "drop_partitions_guarded(text, int, int, int, int, int, boolean, text)"
    "sync_recent_trgm_indexes(text, int)"
)

# Move ownership of every table, sequence and function in THIS database, one
# object at a time.
#
# NOT `REASSIGN OWNED BY`, and that is a correction rather than a style choice.
# REASSIGN OWNED also moves SHARED objects - databases and tablespaces - which
# are not scoped to the database you are connected to. Hardening the corpus with
# it therefore reassigned ownership of every other database the app role owned,
# including rscanvas_test, whose tables it left alone while quietly removing the
# CREATE privilege that came with owning it. The disposable database stopped
# being able to apply its own schema, in a way that pointed at the wrong cause.
#
# Found by the lab, not by reading: the next apply against rscanvas_test failed
# with 42501 and nothing had touched rscanvas_test.
reassign_owned_here() {
    local from="$1" to="$2"
    S -c "DO \$\$
          DECLARE r record;
          BEGIN
              FOR r IN SELECT c.oid::regclass AS obj, c.relkind
                         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                        WHERE n.nspname = 'public' AND pg_get_userbyid(c.relowner) = '$from'
                          AND c.relkind IN ('r','p','S','v','m')
                          -- A sequence LINKED to a table column - an identity
                          -- column or a serial - cannot have its owner changed
                          -- on its own: Postgres refuses with \"cannot change
                          -- owner of sequence ... is linked to table\". It does
                          -- not need changing either, because it follows its
                          -- table's owner, and the table is in this same loop.
                          --
                          -- Never fired until the first fresh install: on every
                          -- database inherited from the spike, messages_id_seq
                          -- was already owned correctly, so the sweep passed
                          -- over it. Building one the right way put it in scope
                          -- and the whole hardening run aborted on it.
                          AND NOT (c.relkind = 'S' AND EXISTS (
                              SELECT 1 FROM pg_depend d
                               WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                                 AND d.refclassid = 'pg_class'::regclass
                                 AND d.deptype IN ('i','a')))
              LOOP
                  IF r.relkind = 'S' THEN
                      EXECUTE format('ALTER SEQUENCE %s OWNER TO $to', r.obj);
                  ELSE
                      EXECUTE format('ALTER TABLE %s OWNER TO $to', r.obj);
                  END IF;
              END LOOP;
              FOR r IN SELECT p.oid::regprocedure AS obj
                         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                        WHERE n.nspname = 'public' AND pg_get_userbyid(p.proowner) = '$from'
              LOOP
                  EXECUTE format('ALTER FUNCTION %s OWNER TO $to', r.obj);
              END LOOP;
          END \$\$"
}

if [ "$REVERT" = "--revert" ]; then
    echo "reverting $DB: giving $APP_ROLE ownership back"
    reassign_owned_here "$OWNER_ROLE" "$APP_ROLE"
    S -c "ALTER DATABASE $DB OWNER TO $APP_ROLE"
    for f in "${DEFINER_FUNCS[@]}"; do
        S -c "ALTER FUNCTION $f SECURITY INVOKER" 2>/dev/null || true
    done
    S -c "GRANT CREATE ON SCHEMA public TO $APP_ROLE"
    echo "reverted. $APP_ROLE can drop tables again."
    exit 0
fi

echo "hardening $DB"

[[ "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9._~+=-]{1,128}$ ]] \
    || { echo "ADMIN_PASSWORD must be 1 to 128 of A-Z a-z 0-9 . _ ~ + = - (it is quoted into psql)" >&2; exit 1; }
# ON STDIN, NOT -c (2026-10-02, review F18). As a DO block on psql's command
# line the admin role's password was in `ps` and in sudo's log on every run -
# the public dev default on an installer box, whose installer creates the role
# first, but whatever ADMIN_PASSWORD held anywhere else. psql does not
# interpolate variables inside a dollar-quoted block, so the conditional
# CREATEs are built by format() and run with \gexec; :'pw' is quoted by psql.
S <<SQL
\\set owner '$OWNER_ROLE'
\\set admin '$ADMIN_ROLE'
\\set pw '$ADMIN_PASSWORD'
SELECT format('CREATE ROLE %I NOLOGIN', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'owner') \\gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L IN ROLE %I', :'admin', :'pw', :'owner')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'admin') \\gexec
SQL
echo "  roles present"

# Everything the app role owns IN THIS DATABASE. Enumerated from the catalogue
# rather than listed, so it cannot go stale as tables are added - but scoped to
# one database, for the reason above.
reassign_owned_here "$APP_ROLE" "$OWNER_ROLE"

# AND EVERYTHING THE ADMIN ROLE OWNS, which is not a symmetry for its own sake.
#
# Sweeping only APP_ROLE assumed the schema had been built by the application's
# own credential. That was true of every database this lab has ever had,
# because they all descend from the spike and predate the role split - so the
# assumption was invisible until 2026-08-14, when the first database built the
# CORRECT way (schema applied as rscanvas_admin, then hardened) left every
# table owned by rscanvas_admin and this function found nothing to move.
#
# The tool said so itself rather than passing: its own check printed "samples
# is still owned by rscanvas_admin - HARDENING DID NOT TAKE". Worth recording
# that the fresh-install path was proven broken by an assertion that was
# already here, not by reading the code.
#
# No-op on every existing database, where the admin role owns nothing.
reassign_owned_here "$ADMIN_ROLE" "$OWNER_ROLE"
S -c "ALTER DATABASE $DB OWNER TO $OWNER_ROLE"
echo "  ownership moved to $OWNER_ROLE"

S -c "GRANT USAGE ON SCHEMA public TO $APP_ROLE"
S -c "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $APP_ROLE"
S -c "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $APP_ROLE"
S -c "GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO $APP_ROLE"

# Future objects too. Without this, the first partition a SECURITY DEFINER
# function creates is owned by rscanvas_owner and invisible to any tool that
# addresses a partition directly - a failure that would appear days later and
# look like corruption rather than like a missing grant.
S -c "ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER_ROLE IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP_ROLE"
S -c "ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER_ROLE IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO $APP_ROLE"
S -c "ALTER DEFAULT PRIVILEGES FOR ROLE $OWNER_ROLE IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO $APP_ROLE"
# AND FOR THE ADMIN ROLE, which is who actually creates things after
# hardening. apply-schema runs as $ADMIN_ROLE, so every table a future slice
# adds is admin-owned - and default privileges declared FOR ROLE $OWNER_ROLE
# do not apply to it. Found live on the first slice applied to a hardened
# database (slice12's reachability_events: the app role could not INSERT),
# which is install break 6's mechanism recurring one level up. Without these,
# "apply a new slice" and "silently break the app on that table" are the same
# operation until somebody remembers to re-run this script.
S -c "ALTER DEFAULT PRIVILEGES FOR ROLE $ADMIN_ROLE IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $APP_ROLE"
S -c "ALTER DEFAULT PRIVILEGES FOR ROLE $ADMIN_ROLE IN SCHEMA public
      GRANT USAGE, SELECT ON SEQUENCES TO $APP_ROLE"
S -c "ALTER DEFAULT PRIVILEGES FOR ROLE $ADMIN_ROLE IN SCHEMA public
      GRANT EXECUTE ON FUNCTIONS TO $APP_ROLE"
echo "  $APP_ROLE granted DML on current and future objects (owner- AND admin-created)"

# THE AUDIT TRAIL IS APPEND-ONLY FOR THE APPLICATION (2026-10-01, review
# F13c). It only ever INSERTs and SELECTs there, and a role that could UPDATE
# or DELETE audit rows could rewrite the record of what it did. After the
# blanket grant above, which every run repeats. Deleting a user still sets
# audit.actor_id to NULL: PostgreSQL runs a foreign key's action as the
# referencing table's owner, not as the role that deleted the user.
S -c "REVOKE UPDATE, DELETE, TRUNCATE ON audit FROM $APP_ROLE"
echo "  audit is append-only for $APP_ROLE"

# THE DATABASE IS FOR ITS OWN ROLES. CONNECT and TEMP are granted to PUBLIC by
# default, so on a shared PostgreSQL every role on the server could connect
# here and make temporary tables. The application role and the admin role
# are the only ones that sign in; the owner never does, and the superuser is
# not subject to this.
S -c "REVOKE CONNECT, TEMPORARY ON DATABASE $DB FROM PUBLIC"
S -c "GRANT CONNECT ON DATABASE $DB TO $APP_ROLE, $ADMIN_ROLE"
echo "  CONNECT on $DB for $APP_ROLE and $ADMIN_ROLE only"

# CREATE on the schema is what lets a role make a table of its own - and a
# table it made is a table it owns and can drop. Taking it away is what stops
# the disposable-partition pattern from quietly restoring the capability.
S -c "REVOKE CREATE ON SCHEMA public FROM $APP_ROLE"
S -c "REVOKE CREATE ON SCHEMA public FROM PUBLIC"
echo "  CREATE revoked on schema public"

for f in "${DEFINER_FUNCS[@]}"; do
    S -c "ALTER FUNCTION $f SECURITY DEFINER"
    # OWNERSHIP TOO. A schema applied as the superuser (a lab habit, never the
    # installer's path) leaves these owned by postgres, and a definer function
    # owned by postgres RUNS as postgres: what it creates is then droppable by
    # nobody the application can be. Found 2026-08-22 on both lab demo
    # databases. The owner role is the one every other object has.
    S -c "ALTER FUNCTION $f OWNER TO $OWNER_ROLE"
    S -c "ALTER FUNCTION $f SET search_path = public, pg_temp"
    # Callable by the application role, not by every role on the server:
    # EXECUTE goes to PUBLIC by default, and these run as the owner (F13c).
    S -c "REVOKE EXECUTE ON FUNCTION $f FROM PUBLIC"
    S -c "GRANT EXECUTE ON FUNCTION $f TO $APP_ROLE"
    echo "  ${f%%(*} is SECURITY DEFINER with a pinned search_path, callable by $APP_ROLE alone"
done

echo
echo "verifying, because a permission model that has not been tried is a claim:"
# THE APP ROLE'S PASSWORD IS AN INPUT, not a constant. It was hardcoded to the
# conventional dev value until 2026-08-15, which made this verification - the
# only part of the script that PROVES the model rather than asserting it -
# unrunnable on any install whose credential was generated rather than typed.
# rscanvas-setup.sh mints a random one, so the first real install of this
# project got every line of hardening applied and then failed on "password
# authentication failed for user rscanvas", with set -e taking the installer
# down before it reached the service unit. The verification is the last thing
# that should be undermined by a stronger password.
PGPASSWORD="${PGPASSWORD:-rscanvas}" psql -q -U "$APP_ROLE" -h localhost -d "$DB" -tAc "
    SELECT '  ' || CASE
        WHEN has_table_privilege('$APP_ROLE', 'samples', 'INSERT') THEN 'CAN insert into samples (correct)'
        ELSE 'CANNOT insert into samples - THE APPLICATION IS BROKEN' END;
    SELECT '  ' || CASE
        WHEN pg_get_userbyid(relowner) = '$OWNER_ROLE' THEN 'samples is owned by $OWNER_ROLE, so $APP_ROLE cannot drop it'
        ELSE 'samples is still owned by ' || pg_get_userbyid(relowner) || ' - HARDENING DID NOT TAKE' END
      FROM pg_class WHERE relname = 'samples';
    SELECT '  ' || CASE
        WHEN has_schema_privilege('$APP_ROLE', 'public', 'CREATE') THEN '$APP_ROLE CAN still create tables - REVOKE DID NOT TAKE'
        ELSE '$APP_ROLE cannot create tables in public' END;
    -- CAN THE APP ROLE READ EVERY TABLE? This is not tidiness: it is exactly
    -- what pg_dump needs, because pg_dump LOCKs every table it will dump and a
    -- single unreadable partition aborts the WHOLE dump. Backups stop, loudly
    -- but in a cron job nobody reads, and the next person to find out is doing
    -- a restore.
    --
    -- Added 2026-08-14 after the sandbox's first drill produced a 0-byte dump.
    -- ensure_monthly_partitions was owned by $ADMIN_ROLE rather than
    -- $OWNER_ROLE, so as a SECURITY DEFINER it created samples_hourly's monthly
    -- partitions AS the admin - and the default privileges above are set FOR
    -- ROLE $OWNER_ROLE, so they did not apply. Six partitions with no ACL at
    -- all, in a database where every DAILY partition was granted correctly by
    -- the same mechanism, because that function happened to be owned right.
    SELECT '  ' || CASE WHEN n = 0
        THEN 'can read every table in public, so pg_dump can lock them all'
        ELSE n || ' table(s) $APP_ROLE CANNOT READ - pg_dump WILL FAIL ENTIRELY: ' || names END
      FROM (SELECT count(*) AS n,
                   coalesce(string_agg(c.relname, ', ' ORDER BY c.relname), '') AS names
              FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
             WHERE ns.nspname = 'public' AND c.relkind IN ('r','p')
               AND NOT has_table_privilege('$APP_ROLE', c.oid, 'SELECT')) t;
"

# The hint must NAME the credential's home, never interpolate a value: when
# this script is invoked by the installer (the normal path) $ADMIN_PASSWORD
# holds this script's own DEFAULT, not the generated password the installer
# wrote to the env file - so the old hint printed a connection string that
# fails auth on every correctly built box, and would only ever "work" on a
# box whose admin credential was literally the default (2026-09-01
# fresh-install drill, finding 5; the operator's production install printed
# the same wrong line).
cat <<EOF

Done. Schema changes now need the admin credential
(RSCANVAS_ADMIN_DB_PASSWORD in /etc/rscanvas/rscanvas.env on installer boxes):

  ADMIN_DATABASE_URL=postgres://$ADMIN_ROLE:<that password>@localhost:5432/$DB \\
    node src/db/apply-schema.ts --with-retention

Revert with: sudo \$0 $DB --revert
EOF
