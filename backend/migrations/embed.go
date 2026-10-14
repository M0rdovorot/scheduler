// Package migrations embeds the goose SQL migrations into the binary.
package migrations

import "embed"

// FS holds the migration files. .gitkeep keeps the directory non-empty until
// the first migration is added.
//
//go:embed *
var FS embed.FS
