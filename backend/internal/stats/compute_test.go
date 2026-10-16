package stats

import (
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
)

var msk, _ = time.LoadLocation("Europe/Moscow")

// at is a Moscow wall time on 2026-10-DD.
func at(day, h, m int) time.Time { return time.Date(2026, 10, day, h, m, 0, 0, msk) }

func ptr[T any](v T) *T { return &v }

var (
	sport, run, swim, work = uuid.New(), uuid.New(), uuid.New(), uuid.New()
	archived               = uuid.New()
)

var categories = []category.Category{
	{ID: sport, Name: "Спорт"},
	{ID: run, Name: "Бег", ParentID: &sport},
	{ID: swim, Name: "Плавание", ParentID: &sport},
	{ID: work, Name: "Работа"},
	{ID: archived, Name: "Старое", ParentID: &work, ArchivedAt: ptr(at(1, 0, 0))},
}

type opt func(*task.Instance)

func cats(ids ...uuid.UUID) opt { return func(i *task.Instance) { i.CategoryIDs = ids } }
func title(t string) opt        { return func(i *task.Instance) { i.Title = t } }
func comment(c string) opt      { return func(i *task.Instance) { i.Comment = c } }
func devs(d ...task.Deviation) opt {
	return func(i *task.Instance) { i.Deviations = d }
}

// planned is a task planned for [start, end) that was done exactly as planned.
func done(start, end time.Time, o ...opt) task.Instance {
	in := task.Instance{
		ID: uuid.New(), Title: "Дело", Status: "done",
		PlannedStart: &start, PlannedEnd: &end, ActualStart: &start, ActualEnd: &end,
	}
	for _, f := range o {
		f(&in)
	}
	return in
}

// withFact replaces the fact of a task.
func withFact(in task.Instance, start, end time.Time) task.Instance {
	in.ActualStart, in.ActualEnd = &start, &end
	return in
}

func planned(start, end time.Time, o ...opt) task.Instance {
	in := task.Instance{ID: uuid.New(), Title: "Дело", Status: "planned", PlannedStart: &start, PlannedEnd: &end}
	for _, f := range o {
		f(&in)
	}
	return in
}

func unplanned(start, end time.Time, o ...opt) task.Instance {
	in := task.Instance{ID: uuid.New(), Title: "Вне плана", Status: "done", ActualStart: &start, ActualEnd: &end}
	for _, f := range o {
		f(&in)
	}
	return in
}

var now = at(14, 12, 0)

func compute(instances ...task.Instance) Report {
	return Compute(Input{
		Instances: instances, Categories: categories,
		From: at(14, 0, 0), To: at(15, 0, 0), Now: now, Loc: msk,
	})
}

func catMinutes(r Report) map[string]int {
	names := map[uuid.UUID]string{}
	for _, c := range categories {
		names[c.ID] = c.Name
	}
	out := map[string]int{}
	for _, c := range r.Categories {
		out[names[c.CategoryID]] = c.Minutes
	}
	return out
}

func TestTheExampleOfTheRequirements(t *testing.T) {
	// One hour with the categories Бег and Плавание (both inside Спорт): 1 h each and 1 h in Спорт, not 2 h.
	r := compute(done(at(14, 9, 0), at(14, 10, 0), cats(run, swim)))
	got := catMinutes(r)
	if fmt.Sprint(got) != fmt.Sprint(map[string]int{"Спорт": 60, "Бег": 60, "Плавание": 60}) {
		t.Errorf("categories = %v", got)
	}
	if r.ActualMinutes != 60 {
		t.Errorf("busy time = %d, want 60", r.ActualMinutes)
	}
}

func TestACategoryAndItsAncestorCountOnce(t *testing.T) {
	// A task in both Спорт and Бег: Спорт would be reached twice (itself and as the parent of Бег).
	r := compute(done(at(14, 9, 0), at(14, 10, 0), cats(sport, run)))
	if got := catMinutes(r); got["Спорт"] != 60 || got["Бег"] != 60 {
		t.Errorf("categories = %v", got)
	}
}

func TestTasksWithoutACategory(t *testing.T) {
	r := compute(done(at(14, 9, 0), at(14, 9, 30)), done(at(14, 10, 0), at(14, 10, 15), cats(work)))
	if r.UncategorizedMinutes != 30 || catMinutes(r)["Работа"] != 15 || len(r.Categories) != 1 {
		t.Errorf("uncategorized = %d, categories = %v", r.UncategorizedMinutes, catMinutes(r))
	}
}

func TestArchivedCategoriesStayInTheHistory(t *testing.T) {
	r := compute(done(at(14, 9, 0), at(14, 10, 0), cats(archived)))
	if got := catMinutes(r); got["Старое"] != 60 || got["Работа"] != 60 {
		t.Errorf("categories = %v", got)
	}
}

func TestParallelTasksAddUpPerCategoryButNotInTheBusyTime(t *testing.T) {
	r := compute(
		done(at(14, 9, 0), at(14, 10, 0), cats(run)),
		done(at(14, 9, 30), at(14, 10, 30), cats(run)),
	)
	if got := catMinutes(r)["Бег"]; got != 120 {
		t.Errorf("Бег = %d, want the sum 120", got)
	}
	if r.ActualMinutes != 90 { // 09:00-10:30
		t.Errorf("busy time = %d, want the union 90 (FR-8.3)", r.ActualMinutes)
	}
	if r.Days[0].Minutes != 90 {
		t.Errorf("busy time of the day = %d, want 90", r.Days[0].Minutes)
	}
}

func TestTouchingTasksAreNotMerged(t *testing.T) {
	r := compute(done(at(14, 9, 0), at(14, 10, 0)), done(at(14, 10, 0), at(14, 11, 0)))
	if r.ActualMinutes != 120 {
		t.Errorf("busy time = %d", r.ActualMinutes)
	}
}

func TestOnlyTheFactCounts(t *testing.T) {
	// Planned 10:00-11:00, really 10:20-11:30.
	in := withFact(done(at(14, 10, 0), at(14, 11, 0), cats(work)), at(14, 10, 20), at(14, 11, 30))
	r := compute(in)
	if r.ActualMinutes != 70 || catMinutes(r)["Работа"] != 70 {
		t.Errorf("fact = %d, category = %v", r.ActualMinutes, catMinutes(r))
	}
	if r.PlannedMinutes != 60 {
		t.Errorf("planned = %d", r.PlannedMinutes)
	}
}

func TestNotMarkedAndNotDoneTasksAreNotInTheFact(t *testing.T) {
	notDone := planned(at(14, 8, 0), at(14, 9, 0))
	notDone.Status = "not_done"
	r := compute(planned(at(14, 9, 0), at(14, 10, 0)), notDone)
	if r.ActualMinutes != 0 || len(r.Categories) != 0 || len(r.Tasks) != 0 {
		t.Errorf("report = %+v", r)
	}
	// Both are in the plan.
	if r.PlannedMinutes != 120 {
		t.Errorf("planned = %d", r.PlannedMinutes)
	}
	if r.PlanVsFact.Unmarked != 1 || r.PlanVsFact.NotDone != 1 {
		t.Errorf("plan vs fact = %+v", r.PlanVsFact)
	}
}

func TestRescheduledOriginalIsNotInThePlanButItsReplacementIs(t *testing.T) {
	orig := planned(at(14, 9, 0), at(14, 10, 0))
	orig.Status = "rescheduled"
	replacement := planned(at(14, 15, 0), at(14, 17, 0))
	r := compute(orig, replacement)
	if r.PlannedMinutes != 120 {
		t.Errorf("planned = %d, want only the replacement's 120", r.PlannedMinutes)
	}
	if r.PlanVsFact.Rescheduled != 1 || r.PlanVsFact.PlannedCount != 1 {
		t.Errorf("plan vs fact = %+v", r.PlanVsFact)
	}
}

func TestCancelledTasksAreNotCounted(t *testing.T) {
	c := planned(at(14, 9, 0), at(14, 10, 0))
	c.Status = "cancelled"
	r := compute(c)
	if r.PlannedMinutes != 0 || r.PlanVsFact.PlannedCount != 0 || r.PlanVsFact.Rescheduled != 0 {
		t.Errorf("report = %+v", r)
	}
}

func TestUnplannedTimeIsInTheFactAndShownSeparately(t *testing.T) {
	r := compute(
		done(at(14, 9, 0), at(14, 10, 0), cats(work)),
		unplanned(at(14, 11, 0), at(14, 11, 30), cats(work)),
	)
	if r.ActualMinutes != 90 || r.UnplannedMinutes != 30 || r.UnplannedCount != 1 {
		t.Errorf("actual = %d, unplanned = %d (%d tasks)", r.ActualMinutes, r.UnplannedMinutes, r.UnplannedCount)
	}
	if catMinutes(r)["Работа"] != 90 {
		t.Errorf("categories = %v", catMinutes(r))
	}
	// An unplanned task has no plan: not in the planned hours and not in the counts of planned tasks.
	if r.PlannedMinutes != 60 || r.PlanVsFact.PlannedCount != 1 {
		t.Errorf("planned = %d, plan vs fact = %+v", r.PlannedMinutes, r.PlanVsFact)
	}
}

func TestARunningTimerCountsUntilNowAndIsCapped(t *testing.T) {
	// Started 11:00, now 12:00: one hour so far.
	short := task.Instance{ID: uuid.New(), Title: "Идёт", Status: "in_progress", ActualStart: ptr(at(14, 11, 0))}
	r := compute(short)
	if r.ActualMinutes != 60 || r.LongRunning != 0 {
		t.Errorf("actual = %d, long running = %d", r.ActualMinutes, r.LongRunning)
	}

	// Started 14 hours ago and never stopped: only the first 12 hours count.
	forgotten := task.Instance{ID: uuid.New(), Title: "Забыл", Status: "in_progress", ActualStart: ptr(at(13, 22, 0))}
	r = Compute(Input{
		Instances: []task.Instance{forgotten}, Categories: categories,
		From: at(13, 0, 0), To: at(15, 0, 0), Now: now, Loc: msk,
	})
	if r.ActualMinutes != 12*60 || r.LongRunning != 1 {
		t.Errorf("actual = %d, long running = %d, want 720 and 1", r.ActualMinutes, r.LongRunning)
	}
	// 22:00 on the 13th + 12 h = 10:00 on the 14th: the days split it 2 h / 10 h.
	if r.Days[0].Minutes != 120 || r.Days[1].Minutes != 600 {
		t.Errorf("days = %+v", r.Days)
	}
}

func TestATimerStartedInTheFutureCountsNothing(t *testing.T) {
	r := compute(task.Instance{ID: uuid.New(), Title: "Позже", Status: "in_progress", ActualStart: ptr(at(14, 13, 0))})
	if r.ActualMinutes != 0 {
		t.Errorf("actual = %d", r.ActualMinutes)
	}
}

func TestThePeriodClipsTasks(t *testing.T) {
	// 23:00 on the 14th to 01:00 on the 15th: one hour belongs to the period [14th, 15th).
	r := compute(done(at(14, 23, 0), at(15, 1, 0), cats(work)))
	if r.ActualMinutes != 60 || catMinutes(r)["Работа"] != 60 {
		t.Errorf("actual = %d, categories = %v", r.ActualMinutes, catMinutes(r))
	}
	// Entirely outside: nothing.
	if r := compute(done(at(13, 9, 0), at(13, 10, 0))); r.ActualMinutes != 0 || len(r.Tasks) != 0 {
		t.Errorf("a task outside the period was counted: %+v", r)
	}
}

func TestTasksAreGroupedByTitle(t *testing.T) {
	r := compute(
		done(at(14, 9, 0), at(14, 9, 30), title("Спорт")),
		done(at(14, 10, 0), at(14, 11, 0), title("Спорт")),
		done(at(14, 12, 0), at(14, 12, 10), title("Почта")),
	)
	if len(r.Tasks) != 2 || r.Tasks[0] != (TaskGroup{Title: "Спорт", Count: 2, Minutes: 90}) || r.Tasks[1] != (TaskGroup{Title: "Почта", Count: 1, Minutes: 10}) {
		t.Errorf("tasks = %+v", r.Tasks)
	}
}

func TestTheBreakdownByDay(t *testing.T) {
	r := Compute(Input{
		Instances: []task.Instance{
			done(at(14, 9, 0), at(14, 10, 0), cats(run, work)), // the color category is the first by name: Бег
			done(at(15, 22, 0), at(16, 2, 0)),                  // across midnight, no category
			done(at(17, 9, 0), at(17, 9, 30), cats(work)),
		},
		Categories: categories,
		From:       at(14, 0, 0), To: at(18, 0, 0), Now: at(18, 0, 0), Loc: msk,
	})
	if len(r.Days) != 4 {
		t.Fatalf("%d days", len(r.Days))
	}
	want := []struct {
		date    string
		minutes int
	}{{"2026-10-14", 60}, {"2026-10-15", 120}, {"2026-10-16", 120}, {"2026-10-17", 30}}
	for i, w := range want {
		if r.Days[i].Date != w.date || r.Days[i].Minutes != w.minutes {
			t.Errorf("day %d = %s %d min, want %s %d", i, r.Days[i].Date, r.Days[i].Minutes, w.date, w.minutes)
		}
	}
	if d := r.Days[0].ByCategory; len(d) != 1 || d[0].CategoryID != run || d[0].Minutes != 60 {
		t.Errorf("14th by category = %+v, want one entry for Бег (a task counts once in the chart)", d)
	}
	if d := r.Days[1].ByCategory; len(d) != 1 || d[0].CategoryID != uuid.Nil || d[0].Minutes != 120 {
		t.Errorf("15th by category = %+v", d)
	}
}

func TestADayThatIsOneHourLongerWhenTheClocksGoBack(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	day := func(d, h int) time.Time { return time.Date(2026, 11, d, h, 0, 0, 0, ny) }
	// The clocks go back on 2026-11-01: that local day is 25 hours long.
	whole := task.Instance{ID: uuid.New(), Title: "Весь день", Status: "done", ActualStart: ptr(day(1, 0)), ActualEnd: ptr(day(2, 0))}
	r := Compute(Input{
		Instances: []task.Instance{whole}, From: day(1, 0), To: day(3, 0), Now: day(3, 0), Loc: ny,
	})
	if len(r.Days) != 2 || r.Days[0].Date != "2026-11-01" || r.Days[0].Minutes != 25*60 || r.Days[1].Minutes != 0 {
		t.Errorf("days = %+v", r.Days)
	}
	if r.ActualMinutes != 25*60 {
		t.Errorf("actual = %d", r.ActualMinutes)
	}
}

func TestDaysFollowTheLocalTimeZoneNotUTC(t *testing.T) {
	// 23:30-00:30 Moscow is 20:30-21:30 UTC, all on the 14th UTC; locally it is split at midnight.
	r := Compute(Input{
		Instances: []task.Instance{done(at(14, 23, 30), at(15, 0, 30))},
		From:      at(14, 0, 0), To: at(16, 0, 0), Now: at(16, 0, 0), Loc: msk,
	})
	if r.Days[0].Minutes != 30 || r.Days[1].Minutes != 30 {
		t.Errorf("days = %+v", r.Days)
	}
}

func TestPlanVersusFact(t *testing.T) {
	onTime := done(at(14, 8, 0), at(14, 9, 0))
	late := withFact(done(at(14, 9, 0), at(14, 10, 0), devs(
		task.Deviation{Kind: task.StartedLate, Minutes: 20}, task.Deviation{Kind: task.FinishedLate, Minutes: 20})),
		at(14, 9, 20), at(14, 10, 20))
	partial := withFact(done(at(14, 10, 0), at(14, 11, 0)), at(14, 10, 0), at(14, 10, 30))
	partial.Status = "partial"
	notDone := planned(at(14, 7, 0), at(14, 8, 0), comment("заболел"))
	notDone.Status = "not_done"
	forgotten := planned(at(14, 6, 0), at(14, 7, 0))
	running := task.Instance{ID: uuid.New(), Title: "Идёт", Status: "in_progress",
		PlannedStart: ptr(at(14, 11, 0)), PlannedEnd: ptr(at(14, 13, 0)), ActualStart: ptr(at(14, 11, 0))}
	upcoming := planned(at(14, 15, 0), at(14, 16, 0))
	moved := planned(at(14, 5, 0), at(14, 5, 30), comment("совещание"))
	moved.Status = "rescheduled"

	r := compute(onTime, late, partial, notDone, forgotten, running, upcoming, moved)
	pf := r.PlanVsFact
	if pf.PlannedCount != 7 || pf.Done != 2 || pf.Partial != 1 || pf.NotDone != 1 || pf.Unmarked != 1 ||
		pf.InProgress != 1 || pf.Upcoming != 1 || pf.Rescheduled != 1 {
		t.Errorf("plan vs fact = %+v", pf)
	}
	if pf.LateStarts != 1 || pf.Overran != 1 {
		t.Errorf("late = %d, overran = %d", pf.LateStarts, pf.Overran)
	}
	// 2 done out of the 5 that are decided: done 2, partial 1, not done 1, unmarked 1.
	if pf.PercentDone == nil || *pf.PercentDone != 40 {
		t.Errorf("percent done = %v, want 40", pf.PercentDone)
	}
}

func TestPercentDoneNeedsADecidedTask(t *testing.T) {
	if r := compute(planned(at(14, 15, 0), at(14, 16, 0))); r.PlanVsFact.PercentDone != nil {
		t.Errorf("percent = %d with nothing decided", *r.PlanVsFact.PercentDone)
	}
	if r := compute(); r.PlanVsFact.PercentDone != nil {
		t.Error("percent for an empty period")
	}
	if r := compute(done(at(14, 9, 0), at(14, 10, 0))); r.PlanVsFact.PercentDone == nil || *r.PlanVsFact.PercentDone != 100 {
		t.Errorf("percent = %v", r.PlanVsFact.PercentDone)
	}
}

func TestDeviationsListHasTheTasksThatNeedAnExplanation(t *testing.T) {
	onTime := done(at(14, 8, 0), at(14, 9, 0))
	late := done(at(14, 9, 0), at(14, 10, 0), comment("пробки"), devs(task.Deviation{Kind: task.StartedLate, Minutes: 25}))
	notDone := planned(at(14, 7, 0), at(14, 8, 0), comment("заболел"))
	notDone.Status = "not_done"
	plainNotDone := planned(at(14, 6, 0), at(14, 7, 0))
	plainNotDone.Status = "not_done" // no comment, no deviation: nothing to explain in the list
	moved := planned(at(14, 5, 0), at(14, 5, 30), comment("совещание"))
	moved.Status = "rescheduled"

	r := compute(late, onTime, notDone, plainNotDone, moved)
	var comments []string
	for _, d := range r.Deviations {
		comments = append(comments, d.Instance.Comment)
	}
	// Ordered by the planned start.
	if fmt.Sprint(comments) != "[совещание заболел пробки]" {
		t.Errorf("deviations = %v", comments)
	}
}

func TestEmptyPeriod(t *testing.T) {
	r := compute()
	if r.ActualMinutes != 0 || r.PlannedMinutes != 0 || len(r.Categories) != 0 || len(r.Tasks) != 0 || len(r.Deviations) != 0 {
		t.Errorf("report = %+v", r)
	}
	if len(r.Days) != 1 || r.Days[0].Minutes != 0 {
		t.Errorf("days = %+v", r.Days)
	}
}

func TestACycleInTheTreeCannotHang(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	loop := []category.Category{{ID: a, Name: "A", ParentID: &b}, {ID: b, Name: "B", ParentID: &a}}
	r := Compute(Input{
		Instances: []task.Instance{done(at(14, 9, 0), at(14, 10, 0), cats(a))}, Categories: loop,
		From: at(14, 0, 0), To: at(15, 0, 0), Now: now, Loc: msk,
	})
	if len(r.Categories) != 2 {
		t.Errorf("categories = %+v", r.Categories)
	}
}

func TestUnionSeconds(t *testing.T) {
	iv := func(a, b int) interval { return interval{at(14, a, 0), at(14, b, 0)} }
	for name, tc := range map[string]struct {
		in   []interval
		want float64
	}{
		"empty":    {nil, 0},
		"one":      {[]interval{iv(9, 10)}, 3600},
		"disjoint": {[]interval{iv(9, 10), iv(11, 12)}, 7200},
		"overlap":  {[]interval{iv(9, 11), iv(10, 12)}, 10800},
		"nested":   {[]interval{iv(9, 12), iv(10, 11)}, 10800},
		"unsorted": {[]interval{iv(11, 12), iv(9, 10), iv(9, 11)}, 10800},
		"touching": {[]interval{iv(9, 10), iv(10, 11)}, 7200},
		"same":     {[]interval{iv(9, 10), iv(9, 10), iv(9, 10)}, 3600},
	} {
		if got := unionSeconds(tc.in); got != tc.want {
			t.Errorf("%s: %v, want %v", name, got, tc.want)
		}
	}
}
