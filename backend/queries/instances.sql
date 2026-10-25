-- name: ListInstances :many
-- Tasks whose plan or fact overlaps [from, to). A running timer lasts until `now`.
-- Cancelled ones (deleted occurrences of a series) are not part of the calendar.
SELECT * FROM instance_details
WHERE user_id = @user_id
  AND status <> 'cancelled'
  AND ((planned_start < @range_to AND planned_end > @range_from)
       OR (actual_start < @range_to AND COALESCE(actual_end, @now::timestamptz) > @range_from))
ORDER BY COALESCE(planned_start, actual_start), id;

-- name: GetInstance :one
SELECT * FROM instance_details WHERE id = @id AND user_id = @user_id;

-- name: LockInstance :one
-- Cancelled instances are deleted occurrences: not found for edits and deletes.
SELECT * FROM task_instances
WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'
FOR UPDATE;

-- name: CreateInstance :one
INSERT INTO task_instances (user_id, title, description, planned_start, planned_end, visibility)
VALUES (@user_id, @title, @description, @planned_start, @planned_end,
        COALESCE(sqlc.narg('visibility'), (SELECT default_visibility FROM users WHERE id = @user_id)))
RETURNING id;

-- name: UpdateInstance :exec
UPDATE task_instances
SET title = $3, description = $4, planned_start = $5, planned_end = $6,
    is_detached = is_detached OR @detach::boolean, updated_at = now()
WHERE id = $1 AND user_id = $2;

-- name: DeleteInstance :execrows
DELETE FROM task_instances WHERE id = $1 AND user_id = $2;

-- name: ClearInstanceCategories :exec
DELETE FROM instance_categories WHERE instance_id = $1 AND user_id = $2;

-- name: AddInstanceCategories :exec
INSERT INTO instance_categories (instance_id, category_id, user_id)
SELECT @instance_id, c, @user_id FROM unnest(@category_ids::uuid[]) AS c;

-- name: CountUserCategories :one
SELECT count(*) FROM categories
WHERE user_id = @user_id AND id = ANY(@ids::uuid[]);

-- name: SetTracking :exec
UPDATE task_instances
SET status = $3, actual_start = $4, actual_end = $5, comment = $6, updated_at = now()
WHERE id = $1 AND user_id = $2;

-- name: CreateUnplannedInstance :one
INSERT INTO task_instances (user_id, title, description, status, actual_start, actual_end, visibility)
VALUES (@user_id, @title, @description, @status, @actual_start, @actual_end,
        (SELECT default_visibility FROM users WHERE id = @user_id))
RETURNING id;

-- name: CreateRescheduledInstance :one
-- The new task is as visible as the one it replaces.
INSERT INTO task_instances (user_id, title, description, planned_start, planned_end, rescheduled_from_id, visibility)
VALUES (@user_id, @title, @description, @planned_start, @planned_end, @rescheduled_from_id,
        (SELECT COALESCE(src.visibility, ts.visibility, 'private')
         FROM task_instances src
         LEFT JOIN task_series ts ON ts.id = src.series_id AND ts.user_id = src.user_id
         WHERE src.id = @rescheduled_from_id AND src.user_id = @user_id))
RETURNING id;

-- name: CopyInstanceCategories :exec
INSERT INTO instance_categories (instance_id, category_id, user_id)
SELECT @to_id::uuid, src.category_id, src.user_id FROM instance_categories src
WHERE src.instance_id = @from_id AND src.user_id = @user_id;

-- name: HasLiveReplacement :one
-- Whether a rescheduled task still has the task it was moved to.
SELECT EXISTS (
    SELECT 1 FROM task_instances r
    WHERE r.rescheduled_from_id = @id AND r.user_id = @user_id AND r.status <> 'cancelled'
) AS has_replacement;

-- name: ListRunningInstances :many
-- Tasks with a running timer, from whatever day they were started.
SELECT * FROM instance_details
WHERE user_id = $1 AND status = 'in_progress'
ORDER BY actual_start, id;

-- name: SetInstanceVisibility :exec
-- Its own value for one task; NULL goes back to the series.
UPDATE task_instances SET visibility = sqlc.narg('visibility'), updated_at = now()
WHERE id = @id AND user_id = @user_id;
