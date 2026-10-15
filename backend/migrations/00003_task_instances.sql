-- +goose Up

-- Tasks in the calendar. This migration covers one-off tasks with a plan;
-- series, actual times, reschedule links and unplanned tasks are added by
-- later migrations (docs/roadmap.md, stages 4 and 5).
CREATE TABLE task_instances (
    id            uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id       uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title         text        NOT NULL
        CONSTRAINT task_instances_title_check CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
    description   text        NOT NULL DEFAULT ''
        CONSTRAINT task_instances_description_check CHECK (char_length(description) <= 5000),
    planned_start timestamptz NOT NULL,
    planned_end   timestamptz NOT NULL,
    status        text        NOT NULL DEFAULT 'planned'
        CONSTRAINT task_instances_status_check CHECK (
            status IN ('planned', 'in_progress', 'done', 'partial', 'not_done', 'rescheduled', 'cancelled')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    -- A task may cross midnight, but it cannot be empty or run backwards.
    CONSTRAINT task_instances_planned_range_check CHECK (planned_end > planned_start),
    -- Lets instance_categories force category and task to belong to one user.
    CONSTRAINT task_instances_id_user_key UNIQUE (id, user_id)
);

CREATE INDEX task_instances_user_planned_start_idx ON task_instances (user_id, planned_start);

CREATE TABLE instance_categories (
    instance_id uuid NOT NULL,
    category_id uuid NOT NULL,
    user_id     uuid NOT NULL,
    PRIMARY KEY (instance_id, category_id),
    CONSTRAINT instance_categories_instance_fkey FOREIGN KEY (instance_id, user_id)
        REFERENCES task_instances (id, user_id) ON DELETE CASCADE,
    -- Deleting a category takes it off all tasks; the tasks stay.
    CONSTRAINT instance_categories_category_fkey FOREIGN KEY (category_id, user_id)
        REFERENCES categories (id, user_id) ON DELETE CASCADE
);

CREATE INDEX instance_categories_category_id_idx ON instance_categories (category_id);

-- +goose Down
DROP TABLE instance_categories;
DROP TABLE task_instances;
