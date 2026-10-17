package reminder_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/reminder"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

var msk, _ = time.LoadLocation("Europe/Moscow")

func at(day, h, m int) time.Time { return time.Date(2026, 10, day, h, m, 0, 0, msk) }

type sent struct {
	chat int64
	msg  reminder.Message
}

type fakeSender struct {
	sent []sent
	err  error
}

func (f *fakeSender) Send(_ context.Context, chat int64, m reminder.Message) (int64, error) {
	if f.err != nil {
		return 0, f.err
	}
	f.sent = append(f.sent, sent{chat, m})
	return int64(len(f.sent)), nil
}

type env struct {
	t      *testing.T
	st     *store.Store
	pool   *pgxpool.Pool
	svc    *reminder.Service
	tasks  *task.Service
	habits *habit.Service
	cats   *category.Service
	sender *fakeSender
	user   uuid.UUID
	other  uuid.UUID
	clock  time.Time
}

const chatA, chatB = 1001, 2002

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := testutil.NewDB(t, migrations.FS)
	st := store.NewStore(pool)
	mk := func(name string, tg string) uuid.UUID {
		u, err := st.CreateUser(context.Background(), store.CreateUserParams{DisplayName: name, Timezone: "Europe/Moscow"})
		if err != nil {
			t.Fatal(err)
		}
		if tg != "" {
			err = st.CreateIdentity(context.Background(), store.CreateIdentityParams{UserID: u.ID, Provider: "telegram", ProviderUserID: tg})
			if err != nil {
				t.Fatal(err)
			}
		}
		return u.ID
	}
	e := &env{t: t, st: st, pool: pool, sender: &fakeSender{}, clock: at(14, 9, 45)}
	e.tasks, e.habits, e.cats = task.NewService(st), habit.NewService(st), category.NewService(st)
	e.svc = reminder.NewService(st, e.tasks, e.habits, e.sender, nil)
	e.user, e.other = mk("a", "1001"), mk("b", "2002")
	e.setNow(e.clock)
	return e
}

func (e *env) setNow(t time.Time) {
	e.clock = t
	fn := func() time.Time { return e.clock }
	e.svc.SetClock(fn)
	e.tasks.SetClock(fn)
	e.habits.SetClock(fn)
}

func (e *env) task(user uuid.UUID, title string, start, end time.Time, cats ...uuid.UUID) task.Instance {
	e.t.Helper()
	in, err := e.tasks.Create(context.Background(), user, task.CreateInput{Title: title, PlannedStart: start, PlannedEnd: end, CategoryIDs: cats})
	if err != nil {
		e.t.Fatal(err)
	}
	return in
}

func (e *env) category(name string, parent *uuid.UUID) uuid.UUID {
	e.t.Helper()
	c, err := e.cats.Create(context.Background(), e.user, category.CreateInput{Name: name, Color: "#aabbcc", ParentID: parent})
	if err != nil {
		e.t.Fatal(err)
	}
	return c.ID
}

func (e *env) plan() {
	e.t.Helper()
	if err := e.svc.PlanAll(context.Background()); err != nil {
		e.t.Fatal(err)
	}
}

func (e *env) send() []sent {
	e.t.Helper()
	before := len(e.sender.sent)
	if err := e.svc.SendDue(context.Background()); err != nil {
		e.t.Fatal(err)
	}
	return e.sender.sent[before:]
}

func (e *env) rows(user uuid.UUID) []store.Notification {
	e.t.Helper()
	rows, err := e.pool.Query(context.Background(), `SELECT id FROM notifications WHERE user_id = $1`, user)
	if err != nil {
		e.t.Fatal(err)
	}
	defer rows.Close()
	var out []store.Notification
	for rows.Next() {
		var n store.Notification
		if err := rows.Scan(&n.ID); err != nil {
			e.t.Fatal(err)
		}
		out = append(out, n)
	}
	return out
}

func set(rules ...reminder.Rule) reminder.Setting {
	return reminder.Setting{Enabled: true, Rules: rules}
}

var (
	before10 = reminder.Rule{Kind: reminder.BeforeStart, OffsetMinutes: 10}
	before60 = reminder.Rule{Kind: reminder.BeforeStart, OffsetMinutes: 60}
	afterEnd = reminder.Rule{Kind: reminder.AfterEnd}
	late5    = reminder.Rule{Kind: reminder.NotStarted, OffsetMinutes: 5}
	over5    = reminder.Rule{Kind: reminder.Overrun, OffsetMinutes: 5}
)

func isValidation(err error, field string) bool {
	var v *validation.Error
	return errors.As(err, &v) && v.Field == field
}

func TestANewUserHasTheDefaultReminders(t *testing.T) {
	e := newEnv(t)
	g, err := e.svc.GetGlobal(context.Background(), e.user)
	if err != nil {
		t.Fatal(err)
	}
	if !g.Enabled || g.Quiet != nil || len(g.Rules) != 2 {
		t.Fatalf("global = %+v", g)
	}
	want := map[reminder.Rule]bool{before10: true, afterEnd: true}
	for _, r := range g.Rules {
		if !want[r] {
			t.Errorf("unexpected default rule %+v", r)
		}
	}
}

func TestAReminderBeforeTheStartIsQueuedOnceAndSentWhenItsTimeComes(t *testing.T) {
	e := newEnv(t)
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))

	e.plan()
	e.plan() // asking again queues nothing new
	if n := len(e.rows(e.user)); n != 1 {
		t.Fatalf("queued = %d, want 1", n)
	}
	if got := e.send(); len(got) != 0 {
		t.Fatalf("sent before its time: %v", got)
	}

	e.setNow(at(14, 9, 51))
	got := e.send()
	if len(got) != 1 || got[0].chat != chatA {
		t.Fatalf("sent = %+v", got)
	}
	if !strings.Contains(got[0].msg.Text, "«Планёрка» начнётся в 10:00 (через 9 мин)") {
		t.Errorf("text = %q", got[0].msg.Text)
	}
	if got := e.send(); len(got) != 0 {
		t.Errorf("sent again: %v", got)
	}
	// Nothing goes to the other user.
	for _, s := range e.sender.sent {
		if s.chat == chatB {
			t.Errorf("a message of A went to B")
		}
	}
}

func TestARemindersOfAnotherUserGoToThatUser(t *testing.T) {
	e := newEnv(t)
	e.task(e.other, "Чужое", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	e.setNow(at(14, 9, 51))
	got := e.send()
	if len(got) != 1 || got[0].chat != chatB {
		t.Fatalf("sent = %+v", got)
	}
}

func TestAMessageIsDroppedWhenTheTaskWasMarkedBeforeItWasSent(t *testing.T) {
	e := newEnv(t)
	in := e.task(e.user, "Планёрка", at(14, 9, 0), at(14, 9, 30))
	e.setNow(at(14, 9, 31))
	e.plan() // the "after the end" request is queued
	if n := len(e.rows(e.user)); n != 1 {
		t.Fatalf("queued = %d", n)
	}
	if _, err := e.tasks.Complete(context.Background(), e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if got := e.send(); len(got) != 0 {
		t.Errorf("sent for a task that was marked: %v", got)
	}
}

func TestAfterTheEndTheMessageHasTheButtons(t *testing.T) {
	e := newEnv(t)
	e.task(e.user, "Планёрка", at(14, 9, 0), at(14, 9, 30))
	e.setNow(at(14, 9, 31))
	e.plan()
	got := e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "закончилось в 09:30") {
		t.Fatalf("sent = %+v", got)
	}
	if b := got[0].msg.Buttons; len(b) != 2 || b[0][0].Text != "Выполнено" || b[0][1].Text != "Не выполнено" {
		t.Errorf("buttons = %+v", b)
	}
}

func TestOnlyRemindersWithinThirtyMinutesOfTheirTimeAreSent(t *testing.T) {
	e := newEnv(t)
	e.task(e.user, "Давно", at(14, 8, 0), at(14, 8, 30))   // its "after the end" was 75 minutes ago
	e.task(e.user, "Недавно", at(14, 9, 0), at(14, 9, 30)) // 15 minutes ago
	e.plan()
	e.setNow(at(14, 9, 46))
	got := e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "Недавно") {
		t.Errorf("sent = %+v", got)
	}
}

func TestTheMostSpecialLevelDecidesWhatIsQueued(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	work := e.category("Работа", nil)
	sub := e.category("Проект", &work)
	// The category (and so its subcategory) wants a reminder 60 minutes before.
	if err := e.svc.Put(ctx, e.user, reminder.ScopeCategory, work, set(before60)); err != nil {
		t.Fatal(err)
	}
	e.task(e.user, "Делаю", at(14, 10, 40), at(14, 11, 0), sub) // fire at 9:40: in the past window, within 30 min
	e.task(e.user, "Без категории", at(14, 9, 55), at(14, 10, 30))
	e.plan()
	e.setNow(at(14, 9, 50))
	got := e.send()
	// "Делаю" has the category rule (9:40); "Без категории" has the global rule (9:45).
	if len(got) != 2 {
		t.Fatalf("sent = %+v", got)
	}
	var texts []string
	for _, s := range got {
		texts = append(texts, s.msg.Text)
	}
	joined := strings.Join(texts, "|")
	if !strings.Contains(joined, "Делаю") || !strings.Contains(joined, "Без категории") {
		t.Errorf("texts = %v", texts)
	}
}

func TestAnInstanceThatIsSwitchedOffGetsNothing(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	in := e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	if err := e.svc.Put(ctx, e.user, reminder.ScopeInstance, in.ID, reminder.Setting{Enabled: false}); err != nil {
		t.Fatal(err)
	}
	e.plan()
	e.setNow(at(14, 9, 51))
	if got := e.send(); len(got) != 0 {
		t.Errorf("sent = %+v", got)
	}
	// Back to inheriting: the global rule applies again.
	if err := e.svc.Delete(ctx, e.user, reminder.ScopeInstance, in.ID); err != nil {
		t.Fatal(err)
	}
	e.setNow(at(14, 9, 46))
	e.plan()
	e.setNow(at(14, 9, 51))
	if got := e.send(); len(got) != 1 {
		t.Errorf("after deleting the override: %+v", got)
	}
}

func TestTheMasterSwitchStopsEverything(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: false, Rules: []reminder.Rule{before10}}); err != nil {
		t.Fatal(err)
	}
	e.plan()
	if n := len(e.rows(e.user)); n != 0 {
		t.Errorf("queued = %d with the switch off", n)
	}
}

func TestChangingTheSettingsRemovesWhatWasQueued(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	if n := len(e.rows(e.user)); n != 1 {
		t.Fatalf("queued = %d", n)
	}
	// 5 minutes before instead of 10: the old message must go and the new one come.
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: true, Rules: []reminder.Rule{{Kind: reminder.BeforeStart, OffsetMinutes: 5}}}); err != nil {
		t.Fatal(err)
	}
	if n := len(e.rows(e.user)); n != 0 {
		t.Fatalf("queued after the change = %d, want 0", n)
	}
	e.setNow(at(14, 9, 52))
	e.plan()
	e.setNow(at(14, 9, 56))
	got := e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "(через 4 мин)") {
		t.Errorf("sent = %+v", got)
	}
}

func TestQuietHoursPostponeAMessageToTheirEnd(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{
		Enabled: true, Quiet: &reminder.Quiet{Start: 23 * 60, End: 8 * 60},
		Rules: []reminder.Rule{before10, afterEnd},
	}); err != nil {
		t.Fatal(err)
	}
	e.task(e.user, "Поздно", at(14, 23, 30), at(14, 23, 50))
	e.setNow(at(14, 23, 20))
	e.plan() // "10 minutes before" is due now, inside the quiet hours
	if got := e.send(); len(got) != 0 {
		t.Fatalf("sent in the quiet hours: %+v", got)
	}
	e.setNow(at(14, 23, 51))
	e.plan() // "after the end"
	if got := e.send(); len(got) != 0 {
		t.Fatalf("sent in the quiet hours: %+v", got)
	}

	e.setNow(at(15, 8, 0))
	got := e.send()
	// The one before the start is not wanted any more, the task is long over; the other still is.
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "закончилось в 23:50") {
		t.Errorf("sent at the end of the quiet hours = %+v", got)
	}
}

func TestAFailedSendIsTriedAgainAndAbandonedAfterFiveTries(t *testing.T) {
	e := newEnv(t)
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	e.sender.err = errors.New("network down")

	e.setNow(at(14, 9, 51))
	e.send() // try 1
	if got := e.send(); len(got) != 0 {
		t.Fatal("sent")
	}
	// Not due again until 30 seconds later.
	e.setNow(at(14, 9, 51).Add(20 * time.Second))
	e.send()
	delays := []time.Duration{30 * time.Second, 2 * time.Minute, 10 * time.Minute, 30 * time.Minute}
	for _, d := range delays {
		e.setNow(e.clock.Add(d + time.Second))
		e.send()
	}
	// Five tries are over: nothing more happens even when the network is back.
	e.sender.err = nil
	e.setNow(e.clock.Add(24 * time.Hour))
	// The message would be skipped anyway as the task is over, so check the row directly.
	var attempts int
	var gaveUp bool
	if err := e.pool.QueryRow(context.Background(),
		`SELECT attempts, gave_up_at IS NOT NULL FROM notifications WHERE user_id = $1`, e.user).Scan(&attempts, &gaveUp); err != nil {
		t.Fatal(err)
	}
	if attempts != 5 || !gaveUp {
		t.Errorf("attempts = %d, gave up = %v, want 5 and true", attempts, gaveUp)
	}
}

func TestAMessageThatTelegramWillNeverDeliverIsNotRepeated(t *testing.T) {
	e := newEnv(t)
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	e.sender.err = reminder.ErrUndeliverable
	e.setNow(at(14, 9, 51))
	e.send()
	var attempts int
	var gaveUp bool
	if err := e.pool.QueryRow(context.Background(),
		`SELECT attempts, gave_up_at IS NOT NULL FROM notifications WHERE user_id = $1`, e.user).Scan(&attempts, &gaveUp); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !gaveUp {
		t.Errorf("attempts = %d, gave up = %v", attempts, gaveUp)
	}
}

func TestAUserWithoutATelegramAccountGetsNothing(t *testing.T) {
	e := newEnv(t)
	u, err := e.st.CreateUser(context.Background(), store.CreateUserParams{DisplayName: "dev", Timezone: "Europe/Moscow"})
	if err != nil {
		t.Fatal(err)
	}
	e.task(u.ID, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	e.setNow(at(14, 9, 51))
	if got := e.send(); len(got) != 0 {
		t.Errorf("sent = %+v", got)
	}
}

func TestOccurrencesOfASeriesAreRemindedAboutAheadOfTime(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	rule := "FREQ=DAILY"
	if _, err := e.tasks.Create(ctx, e.user, task.CreateInput{
		Title: "Зарядка", PlannedStart: at(10, 9, 55), PlannedEnd: at(10, 10, 15), Recurrence: &rule,
	}); err != nil {
		t.Fatal(err)
	}
	// "A day before" for every occurrence: tomorrow's 9:55 fires today at 9:55.
	if err := e.svc.Put(ctx, e.user, reminder.ScopeCategory, e.category("Любая", nil), set()); err != nil {
		t.Fatal(err)
	}
	instance := e.tasks
	_ = instance
	list, err := e.tasks.List(ctx, e.user, at(10, 0, 0), at(11, 0, 0))
	if err != nil || len(list) != 1 || list[0].SeriesID == nil {
		t.Fatalf("setup: %v %v", list, err)
	}
	if err := e.svc.Put(ctx, e.user, reminder.ScopeSeries, *list[0].SeriesID, set(reminder.Rule{Kind: reminder.BeforeStart, OffsetMinutes: 1440})); err != nil {
		t.Fatal(err)
	}
	e.setNow(at(14, 9, 52)) // the occurrence of the 15th has not been created yet
	e.plan()
	e.setNow(at(14, 9, 56))
	got := e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "Зарядка") || !strings.Contains(got[0].msg.Text, "09:55 (через 23 ч 59 мин)") {
		t.Errorf("sent = %+v", got)
	}
}

func TestNotStartedAndOverrunReminders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: true, Rules: []reminder.Rule{late5, over5}}); err != nil {
		t.Fatal(err)
	}
	a := e.task(e.user, "Не начал", at(14, 9, 0), at(14, 10, 0))
	b := e.task(e.user, "Идёт долго", at(14, 8, 0), at(14, 9, 30))
	e.setNow(at(14, 8, 10))
	if _, err := e.tasks.Start(ctx, e.user, b.ID); err != nil {
		t.Fatal(err)
	}
	_ = a
	e.setNow(at(14, 9, 6)) // "not started" of a is due (9:05); "overrun" of b is 9:35, not yet
	e.plan()
	got := e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "Не начал") || got[0].msg.Buttons[0][0].Text != "Старт" {
		t.Fatalf("not started: %+v", got)
	}
	e.setNow(at(14, 9, 36))
	e.plan()
	got = e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "Идёт долго") || got[0].msg.Buttons[0][0].Text != "Стоп" {
		t.Fatalf("overrun: %+v", got)
	}
}

func TestHabitReminders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	water, err := e.habits.Create(ctx, e.user, habit.Input{
		Title: "Вода", Kind: habit.Quantity, Target: 8, Unit: "стаканов", Color: "#06b6d4",
		Schedule: habit.Schedule{Frequency: habit.Daily},
	})
	if err != nil {
		t.Fatal(err)
	}
	tue, _ := e.habits.Create(ctx, e.user, habit.Input{
		Title: "Во вторник", Kind: habit.Boolean, Color: "#06b6d4",
		Schedule: habit.Schedule{Frequency: habit.Weekdays, Weekdays: []int{2}}, // the 14th is a Wednesday
	})
	grid, _ := e.habits.Create(ctx, e.user, habit.Input{
		Title: "В сетке", Kind: habit.Boolean, Color: "#06b6d4", Schedule: habit.Schedule{Frequency: habit.Daily},
		Placement: &habit.Placement{Time: "21:00", DurationMinutes: 10},
	})
	nine := reminder.Rule{Kind: reminder.HabitTime, TimeOfDay: 21 * 60}
	for _, h := range []habit.Habit{water, tue, grid} {
		if err := e.svc.Put(ctx, e.user, reminder.ScopeHabit, h.ID, set(nine)); err != nil {
			t.Fatal(err)
		}
	}
	if err := e.habits.SetMark(ctx, e.user, water.ID, habit.DayOf(2026, 10, 14), 3); err != nil {
		t.Fatal(err)
	}

	e.setNow(at(14, 20, 58))
	e.plan()
	e.setNow(at(14, 21, 1))
	got := e.send()
	// The habit in the grid reminds through its occurrence, like an ordinary task, and not at the
	// time of the habit rule; the habit of Tuesday is not planned for a Wednesday.
	var habitTexts, taskTexts []string
	for _, s := range got {
		if strings.HasPrefix(s.msg.Text, "Привычка") {
			habitTexts = append(habitTexts, s.msg.Text)
		} else {
			taskTexts = append(taskTexts, s.msg.Text)
		}
	}
	if len(habitTexts) != 1 || habitTexts[0] != "Привычка «Вода»: 3 из 8 стаканов" {
		t.Fatalf("habit reminders = %v", habitTexts)
	}
	if len(taskTexts) != 1 || !strings.Contains(taskTexts[0], "«В сетке»") {
		t.Errorf("task reminders = %v", taskTexts)
	}
}

func TestAHabitThatIsDoneIsNotRemindedAbout(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h, _ := e.habits.Create(ctx, e.user, habit.Input{
		Title: "Читать", Kind: habit.Boolean, Color: "#06b6d4", Schedule: habit.Schedule{Frequency: habit.Daily},
	})
	if err := e.svc.Put(ctx, e.user, reminder.ScopeHabit, h.ID, set(reminder.Rule{Kind: reminder.HabitTime, TimeOfDay: 21 * 60})); err != nil {
		t.Fatal(err)
	}
	e.setNow(at(14, 20, 58))
	e.plan()
	// Done in the meantime, before the message goes.
	if err := e.habits.SetMark(ctx, e.user, h.ID, habit.DayOf(2026, 10, 14), 1); err != nil {
		t.Fatal(err)
	}
	e.setNow(at(14, 21, 1))
	if got := e.send(); len(got) != 0 {
		t.Errorf("sent for a habit that is done: %+v", got)
	}
}

func TestAWeeklyGoalReachedStopsTheReminders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h, _ := e.habits.Create(ctx, e.user, habit.Input{
		Title: "Зал", Kind: habit.Boolean, Color: "#06b6d4", Schedule: habit.Schedule{Frequency: habit.TimesPerWeek, TimesPerWeek: 2},
	})
	if err := e.svc.Put(ctx, e.user, reminder.ScopeHabit, h.ID, set(reminder.Rule{Kind: reminder.HabitTime, TimeOfDay: 21 * 60})); err != nil {
		t.Fatal(err)
	}
	// Monday and Tuesday were done: the goal of the week is reached.
	for _, d := range []int{12, 13} {
		if err := e.habits.SetMark(ctx, e.user, h.ID, habit.DayOf(2026, 10, d), 1); err != nil {
			t.Fatal(err)
		}
	}
	e.setNow(at(14, 20, 58))
	e.plan()
	e.setNow(at(14, 21, 1))
	if got := e.send(); len(got) != 0 {
		t.Errorf("sent although the weekly goal is reached: %+v", got)
	}
}

func TestSettingsValidation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	cat := e.category("Работа", nil)
	habitID := uuid.New()
	_ = habitID

	cases := []struct {
		name  string
		scope reminder.Scope
		rules []reminder.Rule
	}{
		{"habit rule on a category", reminder.ScopeCategory, []reminder.Rule{{Kind: reminder.HabitTime, TimeOfDay: 60}}},
		{"unknown kind", reminder.ScopeCategory, []reminder.Rule{{Kind: "weekly"}}},
		{"negative offset", reminder.ScopeCategory, []reminder.Rule{{Kind: reminder.BeforeStart, OffsetMinutes: -1}}},
		{"offset over a week", reminder.ScopeCategory, []reminder.Rule{{Kind: reminder.AfterEnd, OffsetMinutes: 10081}}},
	}
	for _, c := range cases {
		err := e.svc.Put(ctx, e.user, c.scope, cat, reminder.Setting{Enabled: true, Rules: c.rules})
		if !isValidation(err, "rules") {
			t.Errorf("%s: err = %v", c.name, err)
		}
	}
	many := make([]reminder.Rule, 21)
	for i := range many {
		many[i] = reminder.Rule{Kind: reminder.BeforeStart, OffsetMinutes: i}
	}
	if err := e.svc.Put(ctx, e.user, reminder.ScopeCategory, cat, reminder.Setting{Enabled: true, Rules: many}); !isValidation(err, "rules") {
		t.Errorf("21 rules: %v", err)
	}
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: true, Quiet: &reminder.Quiet{Start: 60, End: 60}}); !isValidation(err, "quiet_hours") {
		t.Errorf("empty quiet hours: %v", err)
	}
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: true, Quiet: &reminder.Quiet{Start: 1500, End: 60}}); !isValidation(err, "quiet_hours") {
		t.Errorf("quiet hours out of the day: %v", err)
	}
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: true, Rules: []reminder.Rule{{Kind: reminder.HabitTime}}}); !isValidation(err, "rules") {
		t.Errorf("habit rule in the global settings: %v", err)
	}
	// A habit takes only times of day.
	h, _ := e.habits.Create(ctx, e.user, habit.Input{Title: "a", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily}})
	if err := e.svc.Put(ctx, e.user, reminder.ScopeHabit, h.ID, set(before10)); !isValidation(err, "rules") {
		t.Errorf("task rule on a habit: %v", err)
	}
	// The same rule twice is kept once.
	if err := e.svc.Put(ctx, e.user, reminder.ScopeCategory, cat, set(before10, before10, afterEnd)); err != nil {
		t.Fatal(err)
	}
	got, err := e.svc.Get(ctx, e.user, reminder.ScopeCategory, cat)
	if err != nil || got == nil || len(got.Rules) != 2 {
		t.Errorf("get = %+v, %v", got, err)
	}
}

func TestSettingsOfOtherUsersAreNotFound(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	cat := e.category("Работа", nil)
	in := e.task(e.user, "Дело", at(14, 10, 0), at(14, 11, 0))
	for name, target := range map[string]struct {
		scope reminder.Scope
		id    uuid.UUID
	}{
		"category": {reminder.ScopeCategory, cat},
		"instance": {reminder.ScopeInstance, in.ID},
		"missing":  {reminder.ScopeSeries, uuid.New()},
	} {
		if _, err := e.svc.Get(ctx, e.other, target.scope, target.id); !errors.Is(err, reminder.ErrNotFound) {
			t.Errorf("%s get: %v", name, err)
		}
		if err := e.svc.Put(ctx, e.other, target.scope, target.id, set(before10)); !errors.Is(err, reminder.ErrNotFound) {
			t.Errorf("%s put: %v", name, err)
		}
		if err := e.svc.Delete(ctx, e.other, target.scope, target.id); !errors.Is(err, reminder.ErrNotFound) {
			t.Errorf("%s delete: %v", name, err)
		}
		if _, err := e.svc.Effective(ctx, e.other, target.scope, target.id); !errors.Is(err, reminder.ErrNotFound) {
			t.Errorf("%s effective: %v", name, err)
		}
	}
	// A deleted occurrence of a series is gone too.
	rule := "FREQ=DAILY"
	first, _ := e.tasks.Create(ctx, e.user, task.CreateInput{Title: "С", PlannedStart: at(14, 12, 0), PlannedEnd: at(14, 12, 30), Recurrence: &rule})
	if err := e.tasks.Delete(ctx, e.user, first.ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Put(ctx, e.user, reminder.ScopeInstance, first.ID, set(before10)); !errors.Is(err, reminder.ErrNotFound) {
		t.Errorf("deleted occurrence: %v", err)
	}
}

func TestEffectiveSaysWhereTheRulesComeFrom(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	work := e.category("Работа", nil)
	sub := e.category("Проект", &work)
	in := e.task(e.user, "Дело", at(14, 10, 0), at(14, 11, 0), sub)

	check := func(scope reminder.Scope, id uuid.UUID, wantSource reminder.Scope, wantRules int) {
		t.Helper()
		got, err := e.svc.Effective(ctx, e.user, scope, id)
		if err != nil {
			t.Fatal(err)
		}
		if got.Source != wantSource || len(got.Rules) != wantRules {
			t.Errorf("%s %v: source %s with %d rules, want %s with %d", scope, id, got.Source, len(got.Rules), wantSource, wantRules)
		}
	}
	check(reminder.ScopeInstance, in.ID, reminder.ScopeGlobal, 2)
	check(reminder.ScopeCategory, sub, reminder.ScopeGlobal, 2)

	if err := e.svc.Put(ctx, e.user, reminder.ScopeCategory, work, set(before60)); err != nil {
		t.Fatal(err)
	}
	check(reminder.ScopeCategory, sub, reminder.ScopeCategory, 1) // inherited from the parent
	check(reminder.ScopeInstance, in.ID, reminder.ScopeCategory, 1)

	if err := e.svc.Put(ctx, e.user, reminder.ScopeInstance, in.ID, set(afterEnd, late5)); err != nil {
		t.Fatal(err)
	}
	check(reminder.ScopeInstance, in.ID, reminder.ScopeInstance, 2)
	check(reminder.ScopeGlobal, uuid.Nil, reminder.ScopeGlobal, 2)
	h, err := e.habits.Create(ctx, e.user, habit.Input{Title: "Читать", Kind: habit.Boolean, Color: "#112233", Schedule: habit.Schedule{Frequency: habit.Daily}})
	if err != nil {
		t.Fatal(err)
	}
	check(reminder.ScopeHabit, h.ID, reminder.ScopeHabit, 0) // habits have no defaults
}

func TestDeletingATargetDeletesItsSettings(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	cat := e.category("Работа", nil)
	if err := e.svc.Put(ctx, e.user, reminder.ScopeCategory, cat, set(before60)); err != nil {
		t.Fatal(err)
	}
	if err := e.cats.Delete(ctx, e.user, cat); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := e.pool.QueryRow(ctx, `SELECT count(*) FROM reminder_settings WHERE user_id = $1 AND scope = 'category'`, e.user).Scan(&n); err != nil || n != 0 {
		t.Errorf("settings left: %d, %v", n, err)
	}
}

func TestButtons(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	in := e.task(e.user, "Планёрка", at(14, 9, 0), at(14, 9, 30))

	press := func(action string, id uuid.UUID) reminder.CallbackResult {
		t.Helper()
		res, err := e.svc.HandleCallback(ctx, 1001, reminder.Callback(action, id))
		if err != nil {
			t.Fatal(err)
		}
		return res
	}
	status := func() string {
		got, err := e.tasks.Get(ctx, e.user, in.ID)
		if err != nil {
			t.Fatal(err)
		}
		return got.Status
	}

	if res := press(reminder.ActionStop, in.ID); !strings.Contains(res.Note, "Уже изменено: запланировано") || status() != "planned" {
		t.Errorf("stop on a task that is not running: %+v, %s", res, status())
	}
	if res := press(reminder.ActionStart, in.ID); res.Note != "▶ Таймер запущен" || status() != "in_progress" {
		t.Errorf("start: %+v, %s", res, status())
	}
	if res := press(reminder.ActionDone, in.ID); !strings.Contains(res.Note, "Уже изменено: идёт") || status() != "in_progress" {
		t.Errorf("done while running: %+v, %s", res, status())
	}
	e.setNow(at(14, 9, 50))
	if res := press(reminder.ActionStop, in.ID); res.Note != "■ Таймер остановлен" || status() != "done" {
		t.Errorf("stop: %+v, %s", res, status())
	}
	if res := press(reminder.ActionNotDone, in.ID); !strings.Contains(res.Note, "Уже изменено: выполнено") || status() != "done" {
		t.Errorf("not done after done: %+v, %s", res, status())
	}

	second := e.task(e.user, "Вторая", at(14, 10, 0), at(14, 10, 30))
	if res := press(reminder.ActionNotDone, second.ID); res.Note != "✗ Не выполнено" {
		t.Errorf("not done: %+v", res)
	}
	if res := press(reminder.ActionDone, second.ID); res.Note != "✓ Выполнено" {
		t.Errorf("done after not done: %+v", res)
	}
	got, _ := e.tasks.Get(ctx, e.user, second.ID)
	if got.Status != "done" || !got.ActualStart.Equal(at(14, 10, 0)) || !got.ActualEnd.Equal(at(14, 10, 30)) {
		t.Errorf("done in one tap should equal the plan: %+v", got)
	}
}

func TestButtonsRefuseOtherPeopleAndUnknownThings(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	in := e.task(e.user, "Планёрка", at(14, 9, 0), at(14, 9, 30))

	// Another Telegram user cannot press the button of a message that was not theirs.
	res, err := e.svc.HandleCallback(ctx, 2002, reminder.Callback(reminder.ActionDone, in.ID))
	if err != nil || res.Note != "Дело удалено" {
		t.Errorf("other user: %+v, %v", res, err)
	}
	if got, _ := e.tasks.Get(ctx, e.user, in.ID); got.Status != "planned" {
		t.Errorf("status = %s: someone else marked the task", got.Status)
	}
	// A person who never signed in.
	if res, _ := e.svc.HandleCallback(ctx, 9999, reminder.Callback(reminder.ActionDone, in.ID)); res.Answer != "Сначала откройте приложение" {
		t.Errorf("stranger: %+v", res)
	}
	for _, bad := range []string{"", "done", "done:xyz", "drop:" + in.ID.String()} {
		if res, err := e.svc.HandleCallback(ctx, 1001, bad); err != nil || res.Answer != "Неизвестное действие" {
			t.Errorf("%q: %+v, %v", bad, res, err)
		}
	}
	// A deleted task.
	if err := e.tasks.Delete(ctx, e.user, in.ID, task.ScopeThis); err != nil {
		t.Fatal(err)
	}
	if res, _ := e.svc.HandleCallback(ctx, 1001, reminder.Callback(reminder.ActionDone, in.ID)); res.Note != "Дело удалено" {
		t.Errorf("deleted: %+v", res)
	}
}

func TestTheHabitButton(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	h, _ := e.habits.Create(ctx, e.user, habit.Input{Title: "Читать", Kind: habit.Boolean, Color: "#06b6d4", Schedule: habit.Schedule{Frequency: habit.Daily}})
	res, err := e.svc.HandleCallback(ctx, 1001, reminder.Callback(reminder.ActionHabit, h.ID))
	if err != nil || res.Note != "✓ Выполнено" {
		t.Fatalf("%+v, %v", res, err)
	}
	items, _, _ := e.habits.Today(ctx, e.user)
	if len(items) != 1 || !items[0].Done {
		t.Errorf("today = %+v", items)
	}
	// Somebody else's habit is not there for them.
	res, _ = e.svc.HandleCallback(ctx, 2002, reminder.Callback(reminder.ActionHabit, h.ID))
	if res.Note != "Привычка удалена" {
		t.Errorf("other user: %+v", res)
	}
}

func (e *env) move(in task.Instance, start, end time.Time) {
	e.t.Helper()
	if _, err := e.tasks.Update(context.Background(), e.user, in.ID, task.ScopeThis, task.UpdateInput{PlannedStart: &start, PlannedEnd: &end}); err != nil {
		e.t.Fatal(err)
	}
}

func TestAMessageForAPlanThatChangedIsNotSent(t *testing.T) {
	e := newEnv(t)
	in := e.task(e.user, "Планёрка", at(14, 10, 5), at(14, 11, 0))
	e.setNow(at(14, 9, 55))
	e.plan() // "10 minutes before" for 10:05 is due at 9:55
	if n := len(e.rows(e.user)); n != 1 {
		t.Fatalf("queued = %d", n)
	}
	e.setNow(at(14, 9, 56))
	e.move(in, at(14, 15, 0), at(14, 16, 0))
	e.setNow(at(14, 9, 57))
	if got := e.send(); len(got) != 0 {
		t.Errorf("a reminder for the old time was sent: %+v", got)
	}
}

func TestMovingTheEndGivesANewReminderAfterTheEnd(t *testing.T) {
	e := newEnv(t)
	in := e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.setNow(at(14, 11, 0))
	e.plan()
	if got := e.send(); len(got) != 1 || !strings.Contains(got[0].msg.Text, "закончилось в 11:00") {
		t.Fatalf("first: %+v", got)
	}
	// It ran over and the user fixes the end: the request to mark it comes again at the new end.
	e.move(in, at(14, 10, 0), at(14, 12, 0))
	e.setNow(at(14, 12, 0))
	e.plan()
	got := e.send()
	if len(got) != 1 || !strings.Contains(got[0].msg.Text, "закончилось в 12:00") {
		t.Errorf("second: %+v", got)
	}
}

func TestACutSeriesKeepsItsReminders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	rule := "FREQ=DAILY"
	if _, err := e.tasks.Create(ctx, e.user, task.CreateInput{Title: "Зарядка", PlannedStart: at(12, 8, 0), PlannedEnd: at(12, 8, 30), Recurrence: &rule}); err != nil {
		t.Fatal(err)
	}
	list, err := e.tasks.List(ctx, e.user, at(12, 0, 0), at(18, 0, 0))
	if err != nil || len(list) < 4 {
		t.Fatalf("setup: %v %v", list, err)
	}
	if err := e.svc.Put(ctx, e.user, reminder.ScopeSeries, *list[0].SeriesID, reminder.Setting{Enabled: false}); err != nil {
		t.Fatal(err)
	}
	// "This and the following" from the 15th gets a new series.
	title := "Новая зарядка"
	if _, err := e.tasks.Update(ctx, e.user, list[3].ID, task.ScopeFollowing, task.UpdateInput{Title: &title}); err != nil {
		t.Fatal(err)
	}
	list, _ = e.tasks.List(ctx, e.user, at(12, 0, 0), at(18, 0, 0))
	var tail, head task.Instance
	for _, in := range list {
		if in.Title == title {
			tail = in
		} else {
			head = in
		}
	}
	if tail.SeriesID == nil || head.SeriesID == nil || *tail.SeriesID == *head.SeriesID {
		t.Fatalf("the series was not cut: %+v %+v", head, tail)
	}
	got, err := e.svc.Effective(ctx, e.user, reminder.ScopeInstance, tail.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != reminder.ScopeSeries || len(got.Rules) != 0 {
		t.Errorf("the tail lost the settings of the series: %+v", got)
	}
}

func TestARescheduledTaskKeepsItsReminders(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	in := e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	if err := e.svc.Put(ctx, e.user, reminder.ScopeInstance, in.ID, set(before60)); err != nil {
		t.Fatal(err)
	}
	moved, err := e.tasks.Reschedule(ctx, e.user, in.ID, at(15, 10, 0), at(15, 11, 0), "совещание")
	if err != nil {
		t.Fatal(err)
	}
	got, err := e.svc.Effective(ctx, e.user, reminder.ScopeInstance, moved.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Source != reminder.ScopeInstance || len(got.Rules) != 1 || got.Rules[0] != before60 {
		t.Errorf("effective = %+v", got)
	}
}

func TestTwoSendersDoNotTakeTheSameMessage(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	e.setNow(at(14, 9, 51))
	claim := func() int {
		rows, err := e.st.ClaimDueNotifications(ctx, store.ClaimDueNotificationsParams{
			Now: e.clock, LeaseUntil: e.clock.Add(2 * time.Minute), Batch: 50,
		})
		if err != nil {
			t.Fatal(err)
		}
		return len(rows)
	}
	if n := claim(); n != 1 {
		t.Fatalf("first sender got %d", n)
	}
	if n := claim(); n != 0 {
		t.Errorf("second sender got %d of the message that the first holds", n)
	}
	// The lease ends: the message can be taken again (the first sender died).
	e.setNow(e.clock.Add(3 * time.Minute))
	if n := claim(); n != 1 {
		t.Errorf("after the lease: %d", n)
	}
}

func TestAMessageThatCannotBeBuiltIsRetriedLaterNotForever(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	e.task(e.user, "Планёрка", at(14, 10, 0), at(14, 11, 0))
	e.plan()
	// Something is wrong with the user's data, not with Telegram.
	if _, err := e.pool.Exec(ctx, `UPDATE users SET timezone = 'Nowhere/Land' WHERE id = $1`, e.user); err != nil {
		t.Fatal(err)
	}
	e.setNow(at(14, 9, 51))
	e.send() // must return, and count the try
	e.send()
	var attempts int
	var pushed bool
	if err := e.pool.QueryRow(ctx,
		`SELECT attempts, send_at > $2 FROM notifications WHERE user_id = $1`, e.user, e.clock).Scan(&attempts, &pushed); err != nil {
		t.Fatal(err)
	}
	if attempts != 1 || !pushed {
		t.Errorf("attempts = %d, pushed later = %v, want 1 and true", attempts, pushed)
	}
	if len(e.sender.sent) != 0 {
		t.Errorf("sent: %+v", e.sender.sent)
	}
}

func TestAHabitReminderHeldBackPastMidnightIsDropped(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	if err := e.svc.SetGlobal(ctx, e.user, reminder.Global{Enabled: true, Quiet: &reminder.Quiet{Start: 22 * 60, End: 8 * 60}}); err != nil {
		t.Fatal(err)
	}
	h, _ := e.habits.Create(ctx, e.user, habit.Input{Title: "Читать", Kind: habit.Boolean, Color: "#06b6d4", Schedule: habit.Schedule{Frequency: habit.Daily}})
	if err := e.svc.Put(ctx, e.user, reminder.ScopeHabit, h.ID, set(reminder.Rule{Kind: reminder.HabitTime, TimeOfDay: 23*60 + 30})); err != nil {
		t.Fatal(err)
	}
	e.setNow(at(14, 23, 28))
	e.plan() // due at 23:30 on the 14th, inside the quiet hours: held back to 08:00 on the 15th
	e.setNow(at(14, 23, 40))
	if got := e.send(); len(got) != 0 {
		t.Fatalf("sent in the quiet hours: %+v", got)
	}
	e.setNow(at(15, 8, 1))
	if got := e.send(); len(got) != 0 {
		t.Errorf("a reminder for yesterday was sent: %+v", got)
	}
}
