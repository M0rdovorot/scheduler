// Package habit holds the habits of the user: their schedule, the marks and the
// streaks, best streaks and percentages that are worked out from the marks.
//
// The rules are in docs/requirements.md (assumption 8). Everything here is a pure
// function of the marks, the creation date and "today"; nothing is stored.
package habit

import (
	"slices"
	"time"
)

// Day is a local calendar date: midnight UTC of that date. The time zone of the user
// is applied once, when "today" and the dates of the marks are worked out.
type Day = time.Time

// DayOf makes a Day from a calendar date.
func DayOf(year int, month time.Month, day int) Day {
	return time.Date(year, month, day, 0, 0, 0, 0, time.UTC)
}

// ParseDay reads "2006-01-02".
func ParseDay(s string) (Day, error) { return time.Parse(time.DateOnly, s) }

// LocalDay is the local date of an instant in the time zone.
func LocalDay(t time.Time, loc *time.Location) Day {
	y, m, d := t.In(loc).Date()
	return DayOf(y, m, d)
}

func addDays(d Day, n int) Day { return d.AddDate(0, 0, n) }

// weekStart is the Monday of the week of the day.
func weekStart(d Day) Day { return addDays(d, -((int(d.Weekday()) + 6) % 7)) }

type Frequency string

const (
	Daily        Frequency = "daily"
	Weekdays     Frequency = "weekdays"
	TimesPerWeek Frequency = "times_per_week"
)

// Schedule says on which days a habit is planned.
type Schedule struct {
	Frequency Frequency
	// Weekdays are ISO numbers, 1 = Monday … 7 = Sunday; for Weekdays.
	Weekdays []int
	// TimesPerWeek is the goal for TimesPerWeek.
	TimesPerWeek int
}

// Valid reports whether the schedule is complete for its frequency.
func (s Schedule) Valid() bool {
	switch s.Frequency {
	case Daily:
		return true
	case Weekdays:
		if len(s.Weekdays) == 0 {
			return false
		}
		seen := map[int]bool{}
		for _, w := range s.Weekdays {
			if w < 1 || w > 7 || seen[w] {
				return false
			}
			seen[w] = true
		}
		return true
	case TimesPerWeek:
		return s.TimesPerWeek >= 1 && s.TimesPerWeek <= 7
	}
	return false
}

// iso is the ISO number of the weekday: 1 = Monday … 7 = Sunday.
func iso(d Day) int { return (int(d.Weekday())+6)%7 + 1 }

// Planned reports whether the habit is planned on that day. A habit with a weekly goal
// can be done on any day, so it is planned on none in particular.
func (s Schedule) Planned(d Day) bool {
	switch s.Frequency {
	case Daily:
		return true
	case Weekdays:
		return slices.Contains(s.Weekdays, iso(d))
	}
	return false
}

// Weekly reports whether the goal is a number of days per week.
func (s Schedule) Weekly() bool { return s.Frequency == TimesPerWeek }

// Marks are the values of the days that have a mark; a day without a mark has none.
type Marks map[Day]int

// Rules is what the calculations need to know about a habit.
type Rules struct {
	Schedule Schedule
	// Target is the value that makes a day done: 1 for yes/no, the goal of a quantity.
	Target int
	// Start is the first day that counts: the creation date, or the first mark when it is earlier.
	Start Day
}

// Done reports whether the value makes the day done.
func (h Rules) Done(value int) bool { return value >= max(h.Target, 1) }

// Result of one unit of a habit: a day, or a week for a weekly goal.
type Result int

const (
	// Met: done.
	Met Result = iota
	// Missed: over without being done; it breaks the streak.
	Missed
	// Pending: not over (today, or the week that is going on); it neither breaks the streak nor counts.
	Pending
)

// Unit is a day or a week with its result.
type Unit struct {
	// First is the day, or the Monday of the week.
	First  Day
	Result Result
}

// units works out the result of every planned day (or every week) from the start up to today.
func (h Rules) units(marks Marks, today Day) []Unit {
	start := h.Start
	if first, ok := firstMark(marks); ok && first.Before(start) {
		start = first
	}
	var out []Unit
	if h.Schedule.Weekly() {
		thisWeek := weekStart(today)
		firstWeek := weekStart(start)
		for w := firstWeek; !w.After(thisWeek); w = addDays(w, 7) {
			count := 0
			for i := 0; i < 7; i++ {
				if h.Done(marks[addDays(w, i)]) {
					count++
				}
			}
			switch {
			case count >= h.Schedule.TimesPerWeek:
				out = append(out, Unit{w, Met})
			case w.Equal(thisWeek):
				out = append(out, Unit{w, Pending})
			case w.Equal(firstWeek) && start.After(w):
				// The habit began in the middle of this week: it was not tracked all of it.
				out = append(out, Unit{w, Pending})
			default:
				out = append(out, Unit{w, Missed})
			}
		}
		return out
	}
	for d := start; !d.After(today); d = addDays(d, 1) {
		if !h.Schedule.Planned(d) {
			continue
		}
		switch {
		case h.Done(marks[d]):
			out = append(out, Unit{d, Met})
		case d.Equal(today):
			out = append(out, Unit{d, Pending})
		default:
			out = append(out, Unit{d, Missed})
		}
	}
	return out
}

func firstMark(marks Marks) (Day, bool) {
	var first Day
	found := false
	for d, v := range marks {
		if v > 0 && (!found || d.Before(first)) {
			first, found = d, true
		}
	}
	return first, found
}

// Streaks are the current and the best run of met units: days for a daily or weekday
// habit, weeks for a weekly goal.
type Streaks struct {
	Current, Best int
}

// Streaks counts the runs of met units. A pending unit changes nothing.
func (h Rules) Streaks(marks Marks, today Day) Streaks {
	var s Streaks
	for _, u := range h.units(marks, today) {
		switch u.Result {
		case Met:
			s.Current++
			s.Best = max(s.Best, s.Current)
		case Missed:
			s.Current = 0
		}
	}
	return s
}

// Percent is the share of units that were met, of those that are over (or already met),
// in the period [from, to]. Without such units there is no percentage.
type Percent struct {
	Met, Total int
}

// Value is the rounded percentage, or false when nothing is over yet.
func (p Percent) Value() (int, bool) {
	if p.Total == 0 {
		return 0, false
	}
	return (p.Met*100 + p.Total/2) / p.Total, true
}

// Percent counts the units that fall into [from, to]: a day by its date, a week when
// it shares a day with the period.
func (h Rules) Percent(marks Marks, today, from, to Day) Percent {
	var p Percent
	for _, u := range h.units(marks, today) {
		if u.Result == Pending {
			continue
		}
		last := u.First
		if h.Schedule.Weekly() {
			last = addDays(u.First, 6)
		}
		if last.Before(from) || u.First.After(to) {
			continue
		}
		p.Total++
		if u.Result == Met {
			p.Met++
		}
	}
	return p
}

// Cell is a day of the heat map.
type Cell struct {
	Date  Day
	Value int
	Done  bool
	// Planned is false on a day that is not in the schedule (and for every day of a weekly goal).
	Planned bool
}

// Cells lists the days from `from` to `to` with their marks.
func (h Rules) Cells(marks Marks, from, to Day) []Cell {
	var out []Cell
	for d := from; !d.After(to); d = addDays(d, 1) {
		out = append(out, Cell{Date: d, Value: marks[d], Done: h.Done(marks[d]), Planned: h.Schedule.Planned(d)})
	}
	return out
}

// DoneInWeek counts the done days of the week that contains the day.
func (h Rules) DoneInWeek(marks Marks, day Day) int {
	n := 0
	w := weekStart(day)
	for i := 0; i < 7; i++ {
		if h.Done(marks[addDays(w, i)]) {
			n++
		}
	}
	return n
}

// PlannedOn reports whether the habit belongs in the list of the day: planned on that
// weekday, or with a weekly goal, which can be worked on any day.
func (h Rules) PlannedOn(d Day) bool { return h.Schedule.Weekly() || h.Schedule.Planned(d) }
