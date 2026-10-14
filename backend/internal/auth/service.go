package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	providerTelegram = "telegram"
	providerDev      = "dev"

	defaultDisplayName = "Пользователь"
	maxDevKeyLen       = 64 // characters
	maxDevNameLen      = 100

	// touchInterval limits how often last_used_at is written, so that
	// authenticating a request is normally a plain read.
	touchInterval = time.Hour
)

var (
	ErrUnauthorized    = errors.New("unauthorized")
	ErrDevAuthDisabled = errors.New("dev auth is disabled")
)

type Config struct {
	BotToken       string
	DevAuth        bool
	SessionTTL     time.Duration
	InitDataMaxAge time.Duration
}

// Session is a freshly issued session. Token is shown to the client once;
// only its hash is stored.
type Session struct {
	Token     string
	ExpiresAt time.Time
	User      user.User
}

type Service struct {
	store *store.Store
	cfg   Config
	now   func() time.Time
}

func NewService(s *store.Store, cfg Config) *Service {
	return &Service{store: s, cfg: cfg, now: time.Now}
}

// LoginTelegram signs a user in with Mini App init data. timezone (from the
// device) is used only when the account is created.
func (s *Service) LoginTelegram(ctx context.Context, initData, timezone string) (Session, error) {
	data, err := VerifyInitData(initData, s.cfg.BotToken, s.cfg.InitDataMaxAge, s.now())
	if err != nil {
		return Session{}, err
	}
	u := data.User
	return s.login(ctx, identity{
		provider:     providerTelegram,
		providerID:   strconv.FormatInt(u.ID, 10),
		displayName:  telegramDisplayName(u),
		username:     nonEmpty(u.Username),
		firstName:    nonEmpty(u.FirstName),
		lastName:     nonEmpty(u.LastName),
		photoURL:     nonEmpty(u.PhotoURL),
		languageCode: nonEmpty(u.LanguageCode),
	}, timezone)
}

// LoginDev signs in without Telegram. Available only when DEV_AUTH is on.
// Each key is a separate dev user.
func (s *Service) LoginDev(ctx context.Context, key, displayName, timezone string) (Session, error) {
	if !s.cfg.DevAuth {
		return Session{}, ErrDevAuthDisabled
	}
	if key == "" {
		key = "dev"
	}
	if !validation.ValidText(key) {
		return Session{}, &validation.Error{Field: "key", Message: "contains invalid characters"}
	}
	if !validation.ValidText(displayName) {
		return Session{}, &validation.Error{Field: "display_name", Message: "contains invalid characters"}
	}
	if utf8.RuneCountInString(key) > maxDevKeyLen {
		return Session{}, &validation.Error{Field: "key", Message: "too long"}
	}
	if utf8.RuneCountInString(displayName) > maxDevNameLen {
		return Session{}, &validation.Error{Field: "display_name", Message: "too long"}
	}
	if displayName == "" {
		displayName = "Dev " + key
	}
	return s.login(ctx, identity{provider: providerDev, providerID: key, displayName: displayName}, timezone)
}

// Authenticate resolves a bearer token to a user id.
func (s *Service) Authenticate(ctx context.Context, token string) (uuid.UUID, error) {
	now := s.now()
	sess, err := s.store.GetActiveSession(ctx, store.GetActiveSessionParams{
		TokenHash: hashToken(token),
		Now:       now,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return uuid.Nil, ErrUnauthorized
	}
	if err != nil {
		return uuid.Nil, fmt.Errorf("get session: %w", err)
	}
	if now.Sub(sess.LastUsedAt) >= touchInterval {
		// Best effort: failing to record usage must not fail the request.
		_ = s.store.TouchSession(ctx, store.TouchSessionParams{ID: sess.ID, LastUsedAt: now})
	}
	return sess.UserID, nil
}

type identity struct {
	provider, providerID, displayName                     string
	username, firstName, lastName, photoURL, languageCode *string
}

func (s *Service) login(ctx context.Context, ident identity, timezone string) (Session, error) {
	// Two first logins of the same person can race on the identity's unique
	// key; the loser retries and finds the winner's row.
	for attempt := 0; ; attempt++ {
		sess, err := s.loginOnce(ctx, ident, timezone)
		if attempt == 0 && isUniqueViolation(err) {
			continue
		}
		return sess, err
	}
}

func (s *Service) loginOnce(ctx context.Context, ident identity, timezone string) (Session, error) {
	token, err := newToken()
	if err != nil {
		return Session{}, err
	}
	now := s.now()
	expiresAt := now.Add(s.cfg.SessionTTL)

	var u store.User
	err = s.store.InTx(ctx, func(q *store.Queries) error {
		existing, err := q.GetIdentity(ctx, store.GetIdentityParams{
			Provider: ident.provider, ProviderUserID: ident.providerID,
		})
		switch {
		case err == nil:
			if u, err = q.GetUser(ctx, existing.UserID); err != nil {
				return fmt.Errorf("get user: %w", err)
			}
			err = q.UpdateIdentityProfile(ctx, store.UpdateIdentityProfileParams{
				ID: existing.ID, Username: ident.username, FirstName: ident.firstName,
				LastName: ident.lastName, PhotoUrl: ident.photoURL, LanguageCode: ident.languageCode,
			})
			if err != nil {
				return fmt.Errorf("update identity: %w", err)
			}
			// Telegram is the source of truth for the name until users can edit it.
			if ident.provider == providerTelegram && u.DisplayName != ident.displayName {
				if err := q.UpdateUserDisplayName(ctx, store.UpdateUserDisplayNameParams{
					ID: u.ID, DisplayName: ident.displayName,
				}); err != nil {
					return fmt.Errorf("update display name: %w", err)
				}
				u.DisplayName = ident.displayName
			}
		case errors.Is(err, pgx.ErrNoRows):
			if err := user.ValidateTimezone(timezone); err != nil {
				return err
			}
			if u, err = q.CreateUser(ctx, store.CreateUserParams{
				DisplayName: ident.displayName, Timezone: timezone,
			}); err != nil {
				return fmt.Errorf("create user: %w", err)
			}
			err = q.CreateIdentity(ctx, store.CreateIdentityParams{
				UserID: u.ID, Provider: ident.provider, ProviderUserID: ident.providerID,
				Username: ident.username, FirstName: ident.firstName, LastName: ident.lastName,
				PhotoUrl: ident.photoURL, LanguageCode: ident.languageCode,
			})
			if err != nil {
				return fmt.Errorf("create identity: %w", err)
			}
		default:
			return fmt.Errorf("get identity: %w", err)
		}

		if err := q.CreateSession(ctx, store.CreateSessionParams{
			UserID: u.ID, TokenHash: hashToken(token), ExpiresAt: expiresAt,
		}); err != nil {
			return fmt.Errorf("create session: %w", err)
		}
		if err := q.DeleteExpiredSessions(ctx, now); err != nil {
			return fmt.Errorf("delete expired sessions: %w", err)
		}
		return nil
	})
	if err != nil {
		return Session{}, err
	}
	return Session{Token: token, ExpiresAt: expiresAt, User: user.FromRow(u)}, nil
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}

func telegramDisplayName(u TelegramUser) string {
	if name := strings.TrimSpace(u.FirstName + " " + u.LastName); name != "" {
		return name
	}
	if u.Username != "" {
		return u.Username
	}
	return defaultDisplayName
}

func nonEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func isUniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}
