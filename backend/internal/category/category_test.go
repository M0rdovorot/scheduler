package category_test

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

type env struct {
	t     *testing.T
	svc   *category.Service
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
	return &env{t: t, svc: category.NewService(st), pool: pool, user: mk("a"), other: mk("b")}
}

func (e *env) create(name string, parent *uuid.UUID) category.Category {
	e.t.Helper()
	c, err := e.svc.Create(context.Background(), e.user, category.CreateInput{Name: name, Color: "#aabbcc", ParentID: parent})
	if err != nil {
		e.t.Fatalf("create %q: %v", name, err)
	}
	return c
}

func (e *env) byID() map[uuid.UUID]category.Category {
	e.t.Helper()
	list, err := e.svc.List(context.Background(), e.user)
	if err != nil {
		e.t.Fatal(err)
	}
	m := make(map[uuid.UUID]category.Category, len(list))
	for _, c := range list {
		m[c.ID] = c
	}
	return m
}

func wantValidation(t *testing.T, err error, code, field string) {
	t.Helper()
	var verr *validation.Error
	if !errors.As(err, &verr) {
		t.Fatalf("err = %v, want validation error", err)
	}
	if verr.ErrorCode() != code || verr.Field != field {
		t.Errorf("validation error = {code %q, field %q}, want {%q, %q}", verr.ErrorCode(), verr.Field, code, field)
	}
}

func TestCreateNormalizesAndStoresTree(t *testing.T) {
	e := newEnv(t)
	sport, err := e.svc.Create(context.Background(), e.user, category.CreateInput{Name: "  Спорт ", Color: "#FFA500"})
	if err != nil {
		t.Fatal(err)
	}
	if sport.Name != "Спорт" || sport.Color != "#ffa500" || sport.ParentID != nil || sport.ArchivedAt != nil {
		t.Errorf("sport = %+v", sport)
	}
	run := e.create("Бег", &sport.ID)
	if run.ParentID == nil || *run.ParentID != sport.ID {
		t.Errorf("run.ParentID = %v, want %v", run.ParentID, sport.ID)
	}
}

func TestCreateValidation(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	missing := uuid.New()

	tests := []struct {
		name  string
		in    category.CreateInput
		field string
	}{
		{"empty name", category.CreateInput{Name: "  ", Color: "#aabbcc"}, "name"},
		{"long name", category.CreateInput{Name: strings.Repeat("я", 101), Color: "#aabbcc"}, "name"},
		{"NUL character", category.CreateInput{Name: "a\x00b", Color: "#aabbcc"}, "name"},
		{"invalid UTF-8", category.CreateInput{Name: "a\xffb", Color: "#aabbcc"}, "name"},
		{"bad color", category.CreateInput{Name: "x", Color: "red"}, "color"},
		{"short hex", category.CreateInput{Name: "x", Color: "#abc"}, "color"},
		{"unknown parent", category.CreateInput{Name: "x", Color: "#aabbcc", ParentID: &missing}, "parent_id"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := e.svc.Create(ctx, e.user, tt.in)
			wantValidation(t, err, validation.CodeFailed, tt.field)
		})
	}

	// 100 characters is the limit, counted in characters rather than bytes.
	if _, err := e.svc.Create(ctx, e.user, category.CreateInput{Name: strings.Repeat("я", 100), Color: "#aabbcc"}); err != nil {
		t.Errorf("100-character name: %v", err)
	}
}

func TestUsersCannotTouchEachOthersCategories(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	mine := e.create("Моя", nil)
	name := "x"

	// A parent of another user is reported as not found, like a missing one.
	_, err := e.svc.Create(ctx, e.other, category.CreateInput{Name: "child", Color: "#aabbcc", ParentID: &mine.ID})
	wantValidation(t, err, validation.CodeFailed, "parent_id")

	checks := map[string]error{}
	_, checks["update"] = e.svc.Update(ctx, e.other, mine.ID, category.UpdateInput{Name: &name})
	_, checks["move"] = e.svc.Move(ctx, e.other, mine.ID, nil)
	_, checks["archive"] = e.svc.Archive(ctx, e.other, mine.ID)
	_, checks["unarchive"] = e.svc.Unarchive(ctx, e.other, mine.ID)
	checks["delete"] = e.svc.Delete(ctx, e.other, mine.ID)
	for op, err := range checks {
		if !errors.Is(err, category.ErrNotFound) {
			t.Errorf("%s by another user: err = %v, want ErrNotFound", op, err)
		}
	}

	if list, _ := e.svc.List(ctx, e.other); len(list) != 0 {
		t.Errorf("other user sees %d categories", len(list))
	}
	if got := e.byID()[mine.ID]; got.Name != "Моя" || got.ArchivedAt != nil {
		t.Errorf("category was modified: %+v", got)
	}
}

func TestUpdate(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	c := e.create("Старое", nil)

	newName, newColor := " Новое ", "#00FF00"
	got, err := e.svc.Update(ctx, e.user, c.ID, category.UpdateInput{Name: &newName, Color: &newColor})
	if err != nil || got.Name != "Новое" || got.Color != "#00ff00" {
		t.Fatalf("Update = %+v, %v", got, err)
	}

	got, err = e.svc.Update(ctx, e.user, c.ID, category.UpdateInput{Color: ptr("#112233")})
	if err != nil || got.Name != "Новое" || got.Color != "#112233" {
		t.Errorf("partial update = %+v, %v", got, err)
	}

	_, err = e.svc.Update(ctx, e.user, c.ID, category.UpdateInput{Name: ptr("")})
	wantValidation(t, err, validation.CodeFailed, "name")
	if _, err = e.svc.Update(ctx, e.user, uuid.New(), category.UpdateInput{Name: ptr("x")}); !errors.Is(err, category.ErrNotFound) {
		t.Errorf("unknown id: err = %v, want ErrNotFound", err)
	}
}

func ptr[T any](v T) *T { return &v }

func TestMove(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	a := e.create("A", nil)
	b := e.create("B", &a.ID)
	c := e.create("C", &b.ID)
	d := e.create("D", nil)

	t.Run("to another parent and back to the top", func(t *testing.T) {
		got, err := e.svc.Move(ctx, e.user, b.ID, &d.ID)
		if err != nil || got.ParentID == nil || *got.ParentID != d.ID {
			t.Fatalf("Move = %+v, %v", got, err)
		}
		// The subtree moves along.
		if cc := e.byID()[c.ID]; cc.ParentID == nil || *cc.ParentID != b.ID {
			t.Errorf("C.ParentID = %v, want B", cc.ParentID)
		}
		got, err = e.svc.Move(ctx, e.user, b.ID, nil)
		if err != nil || got.ParentID != nil {
			t.Fatalf("Move to top = %+v, %v", got, err)
		}
		if _, err := e.svc.Move(ctx, e.user, b.ID, &a.ID); err != nil {
			t.Fatal(err)
		}
	})

	t.Run("cycles are rejected", func(t *testing.T) {
		for name, parent := range map[string]uuid.UUID{"itself": a.ID, "child": b.ID, "grandchild": c.ID} {
			_, err := e.svc.Move(ctx, e.user, a.ID, &parent)
			if err == nil {
				t.Errorf("A into %s: no error", name)
				continue
			}
			wantValidation(t, err, category.CodeCycle, "parent_id")
		}
		if got := e.byID()[a.ID]; got.ParentID != nil {
			t.Errorf("A.ParentID = %v after rejected moves", got.ParentID)
		}
	})

	t.Run("unknown and foreign parents", func(t *testing.T) {
		missing := uuid.New()
		_, err := e.svc.Move(ctx, e.user, a.ID, &missing)
		wantValidation(t, err, validation.CodeFailed, "parent_id")
		if _, err := e.svc.Move(ctx, e.user, missing, nil); !errors.Is(err, category.ErrNotFound) {
			t.Errorf("unknown category: err = %v, want ErrNotFound", err)
		}
	})
}

func TestArchiveCoversSubtreeAndGuardsParents(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	root := e.create("Root", nil)
	mid := e.create("Mid", &root.ID)
	leaf := e.create("Leaf", &mid.ID)
	sibling := e.create("Sibling", &root.ID)
	other := e.create("Other", nil)

	got, err := e.svc.Archive(ctx, e.user, mid.ID)
	if err != nil || got.ArchivedAt == nil {
		t.Fatalf("Archive = %+v, %v", got, err)
	}
	all := e.byID()
	for name, id := range map[string]uuid.UUID{"mid": mid.ID, "leaf": leaf.ID} {
		if all[id].ArchivedAt == nil {
			t.Errorf("%s is not archived", name)
		}
	}
	for name, id := range map[string]uuid.UUID{"root": root.ID, "sibling": sibling.ID, "other": other.ID} {
		if all[id].ArchivedAt != nil {
			t.Errorf("%s was archived", name)
		}
	}

	// Archiving again keeps the original timestamp.
	first := all[mid.ID].ArchivedAt
	if _, err := e.svc.Archive(ctx, e.user, root.ID); err != nil {
		t.Fatal(err)
	}
	if again := e.byID()[mid.ID].ArchivedAt; !again.Equal(*first) {
		t.Errorf("archived_at of mid changed from %v to %v", first, again)
	}

	// No new categories under an archived one, and no moves under it.
	_, err = e.svc.Create(ctx, e.user, category.CreateInput{Name: "x", Color: "#aabbcc", ParentID: &mid.ID})
	wantValidation(t, err, category.CodeParentArchived, "parent_id")
	_, err = e.svc.Move(ctx, e.user, other.ID, &mid.ID)
	wantValidation(t, err, category.CodeParentArchived, "parent_id")

	// An archived category may move anywhere, including under another archived one.
	if _, err := e.svc.Move(ctx, e.user, leaf.ID, &root.ID); err != nil {
		t.Errorf("moving an archived category: %v", err)
	}
}

func TestUnarchive(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	root := e.create("Root", nil)
	child := e.create("Child", &root.ID)
	if _, err := e.svc.Archive(ctx, e.user, root.ID); err != nil {
		t.Fatal(err)
	}

	_, err := e.svc.Unarchive(ctx, e.user, child.ID)
	wantValidation(t, err, category.CodeParentArchived, "parent_id")

	got, err := e.svc.Unarchive(ctx, e.user, root.ID)
	if err != nil || got.ArchivedAt != nil {
		t.Fatalf("Unarchive root = %+v, %v", got, err)
	}
	// Only the named category comes back; its subcategories stay archived.
	if e.byID()[child.ID].ArchivedAt == nil {
		t.Error("child was unarchived together with its parent")
	}
	if got, err := e.svc.Unarchive(ctx, e.user, child.ID); err != nil || got.ArchivedAt != nil {
		t.Errorf("Unarchive child = %+v, %v", got, err)
	}
}

func TestDeleteRemovesWholeSubtree(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	root := e.create("Root", nil)
	mid := e.create("Mid", &root.ID)
	e.create("Leaf", &mid.ID)
	keep := e.create("Keep", nil)
	keepChild := e.create("KeepChild", &keep.ID)

	if err := e.svc.Delete(ctx, e.user, root.ID); err != nil {
		t.Fatal(err)
	}
	all := e.byID()
	if len(all) != 2 || all[keep.ID].Name != "Keep" || all[keepChild.ID].Name != "KeepChild" {
		t.Errorf("remaining categories = %+v", all)
	}
	if err := e.svc.Delete(ctx, e.user, root.ID); !errors.Is(err, category.ErrNotFound) {
		t.Errorf("second delete: err = %v, want ErrNotFound", err)
	}
}

func TestDatabaseRejectsCrossUserParent(t *testing.T) {
	e := newEnv(t)
	mine := e.create("Mine", nil)
	// Bypass the service: the composite foreign key must still hold.
	_, err := e.pool.Exec(context.Background(),
		`INSERT INTO categories (user_id, parent_id, name, color) VALUES ($1, $2, 'x', '#aabbcc')`, e.other, mine.ID)
	if err == nil {
		t.Fatal("a category of another user was accepted as parent")
	}
}

func TestConcurrentOppositeMovesNeverCreateCycle(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	a := e.create("A", nil)
	b := e.create("B", nil)

	for range 10 {
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, _ = e.svc.Move(ctx, e.user, a.ID, &b.ID) }()
		go func() { defer wg.Done(); _, _ = e.svc.Move(ctx, e.user, b.ID, &a.ID) }()
		wg.Wait()

		all := e.byID()
		aUnderB := all[a.ID].ParentID != nil && *all[a.ID].ParentID == b.ID
		bUnderA := all[b.ID].ParentID != nil && *all[b.ID].ParentID == a.ID
		if aUnderB && bUnderA {
			t.Fatal("A and B became each other's parents")
		}
		// Reset for the next round.
		_, _ = e.svc.Move(ctx, e.user, a.ID, nil)
		_, _ = e.svc.Move(ctx, e.user, b.ID, nil)
	}
}

func TestConcurrentDeleteAndCreateUnderParent(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	for range 20 {
		parent := e.create("P", nil)
		var wg sync.WaitGroup
		var createErr, deleteErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			_, createErr = e.svc.Create(ctx, e.user, category.CreateInput{Name: "c", Color: "#aabbcc", ParentID: &parent.ID})
		}()
		go func() { defer wg.Done(); deleteErr = e.svc.Delete(ctx, e.user, parent.ID) }()
		wg.Wait()

		// Whichever wins, the loser gets a clean domain error, never a raw database error.
		var verr *validation.Error
		if createErr != nil && !errors.As(createErr, &verr) {
			t.Fatalf("create under a deleted parent: %v, want a validation error", createErr)
		}
		if deleteErr != nil {
			t.Fatalf("delete: %v", deleteErr)
		}
		if n := len(e.byID()); n != 0 {
			t.Fatalf("%d categories left after delete of their root", n)
		}
	}
}
