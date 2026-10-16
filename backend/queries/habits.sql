-- name: CreateHabit :one
INSERT INTO habits (user_id, title, kind, target_value, unit, frequency, weekdays, times_per_week, color, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: GetHabit :one
SELECT * FROM habits WHERE id = $1 AND user_id = $2;

-- name: LockHabit :one
SELECT * FROM habits WHERE id = $1 AND user_id = $2 FOR UPDATE;

-- name: ListHabits :many
SELECT * FROM habits WHERE user_id = $1 ORDER BY created_at, id;

-- name: UpdateHabit :one
UPDATE habits
SET title = $3, kind = $4, target_value = $5, unit = $6, frequency = $7,
    weekdays = $8, times_per_week = $9, color = $10
WHERE id = $1 AND user_id = $2
RETURNING *;

-- name: SetHabitArchived :one
UPDATE habits
SET archived_at = CASE WHEN @archived::boolean THEN COALESCE(archived_at, now()) ELSE NULL END
WHERE id = @id AND user_id = @user_id
RETURNING *;

-- name: DeleteHabit :execrows
DELETE FROM habits WHERE id = $1 AND user_id = $2;

-- name: ListHabitLogs :many
SELECT habit_id, date, value FROM habit_logs
WHERE user_id = $1
ORDER BY habit_id, date;

-- name: ListHabitLogsOf :many
SELECT habit_id, date, value FROM habit_logs
WHERE habit_id = $1 AND user_id = $2
ORDER BY date;

-- name: SetHabitLog :exec
-- A mark made by hand: it replaces the value and is no longer credited by a task.
INSERT INTO habit_logs (habit_id, user_id, date, value, task_instance_id)
VALUES ($1, $2, $3, $4, NULL)
ON CONFLICT (habit_id, date) DO UPDATE SET value = EXCLUDED.value, task_instance_id = NULL;

-- name: DeleteHabitLog :exec
DELETE FROM habit_logs WHERE habit_id = $1 AND user_id = $2 AND date = $3;

-- name: CreditHabitDay :exec
-- A done occurrence of a habit in the grid credits the day of its plan (in the time zone
-- of its series) with the goal. A larger value that is there already is kept.
INSERT INTO habit_logs (habit_id, user_id, date, value, task_instance_id)
SELECT h.id, h.user_id, (ti.planned_start AT TIME ZONE ts.timezone)::date, h.target_value, ti.id
FROM task_instances ti
JOIN task_series ts ON ts.id = ti.series_id AND ts.user_id = ti.user_id
JOIN habits h ON h.id = ts.habit_id AND h.user_id = ts.user_id
WHERE ti.id = @instance_id AND ti.user_id = @user_id AND ti.planned_start IS NOT NULL
ON CONFLICT (habit_id, date) DO UPDATE
SET value = EXCLUDED.value, task_instance_id = EXCLUDED.task_instance_id
WHERE habit_logs.value < EXCLUDED.value;

-- name: RevokeHabitCredit :exec
-- The occurrence is no longer done: what it credited goes, a value edited by hand stays.
DELETE FROM habit_logs WHERE task_instance_id = @instance_id AND user_id = @user_id;

-- name: ListHabitSeries :many
SELECT * FROM task_series WHERE habit_id = $1 AND user_id = $2 ORDER BY created_at DESC, id;

-- name: SetSeriesHabit :exec
UPDATE task_series SET habit_id = $3 WHERE id = $1 AND user_id = $2;

-- name: ListHabitPlacements :many
-- The current series of every habit that is placed in the grid.
SELECT DISTINCT ON (habit_id) habit_id, dtstart_local, duration_minutes
FROM task_series
WHERE user_id = $1 AND habit_id IS NOT NULL
ORDER BY habit_id, created_at DESC, id;
