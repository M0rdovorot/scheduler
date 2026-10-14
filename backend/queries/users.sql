-- name: GetUser :one
SELECT * FROM users WHERE id = $1;

-- name: CreateUser :one
INSERT INTO users (display_name, timezone)
VALUES ($1, $2)
RETURNING *;

-- name: UpdateUserSettings :one
UPDATE users
SET timezone                    = COALESCE(sqlc.narg('timezone'), timezone),
    slot_minutes                = COALESCE(sqlc.narg('slot_minutes'), slot_minutes),
    default_view                = COALESCE(sqlc.narg('default_view'), default_view),
    deviation_threshold_minutes = COALESCE(sqlc.narg('deviation_threshold_minutes'), deviation_threshold_minutes)
WHERE id = @id
RETURNING *;

-- name: GetIdentity :one
SELECT * FROM user_identities
WHERE provider = $1 AND provider_user_id = $2;

-- name: CreateIdentity :exec
INSERT INTO user_identities (user_id, provider, provider_user_id, username, first_name, last_name, photo_url, language_code)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8);

-- name: UpdateIdentityProfile :exec
UPDATE user_identities
SET username = $2, first_name = $3, last_name = $4, photo_url = $5, language_code = $6
WHERE id = $1;
