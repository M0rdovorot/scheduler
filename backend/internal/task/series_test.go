package task_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

// seriesEnv is an env whose user lives in Moscow (UTC+3, no daylight saving).
func newSeriesEnv(t *testing.T) *env {
	return newSeriesEnvIn(t, "Europe/Moscow")
}

func newSeriesEnvIn(t *testing.T, tz string) *env {
	t.Helper()
	e := newEnv(t)
	if _, err := e.pool.Exec(context.Background(), `UPDATE users SET timezone = $1`, tz); err != nil {
		t.Fatal(err)
	}
	return e
}

func local(t *testing.T, tz string, y int, m time.Month, d, h, mi int) time.Time {
	t.Helper()
	loc, err := time.LoadLocation(tz)
	if err != nil {
		t.Fatal(err)
	}
	return time.Date(y, m, d, h, mi, 0, 0, loc)
}

func msk(t *testing.T, y int, m time.Month, d, h, mi int) time.Time {
	return local(t, "Europe/Moscow", y, m, d, h, mi)
}

// createSeries creates a series whose first slot is 2026-10-14 (a Wednesday), 09:00-10:00 Moscow.
func (e *env) createSeries(rule string, cats ...uuid.UUID) task.Instance {
	e.t.Helper()
	in, err := e.svc.Create(context.Background(), e.user, task.CreateInput{
		Title: "Планёрка", PlannedStart: msk(e.t, 2026, 10, 14, 9, 0), PlannedEnd: msk(e.t, 2026, 10, 14, 10, 0),
		CategoryIDs: cats, Recurrence: &rule,
	})
	if err != nil {
		e.t.Fatalf("create series %q: %v", rule, err)
	}
	return in
}

func (e *env) list(from, to time.Time) []task.Instance {
	e.t.Helper()
	list, err := e.svc.List(context.Background(), e.user, from, to)
	if err != nil {
		e.t.Fatal(err)
	}
	return list
}

// days lists the local start of each task as "Mon 01-02 15:04" in the zone.
func days(list []task.Instance, tz string) []string {
	loc, _ := time.LoadLocation(tz)
	out := make([]string, len(list))
	for i, in := range list {
		out[i] = in.PlannedStart.In(loc).Format("Mon 01-02 15:04")
	}
	return out
}

func equal(t *testing.T, got, want []string) {
	t.Helper()
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}

func (e *env) rowCount(where string, args ...any) int {
	e.t.Helper()
	var n int
	if err := e.pool.QueryRow(context.Background(), "SELECT count(*) FROM task_instances WHERE "+where, args...).Scan(&n); err != nil {
		e.t.Fatal(err)
	}
	return n
}

func TestCreateSeriesReturnsTheFirstOccurrence(t *testing.T) {
	e := newSeriesEnv(t)
	cat := e.category(e.user, "Работа")
	first := e.createSeries("FREQ=WEEKLY;BYDAY=MO,WE", cat)

	if first.SeriesID == nil || first.Title != "Планёрка" {
		t.Fatalf("first = %+v", first)
	}
	equal(t, days([]task.Instance{first}, "Europe/Moscow"), []string{"Wed 10-14 09:00"})
	if !first.PlannedEnd.Equal(msk(t, 2026, 10, 14, 10, 0)) || len(first.CategoryIDs) != 1 {
		t.Errorf("first = %+v", first)
	}

	series, err := e.svc.GetSeries(context.Background(), e.user, *first.SeriesID)
	if err != nil {
		t.Fatal(err)
	}
	if series.RRule != "FREQ=WEEKLY;BYDAY=MO,WE" || series.StartLocal != "2026-10-14T09:00" ||
		series.Timezone != "Europe/Moscow" || series.DurationMinutes != 60 || len(series.CategoryIDs) != 1 {
		t.Errorf("series = %+v", series)
	}
}

func TestSeriesStartingOnAnotherWeekdayBeginsAtTheNextMatch(t *testing.T) {
	e := newSeriesEnv(t)
	first := e.createSeries("FREQ=WEEKLY;BYDAY=MO") // the slot is a Wednesday
	equal(t, days([]task.Instance{first}, "Europe/Moscow"), []string{"Mon 10-19 09:00"})
}

func TestListCreatesOccurrencesLazilyAndOnce(t *testing.T) {
	e := newSeriesEnv(t)
	e.createSeries("FREQ=DAILY")
	if n := e.rowCount("true"); n != 1 {
		t.Fatalf("%d rows right after creating a series, want only the first occurrence", n)
	}

	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{"Wed 10-14 09:00", "Thu 10-15 09:00", "Fri 10-16 09:00"})
	if n := e.rowCount("true"); n != 3 {
		t.Errorf("%d rows after listing three days, want 3", n)
	}

	// Asking again changes nothing; a bigger window adds only what is missing.
	e.list(from, to)
	e.list(from, msk(t, 2026, 10, 19, 0, 0))
	if n := e.rowCount("true"); n != 5 {
		t.Errorf("%d rows, want 5 (no duplicates)", n)
	}
}

func TestAnyWindowWorksWithoutGeneratingTheGapBetween(t *testing.T) {
	e := newSeriesEnv(t)
	e.createSeries("FREQ=DAILY")

	// Half a year ahead, and nothing in between has been created.
	got := e.list(msk(t, 2027, 4, 1, 0, 0), msk(t, 2027, 4, 3, 0, 0))
	equal(t, days(got, "Europe/Moscow"), []string{"Thu 04-01 09:00", "Fri 04-02 09:00"})
	if n := e.rowCount("true"); n != 3 { // the first occurrence plus the two asked for
		t.Errorf("%d rows, want 3", n)
	}
	// Before the start of the series there is nothing.
	if got := e.list(msk(t, 2026, 9, 1, 0, 0), msk(t, 2026, 9, 10, 0, 0)); len(got) != 0 {
		t.Errorf("occurrences before the start: %v", days(got, "Europe/Moscow"))
	}
}

func TestOccurrenceOverlappingTheWindowEdgeIsIncluded(t *testing.T) {
	e := newSeriesEnv(t)
	in, err := e.svc.Create(context.Background(), e.user, task.CreateInput{
		Title: "Ночь", PlannedStart: msk(t, 2026, 10, 14, 22, 0), PlannedEnd: msk(t, 2026, 10, 15, 6, 0),
		Recurrence: ptr("FREQ=DAILY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = in
	// The occurrence that began on the 15th at 22:00 is still running at 02:00 on the 16th.
	got := e.list(msk(t, 2026, 10, 16, 0, 0), msk(t, 2026, 10, 16, 12, 0))
	equal(t, days(got, "Europe/Moscow"), []string{"Thu 10-15 22:00"})
}

func TestOccurrencesInheritTheCategoriesOfTheSeries(t *testing.T) {
	e := newSeriesEnv(t)
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")
	e.createSeries("FREQ=DAILY", work, sport)

	for _, in := range e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)) {
		if len(in.CategoryIDs) != 2 {
			t.Errorf("%v has categories %v", in.PlannedStart, in.CategoryIDs)
		}
	}
}

func TestSeriesCreateValidation(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	base := task.CreateInput{Title: "x", PlannedStart: msk(t, 2026, 10, 14, 9, 0), PlannedEnd: msk(t, 2026, 10, 14, 10, 0)}

	for name, tc := range map[string]struct {
		rule  string
		edit  func(*task.CreateInput)
		field string
		code  string
	}{
		"hourly":          {rule: "FREQ=HOURLY", field: "recurrence"},
		"garbage":         {rule: "every day", field: "recurrence"},
		"count and until": {rule: "FREQ=DAILY;COUNT=2;UNTIL=20261231T000000Z", field: "recurrence"},
		"ends before it starts": {
			rule: "FREQ=DAILY;UNTIL=20260101T000000Z", field: "recurrence", code: task.CodeNoOccurrences,
		},
		"seconds in the duration": {
			rule: "FREQ=DAILY", field: "planned_end",
			edit: func(in *task.CreateInput) { in.PlannedEnd = in.PlannedEnd.Add(30 * time.Second) },
		},
		"seconds in the start": {
			rule: "FREQ=DAILY", field: "planned_start",
			edit: func(in *task.CreateInput) {
				in.PlannedStart = in.PlannedStart.Add(time.Second)
				in.PlannedEnd = in.PlannedEnd.Add(time.Second)
			},
		},
	} {
		t.Run(name, func(t *testing.T) {
			in := base
			in.Recurrence = ptr(tc.rule)
			if tc.edit != nil {
				tc.edit(&in)
			}
			_, err := e.svc.Create(ctx, e.user, in)
			var verr *validation.Error
			if !errors.As(err, &verr) || verr.Field != tc.field {
				t.Fatalf("err = %v, want a validation error on %q", err, tc.field)
			}
			if tc.code != "" && verr.ErrorCode() != tc.code {
				t.Errorf("code = %q, want %q", verr.ErrorCode(), tc.code)
			}
		})
	}
	if n := e.rowCount("true"); n != 0 {
		t.Errorf("%d rows were left behind by refused creates", n)
	}
}

func TestDeletingOneOccurrenceKeepsItDeleted(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)
	list := e.list(from, to)

	if err := e.svc.Delete(ctx, e.user, list[1].ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{"Wed 10-14 09:00", "Fri 10-16 09:00", "Sat 10-17 09:00"})
	// The row stays as cancelled; asking for the window again does not bring it back.
	if n := e.rowCount("status = 'cancelled'"); n != 1 {
		t.Errorf("%d cancelled rows, want 1", n)
	}
	e.list(from, to)
	e.list(from.Add(-24*time.Hour), to.Add(24*time.Hour))
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{"Wed 10-14 09:00", "Fri 10-16 09:00", "Sat 10-17 09:00"})
}

func TestEditingOneOccurrenceDetachesIt(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	list := e.list(from, to)

	moved := msk(t, 2026, 10, 15, 18, 0)
	got, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeThis, task.UpdateInput{
		Title: ptr("Особая"), PlannedStart: &moved, PlannedEnd: ptr(moved.Add(30 * time.Minute)),
	})
	if err != nil || got == nil || got.Title != "Особая" || got.SeriesID == nil {
		t.Fatalf("Update = %+v, %v", got, err)
	}
	if n := e.rowCount("is_detached"); n != 1 {
		t.Errorf("%d detached rows, want 1", n)
	}

	// An edit of the whole series leaves the detached occurrence alone.
	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Title: ptr("Общая")}); err != nil {
		t.Fatal(err)
	}
	byTitle := map[string]int{}
	for _, in := range e.list(from, to) {
		byTitle[in.Title]++
	}
	if byTitle["Особая"] != 1 || byTitle["Общая"] != 2 || len(byTitle) != 2 {
		t.Errorf("titles = %v", byTitle)
	}
	// Edited occurrences are not created again either: the detached row still owns its slot.
	if n := e.rowCount("series_id IS NOT NULL"); n != 3 {
		t.Errorf("%d rows, want 3", n)
	}
}

func TestEditAllRewritesTemplateAndKeepsDetachedAndCancelled(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")
	e.createSeries("FREQ=DAILY", work)
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 20, 0, 0)
	list := e.list(from, to) // 14..19

	if err := e.svc.Delete(ctx, e.user, list[2].ID, task.ScopeThis); err != nil { // the 16th: cancelled
		t.Fatal(err)
	}
	if _, err := e.svc.Update(ctx, e.user, list[3].ID, task.ScopeThis, task.UpdateInput{Title: ptr("Особая")}); err != nil { // the 17th: detached
		t.Fatal(err)
	}

	got, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeAll, task.UpdateInput{
		Title: ptr("Общая"), Description: ptr("новое"), CategoryIDs: &[]uuid.UUID{sport},
	})
	if err != nil || got != nil {
		t.Fatalf("Update(all) = %v, %v; want nil, nil", got, err)
	}

	after := e.list(from, to)
	equal(t, days(after, "Europe/Moscow"), []string{"Wed 10-14 09:00", "Thu 10-15 09:00", "Sat 10-17 09:00", "Sun 10-18 09:00", "Mon 10-19 09:00"})
	for _, in := range after {
		switch in.Title {
		case "Общая":
			if in.Description != "новое" || len(in.CategoryIDs) != 1 || in.CategoryIDs[0] != sport {
				t.Errorf("%v was not rewritten: %+v", in.PlannedStart, in)
			}
		case "Особая":
			if in.Description != "" || len(in.CategoryIDs) != 1 || in.CategoryIDs[0] != work {
				t.Errorf("the detached occurrence changed: %+v", in)
			}
		default:
			t.Errorf("unexpected title %q", in.Title)
		}
	}
	// The deleted occurrence did not come back.
	if n := e.rowCount("status = 'cancelled'"); n != 1 {
		t.Errorf("%d cancelled rows, want 1", n)
	}
}

func TestEditAllChangesTimeOfDayAndDurationNotTheDate(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	list := e.list(from, to)

	// Occurrence of the 15th: 09:00-10:00 becomes 11:30-13:00. The series follows.
	start := msk(t, 2026, 10, 15, 11, 30)
	if _, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeAll, task.UpdateInput{
		PlannedStart: &start, PlannedEnd: ptr(msk(t, 2026, 10, 15, 13, 0)),
	}); err != nil {
		t.Fatal(err)
	}
	got := e.list(from, to)
	equal(t, days(got, "Europe/Moscow"), []string{"Wed 10-14 11:30", "Thu 10-15 11:30", "Fri 10-16 11:30"})
	for _, in := range got {
		if in.PlannedEnd.Sub(in.PlannedStart) != 90*time.Minute {
			t.Errorf("duration of %v = %v", in.PlannedStart, in.PlannedEnd.Sub(in.PlannedStart))
		}
	}

	// Moving the occurrence to another day is not an edit of the series.
	other := msk(t, 2026, 10, 16, 11, 30)
	for _, scope := range []task.Scope{task.ScopeAll, task.ScopeFollowing} {
		_, err := e.svc.Update(ctx, e.user, got[1].ID, scope, task.UpdateInput{PlannedStart: &other, PlannedEnd: ptr(other.Add(time.Hour))})
		var verr *validation.Error
		if !errors.As(err, &verr) || verr.ErrorCode() != task.CodeSeriesDateChange {
			t.Errorf("scope %s: err = %v, want the %s error", scope, err, task.CodeSeriesDateChange)
		}
	}
	// With the occurrence only, the date can change.
	if _, err := e.svc.Update(ctx, e.user, got[1].ID, task.ScopeThis, task.UpdateInput{PlannedStart: &other, PlannedEnd: ptr(other.Add(time.Hour))}); err != nil {
		t.Errorf("moving one occurrence: %v", err)
	}
}

func TestEditAllChangesTheRule(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 29, 0, 0)
	list := e.list(from, to)

	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Recurrence: ptr("FREQ=WEEKLY;BYDAY=WE")}); err != nil {
		t.Fatal(err)
	}
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{"Wed 10-14 09:00", "Wed 10-21 09:00", "Wed 10-28 09:00"})

	// An edit of the whole series re-creates the planned occurrences, so ids must be read again.
	list = e.list(from, to)
	// A rule that no longer has occurrences is refused, and the series stays as it was.
	_, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Recurrence: ptr("FREQ=DAILY;UNTIL=20200101T000000Z")})
	var verr *validation.Error
	if !errors.As(err, &verr) || verr.ErrorCode() != task.CodeNoOccurrences {
		t.Errorf("err = %v, want %s", err, task.CodeNoOccurrences)
	}
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{"Wed 10-14 09:00", "Wed 10-21 09:00", "Wed 10-28 09:00"})

	// The rule cannot be changed for one occurrence.
	_, err = e.svc.Update(ctx, e.user, list[0].ID, task.ScopeThis, task.UpdateInput{Recurrence: ptr("FREQ=DAILY")})
	if !errors.As(err, &verr) || verr.Field != "recurrence" {
		t.Errorf("err = %v", err)
	}
}

func TestEditFollowingSplitsTheSeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 24, 0, 0)
	list := e.list(from, to) // 14..23

	start := msk(t, 2026, 10, 18, 20, 0)
	if _, err := e.svc.Update(ctx, e.user, list[4].ID, task.ScopeFollowing, task.UpdateInput{
		Title: ptr("Новая"), PlannedStart: &start, PlannedEnd: ptr(start.Add(45 * time.Minute)),
	}); err != nil {
		t.Fatal(err)
	}

	after := e.list(from, to)
	if len(after) != 10 {
		t.Fatalf("%d tasks, want 10: %v", len(after), days(after, "Europe/Moscow"))
	}
	for i, in := range after {
		old := i < 4 // 14..17 stay as they were
		if old && (in.Title != "Планёрка" || in.PlannedStart.In(time.UTC).Hour() != 6) {
			t.Errorf("%d: an earlier occurrence changed: %+v", i, in)
		}
		if !old && (in.Title != "Новая" || in.PlannedEnd.Sub(in.PlannedStart) != 45*time.Minute) {
			t.Errorf("%d: a following occurrence did not change: %+v", i, in)
		}
	}
	equal(t, days(after[3:6], "Europe/Moscow"), []string{"Sat 10-17 09:00", "Sun 10-18 20:00", "Mon 10-19 20:00"})

	// Two series now, the occurrences of each are in their own series, and the old one has ended.
	if n := e.rowCount("series_id IS NOT NULL AND planned_start < $1", msk(t, 2026, 10, 18, 0, 0)); n != 4 {
		t.Errorf("%d old occurrences, want 4", n)
	}
	var seriesCount int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM task_series`).Scan(&seriesCount); err != nil || seriesCount != 2 {
		t.Errorf("series = %d, %v; want 2", seriesCount, err)
	}
	// Far in the future only the new series produces occurrences.
	far := e.list(msk(t, 2027, 1, 1, 0, 0), msk(t, 2027, 1, 3, 0, 0))
	equal(t, days(far, "Europe/Moscow"), []string{"Fri 01-01 20:00", "Sat 01-02 20:00"})
}

func TestEditFollowingFromTheFirstOccurrenceIsTheWholeSeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0)
	list := e.list(from, to)

	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeFollowing, task.UpdateInput{Title: ptr("Все")}); err != nil {
		t.Fatal(err)
	}
	var seriesCount int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM task_series`).Scan(&seriesCount); err != nil || seriesCount != 1 {
		t.Errorf("series = %d, %v; want 1", seriesCount, err)
	}
	for _, in := range e.list(from, to) {
		if in.Title != "Все" {
			t.Errorf("%+v", in)
		}
	}
}

func TestEditFollowingKeepsTheTotalCount(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY;COUNT=6")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 11, 14, 0, 0)
	list := e.list(from, to)
	if len(list) != 6 {
		t.Fatalf("%d occurrences, want 6", len(list))
	}

	if _, err := e.svc.Update(ctx, e.user, list[2].ID, task.ScopeFollowing, task.UpdateInput{Title: ptr("Хвост")}); err != nil {
		t.Fatal(err)
	}
	after := e.list(from, to)
	if len(after) != 6 {
		t.Fatalf("%d occurrences after the split, want still 6: %v", len(after), days(after, "Europe/Moscow"))
	}
	titles := ""
	for _, in := range after {
		titles += string([]rune(in.Title)[:1])
	}
	if titles != "ППХХХХ" {
		t.Errorf("titles = %q, want two old and four new", titles)
	}
}

func TestEditFollowingKeepsTheEndDate(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	until := msk(t, 2026, 10, 20, 9, 0).UTC().Format("20060102T150405Z")
	e.createSeries("FREQ=DAILY;UNTIL=" + until)
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 11, 14, 0, 0)
	list := e.list(from, to)
	if len(list) != 7 {
		t.Fatalf("%d occurrences, want 7", len(list))
	}
	if _, err := e.svc.Update(ctx, e.user, list[3].ID, task.ScopeFollowing, task.UpdateInput{Title: ptr("Хвост")}); err != nil {
		t.Fatal(err)
	}
	if after := e.list(from, to); len(after) != 7 {
		t.Errorf("%d occurrences after the split, want still 7", len(after))
	}
}

func TestEditFollowingWithANewRule(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 31, 0, 0)
	list := e.list(from, to)

	// From Monday 10-19 on: every Monday only.
	if _, err := e.svc.Update(ctx, e.user, list[5].ID, task.ScopeFollowing, task.UpdateInput{Recurrence: ptr("FREQ=WEEKLY;BYDAY=MO")}); err != nil {
		t.Fatal(err)
	}
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{
		"Wed 10-14 09:00", "Thu 10-15 09:00", "Fri 10-16 09:00", "Sat 10-17 09:00", "Sun 10-18 09:00",
		"Mon 10-19 09:00", "Mon 10-26 09:00",
	})
}

func TestMarkedOccurrencesAreNeverTouched(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)
	list := e.list(from, to) // 14..17

	// The 15th and 16th were marked ("done" and "not done"); the instances are history.
	for _, id := range []uuid.UUID{list[1].ID, list[2].ID} {
		if _, err := e.pool.Exec(ctx, `UPDATE task_instances SET status = 'done' WHERE id = $1`, id); err != nil {
			t.Fatal(err)
		}
	}

	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{Title: ptr("Новая")}); err != nil {
		t.Fatal(err)
	}
	titles := map[string]string{}
	for _, in := range e.list(from, to) {
		titles[in.PlannedStart.In(time.UTC).Format("02")] = in.Title + "/" + in.Status
	}
	want := map[string]string{"14": "Новая/planned", "15": "Планёрка/done", "16": "Планёрка/done", "17": "Новая/planned"}
	if fmt.Sprint(titles) != fmt.Sprint(want) {
		t.Errorf("after edit all: %v, want %v", titles, want)
	}

	// Deleting the whole series removes the planned ones and keeps the marked ones as one-off tasks.
	// (list[1] is marked, so it was not re-created by the edit and its id is still valid.)
	if err := e.svc.Delete(ctx, e.user, list[1].ID, task.ScopeAll); err != nil {
		t.Fatal(err)
	}
	left := e.list(from, to)
	if len(left) != 2 {
		t.Fatalf("%d tasks left, want the two marked ones: %v", len(left), days(left, "Europe/Moscow"))
	}
	for _, in := range left {
		if in.SeriesID != nil || in.Status != "done" {
			t.Errorf("%+v", in)
		}
	}
	// And they are no longer in a series, so nothing can regenerate or rewrite them.
	if n := e.rowCount("series_id IS NOT NULL"); n != 0 {
		t.Errorf("%d rows still linked to a series", n)
	}
}

func TestDeleteFollowing(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 24, 0, 0)
	list := e.list(from, to)
	// A detached occurrence after the cut goes too: the user deleted everything from there on.
	if _, err := e.svc.Update(ctx, e.user, list[7].ID, task.ScopeThis, task.UpdateInput{Title: ptr("Особая")}); err != nil {
		t.Fatal(err)
	}

	if err := e.svc.Delete(ctx, e.user, list[4].ID, task.ScopeFollowing); err != nil {
		t.Fatal(err)
	}
	equal(t, days(e.list(from, to), "Europe/Moscow"), []string{"Wed 10-14 09:00", "Thu 10-15 09:00", "Fri 10-16 09:00", "Sat 10-17 09:00"})
	// Nothing comes back later either.
	if got := e.list(msk(t, 2027, 1, 1, 0, 0), msk(t, 2027, 1, 5, 0, 0)); len(got) != 0 {
		t.Errorf("occurrences after a delete of the following ones: %v", days(got, "Europe/Moscow"))
	}
}

func TestDeleteFollowingFromTheFirstOccurrenceDeletesTheSeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	list := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 17, 0, 0))

	if err := e.svc.Delete(ctx, e.user, list[0].ID, task.ScopeFollowing); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM task_series`).Scan(&n); err != nil || n != 0 {
		t.Errorf("series = %d, %v; want 0", n, err)
	}
	if got := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 30, 0, 0)); len(got) != 0 {
		t.Errorf("%d tasks left", len(got))
	}
}

func TestScopesNeedASeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	one := e.create("Разовое", msk(t, 2026, 10, 14, 9, 0), msk(t, 2026, 10, 14, 10, 0))

	for _, scope := range []task.Scope{task.ScopeAll, task.ScopeFollowing} {
		_, err := e.svc.Update(ctx, e.user, one.ID, scope, task.UpdateInput{Title: ptr("x")})
		var verr *validation.Error
		if !errors.As(err, &verr) || verr.Field != "scope" {
			t.Errorf("Update scope %s: %v", scope, err)
		}
		if err := e.svc.Delete(ctx, e.user, one.ID, scope); !errors.As(err, &verr) || verr.Field != "scope" {
			t.Errorf("Delete scope %s: %v", scope, err)
		}
	}
	// A one-off task is deleted for real.
	if err := e.svc.Delete(ctx, e.user, one.ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	if n := e.rowCount("true"); n != 0 {
		t.Errorf("%d rows left", n)
	}
}

func TestSeriesOfOtherUsersAreOutOfReach(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	first := e.createSeries("FREQ=DAILY")

	if _, err := e.svc.GetSeries(ctx, e.other, *first.SeriesID); !errors.Is(err, task.ErrSeriesNotFound) {
		t.Errorf("GetSeries: %v", err)
	}
	for _, scope := range []task.Scope{task.ScopeThis, task.ScopeFollowing, task.ScopeAll} {
		if _, err := e.svc.Update(ctx, e.other, first.ID, scope, task.UpdateInput{Title: ptr("hacked")}); !errors.Is(err, task.ErrNotFound) {
			t.Errorf("Update scope %s: %v", scope, err)
		}
		if err := e.svc.Delete(ctx, e.other, first.ID, scope); !errors.Is(err, task.ErrNotFound) {
			t.Errorf("Delete scope %s: %v", scope, err)
		}
	}
	if got, _ := e.svc.List(ctx, e.other, msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 20, 0, 0)); len(got) != 0 {
		t.Errorf("another user sees %d tasks", len(got))
	}
	// The other user's materialisation does not touch mine.
	if n := e.rowCount("user_id = $1", e.user); n != 1 {
		t.Errorf("%d rows, want 1", n)
	}
}

func TestConcurrentListsDoNotDuplicateOccurrences(t *testing.T) {
	e := newSeriesEnv(t)
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 11, 14, 0, 0)

	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = e.svc.List(context.Background(), e.user, from, to)
		}()
	}
	wg.Wait()
	for i, err := range errs {
		if err != nil {
			t.Errorf("list %d: %v", i, err)
		}
	}
	if n := e.rowCount("true"); n != 31 {
		t.Errorf("%d rows, want 31", n)
	}
}

func TestOccurrencesKeepTheWallClockAcrossDaylightSavingTime(t *testing.T) {
	const tz = "America/New_York"
	e := newSeriesEnvIn(t, tz)
	in, err := e.svc.Create(context.Background(), e.user, task.CreateInput{
		Title: "Планёрка", PlannedStart: local(t, tz, 2026, 10, 30, 9, 0), PlannedEnd: local(t, tz, 2026, 10, 30, 10, 0),
		Recurrence: ptr("FREQ=DAILY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = in
	// The clocks go back on 2026-11-01: 09:00 stays 09:00 local, but moves from 13:00 to 14:00 UTC.
	got := e.list(local(t, tz, 2026, 10, 30, 0, 0), local(t, tz, 2026, 11, 3, 0, 0))
	var utc []string
	for _, in := range got {
		utc = append(utc, in.PlannedStart.UTC().Format("01-02 15:04"))
		if in.PlannedEnd.Sub(in.PlannedStart) != time.Hour {
			t.Errorf("duration = %v", in.PlannedEnd.Sub(in.PlannedStart))
		}
	}
	equal(t, utc, []string{"10-30 13:00", "10-31 13:00", "11-01 14:00", "11-02 14:00"})
	equal(t, days(got, tz), []string{"Fri 10-30 09:00", "Sat 10-31 09:00", "Sun 11-01 09:00", "Mon 11-02 09:00"})
}

func TestDeletingACategoryTakesItOffTheSeriesToo(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")
	first := e.createSeries("FREQ=DAILY", work, sport)
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 16, 0, 0)
	e.list(from, to)

	if err := e.cats.Delete(ctx, e.user, work); err != nil {
		t.Fatal(err)
	}
	// Occurrences created later no longer carry the deleted category.
	for _, in := range e.list(from, msk(t, 2026, 10, 20, 0, 0)) {
		if len(in.CategoryIDs) > 1 || (len(in.CategoryIDs) == 1 && in.CategoryIDs[0] != sport) {
			if in.PlannedStart.After(msk(t, 2026, 10, 15, 23, 0)) {
				t.Errorf("a new occurrence has categories %v", in.CategoryIDs)
			}
		}
	}
	series, _ := e.svc.GetSeries(ctx, e.user, *first.SeriesID)
	if len(series.CategoryIDs) != 1 || series.CategoryIDs[0] != sport {
		t.Errorf("series categories = %v", series.CategoryIDs)
	}
}

func TestScopeParsing(t *testing.T) {
	for in, want := range map[string]task.Scope{"": task.ScopeThis, "this": task.ScopeThis, "following": task.ScopeFollowing, "all": task.ScopeAll} {
		if got, ok := task.ParseScope(in); !ok || got != want {
			t.Errorf("ParseScope(%q) = %q, %v", in, got, ok)
		}
	}
	for _, bad := range []string{"ALL", "everything", "this_and_following", " all"} {
		if _, ok := task.ParseScope(bad); ok {
			t.Errorf("ParseScope(%q) accepted", bad)
		}
	}
}

// setStatus marks a row as the tracking of stage 5 will (done, partial, …).
func (e *env) setStatus(id uuid.UUID, status string) {
	e.t.Helper()
	if _, err := e.pool.Exec(context.Background(), `UPDATE task_instances SET status = $1 WHERE id = $2`, status, id); err != nil {
		e.t.Fatal(err)
	}
}

func TestSplitHandsTheTailOverSoNothingComesBackOrDoubles(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 24, 0, 0)
	list := e.list(from, to) // 14..23

	// After the cut (the 18th): the 20th is deleted, the 21st is edited on its own, the 22nd is done.
	if err := e.svc.Delete(ctx, e.user, list[6].ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Update(ctx, e.user, list[7].ID, task.ScopeThis, task.UpdateInput{Title: ptr("Особая")}); err != nil {
		t.Fatal(err)
	}
	e.setStatus(list[8].ID, "done")

	if _, err := e.svc.Update(ctx, e.user, list[4].ID, task.ScopeFollowing, task.UpdateInput{Title: ptr("Новая")}); err != nil {
		t.Fatal(err)
	}

	got := e.list(from, to)
	if len(got) != 9 { // 10 days, one of them deleted
		t.Fatalf("%d tasks, want 9: %v", len(got), days(got, "Europe/Moscow"))
	}
	byDay := map[string]string{}
	for _, in := range got {
		byDay[in.PlannedStart.In(time.UTC).Format("02")] = in.Title + "/" + in.Status
	}
	for day, want := range map[string]string{
		"17": "Планёрка/planned", "18": "Новая/planned", "19": "Новая/planned",
		"21": "Особая/planned", "22": "Планёрка/done", "23": "Новая/planned",
	} {
		if byDay[day] != want {
			t.Errorf("day %s: %q, want %q (all: %v)", day, byDay[day], want, byDay)
		}
	}
	if _, deleted := byDay["20"]; deleted {
		t.Error("the deleted occurrence of the 20th came back")
	}
}

func TestChangingTheTimeOfASeriesKeepsDeletedEditedAndMarkedDays(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 20, 0, 0)
	list := e.list(from, to) // 14..19

	if err := e.svc.Delete(ctx, e.user, list[1].ID, task.ScopeThis); err != nil { // the 15th: deleted
		t.Fatal(err)
	}
	if _, err := e.svc.Update(ctx, e.user, list[2].ID, task.ScopeThis, task.UpdateInput{Title: ptr("Особая")}); err != nil { // the 16th: edited
		t.Fatal(err)
	}
	e.setStatus(list[3].ID, "done") // the 17th: done

	start := msk(t, 2026, 10, 14, 11, 30)
	if _, err := e.svc.Update(ctx, e.user, list[0].ID, task.ScopeAll, task.UpdateInput{
		PlannedStart: &start, PlannedEnd: ptr(start.Add(time.Hour)),
	}); err != nil {
		t.Fatal(err)
	}

	got := e.list(from, to)
	byDay := map[string][]string{}
	for _, in := range got {
		day := in.PlannedStart.In(time.UTC).Format("02")
		byDay[day] = append(byDay[day], fmt.Sprintf("%s/%s/%s", in.Title, in.Status, in.PlannedStart.In(time.UTC).Format("15:04")))
	}
	want := map[string][]string{
		"14": {"Планёрка/planned/08:30"}, // re-created at 11:30 Moscow
		"16": {"Особая/planned/06:00"},   // edited: stays as it is, no second one
		"17": {"Планёрка/done/06:00"},    // done: history, no second one
		"18": {"Планёрка/planned/08:30"}, "19": {"Планёрка/planned/08:30"},
	}
	if fmt.Sprint(byDay) != fmt.Sprint(want) {
		t.Errorf("got  %v\nwant %v", byDay, want)
	}
	if _, back := byDay["15"]; back {
		t.Error("the deleted occurrence of the 15th came back")
	}
}

func TestChangingTheTimeWhenSplittingKeepsTheTailToo(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 22, 0, 0)
	list := e.list(from, to) // 14..21

	if err := e.svc.Delete(ctx, e.user, list[5].ID, task.ScopeThis); err != nil { // the 19th
		t.Fatal(err)
	}
	e.setStatus(list[6].ID, "done") // the 20th

	start := msk(t, 2026, 10, 17, 18, 0)
	if _, err := e.svc.Update(ctx, e.user, list[3].ID, task.ScopeFollowing, task.UpdateInput{
		PlannedStart: &start, PlannedEnd: ptr(start.Add(time.Hour)),
	}); err != nil {
		t.Fatal(err)
	}
	got := e.list(from, to)
	equal(t, days(got, "Europe/Moscow"), []string{
		"Wed 10-14 09:00", "Thu 10-15 09:00", "Fri 10-16 09:00",
		"Sat 10-17 18:00", "Sun 10-18 18:00", "Tue 10-20 09:00", "Wed 10-21 18:00",
	})
	// The done occurrence of the 20th keeps its time (history); the 19th stays deleted.
	for _, in := range got {
		if in.PlannedStart.In(time.UTC).Format("02") == "20" && in.Status != "done" {
			t.Errorf("the 20th is %q, want the done one", in.Status)
		}
	}
}

func TestEditingOnlyTheEndKeepsTheTimeOfDayOfTheSeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0)
	list := e.list(from, to)

	// The 15th was moved on its own to 15:00 (so it is detached); now only its end is edited, for all.
	moved := msk(t, 2026, 10, 15, 15, 0)
	if _, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeThis, task.UpdateInput{PlannedStart: &moved, PlannedEnd: ptr(moved.Add(time.Hour))}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Update(ctx, e.user, list[1].ID, task.ScopeAll, task.UpdateInput{PlannedEnd: ptr(msk(t, 2026, 10, 15, 16, 30))}); err != nil {
		t.Fatal(err)
	}

	got := e.list(from, to)
	// The series is still at 09:00 (the moved occurrence is not what defines it); its duration became 1.5 h.
	var times []string
	for _, in := range got {
		// The moved (detached) occurrence on the 15th keeps its own time and length.
		if in.Title == "Планёрка" && in.PlannedStart.In(time.UTC).Day() != 15 {
			times = append(times, in.PlannedStart.In(time.UTC).Format("15:04"))
			if in.PlannedEnd.Sub(in.PlannedStart) != 90*time.Minute {
				t.Errorf("duration = %v, want 1h30m", in.PlannedEnd.Sub(in.PlannedStart))
			}
		}
	}
	equal(t, times, []string{"06:00", "06:00", "06:00"})
}

func TestAMarkedOccurrenceCannotBeDeletedFromItsSeries(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	list := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 16, 0, 0))
	e.setStatus(list[0].ID, "done")

	err := e.svc.Delete(ctx, e.user, list[0].ID, task.ScopeThis)
	var verr *validation.Error
	if !errors.As(err, &verr) || verr.ErrorCode() != task.CodeInstanceMarked {
		t.Fatalf("err = %v, want %s", err, task.CodeInstanceMarked)
	}
	if n := e.rowCount("status = 'done'"); n != 1 {
		t.Errorf("%d done rows, want the record kept", n)
	}
}

func TestDeletedOccurrencesAreGoneForEdits(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	list := e.list(msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 18, 0, 0))
	if err := e.svc.Delete(ctx, e.user, list[2].ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}

	// A stale id of a deleted occurrence is not found, whatever is asked of it.
	for _, scope := range []task.Scope{task.ScopeThis, task.ScopeFollowing, task.ScopeAll} {
		if _, err := e.svc.Update(ctx, e.user, list[2].ID, scope, task.UpdateInput{Title: ptr("x")}); !errors.Is(err, task.ErrNotFound) {
			t.Errorf("Update scope %s: %v", scope, err)
		}
		if err := e.svc.Delete(ctx, e.user, list[2].ID, scope); !errors.Is(err, task.ErrNotFound) {
			t.Errorf("Delete scope %s: %v", scope, err)
		}
	}
	var seriesCount int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM task_series`).Scan(&seriesCount); err != nil || seriesCount != 1 {
		t.Errorf("series = %d, %v; a stale id must not split the series", seriesCount, err)
	}
}

func TestDeletingASeriesOrItsTailLeavesNoCancelledRows(t *testing.T) {
	e := newSeriesEnv(t)
	ctx := context.Background()
	e.createSeries("FREQ=DAILY")
	from, to := msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 24, 0, 0)
	list := e.list(from, to)
	for _, i := range []int{1, 6, 8} { // the 15th, the 20th and the 22nd are deleted
		if err := e.svc.Delete(ctx, e.user, list[i].ID, task.ScopeThis); err != nil {
			t.Fatal(err)
		}
	}

	if err := e.svc.Delete(ctx, e.user, list[4].ID, task.ScopeFollowing); err != nil { // from the 18th
		t.Fatal(err)
	}
	// The cancelled rows of the tail went with it; the one before the cut stays: it keeps the 15th deleted.
	if n := e.rowCount("status = 'cancelled'"); n != 1 {
		t.Errorf("%d cancelled rows after deleting the tail, want 1", n)
	}

	if err := e.svc.Delete(ctx, e.user, list[0].ID, task.ScopeAll); err != nil {
		t.Fatal(err)
	}
	if n := e.rowCount("true"); n != 0 {
		t.Errorf("%d rows left after deleting the whole series", n)
	}
}

func TestMaterialisationDoesNotBlockOnEachOther(t *testing.T) {
	e := newSeriesEnv(t)
	e.createSeries("FREQ=DAILY")

	// Hold the shared lock in one transaction; another materialisation must still go through.
	ctx := context.Background()
	tx, err := e.pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock_shared(hashtextextended('series:' || $1::text, 0))`, e.user); err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() {
		_, err := e.svc.List(ctx, e.user, msk(t, 2026, 10, 14, 0, 0), msk(t, 2026, 10, 20, 0, 0))
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("a list waited for another reader's lock")
	}
}
