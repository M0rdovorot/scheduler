package config

import (
	"log/slog"
	"strings"
	"testing"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.AppEnv != EnvProd || cfg.IsDev() {
		t.Errorf("AppEnv = %q, want prod by default", cfg.AppEnv)
	}
	if cfg.HTTPAddr != "127.0.0.1:8081" {
		t.Errorf("HTTPAddr = %q", cfg.HTTPAddr)
	}
	if cfg.LogLevel != slog.LevelInfo {
		t.Errorf("LogLevel = %v", cfg.LogLevel)
	}
}

func TestLoadValues(t *testing.T) {
	cfg, err := Load(env(map[string]string{
		"APP_ENV":      "dev",
		"HTTP_ADDR":    ":9000",
		"DATABASE_URL": "postgres://x",
		"LOG_LEVEL":    "debug",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.IsDev() || cfg.HTTPAddr != ":9000" || cfg.LogLevel != slog.LevelDebug {
		t.Errorf("unexpected config: %+v", cfg)
	}
}

func TestLoadErrors(t *testing.T) {
	_, err := Load(env(map[string]string{"APP_ENV": "staging", "LOG_LEVEL": "loud"}))
	if err == nil {
		t.Fatal("expected error")
	}
	for _, want := range []string{"APP_ENV", "DATABASE_URL", "LOG_LEVEL"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}
