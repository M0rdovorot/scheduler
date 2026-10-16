package habit_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

var msk, _ = time.LoadLocation("Europe/Moscow")

// at is a Moscow time in October 2026; the clock stands at Wednesday the 14th, 12:00.
func at(day, h, m int) time.Time { return time.Date(2026, 10, day, h, m, 0, 0, msk) }
func day(d int) habit.Day        { return habit.DayOf(2026, time.October, d) }

type env struct {
	t      *testing.T
	habits *habit.Service
	tasks  *task.Service
	user   uuid.UUID
	other  uuid.UUID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	st := store.NewStore(testutil.NewDB(t, migrations.FS))
	mk := func(name string) uuid.UUID {
		u, err := st.CreateUser(context.Background(), store.CreateUserParams{DisplayName: name, Timezone: "Europe/Moscow"})
		if err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	e := &env{t: t, habits: habit.NewService(st), tasks: task.NewService(st), user: mk("a"), other: mk("b")}
	clock := func() time.Time { return at(14, 12, 0) }
	e.habits.SetClock(clock)
	e.tasks.SetClock(clock)
	return e
}

func (e *env) create(in habit.Input) habit.Habit {
	e.t.Helper()
	if in.Title == "" {
		in.Title = "Читать"
	}
	if in.Kind == "" {
		in.Kind = habit.Boolean
	}
	if in.Color == "" {
		in.Color = "#3b82f6"
	}
	if in.Schedule.Frequency == "" {
		in.Schedule = habit.Schedule{Frequency: habit.Daily}
	}
	h, err := e.habits.Create(context.Background(), e.user, in)
	if err != nil {
		e.t.Fatal(err)
	}
	return h
}

func (e *env) mark(id uuid.UUID, d habit.Day, value int) {
	e.t.Helper()
	if err := e.habits.SetMark(context.Background(), e.user, id, d, value); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) stats(id uuid.UUID) habit.Stats {
	e.t.Helper()
	st, err := e.habits.Stats(context.Background(), e.user, id, day(1), day(31))
	if err != nil {
		e.t.Fatal(err)
	}
	return st
}

func (e *env) cellValue(id uuid.UUID, d int) int {
	e.t.Helper()
	for _, c := range e.stats(id).Cells {
		if c.Date.Equal(day(d)) {
			return c.Value
		}
	}
	e.t.Fatalf("no cell for %d", d)
	return 0
}

// occurrences are the instances of the week of the 12th to the 18th.
func (e *env) occurrences() []task.Instance {
	e.t.Helper()
	list, err := e.tasks.List(context.Background(), e.user, at(12, 0, 0), at(19, 0, 0))
	if err != nil {
		e.t.Fatal(err)
	}
	return list
}

func isValidation(err error, field string) bool {
	var v *validation.Error
	return errors.As(err, &v) && v.Field == field
}

func TestCreateCleansUpTheFields(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{
		Title: "  Вода  ", Kind: habit.Boolean, Target: 5, Unit: "стакан", Color: "#AABBCC",
		Schedule: habit.Schedule{Frequency: habit.Weekdays, Weekdays: []int{5, 1}},
	})
	if h.Title != "Вода" || h.Target != 1 || h.Unit != "" || h.Color != "#aabbcc" {
		t.Errorf("habit = %+v", h)
	}
	if h.Schedule.Weekdays[0] != 1 || h.Schedule.Weekdays[1] != 5 {
		t.Errorf("weekdays = %v", h.Schedule.Weekdays)
	}
	if !h.CreatedAt.Equal(at(14, 12, 0)) || h.Placement != nil {
		t.Errorf("created %v, placement %v", h.CreatedAt, h.Placement)
	}
}

func TestCreateRejectsBadInput(t *testing.T) {
	e := newEnv(t)
	cases := []struct {
		name  string
		in    habit.Input
		field string
	}{
		{"empty title", habit.Input{Title: " ", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily}}, "title"},
		{"bad color", habit.Input{Title: "a", Kind: habit.Boolean, Color: "red", Schedule: habit.Schedule{Frequency: habit.Daily}}, "color"},
		{"bad kind", habit.Input{Title: "a", Kind: "x", Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily}}, "kind"},
		{"no target", habit.Input{Title: "a", Kind: habit.Quantity, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily}}, "target_value"},
		{"no weekdays", habit.Input{Title: "a", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Weekdays}}, "frequency"},
		{"weekly in the grid", habit.Input{
			Title: "a", Kind: habit.Boolean, Color: "#112233",
			Schedule:  habit.Schedule{Frequency: habit.TimesPerWeek, TimesPerWeek: 3},
			Placement: &habit.Placement{Time: "07:00", DurationMinutes: 30},
		}, "time"},
		{"bad time", habit.Input{
			Title: "a", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily},
			Placement: &habit.Placement{Time: "7:00", DurationMinutes: 30},
		}, "time"},
		{"no length", habit.Input{
			Title: "a", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily},
			Placement: &habit.Placement{Time: "07:00"},
		}, "duration_minutes"},
	}
	for _, c := range cases {
		if _, err := e.habits.Create(context.Background(), e.user, c.in); !isValidation(err, c.field) {
			t.Errorf("%s: err = %v, want a validation error on %s", c.name, err, c.field)
		}
	}
	if list, _ := e.habits.List(context.Background(), e.user); len(list) != 0 {
		t.Errorf("a rejected habit was stored: %d", len(list))
	}
}

func TestMarks(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{Kind: habit.Quantity, Target: 8, Unit: "стаканов"})
	e.mark(h.ID, day(13), 3)
	e.mark(h.ID, day(13), 5) // replaces
	e.mark(h.ID, day(12), 8)
	if v := e.cellValue(h.ID, 13); v != 5 {
		t.Errorf("value = %d, want 5", v)
	}
	e.mark(h.ID, day(13), 0)
	if v := e.cellValue(h.ID, 13); v != 0 {
		t.Errorf("value after 0 = %d", v)
	}

	ctx := context.Background()
	if err := e.habits.SetMark(ctx, e.user, h.ID, day(15), 1); !isValidation(err, "date") {
		t.Errorf("a future day: %v", err)
	}
	if err := e.habits.SetMark(ctx, e.user, h.ID, day(14), -1); !isValidation(err, "value") {
		t.Errorf("a negative value: %v", err)
	}
	yesno := e.create(habit.Input{Title: "Йога"})
	if err := e.habits.SetMark(ctx, e.user, yesno.ID, day(14), 2); !isValidation(err, "value") {
		t.Errorf("2 for a yes/no habit: %v", err)
	}
	// The day that is today for the user is allowed.
	e.mark(yesno.ID, day(14), 1)
}

func TestOtherUsersHabitsAreNotFound(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{})
	ctx := context.Background()
	if _, err := e.habits.Get(ctx, e.other, h.ID); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("get: %v", err)
	}
	if err := e.habits.SetMark(ctx, e.other, h.ID, day(14), 1); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("mark: %v", err)
	}
	if _, err := e.habits.Update(ctx, e.other, h.ID, habit.Patch{Title: ptr("x")}); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("update: %v", err)
	}
	if _, err := e.habits.Archive(ctx, e.other, h.ID, true); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("archive: %v", err)
	}
	if err := e.habits.Delete(ctx, e.other, h.ID); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("delete: %v", err)
	}
	if _, err := e.habits.SetPlacement(ctx, e.other, h.ID, habit.Placement{Time: "07:00", DurationMinutes: 30}); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("placement: %v", err)
	}
	if _, err := e.habits.Stats(ctx, e.other, h.ID, day(1), day(2)); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("stats: %v", err)
	}
	if list, _ := e.habits.List(ctx, e.other); len(list) != 0 {
		t.Errorf("list: %d", len(list))
	}
	if items, _, _ := e.habits.Today(ctx, e.other); len(items) != 0 {
		t.Errorf("today: %d", len(items))
	}
}

func ptr[T any](v T) *T { return &v }

func TestTodayListsWhatIsPlannedForTheDay(t *testing.T) {
	e := newEnv(t)
	daily := e.create(habit.Input{Title: "Каждый день"})
	wed := e.create(habit.Input{Title: "По средам", Schedule: habit.Schedule{Frequency: habit.Weekdays, Weekdays: []int{3}}})
	e.create(habit.Input{Title: "По вторникам", Schedule: habit.Schedule{Frequency: habit.Weekdays, Weekdays: []int{2}}})
	weekly := e.create(habit.Input{Title: "Три раза", Schedule: habit.Schedule{Frequency: habit.TimesPerWeek, TimesPerWeek: 3}})
	archived := e.create(habit.Input{Title: "Старая"})
	if _, err := e.habits.Archive(context.Background(), e.user, archived.ID, true); err != nil {
		t.Fatal(err)
	}

	e.mark(daily.ID, day(14), 1)
	e.mark(weekly.ID, day(12), 1)
	e.mark(weekly.ID, day(13), 1)

	items, today, err := e.habits.Today(context.Background(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	if !today.Equal(day(14)) {
		t.Errorf("today = %v", today)
	}
	got := map[string]habit.TodayItem{}
	for _, it := range items {
		got[it.Habit.Title] = it
	}
	if len(got) != 3 {
		t.Fatalf("today has %d habits: %v", len(got), got)
	}
	if !got["Каждый день"].Done || got["Каждый день"].Streaks.Current != 1 {
		t.Errorf("daily = %+v", got["Каждый день"])
	}
	if got["По средам"].Habit.ID != wed.ID || got["По средам"].Done {
		t.Errorf("wednesday = %+v", got["По средам"])
	}
	if w := got["Три раза"]; w.Habit.ID != weekly.ID || w.WeekDone != 2 || w.Done {
		t.Errorf("weekly = %+v", w)
	}
}

func TestTodayFollowsTheTimeZoneOfTheUser(t *testing.T) {
	e := newEnv(t)
	// 22:00 UTC on the 14th is already the 15th in Moscow.
	e.habits.SetClock(func() time.Time { return time.Date(2026, 10, 14, 22, 0, 0, 0, time.UTC) })
	e.create(habit.Input{})
	_, today, err := e.habits.Today(context.Background(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	if !today.Equal(day(15)) {
		t.Errorf("today = %v, want the 15th", today)
	}
}

func TestStatsCountStreaksAndPercent(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{})
	// Created on the 14th. A backfilled mark for the 10th moves the start back.
	e.mark(h.ID, day(10), 1)
	e.mark(h.ID, day(11), 1)
	e.mark(h.ID, day(13), 1)
	e.mark(h.ID, day(14), 1)
	st := e.stats(h.ID)
	// 10, 11 done; 12 missed; 13, 14 done.
	if st.Streaks.Current != 2 || st.Streaks.Best != 2 {
		t.Errorf("streaks = %+v", st.Streaks)
	}
	if st.PercentAll == nil || *st.PercentAll != 80 {
		t.Errorf("percent = %v", st.PercentAll)
	}
	if len(st.Cells) != 31 {
		t.Errorf("cells = %d", len(st.Cells))
	}
	if _, err := e.habits.Stats(context.Background(), e.user, h.ID, day(1), day(1).AddDate(1, 0, 1)); !isValidation(err, "to") {
		t.Errorf("a too long period: %v", err)
	}
	if _, err := e.habits.Stats(context.Background(), e.user, h.ID, day(5), day(4)); !isValidation(err, "to") {
		t.Errorf("an upside down period: %v", err)
	}
}

func TestAHabitInTheGridIsARegularTask(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{
		Title: "Зарядка", Schedule: habit.Schedule{Frequency: habit.Weekdays, Weekdays: []int{1, 3}},
		Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20},
	})
	if h.Placement == nil || h.Placement.Time != "07:30" || h.Placement.DurationMinutes != 20 {
		t.Fatalf("placement = %+v", h.Placement)
	}
	list := e.occurrences()
	// The series starts today (Wednesday the 14th); the next day of the schedule is Monday the 19th, outside the window.
	if len(list) != 1 {
		t.Fatalf("occurrences = %d, want 1", len(list))
	}
	in := list[0]
	if in.Title != "Зарядка" || in.HabitID == nil || *in.HabitID != h.ID || in.SeriesID == nil {
		t.Errorf("instance = %+v", in)
	}
	if !in.PlannedStart.Equal(at(14, 7, 30)) || !in.PlannedEnd.Equal(at(14, 7, 50)) {
		t.Errorf("plan = %v - %v", in.PlannedStart, in.PlannedEnd)
	}
}

func TestDoingTheOccurrenceCreditsTheDay(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	in := e.occurrences()[0]

	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 1 {
		t.Fatalf("value after done = %d, want 1", v)
	}
	// Putting it back to planned takes the credit back.
	planned := "planned"
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: &planned}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 0 {
		t.Errorf("value after un-doing = %d, want 0", v)
	}
	// Done again, then partial: partial is not done.
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	partial := "partial"
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: &partial}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 0 {
		t.Errorf("value after partial = %d, want 0", v)
	}
}

func TestAQuantityHabitIsCreditedWithItsGoalAndKeepsALargerValue(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{
		Title: "Бег", Kind: habit.Quantity, Target: 30, Unit: "мин",
		Placement: &habit.Placement{Time: "07:30", DurationMinutes: 30},
	})
	in := e.occurrences()[0]
	e.mark(h.ID, day(14), 12) // done by hand earlier, below the goal
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 30 {
		t.Errorf("value = %d, want the goal, 30", v)
	}

	// The credited value can be corrected; taking the task back then leaves the correction alone.
	e.mark(h.ID, day(14), 45)
	planned := "planned"
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: &planned}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 45 {
		t.Errorf("value after the correction = %d, want 45", v)
	}
	// A larger value that is there is not lowered by a done task.
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 45 {
		t.Errorf("value = %d, want 45", v)
	}
}

func TestDeletingADoneOccurrenceTakesItsCreditBack(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	in := e.occurrences()[0]
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.tasks.Delete(ctx, e.user, in.ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 0 {
		t.Errorf("value = %d, want 0", v)
	}
}

func TestChangingTheScheduleReachesTheGrid(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Title: "Зарядка", Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	if n := len(e.occurrences()); n != 5 { // 14 to 18
		t.Fatalf("daily: %d occurrences, want 5", n)
	}

	_, err := e.habits.Update(ctx, e.user, h.ID, habit.Patch{
		Title:    ptr("Разминка"),
		Schedule: &habit.Schedule{Frequency: habit.Weekdays, Weekdays: []int{3, 5}},
	})
	if err != nil {
		t.Fatal(err)
	}
	list := e.occurrences()
	if len(list) != 2 || list[0].Title != "Разминка" || !list[0].PlannedStart.Equal(at(14, 7, 30)) || !list[1].PlannedStart.Equal(at(16, 7, 30)) {
		t.Errorf("after the change: %+v", list)
	}

	// A new time of day.
	got, err := e.habits.SetPlacement(ctx, e.user, h.ID, habit.Placement{Time: "21:00", DurationMinutes: 45})
	if err != nil {
		t.Fatal(err)
	}
	if got.Placement == nil || got.Placement.Time != "21:00" || got.Placement.DurationMinutes != 45 {
		t.Errorf("placement = %+v", got.Placement)
	}
	list = e.occurrences()
	if len(list) != 2 || !list[0].PlannedStart.Equal(at(14, 21, 0)) || !list[0].PlannedEnd.Equal(at(14, 21, 45)) {
		t.Errorf("after the move: %+v", list)
	}

	// A weekly goal cannot be in the grid.
	_, err = e.habits.Update(ctx, e.user, h.ID, habit.Patch{Schedule: &habit.Schedule{Frequency: habit.TimesPerWeek, TimesPerWeek: 2}})
	if !isValidation(err, "frequency") {
		t.Errorf("weekly goal in the grid: %v", err)
	}
}

func TestMarkedOccurrencesSurviveAChangeOfTheHabit(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Title: "Зарядка", Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	first := e.occurrences()[0]
	if _, err := e.tasks.Complete(ctx, e.user, first.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.habits.Update(ctx, e.user, h.ID, habit.Patch{Title: ptr("Разминка")}); err != nil {
		t.Fatal(err)
	}
	var found bool
	for _, in := range e.occurrences() {
		if in.ID == first.ID {
			found = true
			if in.Title != "Зарядка" || in.Status != "done" {
				t.Errorf("history changed: %+v", in)
			}
		}
	}
	if !found {
		t.Error("the done occurrence is gone")
	}
	if v := e.cellValue(h.ID, 14); v != 1 {
		t.Errorf("credit lost: %d", v)
	}
}

func TestTheScheduleOfAHabitCannotBeChangedFromTheCalendar(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	in := e.occurrences()[0]
	rule := "FREQ=WEEKLY;BYDAY=MO"
	_, err := e.tasks.Update(context.Background(), e.user, in.ID, task.ScopeAll, task.UpdateInput{Recurrence: &rule})
	if !isValidation(err, "recurrence") {
		t.Errorf("err = %v", err)
	}
	_ = h
}

func TestSplittingTheSeriesKeepsTheHabit(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	var third task.Instance
	for _, in := range e.occurrences() {
		if in.PlannedStart.Equal(at(16, 7, 30)) {
			third = in
		}
	}
	title := "Другое"
	if _, err := e.tasks.Update(context.Background(), e.user, third.ID, task.ScopeFollowing, task.UpdateInput{Title: &title}); err != nil {
		t.Fatal(err)
	}
	for _, in := range e.occurrences() {
		if in.HabitID == nil || *in.HabitID != h.ID {
			t.Errorf("%s on %v lost its habit", in.Title, in.PlannedStart)
		}
	}
	got, _ := e.habits.Get(context.Background(), e.user, h.ID)
	if got.Placement == nil {
		t.Error("the placement is gone after a split")
	}
}

func TestArchiveTakesTheHabitOutOfTheGridAndKeepsHistory(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	first := e.occurrences()[0]
	if _, err := e.tasks.Complete(ctx, e.user, first.ID); err != nil {
		t.Fatal(err)
	}
	got, err := e.habits.Archive(ctx, e.user, h.ID, true)
	if err != nil {
		t.Fatal(err)
	}
	if got.ArchivedAt == nil || got.Placement != nil {
		t.Errorf("archived = %+v", got)
	}
	list := e.occurrences()
	if len(list) != 1 || list[0].ID != first.ID {
		t.Errorf("occurrences after archiving: %+v", list)
	}
	if v := e.cellValue(h.ID, 14); v != 1 {
		t.Errorf("mark lost: %d", v)
	}
	if _, err := e.habits.SetPlacement(ctx, e.user, h.ID, habit.Placement{Time: "08:00", DurationMinutes: 10}); !isValidation(err, "time") {
		t.Errorf("an archived habit in the grid: %v", err)
	}
	back, err := e.habits.Archive(ctx, e.user, h.ID, false)
	if err != nil || back.ArchivedAt != nil {
		t.Errorf("unarchive: %+v, %v", back, err)
	}
	if items, _, _ := e.habits.Today(ctx, e.user); len(items) != 1 {
		t.Errorf("an unarchived habit is back in the list: %d", len(items))
	}
}

func TestDeleteRemovesMarksAndTheGridButNotTheDoneOccurrences(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	first := e.occurrences()[0]
	if _, err := e.tasks.Complete(ctx, e.user, first.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.habits.Delete(ctx, e.user, h.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.habits.Get(ctx, e.user, h.ID); !errors.Is(err, habit.ErrNotFound) {
		t.Errorf("get after delete: %v", err)
	}
	list := e.occurrences()
	if len(list) != 1 || list[0].ID != first.ID || list[0].HabitID != nil {
		t.Errorf("occurrences after delete: %+v", list)
	}
}

func TestClearPlacement(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	got, err := e.habits.ClearPlacement(context.Background(), e.user, h.ID)
	if err != nil || got.Placement != nil {
		t.Fatalf("clear: %+v, %v", got, err)
	}
	if n := len(e.occurrences()); n != 0 {
		t.Errorf("occurrences = %d", n)
	}
	// And it can be put back.
	got, err = e.habits.SetPlacement(context.Background(), e.user, h.ID, habit.Placement{Time: "09:00", DurationMinutes: 15})
	if err != nil || got.Placement == nil || got.Placement.Time != "09:00" {
		t.Fatalf("set: %+v, %v", got, err)
	}
	if n := len(e.occurrences()); n != 5 {
		t.Errorf("occurrences = %d", n)
	}
}

func TestTakingTheCreditBackRestoresWhatTheDayHadByHand(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{
		Title: "Вода", Kind: habit.Quantity, Target: 8, Unit: "стаканов",
		Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20},
	})
	in := e.occurrences()[0]
	e.mark(h.ID, day(14), 5)
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 8 {
		t.Fatalf("value after done = %d, want the goal", v)
	}
	planned := "planned"
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: &planned}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 5 {
		t.Errorf("value after un-doing = %d, want the 5 that was there", v)
	}
}

func TestEditingADoneOccurrenceDoesNotResetACorrectedValue(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{
		Title: "Бег", Kind: habit.Quantity, Target: 30, Unit: "мин",
		Placement: &habit.Placement{Time: "07:30", DurationMinutes: 30},
	})
	in := e.occurrences()[0]
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	e.mark(h.ID, day(14), 20) // the real value was lower
	comment := "тяжело"
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Comment: &comment}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 20 {
		t.Errorf("value = %d, the correction was lost", v)
	}
	// Editing the fact of the done occurrence keeps it done and keeps the value too.
	start := at(14, 7, 0).UTC()
	end := at(14, 7, 40).UTC()
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{ActualStart: &start, ActualEnd: &end}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 20 {
		t.Errorf("value after a new fact = %d, want 20", v)
	}
}

func TestACreditIsTakenBackAlsoAfterTheHabitLeftTheGrid(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20}})
	in := e.occurrences()[0]
	if _, err := e.tasks.Complete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := e.habits.ClearPlacement(ctx, e.user, h.ID); err != nil {
		t.Fatal(err)
	}
	// The marked occurrence stays as an ordinary task that has lost its series.
	planned := "planned"
	if _, err := e.tasks.EditTracking(ctx, e.user, in.ID, task.TrackingInput{Status: &planned}); err != nil {
		t.Fatal(err)
	}
	if v := e.cellValue(h.ID, 14); v != 0 {
		t.Errorf("value = %d, the credit of a task that is not done is still there", v)
	}
}

func TestAColorOrGoalChangeLeavesTheGridAlone(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h := e.create(habit.Input{
		Title: "Вода", Kind: habit.Quantity, Target: 8, Unit: "стаканов",
		Placement: &habit.Placement{Time: "07:30", DurationMinutes: 20},
	})
	before := e.occurrences()
	if _, err := e.habits.Update(ctx, e.user, h.ID, habit.Patch{Color: ptr("#ef4444"), Target: ptr(10)}); err != nil {
		t.Fatal(err)
	}
	after := e.occurrences()
	if len(after) != len(before) {
		t.Fatalf("occurrences: %d before, %d after", len(before), len(after))
	}
	for i := range before {
		if before[i].ID != after[i].ID {
			t.Errorf("occurrence %d was made again", i)
		}
	}
	// A change of the title does rewrite them.
	if _, err := e.habits.Update(ctx, e.user, h.ID, habit.Patch{Title: ptr("Вода дома")}); err != nil {
		t.Fatal(err)
	}
	if got := e.occurrences(); len(got) == 0 || got[0].Title != "Вода дома" {
		t.Errorf("title did not reach the grid: %+v", got)
	}
}

func TestMarksBeforeTheYear2000AreRefused(t *testing.T) {
	e := newEnv(t)
	h := e.create(habit.Input{})
	err := e.habits.SetMark(context.Background(), e.user, h.ID, habit.DayOf(1, time.January, 1), 1)
	if !isValidation(err, "date") {
		t.Errorf("err = %v", err)
	}
}

func TestErrorCodesTellWhyAHabitCannotBeInTheGrid(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	weekly := e.create(habit.Input{Schedule: habit.Schedule{Frequency: habit.TimesPerWeek, TimesPerWeek: 2}})
	var v *validation.Error
	_, err := e.habits.SetPlacement(ctx, e.user, weekly.ID, habit.Placement{Time: "07:00", DurationMinutes: 10})
	if !errors.As(err, &v) || v.ErrorCode() != habit.CodeWeeklyInGrid {
		t.Errorf("weekly: %v", err)
	}
	daily := e.create(habit.Input{})
	if _, err := e.habits.Archive(ctx, e.user, daily.ID, true); err != nil {
		t.Fatal(err)
	}
	_, err = e.habits.SetPlacement(ctx, e.user, daily.ID, habit.Placement{Time: "07:00", DurationMinutes: 10})
	if !errors.As(err, &v) || v.ErrorCode() != habit.CodeArchived {
		t.Errorf("archived: %v", err)
	}
	// An incomplete schedule keeps the generic code.
	_, err = e.habits.Create(ctx, e.user, habit.Input{Title: "a", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Weekdays}})
	if !errors.As(err, &v) || v.ErrorCode() != validation.CodeFailed || v.Field != "frequency" {
		t.Errorf("incomplete: %v", err)
	}
}
