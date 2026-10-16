-- +goose Up

-- The value a day had by hand before an occurrence in the grid credited it. Taking the credit
-- back restores it instead of deleting what the user had marked.
ALTER TABLE habit_logs
    ADD COLUMN base_value integer NOT NULL DEFAULT 0
        CONSTRAINT habit_logs_base_check CHECK (base_value >= 0 AND base_value <= 1000000);

-- +goose Down
ALTER TABLE habit_logs DROP COLUMN base_value;
