// Package testutil provides helpers for tests that need a real PostgreSQL.
package testutil

import (
	"context"
	"fmt"
	"io/fs"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
)

// NewDB returns a pool bound to a fresh, isolated schema with all migrations
// from migrationsFS applied. The schema is dropped when the test ends.
//
// The database is taken from TEST_DATABASE_URL; the test is skipped when the
// variable is not set (`make test` sets it).
func NewDB(t *testing.T, migrationsFS fs.FS) *pgxpool.Pool {
	t.Helper()

	url := lookupURL(t)
	ctx := context.Background()

	admin, err := pgx.Connect(ctx, url)
	if err != nil {
		t.Fatalf("connect to test database: %v", err)
	}
	t.Cleanup(func() { _ = admin.Close(ctx) })

	schema := "t_" + strings.ReplaceAll(strings.ToLower(t.Name()), "/", "_")
	schema = sanitize(schema)
	if _, err := admin.Exec(ctx, fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", schema)); err != nil {
		t.Fatalf("drop schema: %v", err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf("CREATE SCHEMA %s", schema)); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec(context.Background(), fmt.Sprintf("DROP SCHEMA IF EXISTS %s CASCADE", schema))
	})

	cfg, err := pgxpool.ParseConfig(url)
	if err != nil {
		t.Fatalf("parse test database url: %v", err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatalf("create pool: %v", err)
	}
	t.Cleanup(pool.Close)

	if _, err := store.Migrate(ctx, pool, migrationsFS); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return pool
}

func lookupURL(t *testing.T) string {
	t.Helper()
	url := getenv("TEST_DATABASE_URL")
	if url == "" {
		t.Skip("TEST_DATABASE_URL is not set; run `make test`")
	}
	return url
}

// sanitize keeps only characters safe for an unquoted identifier and caps
// the length at PostgreSQL's 63-byte limit.
func sanitize(s string) string {
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := b.String()
	if len(out) > 63 {
		out = out[:63]
	}
	return out
}
