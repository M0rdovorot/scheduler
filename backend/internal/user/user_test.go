package user_test

import (
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

func ptr[T any](v T) *T { return &v }

func TestSettingsPatchValidate(t *testing.T) {
	tests := []struct {
		name      string
		patch     user.SettingsPatch
		wantField string // empty: valid
	}{
		{"empty patch", user.SettingsPatch{}, ""},
		{"all valid", user.SettingsPatch{
			Timezone: ptr("Europe/Moscow"), SlotMinutes: ptr(15),
			DefaultView: ptr("week"), DeviationThresholdMinutes: ptr(0),
		}, ""},
		{"threshold upper bound", user.SettingsPatch{DeviationThresholdMinutes: ptr(1440)}, ""},
		{"empty timezone", user.SettingsPatch{Timezone: ptr("")}, "timezone"},
		{"Local timezone", user.SettingsPatch{Timezone: ptr("Local")}, "timezone"},
		{"unknown timezone", user.SettingsPatch{Timezone: ptr("Mars/Olympus")}, "timezone"},
		{"bad slot", user.SettingsPatch{SlotMinutes: ptr(20)}, "slot_minutes"},
		{"bad view", user.SettingsPatch{DefaultView: ptr("month")}, "default_view"},
		{"negative threshold", user.SettingsPatch{DeviationThresholdMinutes: ptr(-1)}, "deviation_threshold_minutes"},
		{"threshold too large", user.SettingsPatch{DeviationThresholdMinutes: ptr(1441)}, "deviation_threshold_minutes"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.patch.Validate()
			if tt.wantField == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			var verr *validation.Error
			if !errors.As(err, &verr) || verr.Field != tt.wantField {
				t.Fatalf("err = %v, want ValidationError on %q", err, tt.wantField)
			}
		})
	}
}

func TestServiceUpdateSettings(t *testing.T) {
	st := store.NewStore(testutil.NewDB(t, migrations.FS))
	svc := user.NewService(st)
	ctx := context.Background()

	created, err := st.CreateUser(ctx, store.CreateUserParams{DisplayName: "Ann", Timezone: "UTC"})
	if err != nil {
		t.Fatal(err)
	}

	u, err := svc.Get(ctx, created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if u.SlotMinutes != 30 || u.DefaultView != "day" || u.DeviationThresholdMinutes != 10 {
		t.Errorf("defaults = %+v, want slot 30, view day, threshold 10", u)
	}

	u, err = svc.UpdateSettings(ctx, created.ID, user.SettingsPatch{SlotMinutes: ptr(5), Timezone: ptr("Asia/Tokyo")})
	if err != nil {
		t.Fatal(err)
	}
	if u.SlotMinutes != 5 || u.Timezone != "Asia/Tokyo" {
		t.Errorf("changed fields = %+v", u)
	}
	if u.DefaultView != "day" || u.DeviationThresholdMinutes != 10 {
		t.Errorf("omitted fields changed: %+v", u)
	}

	// An invalid field rejects the whole patch.
	_, err = svc.UpdateSettings(ctx, created.ID, user.SettingsPatch{SlotMinutes: ptr(10), DefaultView: ptr("nope")})
	if err == nil {
		t.Fatal("expected validation error")
	}
	if got, _ := svc.Get(ctx, created.ID); got.SlotMinutes != 5 {
		t.Errorf("slot_minutes = %d after rejected patch, want 5", got.SlotMinutes)
	}
}

func TestServiceNotFound(t *testing.T) {
	svc := user.NewService(store.NewStore(testutil.NewDB(t, migrations.FS)))
	ctx := context.Background()

	if _, err := svc.Get(ctx, uuid.New()); !errors.Is(err, user.ErrNotFound) {
		t.Errorf("Get err = %v, want ErrNotFound", err)
	}
	_, err := svc.UpdateSettings(ctx, uuid.New(), user.SettingsPatch{SlotMinutes: ptr(10)})
	if !errors.Is(err, user.ErrNotFound) {
		t.Errorf("UpdateSettings err = %v, want ErrNotFound", err)
	}
}
