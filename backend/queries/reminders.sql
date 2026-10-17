-- name: GetGlobalReminderSettings :one
SELECT * FROM reminder_settings WHERE user_id = $1 AND scope = 'global';

-- name: GetReminderSettings :one
-- The settings of one level; exactly one of the targets is given.
SELECT * FROM reminder_settings
WHERE user_id = @user_id AND scope = @scope
  AND category_id IS NOT DISTINCT FROM sqlc.narg('category_id')
  AND series_id   IS NOT DISTINCT FROM sqlc.narg('series_id')
  AND instance_id IS NOT DISTINCT FROM sqlc.narg('instance_id')
  AND habit_id    IS NOT DISTINCT FROM sqlc.narg('habit_id');

-- name: ListReminderSettings :many
SELECT * FROM reminder_settings WHERE user_id = $1;

-- name: ListReminderRules :many
SELECT r.* FROM reminder_rules r
JOIN reminder_settings s ON s.id = r.setting_id
WHERE s.user_id = $1
ORDER BY r.setting_id, r.kind, r.offset_minutes, r.time_of_day;

-- name: ListReminderRulesOf :many
SELECT * FROM reminder_rules WHERE setting_id = $1 ORDER BY kind, offset_minutes, time_of_day;

-- name: InsertReminderSettings :one
INSERT INTO reminder_settings (user_id, scope, category_id, series_id, instance_id, habit_id, enabled, quiet_start, quiet_end)
VALUES (@user_id, @scope, sqlc.narg('category_id'), sqlc.narg('series_id'), sqlc.narg('instance_id'), sqlc.narg('habit_id'),
        @enabled, sqlc.narg('quiet_start'), sqlc.narg('quiet_end'))
RETURNING *;

-- name: UpdateReminderSettings :one
UPDATE reminder_settings
SET enabled = @enabled, quiet_start = sqlc.narg('quiet_start'), quiet_end = sqlc.narg('quiet_end'), updated_at = now()
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: DeleteReminderRules :exec
DELETE FROM reminder_rules WHERE setting_id = $1;

-- name: AddReminderRule :exec
INSERT INTO reminder_rules (setting_id, kind, offset_minutes, time_of_day)
VALUES ($1, $2, sqlc.narg('offset_minutes'), sqlc.narg('time_of_day'))
ON CONFLICT DO NOTHING;

-- name: DeleteReminderSettings :execrows
DELETE FROM reminder_settings WHERE id = $1 AND user_id = $2;

-- name: ListRemindableUsers :many
-- Users whose master switch is on, with their time zone.
SELECT u.id, u.timezone
FROM users u
JOIN reminder_settings s ON s.user_id = u.id AND s.scope = 'global' AND s.enabled
ORDER BY u.id;

-- name: ListUserTelegramID :one
SELECT provider_user_id FROM user_identities
WHERE user_id = $1 AND provider = 'telegram'
LIMIT 1;

-- name: GetUserByTelegramID :one
SELECT user_id FROM user_identities
WHERE provider = 'telegram' AND provider_user_id = $1;

-- name: ListInstancesForReminders :many
-- Occurrences whose plan touches [from, to]: a reminder is due near the start or the end.
SELECT d.id, d.title, d.planned_start, d.planned_end, d.status, d.series_id, d.habit_id, d.category_ids
FROM instance_details d
WHERE d.user_id = @user_id AND d.status IN ('planned', 'in_progress')
  AND d.planned_start IS NOT NULL
  AND d.planned_end >= @from_time AND d.planned_start <= @to_time
ORDER BY d.planned_start, d.id;

-- name: InsertNotification :exec
INSERT INTO notifications (user_id, instance_id, habit_id, kind, dedupe_key, send_at)
VALUES (@user_id, sqlc.narg('instance_id'), sqlc.narg('habit_id'), @kind, @dedupe_key, @send_at)
ON CONFLICT (dedupe_key) DO NOTHING;

-- name: DeletePendingNotifications :exec
-- The planner makes them again, from the settings as they are now.
DELETE FROM notifications WHERE user_id = $1 AND sent_at IS NULL AND gave_up_at IS NULL;

-- name: ClaimDueNotifications :many
-- Pending messages whose time has come. SKIP LOCKED lets two senders share the queue.
SELECT * FROM notifications
WHERE sent_at IS NULL AND gave_up_at IS NULL AND send_at <= @now
ORDER BY send_at, id
LIMIT @batch
FOR UPDATE SKIP LOCKED;

-- name: MarkNotificationSent :exec
UPDATE notifications SET sent_at = @now, telegram_message_id = sqlc.narg('telegram_message_id'), attempts = attempts + 1, last_error = ''
WHERE id = @id;

-- name: MarkNotificationFailed :exec
-- A failed try: try again at retry_at, or give up when it is NULL.
UPDATE notifications
SET attempts = attempts + 1, last_error = @last_error,
    send_at = COALESCE(sqlc.narg('retry_at')::timestamptz, send_at),
    gave_up_at = CASE WHEN sqlc.narg('retry_at')::timestamptz IS NULL THEN @now::timestamptz ELSE NULL END
WHERE id = @id;

-- name: MarkNotificationSkipped :exec
-- The message is not needed any more (the task was marked meanwhile): it counts as dealt with.
UPDATE notifications SET gave_up_at = @now, last_error = @reason WHERE id = @id;
