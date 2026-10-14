-- +goose Up
CREATE TABLE categories (
    id          uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    parent_id   uuid,
    name        text        NOT NULL
        CONSTRAINT categories_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 100),
    color       text        NOT NULL
        CONSTRAINT categories_color_check CHECK (color ~ '^#[0-9a-f]{6}$'),
    archived_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    -- Lets the parent reference below force a parent of the same user.
    CONSTRAINT categories_id_user_key UNIQUE (id, user_id),
    -- Deleting a category deletes its whole subtree.
    CONSTRAINT categories_parent_fkey FOREIGN KEY (parent_id, user_id)
        REFERENCES categories (id, user_id) ON DELETE CASCADE,
    CONSTRAINT categories_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE INDEX categories_user_id_idx ON categories (user_id);
CREATE INDEX categories_parent_id_idx ON categories (parent_id);

-- +goose Down
DROP TABLE categories;
