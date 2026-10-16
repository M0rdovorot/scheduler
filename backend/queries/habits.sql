-- name: CreateHabit :one
INSERT INTO habits (user_id, title, kind, target_value, unit, frequency, weekdays, times_per_week, color, created_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
RETURNING *;

-- name: GetHabit :one
SELECT * FROM habits WHERE id = $1 AND user_id = $2;

-- name: LockHabit :one
-- NO KEY UPDATE: it must not conflict with the key-share lock that a mark takes on the habit.
SELECT * FROM habits WHERE id = $1 AND user_id = $2 FOR NO KEY UPDATE;

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
INSERT INTO habit_logs (habit_id, user_id, date, value, task_instance_id, base_value)
VALUES ($1, $2, $3, $4, NULL, 0)
ON CONFLICT (habit_id, date) DO UPDATE SET value = EXCLUDED.value, task_instance_id = NULL, base_value = 0;

-- name: DeleteHabitLog :exec
DELETE FROM habit_logs WHERE habit_id = $1 AND user_id = $2 AND date = $3;

-- name: CreditHabitDay :exec
-- An occurrence of a habit in the grid that became done credits the day of its plan (in the
-- time zone of its series) with the goal. A value that is there already and is not lower is
-- kept; a lower one made by hand is remembered in base_value.
INSERT INTO habit_logs (habit_id, user_id, date, value, task_instance_id, base_value)
SELECT h.id, h.user_id, (ti.planned_start AT TIME ZONE ts.timezone)::date, h.target_value, ti.id, 0
FROM task_instances ti
JOIN task_series ts ON ts.id = ti.series_id AND ts.user_id = ti.user_id
JOIN habits h ON h.id = ts.habit_id AND h.user_id = ts.user_id
WHERE ti.id = @instance_id AND ti.user_id = @user_id AND ti.planned_start IS NOT NULL
ON CONFLICT (habit_id, date) DO UPDATE
SET base_value = CASE WHEN habit_logs.task_instance_id IS NULL THEN habit_logs.value ELSE habit_logs.base_value END,
    value = EXCLUDED.value,
    task_instance_id = EXCLUDED.task_instance_id
WHERE habit_logs.value < EXCLUDED.value;

-- name: RevokeHabitCredit :exec
-- The occurrence is no longer done: what it credited goes (the value that the day had by hand
-- comes back); a value edited by hand afterwards is no longer linked to it and stays.
WITH restored AS (
    UPDATE habit_logs AS r
    SET value = r.base_value, base_value = 0, task_instance_id = NULL
    WHERE r.task_instance_id = @instance_id AND r.user_id = @user_id AND r.base_value > 0
    RETURNING r.habit_id
)
DELETE FROM habit_logs AS d
WHERE d.task_instance_id = @instance_id AND d.user_id = @user_id AND d.base_value = 0;

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
