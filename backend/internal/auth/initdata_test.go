package auth

import (
	"errors"
	"net/url"
	"strings"
	"testing"
	"time"
)

// Reference vector computed independently with Python's hmac/hashlib:
// bot token "123456:TEST-TOKEN", auth_date 1760000000 (2025-10-09T08:53:20Z).
const (
	testBotToken = "123456:TEST-TOKEN"
	testInitData = "query_id=AAHdF6IQAAAAAN0XohDhrOrc&user=%7B%22id%22%3A279058397%2C%22first_name%22%3A%22Ann%22%2C%22last_name%22%3A%22Lee%22%2C%22username%22%3A%22ann_lee%22%2C%22language_code%22%3A%22ru%22%2C%22photo_url%22%3A%22https%3A%2F%2Ft.me%2Fi%2Fuserpic%2F320%2Fann.jpg%22%7D&auth_date=1760000000&signature=c2lnbmF0dXJl&hash=c9f0a1e242186fdf743585faf7d238b78626a7bdf613c3c6fb6c62565f7cb603"
)

var testAuthDate = time.Unix(1760000000, 0).UTC()

func TestVerifyInitData(t *testing.T) {
	got, err := VerifyInitData(testInitData, testBotToken, 24*time.Hour, testAuthDate.Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	want := TelegramUser{
		ID: 279058397, FirstName: "Ann", LastName: "Lee", Username: "ann_lee",
		LanguageCode: "ru", PhotoURL: "https://t.me/i/userpic/320/ann.jpg",
	}
	if got.User != want {
		t.Errorf("user = %+v, want %+v", got.User, want)
	}
	if !got.AuthDate.Equal(testAuthDate) {
		t.Errorf("AuthDate = %v, want %v", got.AuthDate, testAuthDate)
	}
}

func TestVerifyInitDataRejects(t *testing.T) {
	const maxAge = 24 * time.Hour
	now := testAuthDate.Add(time.Hour)

	replaceParam := func(key, value string) string {
		v, _ := url.ParseQuery(testInitData)
		v.Set(key, value)
		return v.Encode()
	}
	dropParam := func(key string) string {
		v, _ := url.ParseQuery(testInitData)
		v.Del(key)
		return v.Encode()
	}

	tests := []struct {
		name  string
		raw   string
		token string
		now   time.Time
	}{
		{"wrong bot token", testInitData, "123456:OTHER", now},
		{"tampered user", replaceParam("user", `{"id":1,"first_name":"Eve"}`), testBotToken, now},
		{"tampered auth_date", replaceParam("auth_date", "1760000001"), testBotToken, now},
		{"extra field", testInitData + "&extra=1", testBotToken, now},
		{"missing hash", dropParam("hash"), testBotToken, now},
		{"short hash", replaceParam("hash", "abcd"), testBotToken, now},
		{"non-hex hash", replaceParam("hash", strings.Repeat("z", 64)), testBotToken, now},
		{"empty", "", testBotToken, now},
		{"expired", testInitData, testBotToken, testAuthDate.Add(maxAge + time.Second)},
		{"from the future", testInitData, testBotToken, testAuthDate.Add(-2 * time.Minute)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := VerifyInitData(tt.raw, tt.token, maxAge, tt.now)
			if !errors.Is(err, ErrInvalidInitData) {
				t.Errorf("err = %v, want ErrInvalidInitData", err)
			}
		})
	}
}

func TestVerifyInitDataAgeBoundary(t *testing.T) {
	const maxAge = 24 * time.Hour
	if _, err := VerifyInitData(testInitData, testBotToken, maxAge, testAuthDate.Add(maxAge)); err != nil {
		t.Errorf("exactly maxAge old should pass: %v", err)
	}
	if _, err := VerifyInitData(testInitData, testBotToken, maxAge, testAuthDate.Add(-30*time.Second)); err != nil {
		t.Errorf("small clock skew should pass: %v", err)
	}
}
