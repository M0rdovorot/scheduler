package task

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/recurrence"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/internal/visibility"
)

// ErrNoHabitSeries means the habit is not placed in the grid.
var ErrNoHabitSeries = errors.New("the habit is not placed in the grid")

// HabitSeries is the placement of a habit in the grid: a regular task that points at
// the habit. The functions that follow take the transaction of the caller, so that a
// habit and its series change together.
type HabitSeries struct {
	HabitID uuid.UUID
	Title   string
	// Rule is an RRULE without DTSTART: every day, or some weekdays.
	Rule string
	// From is the first local date that the series may have an occurrence on.
	From         time.Time
	Hour, Minute int
	// DurationMinutes is the length of every occurrence.
	DurationMinutes int
}

// CreateHabitSeries places a habit in the grid.
func CreateHabitSeries(ctx context.Context, q *store.Queries, userID uuid.UUID, in HabitSeries) error {
	rule, err := parseRecurrence(in.Rule)
	if err != nil {
		return err
	}
	if in.DurationMinutes <= 0 {
		return &validation.Error{Field: "duration_minutes", Message: "must be positive"}
	}
	if err := q.LockSeriesChanges(ctx, userID.String()); err != nil {
		return fmt.Errorf("lock series: %w", err)
	}
	user, err := q.GetUser(ctx, userID)
	if err != nil {
		return fmt.Errorf("get user: %w", err)
	}
	loc, err := time.LoadLocation(user.Timezone)
	if err != nil {
		return fmt.Errorf("user %s has an unknown time zone %q: %w", userID, user.Timezone, err)
	}
	start := time.Date(in.From.Year(), in.From.Month(), in.From.Day(), in.Hour, in.Minute, 0, 0, time.UTC)
	if _, ok, err := recurrence.First(rule, start, loc); err != nil {
		return err
	} else if !ok {
		return noOccurrences()
	}
	private := visibility.Private
	_, err = q.CreateSeries(ctx, store.CreateSeriesParams{
		UserID: userID, Title: in.Title, Rrule: rule.String(), DtstartLocal: start,
		Timezone: user.Timezone, DurationMinutes: int32(in.DurationMinutes),
		HabitID: uuid.NullUUID{UUID: in.HabitID, Valid: true},
		// Partners see a habit by the access to habits, not by this value. It stays closed so
		// that the occurrences that outlive a deleted habit do not become visible to everyone.
		Visibility: &private,
	})
	if err != nil {
		return fmt.Errorf("create habit series: %w", err)
	}
	return nil
}

// HabitSeriesPatch holds what to change in the placement; nil fields are left as is.
type HabitSeriesPatch struct {
	Title *string
	Rule  *string
	// Time of day, both or none.
	Hour, Minute    *int
	DurationMinutes *int
}

// UpdateHabitSeries changes the placement of a habit the way an edit of a whole
// series does: the planned occurrences are made again from the new template, while
// the marked, edited and deleted ones stay.
func UpdateHabitSeries(ctx context.Context, q *store.Queries, userID, habitID uuid.UUID, p HabitSeriesPatch) error {
	if err := q.LockSeriesChanges(ctx, userID.String()); err != nil {
		return fmt.Errorf("lock series: %w", err)
	}
	rows, err := q.ListHabitSeries(ctx, store.ListHabitSeriesParams{HabitID: uuid.NullUUID{UUID: habitID, Valid: true}, UserID: userID})
	if err != nil {
		return fmt.Errorf("list habit series: %w", err)
	}
	if len(rows) == 0 {
		return ErrNoHabitSeries
	}
	row := rows[0]
	rule, loc, err := loadRule(row)
	if err != nil {
		return err
	}
	if p.Rule != nil {
		if rule, err = parseRecurrence(*p.Rule); err != nil {
			return err
		}
	}
	title := row.Title
	if p.Title != nil {
		title = *p.Title
	}

	tc := &timeChange{durationMinutes: int(row.DurationMinutes)}
	if p.DurationMinutes != nil {
		if *p.DurationMinutes <= 0 {
			return &validation.Error{Field: "duration_minutes", Message: "must be positive"}
		}
		tc.durationMinutes = *p.DurationMinutes
	}
	if p.Hour != nil && p.Minute != nil {
		tc.setTime, tc.hour, tc.minute = true, *p.Hour, *p.Minute
	}
	start := withTime(row.DtstartLocal, row.DtstartLocal, tc)
	if _, ok, err := recurrence.First(rule, start, loc); err != nil {
		return err
	} else if !ok {
		return noOccurrences()
	}
	err = q.UpdateSeries(ctx, store.UpdateSeriesParams{
		ID: row.ID, UserID: userID, Title: title, Description: row.Description,
		Rrule: rule.String(), DtstartLocal: start, DurationMinutes: int32(tc.durationMinutes),
	})
	if err != nil {
		return fmt.Errorf("update habit series: %w", err)
	}
	if err := deleteRewritable(ctx, q, userID, row.ID, false, false, nil); err != nil {
		return err
	}
	if tc.setTime {
		return rekeySurvivors(ctx, q, userID, row.ID, loc, tc)
	}
	return nil
}

// DeleteHabitSeries takes a habit out of the grid. Planned occurrences go; the marked
// ones are history and stay, without the link to the series.
func DeleteHabitSeries(ctx context.Context, q *store.Queries, userID, habitID uuid.UUID) error {
	if err := q.LockSeriesChanges(ctx, userID.String()); err != nil {
		return fmt.Errorf("lock series: %w", err)
	}
	rows, err := q.ListHabitSeries(ctx, store.ListHabitSeriesParams{HabitID: uuid.NullUUID{UUID: habitID, Valid: true}, UserID: userID})
	if err != nil {
		return fmt.Errorf("list habit series: %w", err)
	}
	for _, row := range rows {
		if err := deleteRewritable(ctx, q, userID, row.ID, true, true, nil); err != nil {
			return err
		}
		if err := q.DeleteSeries(ctx, store.DeleteSeriesParams{ID: row.ID, UserID: userID}); err != nil {
			return fmt.Errorf("delete habit series: %w", err)
		}
	}
	return nil
}
