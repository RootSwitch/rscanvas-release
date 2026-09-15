-- Slice 2: local accounts with roles, per-user sessions, an audit trail.
--
-- Additive, like slice 1. No DROP anywhere; src/db/apply-schema.ts refuses a
-- file containing one.
--
-- ARCHITECTURE.md section 3 settles the model. The suite's single shared
-- password is what fails a review: it cannot attribute an action, cannot be
-- revoked for one person, and cannot express "this operator may look but not
-- change". launchcanvas/server/auth.js already has the users table, the scrypt
-- parameters recorded in the stored string, sessions hashed at rest, sliding
-- expiry, and per-IP rate limiting. What it lacks is roles. So this is an
-- extension of working code.

CREATE TABLE IF NOT EXISTS users (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username      text NOT NULL UNIQUE,
    -- The full scrypt string, parameters included:
    --   scrypt$N=16384,r=8,p=1$<salt b64>$<hash b64>
    -- Carrying the parameters in the record is what lets them be raised later
    -- without invalidating every existing password.
    password      text NOT NULL,
    -- viewer may read, operator may change operational state, admin may change
    -- who exists. Checked in one place, authorize(), never inline.
    role          text NOT NULL DEFAULT 'viewer'
                  CHECK (role IN ('viewer', 'operator', 'admin')),
    disabled      boolean NOT NULL DEFAULT false,
    created_ts    timestamptz NOT NULL DEFAULT now(),
    last_login_ts timestamptz
);

-- Sessions are owned by a user and the database stores only sha256(token); the
-- cookie holds the raw token. A leaked database dump therefore does not hand
-- over live sessions.
--
-- Keyed by user_id rather than by username, which is a deliberate change from
-- the parent. There, deleting a user needed a second statement to delete their
-- sessions, and a missed call would leave a live session belonging to an
-- account that no longer exists. ON DELETE CASCADE makes that unrepresentable.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  text PRIMARY KEY,
    user_id     bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_ts  timestamptz NOT NULL DEFAULT now(),
    expires_ts  timestamptz NOT NULL,
    -- Recorded for the "where am I signed in" list a per-user session model
    -- makes possible, and to make a stolen-cookie investigation possible at all.
    user_agent  text,
    source_ip   inet
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_ts);

-- The audit trail. Attribution is the entire point of leaving a shared password
-- behind: "someone changed the SNMP credentials" is not an answer.
--
-- actor_username is DENORMALISED on purpose, and actor_id is nullable with ON
-- DELETE SET NULL. An audit row must survive the deletion of the user it
-- describes - otherwise deleting an account erases the evidence of what it did,
-- which is exactly backwards.
CREATE TABLE IF NOT EXISTS audit (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts              timestamptz NOT NULL DEFAULT now(),
    actor_id        bigint REFERENCES users(id) ON DELETE SET NULL,
    actor_username  text NOT NULL,
    action          text NOT NULL,
    target          text,
    detail          jsonb,
    source_ip       inet
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit (ts DESC);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit (actor_username, ts DESC);
