-- name: CreateSession :exec
INSERT INTO sessions (user_id, token_hash, expires_at)
VALUES ($1, $2, $3);

-- name: GetActiveSession :one
SELECT id, user_id, last_used_at
FROM sessions
WHERE token_hash = @token_hash AND expires_at > @now;

-- name: TouchSession :exec
UPDATE sessions SET last_used_at = $2 WHERE id = $1;

-- name: DeleteExpiredSessions :exec
DELETE FROM sessions WHERE expires_at <= $1;

-- name: DeleteSession :exec
DELETE FROM sessions WHERE token_hash = $1;
