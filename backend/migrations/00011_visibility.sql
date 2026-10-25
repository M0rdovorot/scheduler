-- +goose Up

-- Who sees the title of a task (FR-11.5): partners = all partners, granted =
-- partners with task access, private = nobody (partners see only "busy").
ALTER TABLE users
    ADD COLUMN default_visibility text NOT NULL DEFAULT 'private'
        CONSTRAINT users_default_visibility_check CHECK (default_visibility IN ('partners', 'granted', 'private'));

ALTER TABLE task_series
    ADD COLUMN visibility text NOT NULL DEFAULT 'private'
        CONSTRAINT task_series_visibility_check CHECK (visibility IN ('partners', 'granted', 'private'));

-- NULL means "as the series". A task without a series and without a value (its
-- series was deleted) is private.
ALTER TABLE task_instances
    ADD COLUMN visibility text
        CONSTRAINT task_instances_visibility_check CHECK (visibility IN ('partners', 'granted', 'private'));

-- The effective visibility of an occurrence. New columns go last.
CREATE OR REPLACE VIEW instance_details AS
SELECT ti.id, ti.user_id, ti.title, ti.description,
       ti.planned_start, ti.planned_end, ti.actual_start, ti.actual_end,
       ti.status, ti.comment, ti.series_id,
       COALESCE((SELECT array_agg(ic.category_id ORDER BY ic.category_id)
                 FROM instance_categories ic WHERE ic.instance_id = ti.id), '{}')::uuid[] AS category_ids,
       src.id AS from_id, src.planned_start AS from_planned_start, src.planned_end AS from_planned_end,
       dst.id AS to_id, dst.planned_start AS to_planned_start, dst.planned_end AS to_planned_end,
       ts.habit_id AS habit_id,
       COALESCE(ti.visibility, ts.visibility, 'private')::text AS visibility
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
       dst.id AS to_id, dst.planned_start AS to_planned_start, dst.planned_end AS to_planned_end,
       ts.habit_id AS habit_id
FROM task_instances ti
LEFT JOIN task_instances src ON src.id = ti.rescheduled_from_id AND src.status <> 'cancelled'
LEFT JOIN task_instances dst ON dst.rescheduled_from_id = ti.id AND dst.status <> 'cancelled'
LEFT JOIN task_series ts ON ts.id = ti.series_id AND ts.user_id = ti.user_id;
ALTER TABLE task_instances DROP COLUMN visibility;
ALTER TABLE task_series DROP COLUMN visibility;
ALTER TABLE users DROP COLUMN default_visibility;
