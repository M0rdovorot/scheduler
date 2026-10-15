package task_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

type env struct {
	t     *testing.T
	svc   *task.Service
	cats  *category.Service
	pool  *pgxpool.Pool
	user  uuid.UUID
	other uuid.UUID
}

func newEnv(t *testing.T) *env {
	t.Helper()
	pool := testutil.NewDB(t, migrations.FS)
	st := store.NewStore(pool)
	mk := func(name string) uuid.UUID {
		u, err := st.CreateUser(context.Background(), store.CreateUserParams{DisplayName: name, Timezone: "UTC"})
		if err != nil {
			t.Fatal(err)
		}
		return u.ID
	}
	return &env{t: t, svc: task.NewService(st), cats: category.NewService(st), pool: pool, user: mk("a"), other: mk("b")}
}

func (e *env) category(user uuid.UUID, name string) uuid.UUID {
	e.t.Helper()
	c, err := e.cats.Create(context.Background(), user, category.CreateInput{Name: name, Color: "#aabbcc"})
	if err != nil {
		e.t.Fatal(err)
	}
	return c.ID
}

var base = time.Date(2026, 10, 14, 10, 0, 0, 0, time.UTC)

func at(h, m int) time.Time {
	return base.Add(time.Duration(h-10)*time.Hour + time.Duration(m)*time.Minute)
}

func (e *env) create(title string, start, end time.Time, cats ...uuid.UUID) task.Instance {
	e.t.Helper()
	in, err := e.svc.Create(context.Background(), e.user, task.CreateInput{Title: title, PlannedStart: start, PlannedEnd: end, CategoryIDs: cats})
	if err != nil {
		e.t.Fatalf("create %q: %v", title, err)
	}
	return in
}

func wantField(t *testing.T, err error, field string) {
	t.Helper()
	var verr *validation.Error
	if !errors.As(err, &verr) || verr.Field != field {
		t.Fatalf("err = %v, want a validation error on %q", err, field)
	}
}

func ptr[T any](v T) *T { return &v }

func TestCreateAndGet(t *testing.T) {
	e := newEnv(t)
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")

	in, err := e.svc.Create(context.Background(), e.user, task.CreateInput{
		Title: "  Планёрка ", Description: "обсудить", PlannedStart: at(10, 0), PlannedEnd: at(11, 30),
		CategoryIDs: []uuid.UUID{work, sport, work},
	})
	if err != nil {
		t.Fatal(err)
	}
	if in.Title != "Планёрка" || in.Description != "обсудить" || in.Status != "planned" {
		t.Errorf("instance = %+v", in)
	}
	if !in.PlannedStart.Equal(at(10, 0)) || !in.PlannedEnd.Equal(at(11, 30)) {
		t.Errorf("times = %v – %v", in.PlannedStart, in.PlannedEnd)
	}
	if len(in.CategoryIDs) != 2 {
		t.Errorf("categories = %v, want the two distinct ones", in.CategoryIDs)
	}

	got, err := e.svc.Get(context.Background(), e.user, in.ID)
	if err != nil || got.Title != in.Title {
		t.Errorf("Get = %+v, %v", got, err)
	}
}

func TestCreateValidation(t *testing.T) {
	e := newEnv(t)
	foreign := e.category(e.other, "Чужая")
	ok := task.CreateInput{Title: "x", PlannedStart: at(10, 0), PlannedEnd: at(11, 0)}

	tests := []struct {
		name  string
		edit  func(*task.CreateInput)
		field string
	}{
		{"empty title", func(in *task.CreateInput) { in.Title = "  " }, "title"},
		{"long title", func(in *task.CreateInput) { in.Title = strings.Repeat("я", 201) }, "title"},
		{"NUL in title", func(in *task.CreateInput) { in.Title = "a\x00" }, "title"},
		{"long description", func(in *task.CreateInput) { in.Description = strings.Repeat("я", 5001) }, "description"},
		{"NUL in description", func(in *task.CreateInput) { in.Description = "a\x00" }, "description"},
		{"empty interval", func(in *task.CreateInput) { in.PlannedEnd = in.PlannedStart }, "planned_end"},
		{"backwards interval", func(in *task.CreateInput) { in.PlannedEnd = at(9, 0) }, "planned_end"},
		{"unknown category", func(in *task.CreateInput) { in.CategoryIDs = []uuid.UUID{uuid.New()} }, "category_ids"},
		{"another user's category", func(in *task.CreateInput) { in.CategoryIDs = []uuid.UUID{foreign} }, "category_ids"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			in := ok
			tt.edit(&in)
			_, err := e.svc.Create(context.Background(), e.user, in)
			wantField(t, err, tt.field)
		})
	}

	// Boundaries that must pass.
	in := ok
	in.Title = strings.Repeat("я", 200)
	in.Description = strings.Repeat("я", 5000)
	if _, err := e.svc.Create(context.Background(), e.user, in); err != nil {
		t.Errorf("limits: %v", err)
	}
	// The failed creates left nothing behind.
	list, _ := e.svc.List(context.Background(), e.user, at(0, 0).Add(-24*time.Hour), at(0, 0).Add(48*time.Hour))
	if len(list) != 1 {
		t.Errorf("%d tasks after failed creates, want only the valid one", len(list))
	}
}

func TestTaskMayCrossMidnight(t *testing.T) {
	e := newEnv(t)
	in := e.create("Ночная смена", at(22, 0), at(22, 0).Add(8*time.Hour))
	if got := in.PlannedEnd.Sub(in.PlannedStart); got != 8*time.Hour {
		t.Errorf("duration = %v", got)
	}
}

func TestListOverlap(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	before := e.create("before", at(8, 0), at(9, 0))
	touchesStart := e.create("ends at from", at(9, 0), at(10, 0))
	inside := e.create("inside", at(10, 30), at(11, 0))
	crossesFrom := e.create("crosses from", at(9, 30), at(10, 30))
	crossesTo := e.create("crosses to", at(11, 30), at(13, 0))
	spans := e.create("spans all", at(8, 0), at(14, 0))
	touchesEnd := e.create("starts at to", at(12, 0), at(13, 0))
	_ = before

	list, err := e.svc.List(ctx, e.user, at(10, 0), at(12, 0))
	if err != nil {
		t.Fatal(err)
	}
	var got []uuid.UUID
	for _, in := range list {
		got = append(got, in.ID)
	}
	want := []uuid.UUID{spans.ID, crossesFrom.ID, inside.ID, crossesTo.ID} // ordered by start
	if len(got) != len(want) {
		t.Fatalf("got %d tasks, want %d: %v", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("position %d: got %v, want %v", i, got[i], want[i])
		}
	}
	for _, excluded := range []task.Instance{touchesStart, touchesEnd} {
		if slicesContains(got, excluded.ID) {
			t.Errorf("%q touches the range only at its edge but was listed", excluded.Title)
		}
	}
}

func slicesContains(ids []uuid.UUID, id uuid.UUID) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestListRangeValidation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	_, err := e.svc.List(ctx, e.user, at(10, 0), at(10, 0))
	wantField(t, err, "to")
	_, err = e.svc.List(ctx, e.user, at(10, 0), at(9, 0))
	wantField(t, err, "to")
	_, err = e.svc.List(ctx, e.user, at(10, 0), at(10, 0).Add(task.MaxRange+time.Second))
	wantField(t, err, "to")
	if _, err = e.svc.List(ctx, e.user, at(10, 0), at(10, 0).Add(task.MaxRange)); err != nil {
		t.Errorf("max range: %v", err)
	}
}

func TestUpdate(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")
	in := e.create("Старое", at(10, 0), at(11, 0), work)

	got, err := e.svc.Update(ctx, e.user, in.ID, task.UpdateInput{Title: ptr(" Новое "), Description: ptr("d")})
	if err != nil {
		t.Fatal(err)
	}
	if got.Title != "Новое" || got.Description != "d" || !got.PlannedStart.Equal(at(10, 0)) || len(got.CategoryIDs) != 1 {
		t.Errorf("partial update = %+v", got)
	}

	// Moving only the end keeps the start; the merged range must stay valid.
	got, err = e.svc.Update(ctx, e.user, in.ID, task.UpdateInput{PlannedEnd: ptr(at(12, 0))})
	if err != nil || !got.PlannedEnd.Equal(at(12, 0)) || !got.PlannedStart.Equal(at(10, 0)) {
		t.Errorf("end update = %+v, %v", got, err)
	}
	_, err = e.svc.Update(ctx, e.user, in.ID, task.UpdateInput{PlannedStart: ptr(at(13, 0))})
	wantField(t, err, "planned_end")

	// Categories are replaced as a set; an empty set clears them.
	got, err = e.svc.Update(ctx, e.user, in.ID, task.UpdateInput{CategoryIDs: &[]uuid.UUID{sport}})
	if err != nil || len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != sport {
		t.Errorf("replace categories = %+v, %v", got, err)
	}
	got, err = e.svc.Update(ctx, e.user, in.ID, task.UpdateInput{CategoryIDs: &[]uuid.UUID{}})
	if err != nil || len(got.CategoryIDs) != 0 {
		t.Errorf("clear categories = %+v, %v", got, err)
	}

	// A rejected update changes nothing.
	_, err = e.svc.Update(ctx, e.user, in.ID, task.UpdateInput{Title: ptr("changed"), CategoryIDs: &[]uuid.UUID{uuid.New()}})
	wantField(t, err, "category_ids")
	if after, _ := e.svc.Get(ctx, e.user, in.ID); after.Title != "Новое" {
		t.Errorf("title = %q after a rejected update", after.Title)
	}

	if _, err := e.svc.Update(ctx, e.user, uuid.New(), task.UpdateInput{Title: ptr("x")}); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("unknown id: %v", err)
	}
}

func TestDelete(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	in := e.create("x", at(10, 0), at(11, 0))
	if err := e.svc.Delete(ctx, e.user, in.ID); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Delete(ctx, e.user, in.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("second delete: %v", err)
	}
	if _, err := e.svc.Get(ctx, e.user, in.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Get after delete: %v", err)
	}
}

func TestUsersAreIsolated(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	mine := e.create("Моё", at(10, 0), at(11, 0))

	if list, _ := e.svc.List(ctx, e.other, at(0, 0), at(23, 0)); len(list) != 0 {
		t.Errorf("another user sees %d tasks", len(list))
	}
	if _, err := e.svc.Get(ctx, e.other, mine.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Get: %v", err)
	}
	if _, err := e.svc.Update(ctx, e.other, mine.ID, task.UpdateInput{Title: ptr("hacked")}); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Update: %v", err)
	}
	if err := e.svc.Delete(ctx, e.other, mine.ID); !errors.Is(err, task.ErrNotFound) {
		t.Errorf("Delete: %v", err)
	}
	if got, _ := e.svc.Get(ctx, e.user, mine.ID); got.Title != "Моё" {
		t.Errorf("task changed: %+v", got)
	}
}

func TestDeletingCategoryKeepsTasks(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	work, sport := e.category(e.user, "Работа"), e.category(e.user, "Спорт")
	in := e.create("x", at(10, 0), at(11, 0), work, sport)

	if err := e.cats.Delete(ctx, e.user, work); err != nil {
		t.Fatal(err)
	}
	got, err := e.svc.Get(ctx, e.user, in.ID)
	if err != nil {
		t.Fatalf("the task disappeared with its category: %v", err)
	}
	if len(got.CategoryIDs) != 1 || got.CategoryIDs[0] != sport {
		t.Errorf("categories = %v, want only the remaining one", got.CategoryIDs)
	}
}

func TestDatabaseConstraints(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	foreign := e.category(e.other, "Чужая")
	mine := e.create("x", at(10, 0), at(11, 0))

	// Bypassing the service: the schema itself must refuse these.
	if _, err := e.pool.Exec(ctx, `INSERT INTO instance_categories (instance_id, category_id, user_id) VALUES ($1, $2, $3)`, mine.ID, foreign, e.user); err == nil {
		t.Error("a task was linked to another user's category")
	}
	if _, err := e.pool.Exec(ctx, `INSERT INTO task_instances (user_id, title, planned_start, planned_end) VALUES ($1, 'x', $2, $2)`, e.user, at(10, 0)); err == nil {
		t.Error("an empty interval was accepted")
	}
	if _, err := e.pool.Exec(ctx, `UPDATE task_instances SET status = 'bogus' WHERE id = $1`, mine.ID); err == nil {
		t.Error("an unknown status was accepted")
	}
}
