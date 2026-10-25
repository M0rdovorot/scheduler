package task_test

import (
	"context"
	"errors"
	"testing"

	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

func visibilities(list []task.Instance) []string {
	out := make([]string, len(list))
	for i, in := range list {
		out[i] = in.Visibility
	}
	return out
}

func (e *env) setDefaultVisibility(v string) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), `UPDATE users SET default_visibility = $1`, v); err != nil {
		e.t.Fatal(err)
	}
}

func TestNewTasksAreVisibleAsTheUserSetting(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	mk := func(v *string) task.Instance {
		in, err := e.svc.Create(ctx, e.user, task.CreateInput{
			Title: "t", PlannedStart: msk(t, 2026, 10, 14, 9, 0), PlannedEnd: msk(t, 2026, 10, 14, 10, 0), Visibility: v,
		})
		if err != nil {
			t.Fatal(err)
		}
		return in
	}
	if got := mk(nil).Visibility; got != "private" {
		t.Errorf("initial default = %q, want private", got)
	}
	e.setDefaultVisibility("partners")
	if got := mk(nil).Visibility; got != "partners" {
		t.Errorf("after the setting changed = %q, want partners", got)
	}
	if got := mk(ptr("granted")).Visibility; got != "granted" {
		t.Errorf("explicit = %q, want granted", got)
	}

	_, err := e.svc.Create(ctx, e.user, task.CreateInput{
		Title: "t", PlannedStart: at(9, 0), PlannedEnd: at(10, 0), Visibility: ptr("everyone"),
	})
	var verr *validation.Error
	if !errors.As(err, &verr) {
		t.Errorf("bad value: %v, want a validation error", err)
	}
}

func TestOccurrencesTakeTheVisibilityOfTheSeries(t *testing.T) {
	e := newSeriesEnv(t)
	e.setDefaultVisibility("granted")
	e.createSeries("FREQ=DAILY")
	list := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0))
	equal(t, visibilities(list), []string{"granted", "granted", "granted"})
}

func TestVisibilityOfOneOccurrenceIsItsOwnEdit(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	list := e.list(from, to)

	if _, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeThis, task.UpdateInput{Visibility: ptr("partners")}); err != nil {
		t.Fatal(err)
	}
	equal(t, visibilities(e.list(from, to)), []string{"private", "partners", "private"})
	// Like any edit of one occurrence it sets the occurrence apart from the series,
	// so that a later rewrite of the series cannot lose the value.
	if n := e.rowCount("is_detached"); n != 1 {
		t.Errorf("%d detached rows, want 1", n)
	}
	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Title: ptr("Общая")}); err != nil {
		t.Fatal(err)
	}
	equal(t, visibilities(e.list(from, to)), []string{"private", "partners", "private"})
}

func TestVisibilityOfTheWholeSeriesKeepsTheOccurrences(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	list := e.list(from, to)

	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Visibility: ptr("partners")}); err != nil {
		t.Fatal(err)
	}
	after := e.list(from, to)
	equal(t, visibilities(after), []string{"partners", "partners", "partners"})
	for i := range list {
		if after[i].ID != list[i].ID {
			t.Errorf("occurrence %d was re-created", i)
		}
	}

	// The same for the following occurrences: the split moves the rows, it does not re-create them.
	if _, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeFollowing, task.UpdateInput{Visibility: ptr("granted")}); err != nil {
		t.Fatal(err)
	}
	after = e.list(from, to)
	equal(t, visibilities(after), []string{"partners", "granted", "granted"})
	for i := range list {
		if after[i].ID != list[i].ID {
			t.Errorf("occurrence %d was re-created by the split", i)
		}
	}
}

func TestVisibilityOfTheWholeSeriesOverridesOccurrences(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)
	list := e.list(from, to)
	if _, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeThis, task.UpdateInput{Visibility: ptr("partners")}); err != nil {
		t.Fatal(err)
	}

	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Visibility: ptr("granted")}); err != nil {
		t.Fatal(err)
	}
	equal(t, visibilities(e.list(from, to)), []string{"granted", "granted", "granted", "granted"})
}

func TestVisibilityOfFollowingOccurrencesSplitsTheSeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 20, 0, 0)
	list := e.list(from, to) // 14..19
	if _, err := e.svc.Update(ctx, e.user, list[4].ID, task.ScopeThis, task.UpdateInput{Visibility: ptr("granted")}); err != nil {
		t.Fatal(err)
	}

	if _, err := e.svc.Update(ctx, e.user, list[2].ID, task.ScopeFollowing, task.UpdateInput{Visibility: ptr("partners")}); err != nil {
		t.Fatal(err)
	}
	equal(t, visibilities(e.list(from, to)), []string{"private", "private", "partners", "partners", "partners", "partners"})
	// Later occurrences, made from the new series, are visible the same way.
	far := e.list(msk(t, 2027, 1, 1, 0, 0), msk(t, 2027, 1, 2, 0, 0))
	equal(t, visibilities(far), []string{"partners"})
}

func TestSplitKeepsTheVisibilityWhenItIsNotChanged(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.setDefaultVisibility("partners")
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)
	list := e.list(from, to)

	if _, err := e.svc.Update(ctx, e.user, list[2].ID, task.ScopeFollowing, task.UpdateInput{Title: ptr("Новая")}); err != nil {
		t.Fatal(err)
	}
	equal(t, visibilities(e.list(from, to)), []string{"partners", "partners", "partners", "partners"})
}

func TestRescheduledTaskIsAsVisibleAsTheOriginal(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	list := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 15, 0, 0))
	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Visibility: ptr("granted")}); err != nil {
		t.Fatal(err)
	}
	e.setDefaultVisibility("partners") // the setting at the time of the move does not matter
	list = e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 15, 0, 0))

	moved, err := e.svc.Reschedule(ctx, e.user, list[0].ID, msk(t, 2026, 10, 14, 15, 0), msk(t, 2026, 10, 14, 16, 0), "")
	if err != nil {
		t.Fatal(err)
	}
	if moved.Visibility != "granted" {
		t.Errorf("visibility of the new task = %q, want granted", moved.Visibility)
	}
}

func TestUnplannedTaskTakesTheUserDefault(t *testing.T) {
	e := newEnv(t)
	e.setDefaultVisibility("partners")
	in, err := e.svc.CreateUnplanned(context.Background(), e.user, task.UnplannedInput{
		Title: "Дело вне плана", // a running timer: the fact starts now
	})
	if err != nil {
		t.Fatal(err)
	}
	if in.Visibility != "partners" {
		t.Errorf("visibility = %q, want partners", in.Visibility)
	}
}
