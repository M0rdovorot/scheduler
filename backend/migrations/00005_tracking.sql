-- +goose Up

-- Tracking: the fact (what really happened), the reschedule link, a comment, and
-- tasks that were never planned.
ALTER TABLE task_instances
    ALTER COLUMN planned_start DROP NOT NULL,
    ALTER COLUMN planned_end DROP NOT NULL,
    ADD COLUMN actual_start timestamptz,
    -- NULL while a timer is running.
    ADD COLUMN actual_end timestamptz,
    ADD COLUMN comment text NOT NULL DEFAULT ''
        CONSTRAINT task_instances_comment_check CHECK (char_length(comment) <= 2000),
    -- The task this one was rescheduled from; a task is rescheduled at most once.
    ADD COLUMN rescheduled_from_id uuid,
    ADD CONSTRAINT task_instances_rescheduled_from_fkey FOREIGN KEY (rescheduled_from_id, user_id)
        REFERENCES task_instances (id, user_id) ON DELETE SET NULL (rescheduled_from_id),
    -- The plan is whole or absent (an unplanned task has only a fact). The existing
    -- planned_end > planned_start check is NULL-safe.
    ADD CONSTRAINT task_instances_plan_whole_check CHECK ((planned_start IS NULL) = (planned_end IS NULL)),
    ADD CONSTRAINT task_instances_actual_range_check CHECK (
        actual_end IS NULL OR (actual_start IS NOT NULL AND actual_end >= actual_start)),
    ADD CONSTRAINT task_instances_has_time_check CHECK (planned_start IS NOT NULL OR actual_start IS NOT NULL),
    -- The status and the fact agree.
    ADD CONSTRAINT task_instances_status_fact_check CHECK (
        CASE status
            WHEN 'planned' THEN planned_start IS NOT NULL AND actual_start IS NULL
            WHEN 'in_progress' THEN actual_start IS NOT NULL AND actual_end IS NULL
            WHEN 'done' THEN actual_start IS NOT NULL AND actual_end IS NOT NULL
            WHEN 'partial' THEN actual_start IS NOT NULL AND actual_end IS NOT NULL
            ELSE true
        END);

CREATE UNIQUE INDEX task_instances_rescheduled_from_key
    ON task_instances (rescheduled_from_id) WHERE rescheduled_from_id IS NOT NULL;
CREATE INDEX task_instances_user_actual_start_idx ON task_instances (user_id, actual_start);

-- One row per task with everything the API shows: categories and the reschedule
-- links in both directions (a deleted task is not a link target).
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

-- +goose Down
DROP VIEW instance_details;
DROP INDEX task_instances_user_actual_start_idx;
DROP INDEX task_instances_rescheduled_from_key;
ALTER TABLE task_instances
    DROP CONSTRAINT task_instances_status_fact_check,
    DROP CONSTRAINT task_instances_has_time_check,
    DROP CONSTRAINT task_instances_actual_range_check,
    DROP CONSTRAINT task_instances_plan_whole_check,
    DROP CONSTRAINT task_instances_rescheduled_from_fkey,
    DROP COLUMN rescheduled_from_id,
    DROP COLUMN comment,
    DROP COLUMN actual_end,
    DROP COLUMN actual_start,
    ALTER COLUMN planned_end SET NOT NULL,
    ALTER COLUMN planned_start SET NOT NULL;
