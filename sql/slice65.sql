-- Slice 65 (2026-10-16): change from normal, for temperatures.
-- IDEAS-ANOMALY.md, "Replayed over production's own history".
--
-- The operator's incidents: a closet's AC failed and every switch stayed
-- inside its own limits while the room went from 80 F to 100 F; a NIC's
-- 40 mm fan died and the card ran 20 C hotter, still under any threshold
-- anyone would set. A fixed number cannot see either. A sensor's own last
-- week can.
--
-- One row per tracked temperature sensor: its last seven days of hourly
-- means (samples_hourly.a0), as a median and quartiles. Refreshed hourly by
-- the jobs worker ('temps:baseline'), for EVERY tracked temperature - which
-- sensors take part is decided at scan time (src/alerts/tempchange.ts), so
-- including one on its card counts from the next scan, not the next hour.
--
-- From hourly means, not raw readings: the replay measured both spreads and
-- they gave the same answers throughout - on sensors this quiet, the floor
-- decides, not the spread.
--
-- `hours` is how many hours of the week had a reading. Under 72 the sensor
-- is still learning and nothing is judged; the row is kept so the card can
-- say how far along it is.
--
-- ON DELETE CASCADE: a row is per entity, and an entity that goes takes it.

CREATE TABLE IF NOT EXISTS temp_baselines (
    entity_id int PRIMARY KEY REFERENCES entities (id) ON DELETE CASCADE,
    -- The hour the week ends at (exclusive): the baseline is [base_ts - 7 d, base_ts).
    base_ts   timestamptz NOT NULL,
    hours     int NOT NULL,
    med       double precision NOT NULL,
    q1        double precision NOT NULL,
    q3        double precision NOT NULL
);
