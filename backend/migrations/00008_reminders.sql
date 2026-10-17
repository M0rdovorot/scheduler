-- +goose Up

-- "This level has its own reminder settings". A level without a row inherits from a more
-- general one. The target of a level is a foreign key of its own, so deleting a category, a
-- series, a task or a habit deletes its settings.
CREATE TABLE reminder_settings (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id        uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    scope          text        NOT NULL
        CONSTRAINT reminder_settings_scope_check CHECK (scope IN ('global', 'category', 'series', 'instance', 'habit')),
    category_id    uuid,
    series_id      uuid,
    instance_id    uuid,
    habit_id       uuid,
    -- false: no reminders on this level; on the global row it is the master switch.
    enabled        boolean     NOT NULL DEFAULT true,
    -- Quiet hours, minutes from local midnight; only on the global row. The interval may wrap midnight.
    quiet_start    smallint
        CONSTRAINT reminder_settings_quiet_start_check CHECK (quiet_start BETWEEN 0 AND 1439),
    quiet_end      smallint
        CONSTRAINT reminder_settings_quiet_end_check CHECK (quiet_end BETWEEN 0 AND 1439),
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT reminder_settings_id_key UNIQUE (id),
    CONSTRAINT reminder_settings_target_check CHECK (
        (scope = 'global'   AND category_id IS NULL AND series_id IS NULL AND instance_id IS NULL AND habit_id IS NULL) OR
        (scope = 'category' AND category_id IS NOT NULL AND series_id IS NULL AND instance_id IS NULL AND habit_id IS NULL) OR
        (scope = 'series'   AND series_id IS NOT NULL AND category_id IS NULL AND instance_id IS NULL AND habit_id IS NULL) OR
        (scope = 'instance' AND instance_id IS NOT NULL AND category_id IS NULL AND series_id IS NULL AND habit_id IS NULL) OR
        (scope = 'habit'    AND habit_id IS NOT NULL AND category_id IS NULL AND series_id IS NULL AND instance_id IS NULL)),
    CONSTRAINT reminder_settings_quiet_check CHECK (
        (quiet_start IS NULL) = (quiet_end IS NULL) AND (scope = 'global' OR quiet_start IS NULL)),
    CONSTRAINT reminder_settings_category_fkey FOREIGN KEY (category_id, user_id)
        REFERENCES categories (id, user_id) ON DELETE CASCADE,
    CONSTRAINT reminder_settings_series_fkey FOREIGN KEY (series_id, user_id)
        REFERENCES task_series (id, user_id) ON DELETE CASCADE,
    CONSTRAINT reminder_settings_instance_fkey FOREIGN KEY (instance_id, user_id)
        REFERENCES task_instances (id, user_id) ON DELETE CASCADE,
    CONSTRAINT reminder_settings_habit_fkey FOREIGN KEY (habit_id, user_id)
        REFERENCES habits (id, user_id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX reminder_settings_global_key ON reminder_settings (user_id) WHERE scope = 'global';
CREATE UNIQUE INDEX reminder_settings_category_key ON reminder_settings (category_id) WHERE scope = 'category';
CREATE UNIQUE INDEX reminder_settings_series_key ON reminder_settings (series_id) WHERE scope = 'series';
CREATE UNIQUE INDEX reminder_settings_instance_key ON reminder_settings (instance_id) WHERE scope = 'instance';
CREATE UNIQUE INDEX reminder_settings_habit_key ON reminder_settings (habit_id) WHERE scope = 'habit';

CREATE TABLE reminder_rules (
    id             uuid PRIMARY KEY DEFAULT uuidv7(),
    setting_id     uuid        NOT NULL REFERENCES reminder_settings (id) ON DELETE CASCADE,
    kind           text        NOT NULL
        CONSTRAINT reminder_rules_kind_check CHECK (kind IN ('before_start', 'after_end', 'not_started', 'overrun', 'habit_time')),
    -- Minutes before the start (before_start) or after the start or the end (the others).
    offset_minutes integer
        CONSTRAINT reminder_rules_offset_check CHECK (offset_minutes BETWEEN 0 AND 10080),
    -- Local time of day for habit_time, minutes from midnight.
    time_of_day    smallint
        CONSTRAINT reminder_rules_time_check CHECK (time_of_day BETWEEN 0 AND 1439),
    CONSTRAINT reminder_rules_shape_check CHECK (
        (kind = 'habit_time' AND time_of_day IS NOT NULL AND offset_minutes IS NULL) OR
        (kind <> 'habit_time' AND offset_minutes IS NOT NULL AND time_of_day IS NULL)),
    CONSTRAINT reminder_rules_unique UNIQUE NULLS NOT DISTINCT (setting_id, kind, offset_minutes, time_of_day)
);

CREATE INDEX reminder_rules_setting_id_idx ON reminder_rules (setting_id);

-- The outbox: a message that is to be sent, and what came of sending it.
CREATE TABLE notifications (
    id                  uuid PRIMARY KEY DEFAULT uuidv7(),
    user_id             uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    instance_id         uuid,
    habit_id            uuid,
    kind                text        NOT NULL
        CONSTRAINT notifications_kind_check CHECK (kind IN ('before_start', 'after_end', 'not_started', 'overrun', 'habit_time')),
    -- One message per rule and occurrence (or habit and day): the planner may ask for it again and again.
    dedupe_key          text        NOT NULL UNIQUE,
    send_at             timestamptz NOT NULL,
    sent_at             timestamptz,
    -- The sender stopped trying (too many failures, or Telegram will never deliver).
    gave_up_at          timestamptz,
    attempts            integer     NOT NULL DEFAULT 0,
    last_error          text        NOT NULL DEFAULT '',
    telegram_message_id bigint,
    created_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT notifications_target_check CHECK ((instance_id IS NULL) <> (habit_id IS NULL)),
    CONSTRAINT notifications_instance_fkey FOREIGN KEY (instance_id, user_id)
        REFERENCES task_instances (id, user_id) ON DELETE CASCADE,
    CONSTRAINT notifications_habit_fkey FOREIGN KEY (habit_id, user_id)
        REFERENCES habits (id, user_id) ON DELETE CASCADE
);

CREATE INDEX notifications_due_idx ON notifications (send_at) WHERE sent_at IS NULL AND gave_up_at IS NULL;
CREATE INDEX notifications_user_idx ON notifications (user_id);

-- Every user has the global row, with the default reminders (assumption 3): 10 minutes
-- before the start, and a request to mark the task right after its end.
-- +goose StatementBegin
CREATE FUNCTION create_default_reminders(uid uuid) RETURNS void
LANGUAGE sql AS $$
    WITH s AS (
        INSERT INTO reminder_settings (user_id, scope) VALUES (uid, 'global')
        ON CONFLICT DO NOTHING
        RETURNING id
    )
    INSERT INTO reminder_rules (setting_id, kind, offset_minutes)
    SELECT s.id, r.kind, r.offset_minutes
    FROM s CROSS JOIN (VALUES ('before_start', 10), ('after_end', 0)) AS r (kind, offset_minutes)
$$;
-- +goose StatementEnd

-- +goose StatementBegin
CREATE FUNCTION users_default_reminders() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM create_default_reminders(NEW.id);
    RETURN NEW;
END
$$;
-- +goose StatementEnd

CREATE TRIGGER users_default_reminders AFTER INSERT ON users
    FOR EACH ROW EXECUTE FUNCTION users_default_reminders();

SELECT create_default_reminders(id) FROM users;

-- +goose Down
DROP TRIGGER users_default_reminders ON users;
DROP FUNCTION users_default_reminders();
DROP FUNCTION create_default_reminders(uuid);
DROP TABLE notifications;
DROP TABLE reminder_rules;
DROP TABLE reminder_settings;
