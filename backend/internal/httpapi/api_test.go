package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/m0rdovorot/scheduler/backend/internal/auth"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

const botToken = "123456:TEST-TOKEN"

type testAPI struct {
	t       *testing.T
	handler http.Handler
}

func newTestAPI(t *testing.T, devAuth bool) *testAPI {
	t.Helper()
	st := store.NewStore(testutil.NewDB(t, migrations.FS))
	srv := NewServer(Deps{
		DB: st,
		Auth: auth.NewService(st, auth.Config{
			BotToken: botToken, DevAuth: devAuth,
			SessionTTL: time.Hour, InitDataMaxAge: time.Hour,
		}),
		Users: user.NewService(st),
	})
	return &testAPI{t: t, handler: NewRouter(srv, slog.New(slog.NewTextHandler(io.Discard, nil)))}
}

// do sends a JSON request and returns the status and decoded JSON body.
func (a *testAPI) do(method, path, token, body string) (int, map[string]any) {
	a.t.Helper()
	req := httptest.NewRequestWithContext(a.t.Context(), method, "/api/v1"+path, strings.NewReader(body))
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)

	var out map[string]any
	if rec.Body.Len() > 0 {
		if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
			a.t.Fatalf("%s %s: response is not JSON: %q", method, path, rec.Body.String())
		}
	}
	return rec.Code, out
}

func (a *testAPI) devLogin(key string) string {
	a.t.Helper()
	code, out := a.do("POST", "/auth/dev", "", fmt.Sprintf(`{"key":%q,"timezone":"Europe/Moscow"}`, key))
	if code != http.StatusOK {
		a.t.Fatalf("dev login: status %d, body %v", code, out)
	}
	return out["token"].(string)
}

// signedInitData builds init data signed like Telegram does.
func signedInitData(userJSON string, authDate time.Time) string {
	fields := map[string]string{
		"user":      userJSON,
		"auth_date": fmt.Sprint(authDate.Unix()),
	}
	pairs := make([]string, 0, len(fields))
	for k, v := range fields {
		pairs = append(pairs, k+"="+v)
	}
	sort.Strings(pairs)

	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte(botToken))
	mac := hmac.New(sha256.New, secret.Sum(nil))
	mac.Write([]byte(strings.Join(pairs, "\n")))

	v := url.Values{}
	for k, val := range fields {
		v.Set(k, val)
	}
	v.Set("hash", hex.EncodeToString(mac.Sum(nil)))
	return v.Encode()
}

func TestProtectedEndpointsRequireSession(t *testing.T) {
	api := newTestAPI(t, true)

	tests := []struct{ method, path, body string }{
		{"GET", "/me", ""},
		{"PATCH", "/me/settings", `{"slot_minutes":15}`},
		{"GET", "/no-such-endpoint", ""}, // unknown routes fail closed too
	}
	for _, tt := range tests {
		for _, header := range []string{"", "Bearer", "Bearer not-a-session", "Basic abc"} {
			req := httptest.NewRequestWithContext(t.Context(), tt.method, "/api/v1"+tt.path, strings.NewReader(tt.body))
			if header != "" {
				req.Header.Set("Authorization", header)
			}
			rec := httptest.NewRecorder()
			api.handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("%s %s with %q: status %d, want 401", tt.method, tt.path, header, rec.Code)
			}
		}
	}
}

func TestTelegramLoginFlow(t *testing.T) {
	api := newTestAPI(t, false)
	initData := signedInitData(`{"id":42,"first_name":"Ann","username":"ann"}`, time.Now())

	body, _ := json.Marshal(map[string]string{"init_data": initData, "timezone": "Europe/Moscow"})
	code, out := api.do("POST", "/auth/telegram", "", string(body))
	if code != http.StatusOK {
		t.Fatalf("login: status %d, body %v", code, out)
	}
	token := out["token"].(string)
	if token == "" || out["expires_at"] == "" {
		t.Fatalf("session = %v", out)
	}

	code, me := api.do("GET", "/me", token, "")
	if code != http.StatusOK {
		t.Fatalf("GET /me: status %d, body %v", code, me)
	}
	want := map[string]any{
		"display_name": "Ann", "timezone": "Europe/Moscow",
		"slot_minutes": 30.0, "default_view": "day", "deviation_threshold_minutes": 10.0,
	}
	for k, v := range want {
		if me[k] != v {
			t.Errorf("me[%q] = %v, want %v", k, me[k], v)
		}
	}
}

func TestTelegramLoginRejectsBadInitData(t *testing.T) {
	api := newTestAPI(t, false)

	tests := []struct {
		name     string
		initData string
		timezone string
		want     int
	}{
		{"garbage", "garbage", "UTC", http.StatusUnauthorized},
		{"expired", signedInitData(`{"id":42,"first_name":"Ann"}`, time.Now().Add(-2*time.Hour)), "UTC", http.StatusUnauthorized},
		{"bad timezone", signedInitData(`{"id":42,"first_name":"Ann"}`, time.Now()), "Mars/Olympus", http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, _ := json.Marshal(map[string]string{"init_data": tt.initData, "timezone": tt.timezone})
			code, out := api.do("POST", "/auth/telegram", "", string(body))
			if code != tt.want {
				t.Errorf("status = %d (%v), want %d", code, out, tt.want)
			}
			if out["token"] != nil {
				t.Error("a token was issued")
			}
		})
	}

	if code, _ := api.do("POST", "/auth/telegram", "", `{not json`); code != http.StatusBadRequest {
		t.Errorf("malformed JSON: status %d, want 400", code)
	}
}

func TestDevLoginDisabled(t *testing.T) {
	api := newTestAPI(t, false)
	code, _ := api.do("POST", "/auth/dev", "", `{"timezone":"UTC"}`)
	if code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 when DEV_AUTH is off", code)
	}
}

func TestSettingsFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")

	code, out := api.do("PATCH", "/me/settings", token,
		`{"slot_minutes":15,"default_view":"week","deviation_threshold_minutes":0,"timezone":"Asia/Tokyo"}`)
	if code != http.StatusOK {
		t.Fatalf("PATCH: status %d, body %v", code, out)
	}
	_, me := api.do("GET", "/me", token, "")
	for k, v := range map[string]any{
		"slot_minutes": 15.0, "default_view": "week", "deviation_threshold_minutes": 0.0, "timezone": "Asia/Tokyo",
	} {
		if me[k] != v {
			t.Errorf("me[%q] = %v, want %v", k, me[k], v)
		}
	}

	// Partial update leaves the rest alone.
	api.do("PATCH", "/me/settings", token, `{"slot_minutes":60}`)
	_, me = api.do("GET", "/me", token, "")
	if me["slot_minutes"] != 60.0 || me["default_view"] != "week" {
		t.Errorf("after partial patch: %v", me)
	}

	invalid := []string{
		`{"slot_minutes":20}`,
		`{"default_view":"month"}`,
		`{"deviation_threshold_minutes":-5}`,
		`{"timezone":"Nowhere/Land"}`,
		`{"slot_minutes":"15"}`,
	}
	for _, body := range invalid {
		if code, out := api.do("PATCH", "/me/settings", token, body); code != http.StatusBadRequest {
			t.Errorf("PATCH %s: status %d (%v), want 400", body, code, out)
		}
	}
	_, me = api.do("GET", "/me", token, "")
	if me["slot_minutes"] != 60.0 {
		t.Errorf("invalid patches changed settings: %v", me)
	}
}

func TestUsersAreIsolated(t *testing.T) {
	api := newTestAPI(t, true)
	tokenA, tokenB := api.devLogin("a"), api.devLogin("b")

	api.do("PATCH", "/me/settings", tokenA, `{"slot_minutes":5}`)

	_, meA := api.do("GET", "/me", tokenA, "")
	_, meB := api.do("GET", "/me", tokenB, "")
	if meA["id"] == meB["id"] {
		t.Fatal("two dev keys resolved to one user")
	}
	if meB["slot_minutes"] != 30.0 {
		t.Errorf("user B slot_minutes = %v, want the default 30", meB["slot_minutes"])
	}
}
