package reminder

import (
	"errors"
	"fmt"
	"testing"

	"github.com/go-telegram/bot"
)

func TestKeyboard(t *testing.T) {
	m := Message{Buttons: [][]Button{
		{{Text: "Выполнено", Callback: "done:x"}, {Text: "Не выполнено", Callback: "notdone:x"}},
		{{Text: "Открыть", OpenApp: true}},
	}}
	kb := keyboard(m, "https://app.example/")
	if kb == nil || len(kb.InlineKeyboard) != 2 || len(kb.InlineKeyboard[0]) != 2 {
		t.Fatalf("keyboard = %+v", kb)
	}
	if b := kb.InlineKeyboard[0][0]; b.CallbackData != "done:x" || b.WebApp != nil {
		t.Errorf("callback button = %+v", b)
	}
	if b := kb.InlineKeyboard[1][0]; b.WebApp == nil || b.WebApp.URL != "https://app.example/" || b.CallbackData != "" {
		t.Errorf("open button = %+v", b)
	}
}

func TestKeyboardWithoutAnAddressHasNoOpenButton(t *testing.T) {
	m := Message{Buttons: [][]Button{{{Text: "Выполнено", Callback: "done:x"}}, {{Text: "Открыть", OpenApp: true}}}}
	kb := keyboard(m, "")
	if kb == nil || len(kb.InlineKeyboard) != 1 {
		t.Fatalf("keyboard = %+v", kb)
	}
	// A message with only an "Open" button has no keyboard at all.
	if kb := keyboard(Message{Buttons: [][]Button{{{Text: "Открыть", OpenApp: true}}}}, ""); kb != nil {
		t.Errorf("keyboard = %+v, want none", kb)
	}
	if kb := keyboard(Message{Text: "x"}, "https://a"); kb != nil {
		t.Errorf("keyboard = %+v, want none", kb)
	}
}

func TestClassifyErrors(t *testing.T) {
	forbidden := fmt.Errorf("%w, Forbidden: bot was blocked by the user", bot.ErrorForbidden)
	if err := classify(forbidden); !errors.Is(err, ErrUndeliverable) {
		t.Errorf("blocked: %v", err)
	}
	notFound := fmt.Errorf("%w, Bad Request: chat not found", bot.ErrorBadRequest)
	if err := classify(notFound); !errors.Is(err, ErrUndeliverable) {
		t.Errorf("chat not found: %v", err)
	}
	// Anything else may pass: it is tried again.
	for _, err := range []error{
		errors.New("connection reset"),
		&bot.TooManyRequestsError{Message: "slow down", RetryAfter: 5},
		fmt.Errorf("%w: message is too long", bot.ErrorBadRequest),
		bot.ErrorUnauthorized,
	} {
		if got := classify(err); errors.Is(got, ErrUndeliverable) {
			t.Errorf("%v must not be final", err)
		}
	}
}
