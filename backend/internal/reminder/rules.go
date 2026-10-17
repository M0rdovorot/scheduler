// Package reminder works out which reminders are due, queues them, and sends them
// through the Telegram bot (FR-9).
//
// This file is the pure part: which rules apply to a task, when each fires, how quiet
// hours move it and what the message says. Nothing here touches the database.
package reminder

import (
	"cmp"
	"slices"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/recurrence"
)

type Kind string

const (
	// BeforeStart is N minutes before the planned start.
	BeforeStart Kind = "before_start"
	// AfterEnd is N minutes after the planned end: "how did it go?".
	AfterEnd Kind = "after_end"
	// NotStarted is N minutes after the planned start, if the task is neither started nor marked.
	NotStarted Kind = "not_started"
	// Overrun is N minutes after the planned end, if the timer still runs.
	Overrun Kind = "overrun"
	// HabitTime is a time of day, for a habit.
	HabitTime Kind = "habit_time"
)

// Scope is a level of settings.
type Scope string

const (
	ScopeGlobal   Scope = "global"
	ScopeCategory Scope = "category"
	ScopeSeries   Scope = "series"
	ScopeInstance Scope = "instance"
	ScopeHabit    Scope = "habit"
)

// Rule is one reminder of a level.
type Rule struct {
	Kind Kind
	// OffsetMinutes is for the four kinds that belong to a task.
	OffsetMinutes int
	// TimeOfDay is minutes from local midnight, for HabitTime.
	TimeOfDay int
}

// Setting is what a level says: no reminders, or these.
type Setting struct {
	Enabled bool
	Rules   []Rule
}

func (s *Setting) rules() []Rule {
	if s == nil || !s.Enabled {
		return nil
	}
	return s.Rules
}

// Levels are the settings that can apply to one task, from the most special to the most general.
// A nil level has no row of its own and inherits.
type Levels struct {
	Instance *Setting
	Series   *Setting
	// Categories are the settings found for the categories of the task: each category's own or
	// those of its nearest ancestor that has any. Empty when none of them has settings.
	Categories []*Setting
	Global     *Setting
}

// Explain gives the level whose settings apply and its rules: the first level that has
// settings of its own (FR-9.2). The master switch is the caller's business: with it off
// nothing is sent at all.
func Explain(l Levels) (Scope, []Rule) {
	switch {
	case l.Instance != nil:
		return ScopeInstance, normalize(l.Instance.rules())
	case l.Series != nil:
		return ScopeSeries, normalize(l.Series.rules())
	case len(l.Categories) > 0:
		var rules []Rule
		for _, c := range l.Categories {
			rules = append(rules, c.rules()...)
		}
		return ScopeCategory, normalize(rules)
	}
	return ScopeGlobal, normalize(l.Global.rules())
}

// Resolve gives the rules that apply to a task.
func Resolve(l Levels) []Rule {
	_, rules := Explain(l)
	return rules
}

// normalize sorts the rules and drops the repeated ones.
func normalize(rules []Rule) []Rule {
	slices.SortFunc(rules, func(a, b Rule) int {
		return cmp.Or(cmp.Compare(a.Kind, b.Kind), cmp.Compare(a.OffsetMinutes, b.OffsetMinutes), cmp.Compare(a.TimeOfDay, b.TimeOfDay))
	})
	return slices.Compact(rules)
}

// CategorySettings finds the settings for the categories of a task. Each category counts with
// its own settings, or with those of its nearest ancestor that has some. byCategory has the
// settings that exist, parents the tree. The cycle guard keeps a damaged tree from looping.
func CategorySettings(ids []uuid.UUID, parents map[uuid.UUID]uuid.UUID, byCategory map[uuid.UUID]*Setting) []*Setting {
	var out []*Setting
	seenLevel := map[*Setting]bool{}
	for _, id := range ids {
		cur := id
		for steps := 0; steps <= len(parents)+1; steps++ {
			if s, ok := byCategory[cur]; ok {
				if !seenLevel[s] {
					seenLevel[s] = true
					out = append(out, s)
				}
				break
			}
			parent, ok := parents[cur]
			if !ok {
				break
			}
			cur = parent
		}
	}
	return out
}

// FireAt is when a rule of a task fires.
func (r Rule) FireAt(start, end time.Time) time.Time {
	d := time.Duration(r.OffsetMinutes) * time.Minute
	switch r.Kind {
	case BeforeStart:
		return start.Add(-d)
	case NotStarted:
		return start.Add(d)
	default: // AfterEnd, Overrun
		return end.Add(d)
	}
}

// Needed reports whether the message is still wanted at `now`, by the state of the task.
// The planner asks when it queues the message and the sender again when it sends it.
func Needed(kind Kind, status string, end, now time.Time) bool {
	switch kind {
	case BeforeStart, NotStarted:
		return status == "planned" && now.Before(end)
	case AfterEnd:
		return status == "planned"
	case Overrun:
		return status == "in_progress"
	}
	return false
}

// Quiet is an interval of the local day when the bot does not write. It may wrap midnight.
type Quiet struct {
	// Start and End are minutes from local midnight.
	Start, End int
}

func (q Quiet) contains(minute int) bool {
	switch {
	case q.Start == q.End:
		return false
	case q.Start < q.End:
		return minute >= q.Start && minute < q.End
	default:
		return minute >= q.Start || minute < q.End
	}
}

// Shift moves an instant that falls into quiet hours to their end (FR-9.4).
func (q *Quiet) Shift(t time.Time, loc *time.Location) time.Time {
	if q == nil {
		return t
	}
	w := recurrence.WallOf(t, loc)
	minute := w.Hour()*60 + w.Minute()
	if !q.contains(minute) {
		return t
	}
	day := time.Date(w.Year(), w.Month(), w.Day(), 0, 0, 0, 0, time.UTC)
	// The end is on the same date, unless the interval wraps midnight and we are before it.
	if q.Start > q.End && minute >= q.Start {
		day = day.AddDate(0, 0, 1)
	}
	end := day.Add(time.Duration(q.End) * time.Minute)
	return recurrence.Instant(end, loc)
}

// HabitFireAt is the instant of a time of day on a local date.
func HabitFireAt(year int, month time.Month, day, timeOfDay int, loc *time.Location) time.Time {
	w := time.Date(year, month, day, 0, 0, 0, 0, time.UTC).Add(time.Duration(timeOfDay) * time.Minute)
	return recurrence.Instant(w, loc)
}
