package partner

import (
	"context"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/internal/visibility"
)

const (
	// MaxWindow is the longest window of a busy or free-time query.
	MaxWindow = task.MaxRange
	// MaxPeople is how many partners one free-time query may name.
	MaxPeople = 20
)

// Interval is a stretch of time.
type Interval struct {
	Start, End time.Time
}

// Block is a busy interval of a partner. Title is nil where the viewer may not see it.
type Block struct {
	Interval
	Title *string
}

// Materializer creates the occurrences of the series of a user in a window, so that
// the busy time of a user who has not opened the window himself is complete.
type Materializer interface {
	Materialize(ctx context.Context, userID uuid.UUID, from, to time.Time) error
}

// Busy returns the time the owner is busy in [from, to), as the viewer may see it.
func (s *Service) Busy(ctx context.Context, viewerID, ownerID uuid.UUID, from, to time.Time) ([]Block, error) {
	if err := checkWindow(from, to); err != nil {
		return nil, err
	}
	if err := s.requirePartner(ctx, viewerID, ownerID); err != nil {
		return nil, err
	}
	return s.busy(ctx, viewerID, ownerID, from, to)
}

// FreeTime returns the stretches of [from, to) in which the viewer and all the named
// partners are free, at least `minLen` long, in time order.
func (s *Service) FreeTime(ctx context.Context, viewerID uuid.UUID, with []uuid.UUID, from, to time.Time, minLen time.Duration) ([]Interval, error) {
	if err := checkWindow(from, to); err != nil {
		return nil, err
	}
	people := dedupe(with, viewerID)
	if len(people) > MaxPeople {
		return nil, &validation.Error{Field: "with", Message: fmt.Sprintf("at most %d partners", MaxPeople)}
	}
	for _, id := range people {
		if err := s.requirePartner(ctx, viewerID, id); err != nil {
			return nil, err
		}
	}

	var busy []Interval
	for _, id := range append([]uuid.UUID{viewerID}, people...) {
		blocks, err := s.busy(ctx, viewerID, id, from, to)
		if err != nil {
			return nil, err
		}
		for _, b := range blocks {
			busy = append(busy, b.Interval)
		}
	}
	return freeIntervals(from, to, busy, minLen), nil
}

func (s *Service) busy(ctx context.Context, viewerID, ownerID uuid.UUID, from, to time.Time) ([]Block, error) {
	if err := s.tasks.Materialize(ctx, ownerID, from, to); err != nil {
		return nil, fmt.Errorf("materialize series of %s: %w", ownerID, err)
	}
	rows, err := s.store.ListBusy(ctx, store.ListBusyParams{UserID: ownerID, RangeFrom: from, RangeTo: to, Now: s.now()})
	if err != nil {
		return nil, fmt.Errorf("list busy time: %w", err)
	}
	var access store.GetAccessGivenRow
	if viewerID != ownerID {
		access, err = s.store.GetAccessGiven(ctx, store.GetAccessGivenParams{OwnerID: ownerID, GranteeID: viewerID})
		if err != nil {
			return nil, fmt.Errorf("get access: %w", err)
		}
	}
	out := make([]Block, len(rows))
	for i, r := range rows {
		out[i] = Block{Interval: Interval{Start: r.StartsAt, End: r.EndsAt}}
		if viewerID == ownerID || titleVisible(r, access) {
			title := r.Title
			out[i].Title = &title
		}
	}
	return out, nil
}

// titleVisible says whether a viewer with the given access sees the title of a busy row.
// The title of a habit goes by the access to habits alone, whatever its visibility.
func titleVisible(r store.ListBusyRow, access store.GetAccessGivenRow) bool {
	if r.HabitID.Valid {
		return access.Habits
	}
	switch r.Visibility {
	case visibility.Partners:
		return true
	case visibility.Granted:
		return access.Tasks
	}
	return false
}

// requirePartner answers ErrNotFound for anybody who is not a partner of the viewer,
// so that a stranger cannot tell a user who exists from one who does not.
func (s *Service) requirePartner(ctx context.Context, viewerID, ownerID uuid.UUID) error {
	linked, err := s.store.ArePartners(ctx, store.ArePartnersParams{UserID: viewerID, PartnerID: ownerID})
	if err != nil {
		return fmt.Errorf("check partnership: %w", err)
	}
	if !linked {
		return ErrNotFound
	}
	return nil
}

func checkWindow(from, to time.Time) error {
	if !to.After(from) {
		return &validation.Error{Field: "to", Message: "must be after from"}
	}
	if to.Sub(from) > MaxWindow {
		return &validation.Error{Field: "to", Message: "the range is too long (at most 100 days)"}
	}
	return nil
}

// dedupe drops repeats and the viewer himself, keeping the order.
func dedupe(ids []uuid.UUID, self uuid.UUID) []uuid.UUID {
	var out []uuid.UUID
	for _, id := range ids {
		if id != self && !slices.Contains(out, id) {
			out = append(out, id)
		}
	}
	return out
}

// freeIntervals is [from, to) without the busy intervals, keeping the stretches that
// are at least `minLen` long. Busy intervals may overlap and may lie partly outside.
func freeIntervals(from, to time.Time, busy []Interval, minLen time.Duration) []Interval {
	sorted := slices.Clone(busy)
	slices.SortFunc(sorted, func(a, b Interval) int { return a.Start.Compare(b.Start) })

	var free []Interval
	cursor := from
	add := func(end time.Time) {
		if end.Sub(cursor) >= minLen && end.After(cursor) {
			free = append(free, Interval{Start: cursor, End: end})
		}
	}
	for _, b := range sorted {
		if !b.Start.Before(to) {
			break
		}
		if b.Start.After(cursor) {
			add(b.Start)
		}
		if b.End.After(cursor) {
			cursor = b.End
		}
	}
	if cursor.Before(to) {
		add(to)
	}
	return free
}
