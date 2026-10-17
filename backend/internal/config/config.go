// Package config loads the service configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	EnvDev  = "dev"
	EnvProd = "prod"
)

type Config struct {
	AppEnv      string
	LogLevel    slog.Level
	HTTPAddr    string
	DatabaseURL string

	// BotToken signs and verifies Telegram init data. Required unless DevAuth is on.
	BotToken string
	// DevAuth enables sign-in without Telegram. Allowed only when AppEnv is dev.
	DevAuth bool
	// SessionTTL is how long an issued session token stays valid.
	SessionTTL time.Duration
	// InitDataMaxAge is how old Telegram init data may be.
	InitDataMaxAge time.Duration
	// BotEnabled starts the Telegram bot (long polling) and the reminders it sends.
	BotEnabled bool
	// WebAppURL is where the Mini App is served; the bot's "Open" buttons lead there.
	WebAppURL string
}

// Load reads the configuration using getenv (usually os.Getenv).
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		AppEnv:      withDefault(getenv("APP_ENV"), EnvProd),
		HTTPAddr:    withDefault(getenv("HTTP_ADDR"), "127.0.0.1:8081"),
		DatabaseURL: getenv("DATABASE_URL"),
		BotToken:    strings.TrimSpace(getenv("BOT_TOKEN")),
		WebAppURL:   strings.TrimSpace(getenv("WEBAPP_URL")),
	}

	var errs []error

	var err error
	if cfg.DevAuth, err = parseBool(getenv("DEV_AUTH")); err != nil {
		errs = append(errs, fmt.Errorf("DEV_AUTH: %w", err))
	}
	if cfg.BotEnabled, err = parseBool(getenv("BOT_ENABLED")); err != nil {
		errs = append(errs, fmt.Errorf("BOT_ENABLED: %w", err))
	}
	if cfg.SessionTTL, err = parseDuration(getenv("SESSION_TTL"), 30*24*time.Hour); err != nil {
		errs = append(errs, fmt.Errorf("SESSION_TTL: %w", err))
	}
	if cfg.InitDataMaxAge, err = parseDuration(getenv("INITDATA_MAX_AGE"), 24*time.Hour); err != nil {
		errs = append(errs, fmt.Errorf("INITDATA_MAX_AGE: %w", err))
	}

	if cfg.AppEnv != EnvDev && cfg.AppEnv != EnvProd {
		errs = append(errs, fmt.Errorf("APP_ENV must be %q or %q, got %q", EnvDev, EnvProd, cfg.AppEnv))
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
	}
	if cfg.DevAuth && cfg.AppEnv != EnvDev {
		errs = append(errs, errors.New("DEV_AUTH can be enabled only with APP_ENV=dev"))
	}
	if cfg.BotEnabled && cfg.BotToken == "" {
		errs = append(errs, errors.New("BOT_TOKEN is required when BOT_ENABLED is on"))
	}
	if cfg.WebAppURL != "" && !strings.HasPrefix(cfg.WebAppURL, "https://") {
		errs = append(errs, errors.New("WEBAPP_URL must be an https:// address: Telegram opens Mini Apps only over TLS"))
	}
	if cfg.BotToken == "" && !cfg.DevAuth {
		errs = append(errs, errors.New("BOT_TOKEN is required unless DEV_AUTH is enabled"))
	}
	if err := cfg.LogLevel.UnmarshalText([]byte(withDefault(getenv("LOG_LEVEL"), "info"))); err != nil {
		errs = append(errs, fmt.Errorf("LOG_LEVEL: %w", err))
	}

	if err := errors.Join(errs...); err != nil {
		return Config{}, fmt.Errorf("invalid configuration: %w", err)
	}
	return cfg, nil
}

// LoadFromEnv reads the configuration from the process environment.
func LoadFromEnv() (Config, error) {
	return Load(os.Getenv)
}

func (c Config) IsDev() bool { return c.AppEnv == EnvDev }

func parseBool(v string) (bool, error) {
	if strings.TrimSpace(v) == "" {
		return false, nil
	}
	return strconv.ParseBool(strings.TrimSpace(v))
}

func parseDuration(v string, def time.Duration) (time.Duration, error) {
	if strings.TrimSpace(v) == "" {
		return def, nil
	}
	d, err := time.ParseDuration(strings.TrimSpace(v))
	if err != nil {
		return 0, err
	}
	if d <= 0 {
		return 0, errors.New("must be positive")
	}
	return d, nil
}

func withDefault(v, def string) string {
	if v = strings.TrimSpace(v); v != "" {
		return v
	}
	return def
}
