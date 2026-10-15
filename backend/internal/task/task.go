// Package task manages the user's tasks in the calendar.
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
)

var ErrNotFound = errors.New("task not found")

type Instance struct {
	ID           uuid.UUID
	Title        string
	Description  string
	PlannedStart time.Time
	PlannedEnd   time.Time
	Status       string
	CategoryIDs  []uuid.UUID
}

type CreateInput struct {
	Title        string
	Description  string
	PlannedStart time.Time
	PlannedEnd   time.Time
	CategoryIDs  []uuid.UUID
}

// UpdateInput holds the fields to change; nil fields are left as is. A non-nil
// CategoryIDs replaces the whole set (an empty slice removes all categories).
type UpdateInput struct {
	Title        *string
	Description  *string
	PlannedStart *time.Time
	PlannedEnd   *time.Time
	CategoryIDs  *[]uuid.UUID
}

type Service struct {
	store *store.Store
}

func NewService(s *store.Store) *Service {
	return &Service{store: s}
}

// List returns the tasks whose plan overlaps [from, to).
func (s *Service) List(ctx context.Context, userID uuid.UUID, from, to time.Time) ([]Instance, error) {
	if !to.After(from) {
		return nil, &validation.Error{Field: "to", Message: "must be after from"}
	}
	if to.Sub(from) > MaxRange {
		return nil, &validation.Error{Field: "to", Message: "the range is too long (at most 100 days)"}
	}
	rows, err := s.store.ListInstances(ctx, store.ListInstancesParams{UserID: userID, RangeFrom: from, RangeTo: to})
	if err != nil {
		return nil, fmt.Errorf("list instances: %w", err)
	}
	out := make([]Instance, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r)
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

	var out Instance
	err = s.store.InTx(ctx, func(q *store.Queries) error {
		id, err := q.CreateInstance(ctx, store.CreateInstanceParams{
			UserID: userID, Title: title, Description: in.Description,
			PlannedStart: in.PlannedStart, PlannedEnd: in.PlannedEnd,
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

func (s *Service) Update(ctx context.Context, userID, id uuid.UUID, in UpdateInput) (Instance, error) {
	var out Instance
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.LockInstance(ctx, store.LockInstanceParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock instance: %w", err)
		}

		params := store.UpdateInstanceParams{
			ID: id, UserID: userID, Title: cur.Title, Description: cur.Description,
			PlannedStart: cur.PlannedStart, PlannedEnd: cur.PlannedEnd,
		}
		if in.Title != nil {
			if params.Title, err = normalizeTitle(*in.Title); err != nil {
				return err
			}
		}
		if in.Description != nil {
			if err := validateDescription(*in.Description); err != nil {
				return err
			}
			params.Description = *in.Description
		}
		if in.PlannedStart != nil {
			params.PlannedStart = *in.PlannedStart
		}
		if in.PlannedEnd != nil {
			params.PlannedEnd = *in.PlannedEnd
		}
		if err := validateRange(params.PlannedStart, params.PlannedEnd); err != nil {
			return err
		}
		var categoryIDs []uuid.UUID
		if in.CategoryIDs != nil {
			if categoryIDs, err = normalizeCategoryIDs(*in.CategoryIDs); err != nil {
				return err
			}
		}

		if err := q.UpdateInstance(ctx, params); err != nil {
			return fmt.Errorf("update instance: %w", err)
		}
		if in.CategoryIDs != nil {
			if err := setCategories(ctx, q, userID, id, categoryIDs); err != nil {
				return err
			}
		}
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

func (s *Service) Delete(ctx context.Context, userID, id uuid.UUID) error {
	n, err := s.store.DeleteInstance(ctx, store.DeleteInstanceParams{ID: id, UserID: userID})
	if err != nil {
		return fmt.Errorf("delete instance: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func get(ctx context.Context, q *store.Queries, userID, id uuid.UUID) (Instance, error) {
	r, err := q.GetInstance(ctx, store.GetInstanceParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Instance{}, ErrNotFound
	}
	if err != nil {
		return Instance{}, fmt.Errorf("get instance: %w", err)
	}
	return fromRow(store.ListInstancesRow(r)), nil
}

// fromRow is the only place that maps a query row to Instance. GetInstanceRow
// has the same fields as ListInstancesRow, so it converts directly.
func fromRow(r store.ListInstancesRow) Instance {
	return Instance{
		ID: r.ID, Title: r.Title, Description: r.Description, PlannedStart: r.PlannedStart,
		PlannedEnd: r.PlannedEnd, Status: r.Status, CategoryIDs: r.CategoryIds,
	}
}

// setCategories replaces the task's categories. Every id must be a category of
// the user: ownership is also guaranteed by the composite foreign keys.
func setCategories(ctx context.Context, q *store.Queries, userID, id uuid.UUID, categoryIDs []uuid.UUID) error {
	if len(categoryIDs) > 0 {
		n, err := q.CountUserCategories(ctx, store.CountUserCategoriesParams{UserID: userID, Ids: categoryIDs})
		if err != nil {
			return fmt.Errorf("count categories: %w", err)
		}
		if int(n) != len(categoryIDs) {
			return &validation.Error{Field: "category_ids", Message: "unknown category"}
		}
	}
	if err := q.ClearInstanceCategories(ctx, store.ClearInstanceCategoriesParams{InstanceID: id, UserID: userID}); err != nil {
		return fmt.Errorf("clear categories: %w", err)
	}
	if len(categoryIDs) == 0 {
		return nil
	}
	err := q.AddInstanceCategories(ctx, store.AddInstanceCategoriesParams{InstanceID: id, UserID: userID, CategoryIds: categoryIDs})
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23503" {
		// A category was deleted between the check above and the insert.
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
