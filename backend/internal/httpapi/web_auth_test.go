package httpapi

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"testing"
	"time"
)

// signedWidgetData builds Login Widget fields signed like Telegram does.
func signedWidgetData(id int64, authDate time.Time) map[string]string {
	fields := map[string]string{
		"id":         fmt.Sprint(id),
		"first_name": "Ann",
		"auth_date":  fmt.Sprint(authDate.Unix()),
	}
	pairs := make([]string, 0, len(fields))
	for k, v := range fields {
		pairs = append(pairs, k+"="+v)
	}
	sort.Strings(pairs)
	secret := sha256.Sum256([]byte(botToken))
	mac := hmac.New(sha256.New, secret[:])
	mac.Write([]byte(strings.Join(pairs, "\n")))
	fields["hash"] = hex.EncodeToString(mac.Sum(nil))
	return fields
}

// send performs a request with optional extra headers and returns the recorder.
func (a *testAPI) send(method, path, body string, headers map[string]string) *httptest.ResponseRecorder {
	a.t.Helper()
	req := httptest.NewRequestWithContext(a.t.Context(), method, "/api/v1"+path, strings.NewReader(body))
	req.Host = "plan.example"
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	return rec
}

func (a *testAPI) widgetLogin(fields map[string]string, headers map[string]string) *httptest.ResponseRecorder {
	a.t.Helper()
	body, _ := json.Marshal(map[string]any{"auth_data": fields, "timezone": "Europe/Moscow"})
	return a.send("POST", "/auth/telegram-widget", string(body), headers)
}

func sessionCookieOf(t *testing.T, rec *httptest.ResponseRecorder) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookie {
			return c
		}
	}
	t.Fatalf("no session cookie in %v", rec.Header())
	return nil
}

func TestAuthConfig(t *testing.T) {
	api := newTestAPI(t, false)
	code, out := api.do("GET", "/auth/config", "", "")
	if code != http.StatusOK || out["telegram_bot_id"] != 123456.0 {
		t.Errorf("status %d, body %v", code, out)
	}
}

func TestWidgetLoginFlow(t *testing.T) {
	api := newTestAPI(t, false)

	rec := api.widgetLogin(signedWidgetData(42, time.Now()), map[string]string{"Sec-Fetch-Site": "same-origin"})
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status %d, body %s", rec.Code, rec.Body)
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["token"] != nil {
		t.Error("the token must not reach JavaScript")
	}
	c := sessionCookieOf(t, rec)
	if !c.HttpOnly || c.Path != "/api/v1" || c.SameSite != http.SameSiteLaxMode || c.Value == "" {
		t.Errorf("cookie = %+v", c)
	}
	cookie := c.Name + "=" + c.Value

	// The cookie authenticates reads, and writes from the same origin.
	if rec := api.send("GET", "/me", "", map[string]string{"Cookie": cookie}); rec.Code != http.StatusOK {
		t.Errorf("GET /me: status %d", rec.Code)
	}
	same := map[string]string{"Cookie": cookie, "Sec-Fetch-Site": "same-origin"}
	if rec := api.send("PATCH", "/me/settings", `{"slot_minutes":15}`, same); rec.Code != http.StatusOK {
		t.Errorf("same-origin PATCH: status %d, body %s", rec.Code, rec.Body)
	}

	// The Mini App's account is the same one.
	initData := signedInitData(`{"id":42,"first_name":"Ann"}`, time.Now())
	body, _ := json.Marshal(map[string]string{"init_data": initData, "timezone": "UTC"})
	_, sess := api.do("POST", "/auth/telegram", "", string(body))
	if user := sess["user"].(map[string]any); user["slot_minutes"] != 15.0 {
		t.Errorf("Mini App user = %v, want the settings changed on the web", user)
	}

	// Logout ends the session and clears the cookie.
	rec = api.send("POST", "/auth/logout", "", same)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("logout: status %d, body %s", rec.Code, rec.Body)
	}
	if c := sessionCookieOf(t, rec); c.MaxAge >= 0 {
		t.Errorf("logout cookie = %+v, want it cleared", c)
	}
	if rec := api.send("GET", "/me", "", map[string]string{"Cookie": cookie}); rec.Code != http.StatusUnauthorized {
		t.Errorf("GET /me after logout: status %d, want 401", rec.Code)
	}
}

func TestCookieSessionRejectsCrossOrigin(t *testing.T) {
	api := newTestAPI(t, false)
	rec := api.widgetLogin(signedWidgetData(42, time.Now()), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("login: status %d, body %s", rec.Code, rec.Body)
	}
	cookie := sessionCookieOf(t, rec)
	cookieHeader := cookie.Name + "=" + cookie.Value

	tests := map[string]map[string]string{
		"cross-site fetch":  {"Sec-Fetch-Site": "cross-site"},
		"same-site fetch":   {"Sec-Fetch-Site": "same-site"},
		"foreign Origin":    {"Origin": "https://evil.example"},
		"sibling subdomain": {"Origin": "https://diary.example"},
	}
	for name, headers := range tests {
		t.Run(name, func(t *testing.T) {
			headers["Cookie"] = cookieHeader
			if rec := api.send("PATCH", "/me/settings", `{"slot_minutes":15}`, headers); rec.Code != http.StatusForbidden {
				t.Errorf("PATCH: status %d, want 403", rec.Code)
			}
			delete(headers, "Cookie")
			if rec := api.widgetLogin(signedWidgetData(43, time.Now()), headers); rec.Code != http.StatusForbidden {
				t.Errorf("login: status %d, want 403", rec.Code)
			}
		})
	}

	// A bearer token is not sent by browsers on their own, so it needs no check.
	_, sess := api.do("POST", "/auth/telegram", "", func() string {
		b, _ := json.Marshal(map[string]string{
			"init_data": signedInitData(`{"id":42,"first_name":"Ann"}`, time.Now()), "timezone": "UTC",
		})
		return string(b)
	}())
	headers := map[string]string{"Authorization": "Bearer " + sess["token"].(string), "Sec-Fetch-Site": "cross-site"}
	if rec := api.send("PATCH", "/me/settings", `{"slot_minutes":15}`, headers); rec.Code != http.StatusOK {
		t.Errorf("bearer PATCH: status %d, want 200", rec.Code)
	}
}

func TestWidgetLoginRejectsBadData(t *testing.T) {
	api := newTestAPI(t, false)
	forged := signedWidgetData(42, time.Now())
	forged["id"] = "7"

	tests := map[string]map[string]string{
		"forged":  forged,
		"expired": signedWidgetData(42, time.Now().Add(-2*time.Hour)),
		"empty":   {},
	}
	for name, fields := range tests {
		t.Run(name, func(t *testing.T) {
			rec := api.widgetLogin(fields, nil)
			if rec.Code != http.StatusUnauthorized {
				t.Errorf("status %d, want 401", rec.Code)
			}
			if len(rec.Result().Cookies()) != 0 {
				t.Error("a cookie was set")
			}
		})
	}
}
