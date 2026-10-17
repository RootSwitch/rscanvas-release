-- Slice 60 (2026-10-09): a deleted entity's hourly history goes with it.
--
-- samples_hourly carries no foreign key to entities, for the same reason raw
-- samples do not (an FK check per row on the rollup's hot write), so deleting
-- a device, a service check or an interface corpse left its hourly rows
-- behind. Raw samples age out with retention; the rollup is kept, so those
-- rows stayed FOREVER, unreadable (every reader joins entities) and counted
-- by nobody. Found on the demo box 2026-10-09: four switches deleted and
-- re-added left 2,712 rows, while the delete gate said the history "ages out
-- on the retention horizon" - true of raw samples, not of these.
--
-- rollup_purge is the queue. Every statement that deletes entities inserts
-- their ids here IN THE SAME STATEMENT (tools/check-entity-deletes.mjs
-- refuses one that does not), so a delete and its purge cannot come apart.
-- The jobs worker drains it in bounded batches (OPS.purgeRollupBatch) - not
-- the delete itself, which runs on the interactive lane's two seconds and
-- would fail whole on a big device's year of rows.
--
-- WHY THE DRAIN WAITS FOR THE ROLLUP. roll_up_samples reads raw samples
-- without joining entities, and a deleted entity's raw samples stay until
-- retention. Purged before the rollup has passed the hour of the delete, the
-- next chunk would write that hour's row straight back. queued_ts is the
-- delete's time, and a row is drained only once the rollup frontier is an
-- hour past it - the hour after the delete covers a poll already in flight.
-- (A hand re-roll of older hours would also bring rows back while raw
-- samples remain; nothing in the product does that.)
--
-- Ids are never reused (entities.id is an identity), so a queued id cannot
-- come back to life; the drain checks anyway.

CREATE TABLE IF NOT EXISTS rollup_purge (
    entity_id int PRIMARY KEY,
    queued_ts timestamptz NOT NULL DEFAULT now()
);

/*
 * THE CENSUS: the rows deleted before this slice, found once per database.
 *
 * They were never queued, and entity ids cannot be inferred from gaps (the
 * discovery upserts consume the sequence: the demo box has 335 entities and
 * ids up to 100,471), so the census reads samples_hourly itself - ONE
 * partition per call, the distinct entity ids with no entity, queued for the
 * drain. The partition list is taken at the first call and kept in
 * job_state ('rollup:purge-census'); partitions made later only ever hold
 * rows of entities deleted after this slice, which their delete queued.
 *
 * It waits until the rollup is two hours past its own first call, so the
 * last hour of an entity deleted just before the upgrade has been written
 * (and can be found) before the partition holding it is read. Its own lock,
 * so two jobs workers in a rolling deploy do not read the same partition;
 * the queue's ON CONFLICT would make that harmless, only wasteful.
 */
CREATE OR REPLACE FUNCTION rollup_purge_census()
RETURNS TABLE(part text, queued bigint, parts_left int, waiting boolean, locked boolean)
LANGUAGE plpgsql AS $$
DECLARE
    st       job_state%ROWTYPE;
    todo     text[];
    since    timestamptz;
    frontier timestamptz;
    RSCANVAS_LOCK_NS    constant int := 1381253120;
    LOCK_PURGE_CENSUS   constant int := 4;
BEGIN
    SET LOCAL TimeZone = 'UTC';
    part := NULL; queued := 0; parts_left := NULL; waiting := false; locked := false;
    IF NOT pg_try_advisory_xact_lock(RSCANVAS_LOCK_NS, LOCK_PURGE_CENSUS) THEN
        locked := true;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT * INTO st FROM job_state WHERE job = 'rollup:purge-census';
    IF NOT FOUND THEN
        INSERT INTO job_state (job, through_ts, last_run_ts, last_ok_ts, runs, detail)
        SELECT 'rollup:purge-census', NULL, now(), now(), 0,
               jsonb_build_object('since', now(),
                   'todo', coalesce(jsonb_agg(c.relname::text ORDER BY c.relname), '[]'::jsonb))
          FROM pg_inherits i
          JOIN pg_class c ON c.oid = i.inhrelid
         WHERE i.inhparent = 'samples_hourly'::regclass;
        SELECT * INTO st FROM job_state WHERE job = 'rollup:purge-census';
    END IF;

    todo := ARRAY(SELECT jsonb_array_elements_text(coalesce(st.detail->'todo', '[]'::jsonb)));
    parts_left := cardinality(todo);
    IF parts_left = 0 THEN
        RETURN NEXT;
        RETURN;
    END IF;

    since := (st.detail->>'since')::timestamptz;
    frontier := (SELECT j.through_ts FROM job_state j WHERE j.job = 'rollup');
    IF frontier IS NULL OR frontier < since + interval '2 hours' THEN
        waiting := true;
        RETURN NEXT;
        RETURN;
    END IF;

    part := todo[1];
    -- A partition dropped since the list was taken has nothing left to find.
    IF to_regclass(format('%I', part)) IS NOT NULL THEN
        EXECUTE format(
            'INSERT INTO rollup_purge (entity_id, queued_ts)
             SELECT DISTINCT h.entity_id, $1 FROM %I h
              WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = h.entity_id)
             ON CONFLICT (entity_id) DO NOTHING', part)
        USING since;
        GET DIAGNOSTICS queued = ROW_COUNT;
    END IF;

    UPDATE job_state
       SET last_run_ts = now(), last_ok_ts = now(), runs = runs + 1,
           detail = jsonb_set(detail, '{todo}', to_jsonb(todo[2:]))
     WHERE job = 'rollup:purge-census';
    parts_left := parts_left - 1;
    RETURN NEXT;
END $$;
