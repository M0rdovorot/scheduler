// Package recurrence parses and expands the repeat rules of regular tasks
// (FR-4.1): RRULE (RFC 5545) restricted to what the editor can produce.
package recurrence

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

const (
	FreqDaily   = "DAILY"
	FreqWeekly  = "WEEKLY"
	FreqMonthly = "MONTHLY"
	FreqYearly  = "YEARLY"

	maxRuleLen  = 200
	maxInterval = 999
	maxCount    = 1000

	untilLayout = "20060102T150405Z"
)

var ErrInvalidRule = errors.New("invalid repeat rule")

// ByDay is a weekday of BYDAY. N is the ordinal for monthly rules ("the 2nd
// Tuesday" is N=2, "the last Friday" is N=-1); 0 means every such weekday.
type ByDay struct {
	N       int
	Weekday time.Weekday
}

// Rule is a repeat rule. The start is not part of it: it is stored next to it.
type Rule struct {
	Freq     string
	Interval int // 1 or more
	ByDay    []ByDay
	// ByMonthDay is the day of the month for monthly rules; 0 when unused.
	ByMonthDay int
	// Count limits the number of occurrences; 0 means no limit.
	Count int
	// Until is the last moment an occurrence may start (UTC); nil means no limit.
	Until *time.Time
}

var weekdayCodes = map[string]time.Weekday{
	"MO": time.Monday, "TU": time.Tuesday, "WE": time.Wednesday, "TH": time.Thursday,
	"FR": time.Friday, "SA": time.Saturday, "SU": time.Sunday,
}

func weekdayCode(d time.Weekday) string {
	for code, wd := range weekdayCodes {
		if wd == d {
			return code
		}
	}
	return ""
}

// Parse reads an RRULE value such as "FREQ=WEEKLY;BYDAY=MO,WE;COUNT=10" (no
// "RRULE:" prefix, no DTSTART) and rejects everything the editor cannot make.
func Parse(s string) (Rule, error) {
	if len(s) == 0 || len(s) > maxRuleLen {
		return Rule{}, fmt.Errorf("%w: length", ErrInvalidRule)
	}
	r := Rule{Interval: 1}
	seen := map[string]bool{}

	for _, part := range strings.Split(s, ";") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || value == "" || seen[key] {
			return Rule{}, fmt.Errorf("%w: %q", ErrInvalidRule, part)
		}
		seen[key] = true

		switch key {
		case "FREQ":
			switch value {
			case FreqDaily, FreqWeekly, FreqMonthly, FreqYearly:
				r.Freq = value
			default:
				return Rule{}, fmt.Errorf("%w: FREQ=%s", ErrInvalidRule, value)
			}
		case "INTERVAL":
			n, err := parseInt(value, 1, maxInterval)
			if err != nil {
				return Rule{}, fmt.Errorf("%w: INTERVAL", ErrInvalidRule)
			}
			r.Interval = n
		case "COUNT":
			n, err := parseInt(value, 1, maxCount)
			if err != nil {
				return Rule{}, fmt.Errorf("%w: COUNT", ErrInvalidRule)
			}
			r.Count = n
		case "UNTIL":
			t, err := time.Parse(untilLayout, value)
			if err != nil {
				return Rule{}, fmt.Errorf("%w: UNTIL must look like 20261231T205959Z", ErrInvalidRule)
			}
			r.Until = &t
		case "BYMONTHDAY":
			n, err := parseInt(value, 1, 31)
			if err != nil {
				return Rule{}, fmt.Errorf("%w: BYMONTHDAY", ErrInvalidRule)
			}
			r.ByMonthDay = n
		case "BYDAY":
			days, err := parseByDay(value)
			if err != nil {
				return Rule{}, err
			}
			r.ByDay = days
		default:
			return Rule{}, fmt.Errorf("%w: %s is not supported", ErrInvalidRule, key)
		}
	}
	return r, r.validate()
}

func (r Rule) validate() error {
	if r.Freq == "" {
		return fmt.Errorf("%w: FREQ is required", ErrInvalidRule)
	}
	if r.Count > 0 && r.Until != nil {
		return fmt.Errorf("%w: COUNT and UNTIL together", ErrInvalidRule)
	}
	if r.ByMonthDay != 0 && r.Freq != FreqMonthly {
		return fmt.Errorf("%w: BYMONTHDAY needs FREQ=MONTHLY", ErrInvalidRule)
	}
	if r.ByMonthDay != 0 && len(r.ByDay) > 0 {
		return fmt.Errorf("%w: BYDAY and BYMONTHDAY together", ErrInvalidRule)
	}

	switch r.Freq {
	case FreqWeekly:
		seen := map[time.Weekday]bool{}
		for _, d := range r.ByDay {
			if d.N != 0 || seen[d.Weekday] {
				return fmt.Errorf("%w: BYDAY of a weekly rule is a list of weekdays", ErrInvalidRule)
			}
			seen[d.Weekday] = true
		}
	case FreqMonthly:
		if len(r.ByDay) > 1 || (len(r.ByDay) == 1 && r.ByDay[0].N == 0) {
			return fmt.Errorf("%w: a monthly BYDAY is one ordinal weekday, like 2TU", ErrInvalidRule)
		}
	default:
		if len(r.ByDay) > 0 {
			return fmt.Errorf("%w: BYDAY needs FREQ=WEEKLY or MONTHLY", ErrInvalidRule)
		}
	}
	return nil
}

func parseByDay(value string) ([]ByDay, error) {
	var out []ByDay
	for _, item := range strings.Split(value, ",") {
		if len(item) < 2 {
			return nil, fmt.Errorf("%w: BYDAY=%s", ErrInvalidRule, value)
		}
		wd, ok := weekdayCodes[item[len(item)-2:]]
		if !ok {
			return nil, fmt.Errorf("%w: BYDAY=%s", ErrInvalidRule, value)
		}
		n := 0
		if prefix := item[:len(item)-2]; prefix != "" {
			v, err := strconv.Atoi(prefix)
			if err != nil || v == 0 || v < -1 || v > 5 {
				return nil, fmt.Errorf("%w: BYDAY=%s", ErrInvalidRule, value)
			}
			n = v
		}
		out = append(out, ByDay{N: n, Weekday: wd})
	}
	return out, nil
}

func parseInt(s string, lo, hi int) (int, error) {
	n, err := strconv.Atoi(s)
	if err != nil || n < lo || n > hi {
		return 0, ErrInvalidRule
	}
	return n, nil
}

// String is the canonical RRULE text: Parse(r.String()) gives back r.
func (r Rule) String() string {
	parts := []string{"FREQ=" + r.Freq}
	if r.Interval > 1 {
		parts = append(parts, "INTERVAL="+strconv.Itoa(r.Interval))
	}
	if len(r.ByDay) > 0 {
		items := make([]string, len(r.ByDay))
		for i, d := range r.ByDay {
			prefix := ""
			if d.N != 0 {
				prefix = strconv.Itoa(d.N)
			}
			items[i] = prefix + weekdayCode(d.Weekday)
		}
		parts = append(parts, "BYDAY="+strings.Join(items, ","))
	}
	if r.ByMonthDay != 0 {
		parts = append(parts, "BYMONTHDAY="+strconv.Itoa(r.ByMonthDay))
	}
	if r.Count > 0 {
		parts = append(parts, "COUNT="+strconv.Itoa(r.Count))
	}
	if r.Until != nil {
		parts = append(parts, "UNTIL="+r.Until.UTC().Format(untilLayout))
	}
	return strings.Join(parts, ";")
}
