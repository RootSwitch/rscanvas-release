#!/usr/bin/env bash
# Build the disposable database that destructive tests run against.
#
#   tools/make-test-db.sh                 # build/rebuild rscanvas_test
#   TEST_DB=rscanvas_test2 tools/make-test-db.sh
#
# WHY THIS EXISTS, which matters more than what it does.
#
# Three tools in this tree drop tables: tools/locktest.ts,
# tools/test-retention-guards.ts and tools/test-rollup.ts. All three pointed at
# the measurement corpus by default, because DATABASE_URL defaults to
# rscanvas_spike and nothing distinguished a fixture database from a production
# one anywhere in the tool layer. Two of them have destroyed corpus data - 158GB
# and 22GB - and a third was five weeks from doing it on a date nobody had
# looked up.
#
# Every fix so far was a better guard on the call: a floor, a max_drop, a
# dry_run, a named target. Each was correct and none of them addressed the thing
# the three incidents actually had in common, which is that A TEST THAT DROPS
# TABLES WAS RUNNING AGAINST DATA WORTH KEEPING. This database is that fix. It
# holds a few thousand rows, it rebuilds in seconds, and losing all of it costs
# nothing at all.
#
# What that buys, concretely: the destructive tests stop needing to be careful.
# They can relax a horizon, scan a whole table, drop what they find - the things
# that made them dangerous are the things that make them good tests - because
# the worst outcome is rerunning this script.
#
# The corpus keeps its guards too. Both, not either: layer 3
# (src/safety.ts, sql/slice5-retention.sql) refuses the corpus, this gives the
# tests somewhere to go instead. A refusal with no alternative gets overridden.

set -euo pipefail

TEST_DB="${TEST_DB:-rscanvas_test}"
PGUSER_APP="${PGUSER_APP:-rscanvas}"
PGPASS_APP="${PGPASS_APP:-rscanvas}"
PGHOST="${PGHOST:-localhost}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The protected list, mirrored from sql/slice5-retention.sql. This script drops
# and recreates every table it touches, so pointing it at the corpus would
# destroy in seconds what takes 90 minutes to rebuild.
case "$TEST_DB" in
    rscanvas_spike|rscanvas|postgres)
        echo "refusing: $TEST_DB is not a disposable database" >&2
        echo "this script DROPs and recreates samples, messages, devices and entities" >&2
        exit 1
        ;;
esac

as_super() { sudo -n -u postgres psql -v ON_ERROR_STOP=1 "$@"; }
as_app()   { PGPASSWORD="$PGPASS_APP" psql -v ON_ERROR_STOP=1 -U "$PGUSER_APP" -h "$PGHOST" -d "$TEST_DB" "$@"; }

echo "building $TEST_DB"

# createdb is not idempotent and has no IF NOT EXISTS, so ask the catalogue.
if [ -z "$(as_super -tAc "SELECT 1 FROM pg_database WHERE datname = '$TEST_DB'")" ]; then
    as_super -c "CREATE DATABASE $TEST_DB OWNER $PGUSER_APP"
    echo "  created database"
else
    echo "  database already exists (its tables are about to be rebuilt)"
fi

# pg_trgm needs superuser to install the first time; the schema file's
# CREATE EXTENSION IF NOT EXISTS then finds it already there.
as_super -d "$TEST_DB" -c "CREATE EXTENSION IF NOT EXISTS pg_trgm" >/dev/null
echo "  pg_trgm present"

# Base tables. This file starts with DROP TABLE ... CASCADE, which is precisely
# why it is safe here and nowhere else.
as_app -q -f "$HERE/spike/sql/schema.sql"
echo "  base tables rebuilt from spike/sql/schema.sql"

# The spike file creates samples_hourly UNPARTITIONED - correct when it was
# written, and superseded. sql/slice5.sql creates the partitioned version but
# guards it with IF NOT EXISTS, so on a real deployment the migration
# (tools/partition-rollup.ts) does the conversion in place. Here there is
# nothing to preserve, so the unpartitioned table is removed and slice 5 gets to
# create the shape the code actually expects. Without this the test database is
# subtly the WRONG SHAPE - samples_hourly with no children - and every retention
# assertion against it would pass while testing something else.
as_app -q -c "DROP TABLE IF EXISTS samples_hourly CASCADE"

# Everything since: slices 1, 2, 4, 5 and the retention definitions. Retention
# is the reason this database exists, so --with-retention is not optional here.
(
    cd "$HERE"
    DATABASE_URL="postgres://$PGUSER_APP:$PGPASS_APP@$PGHOST:5432/$TEST_DB" \
        node src/db/apply-schema.ts --with-retention
)

# A small inventory and a partition runway, so the tests have real shapes to
# work against without any of it being expensive to lose.
as_app -q <<'SQL'
SELECT ensure_daily_partitions('samples',  (current_date - 20)::date, (current_date + 2)::date);
SELECT ensure_daily_partitions('messages', (current_date - 40)::date, (current_date + 2)::date);
SELECT ensure_monthly_partitions('samples_hourly', (current_date - 120)::date, (current_date + 40)::date);

INSERT INTO devices (id, name, host, status)
SELECT g, 'test-' || g, ('10.99.0.' || g)::inet, 'up' FROM generate_series(1, 4) g
ON CONFLICT (id) DO NOTHING;

-- Fixture ids stay BELOW 100000. slice4.sql starts entities_id_seq at
-- 100000 precisely so that "below is fixture, at or above is real" holds;
-- the first version of this seed used 100000+g and put fixture rows inside
-- the collector's allocation range, so discovery's nextval walked into them
-- and every poll failed on entities_pkey until the sequence had crawled past
-- the fixture - a failure that CLEARS ITSELF after exactly 20 failed polls,
-- which is the nastiest kind to reproduce.
INSERT INTO entities (id, device_id, kind, name)
SELECT g, 1 + (g % 4), 'interface', 'eth' || g FROM generate_series(1, 20) g
ON CONFLICT (id) DO NOTHING;
SQL

echo "  seeded 4 devices, 20 entities, and a partition runway"

as_app -tAc "
SELECT '  ' || count(*) || ' partitions, ' ||
       pg_size_pretty(sum(pg_total_relation_size(c.oid))) || ' total'
  FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid"

cat <<EOF

$TEST_DB is ready. Point the destructive tests at it:

  export DATABASE_URL=postgres://$PGUSER_APP:$PGPASS_APP@$PGHOST:5432/$TEST_DB
  node tools/test-retention-guards.ts
  node tools/test-rollup.ts
  node tools/locktest.ts

Rebuilding it costs seconds, so nothing in it is worth protecting - which is the
whole point.
EOF
