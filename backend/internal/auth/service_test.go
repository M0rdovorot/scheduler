package auth

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

func newTestService(t *testing.T, cfg Config) (*Service, *pgxpool.Pool) {
	t.Helper()
	pool := testutil.NewDB(t, migrations.FS)
	st := store.NewStore(pool)
	if cfg.SessionTTL == 0 {
		cfg.SessionTTL = time.Hour
	}
	if cfg.InitDataMaxAge == 0 {
		cfg.InitDataMaxAge = 24 * time.Hour
	}
	svc := NewService(st, cfg)
	svc.now = func() time.Time { return testAuthDate.Add(time.Hour) }
	return svc, pool
}

func countRows(t *testing.T, pool *pgxpool.Pool, table string) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), "SELECT count(*) FROM "+table).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestLoginTelegramCreatesAndReusesUser(t *testing.T) {
	svc, pool := newTestService(t, Config{BotToken: testBotToken})
	ctx := context.Background()

	first, err := svc.LoginTelegram(ctx, testInitData, "Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	if first.User.DisplayName != "Ann Lee" || first.User.Timezone != "Europe/Moscow" {
		t.Errorf("user = %+v", first.User)
	}
	if first.User.SlotMinutes != 30 || first.User.DefaultView != "day" || first.User.DeviationThresholdMinutes != 10 {
		t.Errorf("default settings = %+v", first.User)
	}
	if want := svc.now().Add(time.Hour); !first.ExpiresAt.Equal(want) {
		t.Errorf("ExpiresAt = %v, want %v", first.ExpiresAt, want)
	}

	// Second sign-in: same user, the device timezone no longer overrides settings.
	second, err := svc.LoginTelegram(ctx, testInitData, "Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	if second.User.ID != first.User.ID || second.User.Timezone != "Europe/Moscow" {
		t.Errorf("second login user = %+v, want same id and timezone", second.User)
	}
	if second.Token == first.Token {
		t.Error("each login must issue a new token")
	}
	if n := countRows(t, pool, "users"); n != 1 {
		t.Errorf("users = %d, want 1", n)
	}
	if n := countRows(t, pool, "user_identities"); n != 1 {
		t.Errorf("identities = %d, want 1", n)
	}
	if n := countRows(t, pool, "sessions"); n != 2 {
		t.Errorf("sessions = %d, want 2", n)
	}
}

func TestLoginTelegramRejects(t *testing.T) {
	svc, pool := newTestService(t, Config{BotToken: "123456:OTHER"})
	ctx := context.Background()

	if _, err := svc.LoginTelegram(ctx, testInitData, "UTC"); !errors.Is(err, ErrInvalidInitData) {
		t.Errorf("wrong token: err = %v, want ErrInvalidInitData", err)
	}

	svc.cfg.BotToken = testBotToken
	var verr *user.ValidationError
	if _, err := svc.LoginTelegram(ctx, testInitData, "Mars/Olympus"); !errors.As(err, &verr) {
		t.Errorf("bad timezone: err = %v, want ValidationError", err)
	}
	if n := countRows(t, pool, "users"); n != 0 {
		t.Errorf("users = %d after rejected logins, want 0", n)
	}
}

func TestLoginTelegramConcurrentFirstLogin(t *testing.T) {
	svc, pool := newTestService(t, Config{BotToken: testBotToken})

	const n = 5
	var wg sync.WaitGroup
	errs := make([]error, n)
	for i := range n {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, errs[i] = svc.LoginTelegram(context.Background(), testInitData, "UTC")
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Errorf("login %d: %v", i, err)
		}
	}
	if got := countRows(t, pool, "users"); got != 1 {
		t.Errorf("users = %d, want 1", got)
	}
}

func TestLoginDev(t *testing.T) {
	ctx := context.Background()

	t.Run("disabled", func(t *testing.T) {
		svc, _ := newTestService(t, Config{})
		if _, err := svc.LoginDev(ctx, "", "", "UTC"); !errors.Is(err, ErrDevAuthDisabled) {
			t.Errorf("err = %v, want ErrDevAuthDisabled", err)
		}
	})

	t.Run("enabled", func(t *testing.T) {
		svc, _ := newTestService(t, Config{DevAuth: true})
		a, err := svc.LoginDev(ctx, "", "", "UTC")
		if err != nil {
			t.Fatal(err)
		}
		a2, _ := svc.LoginDev(ctx, "dev", "", "UTC")
		b, err := svc.LoginDev(ctx, "other", "Bob", "UTC")
		if err != nil {
			t.Fatal(err)
		}
		if a.User.ID != a2.User.ID || a.User.ID == b.User.ID {
			t.Errorf("ids: a=%v a2=%v b=%v; same key must reuse the user, different keys must not", a.User.ID, a2.User.ID, b.User.ID)
		}
		if a.User.DisplayName != "Dev dev" || b.User.DisplayName != "Bob" {
			t.Errorf("names = %q, %q", a.User.DisplayName, b.User.DisplayName)
		}

		var verr *user.ValidationError
		long := string(make([]byte, 65))
		if _, err := svc.LoginDev(ctx, long, "", "UTC"); !errors.As(err, &verr) {
			t.Errorf("long key: err = %v, want ValidationError", err)
		}
	})
}

func TestAuthenticate(t *testing.T) {
	svc, pool := newTestService(t, Config{DevAuth: true})
	ctx := context.Background()

	sess, err := svc.LoginDev(ctx, "", "", "UTC")
	if err != nil {
		t.Fatal(err)
	}

	id, err := svc.Authenticate(ctx, sess.Token)
	if err != nil || id != sess.User.ID {
		t.Fatalf("Authenticate = %v, %v; want %v", id, err, sess.User.ID)
	}

	if _, err := svc.Authenticate(ctx, "unknown-token"); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("unknown token: err = %v, want ErrUnauthorized", err)
	}
	if _, err := svc.Authenticate(ctx, ""); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("empty token: err = %v, want ErrUnauthorized", err)
	}

	// The token itself is never stored.
	var stored int
	err = pool.QueryRow(ctx, "SELECT count(*) FROM sessions WHERE token_hash = convert_to($1, 'UTF8')", sess.Token).Scan(&stored)
	if err != nil || stored != 0 {
		t.Errorf("plain token found in sessions: n=%d err=%v", stored, err)
	}

	// Expiry: exactly at expires_at the session is already invalid.
	svc.now = func() time.Time { return sess.ExpiresAt }
	if _, err := svc.Authenticate(ctx, sess.Token); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("expired token: err = %v, want ErrUnauthorized", err)
	}
	svc.now = func() time.Time { return sess.ExpiresAt.Add(-time.Second) }
	if _, err := svc.Authenticate(ctx, sess.Token); err != nil {
		t.Errorf("token one second before expiry: %v", err)
	}
}

func TestLoginRemovesExpiredSessions(t *testing.T) {
	svc, pool := newTestService(t, Config{DevAuth: true})
	ctx := context.Background()

	old, err := svc.LoginDev(ctx, "old", "", "UTC")
	if err != nil {
		t.Fatal(err)
	}
	svc.now = func() time.Time { return old.ExpiresAt.Add(time.Minute) }
	if _, err := svc.LoginDev(ctx, "new", "", "UTC"); err != nil {
		t.Fatal(err)
	}
	if n := countRows(t, pool, "sessions"); n != 1 {
		t.Errorf("sessions = %d, want only the new one", n)
	}
}
