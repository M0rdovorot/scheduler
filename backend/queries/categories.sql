-- name: ListCategories :many
SELECT * FROM categories
WHERE user_id = $1
ORDER BY created_at, id;

-- name: GetCategory :one
SELECT * FROM categories
WHERE id = $1 AND user_id = $2;

-- name: CreateCategory :one
INSERT INTO categories (user_id, parent_id, name, color)
VALUES ($1, $2, $3, $4)
RETURNING *;

-- name: UpdateCategory :one
UPDATE categories
SET name  = COALESCE(sqlc.narg('name'), name),
    color = COALESCE(sqlc.narg('color'), color)
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: SetCategoryParent :one
UPDATE categories
SET parent_id = $3
WHERE id = $1 AND user_id = $2
RETURNING *;

-- name: DeleteCategory :execrows
DELETE FROM categories
WHERE id = $1 AND user_id = $2;

-- name: ListCategorySubtreeIDs :many
-- The root and all its descendants.
WITH RECURSIVE subtree AS (
    SELECT c.id FROM categories c WHERE c.id = @root_id AND c.user_id = @user_id
    UNION ALL
    SELECT c.id FROM categories c JOIN subtree s ON c.parent_id = s.id WHERE c.user_id = @user_id
)
SELECT id FROM subtree;

-- name: ArchiveCategories :execrows
UPDATE categories
SET archived_at = @now
WHERE user_id = @user_id AND archived_at IS NULL AND id = ANY(@ids::uuid[]);

-- name: UnarchiveCategory :one
UPDATE categories
SET archived_at = NULL
WHERE id = $1 AND user_id = $2
RETURNING *;

-- name: LockUserCategories :exec
-- Serialises structural changes (create under a parent, move, archive) of one user.
SELECT pg_advisory_xact_lock(hashtextextended('categories:' || @user_id::text, 0));
