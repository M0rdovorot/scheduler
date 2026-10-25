// Package user holds the user profile and settings.
package user

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/internal/visibility"
)

const (
	ViewDay       = "day"
	ViewThreeDays = "three_days"
	ViewWeek      = "week"

	// MaxDeviationThresholdMinutes is a sanity cap: one day.
	MaxDeviationThresholdMinutes = 24 * 60
)

var (
	ErrNotFound = errors.New("user not found")

	SlotMinutesOptions = []int{5, 10, 15, 30, 60}
	ViewOptions        = []string{ViewDay, ViewThreeDays, ViewWeek}
)

type User struct {
	ID                        uuid.UUID
	DisplayName               string
	Timezone                  string
	SlotMinutes               int
	DefaultView               string
	DeviationThresholdMinutes int
	// DefaultVisibility is the visibility of new tasks.
	DefaultVisibility string
}

func FromRow(r store.User) User {
	return User{
		ID:                        r.ID,
		DisplayName:               r.DisplayName,
		Timezone:                  r.Timezone,
		SlotMinutes:               int(r.SlotMinutes),
		DefaultView:               r.DefaultView,
		DeviationThresholdMinutes: int(r.DeviationThresholdMinutes),
		DefaultVisibility:         r.DefaultVisibility,
	}
}

// SettingsPatch holds the settings to change; nil fields are left as is.
type SettingsPatch struct {
	Timezone                  *string
	SlotMinutes               *int
	DefaultView               *string
	DeviationThresholdMinutes *int
	DefaultVisibility         *string
}

// ValidateTimezone accepts only IANA zone names that the runtime knows.
func ValidateTimezone(name string) error {
	if name == "" || name == "Local" {
		return &validation.Error{Field: "timezone", Message: "must be an IANA time zone name"}
	}
	if _, err := time.LoadLocation(name); err != nil {
		return &validation.Error{Field: "timezone", Message: "unknown time zone"}
	}
	return nil
}

func (p SettingsPatch) Validate() error {
	if p.Timezone != nil {
		if err := ValidateTimezone(*p.Timezone); err != nil {
			return err
		}
	}
	if p.SlotMinutes != nil && !slices.Contains(SlotMinutesOptions, *p.SlotMinutes) {
		return &validation.Error{Field: "slot_minutes", Message: "must be one of 5, 10, 15, 30, 60"}
	}
	if p.DefaultView != nil && !slices.Contains(ViewOptions, *p.DefaultView) {
		return &validation.Error{Field: "default_view", Message: "must be one of day, three_days, week"}
	}
	if t := p.DeviationThresholdMinutes; t != nil && (*t < 0 || *t > MaxDeviationThresholdMinutes) {
		return &validation.Error{
			Field:   "deviation_threshold_minutes",
			Message: fmt.Sprintf("must be between 0 and %d", MaxDeviationThresholdMinutes),
		}
	}
	if p.DefaultVisibility != nil {
		if err := visibility.Validate("default_visibility", *p.DefaultVisibility); err != nil {
			return err
		}
	}
	return nil
}

type Service struct {
	store *store.Store
}

func NewService(s *store.Store) *Service {
	return &Service{store: s}
}

func (s *Service) Get(ctx context.Context, id uuid.UUID) (User, error) {
	row, err := s.store.GetUser(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("get user: %w", err)
	}
	return FromRow(row), nil
}

func (s *Service) UpdateSettings(ctx context.Context, id uuid.UUID, patch SettingsPatch) (User, error) {
	if err := patch.Validate(); err != nil {
		return User{}, err
	}
	params := store.UpdateUserSettingsParams{
		ID:                id,
		Timezone:          patch.Timezone,
		DefaultView:       patch.DefaultView,
		DefaultVisibility: patch.DefaultVisibility,
	}
	if patch.SlotMinutes != nil {
		v := int32(*patch.SlotMinutes)
		params.SlotMinutes = &v
	}
	if patch.DeviationThresholdMinutes != nil {
		v := int32(*patch.DeviationThresholdMinutes)
		params.DeviationThresholdMinutes = &v
	}

	row, err := s.store.UpdateUserSettings(ctx, params)
	if errors.Is(err, pgx.ErrNoRows) {
		return User{}, ErrNotFound
	}
	if err != nil {
		return User{}, fmt.Errorf("update user settings: %w", err)
	}
	return FromRow(row), nil
}
