package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/auth"
)

// publicPaths are the endpoints that work without a session. Everything else
// requires a session, so a new endpoint is protected by default. Keep it in
// sync with the operations marked `security: []` in api/openapi.yaml.
var publicPaths = map[string]bool{
	basePath + "/healthz":              true,
	basePath + "/auth/config":          true,
	basePath + "/auth/telegram":        true,
	basePath + "/auth/telegram-widget": true,
	basePath + "/auth/dev":             true,
}

// sessionCookie holds the session token of the web version. The Mini App
// sends a bearer token instead.
const sessionCookie = "session"

type ctxKey int

const (
	userIDKey ctxKey = iota
	tokenKey
)

// sessionToken returns the token the current request was authenticated with.
func sessionToken(ctx context.Context) string {
	token, _ := ctx.Value(tokenKey).(string)
	return token
}

// userID returns the authenticated user's id; it is set for all non-public routes.
func userID(ctx context.Context) uuid.UUID {
	id, _ := ctx.Value(userIDKey).(uuid.UUID)
	return id
}

func requireAuth(svc *auth.Service, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == basePath+"/auth/telegram-widget" && !sameOrigin(w, r) {
				return
			}
			if publicPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}

			token, ok := bearerToken(r)
			if !ok {
				cookie, err := r.Cookie(sessionCookie)
				if err != nil || cookie.Value == "" {
					writeError(w, http.StatusUnauthorized, "unauthorized", "missing or malformed bearer token")
					return
				}
				// Browsers attach cookies to requests from other sites too.
				if !sameOrigin(w, r) {
					return
				}
				token = cookie.Value
			}
			id, err := svc.Authenticate(r.Context(), token)
			if errors.Is(err, auth.ErrUnauthorized) {
				writeError(w, http.StatusUnauthorized, "unauthorized", "invalid or expired session")
				return
			}
			if err != nil {
				log.ErrorContext(r.Context(), "authenticate", "err", err)
				writeError(w, http.StatusInternalServerError, "internal", "internal server error")
				return
			}
			ctx := context.WithValue(r.Context(), userIDKey, id)
			ctx = context.WithValue(ctx, tokenKey, token)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func bearerToken(r *http.Request) (string, bool) {
	scheme, token, found := strings.Cut(r.Header.Get("Authorization"), " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || token == "" {
		return "", false
	}
	return strings.TrimSpace(token), true
}

var crossOrigin = http.NewCrossOriginProtection()

// sameOrigin rejects unsafe requests sent by another site (CSRF); it writes
// the error itself.
func sameOrigin(w http.ResponseWriter, r *http.Request) bool {
	if err := crossOrigin.Check(r); err != nil {
		writeError(w, http.StatusForbidden, "cross_origin", "cross-origin request rejected")
		return false
	}
	return true
}

// sessionCookieHeader sets the session cookie, or clears it when token is empty.
func sessionCookieHeader(token string, expires time.Time, secure bool) string {
	c := http.Cookie{
		Name:     sessionCookie,
		Value:    token,
		Path:     basePath,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
	}
	if token == "" {
		c.MaxAge = -1
	} else {
		c.Expires = expires
	}
	return c.String()
}
