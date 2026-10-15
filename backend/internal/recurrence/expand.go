package recurrence

import (
	"errors"
	"fmt"
	"slices"
	"time"

	rrule "github.com/teambition/rrule-go"
)

// MaxOccurrences bounds one expansion, a safety net against runaway rules.
const MaxOccurrences = 1000

var ErrTooManyOccurrences = errors.New("too many occurrences in the window")

// Wall is a wall-clock date and time without a zone, kept in a time.Time whose
// location is UTC. Rules are expanded in this "floating" form and only then
// turned into instants, because that is how RFC 5545 defines local repeats and
// because rrule-go gets the clocks-change nights wrong when given a zone.
type Wall = time.Time

// WallOf returns the wall clock of the instant in the zone.
func WallOf(instant time.Time, loc *time.Location) Wall {
	t := instant.In(loc)
	return time.Date(t.Year(), t.Month(), t.Day(), t.Hour(), t.Minute(), t.Second(), 0, time.UTC)
}

// Instant turns a wall time into an instant in the zone, following RFC 5545:
// a time that does not exist (the clocks jump forward) uses the offset from
// before the jump, and a time that happens twice (the clocks go back) means
// the first occurrence.
func Instant(w Wall, loc *time.Location) time.Time {
	_, before := w.Add(-24 * time.Hour).In(loc).Zone()
	_, after := w.Add(24 * time.Hour).In(loc).Zone()

	var candidates []time.Time
	for _, offset := range uniqueInts(before, after) {
		c := w.Add(-time.Duration(offset) * time.Second)
		if WallOf(c, loc).Equal(w) {
			candidates = append(candidates, c)
		}
	}
	if len(candidates) == 0 {
		return w.Add(-time.Duration(before) * time.Second)
	}
	return slices.MinFunc(candidates, func(a, b time.Time) int { return a.Compare(b) })
}

func uniqueInts(a, b int) []int {
	if a == b {
		return []int{a}
	}
	return []int{a, b}
}

func (r Rule) option(start Wall, loc *time.Location) (rrule.ROption, error) {
	opt := rrule.ROption{
		Interval: r.Interval,
		Count:    r.Count,
		Dtstart:  start,
	}
	switch r.Freq {
	case FreqDaily:
		opt.Freq = rrule.DAILY
	case FreqWeekly:
		opt.Freq = rrule.WEEKLY
	case FreqMonthly:
		opt.Freq = rrule.MONTHLY
	case FreqYearly:
		opt.Freq = rrule.YEARLY
	default:
		return opt, fmt.Errorf("%w: FREQ=%s", ErrInvalidRule, r.Freq)
	}
	for _, d := range r.ByDay {
		wd := weekdayToRRule(d.Weekday)
		if d.N != 0 {
			wd = wd.Nth(d.N)
		}
		opt.Byweekday = append(opt.Byweekday, wd)
	}
	if r.ByMonthDay != 0 {
		opt.Bymonthday = []int{r.ByMonthDay}
	}
	if r.Until != nil {
		opt.Until = WallOf(*r.Until, loc)
	}
	return opt, nil
}

func weekdayToRRule(d time.Weekday) rrule.Weekday {
	return [...]rrule.Weekday{rrule.SU, rrule.MO, rrule.TU, rrule.WE, rrule.TH, rrule.FR, rrule.SA}[d]
}

// Occurrences returns the start instants of the occurrences that begin in
// [from, to), in order. start is the wall time of the first occurrence slot
// (an occurrence only exists where it matches the rule, so a weekly Monday rule
// started on a Wednesday begins the next Monday).
func Occurrences(r Rule, start Wall, loc *time.Location, from, to time.Time) ([]time.Time, error) {
	opt, err := r.option(start, loc)
	if err != nil {
		return nil, err
	}
	rr, err := rrule.NewRRule(opt)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrInvalidRule, err)
	}

	// Pad the window by a day on both sides in wall time: the offset of the zone
	// is not known before the wall times are turned into instants.
	lo := WallOf(from, loc).Add(-24 * time.Hour)
	hi := WallOf(to, loc).Add(24 * time.Hour)

	var out []time.Time
	for _, w := range rr.Between(lo, hi, true) {
		at := Instant(w, loc)
		if at.Before(from) || !at.Before(to) {
			continue
		}
		out = append(out, at)
		if len(out) > MaxOccurrences {
			return nil, ErrTooManyOccurrences
		}
	}
	return out, nil
}

// First returns the first occurrence, or false if the rule has none.
func First(r Rule, start Wall, loc *time.Location) (time.Time, bool, error) {
	opt, err := r.option(start, loc)
	if err != nil {
		return time.Time{}, false, err
	}
	rr, err := rrule.NewRRule(opt)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("%w: %w", ErrInvalidRule, err)
	}
	next := rr.After(start.Add(-time.Second), true)
	if next.IsZero() {
		return time.Time{}, false, nil
	}
	return Instant(next, loc), true, nil
}

// CountBefore returns how many occurrences start before the cutoff.
func CountBefore(r Rule, start Wall, loc *time.Location, cutoff time.Time) (int, error) {
	opt, err := r.option(start, loc)
	if err != nil {
		return 0, err
	}
	rr, err := rrule.NewRRule(opt)
	if err != nil {
		return 0, fmt.Errorf("%w: %w", ErrInvalidRule, err)
	}
	n := 0
	for _, w := range rr.Between(start.Add(-time.Second), WallOf(cutoff, loc).Add(24*time.Hour), true) {
		if Instant(w, loc).Before(cutoff) {
			n++
		}
	}
	return n, nil
}
