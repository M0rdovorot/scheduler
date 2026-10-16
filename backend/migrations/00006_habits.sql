-- +goose Up

-- A habit: a thing to do regularly, with a daily goal (yes/no or a quantity).
CREATE TABLE habits (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title          text        NOT NULL
        CONSTRAINT habits_title_check CHECK (title = btrim(title) AND char_length(title) BETWEEN 1 AND 200),
    kind           text        NOT NULL
        CONSTRAINT habits_kind_check CHECK (kind IN ('boolean', 'quantity')),
    -- The value that makes a day done: 1 for yes/no.
    target_value   integer     NOT NULL DEFAULT 1
        CONSTRAINT habits_target_check CHECK (target_value BETWEEN 1 AND 100000),
    unit           text        NOT NULL DEFAULT ''
        CONSTRAINT habits_unit_check CHECK (char_length(unit) <= 30),
    frequency      text        NOT NULL
        CONSTRAINT habits_frequency_check CHECK (frequency IN ('daily', 'weekdays', 'times_per_week')),
    -- ISO weekdays, 1 = Monday … 7 = Sunday, for `weekdays`.
    weekdays       smallint[]  NOT NULL DEFAULT '{}',
    times_per_week smallint,
    color          text        NOT NULL
        CONSTRAINT habits_color_check CHECK (color ~ '^#[0-9a-f]{6}$'),
    archived_at    timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT habits_id_user_key UNIQUE (id, user_id),
    CONSTRAINT habits_boolean_check CHECK (kind <> 'boolean' OR (target_value = 1 AND unit = '')),
    CONSTRAINT habits_weekdays_check CHECK (
        (frequency = 'weekdays') = (cardinality(weekdays) > 0)
        AND weekdays <@ ARRAY[1, 2, 3, 4, 5, 6, 7]::smallint[]),
    CONSTRAINT habits_times_check CHECK (
        (frequency = 'times_per_week') = (times_per_week IS NOT NULL)
        AND (times_per_week IS NULL OR times_per_week BETWEEN 1 AND 7))
);

CREATE INDEX habits_user_id_idx ON habits (user_id);

-- The value of a habit on a local date. A day without a row has no mark.
CREATE TABLE habit_logs (
    habit_id         uuid    NOT NULL,
    user_id          uuid    NOT NULL,
    date             date    NOT NULL,
    value            integer NOT NULL
        CONSTRAINT habit_logs_value_check CHECK (value BETWEEN 1 AND 1000000),
    -- The occurrence in the calendar that credited the day; NULL for a mark made by hand.
    task_instance_id uuid,
    PRIMARY KEY (habit_id, date),
    CONSTRAINT habit_logs_habit_fkey FOREIGN KEY (habit_id, user_id)
        REFERENCES habits (id, user_id) ON DELETE CASCADE,
    CONSTRAINT habit_logs_instance_fkey FOREIGN KEY (task_instance_id, user_id)
        REFERENCES task_instances (id, user_id) ON DELETE SET NULL (task_instance_id)
);

CREATE INDEX habit_logs_user_id_idx ON habit_logs (user_id);
CREATE INDEX habit_logs_instance_idx ON habit_logs (task_instance_id) WHERE task_instance_id IS NOT NULL;

-- A habit placed in the grid is a regular task that points at it.
ALTER TABLE task_series
    ADD COLUMN habit_id uuid,
    ADD CONSTRAINT task_series_habit_fkey FOREIGN KEY (habit_id, user_id)
        REFERENCES habits (id, user_id) ON DELETE SET NULL (habit_id);

CREATE INDEX task_series_habit_id_idx ON task_series (habit_id) WHERE habit_id IS NOT NULL;

-- The habit of an occurrence, for the calendar. New columns go last.
CREATE OR REPLACE VIEW instance_details AS
SELECT ti.id, ti.user_id, ti.title, ti.description,
       ti.planned_start, ti.planned_end, ti.actual_start, ti.actual_end,
       ti.status, ti.comment, ti.series_id,
       COALESCE((SELECT array_agg(ic.category_id ORDER BY ic.category_id)
                 FROM instance_categories ic WHERE ic.instance_id = ti.id), '{}')::uuid[] AS category_ids,
       src.id AS from_id, src.planned_start AS from_planned_start, src.planned_end AS from_planned_end,
       dst.id AS to_id, dst.planned_start AS to_planned_start, dst.planned_end AS to_planned_end,
       ts.habit_id AS habit_id
FROM task_instances ti
LEFT JOIN task_instances src ON src.id = ti.rescheduled_from_id AND src.status <> 'cancelled'
LEFT JOIN task_instances dst ON dst.rescheduled_from_id = ti.id AND dst.status <> 'cancelled'
LEFT JOIN task_series ts ON ts.id = ti.series_id AND ts.user_id = ti.user_id;

-- +goose Down
DROP VIEW instance_details;
CREATE VIEW instance_details AS
SELECT ti.id, ti.user_id, ti.title, ti.description,
       ti.planned_start, ti.planned_end, ti.actual_start, ti.actual_end,
       ti.status, ti.comment, ti.series_id,
       COALESCE((SELECT array_agg(ic.category_id ORDER BY ic.category_id)
                 FROM instance_categories ic WHERE ic.instance_id = ti.id), '{}')::uuid[] AS category_ids,
       src.id AS from_id, src.planned_start AS from_planned_start, src.planned_end AS from_planned_end,
       dst.id AS to_id, dst.planned_start AS to_planned_start, dst.planned_end AS to_planned_end
FROM task_instances ti
LEFT JOIN task_instances src ON src.id = ti.rescheduled_from_id AND src.status <> 'cancelled'
LEFT JOIN task_instances dst ON dst.rescheduled_from_id = ti.id AND dst.status <> 'cancelled';
DROP INDEX task_series_habit_id_idx;
ALTER TABLE task_series DROP CONSTRAINT task_series_habit_fkey, DROP COLUMN habit_id;
DROP TABLE habit_logs;
DROP TABLE habits;
