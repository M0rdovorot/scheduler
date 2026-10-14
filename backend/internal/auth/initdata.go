// Package auth verifies Telegram init data and manages sessions.
package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

var ErrInvalidInitData = errors.New("invalid init data")

// clockSkew is how far into the future auth_date may be.
const clockSkew = time.Minute

// TelegramUser is the "user" field of Mini App init data.
type TelegramUser struct {
	ID           int64  `json:"id"`
	FirstName    string `json:"first_name"`
	LastName     string `json:"last_name"`
	Username     string `json:"username"`
	LanguageCode string `json:"language_code"`
	PhotoURL     string `json:"photo_url"`
}

type InitData struct {
	User     TelegramUser
	AuthDate time.Time
}

// VerifyInitData checks the signature of the raw init data string from
// Telegram.WebApp.initData and returns the user it describes.
//
// The signature is HMAC-SHA256 over the sorted "key=value" fields (without
// hash) joined by newlines, keyed with HMAC-SHA256("WebAppData", botToken).
// Init data older than maxAge is rejected.
func VerifyInitData(raw, botToken string, maxAge time.Duration, now time.Time) (InitData, error) {
	values, err := url.ParseQuery(raw)
	if err != nil {
		return InitData{}, fmt.Errorf("%w: malformed query", ErrInvalidInitData)
	}

	gotHash, err := hex.DecodeString(values.Get("hash"))
	if err != nil || len(gotHash) != sha256.Size {
		return InitData{}, fmt.Errorf("%w: bad hash", ErrInvalidInitData)
	}

	if !hmac.Equal(gotHash, sign(dataCheckString(values), botToken)) {
		return InitData{}, fmt.Errorf("%w: signature mismatch", ErrInvalidInitData)
	}

	// The signature is valid, so the fields below were issued by Telegram.
	seconds, err := strconv.ParseInt(values.Get("auth_date"), 10, 64)
	if err != nil {
		return InitData{}, fmt.Errorf("%w: bad auth_date", ErrInvalidInitData)
	}
	authDate := time.Unix(seconds, 0).UTC()
	if age := now.Sub(authDate); age > maxAge || age < -clockSkew {
		return InitData{}, fmt.Errorf("%w: auth_date out of range", ErrInvalidInitData)
	}

	var user TelegramUser
	if err := json.Unmarshal([]byte(values.Get("user")), &user); err != nil || user.ID == 0 {
		return InitData{}, fmt.Errorf("%w: bad user", ErrInvalidInitData)
	}

	return InitData{User: user, AuthDate: authDate}, nil
}

func dataCheckString(values url.Values) string {
	pairs := make([]string, 0, len(values))
	for key, vals := range values {
		if key == "hash" {
			continue
		}
		pairs = append(pairs, key+"="+vals[0])
	}
	sort.Strings(pairs)
	return strings.Join(pairs, "\n")
}

func sign(dataCheck, botToken string) []byte {
	secret := hmac.New(sha256.New, []byte("WebAppData"))
	secret.Write([]byte(botToken))

	mac := hmac.New(sha256.New, secret.Sum(nil))
	mac.Write([]byte(dataCheck))
	return mac.Sum(nil)
}
