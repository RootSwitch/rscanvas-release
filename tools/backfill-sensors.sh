#!/usr/bin/env bash
# Ask the collector to backfill sensors NOW instead of at the inventory
# cadence: clear inventory_ts on sensorless devices, and each one's next
# poll runs the discover-if-none pass. The collector does all the real work -
# this script only removes the "already asked today" stamp, which is why it
# is safe to run repeatedly and does nothing on a fleet that already has
# sensors.
#
#   DB=postgres://... bash tools/backfill-sensors.sh
set -euo pipefail
DB="${DB:-postgres://rscanvas:rscanvas@localhost:5432/rscanvas_demo}"

psql "$DB" -v ON_ERROR_STOP=1 -tAc "
    WITH sensorless AS (
        SELECT d.id FROM devices d
         WHERE d.enabled
           AND NOT EXISTS (SELECT 1 FROM entities e
                            WHERE e.device_id = d.id AND e.kind <> 'if')
    )
    UPDATE devices SET inventory_ts = NULL
     WHERE id IN (SELECT id FROM sensorless)
    RETURNING name" | sed 's/^/  queued: /'
echo "each device backfills on its NEXT POLL - a 30s-interval fleet finishes inside a minute"
