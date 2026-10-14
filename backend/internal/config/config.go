// Package config loads the service configuration from environment variables.
package config

import (
	"errors"
	"fmt"
	"log/slog"
	"os"
	"strings"
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
}

// Load reads the configuration using getenv (usually os.Getenv).
func Load(getenv func(string) string) (Config, error) {
	cfg := Config{
		AppEnv:      withDefault(getenv("APP_ENV"), EnvProd),
		HTTPAddr:    withDefault(getenv("HTTP_ADDR"), "127.0.0.1:8081"),
		DatabaseURL: getenv("DATABASE_URL"),
	}

	var errs []error

	if cfg.AppEnv != EnvDev && cfg.AppEnv != EnvProd {
		errs = append(errs, fmt.Errorf("APP_ENV must be %q or %q, got %q", EnvDev, EnvProd, cfg.AppEnv))
	}
	if cfg.DatabaseURL == "" {
		errs = append(errs, errors.New("DATABASE_URL is required"))
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

func withDefault(v, def string) string {
	if v = strings.TrimSpace(v); v != "" {
		return v
	}
	return def
}
