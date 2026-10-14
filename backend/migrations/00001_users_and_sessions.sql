-- +goose Up
CREATE TABLE users (
    id                           uuid PRIMARY KEY DEFAULT uuidv7(),
    display_name                 text        NOT NULL,
    timezone                     text        NOT NULL,
    slot_minutes                 integer     NOT NULL DEFAULT 30
        CONSTRAINT users_slot_minutes_check CHECK (slot_minutes IN (5, 10, 15, 30, 60)),
    default_view                 text        NOT NULL DEFAULT 'day'
        CONSTRAINT users_default_view_check CHECK (default_view IN ('day', 'three_days', 'week')),
    deviation_threshold_minutes  integer     NOT NULL DEFAULT 10
        CONSTRAINT users_deviation_threshold_check CHECK (deviation_threshold_minutes >= 0),
    created_at                   timestamptz NOT NULL DEFAULT now()
);

-- Sign-in methods. provider is 'telegram' (plus 'dev' when DEV_AUTH is on);
-- 'email' joins with the web version.
CREATE TABLE user_identities (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    provider         text        NOT NULL,
    provider_user_id text        NOT NULL,
    username         text,
    first_name       text,
    last_name        text,
    photo_url        text,
    language_code    text,
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT user_identities_provider_key UNIQUE (provider, provider_user_id)
);

CREATE INDEX user_identities_user_id_idx ON user_identities (user_id);

CREATE TABLE sessions (
    id           uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id      uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash   bytea       NOT NULL UNIQUE,
    created_at   timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    last_used_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- +goose Down
DROP TABLE sessions;
DROP TABLE user_identities;
DROP TABLE users;
