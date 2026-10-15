package recurrence

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestParseRoundTrip(t *testing.T) {
	for _, s := range []string{
		"FREQ=DAILY",
		"FREQ=DAILY;INTERVAL=3",
		"FREQ=WEEKLY;BYDAY=MO,WE,FR",
		"FREQ=WEEKLY;INTERVAL=2;BYDAY=TU",
		"FREQ=WEEKLY",
		"FREQ=MONTHLY;BYMONTHDAY=15",
		"FREQ=MONTHLY;BYDAY=2TU",
		"FREQ=MONTHLY;BYDAY=-1FR",
		"FREQ=MONTHLY",
		"FREQ=YEARLY",
		"FREQ=DAILY;COUNT=10",
		"FREQ=WEEKLY;BYDAY=SA;UNTIL=20261231T205959Z",
		"FREQ=MONTHLY;INTERVAL=6;BYMONTHDAY=31;COUNT=4",
	} {
		r, err := Parse(s)
		if err != nil {
			t.Errorf("Parse(%q): %v", s, err)
			continue
		}
		if got := r.String(); got != s {
			t.Errorf("String() = %q, want %q", got, s)
		}
	}
}

func TestParseNormalisesOrder(t *testing.T) {
	r, err := Parse("COUNT=3;BYDAY=MO;INTERVAL=1;FREQ=WEEKLY")
	if err != nil {
		t.Fatal(err)
	}
	if got := r.String(); got != "FREQ=WEEKLY;BYDAY=MO;COUNT=3" {
		t.Errorf("String() = %q", got)
	}
}

func TestParseRejects(t *testing.T) {
	for name, s := range map[string]string{
		"empty":                "",
		"no freq":              "INTERVAL=2",
		"hourly":               "FREQ=HOURLY",
		"lowercase":            "freq=daily",
		"unsupported part":     "FREQ=DAILY;BYHOUR=9",
		"set position":         "FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=1",
		"duplicate key":        "FREQ=DAILY;FREQ=WEEKLY",
		"zero interval":        "FREQ=DAILY;INTERVAL=0",
		"huge interval":        "FREQ=DAILY;INTERVAL=1000",
		"zero count":           "FREQ=DAILY;COUNT=0",
		"huge count":           "FREQ=DAILY;COUNT=1001",
		"count and until":      "FREQ=DAILY;COUNT=2;UNTIL=20261231T000000Z",
		"until without Z":      "FREQ=DAILY;UNTIL=20261231T000000",
		"until date only":      "FREQ=DAILY;UNTIL=20261231",
		"byday on daily":       "FREQ=DAILY;BYDAY=MO",
		"byday on yearly":      "FREQ=YEARLY;BYDAY=MO",
		"ordinal in weekly":    "FREQ=WEEKLY;BYDAY=2MO",
		"repeated weekday":     "FREQ=WEEKLY;BYDAY=MO,MO",
		"two monthly weekdays": "FREQ=MONTHLY;BYDAY=1MO,2TU",
		"monthly weekday no n": "FREQ=MONTHLY;BYDAY=MO",
		"bad weekday":          "FREQ=WEEKLY;BYDAY=XX",
		"bad ordinal":          "FREQ=MONTHLY;BYDAY=6MO",
		"zero ordinal":         "FREQ=MONTHLY;BYDAY=0MO",
		"bymonthday on weekly": "FREQ=WEEKLY;BYMONTHDAY=1",
		"bymonthday 32":        "FREQ=MONTHLY;BYMONTHDAY=32",
		"bymonthday and byday": "FREQ=MONTHLY;BYMONTHDAY=1;BYDAY=1MO",
		"empty value":          "FREQ=",
		"trailing semicolon":   "FREQ=DAILY;",
		"too long":             "FREQ=WEEKLY;BYDAY=" + strings.Repeat("MO,", 100),
		"RRULE prefix":         "RRULE:FREQ=DAILY",
		"dtstart inside":       "DTSTART:20261014T090000;FREQ=DAILY",
		"negative monthday":    "FREQ=MONTHLY;BYMONTHDAY=-1",
		"non numeric interval": "FREQ=DAILY;INTERVAL=two",
		"wrong separator":      "FREQ=DAILY,INTERVAL=2",
	} {
		if _, err := Parse(s); !errors.Is(err, ErrInvalidRule) {
			t.Errorf("%s: Parse(%q) err = %v, want ErrInvalidRule", name, s, err)
		}
	}
}

func mustParse(t *testing.T, s string) Rule {
	t.Helper()
	r, err := Parse(s)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func loc(t *testing.T, name string) *time.Location {
	t.Helper()
	l, err := time.LoadLocation(name)
	if err != nil {
		t.Fatal(err)
	}
	return l
}

// wall builds a wall time (floating, in UTC).
func wall(y int, m time.Month, d, h, mi int) Wall { return time.Date(y, m, d, h, mi, 0, 0, time.UTC) }

func day(t time.Time, l *time.Location) string { return t.In(l).Format("2006-01-02 Mon 15:04") }

func expand(t *testing.T, rule string, start Wall, l *time.Location, from, to time.Time) []string {
	t.Helper()
	got, err := Occurrences(mustParse(t, rule), start, l, from, to)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, len(got))
	for i, o := range got {
		out[i] = day(o, l)
	}
	return out
}

func eq(t *testing.T, got, want []string) {
	t.Helper()
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}

func TestInstantAroundClockChanges(t *testing.T) {
	ny := loc(t, "America/New_York")
	tests := []struct {
		name string
		wall Wall
		want string // UTC
	}{
		{"ordinary time", wall(2026, 7, 4, 9, 0), "2026-07-04T13:00:00Z"},
		// 2026-03-08: 02:00 EST jumps to 03:00 EDT; 02:30 does not exist and uses the
		// offset from before the jump (EST), which is 03:30 EDT.
		{"time skipped when the clocks go forward", wall(2026, 3, 8, 2, 30), "2026-03-08T07:30:00Z"},
		{"just before the jump", wall(2026, 3, 8, 1, 59), "2026-03-08T06:59:00Z"},
		{"just after the jump", wall(2026, 3, 8, 3, 0), "2026-03-08T07:00:00Z"},
		// 2026-11-01: 02:00 EDT goes back to 01:00 EST; 01:30 happens twice, the first one counts.
		{"time repeated when the clocks go back", wall(2026, 11, 1, 1, 30), "2026-11-01T05:30:00Z"},
		{"after the repeated hour", wall(2026, 11, 1, 2, 30), "2026-11-01T07:30:00Z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Instant(tt.wall, ny).UTC().Format(time.RFC3339); got != tt.want {
				t.Errorf("Instant = %s, want %s", got, tt.want)
			}
		})
	}
}

func TestInstantInZonesWithoutDST(t *testing.T) {
	if got := Instant(wall(2026, 10, 14, 10, 0), loc(t, "Europe/Moscow")).UTC().Format(time.RFC3339); got != "2026-10-14T07:00:00Z" {
		t.Errorf("Moscow: %s", got)
	}
	if got := Instant(wall(2026, 10, 14, 10, 0), loc(t, "Asia/Kolkata")).UTC().Format(time.RFC3339); got != "2026-10-14T04:30:00Z" {
		t.Errorf("Kolkata: %s", got)
	}
	// Lord Howe has a 30-minute DST change: 02:15 on 2026-10-04 does not exist and uses the
	// offset from before the jump (+10:30).
	lh := loc(t, "Australia/Lord_Howe")
	if got := Instant(wall(2026, 10, 4, 2, 15), lh).UTC().Format(time.RFC3339); got != "2026-10-03T15:45:00Z" {
		t.Errorf("Lord Howe, skipped time: %s", got)
	}
}

func TestWallOfAndInstantAreInverse(t *testing.T) {
	for _, name := range []string{"UTC", "Europe/Moscow", "America/New_York", "Australia/Lord_Howe", "Asia/Kathmandu"} {
		l := loc(t, name)
		for d := 0; d < 400; d++ {
			at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(d) * 17 * time.Hour)
			if got := Instant(WallOf(at, l), l); !got.Equal(at) {
				// Only the repeated hour may map to the earlier of its two instants.
				if !got.Before(at) || at.Sub(got) > time.Hour {
					t.Fatalf("%s: Instant(WallOf(%s)) = %s", name, at, got)
				}
			}
		}
	}
}

func TestDailyKeepsWallClockAcrossClockChanges(t *testing.T) {
	ny := loc(t, "America/New_York")
	got, err := Occurrences(mustParse(t, "FREQ=DAILY"), wall(2026, 3, 6, 9, 0), ny,
		Instant(wall(2026, 3, 6, 0, 0), ny), Instant(wall(2026, 3, 11, 0, 0), ny))
	if err != nil {
		t.Fatal(err)
	}
	var utc []string
	for _, o := range got {
		utc = append(utc, o.UTC().Format("01-02 15:04"))
	}
	// 09:00 local is 14:00 UTC in winter and 13:00 UTC after the clocks go forward on 03-08.
	eq(t, utc, []string{"03-06 14:00", "03-07 14:00", "03-08 13:00", "03-09 13:00", "03-10 13:00"})
}

func TestDailyAtSkippedTime(t *testing.T) {
	ny := loc(t, "America/New_York")
	got, _ := Occurrences(mustParse(t, "FREQ=DAILY"), wall(2026, 3, 6, 2, 30), ny,
		Instant(wall(2026, 3, 6, 0, 0), ny), Instant(wall(2026, 3, 11, 0, 0), ny))
	var utc []string
	for _, o := range got {
		utc = append(utc, o.UTC().Format("01-02 15:04"))
	}
	// On 03-08 there is no 02:30; the occurrence stays on that day, at 03:30 EDT.
	eq(t, utc, []string{"03-06 07:30", "03-07 07:30", "03-08 07:30", "03-09 06:30", "03-10 06:30"})
}

func TestWeeklyAcrossFallBack(t *testing.T) {
	ny := loc(t, "America/New_York")
	got, _ := Occurrences(mustParse(t, "FREQ=WEEKLY;BYDAY=MO"), wall(2026, 10, 19, 9, 0), ny,
		Instant(wall(2026, 10, 19, 0, 0), ny), Instant(wall(2026, 11, 10, 0, 0), ny))
	var utc []string
	for _, o := range got {
		utc = append(utc, o.UTC().Format("01-02 15:04"))
	}
	eq(t, utc, []string{"10-19 13:00", "10-26 13:00", "11-02 14:00", "11-09 14:00"})
}

func TestWeeklyOnSeveralDaysWithInterval(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	// Every 2 weeks on Monday and Thursday, starting Monday 2026-10-12.
	eq(t, expand(t, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH", wall(2026, 10, 12, 18, 30), msk,
		Instant(wall(2026, 10, 12, 0, 0), msk), Instant(wall(2026, 11, 10, 0, 0), msk)),
		[]string{"2026-10-12 Mon 18:30", "2026-10-15 Thu 18:30", "2026-10-26 Mon 18:30", "2026-10-29 Thu 18:30", "2026-11-09 Mon 18:30"})
}

func TestWeeklyStartedOnAnotherWeekday(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	// 2026-10-14 is a Wednesday: the first Monday occurrence is on the 19th.
	eq(t, expand(t, "FREQ=WEEKLY;BYDAY=MO", wall(2026, 10, 14, 9, 0), msk,
		Instant(wall(2026, 10, 1, 0, 0), msk), Instant(wall(2026, 10, 27, 0, 0), msk)),
		[]string{"2026-10-19 Mon 09:00", "2026-10-26 Mon 09:00"})
	first, ok, err := First(mustParse(t, "FREQ=WEEKLY;BYDAY=MO"), wall(2026, 10, 14, 9, 0), msk)
	if err != nil || !ok || day(first, msk) != "2026-10-19 Mon 09:00" {
		t.Errorf("First = %v, %v, %v", day(first, msk), ok, err)
	}
}

func TestWeeklyWithoutByDayUsesTheStartWeekday(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	eq(t, expand(t, "FREQ=WEEKLY", wall(2026, 10, 14, 9, 0), msk,
		Instant(wall(2026, 10, 1, 0, 0), msk), Instant(wall(2026, 11, 1, 0, 0), msk)),
		[]string{"2026-10-14 Wed 09:00", "2026-10-21 Wed 09:00", "2026-10-28 Wed 09:00"})
}

func TestMonthlyByDayOfMonth(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	// The 31st exists only in some months; the others are skipped (RFC 5545).
	eq(t, expand(t, "FREQ=MONTHLY;BYMONTHDAY=31", wall(2026, 1, 31, 9, 0), msk,
		Instant(wall(2026, 1, 1, 0, 0), msk), Instant(wall(2026, 8, 1, 0, 0), msk)),
		[]string{"2026-01-31 Sat 09:00", "2026-03-31 Tue 09:00", "2026-05-31 Sun 09:00", "2026-07-31 Fri 09:00"})
	// Without BYMONTHDAY the day of the start is used.
	eq(t, expand(t, "FREQ=MONTHLY", wall(2026, 1, 15, 9, 0), msk,
		Instant(wall(2026, 1, 1, 0, 0), msk), Instant(wall(2026, 4, 1, 0, 0), msk)),
		[]string{"2026-01-15 Thu 09:00", "2026-02-15 Sun 09:00", "2026-03-15 Sun 09:00"})
}

func TestMonthlyOnNthWeekday(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	eq(t, expand(t, "FREQ=MONTHLY;BYDAY=2TU", wall(2026, 1, 1, 9, 0), msk,
		Instant(wall(2026, 1, 1, 0, 0), msk), Instant(wall(2026, 5, 1, 0, 0), msk)),
		[]string{"2026-01-13 Tue 09:00", "2026-02-10 Tue 09:00", "2026-03-10 Tue 09:00", "2026-04-14 Tue 09:00"})
	eq(t, expand(t, "FREQ=MONTHLY;BYDAY=-1FR", wall(2026, 1, 1, 9, 0), msk,
		Instant(wall(2026, 1, 1, 0, 0), msk), Instant(wall(2026, 4, 1, 0, 0), msk)),
		[]string{"2026-01-30 Fri 09:00", "2026-02-27 Fri 09:00", "2026-03-27 Fri 09:00"})
}

func TestYearly(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	eq(t, expand(t, "FREQ=YEARLY", wall(2026, 10, 14, 9, 0), msk,
		Instant(wall(2026, 1, 1, 0, 0), msk), Instant(wall(2029, 1, 1, 0, 0), msk)),
		[]string{"2026-10-14 Wed 09:00", "2027-10-14 Thu 09:00", "2028-10-14 Sat 09:00"})
	// A 29 February start repeats only in leap years.
	eq(t, expand(t, "FREQ=YEARLY", wall(2024, 2, 29, 9, 0), msk,
		Instant(wall(2024, 1, 1, 0, 0), msk), Instant(wall(2033, 1, 1, 0, 0), msk)),
		[]string{"2024-02-29 Thu 09:00", "2028-02-29 Tue 09:00", "2032-02-29 Sun 09:00"})
}

func TestEveryNDays(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	eq(t, expand(t, "FREQ=DAILY;INTERVAL=3", wall(2026, 10, 14, 9, 0), msk,
		Instant(wall(2026, 10, 14, 0, 0), msk), Instant(wall(2026, 10, 25, 0, 0), msk)),
		[]string{"2026-10-14 Wed 09:00", "2026-10-17 Sat 09:00", "2026-10-20 Tue 09:00", "2026-10-23 Fri 09:00"})
}

func TestCountAndUntil(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	wide := func(rule string) []string {
		return expand(t, rule, wall(2026, 10, 14, 9, 0), msk,
			Instant(wall(2026, 1, 1, 0, 0), msk), Instant(wall(2030, 1, 1, 0, 0), msk))
	}
	eq(t, wide("FREQ=DAILY;COUNT=3"), []string{"2026-10-14 Wed 09:00", "2026-10-15 Thu 09:00", "2026-10-16 Fri 09:00"})

	// UNTIL is the last moment an occurrence may start: inclusive.
	until := Instant(wall(2026, 10, 16, 9, 0), msk).UTC().Format(untilLayout)
	eq(t, wide("FREQ=DAILY;UNTIL="+until), []string{"2026-10-14 Wed 09:00", "2026-10-15 Thu 09:00", "2026-10-16 Fri 09:00"})
	justBefore := Instant(wall(2026, 10, 16, 8, 59), msk).UTC().Format(untilLayout)
	eq(t, wide("FREQ=DAILY;UNTIL="+justBefore), []string{"2026-10-14 Wed 09:00", "2026-10-15 Thu 09:00"})
}

func TestWindowIsHalfOpenAndIndependentOfStart(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	start := wall(2020, 1, 1, 9, 0)
	from := Instant(wall(2026, 10, 14, 9, 0), msk) // exactly an occurrence
	to := Instant(wall(2026, 10, 16, 9, 0), msk)   // exactly an occurrence
	eq(t, expand(t, "FREQ=DAILY", start, msk, from, to), []string{"2026-10-14 Wed 09:00", "2026-10-15 Thu 09:00"})
	// Years after the start: same answer, nothing is generated in between beforehand.
	eq(t, expand(t, "FREQ=DAILY", start, msk, from.Add(time.Second), to), []string{"2026-10-15 Thu 09:00"})
	if got := expand(t, "FREQ=DAILY", wall(2030, 1, 1, 9, 0), msk, from, to); len(got) != 0 {
		t.Errorf("a series that starts later has occurrences %v", got)
	}
}

func TestOccurrencesNearMidnightBelongToTheirLocalDay(t *testing.T) {
	// 23:30 in Auckland (UTC+13 in summer) is 10:30 UTC the same day.
	akl := loc(t, "Pacific/Auckland")
	got, _ := Occurrences(mustParse(t, "FREQ=DAILY"), wall(2026, 12, 1, 23, 30), akl,
		Instant(wall(2026, 12, 1, 0, 0), akl), Instant(wall(2026, 12, 3, 0, 0), akl))
	if len(got) != 2 || got[0].UTC().Format(time.RFC3339) != "2026-12-01T10:30:00Z" {
		t.Errorf("got %v", got)
	}
}

func TestTooManyOccurrences(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	_, err := Occurrences(mustParse(t, "FREQ=DAILY"), wall(2020, 1, 1, 9, 0), msk,
		Instant(wall(2020, 1, 1, 0, 0), msk), Instant(wall(2026, 1, 1, 0, 0), msk))
	if !errors.Is(err, ErrTooManyOccurrences) {
		t.Errorf("err = %v, want ErrTooManyOccurrences", err)
	}
}

func TestCountBeforeAndFirst(t *testing.T) {
	msk := loc(t, "Europe/Moscow")
	r := mustParse(t, "FREQ=DAILY;COUNT=10")
	start := wall(2026, 10, 14, 9, 0)

	for cutoff, want := range map[time.Time]int{
		Instant(wall(2026, 10, 14, 9, 0), msk): 0, // the cutoff itself is not before it
		Instant(wall(2026, 10, 14, 9, 1), msk): 1,
		Instant(wall(2026, 10, 17, 0, 0), msk): 3,
		Instant(wall(2027, 1, 1, 0, 0), msk):   10, // capped by COUNT
	} {
		got, err := CountBefore(r, start, msk, cutoff)
		if err != nil || got != want {
			t.Errorf("CountBefore(%s) = %d, %v; want %d", cutoff, got, err, want)
		}
	}

	first, ok, err := First(r, start, msk)
	if err != nil || !ok || day(first, msk) != "2026-10-14 Wed 09:00" {
		t.Errorf("First = %v %v %v", first, ok, err)
	}
	// A rule that ends before it starts has no first occurrence.
	past := Instant(wall(2026, 10, 1, 0, 0), msk).UTC().Format(untilLayout)
	if _, ok, _ := First(mustParse(t, "FREQ=DAILY;UNTIL="+past), start, msk); ok {
		t.Error("First found an occurrence after UNTIL")
	}
}
