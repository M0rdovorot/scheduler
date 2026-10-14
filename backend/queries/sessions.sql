-- name: CreateSession :exec
INSERT INTO sessions (user_id, token_hash, expires_at)
VALUES ($1, $2, $3);

-- name: TouchSession :one
UPDATE sessions
SET last_used_at = @now
WHERE token_hash = @token_hash AND expires_at > @now
RETURNING user_id;

-- name: DeleteExpiredSessions :exec
DELETE FROM sessions WHERE expires_at <= $1;
