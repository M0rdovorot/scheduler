// Package stats turns the tasks of a period into the numbers of the statistics
// screen (FR-8): hours by category and by task, the total busy time, plan against
// fact, the breakdown by day, and the deviations.
//
// Everything is counted by the fact. The aggregation is done here, over the tasks
// that overlap the period, rather than in SQL: the boundaries of local days, clock
// changes and the union of intervals are easier to get right and to test in Go,
// and a user's tasks in a period are few.
package stats

import (
	"cmp"
	"math"
	"slices"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
)

// MaxTimerDuration caps a timer that was never stopped: only its first hours count,
// so that a forgotten "Start" does not fill the statistics until it is noticed.
const MaxTimerDuration = 12 * time.Hour

// MaxDays bounds the number of days of the breakdown.
const MaxDays = 400

type Input struct {
	Instances  []task.Instance
	Categories []category.Category
	// The period is [From, To).
	From, To time.Time
	Now      time.Time
	// Loc is the user's time zone: days are local days.
	Loc *time.Location
}

type CategoryMinutes struct {
	CategoryID uuid.UUID
	Minutes    int
}

type TaskGroup struct {
	Title   string
	Count   int
	Minutes int
}

type DayCategory struct {
	// CategoryID is uuid.Nil for tasks without a category.
	CategoryID uuid.UUID
	Minutes    int
}

type Day struct {
	// Date is the local date, "2006-01-02".
	Date string
	// Minutes is the busy time of the day: parallel tasks are not counted twice.
	Minutes int
	// ByCategory splits the sum of the tasks of the day by the color category of each
	// task (its first category by name). Parallel tasks add up here.
	ByCategory []DayCategory
}

type PlanVsFact struct {
	// Planned tasks of the period (by planned start), without rescheduled originals.
	PlannedCount int
	Done         int
	Partial      int
	NotDone      int
	InProgress   int
	// Unmarked are planned tasks whose time is over and nobody marked them (FR-8.7).
	Unmarked int
	// Upcoming are planned tasks whose time has not come yet.
	Upcoming int
	// Rescheduled originals; their replacements are counted as planned tasks.
	Rescheduled int
	// LateStarts and Overran count tasks with the deviations started_late and finished_late.
	LateStarts int
	Overran    int
	// PercentDone is done / (done + partial + not done + unmarked), rounded; nil when
	// no task has been decided yet.
	PercentDone *int
}

type DeviationItem struct {
	Instance task.Instance
}

type Report struct {
	From, To time.Time

	// ActualMinutes and PlannedMinutes are the busy time by the fact and by the plan:
	// unions of intervals, so parallel tasks are not counted twice (FR-8.3).
	ActualMinutes  int
	PlannedMinutes int
	// UnplannedMinutes is the part of the fact that belongs to tasks outside the plan
	// (they are included in ActualMinutes and in the categories); UnplannedCount their number.
	UnplannedMinutes int
	UnplannedCount   int
	// LongRunning is the number of timers that run for longer than MaxTimerDuration.
	LongRunning int

	// Categories holds the sum of the hours of the tasks of each category and of all its
	// subcategories. A task counts once in each category of its categories and their
	// ancestors (FR-8.2). Only categories with time are listed.
	Categories           []CategoryMinutes
	UncategorizedMinutes int
	Tasks                []TaskGroup
	Days                 []Day
	PlanVsFact           PlanVsFact
	Deviations           []DeviationItem
}

type interval struct{ start, end time.Time }

func (iv interval) seconds() float64 { return iv.end.Sub(iv.start).Seconds() }

// factOf is the fact of a task: a finished task by its times, a running one up to
// now (at most MaxTimerDuration). capped says that the cap was applied.
func factOf(in task.Instance, now time.Time) (iv interval, ok, capped bool) {
	switch in.Status {
	case "in_progress", "done", "partial":
	default:
		return interval{}, false, false
	}
	if in.ActualStart == nil {
		return interval{}, false, false
	}
	start := *in.ActualStart
	end := now
	if in.ActualEnd != nil {
		end = *in.ActualEnd
	} else if end.Sub(start) > MaxTimerDuration {
		end, capped = start.Add(MaxTimerDuration), true
	}
	if end.Before(start) {
		end = start
	}
	return interval{start, end}, true, capped
}

// planOf is the plan of a task, unless it is a rescheduled original (it is replaced
// by a new task) or has no plan.
func planOf(in task.Instance) (interval, bool) {
	if in.PlannedStart == nil || in.PlannedEnd == nil {
		return interval{}, false
	}
	if in.Status == "rescheduled" || in.Status == "cancelled" {
		return interval{}, false
	}
	return interval{*in.PlannedStart, *in.PlannedEnd}, true
}

func clip(iv interval, from, to time.Time) (interval, bool) {
	if iv.start.Before(from) {
		iv.start = from
	}
	if iv.end.After(to) {
		iv.end = to
	}
	return iv, iv.end.After(iv.start)
}

// unionSeconds is the length of the union of the intervals.
func unionSeconds(ivs []interval) float64 {
	if len(ivs) == 0 {
		return 0
	}
	sorted := slices.Clone(ivs)
	slices.SortFunc(sorted, func(a, b interval) int { return a.start.Compare(b.start) })
	total := 0.0
	cur := sorted[0]
	for _, iv := range sorted[1:] {
		if iv.start.After(cur.end) {
			total += cur.seconds()
			cur = iv
			continue
		}
		if iv.end.After(cur.end) {
			cur.end = iv.end
		}
	}
	return total + cur.seconds()
}

func minutes(seconds float64) int { return int(math.Round(seconds / 60)) }

// tree answers questions about the category tree.
type tree struct {
	parent map[uuid.UUID]*uuid.UUID
	name   map[uuid.UUID]string
}

func newTree(cats []category.Category) tree {
	t := tree{parent: map[uuid.UUID]*uuid.UUID{}, name: map[uuid.UUID]string{}}
	for _, c := range cats {
		t.parent[c.ID] = c.ParentID
		t.name[c.ID] = c.Name
	}
	return t
}

// withAncestors is the set of the categories and all their ancestors, each once.
// Unknown ids are ignored; a cycle (which the service prevents) cannot loop.
func (t tree) withAncestors(ids []uuid.UUID) map[uuid.UUID]bool {
	set := map[uuid.UUID]bool{}
	for _, id := range ids {
		for cur := &id; cur != nil; cur = t.parent[*cur] {
			if _, known := t.parent[*cur]; !known || set[*cur] {
				break
			}
			set[*cur] = true
		}
	}
	return set
}

// primary is the category whose color a task has: the first by name, then by id.
func (t tree) primary(ids []uuid.UUID) uuid.UUID {
	best := uuid.Nil
	for _, id := range ids {
		if _, known := t.name[id]; !known {
			continue
		}
		if best == uuid.Nil || cmp.Or(
			strings.Compare(strings.ToLower(t.name[id]), strings.ToLower(t.name[best])),
			strings.Compare(id.String(), best.String()),
		) < 0 {
			best = id
		}
	}
	return best
}

// Compute builds the report of the period.
func Compute(in Input) Report {
	loc := in.Loc
	if loc == nil {
		loc = time.UTC
	}
	rep := Report{From: in.From, To: in.To}
	cats := newTree(in.Categories)

	var factAll, planAll []interval
	categorySeconds := map[uuid.UUID]float64{}
	var uncategorizedSeconds, unplannedSeconds float64
	taskSeconds := map[string]*struct {
		count   int
		seconds float64
	}{}

	days := dayWindows(in.From, in.To, loc)
	type dayAcc struct {
		facts      []interval
		byCategory map[uuid.UUID]float64
	}
	perDay := make([]dayAcc, len(days))
	for i := range perDay {
		perDay[i].byCategory = map[uuid.UUID]float64{}
	}

	for _, inst := range in.Instances {
		if fact, ok, capped := factOf(inst, in.Now); ok {
			if capped && fact.end.After(in.From) && fact.start.Before(in.To) {
				rep.LongRunning++
			}
			if f, ok := clip(fact, in.From, in.To); ok {
				factAll = append(factAll, f)
				secs := f.seconds()

				set := cats.withAncestors(inst.CategoryIDs)
				if len(set) == 0 {
					uncategorizedSeconds += secs
				}
				for id := range set {
					categorySeconds[id] += secs
				}

				group := taskSeconds[inst.Title]
				if group == nil {
					group = &struct {
						count   int
						seconds float64
					}{}
					taskSeconds[inst.Title] = group
				}
				group.count++
				group.seconds += secs

				if inst.PlannedStart == nil {
					unplannedSeconds += secs
					rep.UnplannedCount++
				}

				primary := cats.primary(inst.CategoryIDs)
				for i, w := range days {
					if d, ok := clip(f, w.start, w.end); ok {
						perDay[i].facts = append(perDay[i].facts, d)
						perDay[i].byCategory[primary] += d.seconds()
					}
				}
			}
		}
		if plan, ok := planOf(inst); ok {
			if p, ok := clip(plan, in.From, in.To); ok {
				planAll = append(planAll, p)
			}
		}
	}

	rep.ActualMinutes = minutes(unionSeconds(factAll))
	rep.PlannedMinutes = minutes(unionSeconds(planAll))
	rep.UnplannedMinutes = minutes(unplannedSeconds)
	rep.UncategorizedMinutes = minutes(uncategorizedSeconds)

	for id, secs := range categorySeconds {
		if m := minutes(secs); m > 0 {
			rep.Categories = append(rep.Categories, CategoryMinutes{CategoryID: id, Minutes: m})
		}
	}
	slices.SortFunc(rep.Categories, func(a, b CategoryMinutes) int {
		return cmp.Or(cmp.Compare(b.Minutes, a.Minutes), strings.Compare(a.CategoryID.String(), b.CategoryID.String()))
	})

	for title, g := range taskSeconds {
		rep.Tasks = append(rep.Tasks, TaskGroup{Title: title, Count: g.count, Minutes: minutes(g.seconds)})
	}
	slices.SortFunc(rep.Tasks, func(a, b TaskGroup) int {
		return cmp.Or(cmp.Compare(b.Minutes, a.Minutes), strings.Compare(a.Title, b.Title))
	})

	for i, w := range days {
		day := Day{Date: w.date, Minutes: minutes(unionSeconds(perDay[i].facts))}
		for id, secs := range perDay[i].byCategory {
			if m := minutes(secs); m > 0 {
				day.ByCategory = append(day.ByCategory, DayCategory{CategoryID: id, Minutes: m})
			}
		}
		slices.SortFunc(day.ByCategory, func(a, b DayCategory) int {
			return cmp.Or(cmp.Compare(b.Minutes, a.Minutes), strings.Compare(a.CategoryID.String(), b.CategoryID.String()))
		})
		rep.Days = append(rep.Days, day)
	}

	rep.PlanVsFact, rep.Deviations = planVsFact(in)
	return rep
}

type dayWindow struct {
	date       string
	start, end time.Time
}

// dayWindows splits [from, to) into local days (a day is 23 or 25 hours long when the clocks change).
func dayWindows(from, to time.Time, loc *time.Location) []dayWindow {
	local := from.In(loc)
	cursor := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, loc)
	var out []dayWindow
	for cursor.Before(to) && len(out) < MaxDays {
		next := time.Date(cursor.Year(), cursor.Month(), cursor.Day()+1, 0, 0, 0, 0, loc)
		start, end := cursor, next
		if start.Before(from) {
			start = from
		}
		if end.After(to) {
			end = to
		}
		out = append(out, dayWindow{date: cursor.Format("2006-01-02"), start: start, end: end})
		cursor = next
	}
	return out
}

func planVsFact(in Input) (PlanVsFact, []DeviationItem) {
	var pf PlanVsFact
	var items []DeviationItem
	for _, inst := range in.Instances {
		// A task belongs to the period by its planned start.
		if inst.PlannedStart == nil || inst.PlannedStart.Before(in.From) || !inst.PlannedStart.Before(in.To) {
			continue
		}
		switch inst.Status {
		case "cancelled":
			continue
		case "rescheduled":
			pf.Rescheduled++
		default:
			pf.PlannedCount++
			switch inst.Status {
			case "done":
				pf.Done++
			case "partial":
				pf.Partial++
			case "not_done":
				pf.NotDone++
			case "in_progress":
				pf.InProgress++
			case "planned":
				if inst.PlannedEnd != nil && !inst.PlannedEnd.After(in.Now) {
					pf.Unmarked++
				} else {
					pf.Upcoming++
				}
			}
		}

		for _, d := range inst.Deviations {
			switch d.Kind {
			case task.StartedLate:
				pf.LateStarts++
			case task.FinishedLate:
				pf.Overran++
			}
		}
		explained := inst.Comment != "" && (inst.Status == "not_done" || inst.Status == "partial" || inst.Status == "rescheduled")
		if len(inst.Deviations) > 0 || explained {
			items = append(items, DeviationItem{Instance: inst})
		}
	}

	if decided := pf.Done + pf.Partial + pf.NotDone + pf.Unmarked; decided > 0 {
		p := int(math.Round(float64(pf.Done) * 100 / float64(decided)))
		pf.PercentDone = &p
	}
	slices.SortFunc(items, func(a, b DeviationItem) int {
		return cmp.Or(a.Instance.PlannedStart.Compare(*b.Instance.PlannedStart), strings.Compare(a.Instance.ID.String(), b.Instance.ID.String()))
	})
	return pf, items
}
