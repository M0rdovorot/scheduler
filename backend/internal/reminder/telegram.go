package reminder

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/go-telegram/bot"
	"github.com/go-telegram/bot/models"
)

// Bot is the Telegram side: it sends the queued messages, answers /start and runs the buttons.
// It is the only code that talks to Telegram; everything it decides is in Service.
type Bot struct {
	b         *bot.Bot
	svc       *Service
	webAppURL string
	log       *slog.Logger
}

// NewBot connects to Telegram with the token. webAppURL is where the Mini App lives; without it
// the "Open" buttons are left out.
func NewBot(token, webAppURL string, svc *Service, log *slog.Logger) (*Bot, error) {
	t := &Bot{svc: svc, webAppURL: webAppURL, log: log}
	// No getMe at startup: an unreachable Telegram must not keep the API from starting.
	b, err := bot.New(token,
		bot.WithSkipGetMe(),
		bot.WithAllowedUpdates(bot.AllowedUpdates{"message", "callback_query"}),
		bot.WithErrorsHandler(func(err error) { log.Error("telegram", "err", err) }),
	)
	if err != nil {
		return nil, fmt.Errorf("create bot: %w", err)
	}
	b.RegisterHandler(bot.HandlerTypeMessageText, "/start", bot.MatchTypePrefix, t.onStart)
	b.RegisterHandler(bot.HandlerTypeCallbackQueryData, "", bot.MatchTypePrefix, t.onCallback)
	t.b = b
	return t, nil
}

// Run receives updates (long polling) until the context ends.
func (t *Bot) Run(ctx context.Context) { t.b.Start(ctx) }

// Send implements Sender.
func (t *Bot) Send(ctx context.Context, chatID int64, m Message) (int64, error) {
	params := &bot.SendMessageParams{ChatID: chatID, Text: m.Text}
	if kb := keyboard(m, t.webAppURL); kb != nil {
		params.ReplyMarkup = kb
	}
	sent, err := t.b.SendMessage(ctx, params)
	if err != nil {
		return 0, classify(err)
	}
	return int64(sent.ID), nil
}

// keyboard turns the buttons of a message into Telegram's inline keyboard. Rows that end up
// empty (an "Open" button without an address) are dropped; nil means no keyboard at all.
func keyboard(m Message, webAppURL string) *models.InlineKeyboardMarkup {
	var rows [][]models.InlineKeyboardButton
	for _, row := range m.Buttons {
		var out []models.InlineKeyboardButton
		for _, b := range row {
			switch {
			case b.OpenApp && webAppURL != "":
				out = append(out, models.InlineKeyboardButton{Text: b.Text, WebApp: &models.WebAppInfo{URL: webAppURL}})
			case !b.OpenApp:
				out = append(out, models.InlineKeyboardButton{Text: b.Text, CallbackData: b.Callback})
			}
		}
		if len(out) > 0 {
			rows = append(rows, out)
		}
	}
	if len(rows) == 0 {
		return nil
	}
	return &models.InlineKeyboardMarkup{InlineKeyboard: rows}
}

// classify tells an error that will never go away (the user blocked the bot or never started
// it) from one that may: those get ErrUndeliverable.
func classify(err error) error {
	switch {
	case errors.Is(err, bot.ErrorForbidden):
		return fmt.Errorf("%w: %w", ErrUndeliverable, err)
	case errors.Is(err, bot.ErrorBadRequest) && strings.Contains(strings.ToLower(err.Error()), "chat not found"):
		return fmt.Errorf("%w: %w", ErrUndeliverable, err)
	}
	return err
}

const startText = "Планировщик дел: план, факт и привычки в одном месте. Напоминания о делах и привычках приходят сюда."

func (t *Bot) onStart(ctx context.Context, b *bot.Bot, update *models.Update) {
	if update.Message == nil {
		return
	}
	params := &bot.SendMessageParams{ChatID: update.Message.Chat.ID, Text: startText}
	if kb := keyboard(Message{Buttons: [][]Button{{{Text: "Открыть планировщик", OpenApp: true}}}}, t.webAppURL); kb != nil {
		params.ReplyMarkup = kb
	}
	if _, err := b.SendMessage(ctx, params); err != nil {
		t.log.ErrorContext(ctx, "answer /start", "err", err)
	}
}

func (t *Bot) onCallback(ctx context.Context, b *bot.Bot, update *models.Update) {
	q := update.CallbackQuery
	if q == nil {
		return
	}
	res, err := t.svc.HandleCallback(ctx, q.From.ID, q.Data)
	if err != nil {
		t.log.ErrorContext(ctx, "button", "data", q.Data, "err", err)
		res = CallbackResult{Answer: "Не получилось, попробуйте ещё раз"}
	}
	if _, err := b.AnswerCallbackQuery(ctx, &bot.AnswerCallbackQueryParams{CallbackQueryID: q.ID, Text: res.Answer}); err != nil {
		t.log.ErrorContext(ctx, "answer button", "err", err)
	}
	// The buttons of a message that was dealt with go, and the result is written under the text.
	msg := q.Message.Message
	if res.Note == "" || msg == nil {
		return
	}
	_, err = b.EditMessageText(ctx, &bot.EditMessageTextParams{
		ChatID: msg.Chat.ID, MessageID: msg.ID, Text: msg.Text + "\n\n" + res.Note,
		ReplyMarkup: &models.InlineKeyboardMarkup{InlineKeyboard: [][]models.InlineKeyboardButton{}},
	})
	if err != nil {
		t.log.ErrorContext(ctx, "edit message", "err", err)
	}
}
