-- Slice 23: entities.exported becomes entities.tracked.
--
-- The column arrived at slice 4 wearing the parent's name: in SNMPCanvas
-- the flag meant "exported to the board file". Here it has always meant
-- TRACKED - it gates the alert scan, the roster's entity counts, the
-- poll's sample writes and the summary fold - and the UI has said
-- track/untrack since the untrack slice. A schema that says what it means
-- costs one rename; every future reader stops translating.
--
-- REVISED 2026-08-27, after a production re-deploy found the original
-- version's blind spot. The first cut renamed whenever exported existed,
-- and its comment declared leaving slice 4 untouched "deliberate" - true
-- for fresh installs and for the first upgrade, WRONG for every re-apply
-- after the rename: slice 4's un-guarded ADD COLUMN IF NOT EXISTS
-- re-created exported as an empty husk beside tracked, and this rename
-- then collided on a database that was already correct. Slice 4 now
-- guards its ADD; this file converges all three states:
--
--   exported only          the rename (fresh installs, first upgrade)
--   exported AND tracked   the husk state from the incident window: the
--                          re-added column holds nothing but its default,
--                          the data lives in tracked, and removing the
--                          husk restores the state this series describes.
--                          (DROP COLUMN of an empty husk is corrective,
--                          not destructive - the additive guard's list
--                          of forbidden statements agrees.)
--   tracked only           nothing to do.
--
-- The partial index entities_pollable_idx follows the rename by itself -
-- postgres stores the parsed predicate, not the text.

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'entities'
                  AND column_name = 'exported') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'entities'
                      AND column_name = 'tracked') THEN
            ALTER TABLE entities DROP COLUMN exported;
        ELSE
            ALTER TABLE entities RENAME COLUMN exported TO tracked;
        END IF;
    END IF;
END $$;
