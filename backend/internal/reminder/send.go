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
)

// retryDelays are the pauses after the first, second … failed try.
var retryDelays = []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute}

// SendDue sends the queued messages whose time has come.
func (s *Service) SendDue(ctx context.Context) error {
	for {
		now := s.now()
		due, err := s.store.ClaimDueNotifications(ctx, store.ClaimDueNotificationsParams{Now: now, Batch: batchSize})
		if err != nil {
			return fmt.Errorf("claim due notifications: %w", err)
		}
		for _, n := range due {
			if err := s.sendOne(ctx, n, now); err != nil {
				s.log.ErrorContext(ctx, "send notification", "id", n.ID, "err", err)
			}
		}
		if len(due) < batchSize {
			return nil
		}
	}
}

// skip marks a message as no longer needed.
func (s *Service) skip(ctx context.Context, n store.Notification, now time.Time, reason string) error {
	return s.store.MarkNotificationSkipped(ctx, store.MarkNotificationSkippedParams{ID: n.ID, Now: &now, Reason: reason})
}

func (s *Service) sendOne(ctx context.Context, n store.Notification, now time.Time) error {
	u, err := s.store.GetUser(ctx, n.UserID)
	if err != nil {
		return fmt.Errorf("get user: %w", err)
	}
	loc, err := time.LoadLocation(u.Timezone)
	if err != nil {
		return fmt.Errorf("unknown time zone %q: %w", u.Timezone, err)
	}

	var msg Message
	var ok bool
	if n.InstanceID.Valid {
		msg, ok, err = s.taskMessage(ctx, n, now, loc)
	} else {
		msg, ok, err = s.habitMessage(ctx, n)
	}
	if err != nil {
		return err
	}
	if !ok {
		return s.skip(ctx, n, now, "not needed any more")
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

	// Another failure: try again later, a few times.
	var retryAt *time.Time
	if int(n.Attempts)+1 < maxAttempts {
		delay := retryDelays[min(int(n.Attempts), len(retryDelays)-1)]
		g, qerr := s.store.GetGlobalReminderSettings(ctx, n.UserID)
		var quiet *Quiet
		if qerr == nil && g.QuietStart != nil && g.QuietEnd != nil {
			quiet = &Quiet{Start: int(*g.QuietStart), End: int(*g.QuietEnd)}
		}
		at := quiet.Shift(now.Add(delay), loc)
		retryAt = &at
	}
	if mErr := s.store.MarkNotificationFailed(ctx, store.MarkNotificationFailedParams{
		ID: n.ID, LastError: err.Error(), RetryAt: retryAt, Now: now,
	}); mErr != nil {
		return fmt.Errorf("mark failed: %w", mErr)
	}
	return fmt.Errorf("send: %w", err)
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

func (s *Service) taskMessage(ctx context.Context, n store.Notification, now time.Time, loc *time.Location) (Message, bool, error) {
	in, err := s.tasks.Get(ctx, n.UserID, n.InstanceID.UUID)
	if errors.Is(err, task.ErrNotFound) {
		return Message{}, false, nil
	}
	if err != nil {
		return Message{}, false, err
	}
	if in.PlannedStart == nil || in.PlannedEnd == nil || !Needed(Kind(n.Kind), in.Status, *in.PlannedEnd, now) {
		return Message{}, false, nil
	}
	return TaskMessage(Kind(n.Kind), in.ID, in.Title, *in.PlannedStart, *in.PlannedEnd, now, loc), true, nil
}

func (s *Service) habitMessage(ctx context.Context, n store.Notification) (Message, bool, error) {
	items, _, err := s.habits.Today(ctx, n.UserID)
	if err != nil {
		return Message{}, false, err
	}
	for _, it := range items {
		if it.Habit.ID != n.HabitID.UUID {
			continue
		}
		h := it.Habit
		// Planned today and not done yet; a weekly goal also stops once it is reached.
		if it.Done || (h.Schedule.Weekly() && it.WeekDone >= h.Schedule.TimesPerWeek) {
			return Message{}, false, nil
		}
		progress := ""
		if h.Kind == habit.Quantity {
			progress = fmt.Sprintf("%d из %d", it.Value, h.Target)
			if h.Unit != "" {
				progress += " " + h.Unit
			}
		}
		return HabitMessage(h.ID, h.Title, h.Kind == habit.Boolean, progress), true, nil
	}
	return Message{}, false, nil
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
