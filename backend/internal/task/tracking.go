package task

import (
	"context"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	maxCommentLen = 2000

	// futureTolerance is how far ahead of the server clock a fact may be: devices differ a little.
	futureTolerance = time.Minute
)

// Statuses that a task can be given by hand.
const (
	StatusPlanned     = "planned"
	StatusInProgress  = "in_progress"
	StatusDone        = "done"
	StatusPartial     = "partial"
	StatusNotDone     = "not_done"
	StatusRescheduled = "rescheduled"
)

// notInTheFuture refuses a fact that has not happened yet: a fact is what already took place.
func (s *Service) notInTheFuture(field string, t *time.Time) error {
	if t != nil && t.After(s.now().Add(futureTolerance)) {
		return &validation.Error{Code: CodeFactInFuture, Field: field, Message: "a fact cannot be in the future"}
	}
	return nil
}

func invalidState(message string) error {
	return &validation.Error{Code: CodeInvalidState, Field: "status", Message: message}
}

// lockForTracking locks a task of the user for a change of its status. Cancelled
// tasks (deleted occurrences) are not found. A rescheduled task is history that
// tracking leaves alone, unless allowOrphan is set and the task it was moved to
// has been deleted: then nothing is left of the move, and the mark can be removed.
func lockForTracking(ctx context.Context, q *store.Queries, userID, id uuid.UUID, allowOrphan bool) (store.TaskInstance, error) {
	cur, err := q.LockInstance(ctx, store.LockInstanceParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return store.TaskInstance{}, ErrNotFound
	}
	if err != nil {
		return store.TaskInstance{}, fmt.Errorf("lock instance: %w", err)
	}
	if cur.Status == StatusRescheduled {
		if !allowOrphan {
			return store.TaskInstance{}, invalidState("the task was rescheduled; its status can no longer be changed")
		}
		has, err := q.HasLiveReplacement(ctx, store.HasLiveReplacementParams{ID: uuid.NullUUID{UUID: cur.ID, Valid: true}, UserID: userID})
		if err != nil {
			return store.TaskInstance{}, fmt.Errorf("check replacement: %w", err)
		}
		if has {
			return store.TaskInstance{}, invalidState("the task was rescheduled; change the new task instead")
		}
	}
	return cur, nil
}

func (s *Service) inTracking(ctx context.Context, userID, id uuid.UUID, allowOrphan bool, fn func(q *store.Queries, cur store.TaskInstance) error) (Instance, error) {
	var out Instance
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		cur, err := lockForTracking(ctx, q, userID, id, allowOrphan)
		if err != nil {
			return err
		}
		if err := fn(q, cur); err != nil {
			return err
		}
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

func set(ctx context.Context, q *store.Queries, userID uuid.UUID, cur store.TaskInstance, status string, start, end *time.Time, comment string) error {
	err := q.SetTracking(ctx, store.SetTrackingParams{
		ID: cur.ID, UserID: userID, Status: status, ActualStart: start, ActualEnd: end, Comment: comment,
	})
	if err != nil {
		return fmt.Errorf("set tracking: %w", err)
	}
	// A done occurrence of a habit credits its day; one that is no longer done takes it back.
	if cur.SeriesID.Valid {
		if status == StatusDone {
			err = q.CreditHabitDay(ctx, store.CreditHabitDayParams{InstanceID: cur.ID, UserID: userID})
		} else {
			err = q.RevokeHabitCredit(ctx, store.RevokeHabitCreditParams{InstanceID: uuid.NullUUID{UUID: cur.ID, Valid: true}, UserID: userID})
		}
		if err != nil {
			return fmt.Errorf("update habit credit: %w", err)
		}
	}
	return nil
}

// Complete is "Done" in one tap: the fact becomes equal to the plan (FR-5.3). On a
// task that is already done or partial it changes nothing.
func (s *Service) Complete(ctx context.Context, userID, id uuid.UUID) (Instance, error) {
	return s.inTracking(ctx, userID, id, false, func(q *store.Queries, cur store.TaskInstance) error {
		if cur.PlannedStart == nil || cur.PlannedEnd == nil {
			return invalidState("a task outside the plan has no plan to take the fact from")
		}
		// Already marked: a second tap (or a stale tab) must not replace a fact that was edited.
		if cur.Status == StatusDone || cur.Status == StatusPartial {
			return nil
		}
		return set(ctx, q, userID, cur, StatusDone, cur.PlannedStart, cur.PlannedEnd, cur.Comment)
	})
}

// Start starts a timer: the fact begins now. Several tasks may run at once.
func (s *Service) Start(ctx context.Context, userID, id uuid.UUID) (Instance, error) {
	now := s.now()
	return s.inTracking(ctx, userID, id, false, func(q *store.Queries, cur store.TaskInstance) error {
		if cur.Status != StatusPlanned && cur.Status != StatusNotDone {
			return invalidState("only a planned task can be started")
		}
		return set(ctx, q, userID, cur, StatusInProgress, &now, nil, cur.Comment)
	})
}

// Stop ends the timer: the fact ends now and the task is done; the status can
// be changed to partial afterwards.
func (s *Service) Stop(ctx context.Context, userID, id uuid.UUID) (Instance, error) {
	now := s.now()
	return s.inTracking(ctx, userID, id, false, func(q *store.Queries, cur store.TaskInstance) error {
		if cur.Status != StatusInProgress || cur.ActualStart == nil {
			return invalidState("the task is not running")
		}
		// With the clock behind the start the fact still gets a length, a second.
		end := now
		if !end.After(*cur.ActualStart) {
			end = cur.ActualStart.Add(time.Second)
		}
		return set(ctx, q, userID, cur, StatusDone, cur.ActualStart, &end, cur.Comment)
	})
}

// TrackingInput holds what to change; nil fields are left as is. A status of
// planned or not_done clears the fact. With no status, a given fact decides it:
// a start without an end is in progress, both is done (or stays partial).
type TrackingInput struct {
	Status      *string
	ActualStart *time.Time
	ActualEnd   *time.Time
	Comment     *string
}

// EditTracking is the manual edit of the status, the fact and the comment
// (FR-5.3, FR-5.6). Setting the status back to planned removes the mark.
func (s *Service) EditTracking(ctx context.Context, userID, id uuid.UUID, in TrackingInput) (Instance, error) {
	return s.inTracking(ctx, userID, id, true, func(q *store.Queries, cur store.TaskInstance) error {
		comment := cur.Comment
		if in.Comment != nil {
			if !validation.ValidText(*in.Comment) {
				return &validation.Error{Field: "comment", Message: "contains invalid characters"}
			}
			if utf8.RuneCountInString(*in.Comment) > maxCommentLen {
				return &validation.Error{Field: "comment", Message: fmt.Sprintf("must be at most %d characters", maxCommentLen)}
			}
			comment = *in.Comment
		}

		if err := s.notInTheFuture("actual_start", in.ActualStart); err != nil {
			return err
		}
		if err := s.notInTheFuture("actual_end", in.ActualEnd); err != nil {
			return err
		}
		status, start, end, err := nextTracking(cur, in)
		if err != nil {
			return err
		}
		return set(ctx, q, userID, cur, status, start, end, comment)
	})
}

// nextTracking works out the status and the fact that an edit leads to.
func nextTracking(cur store.TaskInstance, in TrackingInput) (status string, start, end *time.Time, err error) {
	hasFactInput := in.ActualStart != nil || in.ActualEnd != nil
	if cur.Status == StatusRescheduled {
		// Only reachable when the task it was moved to is gone: the mark may be removed.
		if hasFactInput || (in.Status != nil && *in.Status != StatusPlanned) {
			return "", nil, nil, invalidState("a rescheduled task can only go back to planned")
		}
	}
	if in.Status != nil {
		switch *in.Status {
		case StatusPlanned, StatusInProgress, StatusDone, StatusPartial, StatusNotDone:
		default:
			return "", nil, nil, &validation.Error{Field: "status", Message: "must be planned, in_progress, done, partial or not_done"}
		}
	}

	start, end = cur.ActualStart, cur.ActualEnd
	if in.ActualStart != nil {
		start = in.ActualStart
	}
	if in.ActualEnd != nil {
		end = in.ActualEnd
	}

	status = cur.Status
	switch {
	case in.Status != nil:
		status = *in.Status
	case hasFactInput:
		status = StatusDone
		if end == nil {
			status = StatusInProgress
		} else if cur.Status == StatusPartial {
			status = StatusPartial
		}
	default:
		// Only a comment changes.
		return status, cur.ActualStart, cur.ActualEnd, nil
	}

	switch status {
	case StatusPlanned, StatusNotDone:
		if hasFactInput {
			return "", nil, nil, &validation.Error{Field: "actual_start", Message: "a task that is " + status + " has no fact"}
		}
		if cur.PlannedStart == nil {
			// Without a plan the fact is all that is left of the task.
			return "", nil, nil, invalidState("a task outside the plan keeps its fact; delete it instead")
		}
		return status, nil, nil, nil
	case StatusInProgress:
		if start == nil {
			return "", nil, nil, &validation.Error{Field: "actual_start", Message: "a running task needs a start"}
		}
		if in.ActualEnd != nil {
			return "", nil, nil, &validation.Error{Field: "actual_end", Message: "a running task has no end yet"}
		}
		return status, start, nil, nil
	default: // done, partial
		if start == nil && end == nil && cur.PlannedStart != nil {
			// Marking a planned task as done with no times: the fact equals the plan.
			start, end = cur.PlannedStart, cur.PlannedEnd
		}
		if start == nil || end == nil {
			return "", nil, nil, &validation.Error{Field: "actual_end", Message: "a finished task needs a start and an end"}
		}
		if !end.After(*start) {
			return "", nil, nil, &validation.Error{Field: "actual_end", Message: "must be after actual_start"}
		}
		return status, start, end, nil
	}
}

// Reschedule moves a task to a new time the way FR-5.4 says: the original gets
// the status "rescheduled" and the reason, and a new one-off task is created at
// the new time with the same title, description and categories, linked to it.
// It returns the new task.
func (s *Service) Reschedule(ctx context.Context, userID, id uuid.UUID, start, end time.Time, comment string) (Instance, error) {
	if err := validateRange(start, end); err != nil {
		return Instance{}, err
	}
	if !validation.ValidText(comment) || utf8.RuneCountInString(comment) > maxCommentLen {
		return Instance{}, &validation.Error{Field: "comment", Message: fmt.Sprintf("must be valid text of at most %d characters", maxCommentLen)}
	}

	var out Instance
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		cur, err := lockForTracking(ctx, q, userID, id, false)
		if err != nil {
			return err
		}
		if cur.Status != StatusPlanned && cur.Status != StatusNotDone {
			return invalidState("only a planned or not done task can be rescheduled")
		}
		if cur.PlannedStart == nil {
			return invalidState("a task outside the plan cannot be rescheduled")
		}

		newID, err := q.CreateRescheduledInstance(ctx, store.CreateRescheduledInstanceParams{
			UserID: userID, Title: cur.Title, Description: cur.Description,
			PlannedStart: &start, PlannedEnd: &end,
			RescheduledFromID: uuid.NullUUID{UUID: cur.ID, Valid: true},
		})
		if err != nil {
			return fmt.Errorf("create rescheduled instance: %w", err)
		}
		if err := q.CopyInstanceCategories(ctx, store.CopyInstanceCategoriesParams{ToID: newID, FromID: cur.ID, UserID: userID}); err != nil {
			return fmt.Errorf("copy categories: %w", err)
		}
		reason := comment
		if reason == "" {
			reason = cur.Comment
		}
		if err := set(ctx, q, userID, cur, StatusRescheduled, nil, nil, reason); err != nil {
			return err
		}
		out, err = get(ctx, q, userID, newID)
		return err
	})
	return out, err
}

// UnplannedInput describes a task that was never planned (FR-5.7).
type UnplannedInput struct {
	Title       string
	Description string
	CategoryIDs []uuid.UUID
	// ActualStart defaults to now. With no ActualEnd the timer is running.
	ActualStart *time.Time
	ActualEnd   *time.Time
}

// CreateUnplanned adds a task outside the plan: back-dated with its fact, or
// with a timer started now.
func (s *Service) CreateUnplanned(ctx context.Context, userID uuid.UUID, in UnplannedInput) (Instance, error) {
	title, err := normalizeTitle(in.Title)
	if err != nil {
		return Instance{}, err
	}
	if err := validateDescription(in.Description); err != nil {
		return Instance{}, err
	}
	categoryIDs, err := normalizeCategoryIDs(in.CategoryIDs)
	if err != nil {
		return Instance{}, err
	}

	if err := s.notInTheFuture("actual_start", in.ActualStart); err != nil {
		return Instance{}, err
	}
	if err := s.notInTheFuture("actual_end", in.ActualEnd); err != nil {
		return Instance{}, err
	}
	start := s.now()
	if in.ActualStart != nil {
		start = *in.ActualStart
	}
	status := StatusInProgress
	if in.ActualEnd != nil {
		status = StatusDone
		if !in.ActualEnd.After(start) {
			return Instance{}, &validation.Error{Field: "actual_end", Message: "must be after actual_start"}
		}
	}

	var out Instance
	err = s.store.InTx(ctx, func(q *store.Queries) error {
		id, err := q.CreateUnplannedInstance(ctx, store.CreateUnplannedInstanceParams{
			UserID: userID, Title: title, Description: in.Description, Status: status,
			ActualStart: &start, ActualEnd: in.ActualEnd,
		})
		if err != nil {
			return fmt.Errorf("create unplanned instance: %w", err)
		}
		if err := setCategories(ctx, q, userID, id, categoryIDs); err != nil {
			return err
		}
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}
