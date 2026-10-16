-- name: CreateSeries :one
INSERT INTO task_series (user_id, title, description, rrule, dtstart_local, timezone, duration_minutes)
VALUES ($1, $2, $3, $4, $5, $6, $7)
RETURNING *;

-- name: GetSeries :one
SELECT * FROM task_series WHERE id = $1 AND user_id = $2;

-- name: ListSeries :many
SELECT * FROM task_series WHERE user_id = $1 ORDER BY created_at, id;

-- name: UpdateSeries :exec
UPDATE task_series
SET title = $3, description = $4, rrule = $5, dtstart_local = $6, duration_minutes = $7, updated_at = now()
WHERE id = $1 AND user_id = $2;

-- name: DeleteSeries :exec
DELETE FROM task_series WHERE id = $1 AND user_id = $2;

-- name: ListSeriesCategoryIDs :many
SELECT category_id FROM series_categories
WHERE series_id = $1 AND user_id = $2
ORDER BY category_id;

-- name: ClearSeriesCategories :exec
DELETE FROM series_categories WHERE series_id = $1 AND user_id = $2;

-- name: AddSeriesCategories :exec
INSERT INTO series_categories (series_id, category_id, user_id)
SELECT @series_id, c, @user_id FROM unnest(@category_ids::uuid[]) AS c;

-- name: MaterializeInstance :batchone
-- Creates one occurrence; when it exists already (also cancelled) nothing is returned.
INSERT INTO task_instances (user_id, series_id, original_start, title, description, planned_start, planned_end)
VALUES ($1, $2, $3, $4, $5, $3, $6)
ON CONFLICT (series_id, original_start) DO NOTHING
RETURNING id;

-- name: CopySeriesCategoriesToInstances :exec
INSERT INTO instance_categories (instance_id, category_id, user_id)
SELECT i, sc.category_id, sc.user_id
FROM unnest(@instance_ids::uuid[]) AS i
CROSS JOIN series_categories sc
WHERE sc.series_id = @series_id AND sc.user_id = @user_id;

-- name: DeleteSeriesInstances :execrows
-- Removes instances of a series that an edit or a delete of the series may remove:
-- planned ones, from `from_start` on (all of them when it is NULL). Instances that
-- were marked (any status but planned, except cancelled) are history and are never
-- touched. Detached instances survive an edit of the series but not its deletion.
-- Cancelled ones (deleted occurrences) are kept by an edit, so that they are not
-- created again, and removed together with the series or its tail.
DELETE FROM task_instances
WHERE series_id = @series_id AND user_id = @user_id
  AND (status = 'planned' OR (@include_cancelled::boolean AND status = 'cancelled'))
  AND (@include_detached::boolean OR NOT is_detached)
  AND (sqlc.narg('from_start')::timestamptz IS NULL OR original_start >= sqlc.narg('from_start'));

-- name: CancelInstance :exec
UPDATE task_instances SET status = 'cancelled', updated_at = now()
WHERE id = $1 AND user_id = $2;

-- name: LockSeriesChanges :exec
-- Serialises materialisation and edits of the series of one user.
SELECT pg_advisory_xact_lock(hashtextextended('series:' || @user_id::text, 0));

-- name: MoveSeriesInstances :exec
-- Hands the instances of a series from `from_start` on over to another series (the
-- tail that a split cuts off), so that they keep owning their slots there.
UPDATE task_instances
SET series_id = @new_series_id
WHERE series_id = @old_series_id AND user_id = @user_id AND original_start >= @from_start;

-- name: ListSeriesSurvivors :many
-- The instances of a series that an edit leaves in place: detached, cancelled or marked.
SELECT id, original_start FROM task_instances
WHERE series_id = @series_id AND user_id = @user_id
  AND (status <> 'planned' OR is_detached);

-- name: SetInstanceOriginalStart :exec
UPDATE task_instances SET original_start = $3 WHERE id = $1 AND user_id = $2;

-- name: LockSeriesChangesShared :exec
-- Materialisation may run in parallel with itself, but not with an edit of a series.
SELECT pg_advisory_xact_lock_shared(hashtextextended('series:' || @user_id::text, 0));
