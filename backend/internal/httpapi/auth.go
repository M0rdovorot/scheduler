package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/auth"
)

// publicPaths are the endpoints that work without a session. Everything else
// requires a bearer token, so a new endpoint is protected by default. Keep it
// in sync with the operations marked `security: []` in api/openapi.yaml.
var publicPaths = map[string]bool{
	basePath + "/healthz":       true,
	basePath + "/auth/telegram": true,
	basePath + "/auth/dev":      true,
}

type ctxKey int

const userIDKey ctxKey = iota

// userID returns the authenticated user's id; it is set for all non-public routes.
func userID(ctx context.Context) uuid.UUID {
	id, _ := ctx.Value(userIDKey).(uuid.UUID)
	return id
}

func requireAuth(svc *auth.Service, log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if publicPaths[r.URL.Path] {
				next.ServeHTTP(w, r)
				return
			}

			token, ok := bearerToken(r)
			if !ok {
				writeError(w, http.StatusUnauthorized, "unauthorized", "missing or malformed bearer token")
				return
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
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, id)))
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
