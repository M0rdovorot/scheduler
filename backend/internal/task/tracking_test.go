package task_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

// trackEnv is an env with a fixed clock: Wednesday 2026-10-14, 12:00 in Moscow.
func newTrackEnv(t *testing.T) *env {
	t.Helper()
	e := newSeriesEnv(t)
	e.svc.SetClock(func() time.Time { return msk(t, 2026, 10, 14, 12, 0) })
	return e
}

// planned creates a one-off task 10:00-11:00 on the 14th.
func (e *env) planned(title string, cats ...uuid.UUID) task.Instance {
	e.t.Helper()
	return e.create(title, msk(e.t, 2026, 10, 14, 10, 0), msk(e.t, 2026, 10, 14, 11, 0), cats...)
}

func wantState(t *testing.T, err error, code string) {
	t.Helper()
	var verr *validation.Error
	if !errors.As(err, &verr) || verr.ErrorCode() != code {
		t.Fatalf("err = %v, want a validation error with code %q", err, code)
	}
}

func same(t *testing.T, got *time.Time, want time.Time, what string) {
	t.Helper()
	if got == nil || !got.Equal(want) {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func TestCompleteTakesTheFactFromThePlan(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	in := e.planned("Спорт")

	done, err := e.svc.Complete(ctx, e.user, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	if done.Status != "done" || len(done.Deviations) != 0 {
		t.Errorf("done = %+v", done)
	}
	same(t, done.ActualStart, msk(t, 2026, 10, 14, 10, 0), "actual start")
	same(t, done.ActualEnd, msk(t, 2026, 10, 14, 11, 0), "actual end")

	// Tapping again changes nothing.
	again, err := e.svc.Complete(ctx, e.user, in.ID)
	if err != nil || again.Status != "done" {
		t.Errorf("second Complete = %+v, %v", again, err)
	}
}

func TestCompleteIsRefusedWhereThereIsNoPlanOrItWasRescheduled(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()

	unplanned, err := e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: "Нежданное"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.Complete(ctx, e.user, unplanned.ID)
	wantState(t, err, task.CodeInvalidState)

	src := e.planned("Перенесу")
	if _, err := e.svc.Reschedule(ctx, e.user, src.ID, msk(t, 2026, 10, 15, 10, 0), msk(t, 2026, 10, 15, 11, 0), ""); err != nil {
		t.Fatal(err)
	}
	_, err = e.svc.Complete(ctx, e.user, src.ID)
	wantState(t, err, task.CodeInvalidState)
}

func TestTimersStartAndStopAndSeveralRunAtOnce(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	a, b := e.planned("Первое"), e.planned("Второе")

	started, err := e.svc.Start(ctx, e.user, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != "in_progress" || started.ActualEnd != nil {
		t.Errorf("started = %+v", started)
	}
	same(t, started.ActualStart, msk(t, 2026, 10, 14, 12, 0), "actual start")
	// Started two hours after the plan: late by 120 minutes (the running task has only its start compared).
	if len(started.Deviations) != 1 || started.Deviations[0].Kind != task.StartedLate || started.Deviations[0].Minutes != 120 {
		t.Errorf("deviations = %+v", started.Deviations)
	}

	// A second timer runs at the same time (FR-5.3).
	if _, err := e.svc.Start(ctx, e.user, b.ID); err != nil {
		t.Fatalf("second timer: %v", err)
	}
	if n := e.rowCount("status = 'in_progress'"); n != 2 {
		t.Errorf("%d running timers, want 2", n)
	}

	// Starting a running task is refused.
	_, err = e.svc.Start(ctx, e.user, a.ID)
	wantState(t, err, task.CodeInvalidState)

	e.svc.SetClock(func() time.Time { return msk(t, 2026, 10, 14, 12, 45) })
	stopped, err := e.svc.Stop(ctx, e.user, a.ID)
	if err != nil {
		t.Fatal(err)
	}
	if stopped.Status != "done" {
		t.Errorf("stopped = %+v", stopped)
	}
	same(t, stopped.ActualEnd, msk(t, 2026, 10, 14, 12, 45), "actual end")

	// A task that is not running cannot be stopped.
	_, err = e.svc.Stop(ctx, e.user, a.ID)
	wantState(t, err, task.CodeInvalidState)
	c := e.planned("Третье")
	_, err = e.svc.Stop(ctx, e.user, c.ID)
	wantState(t, err, task.CodeInvalidState)

	// A finished task cannot be started again without removing the mark first.
	_, err = e.svc.Start(ctx, e.user, a.ID)
	wantState(t, err, task.CodeInvalidState)
}

func TestStopNeverEndsBeforeTheStart(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	in := e.planned("Спорт")
	if _, err := e.svc.Start(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	// The clock goes back (a correction of the device clock): the end is clamped to the start.
	e.svc.SetClock(func() time.Time { return msk(t, 2026, 10, 14, 11, 0) })
	stopped, err := e.svc.Stop(ctx, e.user, in.ID)
	if err != nil {
		t.Fatal(err)
	}
	same(t, stopped.ActualEnd, msk(t, 2026, 10, 14, 12, 0), "actual end")
}

func TestTwoStartsAtOnceStartOnce(t *testing.T) {
	e := newTrackEnv(t)
	in := e.planned("Спорт")

	var wg sync.WaitGroup
	errs := make([]error, 6)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = e.svc.Start(context.Background(), e.user, in.ID)
		}()
	}
	wg.Wait()
	ok := 0
	for _, err := range errs {
		if err == nil {
			ok++
			continue
		}
		wantState(t, err, task.CodeInvalidState)
	}
	if ok != 1 {
		t.Errorf("%d starts succeeded, want exactly 1", ok)
	}
}

func TestEditTrackingFactAndDeviations(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	in := e.planned("Спорт") // plan 10:00-11:00; the user's threshold is 10 minutes

	// Started 20 minutes late, finished 25 minutes late: 5 minutes longer than planned.
	got, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{
		ActualStart: ptr(msk(t, 2026, 10, 14, 10, 20)), ActualEnd: ptr(msk(t, 2026, 10, 14, 11, 25)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != "done" {
		t.Errorf("status = %q, want done (a fact with both times)", got.Status)
	}
	var kinds []string
	for _, d := range got.Deviations {
		kinds = append(kinds, string(d.Kind))
	}
	if strings.Join(kinds, ",") != "started_late,finished_late" {
		t.Errorf("deviations = %v (65 vs 60 minutes: below the threshold of 10)", kinds)
	}

	// A lower threshold reveals the longer duration too; the deviations follow the user's setting.
	if _, err := e.pool.Exec(ctx, `UPDATE users SET deviation_threshold_minutes = 5`); err != nil {
		t.Fatal(err)
	}
	got, _ = e.svc.Get(ctx, e.user, in.ID)
	if len(got.Deviations) != 3 {
		t.Errorf("deviations with threshold 5 = %+v", got.Deviations)
	}
	if _, err := e.pool.Exec(ctx, `UPDATE users SET deviation_threshold_minutes = 90`); err != nil {
		t.Fatal(err)
	}
	got, _ = e.svc.Get(ctx, e.user, in.ID)
	if len(got.Deviations) != 0 {
		t.Errorf("deviations with threshold 90 = %+v", got.Deviations)
	}
}

func TestEditTrackingStatuses(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()

	t.Run("done with no times takes the plan", func(t *testing.T) {
		in := e.planned("A")
		got, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: ptr("done")})
		if err != nil || got.Status != "done" {
			t.Fatalf("got %+v, %v", got, err)
		}
		same(t, got.ActualStart, msk(t, 2026, 10, 14, 10, 0), "actual start")
	})

	t.Run("partial keeps its own fact", func(t *testing.T) {
		in := e.planned("B")
		if _, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{
			ActualStart: ptr(msk(t, 2026, 10, 14, 10, 0)), ActualEnd: ptr(msk(t, 2026, 10, 14, 10, 30)),
		}); err != nil {
			t.Fatal(err)
		}
		got, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: ptr("partial")})
		if err != nil || got.Status != "partial" {
			t.Fatalf("got %+v, %v", got, err)
		}
		same(t, got.ActualEnd, msk(t, 2026, 10, 14, 10, 30), "actual end")
		// Correcting the times of a partial task keeps it partial.
		got, err = e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{ActualEnd: ptr(msk(t, 2026, 10, 14, 10, 40))})
		if err != nil || got.Status != "partial" {
			t.Errorf("got %+v, %v", got, err)
		}
	})

	t.Run("a start alone means in progress, an end then finishes it", func(t *testing.T) {
		in := e.planned("C")
		got, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{ActualStart: ptr(msk(t, 2026, 10, 14, 10, 5))})
		if err != nil || got.Status != "in_progress" || got.ActualEnd != nil {
			t.Fatalf("got %+v, %v", got, err)
		}
		got, err = e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{ActualEnd: ptr(msk(t, 2026, 10, 14, 10, 50))})
		if err != nil || got.Status != "done" {
			t.Fatalf("got %+v, %v", got, err)
		}
	})

	t.Run("not done and planned clear the fact", func(t *testing.T) {
		in := e.planned("D")
		if _, err := e.svc.Complete(ctx, e.user, in.ID); err != nil {
			t.Fatal(err)
		}
		got, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: ptr("not_done"), Comment: ptr("заболел")})
		if err != nil || got.Status != "not_done" || got.ActualStart != nil || got.ActualEnd != nil || got.Comment != "заболел" {
			t.Fatalf("got %+v, %v", got, err)
		}
		got, err = e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: ptr("planned")})
		if err != nil || got.Status != "planned" || got.ActualStart != nil {
			t.Fatalf("got %+v, %v", got, err)
		}
		if got.Comment != "заболел" {
			t.Errorf("comment = %q: removing the mark must not erase the comment", got.Comment)
		}
	})

	t.Run("a comment alone changes nothing else", func(t *testing.T) {
		in := e.planned("E")
		got, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Comment: ptr("заметка")})
		if err != nil || got.Status != "planned" || got.Comment != "заметка" {
			t.Fatalf("got %+v, %v", got, err)
		}
	})
}

func TestEditTrackingValidation(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	in := e.planned("Спорт")
	s10, s11 := msk(t, 2026, 10, 14, 10, 0), msk(t, 2026, 10, 14, 11, 0)

	for name, tc := range map[string]struct {
		in    task.TrackingInput
		field string
	}{
		"end before start":   {task.TrackingInput{ActualStart: &s11, ActualEnd: &s10}, "actual_end"},
		"empty fact":         {task.TrackingInput{ActualStart: &s10, ActualEnd: &s10}, "actual_end"},
		"unknown status":     {task.TrackingInput{Status: ptr("finished")}, "status"},
		"fact with planned":  {task.TrackingInput{Status: ptr("planned"), ActualStart: &s10}, "actual_start"},
		"fact with not done": {task.TrackingInput{Status: ptr("not_done"), ActualEnd: &s11}, "actual_start"},
		"running with end":   {task.TrackingInput{Status: ptr("in_progress"), ActualStart: &s10, ActualEnd: &s11}, "actual_end"},
		"running no start":   {task.TrackingInput{Status: ptr("in_progress")}, "actual_start"},
		"long comment":       {task.TrackingInput{Comment: ptr(strings.Repeat("я", 2001))}, "comment"},
		"NUL in comment":     {task.TrackingInput{Comment: ptr("a\x00b")}, "comment"},
	} {
		t.Run(name, func(t *testing.T) {
			_, err := e.svc.EditTracking(ctx, e.user, in.ID, tc.in)
			var verr *validation.Error
			if !errors.As(err, &verr) || verr.Field != tc.field {
				t.Fatalf("err = %v, want a validation error on %q", err, tc.field)
			}
		})
	}
	if got, _ := e.svc.Get(ctx, e.user, in.ID); got.Status != "planned" || got.ActualStart != nil {
		t.Errorf("a refused edit changed the task: %+v", got)
	}
	// 2000 characters are fine.
	if _, err := e.svc.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Comment: ptr(strings.Repeat("я", 2000))}); err != nil {
		t.Errorf("2000-character comment: %v", err)
	}
}

func TestRescheduleLeavesATrailInBothDirections(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")
	src := e.planned("Планёрка", work, sport)
	if _, err := e.svc.Update(ctx, e.user, src.ID, task.ScopeThis, task.UpdateInput{Description: ptr("повестка")}); err != nil {
		t.Fatal(err)
	}

	newStart, newEnd := msk(t, 2026, 10, 15, 15, 0), msk(t, 2026, 10, 15, 16, 30)
	moved, err := e.svc.Reschedule(ctx, e.user, src.ID, newStart, newEnd, "совещание")
	if err != nil {
		t.Fatal(err)
	}

	// The new task: a one-off with the same content, linked back to the source.
	if moved.ID == src.ID || moved.SeriesID != nil || moved.Status != "planned" || moved.Title != "Планёрка" || moved.Description != "повестка" {
		t.Errorf("moved = %+v", moved)
	}
	same(t, moved.PlannedStart, newStart, "new start")
	same(t, moved.PlannedEnd, newEnd, "new end")
	if len(moved.CategoryIDs) != 2 {
		t.Errorf("categories = %v", moved.CategoryIDs)
	}
	if moved.RescheduledFrom == nil || moved.RescheduledFrom.ID != src.ID {
		t.Fatalf("RescheduledFrom = %+v", moved.RescheduledFrom)
	}
	same(t, &moved.RescheduledFrom.PlannedStart, msk(t, 2026, 10, 14, 10, 0), "link to the source")

	// The source stays in the calendar, marked and pointing to the new one.
	orig, err := e.svc.Get(ctx, e.user, src.ID)
	if err != nil {
		t.Fatal(err)
	}
	if orig.Status != "rescheduled" || orig.Comment != "совещание" || orig.RescheduledTo == nil || orig.RescheduledTo.ID != moved.ID {
		t.Errorf("source = %+v", orig)
	}
	same(t, &orig.RescheduledTo.PlannedStart, newStart, "link to the new task")
	inList := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 14, 23, 0))
	if len(inList) != 1 || inList[0].Status != "rescheduled" {
		t.Errorf("the source must stay in the calendar: %+v", inList)
	}

	// A task is rescheduled once; the source can no longer be tracked.
	_, err = e.svc.Reschedule(ctx, e.user, src.ID, newStart, newEnd, "")
	wantState(t, err, task.CodeInvalidState)
	_, err = e.svc.Start(ctx, e.user, src.ID)
	wantState(t, err, task.CodeInvalidState)
	_, err = e.svc.EditTracking(ctx, e.user, src.ID, task.TrackingInput{Status: ptr("planned")})
	wantState(t, err, task.CodeInvalidState)
}

func TestRescheduleRules(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	s, en := msk(t, 2026, 10, 15, 10, 0), msk(t, 2026, 10, 15, 11, 0)

	// A not-done task can be moved; a done one cannot.
	notDone := e.planned("Не сделал")
	if _, err := e.svc.EditTracking(ctx, e.user, notDone.ID, task.TrackingInput{Status: ptr("not_done")}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Reschedule(ctx, e.user, notDone.ID, s, en, ""); err != nil {
		t.Errorf("not done: %v", err)
	}
	done := e.planned("Сделал")
	if _, err := e.svc.Complete(ctx, e.user, done.ID); err != nil {
		t.Fatal(err)
	}
	_, err := e.svc.Reschedule(ctx, e.user, done.ID, s, en, "")
	wantState(t, err, task.CodeInvalidState)

	// Validation.
	other := e.planned("Другое")
	_, err = e.svc.Reschedule(ctx, e.user, other.ID, en, s, "")
	wantField(t, err, "planned_end")
	_, err = e.svc.Reschedule(ctx, e.user, other.ID, s, en, strings.Repeat("я", 2001))
	wantField(t, err, "comment")
	if got, _ := e.svc.Get(ctx, e.user, other.ID); got.Status != "planned" {
		t.Errorf("a refused reschedule changed the task: %+v", got)
	}
}

func TestRescheduleOfAnOccurrenceKeepsItsSlotAndMakesAOneOff(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)
	list := e.list(from, to)

	moved, err := e.svc.Reschedule(ctx, e.user, list[1].ID, msk(t, 2026, 10, 15, 18, 0), msk(t, 2026, 10, 15, 19, 0), "")
	if err != nil {
		t.Fatal(err)
	}
	if moved.SeriesID != nil {
		t.Error("the replacement must be a one-off task even if the original was in a series")
	}
	// The slot of the 15th stays taken by the rescheduled original: nothing is created twice.
	got := e.list(from, to)
	byDay := map[string]int{}
	for _, in := range got {
		byDay[in.PlannedStart.In(time.UTC).Format("02")]++
	}
	if byDay["15"] != 2 { // the muted original at 09:00 and the new task at 18:00
		t.Errorf("tasks on the 15th = %d, want 2: %v", byDay["15"], days(got, "Europe/Moscow"))
	}
	// Editing the whole series leaves the rescheduled original and its replacement alone.
	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Title: ptr("Новая")}); err != nil {
		t.Fatal(err)
	}
	for _, in := range e.list(from, to) {
		if in.Status == "rescheduled" && in.Title != "Планёрка" {
			t.Errorf("the rescheduled original was rewritten: %+v", in)
		}
		if in.ID == moved.ID && in.Title != "Планёрка" {
			t.Errorf("the replacement was rewritten: %+v", in)
		}
	}
}

func TestDeletingTheReplacementOrTheOriginal(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()

	// Replacement deleted: the original stays rescheduled, with no target.
	a := e.planned("A")
	movedA, err := e.svc.Reschedule(ctx, e.user, a.ID, msk(t, 2026, 10, 15, 10, 0), msk(t, 2026, 10, 15, 11, 0), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(ctx, e.user, movedA.ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	got, _ := e.svc.Get(ctx, e.user, a.ID)
	if got.Status != "rescheduled" || got.RescheduledTo != nil {
		t.Errorf("original = %+v", got)
	}

	// Original deleted (a one-off is removed for real): the replacement loses its link.
	b := e.planned("B")
	movedB, err := e.svc.Reschedule(ctx, e.user, b.ID, msk(t, 2026, 10, 15, 10, 0), msk(t, 2026, 10, 15, 11, 0), "")
	if err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(ctx, e.user, b.ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	got, _ = e.svc.Get(ctx, e.user, movedB.ID)
	if got.RescheduledFrom != nil || got.Status != "planned" {
		t.Errorf("replacement = %+v", got)
	}
}

func TestUnplannedTasks(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	work := e.category(e.user, "Работа")

	// Back-dated: with a fact, done at once.
	past, err := e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{
		Title: "  Звонок маме ", CategoryIDs: []uuid.UUID{work},
		ActualStart: ptr(msk(t, 2026, 10, 14, 8, 0)), ActualEnd: ptr(msk(t, 2026, 10, 14, 8, 20)),
	})
	if err != nil {
		t.Fatal(err)
	}
	if past.Title != "Звонок маме" || past.Status != "done" || past.PlannedStart != nil || past.PlannedEnd != nil || len(past.CategoryIDs) != 1 {
		t.Errorf("past = %+v", past)
	}
	if len(past.Deviations) != 0 {
		t.Errorf("an unplanned task has no deviations: %+v", past.Deviations)
	}

	// With a timer: starts now, running.
	running, err := e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: "Вдруг"})
	if err != nil {
		t.Fatal(err)
	}
	if running.Status != "in_progress" || running.ActualEnd != nil {
		t.Errorf("running = %+v", running)
	}
	same(t, running.ActualStart, msk(t, 2026, 10, 14, 12, 0), "actual start")
	stopped, err := e.svc.Stop(ctx, e.user, running.ID)
	if err != nil || stopped.Status != "done" || stopped.PlannedStart != nil {
		t.Errorf("stopped = %+v, %v", stopped, err)
	}

	// Validation.
	_, err = e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: "x", ActualStart: ptr(msk(t, 2026, 10, 14, 9, 0)), ActualEnd: ptr(msk(t, 2026, 10, 14, 9, 0))})
	wantField(t, err, "actual_end")
	_, err = e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: " "})
	wantField(t, err, "title")
	_, err = e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: "x", CategoryIDs: []uuid.UUID{uuid.New()}})
	wantField(t, err, "category_ids")

	// It has no plan to edit or to go back to; the rest is editable and it can be deleted.
	_, err = e.svc.Update(ctx, e.user, past.ID, task.ScopeThis, task.UpdateInput{PlannedStart: ptr(msk(t, 2026, 10, 14, 9, 0))})
	wantField(t, err, "planned_start")
	if got, err := e.svc.Update(ctx, e.user, past.ID, task.ScopeThis, task.UpdateInput{Title: ptr("Звонок")}); err != nil || got.Title != "Звонок" {
		t.Errorf("rename: %+v, %v", got, err)
	}
	_, err = e.svc.EditTracking(ctx, e.user, past.ID, task.TrackingInput{Status: ptr("planned")})
	wantState(t, err, task.CodeInvalidState)
	_, err = e.svc.Reschedule(ctx, e.user, past.ID, msk(t, 2026, 10, 15, 9, 0), msk(t, 2026, 10, 15, 10, 0), "")
	wantState(t, err, task.CodeInvalidState)
	if err := e.svc.Delete(ctx, e.user, past.ID, task.ScopeThis); err != nil {
		t.Errorf("delete: %v", err)
	}
}

func TestListFindsTasksByPlanOrFact(t *testing.T) {
	e := newTrackEnv(t) // now = 12:00
	ctx := context.Background()
	planned := e.planned("План 10-11")
	if _, err := e.svc.EditTracking(ctx, e.user, planned.ID, task.TrackingInput{
		ActualStart: ptr(msk(t, 2026, 10, 14, 11, 30)), ActualEnd: ptr(msk(t, 2026, 10, 14, 12, 30)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{
		Title: "Вне плана", ActualStart: ptr(msk(t, 2026, 10, 14, 15, 0)), ActualEnd: ptr(msk(t, 2026, 10, 14, 16, 0)),
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.CreateUnplanned(ctx, e.user, task.UnplannedInput{Title: "Таймер", ActualStart: ptr(msk(t, 2026, 10, 14, 9, 0))}); err != nil {
		t.Fatal(err)
	}

	titles := func(from, to time.Time) string {
		var out []string
		for _, in := range e.list(from, to) {
			out = append(out, in.Title)
		}
		return strings.Join(out, ",")
	}
	// By the plan (10-11).
	if got := titles(msk(t, 2026, 10, 14, 10, 15), msk(t, 2026, 10, 14, 10, 30)); got != "Таймер,План 10-11" {
		t.Errorf("plan window: %q", got)
	}
	// By the fact only: 11:30-12:30 reaches beyond the plan, and the timer runs until now (12:00).
	if got := titles(msk(t, 2026, 10, 14, 12, 15), msk(t, 2026, 10, 14, 12, 20)); got != "План 10-11" {
		t.Errorf("fact window after the plan: %q", got)
	}
	// A task outside the plan is found by its fact.
	if got := titles(msk(t, 2026, 10, 14, 15, 30), msk(t, 2026, 10, 14, 15, 40)); got != "Вне плана" {
		t.Errorf("unplanned window: %q", got)
	}
	// A running timer reaches up to now and not beyond.
	if got := titles(msk(t, 2026, 10, 14, 12, 5), msk(t, 2026, 10, 14, 13, 0)); strings.Contains(got, "Таймер") {
		t.Errorf("the timer must not extend past now: %q", got)
	}
	if got := titles(msk(t, 2026, 10, 14, 11, 0), msk(t, 2026, 10, 14, 11, 45)); !strings.Contains(got, "Таймер") {
		t.Errorf("the timer should be found before now: %q", got)
	}
}

func TestMarkingAnOccurrenceProtectsItAndRemovingTheMarkReleasesIt(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	list := e.list(from, to)

	if _, err := e.svc.Complete(ctx, e.user, list[1].ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Title: ptr("Новая")}); err != nil {
		t.Fatal(err)
	}
	titles := map[string]string{}
	for _, in := range e.list(from, to) {
		titles[in.PlannedStart.In(time.UTC).Format("02")] = in.Title
	}
	if titles["15"] != "Планёрка" || titles["14"] != "Новая" {
		t.Errorf("after edit all: %v (the done one must keep its title)", titles)
	}

	// Remove the mark: the occurrence is an ordinary planned one again, and the series edit reaches it.
	done := e.list(from, to)
	var doneID uuid.UUID
	for _, in := range done {
		if in.Status == "done" {
			doneID = in.ID
		}
	}
	if _, err := e.svc.EditTracking(ctx, e.user, doneID, task.TrackingInput{Status: ptr("planned")}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Update(ctx, e.user, e.list(from, to)[0].ID, task.ScopeAll, task.UpdateInput{Title: ptr("Ещё новее")}); err != nil {
		t.Fatal(err)
	}
	for _, in := range e.list(from, to) {
		if in.Title != "Ещё новее" {
			t.Errorf("%v was not rewritten after the mark was removed: %+v", in.PlannedStart, in)
		}
	}
}

func TestTrackingIsPerUser(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	in := e.planned("Моё")

	if _, err := e.svc.Complete(ctx, e.other, in.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Complete: %v", err)
	}
	if _, err := e.svc.Start(ctx, e.other, in.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Start: %v", err)
	}
	if _, err := e.svc.Stop(ctx, e.other, in.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Stop: %v", err)
	}
	if _, err := e.svc.EditTracking(ctx, e.other, in.ID, task.TrackingInput{Comment: ptr("x")}); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("EditTracking: %v", err)
	}
	if _, err := e.svc.Reschedule(ctx, e.other, in.ID, msk(t, 2026, 10, 15, 10, 0), msk(t, 2026, 10, 15, 11, 0), ""); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Reschedule: %v", err)
	}
	if got, _ := e.svc.Get(ctx, e.user, in.ID); got.Status != "planned" {
		t.Errorf("task changed: %+v", got)
	}
}

func TestTheTableKeepsStatusAndFactConsistent(t *testing.T) {
	e := newTrackEnv(t)
	ctx := context.Background()
	in := e.planned("Спорт")

	for name, sql := range map[string]string{
		"done without a fact":     `UPDATE task_instances SET status = 'done' WHERE id = $1`,
		"in progress with an end": `UPDATE task_instances SET status = 'in_progress', actual_start = planned_start, actual_end = planned_end WHERE id = $1`,
		"planned with a fact":     `UPDATE task_instances SET actual_start = planned_start WHERE id = $1`,
		"end before start":        `UPDATE task_instances SET status = 'done', actual_start = planned_end, actual_end = planned_start WHERE id = $1`,
		"end without start":       `UPDATE task_instances SET actual_end = planned_end WHERE id = $1`,
		"half a plan":             `UPDATE task_instances SET planned_end = NULL WHERE id = $1`,
		"too long a comment":      `UPDATE task_instances SET comment = repeat('x', 2001) WHERE id = $1`,
	} {
		if _, err := e.pool.Exec(ctx, sql, in.ID); err == nil {
			t.Errorf("%s: the table accepted it", name)
		}
	}
	// Unplanned and without a fact is nothing.
	if _, err := e.pool.Exec(ctx, `INSERT INTO task_instances (user_id, title, status) VALUES ($1, 'x', 'in_progress')`, e.user); err == nil {
		t.Error("a task with neither plan nor fact was accepted")
	}
}
