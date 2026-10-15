-- +goose Up

-- A regular task: the template of a repeat rule. Occurrences are materialised
-- lazily as rows of task_instances, for the windows that are asked for.
CREATE TABLE task_series (
    id               uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id          uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title            text        NOT NULL
        CONSTRAINT task_series_title_check CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
    description      text        NOT NULL DEFAULT ''
        CONSTRAINT task_series_description_check CHECK (char_length(description) <= 5000),
    -- RRULE value without DTSTART, e.g. FREQ=WEEKLY;BYDAY=MO,WE
    rrule            text        NOT NULL
        CONSTRAINT task_series_rrule_check CHECK (char_length(rrule) BETWEEN 1 AND 200),
    -- Wall-clock start of the first occurrence slot, read in `timezone`.
    dtstart_local    timestamp   NOT NULL,
    timezone         text        NOT NULL,
    duration_minutes integer     NOT NULL
        CONSTRAINT task_series_duration_check CHECK (duration_minutes > 0),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT task_series_id_user_key UNIQUE (id, user_id)
);

CREATE INDEX task_series_user_id_idx ON task_series (user_id);

CREATE TABLE series_categories (
    series_id   uuid NOT NULL,
    category_id uuid NOT NULL,
    user_id     uuid NOT NULL,
    PRIMARY KEY (series_id, category_id),
    CONSTRAINT series_categories_series_fkey FOREIGN KEY (series_id, user_id)
        REFERENCES task_series (id, user_id) ON DELETE CASCADE,
    CONSTRAINT series_categories_category_fkey FOREIGN KEY (category_id, user_id)
        REFERENCES categories (id, user_id) ON DELETE CASCADE
);

CREATE INDEX series_categories_category_id_idx ON series_categories (category_id);

ALTER TABLE task_instances
    -- original_start is the occurrence time by the rule: the key of the instance inside its series.
    ADD COLUMN series_id      uuid,
    ADD COLUMN original_start timestamptz,
    -- The instance was edited on its own; edits of the whole series leave it alone.
    ADD COLUMN is_detached    boolean NOT NULL DEFAULT false,
    -- Deleting a series keeps the instances that must not disappear (history): they lose the link.
    ADD CONSTRAINT task_instances_series_fkey FOREIGN KEY (series_id, user_id)
        REFERENCES task_series (id, user_id) ON DELETE SET NULL (series_id),
    ADD CONSTRAINT task_instances_series_original_check CHECK (series_id IS NULL OR original_start IS NOT NULL),
    ADD CONSTRAINT task_instances_series_original_start_key UNIQUE (series_id, original_start);

-- +goose Down
ALTER TABLE task_instances
    DROP CONSTRAINT task_instances_series_original_start_key,
    DROP CONSTRAINT task_instances_series_original_check,
    DROP CONSTRAINT task_instances_series_fkey,
    DROP COLUMN is_detached,
    DROP COLUMN original_start,
    DROP COLUMN series_id;
DROP TABLE series_categories;
DROP TABLE task_series;
