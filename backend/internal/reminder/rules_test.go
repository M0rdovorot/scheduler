package reminder

import (
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var msk, _ = time.LoadLocation("Europe/Moscow")

func at(day, h, m int) time.Time { return time.Date(2026, 10, day, h, m, 0, 0, msk) }

func set(rules ...Rule) *Setting { return &Setting{Enabled: true, Rules: rules} }
func off() *Setting {
	return &Setting{Enabled: false, Rules: []Rule{{Kind: BeforeStart, OffsetMinutes: 5}}}
}

var (
	before10 = Rule{Kind: BeforeStart, OffsetMinutes: 10}
	before60 = Rule{Kind: BeforeStart, OffsetMinutes: 60}
	afterEnd = Rule{Kind: AfterEnd}
	late15   = Rule{Kind: NotStarted, OffsetMinutes: 15}
)

func TestTheMostSpecialLevelWins(t *testing.T) {
	g := set(before10, afterEnd)
	cases := []struct {
		name string
		l    Levels
		want []Rule
	}{
		{"global only", Levels{Global: g}, []Rule{afterEnd, before10}}, // sorted by kind
		{"category over global", Levels{Global: g, Categories: []*Setting{set(before60)}}, []Rule{before60}},
		{"series over category", Levels{Global: g, Categories: []*Setting{set(before60)}, Series: set(late15)}, []Rule{late15}},
		{"instance over series", Levels{Global: g, Series: set(late15), Instance: set(afterEnd)}, []Rule{afterEnd}},
		{"instance switched off", Levels{Global: g, Series: set(late15), Instance: off()}, nil},
		{"series switched off", Levels{Global: g, Categories: []*Setting{set(before60)}, Series: off()}, nil},
		{"global switched off on a level", Levels{Global: off()}, nil},
		{"no settings", Levels{}, nil},
	}
	for _, c := range cases {
		got := Resolve(c.l)
		if len(got) != len(c.want) {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
			continue
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: got %v, want %v", c.name, got, c.want)
			}
		}
	}
}

func TestSeveralRulesOnALevel(t *testing.T) {
	day := Rule{Kind: BeforeStart, OffsetMinutes: 1440}
	got := Resolve(Levels{Global: set(before10, day, before10)})
	if len(got) != 2 || got[0] != day && got[1] != day {
		t.Errorf("got %v", got)
	}
}

func TestTheRulesOfAllCategoriesAreJoinedWithoutRepeats(t *testing.T) {
	got := Resolve(Levels{
		Global:     set(afterEnd),
		Categories: []*Setting{set(before60, before10), set(before10, late15), off()},
	})
	want := []Rule{before10, before60, late15}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for _, w := range want {
		found := false
		for _, g := range got {
			found = found || g == w
		}
		if !found {
			t.Errorf("%v is missing from %v", w, got)
		}
	}
}

func TestACategorySwitchedOffGivesNothingAndDoesNotFallBackToTheGlobalLevel(t *testing.T) {
	if got := Resolve(Levels{Global: set(afterEnd), Categories: []*Setting{off()}}); len(got) != 0 {
		t.Errorf("got %v", got)
	}
}

func TestCategorySettingsInheritFromTheNearestAncestor(t *testing.T) {
	root, mid, leaf, other, lone := uuid.New(), uuid.New(), uuid.New(), uuid.New(), uuid.New()
	parents := map[uuid.UUID]uuid.UUID{mid: root, leaf: mid}
	rootSet, midSet := set(before60), set(late15)

	// The leaf has none of its own: the nearest ancestor with some is its parent.
	got := CategorySettings([]uuid.UUID{leaf}, parents, map[uuid.UUID]*Setting{root: rootSet, mid: midSet})
	if len(got) != 1 || got[0] != midSet {
		t.Errorf("leaf: got %v", got)
	}
	// Only the root has some.
	got = CategorySettings([]uuid.UUID{leaf}, parents, map[uuid.UUID]*Setting{root: rootSet})
	if len(got) != 1 || got[0] != rootSet {
		t.Errorf("leaf under the root: got %v", got)
	}
	// Two categories of a task that share an ancestor count it once.
	got = CategorySettings([]uuid.UUID{leaf, mid}, parents, map[uuid.UUID]*Setting{root: rootSet, mid: midSet})
	if len(got) != 1 {
		t.Errorf("shared ancestor: got %d settings", len(got))
	}
	// A category without settings anywhere above it is skipped; the others still count.
	got = CategorySettings([]uuid.UUID{lone, other}, parents, map[uuid.UUID]*Setting{other: rootSet})
	if len(got) != 1 || got[0] != rootSet {
		t.Errorf("category without settings: got %v", got)
	}
	// None has any: the level is skipped.
	if got := CategorySettings([]uuid.UUID{lone}, parents, map[uuid.UUID]*Setting{}); len(got) != 0 {
		t.Errorf("no settings: got %v", got)
	}
}

func TestACycleInTheCategoryTreeCannotHang(t *testing.T) {
	a, b := uuid.New(), uuid.New()
	got := CategorySettings([]uuid.UUID{a}, map[uuid.UUID]uuid.UUID{a: b, b: a}, map[uuid.UUID]*Setting{})
	if len(got) != 0 {
		t.Errorf("got %v", got)
	}
}

func TestWhenARuleFires(t *testing.T) {
	start, end := at(14, 10, 0), at(14, 11, 0)
	cases := []struct {
		r    Rule
		want time.Time
	}{
		{Rule{Kind: BeforeStart, OffsetMinutes: 10}, at(14, 9, 50)},
		{Rule{Kind: BeforeStart, OffsetMinutes: 1440}, at(13, 10, 0)},
		{Rule{Kind: AfterEnd, OffsetMinutes: 0}, at(14, 11, 0)},
		{Rule{Kind: AfterEnd, OffsetMinutes: 5}, at(14, 11, 5)},
		{Rule{Kind: NotStarted, OffsetMinutes: 15}, at(14, 10, 15)},
		{Rule{Kind: Overrun, OffsetMinutes: 30}, at(14, 11, 30)},
	}
	for _, c := range cases {
		if got := c.r.FireAt(start, end); !got.Equal(c.want) {
			t.Errorf("%v fires at %v, want %v", c.r, got, c.want)
		}
	}
}

func TestWhichMessagesAreStillNeeded(t *testing.T) {
	end := at(14, 11, 0)
	cases := []struct {
		kind   Kind
		status string
		now    time.Time
		want   bool
	}{
		{BeforeStart, "planned", at(14, 9, 50), true},
		{BeforeStart, "planned", at(14, 10, 30), true}, // started late, not marked: still planned
		{BeforeStart, "planned", at(14, 11, 0), false}, // it is over
		{BeforeStart, "in_progress", at(14, 9, 50), false},
		{BeforeStart, "done", at(14, 9, 50), false},
		{NotStarted, "planned", at(14, 10, 15), true},
		{NotStarted, "planned", at(14, 12, 0), false},
		{NotStarted, "in_progress", at(14, 10, 15), false},
		{AfterEnd, "planned", at(14, 11, 0), true},
		{AfterEnd, "planned", at(14, 18, 0), true},
		{AfterEnd, "done", at(14, 11, 0), false},
		{AfterEnd, "not_done", at(14, 11, 0), false},
		{AfterEnd, "in_progress", at(14, 11, 0), false},
		{Overrun, "in_progress", at(14, 11, 30), true},
		{Overrun, "done", at(14, 11, 30), false},
		{Overrun, "planned", at(14, 11, 30), false},
		{HabitTime, "planned", at(14, 11, 30), false},
	}
	for _, c := range cases {
		if got := Needed(c.kind, c.status, end, c.now); got != c.want {
			t.Errorf("%s while %s at %v: %v, want %v", c.kind, c.status, c.now, got, c.want)
		}
	}
}

func TestQuietHours(t *testing.T) {
	night := &Quiet{Start: 23 * 60, End: 8 * 60}
	cases := []struct {
		name string
		q    *Quiet
		in   time.Time
		want time.Time
	}{
		{"before the night", night, at(14, 22, 59), at(14, 22, 59)},
		{"at the start", night, at(14, 23, 0), at(15, 8, 0)},
		{"after midnight", night, at(15, 3, 30), at(15, 8, 0)},
		{"at the end", night, at(15, 8, 0), at(15, 8, 0)},
		{"day", night, at(15, 12, 0), at(15, 12, 0)},
		{"none", nil, at(15, 3, 30), at(15, 3, 30)},
		{"same day", &Quiet{Start: 13 * 60, End: 14 * 60}, at(15, 13, 30), at(15, 14, 0)},
		{"same day outside", &Quiet{Start: 13 * 60, End: 14 * 60}, at(15, 14, 0), at(15, 14, 0)},
		{"empty interval", &Quiet{Start: 600, End: 600}, at(15, 10, 0), at(15, 10, 0)},
	}
	for _, c := range cases {
		if got := c.q.Shift(c.in, msk); !got.Equal(c.want) {
			t.Errorf("%s: %v moved to %v, want %v", c.name, c.in, got, c.want)
		}
	}
}

func TestQuietHoursInAnotherTimeZoneAndAtAClockChange(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	night := &Quiet{Start: 23 * 60, End: 8 * 60}
	// 04:30 UTC on 5 Nov is 23:30 EST on the 4th in New York.
	got := night.Shift(time.Date(2026, 11, 5, 4, 30, 0, 0, time.UTC), ny)
	want := time.Date(2026, 11, 5, 8, 0, 0, 0, ny)
	if !got.Equal(want) {
		t.Errorf("got %v, want %v", got, want)
	}
	// The night of 1 November has 25 hours in New York: the end is still 08:00 local.
	got = night.Shift(time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC), ny) // 01:30 EDT (first)
	want = time.Date(2026, 11, 1, 8, 0, 0, 0, ny)
	if !got.Equal(want) {
		t.Errorf("clock change: got %v, want %v", got, want)
	}
}

func TestHabitFireAt(t *testing.T) {
	if got := HabitFireAt(2026, time.October, 14, 21*60+30, msk); !got.Equal(at(14, 21, 30)) {
		t.Errorf("got %v", got)
	}
}

func TestCallbackRoundTrip(t *testing.T) {
	id := uuid.New()
	for _, a := range []string{ActionDone, ActionNotDone, ActionStart, ActionStop, ActionHabit} {
		data := Callback(a, id)
		if len(data) > 64 {
			t.Errorf("%s: %d bytes, Telegram allows 64", data, len(data))
		}
		gotA, gotID, ok := ParseCallback(data)
		if !ok || gotA != a || gotID != id {
			t.Errorf("%s: parsed as %q %v %v", data, gotA, gotID, ok)
		}
	}
	for _, bad := range []string{"", "done", "done:", "done:not-a-uuid", "drop:" + id.String(), ":" + id.String()} {
		if _, _, ok := ParseCallback(bad); ok {
			t.Errorf("%q must not parse", bad)
		}
	}
}

func TestMessages(t *testing.T) {
	id := uuid.New()
	start, end := at(14, 10, 0), at(14, 11, 0)

	m := TaskMessage(BeforeStart, id, "Планёрка", start, end, at(14, 9, 50), msk)
	if m.Text != "⏰ «Планёрка» начнётся в 10:00 (через 10 мин)" {
		t.Errorf("before: %q", m.Text)
	}
	late := TaskMessage(BeforeStart, id, "Планёрка", start, end, at(14, 10, 5), msk)
	if !strings.Contains(late.Text, "должно было начаться в 10:00") {
		t.Errorf("before, late: %q", late.Text)
	}

	m = TaskMessage(AfterEnd, id, "Планёрка", start, end, end, msk)
	if m.Text != "«Планёрка» закончилось в 11:00. Как прошло?" {
		t.Errorf("after end: %q", m.Text)
	}
	if len(m.Buttons) != 2 || m.Buttons[0][0].Text != "Выполнено" || m.Buttons[0][1].Text != "Не выполнено" || !m.Buttons[1][0].OpenApp {
		t.Errorf("after end buttons: %+v", m.Buttons)
	}
	if a, _, _ := ParseCallback(m.Buttons[0][0].Callback); a != ActionDone {
		t.Errorf("done button: %q", m.Buttons[0][0].Callback)
	}

	m = TaskMessage(NotStarted, id, "Планёрка", start, end, at(14, 10, 15), msk)
	if m.Buttons[0][0].Text != "Старт" || !m.Buttons[0][1].OpenApp {
		t.Errorf("not started buttons: %+v", m.Buttons)
	}
	m = TaskMessage(Overrun, id, "Планёрка", start, end, at(14, 11, 20), msk)
	if m.Buttons[0][0].Text != "Стоп" || !strings.Contains(m.Text, "таймер идёт") {
		t.Errorf("overrun: %+v", m)
	}

	if got := minutesText(1440); got != "1 дн" {
		t.Errorf("minutesText(1440) = %q", got)
	}
	if got := minutesText(90); got != "1 ч 30 мин" {
		t.Errorf("minutesText(90) = %q", got)
	}

	h := HabitMessage(id, "Вода", false, "3 из 8 стаканов")
	if h.Text != "Привычка «Вода»: 3 из 8 стаканов" || len(h.Buttons[0]) != 1 || !h.Buttons[0][0].OpenApp {
		t.Errorf("quantity habit: %+v", h)
	}
	h = HabitMessage(id, "Читать", true, "")
	if h.Text != "Привычка «Читать»" || h.Buttons[0][0].Text != "Выполнено" {
		t.Errorf("yes/no habit: %+v", h)
	}
}
