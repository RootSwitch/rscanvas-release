-- Slice 20: the roster's summary columns, written at poll time.
--
-- WHY COLUMNS AND NOT AGGREGATES. The roster wanted SNMPCanvas's columns
-- (CPU, memory, fullest filesystem, temperature, down ports, errors, busiest
-- interface, health, UPS). Computing them in the roster query - one more set
-- of aggregates on the grouped entities pass it already makes - was the
-- first cut, and it failed its pre-registered budget at 450 devices: 7.2 ms
-- became 24.5 ms as written and 15.0 ms with every sort removed, against a
-- 10.8 ms ceiling (SLICE-ROSTER-COLUMNS-PLAN, the measurement section). The
-- roster is refreshed by every viewer every ten seconds, so that cost
-- multiplies by the fleet AND by the audience.
--
-- So the computation moves to the one place that already holds every
-- reading for one device exactly once per poll: the collector
-- (src/collector/summary.ts), which writes these columns inside the
-- recordDevicePoll UPDATE that already runs. The roster reads plain columns
-- at any fleet size. Freshness is inherent: a column is as fresh as the poll
-- that wrote it, and the roster blanks them when the device is not up - the
-- same one-way door the device page enforces for stale readings.
--
-- NULL means "nothing of that kind was measured", never zero. The counts
-- (down_ports, if_count, alarms, state_sensors) are zero when there is
-- nothing to count, which IS the measurement.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS cpu_pct       real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mem_pct       real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fs_pct        real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS fs_name       text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS temp_c        real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS down_ports    int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS if_count      int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS if_errs       real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS top_if        text;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS top_bps       double precision;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS top_speed     double precision;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS alarms        int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS state_sensors int;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS batt_pct      real;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS runtime_s     real;
