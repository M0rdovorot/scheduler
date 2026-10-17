// Package httpapi wires the generated OpenAPI server to the service layer.
package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"

	"github.com/m0rdovorot/scheduler/backend/internal/auth"
	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/reminder"
	"github.com/m0rdovorot/scheduler/backend/internal/stats"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	basePath = "/api/v1"

	maxBodyBytes = 1 << 20
)

// Pinger reports whether the database is reachable.
type Pinger interface {
	Ping(ctx context.Context) error
}

// Deps are the services the API needs.
type Deps struct {
	DB         Pinger
	Auth       *auth.Service
	Users      *user.Service
	Categories *category.Service
	Tasks      *task.Service
	Stats      *stats.Service
	Habits     *habit.Service
	Reminders  *reminder.Service
}

// Server implements StrictServerInterface.
type Server struct {
	Deps
}

var _ StrictServerInterface = (*Server)(nil)

func NewServer(deps Deps) *Server {
	return &Server{Deps: deps}
}

// NewRouter builds the HTTP handler for the whole API.
func NewRouter(srv *Server, log *slog.Logger) http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(requestLogger(log))
	r.Use(middleware.Recoverer)
	r.Use(limitBody)
	r.Use(requireAuth(srv.Auth, log))

	strict := NewStrictHandlerWithOptions(srv, nil, StrictHTTPServerOptions{
		RequestErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				writeError(w, http.StatusRequestEntityTooLarge, "body_too_large", "request body is too large")
				return
			}
			log.DebugContext(r.Context(), "bad request", "err", err)
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request body")
		},
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			log.ErrorContext(r.Context(), "handler error", "err", err)
			writeError(w, http.StatusInternalServerError, "internal", "internal server error")
		},
	})
	return HandlerWithOptions(strict, ChiServerOptions{
		BaseURL:    basePath,
		BaseRouter: r,
		// Malformed path or query parameters.
		ErrorHandlerFunc: func(w http.ResponseWriter, _ *http.Request, _ error) {
			writeError(w, http.StatusBadRequest, "bad_request", "invalid request parameters")
		},
	})
}

func (s *Server) GetHealth(ctx context.Context, _ GetHealthRequestObject) (GetHealthResponseObject, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := s.DB.Ping(ctx); err != nil {
		return GetHealth503JSONResponse{Status: Unavailable}, nil
	}
	return GetHealth200JSONResponse{Status: Ok}, nil
}

func (s *Server) LoginTelegram(ctx context.Context, req LoginTelegramRequestObject) (LoginTelegramResponseObject, error) {
	sess, err := s.Auth.LoginTelegram(ctx, req.Body.InitData, req.Body.Timezone)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return LoginTelegram400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, auth.ErrInvalidInitData):
		return LoginTelegram401JSONResponse{UnauthorizedJSONResponse{
			Code: "invalid_init_data", Message: "invalid or expired Telegram init data",
		}}, nil
	case err != nil:
		return nil, err
	}
	return LoginTelegram200JSONResponse{SessionIssuedJSONResponse(toSession(sess))}, nil
}

func (s *Server) LoginDev(ctx context.Context, req LoginDevRequestObject) (LoginDevResponseObject, error) {
	var name string
	if req.Body.DisplayName != nil {
		name = *req.Body.DisplayName
	}
	var key string
	if req.Body.Key != nil {
		key = *req.Body.Key
	}
	sess, err := s.Auth.LoginDev(ctx, key, name, req.Body.Timezone)
	var verr *validation.Error
	switch {
	case errors.Is(err, auth.ErrDevAuthDisabled):
		return LoginDev404JSONResponse{NotFoundJSONResponse{Code: "not_found", Message: "not found"}}, nil
	case errors.As(err, &verr):
		return LoginDev400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case err != nil:
		return nil, err
	}
	return LoginDev200JSONResponse{SessionIssuedJSONResponse(toSession(sess))}, nil
}

func (s *Server) GetMe(ctx context.Context, _ GetMeRequestObject) (GetMeResponseObject, error) {
	u, err := s.Users.Get(ctx, userID(ctx))
	if errors.Is(err, user.ErrNotFound) {
		return GetMe401JSONResponse{UnauthorizedJSONResponse{Code: "unauthorized", Message: "unauthorized"}}, nil
	}
	if err != nil {
		return nil, err
	}
	return GetMe200JSONResponse(toUser(u)), nil
}

func (s *Server) UpdateMySettings(ctx context.Context, req UpdateMySettingsRequestObject) (UpdateMySettingsResponseObject, error) {
	patch := user.SettingsPatch{
		Timezone:                  req.Body.Timezone,
		DeviationThresholdMinutes: req.Body.DeviationThresholdMinutes,
	}
	if v := req.Body.SlotMinutes; v != nil {
		n := int(*v)
		patch.SlotMinutes = &n
	}
	if v := req.Body.DefaultView; v != nil {
		str := string(*v)
		patch.DefaultView = &str
	}

	u, err := s.Users.UpdateSettings(ctx, userID(ctx), patch)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UpdateMySettings400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, user.ErrNotFound):
		return UpdateMySettings401JSONResponse{UnauthorizedJSONResponse{Code: "unauthorized", Message: "unauthorized"}}, nil
	case err != nil:
		return nil, err
	}
	return UpdateMySettings200JSONResponse(toUser(u)), nil
}

func toUser(u user.User) User {
	return User{
		Id:                        u.ID,
		DisplayName:               u.DisplayName,
		Timezone:                  u.Timezone,
		SlotMinutes:               SlotMinutes(u.SlotMinutes),
		DefaultView:               ViewMode(u.DefaultView),
		DeviationThresholdMinutes: u.DeviationThresholdMinutes,
	}
}

func toSession(s auth.Session) Session {
	return Session{Token: s.Token, ExpiresAt: s.ExpiresAt, User: toUser(s.User)}
}

func validationError(e *validation.Error) Error {
	out := Error{Code: e.ErrorCode(), Message: e.Error()}
	if e.Field != "" {
		out.Field = &e.Field
	}
	return out
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(Error{Code: code, Message: message})
}

func limitBody(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
		next.ServeHTTP(w, r)
	})
}

func requestLogger(log *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
			start := time.Now()
			next.ServeHTTP(ww, r)
			log.LogAttrs(r.Context(), slog.LevelInfo, "request",
				slog.String("method", r.Method),
				slog.String("path", r.URL.Path),
				slog.Int("status", ww.Status()),
				slog.Duration("duration", time.Since(start)),
				slog.String("request_id", middleware.GetReqID(r.Context())),
			)
		})
	}
}
