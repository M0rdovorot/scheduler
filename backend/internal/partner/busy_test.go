package partner_test

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/partner"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
)

// t is the 14th of October 2026 (the env clock stands at 12:00 Moscow); h:m in UTC.
func t14(h, m int) time.Time { return time.Date(2026, 10, 14, h, m, 0, 0, time.UTC) }

func dayWindow() (time.Time, time.Time) { return t14(0, 0), t14(0, 0).Add(24 * time.Hour) }

func str(s string) *string { return &s }

// plan creates a one-off task of the user from h1 to h2 (UTC).
func (e *env) plan(user uuid.UUID, title, vis string, h1, h2 int) task.Instance {
	e.t.Helper()
	in, err := e.tasks.Create(context.Background(), user, task.CreateInput{
		Title: title, PlannedStart: t14(h1, 0), PlannedEnd: t14(h2, 0), Visibility: str(vis),
	})
	if err != nil {
		e.t.Fatal(err)
	}
	return in
}

// busyOf describes what viewer sees of owner: "09-10 title" or "09-10 busy".
func (e *env) busyOf(viewer, owner uuid.UUID) []string {
	e.t.Helper()
	from, to := dayWindow()
	blocks, err := e.svc.Busy(context.Background(), viewer, owner, from, to)
	if err != nil {
		e.t.Fatal(err)
	}
	out := make([]string, len(blocks))
	for i, b := range blocks {
		name := "busy"
		if b.Title != nil {
			name = *b.Title
		}
		out[i] = fmt.Sprintf("%02d-%02d %s", b.Start.Hour(), b.End.Hour(), name)
	}
	return out
}

func same(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "; ") != strings.Join(want, "; ") {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}

func TestBusyShowsTitlesByVisibilityAndAccess(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.link(e.a, e.b)
	e.link(e.a, e.c)
	e.plan(e.a, "Для всех", "partners", 6, 7)
	e.plan(e.a, "Для своих", "granted", 7, 8)
	e.plan(e.a, "Тайна", "private", 8, 9)

	// Nothing is given yet: only what is open to all partners has a title.
	same(t, e.busyOf(e.b, e.a), []string{"06-07 Для всех", "07-08 busy", "08-09 busy"})

	yes := true
	if _, err := e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Tasks: &yes}); err != nil {
		t.Fatal(err)
	}
	same(t, e.busyOf(e.b, e.a), []string{"06-07 Для всех", "07-08 Для своих", "08-09 busy"})
	// The access is per partner.
	same(t, e.busyOf(e.c, e.a), []string{"06-07 Для всех", "07-08 busy", "08-09 busy"})
}

func TestBusyOfAStrangerIsNotFound(t *testing.T) {
	e := newEnv(t)
	e.plan(e.a, "x", "partners", 6, 7)
	from, to := dayWindow()
	if _, err := e.svc.Busy(context.Background(), e.b, e.a, from, to); !errors.Is(err, partner.ErrNotFound) {
		t.Errorf("Busy of a stranger: %v, want ErrNotFound", err)
	}
	// After the link is broken the partner sees nothing again.
	e.link(e.a, e.b)
	if err := e.svc.Remove(context.Background(), e.a, e.b); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Busy(context.Background(), e.b, e.a, from, to); !errors.Is(err, partner.ErrNotFound) {
		t.Errorf("Busy after the break: %v, want ErrNotFound", err)
	}
}

func TestBusyWindowIsChecked(t *testing.T) {
	e := newEnv(t)
	e.link(e.a, e.b)
	from, _ := dayWindow()
	for name, to := range map[string]time.Time{"empty": from, "backwards": from.Add(-time.Hour), "too long": from.Add(partner.MaxWindow + time.Hour)} {
		if _, err := e.svc.Busy(context.Background(), e.b, e.a, from, to); err == nil {
			t.Errorf("%s window accepted", name)
		}
	}
}

func TestBusyUsesTheFactWhereThereIsOne(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.link(e.a, e.b)
	e.now = t14(12, 0)

	done := e.plan(e.a, "Сделано", "partners", 6, 7)
	late := t14(6, 30)
	end := t14(7, 45)
	if _, err := e.tasks.EditTracking(ctx, e.a, done.ID, task.TrackingInput{ActualStart: &late, ActualEnd: &end}); err != nil {
		t.Fatal(err)
	}
	running := e.plan(e.a, "Идёт", "partners", 9, 10)
	e.now = t14(11, 0)
	if _, err := e.tasks.Start(ctx, e.a, running.ID); err != nil {
		t.Fatal(err)
	}
	e.now = t14(11, 30)

	from, to := dayWindow()
	blocks, err := e.svc.Busy(ctx, e.b, e.a, from, to)
	if err != nil {
		t.Fatal(err)
	}
	want := []partner.Interval{{Start: late, End: end}, {Start: t14(11, 0), End: t14(11, 30)}}
	if len(blocks) != len(want) {
		t.Fatalf("busy = %+v, want the fact %v", blocks, want)
	}
	for i, w := range want {
		if !blocks[i].Start.Equal(w.Start) || !blocks[i].End.Equal(w.End) {
			t.Errorf("block %d = %v–%v, want the fact %v–%v", i, blocks[i].Start, blocks[i].End, w.Start, w.End)
		}
	}
}

func TestBusySkipsRescheduledCancelledAndNotDone(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.link(e.a, e.b)

	moved := e.plan(e.a, "Перенесённое", "partners", 6, 7)
	if _, err := e.tasks.Reschedule(ctx, e.a, moved.ID, t14(15, 0), t14(16, 0), ""); err != nil {
		t.Fatal(err)
	}
	skipped := e.plan(e.a, "Не сделано", "partners", 8, 9)
	if _, err := e.tasks.EditTracking(ctx, e.a, skipped.ID, task.TrackingInput{Status: str("not_done")}); err != nil {
		t.Fatal(err)
	}
	e.plan(e.a, "Остаётся", "partners", 10, 11)

	// The new task replaces the old one; the old time is free.
	same(t, e.busyOf(e.b, e.a), []string{"10-11 Остаётся", "15-16 Перенесённое"})
}

func TestBusyIncludesSeriesNobodyOpenedYet(t *testing.T) {
	e := newEnv(t)
	e.link(e.a, e.b)
	rule := "FREQ=DAILY"
	if _, err := e.tasks.Create(context.Background(), e.a, task.CreateInput{
		Title: "Планёрка", PlannedStart: t14(6, 0), PlannedEnd: t14(7, 0), Recurrence: &rule, Visibility: str("partners"),
	}); err != nil {
		t.Fatal(err)
	}

	from := t14(0, 0).AddDate(0, 0, 10)
	blocks, err := e.svc.Busy(context.Background(), e.b, e.a, from, from.Add(48*time.Hour))
	if err != nil || len(blocks) != 2 || blocks[0].Title == nil || *blocks[0].Title != "Планёрка" {
		t.Errorf("busy in a window ahead = %+v, %v; want two occurrences", blocks, err)
	}
}

func TestHabitTitleGoesByHabitAccess(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.link(e.a, e.b)
	if _, err := e.habits.Create(ctx, e.a, habit.Input{
		Title: "Зарядка", Kind: habit.Boolean, Color: "#3b82f6", Schedule: habit.Schedule{Frequency: habit.Daily},
		Placement: &habit.Placement{Time: "09:00", DurationMinutes: 30}, // 06:00 UTC
	}); err != nil {
		t.Fatal(err)
	}
	// Whatever the visibility of tasks, a habit is open only through the access to habits.
	if _, err := e.pool.Exec(ctx, `UPDATE task_series SET visibility = 'partners'`); err != nil {
		t.Fatal(err)
	}

	same(t, e.busyOf(e.b, e.a), []string{"06-06 busy"})
	yes := true
	if _, err := e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Tasks: &yes}); err != nil {
		t.Fatal(err)
	}
	same(t, e.busyOf(e.b, e.a), []string{"06-06 busy"}) // access to tasks is not access to habits
	if _, err := e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Habits: &yes}); err != nil {
		t.Fatal(err)
	}
	same(t, e.busyOf(e.b, e.a), []string{"06-06 Зарядка"})
}

func TestFreeTime(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.link(e.a, e.b)
	e.link(e.a, e.c)
	e.plan(e.a, "a", "private", 6, 8)
	e.plan(e.b, "b", "private", 7, 10)
	e.plan(e.c, "c", "private", 20, 22)

	from, to := t14(5, 0), t14(12, 0)
	list := func(with []uuid.UUID, min time.Duration) string {
		t.Helper()
		free, err := e.svc.FreeTime(ctx, e.a, with, from, to, min)
		if err != nil {
			t.Fatal(err)
		}
		var parts []string
		for _, f := range free {
			parts = append(parts, fmt.Sprintf("%02d:%02d-%02d:%02d", f.Start.Hour(), f.Start.Minute(), f.End.Hour(), f.End.Minute()))
		}
		return strings.Join(parts, " ")
	}
	if got := list(nil, time.Minute); got != "05:00-06:00 08:00-12:00" {
		t.Errorf("alone = %q", got)
	}
	if got := list([]uuid.UUID{e.b}, time.Minute); got != "05:00-06:00 10:00-12:00" {
		t.Errorf("with b = %q", got)
	}
	if got := list([]uuid.UUID{e.b, e.c, e.b, e.a}, 90*time.Minute); got != "10:00-12:00" {
		t.Errorf("with b, c (repeats and himself ignored), at least 90 minutes = %q", got)
	}
}

func TestFreeTimeNeedsPartners(t *testing.T) {
	e := newEnv(t)
	e.link(e.a, e.b)
	from, to := dayWindow()
	if _, err := e.svc.FreeTime(context.Background(), e.a, []uuid.UUID{e.b, e.c}, from, to, time.Minute); !errors.Is(err, partner.ErrNotFound) {
		t.Errorf("with a stranger: %v, want ErrNotFound", err)
	}
}

func TestFreeIntervals(t *testing.T) {
	iv := func(h1, h2 int) partner.Interval { return partner.Interval{Start: t14(h1, 0), End: t14(h2, 0)} }
	tests := []struct {
		name     string
		busy     []partner.Interval
		min      time.Duration
		from, to int
		want     []partner.Interval
	}{
		{"nobody is busy", nil, time.Minute, 8, 18, []partner.Interval{iv(8, 18)}},
		{"overlapping and nested intervals", []partner.Interval{iv(10, 12), iv(9, 11), iv(9, 10), iv(10, 11)}, time.Minute, 8, 18, []partner.Interval{iv(8, 9), iv(12, 18)}},
		{"touching intervals leave no gap", []partner.Interval{iv(9, 10), iv(10, 11)}, time.Minute, 8, 12, []partner.Interval{iv(8, 9), iv(11, 12)}},
		{"intervals sticking out of the window", []partner.Interval{iv(6, 9), iv(17, 20)}, time.Minute, 8, 18, []partner.Interval{iv(9, 17)}},
		{"busy all window", []partner.Interval{iv(6, 20)}, time.Minute, 8, 18, nil},
		{"short gaps are dropped", []partner.Interval{iv(9, 10), iv(10, 11)}, 2 * time.Hour, 8, 12, nil},
		{"a gap of exactly the minimum stays", []partner.Interval{iv(9, 10)}, time.Hour, 8, 11, []partner.Interval{iv(8, 9), iv(10, 11)}},
		{"outside the window", []partner.Interval{iv(1, 2), iv(20, 21)}, time.Minute, 8, 18, []partner.Interval{iv(8, 18)}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			before := fmt.Sprint(tt.busy)
			got := partner.FreeIntervals(t14(tt.from, 0), t14(tt.to, 0), tt.busy, tt.min)
			if fmt.Sprint(got) != fmt.Sprint(tt.want) {
				t.Errorf("got  %v\nwant %v", got, tt.want)
			}
			if fmt.Sprint(tt.busy) != before {
				t.Errorf("the input was reordered: %v", tt.busy)
			}
		})
	}
}
