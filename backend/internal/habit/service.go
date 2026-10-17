package habit

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	maxTitleLen    = 200
	maxUnitLen     = 30
	maxTarget      = 100000
	maxMark        = 1_000_000
	maxStatsDays   = 366
	maxPlacementMn = 24 * 60
)

const (
	// CodeWeeklyInGrid: a habit with a weekly goal has no day, so it cannot sit in the grid.
	CodeWeeklyInGrid = "habit_weekly_in_grid"
	// CodeArchived: an archived habit cannot be put in the grid.
	CodeArchived = "habit_archived"
)

// earliestMark is the oldest day a mark can be made for.
var earliestMark = DayOf(2000, time.January, 1)

var (
	ErrNotFound = errors.New("habit not found")

	colorRe = regexp.MustCompile(`^#[0-9a-f]{6}$`)
	timeRe  = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)
)

// Kind is how a habit is tracked.
type Kind string

const (
	// Boolean is done or not, per day.
	Boolean Kind = "boolean"
	// Quantity has a daily goal in a unit; the value adds up through the day.
	Quantity Kind = "quantity"
)

// Placement is where a habit sits in the day grid.
type Placement struct {
	// Time is the local time of day, "15:04".
	Time            string
	DurationMinutes int
}

type Habit struct {
	ID         uuid.UUID
	Title      string
	Kind       Kind
	Target     int
	Unit       string
	Schedule   Schedule
	Color      string
	ArchivedAt *time.Time
	CreatedAt  time.Time
	// Placement is nil when the habit is not in the grid.
	Placement *Placement
}

// Input describes a new habit.
type Input struct {
	Title     string
	Kind      Kind
	Target    int
	Unit      string
	Schedule  Schedule
	Color     string
	Placement *Placement
}

// Patch holds the fields to change; nil fields are left as is. The kind cannot be
// changed: the marks of a yes/no habit and of a quantity mean different things.
type Patch struct {
	Title    *string
	Target   *int
	Unit     *string
	Schedule *Schedule
	Color    *string
}

type Service struct {
	store *store.Store
	now   func() time.Time
}

func NewService(s *store.Store) *Service { return &Service{store: s, now: time.Now} }

// SetClock replaces the clock of the service; tests of services that use habits fix the time with it.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

func (s *Service) location(ctx context.Context, q *store.Queries, userID uuid.UUID) (*time.Location, error) {
	u, err := q.GetUser(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("get user: %w", err)
	}
	loc, err := time.LoadLocation(u.Timezone)
	if err != nil {
		return nil, fmt.Errorf("user %s has an unknown time zone %q: %w", userID, u.Timezone, err)
	}
	return loc, nil
}

// List returns the habits of the user, archived ones too.
func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]Habit, error) {
	rows, err := s.store.ListHabits(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list habits: %w", err)
	}
	placements, err := placementsOf(ctx, s.store.Queries, userID)
	if err != nil {
		return nil, err
	}
	out := make([]Habit, len(rows))
	for i, r := range rows {
		out[i] = fromRow(r, placements[r.ID])
	}
	return out, nil
}

func (s *Service) Get(ctx context.Context, userID, id uuid.UUID) (Habit, error) {
	return get(ctx, s.store.Queries, userID, id)
}

func get(ctx context.Context, q *store.Queries, userID, id uuid.UUID) (Habit, error) {
	row, err := q.GetHabit(ctx, store.GetHabitParams{ID: id, UserID: userID})
	if errors.Is(err, pgx.ErrNoRows) {
		return Habit{}, ErrNotFound
	}
	if err != nil {
		return Habit{}, fmt.Errorf("get habit: %w", err)
	}
	placements, err := placementsOf(ctx, q, userID)
	if err != nil {
		return Habit{}, err
	}
	return fromRow(row, placements[row.ID]), nil
}

func placementsOf(ctx context.Context, q *store.Queries, userID uuid.UUID) (map[uuid.UUID]*Placement, error) {
	rows, err := q.ListHabitPlacements(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list placements: %w", err)
	}
	out := make(map[uuid.UUID]*Placement, len(rows))
	for _, r := range rows {
		if r.HabitID.Valid {
			out[r.HabitID.UUID] = &Placement{Time: r.DtstartLocal.Format("15:04"), DurationMinutes: int(r.DurationMinutes)}
		}
	}
	return out, nil
}

func fromRow(r store.Habit, p *Placement) Habit {
	h := Habit{
		ID: r.ID, Title: r.Title, Kind: Kind(r.Kind), Target: int(r.TargetValue), Unit: r.Unit,
		Schedule: Schedule{Frequency: Frequency(r.Frequency)},
		Color:    r.Color, ArchivedAt: r.ArchivedAt, CreatedAt: r.CreatedAt, Placement: p,
	}
	for _, w := range r.Weekdays {
		h.Schedule.Weekdays = append(h.Schedule.Weekdays, int(w))
	}
	if r.TimesPerWeek != nil {
		h.Schedule.TimesPerWeek = int(*r.TimesPerWeek)
	}
	return h
}

func (s *Service) Create(ctx context.Context, userID uuid.UUID, in Input) (Habit, error) {
	f, err := normalize(in.Title, in.Kind, in.Target, in.Unit, in.Schedule, in.Color)
	if err != nil {
		return Habit{}, err
	}
	if in.Placement != nil {
		if _, _, err := checkPlacement(f.schedule, *in.Placement); err != nil {
			return Habit{}, err
		}
	}

	var out Habit
	err = s.store.InTx(ctx, func(q *store.Queries) error {
		row, err := q.CreateHabit(ctx, store.CreateHabitParams{
			UserID: userID, Title: f.title, Kind: string(f.kind), TargetValue: int32(f.target), Unit: f.unit,
			Frequency: string(f.schedule.Frequency), Weekdays: weekdaysOf(f.schedule), TimesPerWeek: timesOf(f.schedule),
			Color: f.color, CreatedAt: s.now(),
		})
		if err != nil {
			return fmt.Errorf("create habit: %w", err)
		}
		if in.Placement != nil {
			if err := s.place(ctx, q, userID, row.ID, f.title, f.schedule, *in.Placement); err != nil {
				return err
			}
		}
		out, err = get(ctx, q, userID, row.ID)
		return err
	})
	return out, err
}

// Update changes a habit. A new title or schedule reaches the series in the grid.
func (s *Service) Update(ctx context.Context, userID, id uuid.UUID, in Patch) (Habit, error) {
	var out Habit
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.LockHabit(ctx, store.LockHabitParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock habit: %w", err)
		}
		h := fromRow(cur, nil)

		title, target, unit, schedule, color := h.Title, h.Target, h.Unit, h.Schedule, h.Color
		if in.Title != nil {
			title = *in.Title
		}
		if in.Target != nil {
			target = *in.Target
		}
		if in.Unit != nil {
			unit = *in.Unit
		}
		if in.Schedule != nil {
			schedule = *in.Schedule
		}
		if in.Color != nil {
			color = *in.Color
		}
		f, err := normalize(title, h.Kind, target, unit, schedule, color)
		if err != nil {
			return err
		}

		placements, err := placementsOf(ctx, q, userID)
		if err != nil {
			return err
		}
		placed := placements[id] != nil
		if placed && f.schedule.Weekly() {
			return &validation.Error{Code: CodeWeeklyInGrid, Field: "frequency", Message: "a habit with a weekly goal cannot be in the grid: take it out of the grid first"}
		}

		row, err := q.UpdateHabit(ctx, store.UpdateHabitParams{
			ID: id, UserID: userID, Title: f.title, Kind: string(f.kind), TargetValue: int32(f.target), Unit: f.unit,
			Frequency: string(f.schedule.Frequency), Weekdays: weekdaysOf(f.schedule), TimesPerWeek: timesOf(f.schedule),
			Color: f.color,
		})
		if err != nil {
			return fmt.Errorf("update habit: %w", err)
		}
		// The series is rewritten (its planned occurrences are made again) only when something it
		// is made of changed: not for a new color or goal.
		if placed {
			var sp task.HabitSeriesPatch
			if f.title != h.Title {
				sp.Title = &f.title
			}
			if rule := ruleOf(f.schedule); rule != ruleOf(h.Schedule) {
				sp.Rule = &rule
			}
			if sp.Title != nil || sp.Rule != nil {
				if err := task.UpdateHabitSeries(ctx, q, userID, id, sp); err != nil {
					return err
				}
			}
		}
		out, err = get(ctx, q, userID, row.ID)
		return err
	})
	return out, err
}

// Archive hides a habit (archived = true) or brings it back. An archived habit
// leaves the grid; its marks and the occurrences that were marked stay.
func (s *Service) Archive(ctx context.Context, userID, id uuid.UUID, archived bool) (Habit, error) {
	var out Habit
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockHabit(ctx, store.LockHabitParams{ID: id, UserID: userID}); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("lock habit: %w", err)
		}
		if archived {
			if err := task.DeleteHabitSeries(ctx, q, userID, id); err != nil {
				return err
			}
		}
		if _, err := q.SetHabitArchived(ctx, store.SetHabitArchivedParams{ID: id, UserID: userID, Archived: archived}); err != nil {
			return fmt.Errorf("archive habit: %w", err)
		}
		var err error
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

// Delete removes a habit with its marks and takes it out of the grid.
func (s *Service) Delete(ctx context.Context, userID, id uuid.UUID) error {
	return s.store.InTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockHabit(ctx, store.LockHabitParams{ID: id, UserID: userID}); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("lock habit: %w", err)
		}
		if err := task.DeleteHabitSeries(ctx, q, userID, id); err != nil {
			return err
		}
		if _, err := q.DeleteHabit(ctx, store.DeleteHabitParams{ID: id, UserID: userID}); err != nil {
			return fmt.Errorf("delete habit: %w", err)
		}
		return nil
	})
}

// SetPlacement puts the habit in the grid, or changes its time and length there.
func (s *Service) SetPlacement(ctx context.Context, userID, id uuid.UUID, p Placement) (Habit, error) {
	var out Habit
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.LockHabit(ctx, store.LockHabitParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock habit: %w", err)
		}
		h := fromRow(cur, nil)
		if h.ArchivedAt != nil {
			return &validation.Error{Code: CodeArchived, Field: "time", Message: "an archived habit cannot be put in the grid"}
		}
		hour, minute, err := checkPlacement(h.Schedule, p)
		if err != nil {
			return err
		}
		placements, err := placementsOf(ctx, q, userID)
		if err != nil {
			return err
		}
		if placements[id] == nil {
			err = s.place(ctx, q, userID, id, h.Title, h.Schedule, p)
		} else {
			duration := p.DurationMinutes
			err = task.UpdateHabitSeries(ctx, q, userID, id, task.HabitSeriesPatch{Hour: &hour, Minute: &minute, DurationMinutes: &duration})
		}
		if err != nil {
			return err
		}
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

// ClearPlacement takes the habit out of the grid.
func (s *Service) ClearPlacement(ctx context.Context, userID, id uuid.UUID) (Habit, error) {
	var out Habit
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		if _, err := q.LockHabit(ctx, store.LockHabitParams{ID: id, UserID: userID}); errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		} else if err != nil {
			return fmt.Errorf("lock habit: %w", err)
		}
		if err := task.DeleteHabitSeries(ctx, q, userID, id); err != nil {
			return err
		}
		var err error
		out, err = get(ctx, q, userID, id)
		return err
	})
	return out, err
}

func (s *Service) place(ctx context.Context, q *store.Queries, userID, id uuid.UUID, title string, schedule Schedule, p Placement) error {
	hour, minute, err := checkPlacement(schedule, p)
	if err != nil {
		return err
	}
	loc, err := s.location(ctx, q, userID)
	if err != nil {
		return err
	}
	return task.CreateHabitSeries(ctx, q, userID, task.HabitSeries{
		HabitID: id, Title: title, Rule: ruleOf(schedule),
		From: LocalDay(s.now(), loc), Hour: hour, Minute: minute, DurationMinutes: p.DurationMinutes,
	})
}

// checkPlacement validates a place in the grid for a schedule.
func checkPlacement(schedule Schedule, p Placement) (hour, minute int, err error) {
	if schedule.Weekly() {
		return 0, 0, &validation.Error{Code: CodeWeeklyInGrid, Field: "time", Message: "a habit with a weekly goal cannot be put in the grid"}
	}
	if !timeRe.MatchString(p.Time) {
		return 0, 0, &validation.Error{Field: "time", Message: "must be a time like 07:30"}
	}
	if p.DurationMinutes < 1 || p.DurationMinutes > maxPlacementMn {
		return 0, 0, &validation.Error{Field: "duration_minutes", Message: fmt.Sprintf("must be between 1 and %d", maxPlacementMn)}
	}
	t, _ := time.Parse("15:04", p.Time)
	return t.Hour(), t.Minute(), nil
}

var weekdayCodes = [...]string{"MO", "TU", "WE", "TH", "FR", "SA", "SU"}

// ruleOf is the repeat rule of the habit's series.
func ruleOf(s Schedule) string {
	if s.Frequency != Weekdays {
		return "FREQ=DAILY"
	}
	days := slices.Clone(s.Weekdays)
	slices.Sort(days)
	codes := make([]string, len(days))
	for i, d := range days {
		codes[i] = weekdayCodes[d-1]
	}
	return "FREQ=WEEKLY;BYDAY=" + strings.Join(codes, ",")
}

type fields struct {
	title    string
	kind     Kind
	target   int
	unit     string
	schedule Schedule
	color    string
}

// normalize checks the fields of a habit and cleans them up.
func normalize(title string, kind Kind, target int, unit string, schedule Schedule, color string) (fields, error) {
	title = strings.TrimSpace(title)
	if title == "" || utf8.RuneCountInString(title) > maxTitleLen || !validation.ValidText(title) {
		return fields{}, &validation.Error{Field: "title", Message: fmt.Sprintf("must be 1 to %d characters", maxTitleLen)}
	}
	color = strings.ToLower(strings.TrimSpace(color))
	if !colorRe.MatchString(color) {
		return fields{}, &validation.Error{Field: "color", Message: "must be a hex color like #1a2b3c"}
	}
	unit = strings.TrimSpace(unit)
	switch kind {
	case Boolean:
		target, unit = 1, ""
	case Quantity:
		if target < 1 || target > maxTarget {
			return fields{}, &validation.Error{Field: "target_value", Message: fmt.Sprintf("must be between 1 and %d", maxTarget)}
		}
		if utf8.RuneCountInString(unit) > maxUnitLen || !validation.ValidText(unit) {
			return fields{}, &validation.Error{Field: "unit", Message: fmt.Sprintf("must be at most %d characters", maxUnitLen)}
		}
	default:
		return fields{}, &validation.Error{Field: "kind", Message: "must be boolean or quantity"}
	}
	if !schedule.Valid() {
		return fields{}, &validation.Error{Field: "frequency", Message: "the schedule is not complete"}
	}
	switch schedule.Frequency {
	case Daily:
		schedule = Schedule{Frequency: Daily}
	case Weekdays:
		days := slices.Clone(schedule.Weekdays)
		slices.Sort(days)
		schedule = Schedule{Frequency: Weekdays, Weekdays: days}
	case TimesPerWeek:
		schedule = Schedule{Frequency: TimesPerWeek, TimesPerWeek: schedule.TimesPerWeek}
	}
	return fields{title: title, kind: kind, target: target, unit: unit, schedule: schedule, color: color}, nil
}

func weekdaysOf(s Schedule) []int16 {
	out := make([]int16, len(s.Weekdays))
	for i, w := range s.Weekdays {
		out[i] = int16(w)
	}
	return out
}

func timesOf(s Schedule) *int16 {
	if !s.Weekly() {
		return nil
	}
	n := int16(s.TimesPerWeek)
	return &n
}

// SetMark sets the value of a habit on a local date; zero removes the mark.
func (s *Service) SetMark(ctx context.Context, userID, id uuid.UUID, date Day, value int) error {
	if value < 0 || value > maxMark {
		return &validation.Error{Field: "value", Message: fmt.Sprintf("must be between 0 and %d", maxMark)}
	}
	return s.store.InTx(ctx, func(q *store.Queries) error {
		cur, err := q.LockHabit(ctx, store.LockHabitParams{ID: id, UserID: userID})
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock habit: %w", err)
		}
		if cur.Kind == string(Boolean) && value > 1 {
			return &validation.Error{Field: "value", Message: "a yes/no habit is 0 or 1"}
		}
		loc, err := s.location(ctx, q, userID)
		if err != nil {
			return err
		}
		if date.After(LocalDay(s.now(), loc)) {
			return &validation.Error{Field: "date", Message: "a mark cannot be made for a day that has not come"}
		}
		if date.Before(earliestMark) {
			return &validation.Error{Field: "date", Message: "a mark cannot be made for a day before 2000"}
		}
		if value == 0 {
			err = q.DeleteHabitLog(ctx, store.DeleteHabitLogParams{HabitID: id, UserID: userID, Date: date})
		} else {
			err = q.SetHabitLog(ctx, store.SetHabitLogParams{HabitID: id, UserID: userID, Date: date, Value: int32(value)})
		}
		if err != nil {
			return fmt.Errorf("set mark: %w", err)
		}
		return nil
	})
}

// TodayItem is a habit in the list of today.
type TodayItem struct {
	Habit Habit
	Date  Day
	Value int
	Done  bool
	// WeekDone is the number of done days this week; for a weekly goal.
	WeekDone int
	Streaks  Streaks
}

// Today lists the habits for today: planned for this weekday, and those with a weekly goal.
func (s *Service) Today(ctx context.Context, userID uuid.UUID) ([]TodayItem, Day, error) {
	loc, err := s.location(ctx, s.store.Queries, userID)
	if err != nil {
		return nil, Day{}, err
	}
	today := LocalDay(s.now(), loc)
	habits, err := s.List(ctx, userID)
	if err != nil {
		return nil, Day{}, err
	}
	logs, err := s.allMarks(ctx, userID)
	if err != nil {
		return nil, Day{}, err
	}
	var out []TodayItem
	for _, h := range habits {
		if h.ArchivedAt != nil {
			continue
		}
		r := h.rules(loc)
		if !r.PlannedOn(today) {
			continue
		}
		marks := logs[h.ID]
		out = append(out, TodayItem{
			Habit: h, Date: today, Value: marks[today], Done: r.Done(marks[today]),
			WeekDone: r.DoneInWeek(marks, today), Streaks: r.Streaks(marks, today),
		})
	}
	return out, today, nil
}

func (h Habit) rules(loc *time.Location) Rules {
	return Rules{Schedule: h.Schedule, Target: h.Target, Start: LocalDay(h.CreatedAt, loc)}
}

func (s *Service) allMarks(ctx context.Context, userID uuid.UUID) (map[uuid.UUID]Marks, error) {
	rows, err := s.store.ListHabitLogs(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list habit logs: %w", err)
	}
	out := map[uuid.UUID]Marks{}
	for _, r := range rows {
		if out[r.HabitID] == nil {
			out[r.HabitID] = Marks{}
		}
		out[r.HabitID][dayUTC(r.Date)] = int(r.Value)
	}
	return out, nil
}

// dayUTC normalises a date from the database to midnight UTC.
func dayUTC(d time.Time) Day { return DayOf(d.Year(), d.Month(), d.Day()) }

// Stats of one habit.
type Stats struct {
	Habit   Habit
	Streaks Streaks
	// Percent over the whole history and over the last 30 and 90 days; nil while nothing is over yet.
	PercentAll, Percent30, Percent90 *int
	// Cells of the days from..to (the heat map).
	Cells []Cell
	Today Day
}

// Stats works out the streaks, the percentages and the heat map of a habit for [from, to].
func (s *Service) Stats(ctx context.Context, userID, id uuid.UUID, from, to Day) (Stats, error) {
	if to.Before(from) {
		return Stats{}, &validation.Error{Field: "to", Message: "must not be before from"}
	}
	if to.Sub(from) > (maxStatsDays-1)*24*time.Hour {
		return Stats{}, &validation.Error{Field: "to", Message: fmt.Sprintf("the period is too long (at most %d days)", maxStatsDays)}
	}
	h, err := s.Get(ctx, userID, id)
	if err != nil {
		return Stats{}, err
	}
	loc, err := s.location(ctx, s.store.Queries, userID)
	if err != nil {
		return Stats{}, err
	}
	rows, err := s.store.ListHabitLogsOf(ctx, store.ListHabitLogsOfParams{HabitID: id, UserID: userID})
	if err != nil {
		return Stats{}, fmt.Errorf("list habit logs: %w", err)
	}
	marks := Marks{}
	for _, r := range rows {
		marks[dayUTC(r.Date)] = int(r.Value)
	}

	today := LocalDay(s.now(), loc)
	r := h.rules(loc)
	st := Stats{Habit: h, Streaks: r.Streaks(marks, today), Cells: r.Cells(marks, from, to), Today: today}
	percent := func(from Day) *int {
		if v, ok := r.Percent(marks, today, from, today).Value(); ok {
			return &v
		}
		return nil
	}
	st.PercentAll = percent(DayOf(1, time.January, 1))
	st.Percent30 = percent(today.AddDate(0, 0, -29))
	st.Percent90 = percent(today.AddDate(0, 0, -89))
	return st, nil
}

// MarkToday makes today a done day of a yes/no habit (a button in a bot message). For a
// quantity it sets the goal.
func (s *Service) MarkToday(ctx context.Context, userID, id uuid.UUID) error {
	h, err := s.Get(ctx, userID, id)
	if err != nil {
		return err
	}
	loc, err := s.location(ctx, s.store.Queries, userID)
	if err != nil {
		return err
	}
	return s.SetMark(ctx, userID, id, LocalDay(s.now(), loc), h.Target)
}
