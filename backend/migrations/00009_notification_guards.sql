-- +goose Up

-- What a queued message was made for, so that the sender can tell that it went stale:
-- the plan it was computed from, the day (for a habit), and a lease while a sender works on it.
ALTER TABLE notifications
    ADD COLUMN plan_start    timestamptz,
    ADD COLUMN plan_end      timestamptz,
    ADD COLUMN for_date      date,
    ADD COLUMN claimed_until timestamptz;

-- +goose Down
ALTER TABLE notifications
    DROP COLUMN claimed_until,
    DROP COLUMN for_date,
    DROP COLUMN plan_end,
    DROP COLUMN plan_start;
