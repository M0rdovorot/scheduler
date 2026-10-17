package task

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/recurrence"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

// Series is a regular task: the template that its occurrences are made from.
type Series struct {
	ID          uuid.UUID
	Title       string
	Description string
	// RRule is the repeat rule without DTSTART.
	RRule string
	// StartLocal is the wall-clock time of the first occurrence slot,
	// "2006-01-02T15:04", read in Timezone.
	StartLocal      string
	Timezone        string
	DurationMinutes int
	CategoryIDs     []uuid.UUID
}

const startLocalLayout = "2006-01-02T15:04"

func (s *Service) GetSeries(ctx context.Context, userID, id uuid.UUID) (Series, error) {
	row, err := s.store.GetSeries(ctx, store.GetSeriesParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Series{}, ErrSeriesNotFound
	}
	if err != nil {
		return Series{}, fmt.Errorf("get series: %w", err)
	}
	cats, err := s.store.ListSeriesCategoryIDs(ctx, store.ListSeriesCategoryIDsParams{SeriesID: id, UserID: userID})
	if err != nil {
		return Series{}, fmt.Errorf("list series categories: %w", err)
	}
	if cats == nil {
		cats = []uuid.UUID{}
	}
	return Series{
		ID: row.ID, Title: row.Title, Description: row.Description, RRule: row.Rrule,
		StartLocal: row.DtstartLocal.Format(startLocalLayout), Timezone: row.Timezone,
		DurationMinutes: int(row.DurationMinutes), CategoryIDs: cats,
	}, nil
}

// Materialize creates the occurrences of the user's series that fall into
// [from, to) and do not exist yet. It is idempotent: occurrences that exist,
// also cancelled ones, are left alone. Stats and reminders call it for their
// periods too.
func (s *Service) Materialize(ctx context.Context, userID uuid.UUID, from, to time.Time) error {
	// Most users have no series; do not open a transaction for them.
	list, err := s.store.ListSeries(ctx, userID)
	if err != nil {
		return fmt.Errorf("list series: %w", err)
	}
	if len(list) == 0 {
		return nil
	}
	return s.store.InTx(ctx, func(q *store.Queries) error {
		// A shared lock: windows are materialised in parallel, but never while an
		// edit of a series (which takes the exclusive lock) is running.
		if err := q.LockSeriesChangesShared(ctx, userID.String()); err != nil {
			return fmt.Errorf("lock series: %w", err)
		}
		// Read again under the lock: an edit may have changed the rules meanwhile.
		list, err := q.ListSeries(ctx, userID)
		if err != nil {
			return fmt.Errorf("list series: %w", err)
		}
		for _, row := range list {
			if _, err := materializeSeries(ctx, q, userID, row, from, to); err != nil {
				return err
			}
		}
		return nil
	})
}

// materializeSeries creates the missing occurrences of one series in [from, to)
// and returns the ids of the new ones.
func materializeSeries(ctx context.Context, q *store.Queries, userID uuid.UUID, row store.TaskSeries, from, to time.Time) ([]uuid.UUID, error) {
	rule, loc, err := loadRule(row)
	if err != nil {
		return nil, err
	}
	duration := time.Duration(row.DurationMinutes) * time.Minute
	// An occurrence overlaps the window if it starts after from - duration.
	starts, err := recurrence.Occurrences(rule, row.DtstartLocal, loc, from.Add(-duration), to)
	if err != nil {
		return nil, fmt.Errorf("expand series %s: %w", row.ID, err)
	}
	return insertOccurrences(ctx, q, userID, row, starts)
}

func insertOccurrences(ctx context.Context, q *store.Queries, userID uuid.UUID, row store.TaskSeries, starts []time.Time) ([]uuid.UUID, error) {
	if len(starts) == 0 {
		return nil, nil
	}
	duration := time.Duration(row.DurationMinutes) * time.Minute
	params := make([]store.MaterializeInstanceParams, len(starts))
	for i, start := range starts {
		end := start.Add(duration)
		params[i] = store.MaterializeInstanceParams{
			UserID: userID, SeriesID: uuid.NullUUID{UUID: row.ID, Valid: true}, OriginalStart: &start,
			Title: row.Title, Description: row.Description, PlannedEnd: &end,
		}
	}

	var created []uuid.UUID
	var firstErr error
	results := q.MaterializeInstance(ctx, params)
	results.QueryRow(func(_ int, id uuid.UUID, err error) {
		switch {
		case errors.Is(err, pgx.ErrNoRows): // exists already
		case err != nil:
			if firstErr == nil {
				firstErr = err
			}
		default:
			created = append(created, id)
		}
	})
	if err := results.Close(); err != nil && firstErr == nil {
		firstErr = err
	}
	if firstErr != nil {
		return nil, fmt.Errorf("insert occurrences: %w", firstErr)
	}

	if len(created) > 0 {
		err := q.CopySeriesCategoriesToInstances(ctx, store.CopySeriesCategoriesToInstancesParams{
			InstanceIds: created, SeriesID: row.ID, UserID: userID,
		})
		if err != nil {
			return nil, fmt.Errorf("copy series categories: %w", err)
		}
	}
	return created, nil
}

func loadRule(row store.TaskSeries) (recurrence.Rule, *time.Location, error) {
	rule, err := recurrence.Parse(row.Rrule)
	if err != nil {
		return recurrence.Rule{}, nil, fmt.Errorf("series %s has an invalid rule %q: %w", row.ID, row.Rrule, err)
	}
	loc, err := time.LoadLocation(row.Timezone)
	if err != nil {
		return recurrence.Rule{}, nil, fmt.Errorf("series %s has an unknown time zone %q: %w", row.ID, row.Timezone, err)
	}
	return rule, loc, nil
}

func parseRecurrence(text string) (recurrence.Rule, error) {
	rule, err := recurrence.Parse(text)
	if err != nil {
		return recurrence.Rule{}, &validation.Error{Field: "recurrence", Message: err.Error()}
	}
	return rule, nil
}

func noOccurrences() error {
	return &validation.Error{Code: CodeNoOccurrences, Field: "recurrence", Message: "the rule has no occurrences from the start date on"}
}

func (s *Service) createSeries(ctx context.Context, userID uuid.UUID, title string, in CreateInput, categoryIDs []uuid.UUID) (Instance, error) {
	rule, err := parseRecurrence(*in.Recurrence)
	if err != nil {
		return Instance{}, err
	}
	duration := in.PlannedEnd.Sub(in.PlannedStart)
	if duration%time.Minute != 0 {
		return Instance{}, &validation.Error{Field: "planned_end", Message: "the duration of a repeating task must be whole minutes"}
	}

	var out Instance
	err = s.store.InTx(ctx, func(q *store.Queries) error {
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
		start := recurrence.WallOf(in.PlannedStart, loc)
		if start.Second() != 0 {
			return &validation.Error{Field: "planned_start", Message: "the start of a repeating task must be whole minutes"}
		}
		first, ok, err := recurrence.First(rule, start, loc)
		if err != nil {
			return err
		}
		if !ok {
			return noOccurrences()
		}

		row, err := q.CreateSeries(ctx, store.CreateSeriesParams{
			UserID: userID, Title: title, Description: in.Description, Rrule: rule.String(),
			DtstartLocal: start, Timezone: user.Timezone, DurationMinutes: int32(duration / time.Minute),
		})
		if err != nil {
			return fmt.Errorf("create series: %w", err)
		}
		if err := setSeriesCategories(ctx, q, userID, row.ID, categoryIDs); err != nil {
			return err
		}

		ids, err := insertOccurrences(ctx, q, userID, row, []time.Time{first})
		if err != nil {
			return err
		}
		if len(ids) != 1 {
			return fmt.Errorf("the first occurrence of a new series was not created")
		}
		out, err = get(ctx, q, userID, ids[0])
		return err
	})
	return out, err
}

func setSeriesCategories(ctx context.Context, q *store.Queries, userID, seriesID uuid.UUID, categoryIDs []uuid.UUID) error {
	if err := checkCategories(ctx, q, userID, categoryIDs); err != nil {
		return err
	}
	if err := q.ClearSeriesCategories(ctx, store.ClearSeriesCategoriesParams{SeriesID: seriesID, UserID: userID}); err != nil {
		return fmt.Errorf("clear series categories: %w", err)
	}
	if len(categoryIDs) == 0 {
		return nil
	}
	err := q.AddSeriesCategories(ctx, store.AddSeriesCategoriesParams{SeriesID: seriesID, UserID: userID, CategoryIds: categoryIDs})
	return categoryInsertError(err)
}

// timeChange is a change of the time of day and the duration of a series.
type timeChange struct {
	// setTime is false when only the end was edited: the duration changes, the time of day does not.
	setTime         bool
	hour, minute    int
	durationMinutes int
}

// seriesTimeChange reads a time edit of an occurrence as an edit of the series.
// Only the time of day and the duration can be changed this way: moving the
// occurrence to another day is a change of that one occurrence.
func seriesTimeChange(cur store.TaskInstance, in UpdateInput, loc *time.Location) (*timeChange, error) {
	if in.PlannedStart == nil && in.PlannedEnd == nil {
		return nil, nil
	}
	if cur.PlannedStart == nil || cur.PlannedEnd == nil {
		return nil, fmt.Errorf("occurrence %s of a series has no plan", cur.ID)
	}
	start, end := *cur.PlannedStart, *cur.PlannedEnd
	if in.PlannedStart != nil {
		start = *in.PlannedStart
	}
	if in.PlannedEnd != nil {
		end = *in.PlannedEnd
	}
	if err := validateRange(start, end); err != nil {
		return nil, err
	}

	was, now := recurrence.WallOf(*cur.PlannedStart, loc), recurrence.WallOf(start, loc)
	if in.PlannedStart != nil && (was.Year() != now.Year() || was.YearDay() != now.YearDay()) {
		return nil, &validation.Error{
			Code: CodeSeriesDateChange, Field: "planned_start",
			Message: "the date of an occurrence cannot be changed for a series; change this occurrence only",
		}
	}
	duration := end.Sub(start)
	if now.Second() != 0 || duration%time.Minute != 0 {
		return nil, &validation.Error{Field: "planned_start", Message: "times of a repeating task must be whole minutes"}
	}
	return &timeChange{
		setTime: in.PlannedStart != nil, hour: now.Hour(), minute: now.Minute(),
		durationMinutes: int(duration / time.Minute),
	}, nil
}

// withTime returns the wall time of `day` at the time of day of the change; with
// no change it keeps the time of `base`.
func withTime(day, base recurrence.Wall, tc *timeChange) recurrence.Wall {
	h, m := base.Hour(), base.Minute()
	if tc != nil && tc.setTime {
		h, m = tc.hour, tc.minute
	}
	return time.Date(day.Year(), day.Month(), day.Day(), h, m, 0, 0, time.UTC)
}

// splitPoint finds where the series is cut for ScopeFollowing: the original
// start of the occurrence and how many occurrences come before it. When none
// does, the following occurrences are the whole series.
func splitPoint(row store.TaskSeries, rule recurrence.Rule, loc *time.Location, cur store.TaskInstance) (at time.Time, before int, err error) {
	if cur.OriginalStart == nil {
		return time.Time{}, 0, fmt.Errorf("occurrence %s of series %s has no original start", cur.ID, row.ID)
	}
	before, err = recurrence.CountBefore(rule, row.DtstartLocal, loc, *cur.OriginalStart)
	return *cur.OriginalStart, before, err
}

// endedBefore is the rule cut so that no occurrence starts at or after `at`;
// `before` is the number of occurrences that come before it.
func endedBefore(rule recurrence.Rule, at time.Time, before int) recurrence.Rule {
	if rule.Count > 0 {
		rule.Count = before
	} else {
		until := at.Add(-time.Second)
		rule.Until = &until
	}
	return rule
}

func updateSeries(ctx context.Context, q *store.Queries, userID uuid.UUID, cur store.TaskInstance, scope Scope, in UpdateInput) error {
	row, err := q.GetSeries(ctx, store.GetSeriesParams{ID: cur.SeriesID.UUID, UserID: userID})
	if err != nil {
		return fmt.Errorf("get series: %w", err)
	}
	rule, loc, err := loadRule(row)
	if err != nil {
		return err
	}

	title, description := row.Title, row.Description
	if in.Title != nil {
		if title, err = normalizeTitle(*in.Title); err != nil {
			return err
		}
	}
	if in.Description != nil {
		if err := validateDescription(*in.Description); err != nil {
			return err
		}
		description = *in.Description
	}
	var categoryIDs []uuid.UUID
	if in.CategoryIDs != nil {
		if categoryIDs, err = normalizeCategoryIDs(*in.CategoryIDs); err != nil {
			return err
		}
	}
	tc, err := seriesTimeChange(cur, in, loc)
	if err != nil {
		return err
	}
	var patchedRule *recurrence.Rule
	if in.Recurrence != nil {
		if row.HabitID.Valid {
			return &validation.Error{Field: "recurrence", Message: "the schedule of a habit is changed in the habit"}
		}
		r, err := parseRecurrence(*in.Recurrence)
		if err != nil {
			return err
		}
		patchedRule = &r
	}

	duration := row.DurationMinutes
	if tc != nil {
		duration = int32(tc.durationMinutes)
	}

	var at time.Time
	before := 0
	if scope == ScopeFollowing {
		if at, before, err = splitPoint(row, rule, loc, cur); err != nil {
			return err
		}
	}

	if scope == ScopeAll || before == 0 {
		// The whole series is rewritten. Occurrences that may be rewritten are removed
		// and come back, from the new template, when their window is asked for.
		newRule := rule
		if patchedRule != nil {
			newRule = *patchedRule
		}
		start := withTime(row.DtstartLocal, row.DtstartLocal, tc)
		if _, ok, err := recurrence.First(newRule, start, loc); err != nil {
			return err
		} else if !ok {
			return noOccurrences()
		}
		err := q.UpdateSeries(ctx, store.UpdateSeriesParams{
			ID: row.ID, UserID: userID, Title: title, Description: description,
			Rrule: newRule.String(), DtstartLocal: start, DurationMinutes: duration,
		})
		if err != nil {
			return fmt.Errorf("update series: %w", err)
		}
		if in.CategoryIDs != nil {
			if err := setSeriesCategories(ctx, q, userID, row.ID, categoryIDs); err != nil {
				return err
			}
		}
		if err := deleteRewritable(ctx, q, userID, row.ID, false, false, nil); err != nil {
			return err
		}
		if tc != nil && tc.setTime {
			return rekeySurvivors(ctx, q, userID, row.ID, loc, tc)
		}
		return nil
	}

	// ScopeFollowing in the middle of the series: it is cut in two. The old series
	// ends before this occurrence; a new one starts at it, from the new template.
	newRule := rule
	if rule.Count > 0 {
		newRule.Count = rule.Count - before
	}
	if patchedRule != nil {
		newRule = *patchedRule
	}
	start := withTime(recurrence.WallOf(at, loc), row.DtstartLocal, tc)
	if _, ok, err := recurrence.First(newRule, start, loc); err != nil {
		return err
	} else if !ok {
		return noOccurrences()
	}
	newCategories := categoryIDs
	if in.CategoryIDs == nil {
		cur, err := q.ListSeriesCategoryIDs(ctx, store.ListSeriesCategoryIDsParams{SeriesID: row.ID, UserID: userID})
		if err != nil {
			return fmt.Errorf("list series categories: %w", err)
		}
		newCategories = cur
	}

	err = q.UpdateSeries(ctx, store.UpdateSeriesParams{
		ID: row.ID, UserID: userID, Title: row.Title, Description: row.Description,
		Rrule: endedBefore(rule, at, before).String(), DtstartLocal: row.DtstartLocal, DurationMinutes: row.DurationMinutes,
	})
	if err != nil {
		return fmt.Errorf("end old series: %w", err)
	}
	created, err := q.CreateSeries(ctx, store.CreateSeriesParams{
		UserID: userID, Title: title, Description: description, Rrule: newRule.String(),
		DtstartLocal: start, Timezone: row.Timezone, DurationMinutes: duration, HabitID: row.HabitID,
	})
	if err != nil {
		return fmt.Errorf("create series: %w", err)
	}
	if err := setSeriesCategories(ctx, q, userID, created.ID, newCategories); err != nil {
		return err
	}
	// The tail is the same regular task: its reminders stay as they were set for the series.
	if err := q.CopySeriesReminders(ctx, store.CopySeriesRemindersParams{
		OldSeriesID: uuid.NullUUID{UUID: row.ID, Valid: true}, NewSeriesID: uuid.NullUUID{UUID: created.ID, Valid: true}, UserID: userID,
	}); err != nil {
		return fmt.Errorf("copy series reminders: %w", err)
	}
	if err := deleteRewritable(ctx, q, userID, row.ID, false, false, &at); err != nil {
		return err
	}
	// What is left of the tail (deleted, edited and marked occurrences) now belongs to
	// the new series, and keeps its slots there: nothing is created twice.
	err = q.MoveSeriesInstances(ctx, store.MoveSeriesInstancesParams{
		NewSeriesID: uuid.NullUUID{UUID: created.ID, Valid: true},
		OldSeriesID: uuid.NullUUID{UUID: row.ID, Valid: true},
		UserID:      userID, FromStart: &at,
	})
	if err != nil {
		return fmt.Errorf("move series instances: %w", err)
	}
	if tc != nil && tc.setTime {
		return rekeySurvivors(ctx, q, userID, created.ID, loc, tc)
	}
	return nil
}

// rekeySurvivors moves the keys (original starts) of the occurrences that an edit
// leaves in place (deleted, edited and marked ones) to the new time of day of the
// series, on the same local date. A series has at most one occurrence per day, so
// the date identifies the slot: without this, a new time would make the template
// create a second occurrence on each of those days.
func rekeySurvivors(ctx context.Context, q *store.Queries, userID, seriesID uuid.UUID, loc *time.Location, tc *timeChange) error {
	rows, err := q.ListSeriesSurvivors(ctx, store.ListSeriesSurvivorsParams{SeriesID: uuid.NullUUID{UUID: seriesID, Valid: true}, UserID: userID})
	if err != nil {
		return fmt.Errorf("list survivors: %w", err)
	}
	for _, r := range rows {
		if r.OriginalStart == nil {
			continue
		}
		day := recurrence.WallOf(*r.OriginalStart, loc)
		key := recurrence.Instant(time.Date(day.Year(), day.Month(), day.Day(), tc.hour, tc.minute, 0, 0, time.UTC), loc)
		if key.Equal(*r.OriginalStart) {
			continue
		}
		if err := q.SetInstanceOriginalStart(ctx, store.SetInstanceOriginalStartParams{ID: r.ID, UserID: userID, OriginalStart: &key}); err != nil {
			return fmt.Errorf("re-key instance: %w", err)
		}
	}
	return nil
}

func deleteSeries(ctx context.Context, q *store.Queries, userID uuid.UUID, cur store.TaskInstance, scope Scope) error {
	row, err := q.GetSeries(ctx, store.GetSeriesParams{ID: cur.SeriesID.UUID, UserID: userID})
	if err != nil {
		return fmt.Errorf("get series: %w", err)
	}
	rule, loc, err := loadRule(row)
	if err != nil {
		return err
	}

	var at time.Time
	before := 0
	if scope == ScopeFollowing {
		if at, before, err = splitPoint(row, rule, loc, cur); err != nil {
			return err
		}
	}

	if scope == ScopeAll || before == 0 {
		// Planned occurrences go; marked ones are history and keep their rows,
		// which lose the link to the deleted series.
		if err := deleteRewritable(ctx, q, userID, row.ID, true, true, nil); err != nil {
			return err
		}
		if err := q.DeleteSeries(ctx, store.DeleteSeriesParams{ID: row.ID, UserID: userID}); err != nil {
			return fmt.Errorf("delete series: %w", err)
		}
		return nil
	}

	err = q.UpdateSeries(ctx, store.UpdateSeriesParams{
		ID: row.ID, UserID: userID, Title: row.Title, Description: row.Description,
		Rrule: endedBefore(rule, at, before).String(), DtstartLocal: row.DtstartLocal, DurationMinutes: row.DurationMinutes,
	})
	if err != nil {
		return fmt.Errorf("end series: %w", err)
	}
	return deleteRewritable(ctx, q, userID, row.ID, true, true, &at)
}

// deleteRewritable removes the occurrences of a series that an edit or a delete
// of the series may remove (see the query for the rule that protects history).
func deleteRewritable(ctx context.Context, q *store.Queries, userID, seriesID uuid.UUID, includeDetached, includeCancelled bool, from *time.Time) error {
	_, err := q.DeleteSeriesInstances(ctx, store.DeleteSeriesInstancesParams{
		SeriesID: uuid.NullUUID{UUID: seriesID, Valid: true}, UserID: userID,
		IncludeDetached: includeDetached, IncludeCancelled: includeCancelled, FromStart: from,
	})
	if err != nil {
		return fmt.Errorf("delete series instances: %w", err)
	}
	return nil
}
