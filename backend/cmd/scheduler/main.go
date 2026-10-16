// Command scheduler runs the planner backend: HTTP API (and later reminders and the bot).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
	_ "time/tzdata" // IANA zones must not depend on the host's tzdata

	"github.com/m0rdovorot/scheduler/backend/internal/auth"
	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/config"
	"github.com/m0rdovorot/scheduler/backend/internal/httpapi"
	"github.com/m0rdovorot/scheduler/backend/internal/stats"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/user"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return err
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	pool, err := store.Open(ctx, cfg.DatabaseURL)
	if err != nil {
		return fmt.Errorf("open store: %w", err)
	}
	defer pool.Close()

	applied, err := store.Migrate(ctx, pool, migrations.FS)
	if err != nil {
		return fmt.Errorf("migrate: %w", err)
	}
	log.Info("migrations applied", "count", applied)

	st := store.NewStore(pool)
	users := user.NewService(st)
	categories := category.NewService(st)
	tasks := task.NewService(st)
	api := httpapi.NewServer(httpapi.Deps{
		DB: st,
		Auth: auth.NewService(st, auth.Config{
			BotToken:       cfg.BotToken,
			DevAuth:        cfg.DevAuth,
			SessionTTL:     cfg.SessionTTL,
			InitDataMaxAge: cfg.InitDataMaxAge,
		}),
		Users:      users,
		Categories: categories,
		Tasks:      tasks,
		Stats:      stats.NewService(tasks, categories, users),
	})

	srv := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           httpapi.NewRouter(api, log),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("http server listening", "addr", cfg.HTTPAddr, "env", cfg.AppEnv, "dev_auth", cfg.DevAuth)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case err := <-errCh:
		return fmt.Errorf("http server: %w", err)
	case <-ctx.Done():
	}

	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}
