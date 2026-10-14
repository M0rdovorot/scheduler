package store_test

import (
	"context"
	"testing"
	"testing/fstest"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/testutil"
	"github.com/m0rdovorot/scheduler/backend/migrations"
)

func TestMigrateAppliesPendingOnce(t *testing.T) {
	fsys := fstest.MapFS{
		"00001_widgets.sql": {Data: []byte(`-- +goose Up
CREATE TABLE widgets (id uuid PRIMARY KEY DEFAULT uuidv7());
-- +goose Down
DROP TABLE widgets;
`)},
	}
	// Start from an empty schema and apply the fake migration on top.
	pool := testutil.NewDB(t, fstest.MapFS{})
	ctx := context.Background()

	n, err := store.Migrate(ctx, pool, fsys)
	if err != nil || n != 1 {
		t.Fatalf("first Migrate = %d, %v; want 1, nil", n, err)
	}
	n, err = store.Migrate(ctx, pool, fsys)
	if err != nil || n != 0 {
		t.Fatalf("second Migrate = %d, %v; want 0, nil", n, err)
	}

	var exists bool
	err = pool.QueryRow(ctx, `SELECT to_regclass('widgets') IS NOT NULL`).Scan(&exists)
	if err != nil || !exists {
		t.Fatalf("widgets table missing: exists=%v err=%v", exists, err)
	}
}

func TestMigrateWithoutMigrations(t *testing.T) {
	pool := testutil.NewDB(t, fstest.MapFS{})
	n, err := store.Migrate(context.Background(), pool, fstest.MapFS{})
	if err != nil || n != 0 {
		t.Fatalf("Migrate = %d, %v; want 0, nil", n, err)
	}
}

// Guards the real migration set: it must apply cleanly to an empty database.
func TestRealMigrationsApply(t *testing.T) {
	testutil.NewDB(t, migrations.FS)
}
