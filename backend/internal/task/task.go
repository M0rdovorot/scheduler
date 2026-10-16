// Package task manages the user's tasks in the calendar: one-off tasks and the
// occurrences of regular (repeating) ones.
package task

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	maxTitleLen       = 200
	maxDescriptionLen = 5000
	maxCategories     = 50

	// MaxRange is the longest window List accepts.
	MaxRange = 100 * 24 * time.Hour

	// Error codes of validation errors that clients react to.
	CodeSeriesDateChange = "series_date_change"
	CodeNoOccurrences    = "no_occurrences"
	CodeInvalidState     = "invalid_state"
	CodeFactInFuture     = "fact_in_future"
)

var (
	ErrNotFound       = errors.New("task not found")
	ErrSeriesNotFound = errors.New("series not found")
)

// Scope says what an edit or a delete of an occurrence applies to (FR-4.2).
type Scope string

const (
	ScopeThis      Scope = "this"
	ScopeFollowing Scope = "following"
	ScopeAll       Scope = "all"
)

// ParseScope reads the scope; an empty string means ScopeThis.
func ParseScope(s string) (Scope, bool) {
	switch Scope(s) {
	case "", ScopeThis:
		return ScopeThis, true
	case ScopeFollowing:
		return ScopeFollowing, true
	case ScopeAll:
		return ScopeAll, true
	}
	return "", false
}

// Link points at the other half of a reschedule.
type Link struct {
	ID           uuid.UUID
	PlannedStart time.Time
	PlannedEnd   time.Time
}

type Instance struct {
	ID          uuid.UUID
	Title       string
	Description string
	// PlannedStart and PlannedEnd are nil for a task that was never planned.
	PlannedStart *time.Time
	PlannedEnd   *time.Time
	// ActualStart is nil until the task is started or marked; ActualEnd is nil while a timer runs.
	ActualStart *time.Time
	ActualEnd   *time.Time
	Status      string
	Comment     string
	CategoryIDs []uuid.UUID
	// SeriesID is set for occurrences of a regular task.
	SeriesID *uuid.UUID
	// HabitID is set for occurrences of a habit that is placed in the grid.
	HabitID *uuid.UUID
	// RescheduledFrom is the task this one replaced; RescheduledTo the one that replaced this.
	RescheduledFrom *Link
	RescheduledTo   *Link
	// Deviations of the fact from the plan, by the user's threshold; computed, never stored.
	Deviations []Deviation
}

type CreateInput struct {
	Title        string
	Description  string
	PlannedStart time.Time
	PlannedEnd   time.Time
	CategoryIDs  []uuid.UUID
	// Recurrence is an RRULE; when set, a regular task is created whose first
	// occurrence slot is PlannedStart–PlannedEnd.
	Recurrence *string
}

// UpdateInput holds the fields to change; nil fields are left as is. A non-nil
// CategoryIDs replaces the whole set (an empty slice removes all categories).
type UpdateInput struct {
	Title        *string
	Description  *string
	PlannedStart *time.Time
	PlannedEnd   *time.Time
	CategoryIDs  *[]uuid.UUID
	// Recurrence replaces the repeat rule; only for ScopeFollowing and ScopeAll.
	Recurrence *string
}

type Service struct {
	store *store.Store
	now   func() time.Time
}

func NewService(s *store.Store) *Service {
	return &Service{store: s, now: time.Now}
}

// SetClock replaces the clock of the service; tests use it to fix the time.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// Now is the current time of the service, so that other services reading the same data use the same instant.
func (s *Service) Now() time.Time { return s.now() }

// List returns the tasks whose plan or fact overlaps [from, to). The occurrences of
// regular tasks in the window are created first if they do not exist yet.
func (s *Service) List(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]Instance, error) {
	if !to.After(from) {
		return nil, &validation.Error{Field: "to", Message: "must be after from"}
	}
	if to.Sub(from) > MaxRange {
		return nil, &validation.Error{Field: "to", Message: "the range is too long (at most 100 days)"}
	}
	return s.ListUnbounded(ctx, userID, from, to)
}

// ListUnbounded is List without the limit on the length of the window, for callers
// that bound it themselves (statistics).
func (s *Service) ListUnbounded(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]Instance, error) {
	if err := s.Materialize(ctx, userID, from, to); err != nil {
		return nil, err
	}
	threshold, err := deviationThreshold(ctx, s.store.Queries, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.ListInstances(ctx, store.ListInstancesParams{
		UserID: userID, RangeFrom: &from, RangeTo: &to, Now: s.now(),
	})
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}
	out := make([]Instance, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r, threshold)
	}
	return out, nil
}

// Running returns the tasks whose timer is running, whenever they were started.
func (s *Service) Running(ctx context.Context, userID uuid.UUID) ([]Instance, error) {
	threshold, err := deviationThreshold(ctx, s.store.Queries, userID)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.ListRunningInstances(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list running instances: %w", err)
	}
	out := make([]Instance, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r, threshold)
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, userID, id uuid.UUID) (Instance, error) {
	return get(ctx, s.store.Queries, userID, id)
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, in CreateInput) (Instance, error) {
	title, err := normalizeTitle(in.Title)
	if err != nil {
		return Instance{}, err
	}
	if err := validateDescription(in.Description); err != nil {
		return Instance{}, err
	}
	if err := validateRange(in.PlannedStart, in.PlannedEnd); err != nil {
		return Instance{}, err
	}
	categoryIDs, err := normalizeCategoryIDs(in.CategoryIDs)
	if err != nil {
		return Instance{}, err
	}
	if in.Recurrence != nil {
		return s.createSeries(ctx, userID, title, in, categoryIDs)
	}

	var out Instance
	err = s.store.InTx(ctx, func(q *store.Queries) error {
		id, err := q.CreateInstance(ctx, store.CreateInstanceParams{
			UserID: userID, Title: title, Description: in.Description,
			PlannedStart: &in.PlannedStart, PlannedEnd: &in.PlannedEnd,
		})
		if err != nil {
			return fmt.Errorf("create instance: %w", err)
		}
		if err := setCategories(ctx, q, userID, id, categoryIDs); err != nil {
			return err
		}
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

// Update edits an occurrence or a one-off task. For ScopeThis it returns the
// updated task; for ScopeFollowing and ScopeAll the series is rewritten and nil
// is returned, because the occurrences are re-created lazily.
func (s *Service) Update(ctx context.Context, userID, id uuid.UUID, scope Scope, in UpdateInput) (*Instance, error) {
	var out *Instance
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		// Series first, then the row: the same order everywhere, so edits cannot deadlock.
		if err := q.LockSeriesChanges(ctx, userID.String()); err != nil {
			return fmt.Errorf("lock series: %w", err)
		}
		cur, err := q.LockInstance(ctx, store.LockInstanceParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock instance: %w", err)
		}

		// A rescheduled task is history: what changes is the task it was moved to.
		if cur.Status == StatusRescheduled {
			return invalidState("the task was rescheduled; edit the new task instead")
		}
		if scope != ScopeThis {
			if !cur.SeriesID.Valid {
				return &validation.Error{Field: "scope", Message: "the task is not part of a series"}
			}
			return updateSeries(ctx, q, userID, cur, scope, in)
		}
		if in.Recurrence != nil {
			return &validation.Error{Field: "recurrence", Message: "the repeat rule can only be changed for the whole series or the following tasks"}
		}
		inst, err := updateInstance(ctx, q, userID, cur, in)
		if err != nil {
			return err
		}
		out = &inst
		return nil
	})
	return out, err
}

// updateInstance edits one row. An occurrence of a series becomes detached, so
// that later edits of the whole series leave it alone.
func updateInstance(ctx context.Context, q *store.Queries, userID uuid.UUID, cur store.TaskInstance, in UpdateInput) (Instance, error) {
	params := store.UpdateInstanceParams{
		ID: cur.ID, UserID: userID, Title: cur.Title, Description: cur.Description,
		PlannedStart: cur.PlannedStart, PlannedEnd: cur.PlannedEnd, Detach: cur.SeriesID.Valid,
	}
	var err error
	if in.Title != nil {
		if params.Title, err = normalizeTitle(*in.Title); err != nil {
			return Instance{}, err
		}
	}
	if in.Description != nil {
		if err := validateDescription(*in.Description); err != nil {
			return Instance{}, err
		}
		params.Description = *in.Description
	}
	if cur.PlannedStart == nil {
		// A task that was never planned has only a fact; it gets no plan afterwards.
		if in.PlannedStart != nil || in.PlannedEnd != nil {
			return Instance{}, &validation.Error{Field: "planned_start", Message: "a task outside the plan has no planned time"}
		}
	} else {
		start, end := *cur.PlannedStart, *cur.PlannedEnd
		if in.PlannedStart != nil {
			start = *in.PlannedStart
		}
		if in.PlannedEnd != nil {
			end = *in.PlannedEnd
		}
		if err := validateRange(start, end); err != nil {
			return Instance{}, err
		}
		params.PlannedStart, params.PlannedEnd = &start, &end
	}
	var categoryIDs []uuid.UUID
	if in.CategoryIDs != nil {
		if categoryIDs, err = normalizeCategoryIDs(*in.CategoryIDs); err != nil {
			return Instance{}, err
		}
	}

	if err := q.UpdateInstance(ctx, params); err != nil {
		return Instance{}, fmt.Errorf("update instance: %w", err)
	}
	if in.CategoryIDs != nil {
		if err := setCategories(ctx, q, userID, cur.ID, categoryIDs); err != nil {
			return Instance{}, err
		}
	}
	return get(ctx, q, userID, cur.ID)
}

// Delete removes an occurrence or a one-off task. Deleting one occurrence of a
// series keeps its row as cancelled, so that it is not created again.
func (s *Service) Delete(ctx context.Context, userID, id uuid.UUID, scope Scope) error {
	return s.store.InTx(ctx, func(q *store.Queries) error {
		if err := q.LockSeriesChanges(ctx, userID.String()); err != nil {
			return fmt.Errorf("lock series: %w", err)
		}
		cur, err := q.LockInstance(ctx, store.LockInstanceParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock instance: %w", err)
		}

		if !cur.SeriesID.Valid {
			if scope != ScopeThis {
				return &validation.Error{Field: "scope", Message: "the task is not part of a series"}
			}
			if _, err := q.DeleteInstance(ctx, store.DeleteInstanceParams{ID: id, UserID: userID}); err != nil {
				return fmt.Errorf("delete instance: %w", err)
			}
			return nil
		}
		if scope == ScopeThis {
			// Also for a marked occurrence: the user asked for it (the client warns that the fact
			// goes too). The row stays as a deleted slot, without its fact.
			if err := q.CancelInstance(ctx, store.CancelInstanceParams{ID: id, UserID: userID}); err != nil {
				return fmt.Errorf("cancel instance: %w", err)
			}
			if err := q.RevokeHabitCredit(ctx, store.RevokeHabitCreditParams{InstanceID: uuid.NullUUID{UUID: id, Valid: true}, UserID: userID}); err != nil {
				return fmt.Errorf("revoke habit credit: %w", err)
			}
			return nil
		}
		return deleteSeries(ctx, q, userID, cur, scope)
	})
}

func get(ctx context.Context, q *store.Queries, userID, id uuid.UUID) (Instance, error) {
	threshold, err := deviationThreshold(ctx, q, userID)
	if err != nil {
		return Instance{}, err
	}
	r, err := q.GetInstance(ctx, store.GetInstanceParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Instance{}, ErrNotFound
	}
	if err != nil {
		return Instance{}, fmt.Errorf("get instance: %w", err)
	}
	return fromRow(r, threshold), nil
}

// deviationThreshold is the user's threshold from which a difference between plan and fact counts.
func deviationThreshold(ctx context.Context, q *store.Queries, userID uuid.UUID) (int, error) {
	u, err := q.GetUser(ctx, userID)
	if err != nil {
		return 0, fmt.Errorf("get user: %w", err)
	}
	return int(u.DeviationThresholdMinutes), nil
}

// fromRow is the only place that maps a query row to Instance.
func fromRow(r store.InstanceDetail, threshold int) Instance {
	in := Instance{
		ID: r.ID, Title: r.Title, Description: r.Description,
		PlannedStart: r.PlannedStart, PlannedEnd: r.PlannedEnd,
		ActualStart: r.ActualStart, ActualEnd: r.ActualEnd,
		Status: r.Status, Comment: r.Comment, CategoryIDs: r.CategoryIds,
		SeriesID:        nullUUIDPtr(r.SeriesID),
		HabitID:         nullUUIDPtr(r.HabitID),
		RescheduledFrom: link(r.FromID, r.FromPlannedStart, r.FromPlannedEnd),
		RescheduledTo:   link(r.ToID, r.ToPlannedStart, r.ToPlannedEnd),
	}
	// Deviations describe a fact: a task that is only planned (or dropped) has none.
	switch r.Status {
	case "in_progress", "done", "partial":
		in.Deviations = Deviations(r.PlannedStart, r.PlannedEnd, r.ActualStart, r.ActualEnd, threshold)
	}
	return in
}

func link(id uuid.NullUUID, start, end *time.Time) *Link {
	if !id.Valid || start == nil || end == nil {
		return nil
	}
	return &Link{ID: id.UUID, PlannedStart: *start, PlannedEnd: *end}
}

func nullUUIDPtr(id uuid.NullUUID) *uuid.UUID {
	if !id.Valid {
		return nil
	}
	return &id.UUID
}

// setCategories replaces the task's categories. Every id must be a category of
// the user: ownership is also guaranteed by the composite foreign keys.
func setCategories(ctx context.Context, q *store.Queries, userID, id uuid.UUID, categoryIDs []uuid.UUID) error {
	if err := checkCategories(ctx, q, userID, categoryIDs); err != nil {
		return err
	}
	if err := q.ClearInstanceCategories(ctx, store.ClearInstanceCategoriesParams{InstanceID: id, UserID: userID}); err != nil {
		return fmt.Errorf("clear categories: %w", err)
	}
	if len(categoryIDs) == 0 {
		return nil
	}
	err := q.AddInstanceCategories(ctx, store.AddInstanceCategoriesParams{InstanceID: id, UserID: userID, CategoryIds: categoryIDs})
	return categoryInsertError(err)
}

func checkCategories(ctx context.Context, q *store.Queries, userID uuid.UUID, categoryIDs []uuid.UUID) error {
	if len(categoryIDs) == 0 {
		return nil
	}
	n, err := q.CountUserCategories(ctx, store.CountUserCategoriesParams{UserID: userID, Ids: categoryIDs})
	if err != nil {
		return fmt.Errorf("count categories: %w", err)
	}
	if int(n) != len(categoryIDs) {
		return &validation.Error{Field: "category_ids", Message: "unknown category"}
	}
	return nil
}

// categoryInsertError turns a foreign key violation (a category deleted between
// the check and the insert) into a validation error.
func categoryInsertError(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		return &validation.Error{Field: "category_ids", Message: "unknown category"}
	}
	if err != nil {
		return fmt.Errorf("add categories: %w", err)
	}
	return nil
}

func normalizeTitle(title string) (string, error) {
	title = strings.TrimSpace(title)
	if !validation.ValidText(title) {
		return "", &validation.Error{Field: "title", Message: "contains invalid characters"}
	}
	if n := utf8.RuneCountInString(title); n < 1 || n > maxTitleLen {
		return "", &validation.Error{Field: "title", Message: fmt.Sprintf("must be 1 to %d characters", maxTitleLen)}
	}
	return title, nil
}

func validateDescription(d string) error {
	if !validation.ValidText(d) {
		return &validation.Error{Field: "description", Message: "contains invalid characters"}
	}
	if utf8.RuneCountInString(d) > maxDescriptionLen {
		return &validation.Error{Field: "description", Message: fmt.Sprintf("must be at most %d characters", maxDescriptionLen)}
	}
	return nil
}

func validateRange(start, end time.Time) error {
	if !end.After(start) {
		return &validation.Error{Field: "planned_end", Message: "must be after planned_start"}
	}
	return nil
}

// normalizeCategoryIDs removes duplicates and bounds the count.
func normalizeCategoryIDs(ids []uuid.UUID) ([]uuid.UUID, error) {
	out := slices.Clone(ids)
	slices.SortFunc(out, func(a, b uuid.UUID) int { return strings.Compare(a.String(), b.String()) })
	out = slices.Compact(out)
	if len(out) > maxCategories {
		return nil, &validation.Error{Field: "category_ids", Message: fmt.Sprintf("at most %d categories", maxCategories)}
	}
	return out, nil
}
