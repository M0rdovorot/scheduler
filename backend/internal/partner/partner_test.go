package partner_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/partner"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

type env struct {
	t       *testing.T
	svc     *partner.Service
	st      *store.Store
	a, b, c uuid.UUID
	now     time.Time
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
	e := &env{t: t, st: st, a: mk("Anna"), b: mk("Boris"), c: mk("Clara"), now: time.Date(2026, 10, 14, 9, 0, 0, 0, time.UTC)}
	e.svc = partner.NewService(st)
	e.svc.SetClock(func() time.Time { return e.now })
	return e
}

// link makes a and b partners.
func (e *env) link(a, b uuid.UUID) {
	e.t.Helper()
	inv, err := e.svc.CreateInvite(context.Background(), a)
	if err != nil {
		e.t.Fatal(err)
	}
	if _, err := e.svc.Accept(context.Background(), b, inv.Token); err != nil {
		e.t.Fatal(err)
	}
}

func TestAcceptLinksBothWays(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	inv, err := e.svc.CreateInvite(ctx, e.a)
	if err != nil {
		t.Fatal(err)
	}
	if want := e.now.Add(partner.InviteTTL); !inv.ExpiresAt.Equal(want) {
		t.Errorf("expires_at = %v, want %v", inv.ExpiresAt, want)
	}

	p, err := e.svc.Accept(ctx, e.b, inv.Token)
	if err != nil {
		t.Fatal(err)
	}
	if p.ID != e.a || p.DisplayName != "Anna" {
		t.Errorf("accepter got partner %+v, want Anna", p)
	}
	for user, want := range map[uuid.UUID]string{e.a: "Boris", e.b: "Anna"} {
		list, err := e.svc.List(ctx, user)
		if err != nil || len(list) != 1 || list[0].DisplayName != want {
			t.Errorf("List(%v) = %+v, %v; want only %s", user, list, err, want)
		}
	}
}

func TestInviteIsSingleUse(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	inv, _ := e.svc.CreateInvite(ctx, e.a)
	if _, err := e.svc.Accept(ctx, e.b, inv.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.Accept(ctx, e.c, inv.Token); !errors.Is(err, partner.ErrInvalidInvite) {
		t.Errorf("second accept: %v, want ErrInvalidInvite", err)
	}
}

func TestInviteRejections(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()

	if _, err := e.svc.Accept(ctx, e.b, "no-such-token"); !errors.Is(err, partner.ErrInvalidInvite) {
		t.Errorf("unknown token: %v", err)
	}

	inv, _ := e.svc.CreateInvite(ctx, e.a)
	if _, err := e.svc.Accept(ctx, e.a, inv.Token); !errors.Is(err, partner.ErrOwnInvite) {
		t.Errorf("own invite: %v", err)
	}

	// A failed accept does not burn the invite.
	e.link(e.a, e.b)
	if _, err := e.svc.Accept(ctx, e.b, inv.Token); !errors.Is(err, partner.ErrAlreadyLinked) {
		t.Errorf("already partners: %v", err)
	}
	if _, err := e.svc.Accept(ctx, e.c, inv.Token); err != nil {
		t.Errorf("invite should still work for someone else: %v", err)
	}

	old, _ := e.svc.CreateInvite(ctx, e.a)
	e.now = e.now.Add(partner.InviteTTL)
	if _, err := e.svc.Accept(ctx, e.c, old.Token); !errors.Is(err, partner.ErrInvalidInvite) {
		t.Errorf("expired invite: %v", err)
	}
}

func TestSetAccess(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	yes, no := true, false

	if _, err := e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Tasks: &yes}); !errors.Is(err, partner.ErrNotFound) {
		t.Fatalf("access for a stranger: %v, want ErrNotFound", err)
	}

	e.link(e.a, e.b)
	p, err := e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Tasks: &yes})
	if err != nil || !p.TasksShared || p.HabitsShared {
		t.Fatalf("grant tasks: %+v, %v", p, err)
	}
	// Habits are separate; a patch with only habits leaves tasks as they are.
	p, err = e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Habits: &yes})
	if err != nil || !p.TasksShared || !p.HabitsShared {
		t.Fatalf("grant habits: %+v, %v", p, err)
	}
	// The grant is one-way: b gave nothing to a.
	if list, _ := e.svc.List(ctx, e.b); list[0].TasksShared || list[0].HabitsShared {
		t.Errorf("b's view shows access b did not give: %+v", list[0])
	}
	p, err = e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Tasks: &no})
	if err != nil || p.TasksShared || !p.HabitsShared {
		t.Fatalf("revoke tasks: %+v, %v", p, err)
	}
}

func TestRemoveDropsLinkAndGrants(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	yes := true
	e.link(e.a, e.b)
	if _, err := e.svc.SetAccess(ctx, e.a, e.b, partner.AccessPatch{Tasks: &yes, Habits: &yes}); err != nil {
		t.Fatal(err)
	}
	if _, err := e.svc.SetAccess(ctx, e.b, e.a, partner.AccessPatch{Tasks: &yes}); err != nil {
		t.Fatal(err)
	}

	// Either side can break the link.
	if err := e.svc.Remove(ctx, e.b, e.a); err != nil {
		t.Fatal(err)
	}
	if err := e.svc.Remove(ctx, e.a, e.b); !errors.Is(err, partner.ErrNotFound) {
		t.Errorf("second remove: %v, want ErrNotFound", err)
	}
	for _, u := range []uuid.UUID{e.a, e.b} {
		if list, _ := e.svc.List(ctx, u); len(list) != 0 {
			t.Errorf("%v still has partners: %+v", u, list)
		}
	}

	// A new link starts with no access.
	e.link(e.a, e.b)
	list, _ := e.svc.List(ctx, e.a)
	if list[0].TasksShared || list[0].HabitsShared {
		t.Errorf("access survived the break: %+v", list[0])
	}
	list, _ = e.svc.List(ctx, e.b)
	if list[0].TasksShared {
		t.Errorf("b's access survived the break: %+v", list[0])
	}
}
