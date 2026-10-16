-- name: ListInstances :many
-- Tasks whose plan overlaps [from, to). Cancelled ones (deleted occurrences of a series) are not part of the plan.
SELECT ti.id, ti.title, ti.description, ti.planned_start, ti.planned_end, ti.status, ti.series_id,
       COALESCE(array_agg(ic.category_id ORDER BY ic.category_id) FILTER (WHERE ic.category_id IS NOT NULL), '{}')::uuid[] AS category_ids
FROM task_instances ti
LEFT JOIN instance_categories ic ON ic.instance_id = ti.id
WHERE ti.user_id = @user_id
  AND ti.planned_start < @range_to
  AND ti.planned_end > @range_from
  AND ti.status <> 'cancelled'
GROUP BY ti.id
ORDER BY ti.planned_start, ti.id;

-- name: GetInstance :one
SELECT ti.id, ti.title, ti.description, ti.planned_start, ti.planned_end, ti.status, ti.series_id,
       COALESCE(array_agg(ic.category_id ORDER BY ic.category_id) FILTER (WHERE ic.category_id IS NOT NULL), '{}')::uuid[] AS category_ids
FROM task_instances ti
LEFT JOIN instance_categories ic ON ic.instance_id = ti.id
WHERE ti.id = @id AND ti.user_id = @user_id
GROUP BY ti.id;

-- name: LockInstance :one
-- Cancelled instances are deleted occurrences: not found for edits and deletes.
SELECT * FROM task_instances
WHERE id = $1 AND user_id = $2 AND status <> 'cancelled'
FOR UPDATE;

-- name: CreateInstance :one
INSERT INTO task_instances (user_id, title, description, planned_start, planned_end)
VALUES ($1, $2, $3, $4, $5)
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
