package stats

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

// MaxPeriod is the longest period of a report.
const MaxPeriod = 366 * 24 * time.Hour

type Service struct {
	tasks      *task.Service
	categories *category.Service
	users      *user.Service
}

func NewService(tasks *task.Service, categories *category.Service, users *user.Service) *Service {
	return &Service{tasks: tasks, categories: categories, users: users}
}

// Report builds the statistics of [from, to) for the user. The occurrences of regular
// tasks in the period are created first, so that planned tasks that never had their
// window opened are counted too.
func (s *Service) Report(ctx context.Context, userID uuid.UUID, from, to time.Time) (Report, error) {
	if !to.After(from) {
		return Report{}, &validation.Error{Field: "to", Message: "must be after from"}
	}
	if to.Sub(from) > MaxPeriod {
		return Report{}, &validation.Error{Field: "to", Message: "the period is too long (at most 366 days)"}
	}

	u, err := s.users.Get(ctx, userID)
	if err != nil {
		return Report{}, fmt.Errorf("get user: %w", err)
	}
	loc, err := time.LoadLocation(u.Timezone)
	if err != nil {
		return Report{}, fmt.Errorf("user %s has an unknown time zone %q: %w", userID, u.Timezone, err)
	}
	instances, err := s.tasks.ListUnbounded(ctx, userID, from, to)
	if err != nil {
		return Report{}, err
	}
	cats, err := s.categories.List(ctx, userID)
	if err != nil {
		return Report{}, err
	}
	return Compute(Input{Instances: instances, Categories: cats, From: from, To: to, Now: s.tasks.Now(), Loc: loc}), nil
}
