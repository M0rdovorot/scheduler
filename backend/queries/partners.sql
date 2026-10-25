-- name: CreatePartnerInvite :exec
INSERT INTO partner_invites (inviter_id, token_hash, expires_at)
VALUES ($1, $2, $3);

-- name: LockPartnerInvite :one
-- The invite by token, locked so that two people cannot accept it at once.
SELECT * FROM partner_invites WHERE token_hash = $1 FOR UPDATE;

-- name: AcceptPartnerInvite :exec
UPDATE partner_invites SET accepted_by = $2, accepted_at = $3 WHERE id = $1;

-- name: CreatePartnership :exec
-- One direction; the service creates both in one transaction.
INSERT INTO partnerships (user_id, partner_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: ArePartners :one
SELECT EXISTS (
    SELECT 1 FROM partnerships WHERE user_id = $1 AND partner_id = $2
) AS partners;

-- name: ListPartners :many
-- Partners of the user, with the access the user has given to each.
SELECT p.partner_id AS id, u.display_name, p.created_at,
       EXISTS (SELECT 1 FROM task_access_grants g
               WHERE g.owner_id = p.user_id AND g.grantee_id = p.partner_id) AS tasks_shared,
       EXISTS (SELECT 1 FROM habit_access_grants g
               WHERE g.owner_id = p.user_id AND g.grantee_id = p.partner_id) AS habits_shared
FROM partnerships p
JOIN users u ON u.id = p.partner_id
WHERE p.user_id = $1
ORDER BY u.display_name, p.partner_id;

-- name: DeletePartnership :execrows
-- Both directions; the grants go with them (ON DELETE CASCADE).
DELETE FROM partnerships
WHERE (user_id = @user_id AND partner_id = @partner_id)
   OR (user_id = @partner_id AND partner_id = @user_id);

-- name: GrantTaskAccess :exec
INSERT INTO task_access_grants (owner_id, grantee_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: RevokeTaskAccess :exec
DELETE FROM task_access_grants WHERE owner_id = $1 AND grantee_id = $2;

-- name: GrantHabitAccess :exec
INSERT INTO habit_access_grants (owner_id, grantee_id) VALUES ($1, $2)
ON CONFLICT DO NOTHING;

-- name: RevokeHabitAccess :exec
DELETE FROM habit_access_grants WHERE owner_id = $1 AND grantee_id = $2;

-- name: GetAccessGiven :one
-- What `owner` has given to `grantee`: access to task titles and to habits.
SELECT
    EXISTS (SELECT 1 FROM task_access_grants t
            WHERE t.owner_id = @owner_id AND t.grantee_id = @grantee_id) AS tasks,
    EXISTS (SELECT 1 FROM habit_access_grants h
            WHERE h.owner_id = @owner_id AND h.grantee_id = @grantee_id) AS habits;

-- name: ListBusy :many
-- The time the user spends in [range_from, range_to): the fact of a marked task (a running
-- timer lasts until `now`), the plan of the others. Rescheduled, cancelled and not done tasks
-- take no time. The title is for the service to show or hide.
WITH busy AS (
    SELECT d.title, d.visibility, d.habit_id,
           CAST(COALESCE(d.actual_start, d.planned_start) AS timestamptz) AS starts_at,
           CAST(CASE WHEN d.actual_start IS NOT NULL
                     THEN GREATEST(COALESCE(d.actual_end, @now::timestamptz), d.actual_start)
                     ELSE d.planned_end END AS timestamptz) AS ends_at
    FROM instance_details d
    WHERE d.user_id = @user_id AND d.status NOT IN ('rescheduled', 'cancelled', 'not_done')
)
SELECT title, visibility, habit_id, starts_at, ends_at
FROM busy
WHERE ends_at > starts_at AND starts_at < @range_to::timestamptz AND ends_at > @range_from::timestamptz
ORDER BY starts_at, ends_at;
