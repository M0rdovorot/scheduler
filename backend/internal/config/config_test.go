package config

import (
	"log/slog"
	"strings"
	"testing"
	"time"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestLoadDefaults(t *testing.T) {
	cfg, err := Load(env(map[string]string{"DATABASE_URL": "postgres://x", "BOT_TOKEN": "tok"}))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.DevAuth || cfg.BotToken != "tok" {
		t.Errorf("DevAuth = %v, BotToken = %q", cfg.DevAuth, cfg.BotToken)
	}
	if cfg.SessionTTL != 30*24*time.Hour || cfg.InitDataMaxAge != 24*time.Hour {
		t.Errorf("SessionTTL = %v, InitDataMaxAge = %v", cfg.SessionTTL, cfg.InitDataMaxAge)
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
		"DEV_AUTH":     "true",
		"SESSION_TTL":  "48h",
	}))
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.DevAuth || cfg.SessionTTL != 48*time.Hour {
		t.Errorf("DevAuth = %v, SessionTTL = %v", cfg.DevAuth, cfg.SessionTTL)
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
	for _, want := range []string{"APP_ENV", "DATABASE_URL", "LOG_LEVEL", "BOT_TOKEN"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error %q does not mention %s", err, want)
		}
	}
}

func TestLoadDevAuthRules(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantErr string // empty: must succeed
	}{
		{"dev auth in prod", map[string]string{"APP_ENV": "prod", "DEV_AUTH": "true", "DATABASE_URL": "x"}, "DEV_AUTH can be enabled only with APP_ENV=dev"},
		{"dev auth in dev without token", map[string]string{"APP_ENV": "dev", "DEV_AUTH": "true", "DATABASE_URL": "x"}, ""},
		{"prod without token", map[string]string{"APP_ENV": "prod", "DATABASE_URL": "x"}, "BOT_TOKEN is required"},
		{"dev without token and dev auth", map[string]string{"APP_ENV": "dev", "DATABASE_URL": "x"}, "BOT_TOKEN is required"},
		{"bad bool", map[string]string{"APP_ENV": "dev", "DEV_AUTH": "maybe", "DATABASE_URL": "x"}, "DEV_AUTH"},
		{"bad duration", map[string]string{"APP_ENV": "dev", "DEV_AUTH": "1", "DATABASE_URL": "x", "SESSION_TTL": "soon"}, "SESSION_TTL"},
		{"non-positive duration", map[string]string{"BOT_TOKEN": "t", "DATABASE_URL": "x", "INITDATA_MAX_AGE": "0s"}, "INITDATA_MAX_AGE"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := Load(env(tt.env))
			if tt.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.wantErr)
			}
		})
	}
}

func TestLoadBotSettings(t *testing.T) {
	base := map[string]string{"DATABASE_URL": "x", "BOT_TOKEN": "tok"}
	with := func(kv ...string) func(string) string {
		m := map[string]string{}
		for k, v := range base {
			m[k] = v
		}
		for i := 0; i < len(kv); i += 2 {
			m[kv[i]] = kv[i+1]
		}
		return env(m)
	}

	cfg, err := Load(with())
	if err != nil || cfg.BotEnabled || cfg.WebAppURL != "" {
		t.Fatalf("defaults: %+v, %v", cfg, err)
	}
	cfg, err = Load(with("BOT_ENABLED", "true", "WEBAPP_URL", " https://plan.example/ "))
	if err != nil || !cfg.BotEnabled || cfg.WebAppURL != "https://plan.example/" {
		t.Fatalf("enabled: %+v, %v", cfg, err)
	}
	for name, kv := range map[string][]string{
		"bad bool":        {"BOT_ENABLED", "maybe"},
		"plain http":      {"WEBAPP_URL", "http://plan.example/"},
		"not an address":  {"WEBAPP_URL", "plan.example"},
		"enabled, no key": {"BOT_ENABLED", "true", "BOT_TOKEN", ""},
	} {
		in := with(kv...)
		if name == "enabled, no key" {
			// A dev login does not need the token, the bot does.
			in = env(map[string]string{"DATABASE_URL": "x", "APP_ENV": "dev", "DEV_AUTH": "true", "BOT_ENABLED": "true"})
		}
		if _, err := Load(in); err == nil {
			t.Errorf("%s: expected an error", name)
		}
	}
}
