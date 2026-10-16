package habit

import (
	"testing"
	"time"
)

// d is a day of October 2026: the 1st is a Thursday, the 5th a Monday.
func d(day int) Day { return DayOf(2026, time.October, day) }

func marks(days ...int) Marks {
	m := Marks{}
	for _, day := range days {
		m[d(day)] = 1
	}
	return m
}

func daily(start int) Rules {
	return Rules{Schedule: Schedule{Frequency: Daily}, Target: 1, Start: d(start)}
}

func TestScheduleIsValidOnlyWhenComplete(t *testing.T) {
	cases := []struct {
		s  Schedule
		ok bool
	}{
		{Schedule{Frequency: Daily}, true},
		{Schedule{Frequency: Weekdays, Weekdays: []int{1, 3, 5}}, true},
		{Schedule{Frequency: Weekdays}, false},
		{Schedule{Frequency: Weekdays, Weekdays: []int{0}}, false},
		{Schedule{Frequency: Weekdays, Weekdays: []int{8}}, false},
		{Schedule{Frequency: Weekdays, Weekdays: []int{2, 2}}, false},
		{Schedule{Frequency: TimesPerWeek, TimesPerWeek: 3}, true},
		{Schedule{Frequency: TimesPerWeek, TimesPerWeek: 0}, false},
		{Schedule{Frequency: TimesPerWeek, TimesPerWeek: 8}, false},
		{Schedule{Frequency: "monthly"}, false},
	}
	for _, c := range cases {
		if got := c.s.Valid(); got != c.ok {
			t.Errorf("%+v: valid = %v, want %v", c.s, got, c.ok)
		}
	}
}

func TestPlannedDays(t *testing.T) {
	s := Schedule{Frequency: Weekdays, Weekdays: []int{1, 7}} // Monday and Sunday
	if !s.Planned(d(5)) || !s.Planned(d(11)) || s.Planned(d(6)) {
		t.Error("Monday and Sunday must be planned, Tuesday not")
	}
	if !(Schedule{Frequency: Daily}).Planned(d(6)) {
		t.Error("every day is planned for a daily habit")
	}
	weekly := Schedule{Frequency: TimesPerWeek, TimesPerWeek: 3}
	if weekly.Planned(d(5)) {
		t.Error("no day is planned in particular for a weekly goal")
	}
	if !(Rules{Schedule: weekly}).PlannedOn(d(5)) {
		t.Error("but it is in the list of every day")
	}
}

func TestWeekStartIsMonday(t *testing.T) {
	for _, day := range []int{5, 6, 9, 11} {
		if got := weekStart(d(day)); !got.Equal(d(5)) {
			t.Errorf("weekStart(%d) = %v", day, got)
		}
	}
	if got := weekStart(d(12)); !got.Equal(d(12)) {
		t.Errorf("weekStart(12) = %v", got)
	}
}

func TestDailyStreak(t *testing.T) {
	h := daily(1)
	// 1-3 done, 4 missed, 5-6 done; today is the 7th, not done yet: it does not break the run.
	s := h.Streaks(marks(1, 2, 3, 5, 6), d(7))
	if s.Current != 2 || s.Best != 3 {
		t.Errorf("streaks = %+v, want current 2, best 3", s)
	}
	// Today done as well: the run grows.
	s = h.Streaks(marks(1, 2, 3, 5, 6, 7), d(7))
	if s.Current != 3 || s.Best != 3 {
		t.Errorf("streaks = %+v, want 3 and 3", s)
	}
	// Yesterday missed and today pending: the run is over.
	s = h.Streaks(marks(1, 2, 3, 4, 5), d(7))
	if s.Current != 0 || s.Best != 5 {
		t.Errorf("streaks = %+v, want 0 and 5", s)
	}
}

func TestWeekdayStreakIgnoresDaysOutOfTheSchedule(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: Weekdays, Weekdays: []int{1, 3, 5}}, Target: 1, Start: d(5)}
	// Monday 5, Wednesday 7, Friday 9 done; Tuesday and Thursday are not planned and do not break it.
	s := h.Streaks(marks(5, 7, 9), d(10))
	if s.Current != 3 || s.Best != 3 {
		t.Errorf("streaks = %+v", s)
	}
	// Monday 12 is missed (today is Tuesday 13).
	s = h.Streaks(marks(5, 7, 9), d(13))
	if s.Current != 0 || s.Best != 3 {
		t.Errorf("streaks = %+v", s)
	}
	// A done day outside the schedule counts for nothing.
	s = h.Streaks(marks(5, 6, 7), d(8))
	if s.Current != 2 || s.Best != 2 {
		t.Errorf("streaks = %+v", s)
	}
}

func TestDaysBeforeTheStartAreNotMissed(t *testing.T) {
	h := daily(10)
	if s := h.Streaks(marks(10, 11), d(11)); s.Current != 2 || s.Best != 2 {
		t.Errorf("streaks = %+v", s)
	}
	// A mark made for an earlier day moves the start back: the days between are missed.
	if s := h.Streaks(marks(8, 10, 11), d(11)); s.Current != 2 || s.Best != 2 {
		t.Errorf("streaks = %+v", s)
	}
}

func TestQuantityNeedsTheTarget(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: Daily}, Target: 8, Start: d(1)}
	m := Marks{d(1): 8, d(2): 7, d(3): 10}
	if !h.Done(8) || h.Done(7) || !h.Done(10) {
		t.Error("done at the target or above")
	}
	s := h.Streaks(m, d(3))
	if s.Current != 1 || s.Best != 1 {
		t.Errorf("streaks = %+v", s)
	}
}

func TestWeeklyGoalStreakCountsWeeks(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 3}, Target: 1, Start: d(5)}
	// Week 5-11: three days. Week 12-18: two days, so the run breaks. Week 19-25: three. Today is the 22nd.
	m := marks(5, 7, 9, 12, 14, 19, 20, 21)
	s := h.Streaks(m, d(22))
	if s.Current != 1 || s.Best != 1 {
		t.Errorf("streaks = %+v, want 1 and 1", s)
	}
	// Two good weeks in a row.
	s = h.Streaks(marks(5, 7, 9, 12, 14, 16), d(22))
	// The current week (19-25) has nothing yet but it is not over.
	if s.Current != 2 || s.Best != 2 {
		t.Errorf("streaks = %+v, want 2 and 2", s)
	}
}

func TestTheWeekThatGoesOnBreaksNothing(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 3}, Target: 1, Start: d(5)}
	// The week of the 12th has one day so far; today is Wednesday the 14th.
	s := h.Streaks(marks(5, 6, 7, 12), d(14))
	if s.Current != 1 {
		t.Errorf("current = %d, want 1", s.Current)
	}
	// Once the goal is reached it counts at once.
	s = h.Streaks(marks(5, 6, 7, 12, 13, 14), d(14))
	if s.Current != 2 {
		t.Errorf("current = %d, want 2", s.Current)
	}
}

func TestAWeekWithLessThanTheGoalBreaksTheStreak(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 2}, Target: 1, Start: d(5)}
	m := marks(5, 6, 12) // a week with 2, a week with 1
	s := h.Streaks(m, d(20))
	if s.Current != 0 || s.Best != 1 {
		t.Errorf("streaks = %+v, want 0 and 1", s)
	}
}

func TestTheFirstWeekIsNotHeldAgainstAHabitStartedLate(t *testing.T) {
	// Started on Friday the 9th: only three days were left of the week.
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 4}, Target: 1, Start: d(9)}
	s := h.Streaks(marks(9, 10, 12, 13, 14, 15), d(20))
	if s.Current != 1 || s.Best != 1 {
		t.Errorf("streaks = %+v, want 1 and 1", s)
	}
	// The week that the habit began on a Monday counts in full.
	h.Start = d(5)
	s = h.Streaks(marks(9, 10), d(20))
	if s.Current != 0 {
		t.Errorf("current = %d, want 0", s.Current)
	}
}

func TestMoreThanOneMarkADayCountsOnce(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 2}, Target: 1, Start: d(5)}
	m := Marks{d(5): 40, d(6): 1} // a value above the target is still one day
	if s := h.Streaks(m, d(12)); s.Current != 1 {
		t.Errorf("current = %d", s.Current)
	}
}

func TestPercent(t *testing.T) {
	h := daily(1)
	m := marks(1, 2, 3, 5)
	// Days 1-6 are over: 4 of 6. Today (the 7th) is pending and not counted.
	p := h.Percent(m, d(7), d(1), d(31))
	if v, ok := p.Value(); !ok || v != 67 || p.Met != 4 || p.Total != 6 {
		t.Errorf("percent = %+v (%d)", p, v)
	}
	// Today done: it is in the count.
	p = h.Percent(marks(1, 2, 3, 5, 7), d(7), d(1), d(31))
	if p.Met != 5 || p.Total != 7 {
		t.Errorf("percent = %+v", p)
	}
	// A period inside the history.
	p = h.Percent(m, d(7), d(4), d(6))
	if p.Met != 1 || p.Total != 3 {
		t.Errorf("percent = %+v", p)
	}
	// Nothing is over yet.
	if _, ok := daily(7).Percent(Marks{}, d(7), d(1), d(31)).Value(); ok {
		t.Error("no percentage before a day is over")
	}
}

func TestPercentOfAWeeklyGoalCountsWeeks(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 2}, Target: 1, Start: d(5)}
	m := marks(5, 6, 12) // met, missed, and the week of the 19th is current
	p := h.Percent(m, d(21), d(1), d(31))
	if p.Met != 1 || p.Total != 2 {
		t.Errorf("percent = %+v", p)
	}
	// A week that shares a day with the period is in it.
	p = h.Percent(m, d(21), d(11), d(11))
	if p.Met != 1 || p.Total != 1 {
		t.Errorf("percent = %+v", p)
	}
	p = h.Percent(m, d(21), d(25), d(31))
	if p.Total != 0 {
		t.Errorf("percent = %+v", p)
	}
}

func TestPercentRounds(t *testing.T) {
	cases := []struct {
		met, total, want int
	}{{1, 3, 33}, {2, 3, 67}, {1, 2, 50}, {7, 7, 100}, {0, 5, 0}, {1, 8, 13}}
	for _, c := range cases {
		if got, _ := (Percent{c.met, c.total}).Value(); got != c.want {
			t.Errorf("%d/%d = %d, want %d", c.met, c.total, got, c.want)
		}
	}
}

func TestCells(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: Weekdays, Weekdays: []int{1}}, Target: 3, Start: d(1)}
	cells := h.Cells(Marks{d(5): 3, d(6): 2}, d(5), d(7))
	if len(cells) != 3 {
		t.Fatalf("cells = %d", len(cells))
	}
	if !cells[0].Done || !cells[0].Planned || cells[0].Value != 3 {
		t.Errorf("Monday = %+v", cells[0])
	}
	if cells[1].Done || cells[1].Planned || cells[1].Value != 2 {
		t.Errorf("Tuesday = %+v", cells[1])
	}
}

func TestDoneInWeek(t *testing.T) {
	h := Rules{Schedule: Schedule{Frequency: TimesPerWeek, TimesPerWeek: 3}, Target: 1, Start: d(1)}
	if n := h.DoneInWeek(marks(5, 7, 11, 12), d(9)); n != 3 {
		t.Errorf("done in week = %d, want 3 (the 12th is the next week)", n)
	}
}

func TestLocalDayFollowsTheTimeZone(t *testing.T) {
	msk, _ := time.LoadLocation("Europe/Moscow")
	// 22:30 UTC on the 5th is 01:30 on the 6th in Moscow.
	if got := LocalDay(time.Date(2026, 10, 5, 22, 30, 0, 0, time.UTC), msk); !got.Equal(d(6)) {
		t.Errorf("local day = %v", got)
	}
}
