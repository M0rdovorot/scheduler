package auth

import (
	"context"
	"errors"
	"maps"
	"testing"
	"time"
)

// Reference vector computed independently with Python's hmac/hashlib,
// same bot token and auth_date as testInitData.
func testWidgetData() map[string]string {
	return map[string]string{
		"id":         "279058397",
		"first_name": "Ann",
		"last_name":  "Lee",
		"username":   "ann_lee",
		"photo_url":  "https://t.me/i/userpic/320/ann.jpg",
		"auth_date":  "1760000000",
		"hash":       "2769e95a447316dfc2cdee599e6f59328e690bb029a11d3b32f948102858cf8d",
	}
}

func TestVerifyWidgetData(t *testing.T) {
	got, err := VerifyWidgetData(testWidgetData(), testBotToken, 24*time.Hour, testAuthDate.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := TelegramUser{
		ID: 279058397, FirstName: "Ann", LastName: "Lee", Username: "ann_lee",
		PhotoURL: "https://t.me/i/userpic/320/ann.jpg",
	}
	if got != want {
		t.Errorf("user = %+v, want %+v", got, want)
	}
}

func TestVerifyWidgetDataRejects(t *testing.T) {
	const maxAge = 24 * time.Hour
	now := testAuthDate.Add(time.Hour)
	with := func(key, value string) map[string]string {
		f := maps.Clone(testWidgetData())
		f[key] = value
		return f
	}
	without := func(key string) map[string]string {
		f := maps.Clone(testWidgetData())
		delete(f, key)
		return f
	}

	tests := []struct {
		name   string
		fields map[string]string
		token  string
		now    time.Time
	}{
		{"wrong bot token", testWidgetData(), "123456:OTHER", now},
		{"tampered field", with("id", "1"), testBotToken, now},
		{"added field", with("extra", "x"), testBotToken, now},
		{"dropped field", without("username"), testBotToken, now},
		{"no hash", without("hash"), testBotToken, now},
		{"malformed hash", with("hash", "zz"), testBotToken, now},
		{"expired", testWidgetData(), testBotToken, testAuthDate.Add(maxAge + time.Second)},
		{"from the future", testWidgetData(), testBotToken, testAuthDate.Add(-2 * clockSkew)},
		{"empty", map[string]string{}, testBotToken, now},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := VerifyWidgetData(tt.fields, tt.token, maxAge, tt.now)
			if !errors.Is(err, ErrInvalidInitData) {
				t.Errorf("err = %v, want ErrInvalidInitData", err)
			}
		})
	}
}

func TestBotID(t *testing.T) {
	tests := map[string]int64{
		"123456:TEST-TOKEN": 123456,
		"":                  0,
		"no-colon":          0,
		"abc:def":           0,
		"-5:x":              0,
	}
	for token, want := range tests {
		if got := BotID(token); got != want {
			t.Errorf("BotID(%q) = %d, want %d", token, got, want)
		}
	}
}

func TestLoginTelegramWidgetIsTheMiniAppAccount(t *testing.T) {
	svc, pool := newTestService(t, Config{BotToken: testBotToken})
	ctx := context.Background()

	app, err := svc.LoginTelegram(ctx, testInitData, "Europe/Moscow")
	if err != nil {
		t.Fatal(err)
	}
	web, err := svc.LoginTelegramWidget(ctx, testWidgetData(), "Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	if web.User.ID != app.User.ID {
		t.Errorf("widget user %v, Mini App user %v: want the same account", web.User.ID, app.User.ID)
	}
	if web.User.Timezone != "Europe/Moscow" {
		t.Errorf("timezone = %q: an existing account keeps its own", web.User.Timezone)
	}
	if n := countRows(t, pool, "user_identities"); n != 1 {
		t.Errorf("identities = %d, want 1", n)
	}
	var lang *string
	if err := pool.QueryRow(ctx, "SELECT language_code FROM user_identities").Scan(&lang); err != nil {
		t.Fatal(err)
	}
	if lang == nil || *lang != "ru" {
		t.Errorf("language_code = %v: the widget does not report it, the stored one must stay", lang)
	}
}

func TestLoginTelegramWidgetNeedsBotToken(t *testing.T) {
	svc, _ := newTestService(t, Config{DevAuth: true})
	if _, err := svc.LoginTelegramWidget(context.Background(), testWidgetData(), "UTC"); !errors.Is(err, ErrInvalidInitData) {
		t.Errorf("err = %v, want ErrInvalidInitData", err)
	}
}

func TestLogout(t *testing.T) {
	svc, _ := newTestService(t, Config{BotToken: testBotToken})
	ctx := context.Background()

	sess, err := svc.LoginTelegramWidget(ctx, testWidgetData(), "UTC")
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.Logout(ctx, sess.Token); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.Authenticate(ctx, sess.Token); !errors.Is(err, ErrUnauthorized) {
		t.Errorf("after logout: err = %v, want ErrUnauthorized", err)
	}
	if err := svc.Logout(ctx, "unknown"); err != nil {
		t.Errorf("unknown token: %v", err)
	}
}
