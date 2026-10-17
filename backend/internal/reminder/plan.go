package reminder

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
)

const (
	// lateness is how long after its time a reminder is still sent (the server was down).
	lateness = 30 * time.Minute
	// lookahead is how far ahead the planner queues reminders.
	lookahead = 5 * time.Minute
)

// PlanAll queues the reminders that are due for every user whose master switch is on.
func (s *Service) PlanAll(ctx context.Context) error {
	users, err := s.store.ListRemindableUsers(ctx)
	if err != nil {
		return fmt.Errorf("list users: %w", err)
	}
	for _, u := range users {
		if err := s.planUser(ctx, u.ID, u.Timezone); err != nil {
			// One user's trouble must not stop the others.
			s.log.ErrorContext(ctx, "plan reminders", "user", u.ID, "err", err)
		}
	}
	return nil
}

func (s *Service) planUser(ctx context.Context, userID uuid.UUID, timezone string) error {
	loc, err := time.LoadLocation(timezone)
	if err != nil {
		return fmt.Errorf("unknown time zone %q: %w", timezone, err)
	}
	snap, err := load(ctx, s.store.Queries, userID)
	if err != nil {
		return err
	}
	now := s.now()
	from, to := now.Add(-lateness), now.Add(lookahead)

	if err := s.planTasks(ctx, userID, snap, loc, now, from, to); err != nil {
		return err
	}
	return s.planHabits(ctx, userID, snap, loc, from, to)
}

func (s *Service) planTasks(ctx context.Context, userID uuid.UUID, snap *snapshot, loc *time.Location, now, from, to time.Time) error {
	// A rule fires a fixed time from the start or the end, so the tasks to look at are those
	// whose plan reaches into the window widened by the largest such offset.
	winFrom, winTo := from.Add(-snap.maxAfter), to.Add(snap.maxBefore)
	if err := s.tasks.Materialize(ctx, userID, winFrom, winTo); err != nil {
		return fmt.Errorf("materialize: %w", err)
	}
	rows, err := s.store.ListInstancesForReminders(ctx, store.ListInstancesForRemindersParams{
		UserID: userID, FromTime: &winFrom, ToTime: &winTo,
	})
	if err != nil {
		return fmt.Errorf("list instances: %w", err)
	}
	for _, in := range rows {
		if in.PlannedStart == nil || in.PlannedEnd == nil {
			continue
		}
		var series *uuid.UUID
		if in.SeriesID.Valid {
			series = &in.SeriesID.UUID
		}
		for _, rule := range Resolve(snap.levelsFor(in.ID, series, in.CategoryIds)) {
			fire := rule.FireAt(*in.PlannedStart, *in.PlannedEnd)
			if fire.Before(from) || fire.After(to) || !Needed(rule.Kind, in.Status, *in.PlannedEnd, now) {
				continue
			}
			// Moving the task gives it new reminders: the start is part of the key.
			key := fmt.Sprintf("inst:%s:%s:%d:%d", in.ID, rule.Kind, rule.OffsetMinutes, in.PlannedStart.Unix())
			err := s.store.InsertNotification(ctx, store.InsertNotificationParams{
				UserID: userID, InstanceID: uuid.NullUUID{UUID: in.ID, Valid: true},
				Kind: string(rule.Kind), DedupeKey: key, SendAt: snap.quiet.Shift(fire, loc),
			})
			if err != nil {
				return fmt.Errorf("queue notification: %w", err)
			}
		}
	}
	return nil
}

func (s *Service) planHabits(ctx context.Context, userID uuid.UUID, snap *snapshot, loc *time.Location, from, to time.Time) error {
	if len(snap.habit) == 0 {
		return nil
	}
	habits, err := s.habits.List(ctx, userID)
	if err != nil {
		return fmt.Errorf("list habits: %w", err)
	}
	// The window can reach over midnight.
	days := []habit.Day{habit.LocalDay(from, loc)}
	if last := habit.LocalDay(to, loc); !last.Equal(days[0]) {
		days = append(days, last)
	}
	for _, h := range habits {
		set := snap.habit[h.ID]
		// A habit in the grid reminds like an ordinary task, through its occurrences.
		if h.ArchivedAt != nil || h.Placement != nil || set == nil {
			continue
		}
		for _, rule := range normalize(set.rules()) {
			for _, day := range days {
				if !h.Schedule.Weekly() && !h.Schedule.Planned(day) {
					continue
				}
				fire := HabitFireAt(day.Year(), day.Month(), day.Day(), rule.TimeOfDay, loc)
				if fire.Before(from) || fire.After(to) {
					continue
				}
				key := fmt.Sprintf("habit:%s:%s:%d", h.ID, day.Format(time.DateOnly), rule.TimeOfDay)
				err := s.store.InsertNotification(ctx, store.InsertNotificationParams{
					UserID: userID, HabitID: uuid.NullUUID{UUID: h.ID, Valid: true},
					Kind: string(HabitTime), DedupeKey: key, SendAt: snap.quiet.Shift(fire, loc),
				})
				if err != nil {
					return fmt.Errorf("queue habit notification: %w", err)
				}
			}
		}
	}
	return nil
}
