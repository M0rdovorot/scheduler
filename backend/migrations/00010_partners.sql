-- +goose Up

-- An invite link. Only the hash of the token is stored; the token itself is shown
-- to the inviter once.
CREATE TABLE partner_invites (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    inviter_id  uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash  bytea       NOT NULL UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    accepted_by uuid        REFERENCES users (id) ON DELETE CASCADE,
    accepted_at timestamptz,
    CONSTRAINT partner_invites_accepted_check CHECK ((accepted_by IS NULL) = (accepted_at IS NULL)),
    CONSTRAINT partner_invites_not_self_check CHECK (accepted_by IS NULL OR accepted_by <> inviter_id)
);

CREATE INDEX partner_invites_inviter_id_idx ON partner_invites (inviter_id);

-- A mutual link is two rows, (a, b) and (b, a), created and deleted together.
-- The grants below point at the row of their direction, so breaking the link
-- removes the grants.
CREATE TABLE partnerships (
    user_id    uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    partner_id uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, partner_id),
    CONSTRAINT partnerships_not_self_check CHECK (user_id <> partner_id)
);

CREATE INDEX partnerships_partner_id_idx ON partnerships (partner_id);

-- The grantee sees the titles of the owner's tasks (subject to task visibility).
CREATE TABLE task_access_grants (
    owner_id   uuid        NOT NULL,
    grantee_id uuid        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, grantee_id),
    CONSTRAINT task_access_grants_partnership_fkey FOREIGN KEY (owner_id, grantee_id)
        REFERENCES partnerships (user_id, partner_id) ON DELETE CASCADE
);

-- The grantee sees the owner's habits. Separate from task access (FR-11.8).
CREATE TABLE habit_access_grants (
    owner_id   uuid        NOT NULL,
    grantee_id uuid        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (owner_id, grantee_id),
    CONSTRAINT habit_access_grants_partnership_fkey FOREIGN KEY (owner_id, grantee_id)
        REFERENCES partnerships (user_id, partner_id) ON DELETE CASCADE
);

-- +goose Down
DROP TABLE habit_access_grants;
DROP TABLE task_access_grants;
DROP TABLE partnerships;
DROP TABLE partner_invites;
