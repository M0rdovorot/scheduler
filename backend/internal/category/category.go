// Package category manages the user's category tree.
package category

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	maxNameLen = 100

	CodeCycle          = "category_cycle"
	CodeParentArchived = "parent_archived"
)

var (
	ErrNotFound = errors.New("category not found")

	colorRe = regexp.MustCompile(`^#[0-9a-f]{6}$`)
)

type Category struct {
	ID         uuid.UUID
	ParentID   *uuid.UUID // nil for top-level categories
	Name       string
	Color      string
	ArchivedAt *time.Time
}

func fromRow(r store.Category) Category {
	c := Category{ID: r.ID, Name: r.Name, Color: r.Color, ArchivedAt: r.ArchivedAt}
	if r.ParentID.Valid {
		id := r.ParentID.UUID
		c.ParentID = &id
	}
	return c
}

type CreateInput struct {
	Name     string
	Color    string
	ParentID *uuid.UUID
}

// UpdateInput holds the fields to change; nil fields are left as is.
type UpdateInput struct {
	Name  *string
	Color *string
}

type Service struct {
	store *store.Store
	now   func() time.Time
}

func NewService(s *store.Store) *Service {
	return &Service{store: s, now: time.Now}
}

// List returns all categories of the user, archived ones included.
func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]Category, error) {
	rows, err := s.store.ListCategories(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list categories: %w", err)
	}
	out := make([]Category, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r)
	}
	return out, nil
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, in CreateInput) (Category, error) {
	name, err := normalizeName(in.Name)
	if err != nil {
		return Category{}, err
	}
	color, err := normalizeColor(in.Color)
	if err != nil {
		return Category{}, err
	}

	var row store.Category
	err = s.inTx(ctx, userID, func(q *store.Queries) error {
		if in.ParentID != nil {
			if _, err := getActive(ctx, q, userID, *in.ParentID, "parent_id"); err != nil {
				return err
			}
		}
		row, err = q.CreateCategory(ctx, store.CreateCategoryParams{
			UserID: userID, ParentID: nullUUID(in.ParentID), Name: name, Color: color,
		})
		if err != nil {
			return fmt.Errorf("create category: %w", err)
		}
		return nil
	})
	if err != nil {
		return Category{}, err
	}
	return fromRow(row), nil
}

func (s *Service) Update(ctx context.Context, userID, id uuid.UUID, in UpdateInput) (Category, error) {
	params := store.UpdateCategoryParams{ID: id, UserID: userID}
	if in.Name != nil {
		name, err := normalizeName(*in.Name)
		if err != nil {
			return Category{}, err
		}
		params.Name = &name
	}
	if in.Color != nil {
		color, err := normalizeColor(*in.Color)
		if err != nil {
			return Category{}, err
		}
		params.Color = &color
	}

	row, err := s.store.UpdateCategory(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		return Category{}, ErrNotFound
	}
	if err != nil {
		return Category{}, fmt.Errorf("update category: %w", err)
	}
	return fromRow(row), nil
}

// Move makes parentID (nil: the top level) the new parent of the category.
// A category cannot move into its own subtree, and an active category cannot
// move under an archived one.
func (s *Service) Move(ctx context.Context, userID, id uuid.UUID, parentID *uuid.UUID) (Category, error) {
	var row store.Category
	err := s.inTx(ctx, userID, func(q *store.Queries) error {
		cat, err := get(ctx, q, userID, id)
		if err != nil {
			return err
		}
		if parentID != nil {
			subtree, err := q.ListCategorySubtreeIDs(ctx, store.ListCategorySubtreeIDsParams{RootID: id, UserID: userID})
			if err != nil {
				return fmt.Errorf("list subtree: %w", err)
			}
			if slices.Contains(subtree, *parentID) {
				return &validation.Error{Code: CodeCycle, Field: "parent_id", Message: "a category cannot be moved into itself or its subcategory"}
			}
			parent, err := get(ctx, q, userID, *parentID)
			if errors.Is(err, ErrNotFound) {
				return &validation.Error{Field: "parent_id", Message: "category not found"}
			}
			if err != nil {
				return err
			}
			if parent.ArchivedAt != nil && cat.ArchivedAt == nil {
				return errParentArchived()
			}
		}
		row, err = q.SetCategoryParent(ctx, store.SetCategoryParentParams{ID: id, UserID: userID, ParentID: nullUUID(parentID)})
		if err != nil {
			return fmt.Errorf("set parent: %w", err)
		}
		return nil
	})
	if err != nil {
		return Category{}, err
	}
	return fromRow(row), nil
}

// Archive archives the category together with all its subcategories.
func (s *Service) Archive(ctx context.Context, userID, id uuid.UUID) (Category, error) {
	now := s.now()
	var row store.Category
	err := s.inTx(ctx, userID, func(q *store.Queries) error {
		if _, err := get(ctx, q, userID, id); err != nil {
			return err
		}
		ids, err := q.ListCategorySubtreeIDs(ctx, store.ListCategorySubtreeIDsParams{RootID: id, UserID: userID})
		if err != nil {
			return fmt.Errorf("list subtree: %w", err)
		}
		if _, err := q.ArchiveCategories(ctx, store.ArchiveCategoriesParams{Now: &now, UserID: userID, Ids: ids}); err != nil {
			return fmt.Errorf("archive categories: %w", err)
		}
		row, err = q.GetCategory(ctx, store.GetCategoryParams{ID: id, UserID: userID})
		if err != nil {
			return fmt.Errorf("reload category: %w", err)
		}
		return nil
	})
	if err != nil {
		return Category{}, err
	}
	return fromRow(row), nil
}

// Unarchive restores one category. Its parent must not be archived.
func (s *Service) Unarchive(ctx context.Context, userID, id uuid.UUID) (Category, error) {
	var row store.Category
	err := s.inTx(ctx, userID, func(q *store.Queries) error {
		cat, err := get(ctx, q, userID, id)
		if err != nil {
			return err
		}
		if cat.ParentID.Valid {
			parent, err := get(ctx, q, userID, cat.ParentID.UUID)
			if err != nil {
				return err
			}
			if parent.ArchivedAt != nil {
				return errParentArchived()
			}
		}
		row, err = q.UnarchiveCategory(ctx, store.UnarchiveCategoryParams{ID: id, UserID: userID})
		if err != nil {
			return fmt.Errorf("unarchive category: %w", err)
		}
		return nil
	})
	if err != nil {
		return Category{}, err
	}
	return fromRow(row), nil
}

// Delete removes the category together with all its subcategories.
func (s *Service) Delete(ctx context.Context, userID, id uuid.UUID) error {
	n, err := s.store.DeleteCategory(ctx, store.DeleteCategoryParams{ID: id, UserID: userID})
	if err != nil {
		return fmt.Errorf("delete category: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// inTx runs fn in a transaction holding the user's category lock, so that
// structural changes of one user (and the cycle check) never interleave.
func (s *Service) inTx(ctx context.Context, userID uuid.UUID, fn func(q *store.Queries) error) error {
	return s.store.InTx(ctx, func(q *store.Queries) error {
		if err := q.LockUserCategories(ctx, userID.String()); err != nil {
			return fmt.Errorf("lock categories: %w", err)
		}
		return fn(q)
	})
}

func get(ctx context.Context, q *store.Queries, userID, id uuid.UUID) (store.Category, error) {
	row, err := q.GetCategory(ctx, store.GetCategoryParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.Category{}, ErrNotFound
	}
	if err != nil {
		return store.Category{}, fmt.Errorf("get category: %w", err)
	}
	return row, nil
}

// getActive loads a category that is going to become a parent.
func getActive(ctx context.Context, q *store.Queries, userID, id uuid.UUID, field string) (store.Category, error) {
	row, err := get(ctx, q, userID, id)
	if errors.Is(err, ErrNotFound) {
		return store.Category{}, &validation.Error{Field: field, Message: "category not found"}
	}
	if err != nil {
		return store.Category{}, err
	}
	if row.ArchivedAt != nil {
		return store.Category{}, errParentArchived()
	}
	return row, nil
}

func errParentArchived() error {
	return &validation.Error{Code: CodeParentArchived, Field: "parent_id", Message: "the parent category is archived"}
}

func normalizeName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if n := utf8.RuneCountInString(name); n < 1 || n > maxNameLen {
		return "", &validation.Error{Field: "name", Message: fmt.Sprintf("must be 1 to %d characters", maxNameLen)}
	}
	return name, nil
}

func normalizeColor(color string) (string, error) {
	color = strings.ToLower(strings.TrimSpace(color))
	if !colorRe.MatchString(color) {
		return "", &validation.Error{Field: "color", Message: "must be a hex color like #1a2b3c"}
	}
	return color, nil
}

func nullUUID(id *uuid.UUID) uuid.NullUUID {
	if id == nil {
		return uuid.NullUUID{}
	}
	return uuid.NullUUID{UUID: *id, Valid: true}
}
