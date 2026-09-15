-- Slice 8 / U5: boards, capability tokens.
--
-- Read sql/slice8.sql alongside BOARD-EXPOSURE.md. The schema is shaped by
-- that document's two clauses, and several columns exist only to make them
-- enforceable rather than merely intended.

-- BOARDS, in two collections rather than two tables. The distinction that
-- matters is whether a board is MONITORED (live, rendered on displays, driven
-- by device status) or a DIAGRAM (stored and shared, a team's repository).
-- ARCHITECTURE calls that out as the real axis - not where the bytes live -
-- so it is a column, and every query that serves a display filters on it.
CREATE TABLE IF NOT EXISTS boards (
    id           bigserial PRIMARY KEY,
    name         text NOT NULL,
    collection   text NOT NULL CHECK (collection IN ('wall', 'diagram')),
    owner_id     integer REFERENCES users (id) ON DELETE SET NULL,

    -- THE BOARD DOCUMENT. This is the thing BOARD-EXPOSURE clause 1 says never
    -- leaves the server: shapes, bindings, addresses, annotations, and any
    -- field the renderer ignores. A display never receives this column; it
    -- receives a projection computed from it.
    doc          jsonb NOT NULL DEFAULT '{}'::jsonb,

    -- Clause 3: addresses are a per-board decision, DEFAULT OFF. The default
    -- is the load-bearing part. The parent's failure was not that somebody
    -- chose to expose addresses - it was that addresses were in the file
    -- because the application needed them, and serving the file served them.
    -- Nobody chose. Here, not choosing means not exposed.
    show_addresses boolean NOT NULL DEFAULT false,

    created_ts   timestamptz NOT NULL DEFAULT now(),
    updated_ts   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS boards_name_idx ON boards (name);

-- CAPABILITY TOKENS.
--
-- One token, one board, enforced by the foreign key and by the fact that
-- there is no nullable "all boards" state. A token that could name its own
-- board id is not a capability, it is a role (BOARD-EXPOSURE clause 2).
CREATE TABLE IF NOT EXISTS board_tokens (
    id           bigserial PRIMARY KEY,
    board_id     bigint NOT NULL REFERENCES boards (id) ON DELETE CASCADE,

    -- STORED HASHED, like a password, for the same reason: this table is what
    -- a SQL-injection or a stolen backup yields, and a plaintext capability
    -- URL in a backup is a working credential for as long as the token lives.
    -- sha256 rather than a slow KDF deliberately - the secret is 32 random
    -- bytes minted by the server, not a human-chosen password, so there is no
    -- dictionary to slow down and every display render would pay the cost.
    token_hash   text NOT NULL,

    -- Named, because revocation is a human act and "revoke the token" needs
    -- to be answerable as "which one is the lobby screen".
    label        text NOT NULL,

    created_ts   timestamptz NOT NULL DEFAULT now(),
    created_by   integer REFERENCES users (id) ON DELETE SET NULL,

    -- last_used_ts answers the question that decides whether revoking is safe:
    -- "is anything still using this". Updated on use, but see the note in
    -- ops.ts - it is NOT written on every render.
    last_used_ts timestamptz,

    -- REVOCATION IS A COLUMN, NOT A DELETE. A deleted row cannot answer "was
    -- this token revoked, or did it never exist" - and after an incident that
    -- is exactly the question. Revoked tokens stay, with who and when.
    revoked_ts   timestamptz,
    revoked_by   integer REFERENCES users (id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS board_tokens_hash_idx ON board_tokens (token_hash);
CREATE INDEX IF NOT EXISTS board_tokens_board_idx ON board_tokens (board_id);
