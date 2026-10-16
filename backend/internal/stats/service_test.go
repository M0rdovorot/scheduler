package stats_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/stats"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

var msk, _ = time.LoadLocation("Europe/Moscow")

func at(day, h, m int) time.Time { return time.Date(2026, 10, day, h, m, 0, 0, msk) }
func ptr[T any](v T) *T          { return &v }

type env struct {
	t     *testing.T
	stats *stats.Service
	tasks *task.Service
	cats  *category.Service
	user  uuid.UUID
	other uuid.UUID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := testutil.NewDB(t, migrations.FS)
	st := store.NewStore(pool)
	mk := func(name string) uuid.UUID {
		u, err := st.CreateUser(context.Background(), store.CreateUserParams{DisplayName: name, Timezone: "Europe/Moscow"})
		if err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	users, cats, tasks := user.NewService(st), category.NewService(st), task.NewService(st)
	e := &env{t: t, stats: stats.NewService(tasks, cats, users), tasks: tasks, cats: cats, user: mk("a"), other: mk("b")}
	clock := func() time.Time { return at(14, 12, 0) }
	e.stats.SetClock(clock)
	tasks.SetClock(clock)
	return e
}

func (e *env) category(name string, parent *uuid.UUID) uuid.UUID {
	e.t.Helper()
	c, err := e.cats.Create(context.Background(), e.user, category.CreateInput{Name: name, Color: "#aabbcc", ParentID: parent})
	if err != nil {
		e.t.Fatal(err)
	}
	return c.ID
}

func (e *env) report(from, to time.Time) stats.Report {
	e.t.Helper()
	r, err := e.stats.Report(context.Background(), e.user, from, to)
	if err != nil {
		e.t.Fatal(err)
	}
	return r
}

func TestReportOverRealData(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	sport := e.category("Спорт", nil)
	run := e.category("Бег", &sport)
	swim := e.category("Плавание", &sport)

	// A task of 1 h in Бег and Плавание, done 20 minutes late for an hour and ten.
	a, err := e.tasks.Create(ctx, e.user, task.CreateInput{
		Title: "Тренировка", PlannedStart: at(14, 9, 0), PlannedEnd: at(14, 10, 0), CategoryIDs: []uuid.UUID{run, swim},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.tasks.EditTracking(ctx, e.user, a.ID, task.TrackingInput{
		ActualStart: ptr(at(14, 9, 20)), ActualEnd: ptr(at(14, 10, 30)), Comment: ptr("пробки"),
	}); err != nil {
		t.Fatal(err)
	}
	// Planned and forgotten.
	if _, err := e.tasks.Create(ctx, e.user, task.CreateInput{Title: "Забыл", PlannedStart: at(14, 7, 0), PlannedEnd: at(14, 8, 0)}); err != nil {
		t.Fatal(err)
	}
	// Moved: the original leaves the plan, the new task enters it.
	moved, err := e.tasks.Create(ctx, e.user, task.CreateInput{Title: "Планёрка", PlannedStart: at(14, 11, 0), PlannedEnd: at(14, 11, 30)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := e.tasks.Reschedule(ctx, e.user, moved.ID, at(14, 15, 0), at(14, 16, 0), "совещание"); err != nil {
		t.Fatal(err)
	}
	// Outside the plan.
	if _, err := e.tasks.CreateUnplanned(ctx, e.user, task.UnplannedInput{
		Title: "Звонок", ActualStart: ptr(at(14, 8, 0)), ActualEnd: ptr(at(14, 8, 15)),
	}); err != nil {
		t.Fatal(err)
	}

	r := e.report(at(14, 0, 0), at(15, 0, 0))

	// Fact: 70 min of the workout + 15 min call.
	if r.ActualMinutes != 85 {
		t.Errorf("actual = %d, want 85", r.ActualMinutes)
	}
	// Plan: 60 (workout) + 60 (forgotten) + 60 (the new task); the rescheduled original (30) is out.
	if r.PlannedMinutes != 180 {
		t.Errorf("planned = %d, want 180", r.PlannedMinutes)
	}
	if r.UnplannedMinutes != 15 || r.UnplannedCount != 1 {
		t.Errorf("unplanned = %d min, %d tasks", r.UnplannedMinutes, r.UnplannedCount)
	}
	byCat := map[uuid.UUID]int{}
	for _, c := range r.Categories {
		byCat[c.CategoryID] = c.Minutes
	}
	if byCat[run] != 70 || byCat[swim] != 70 || byCat[sport] != 70 {
		t.Errorf("categories = %v (Спорт must count the task once)", byCat)
	}
	if r.UncategorizedMinutes != 15 {
		t.Errorf("uncategorized = %d", r.UncategorizedMinutes)
	}

	pf := r.PlanVsFact
	if pf.PlannedCount != 3 || pf.Done != 1 || pf.Unmarked != 1 || pf.Upcoming != 1 || pf.Rescheduled != 1 {
		t.Errorf("plan vs fact = %+v", pf)
	}
	if pf.LateStarts != 1 || pf.Overran != 1 {
		t.Errorf("late = %d, overran = %d", pf.LateStarts, pf.Overran)
	}
	// Deviations: the workout (20 and 20 minutes over the threshold of 10) and the rescheduled one with its reason.
	if len(r.Deviations) != 2 {
		t.Fatalf("deviations = %d: %+v", len(r.Deviations), r.Deviations)
	}
	if r.Deviations[0].Instance.Comment != "пробки" && r.Deviations[1].Instance.Comment != "пробки" {
		t.Errorf("the comment of the workout is missing")
	}
}

func TestReportMaterializesTheSeriesOfThePeriod(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	// A daily series: nobody has opened a calendar window yet, so no rows exist beyond the first.
	if _, err := e.tasks.Create(ctx, e.user, task.CreateInput{
		Title: "Зарядка", PlannedStart: at(14, 8, 0), PlannedEnd: at(14, 8, 30), Recurrence: ptr("FREQ=DAILY"),
	}); err != nil {
		t.Fatal(err)
	}

	r := e.report(at(14, 0, 0), at(21, 0, 0)) // a week
	// 7 planned occurrences; those whose time is over and nobody marked are "unmarked", the rest upcoming.
	if r.PlanVsFact.PlannedCount != 7 {
		t.Errorf("planned count = %d, want 7 (the series of the period)", r.PlanVsFact.PlannedCount)
	}
	if r.PlannedMinutes != 7*30 {
		t.Errorf("planned = %d", r.PlannedMinutes)
	}
	if r.PlanVsFact.Unmarked != 1 || r.PlanVsFact.Upcoming != 6 { // the 14th 08:00 is past (now 12:00)
		t.Errorf("unmarked = %d, upcoming = %d", r.PlanVsFact.Unmarked, r.PlanVsFact.Upcoming)
	}
	if len(r.Days) != 7 {
		t.Errorf("%d days", len(r.Days))
	}
}

func TestRunningTimerInTheReport(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.tasks.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: "Идёт", ActualStart: ptr(at(14, 11, 0))}); err != nil {
		t.Fatal(err)
	}
	if r := e.report(at(14, 0, 0), at(15, 0, 0)); r.ActualMinutes != 60 || r.LongRunning != 0 {
		t.Errorf("actual = %d, long running = %d", r.ActualMinutes, r.LongRunning)
	}

	// Ten hours later the timer is still running: the cap of 12 hours has not been reached yet,
	// two days later it has.
	e.stats.SetClock(func() time.Time { return at(16, 12, 0) })
	r := e.report(at(14, 0, 0), at(17, 0, 0))
	if r.ActualMinutes != 12*60 || r.LongRunning != 1 {
		t.Errorf("actual = %d, long running = %d, want 720 and 1", r.ActualMinutes, r.LongRunning)
	}
}

func TestReportValidationAndIsolation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if _, err := e.tasks.CreateUnplanned(ctx, e.user, task.UnplannedInput{
		Title: "Моё", ActualStart: ptr(at(14, 8, 0)), ActualEnd: ptr(at(14, 9, 0)),
	}); err != nil {
		t.Fatal(err)
	}

	for name, rng := range map[string][2]time.Time{
		"empty":    {at(14, 0, 0), at(14, 0, 0)},
		"backward": {at(15, 0, 0), at(14, 0, 0)},
		"too long": {at(14, 0, 0), at(14, 0, 0).Add(stats.MaxPeriod + time.Second)},
	} {
		_, err := e.stats.Report(ctx, e.user, rng[0], rng[1])
		var verr *validation.Error
		if !errors.As(err, &verr) || verr.Field != "to" {
			t.Errorf("%s: err = %v, want a validation error on \"to\"", name, err)
		}
	}
	if _, err := e.stats.Report(ctx, e.user, at(14, 0, 0), at(14, 0, 0).Add(stats.MaxPeriod)); err != nil {
		t.Errorf("a period of 366 days: %v", err)
	}

	r, err := e.stats.Report(ctx, e.other, at(14, 0, 0), at(15, 0, 0))
	if err != nil {
		t.Fatal(err)
	}
	if r.ActualMinutes != 0 || len(r.Tasks) != 0 {
		t.Errorf("another user's data leaked into the report: %+v", r)
	}
}
