-- Credential profiles: named, operator-created, secrets encrypted at rest.
--
-- See SLICE-CREDENTIALS-PLAN.md for the decision. The short form: profiles
-- are per-POLICY not per-device, so the count stays in single digits and the
-- ARCHITECTURE 4a argument against a credential store does not fire; the
-- backup argument does, and encryption under an env-provided RSCANVAS_SECRET
-- is the answer to it. A pg_dump carries the NAME and ciphertext, never the
-- community.
--
-- Every secret column holds iv:tag:ciphertext (AES-256-GCM, see
-- src/credentials/crypto.ts). v3_user is a username and not a secret; it is
-- stored plain so the UI can show it.
--
-- Designed for SNMPv3 from the first migration so it never needs a second
-- one. The v2c GUI ships first; the v3 columns are stored and validated but
-- the session layer does not use them until the v3 slice.
--
-- devices.credential_ref is UNCHANGED - a text name. It now resolves against
-- this table first and the environment second. Nothing here is a foreign key
-- on purpose: an env-named reference has no row to point at, and a profile
-- must be deletable while a device still names it (the device then refuses
-- to poll, loudly, by name - which is the correct outcome and the operator's
-- signal to fix one or the other).

CREATE TABLE IF NOT EXISTS credential_profiles (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          text NOT NULL UNIQUE,
    version       text NOT NULL CHECK (version IN ('1', '2c', '3')),
    community     text,
    v3_user       text,
    v3_level      text CHECK (v3_level IS NULL OR v3_level IN ('noAuthNoPriv', 'authNoPriv', 'authPriv')),
    v3_auth_proto text,
    v3_auth_key   text,
    v3_priv_proto text,
    v3_priv_key   text,
    created_ts    timestamptz NOT NULL DEFAULT now(),
    updated_ts    timestamptz NOT NULL DEFAULT now()
);
