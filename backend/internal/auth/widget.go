package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"time"
)

// VerifyWidgetData checks the fields the Telegram Login Widget returned and
// returns the user they describe.
//
// The data-check string is built as for Mini App init data (sorted
// "key=value" fields without hash, joined by newlines), but the key is
// SHA256(botToken) instead of HMAC-SHA256("WebAppData", botToken). Data older
// than maxAge is rejected.
func VerifyWidgetData(fields map[string]string, botToken string, maxAge time.Duration, now time.Time) (TelegramUser, error) {
	gotHash, err := hex.DecodeString(fields["hash"])
	if err != nil || len(gotHash) != sha256.Size {
		return TelegramUser{}, fmt.Errorf("%w: bad hash", ErrInvalidInitData)
	}

	pairs := make([]string, 0, len(fields))
	for _, key := range slices.Sorted(maps.Keys(fields)) {
		if key != "hash" {
			pairs = append(pairs, key+"="+fields[key])
		}
	}
	secret := sha256.Sum256([]byte(botToken))
	mac := hmac.New(sha256.New, secret[:])
	mac.Write([]byte(strings.Join(pairs, "\n")))
	if !hmac.Equal(gotHash, mac.Sum(nil)) {
		return TelegramUser{}, fmt.Errorf("%w: signature mismatch", ErrInvalidInitData)
	}

	// The signature is valid, so the fields below were issued by Telegram.
	seconds, err := strconv.ParseInt(fields["auth_date"], 10, 64)
	if err != nil {
		return TelegramUser{}, fmt.Errorf("%w: bad auth_date", ErrInvalidInitData)
	}
	if age := now.Sub(time.Unix(seconds, 0)); age > maxAge || age < -clockSkew {
		return TelegramUser{}, fmt.Errorf("%w: auth_date out of range", ErrInvalidInitData)
	}

	id, err := strconv.ParseInt(fields["id"], 10, 64)
	if err != nil || id == 0 {
		return TelegramUser{}, fmt.Errorf("%w: bad user", ErrInvalidInitData)
	}
	return TelegramUser{
		ID:        id,
		FirstName: fields["first_name"],
		LastName:  fields["last_name"],
		Username:  fields["username"],
		PhotoURL:  fields["photo_url"],
	}, nil
}

// BotID is the numeric id of the bot (the part of the token before the
// colon), which the browser needs to open the Telegram sign-in popup. It is
// 0 when there is no valid token.
func BotID(botToken string) int64 {
	prefix, _, found := strings.Cut(botToken, ":")
	if !found {
		return 0
	}
	id, err := strconv.ParseInt(prefix, 10, 64)
	if err != nil || id <= 0 {
		return 0
	}
	return id
}
