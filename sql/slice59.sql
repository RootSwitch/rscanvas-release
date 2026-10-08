-- Slice 59 (2026-10-05): outside services, step 2 of SLICE-SERVICE-CHECKS-PLAN.md.
--
-- RSCanvas checks everything from one place, so one failure looks like many:
-- when its own internet goes, every outside check fails in the same minute,
-- and each would page on its own. This is the group alert for that case -
-- one alert, "outside services failing from RSCanvas", holding its members'
-- own down notifications while it is open, exactly as a location's group
-- alert holds its devices' (slice 55).
--
-- entities.outside: whether a check counts as outside, written by the
-- collector with each run's last values - the check's own setting, or for
-- 'auto' whether the address it reached is public. NULL is "cannot say": a
-- check never yet run, or an 'auto' run that reached no address, and the
-- write keeps the previous verdict for that - a check must not stop counting
-- as outside at the moment its internet is gone. One column, so the scan,
-- the hold predicate and the page read one answer instead of three copies
-- of the rule.
--
-- group_alert_rules.axis gains 'outside', the one rule a group can have
-- that is not a place or a service the operator named (its value is always
-- 'services'). Opt-in, like the rest: no row, no alert.

ALTER TABLE entities ADD COLUMN IF NOT EXISTS outside boolean;

ALTER TABLE group_alert_rules DROP CONSTRAINT IF EXISTS group_alert_rules_axis_check;
ALTER TABLE group_alert_rules ADD CONSTRAINT group_alert_rules_axis_check
    CHECK (axis IN ('location', 'application', 'outside'));
