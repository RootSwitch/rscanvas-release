-- Slice 25: the two quiets (SLICE-INTERMITTENT-DEVICES-PLAN).
--
-- Quiet 2 first because it is one column: `transient` is the operator's
-- declaration that offline is a STATE for this device, not a fault. The
-- device-down rule reads it and emits severity null (the watchdog's healthy
-- pattern), so flipping the flag on an alerting device clears the alert
-- through the existing machinery - the recovery path is the absence of new
-- machinery. Nothing is ever derived from behavior: a device that flaps a
-- lot does NOT get auto-classified, because auto-classification is how a
-- genuinely failing machine gets relabeled as a lifestyle.

ALTER TABLE devices ADD COLUMN IF NOT EXISTS transient boolean NOT NULL DEFAULT false;

-- Quiet 1: a STANDING notification policy - raises but never pages. The
-- operator's own framing: Dev/Test boxes "you might want to monitor, but
-- don't care to be alerted on". Alerts still raise, still show on every
-- page and wall; only DELIVERY is withheld, permanently, while the policy
-- row stands. This is a different declaration from a maintenance window -
-- a policy does not expire, so it carries no timestamps beyond creation
-- metadata - and deliberately has NO 'all' scope: a policy covering
-- everything is the notification channel switched off wearing a costume,
-- and the channel toggle already exists for that.
--
-- UNIQUE (scope, target) because two identical policies are one policy
-- written twice: creation is idempotent, the second write reports "already
-- covered" rather than stacking a row the delete button would then only
-- half-remove.

CREATE TABLE IF NOT EXISTS notify_policy (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    scope       text NOT NULL CHECK (scope IN ('device', 'location', 'application')),
    target      text NOT NULL,
    note        text,
    created_by  text,
    created_ts  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, target)
);
