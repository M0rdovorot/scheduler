package reminder

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
)

// ErrUndeliverable is what a Sender returns when Telegram will not deliver to this chat, ever:
// the user blocked the bot or never started it. Trying again is pointless.
var ErrUndeliverable = errors.New("telegram cannot deliver to this chat")

// Sender delivers a message to a Telegram chat and returns the id of the message.
type Sender interface {
	Send(ctx context.Context, chatID int64, m Message) (messageID int64, err error)
}

const (
	maxAttempts = 5
	batchSize   = 50
	// maxBatches bounds one pass of the sender, so that it cannot spin.
	maxBatches = 20
	// lease is how long a message is reserved for the sender that took it.
	lease = 2 * time.Minute
)

// retryDelays are the pauses after the first, second … failed try.
var retryDelays = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute}

// today is what the habits of a user look like today; it is worked out once per pass.
type today struct {
	items []habit.TodayItem
	day   habit.Day
}

// SendDue sends the queued messages whose time has come.
func (s *Service) SendDue(ctx context.Context) error {
	habits := map[uuid.UUID]today{}
	for range maxBatches {
		now := s.now()
		due, err := s.store.ClaimDueNotifications(ctx, store.ClaimDueNotificationsParams{
			Now: now, LeaseUntil: now.Add(lease), Batch: batchSize,
		})
		if err != nil {
			return fmt.Errorf("claim due notifications: %w", err)
		}
		for _, n := range due {
			if err := s.sendOne(ctx, n, now, habits); err != nil {
				// Not Telegram's fault (the database, a bad time zone): try again later, a few times,
				// like any other failure, so that a broken message cannot be picked up for ever.
				s.log.ErrorContext(ctx, "send notification", "id", n.ID, "err", err)
				s.fail(ctx, n, now, err)
			}
		}
		if len(due) < batchSize {
			return nil
		}
	}
	return nil
}

// skip marks a message as no longer needed.
func (s *Service) skip(ctx context.Context, n store.Notification, now time.Time, reason string) error {
	return s.store.MarkNotificationSkipped(ctx, store.MarkNotificationSkippedParams{ID: n.ID, Now: &now, Reason: reason})
}

func (s *Service) sendOne(ctx context.Context, n store.Notification, now time.Time, habits map[uuid.UUID]today) error {
	u, err := s.store.GetUser(ctx, n.UserID)
	if err != nil {
		return fmt.Errorf("get user: %w", err)
	}
	loc, err := time.LoadLocation(u.Timezone)
	if err != nil {
		return fmt.Errorf("unknown time zone %q: %w", u.Timezone, err)
	}

	var msg Message
	var reason string
	if n.InstanceID.Valid {
		msg, reason, err = s.taskMessage(ctx, n, now, loc)
	} else {
		msg, reason, err = s.habitMessage(ctx, n, habits)
	}
	if err != nil {
		return err
	}
	if reason != "" {
		return s.skip(ctx, n, now, reason)
	}

	chatID, err := s.chatID(ctx, n.UserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return s.giveUp(ctx, n, now, "the user has no Telegram account")
	}
	if err != nil {
		return err
	}

	messageID, err := s.sender.Send(ctx, chatID, msg)
	switch {
	case err == nil:
		return s.store.MarkNotificationSent(ctx, store.MarkNotificationSentParams{ID: n.ID, Now: &now, TelegramMessageID: &messageID})
	case errors.Is(err, ErrUndeliverable):
		return s.giveUp(ctx, n, now, err.Error())
	}
	s.fail(ctx, n, now, err)
	return nil
}

// fail records a failed try: the next one comes after a pause, or the message is given up
// after maxAttempts. The pause does not end in quiet hours.
func (s *Service) fail(ctx context.Context, n store.Notification, now time.Time, cause error) {
	var retryAt *time.Time
	if int(n.Attempts)+1 < maxAttempts {
		at := now.Add(retryDelays[min(int(n.Attempts), len(retryDelays)-1)])
		if u, err := s.store.GetUser(ctx, n.UserID); err == nil {
			if loc, err := time.LoadLocation(u.Timezone); err == nil {
				if g, err := s.store.GetGlobalReminderSettings(ctx, n.UserID); err == nil && g.QuietStart != nil && g.QuietEnd != nil {
					at = (&Quiet{Start: int(*g.QuietStart), End: int(*g.QuietEnd)}).Shift(at, loc)
				}
			}
		}
		retryAt = &at
	}
	err := s.store.MarkNotificationFailed(ctx, store.MarkNotificationFailedParams{
		ID: n.ID, LastError: cause.Error(), RetryAt: retryAt, Now: now,
	})
	if err != nil {
		s.log.ErrorContext(ctx, "mark notification failed", "id", n.ID, "err", err)
	}
}

func (s *Service) giveUp(ctx context.Context, n store.Notification, now time.Time, reason string) error {
	return s.store.MarkNotificationFailed(ctx, store.MarkNotificationFailedParams{ID: n.ID, LastError: reason, Now: now})
}

func (s *Service) chatID(ctx context.Context, userID uuid.UUID) (int64, error) {
	id, err := s.store.ListUserTelegramID(ctx, userID)
	if err != nil {
		return 0, err
	}
	chat, err := strconv.ParseInt(id, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("telegram id %q: %w", id, err)
	}
	return chat, nil
}

// taskMessage builds the message of a task reminder; a non-empty reason means it is not needed.
func (s *Service) taskMessage(ctx context.Context, n store.Notification, now time.Time, loc *time.Location) (Message, string, error) {
	in, err := s.tasks.Get(ctx, n.UserID, n.InstanceID.UUID)
	if errors.Is(err, task.ErrNotFound) {
		return Message{}, "the task is gone", nil
	}
	if err != nil {
		return Message{}, "", err
	}
	if in.PlannedStart == nil || in.PlannedEnd == nil {
		return Message{}, "the task has no plan", nil
	}
	// The message was made for a plan; a task that was moved since gets reminders of its own.
	if n.PlanStart != nil && n.PlanEnd != nil && (!in.PlannedStart.Equal(*n.PlanStart) || !in.PlannedEnd.Equal(*n.PlanEnd)) {
		return Message{}, "the plan changed", nil
	}
	if !Needed(Kind(n.Kind), in.Status, *in.PlannedEnd, now) {
		return Message{}, "not needed any more", nil
	}
	return TaskMessage(Kind(n.Kind), in.ID, in.Title, *in.PlannedStart, *in.PlannedEnd, now, loc), "", nil
}

// habitMessage builds the message of a habit reminder; a non-empty reason means it is not needed.
func (s *Service) habitMessage(ctx context.Context, n store.Notification, cache map[uuid.UUID]today) (Message, string, error) {
	t, ok := cache[n.UserID]
	if !ok {
		items, day, err := s.habits.Today(ctx, n.UserID)
		if err != nil {
			return Message{}, "", err
		}
		t = today{items, day}
		cache[n.UserID] = t
	}
	// A reminder is for a day; one that was held back past midnight by quiet hours is over.
	if n.ForDate != nil && !habit.DayOf(n.ForDate.Year(), n.ForDate.Month(), n.ForDate.Day()).Equal(t.day) {
		return Message{}, "the day is over", nil
	}
	for _, it := range t.items {
		if it.Habit.ID != n.HabitID.UUID {
			continue
		}
		h := it.Habit
		// Planned today and not done yet; a weekly goal also stops once it is reached.
		if it.Done || (h.Schedule.Weekly() && it.WeekDone >= h.Schedule.TimesPerWeek) {
			return Message{}, "not needed any more", nil
		}
		progress := ""
		if h.Kind == habit.Quantity {
			progress = fmt.Sprintf("%d из %d", it.Value, h.Target)
			if h.Unit != "" {
				progress += " " + h.Unit
			}
		}
		return HabitMessage(h.ID, h.Title, h.Kind == habit.Boolean, progress), "", nil
	}
	return Message{}, "not planned today", nil
}

// CallbackResult is what the bot shows after a button was pressed.
type CallbackResult struct {
	// Answer is a short pop-up for the user.
	Answer string
	// Note is added to the message in place of its buttons; empty leaves the message as it is.
	Note string
}

// HandleCallback runs the action behind a button of a message, for the Telegram user who
// pressed it. A button that no longer fits the state of the task changes nothing.
func (s *Service) HandleCallback(ctx context.Context, telegramID int64, data string) (CallbackResult, error) {
	action, id, ok := ParseCallback(data)
	if !ok {
		return CallbackResult{Answer: "Неизвестное действие"}, nil
	}
	userID, err := s.store.GetUserByTelegramID(ctx, strconv.FormatInt(telegramID, 10))
	if errors.Is(err, pgx.ErrNoRows) {
		return CallbackResult{Answer: "Сначала откройте приложение"}, nil
	}
	if err != nil {
		return CallbackResult{}, fmt.Errorf("find user: %w", err)
	}

	if action == ActionHabit {
		return s.habitButton(ctx, userID, id)
	}
	return s.taskButton(ctx, userID, action, id)
}

func (s *Service) habitButton(ctx context.Context, userID, id uuid.UUID) (CallbackResult, error) {
	err := s.habits.MarkToday(ctx, userID, id)
	if errors.Is(err, habit.ErrNotFound) {
		return CallbackResult{Answer: "Привычка не найдена", Note: "Привычка удалена"}, nil
	}
	if err != nil {
		return CallbackResult{}, fmt.Errorf("mark habit: %w", err)
	}
	return CallbackResult{Answer: "Отмечено", Note: "✓ Выполнено"}, nil
}

// allowed lists the states a task may be in for a button to apply.
var allowed = map[string][]string{
	ActionDone:    {"planned", "not_done"},
	ActionNotDone: {"planned"},
	ActionStart:   {"planned", "not_done"},
	ActionStop:    {"in_progress"},
}

var statusText = map[string]string{
	"planned": "запланировано", "in_progress": "идёт", "done": "выполнено", "partial": "выполнено частично",
	"not_done": "не выполнено", "rescheduled": "перенесено", "cancelled": "удалено",
}

func (s *Service) taskButton(ctx context.Context, userID uuid.UUID, action string, id uuid.UUID) (CallbackResult, error) {
	in, err := s.tasks.Get(ctx, userID, id)
	if errors.Is(err, task.ErrNotFound) {
		return CallbackResult{Answer: "Дело не найдено", Note: "Дело удалено"}, nil
	}
	if err != nil {
		return CallbackResult{}, fmt.Errorf("get task: %w", err)
	}
	fits := false
	for _, st := range allowed[action] {
		fits = fits || st == in.Status
	}
	if !fits {
		text := "Уже изменено: " + statusText[in.Status]
		return CallbackResult{Answer: text, Note: text}, nil
	}

	switch action {
	case ActionDone:
		_, err = s.tasks.Complete(ctx, userID, id)
	case ActionNotDone:
		notDone := task.StatusNotDone
		_, err = s.tasks.EditTracking(ctx, userID, id, task.TrackingInput{Status: &notDone})
	case ActionStart:
		_, err = s.tasks.Start(ctx, userID, id)
	case ActionStop:
		_, err = s.tasks.Stop(ctx, userID, id)
	}
	if err != nil {
		return CallbackResult{}, fmt.Errorf("%s: %w", action, err)
	}
	note := map[string]string{
		ActionDone: "✓ Выполнено", ActionNotDone: "✗ Не выполнено", ActionStart: "▶ Таймер запущен", ActionStop: "■ Таймер остановлен",
	}[action]
	return CallbackResult{Answer: note, Note: note}, nil
}

// Run queues and sends reminders until the context ends: the planner once a minute, the sender
// every few seconds.
func (s *Service) Run(ctx context.Context) {
	plan := time.NewTicker(time.Minute)
	send := time.NewTicker(10 * time.Second)
	defer plan.Stop()
	defer send.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-plan.C:
			if err := s.PlanAll(ctx); err != nil && ctx.Err() == nil {
				s.log.ErrorContext(ctx, "plan reminders", "err", err)
			}
		case <-send.C:
			if err := s.SendDue(ctx); err != nil && ctx.Err() == nil {
				s.log.ErrorContext(ctx, "send reminders", "err", err)
			}
		}
	}
}
