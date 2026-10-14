// Package migrations embeds the goose SQL migrations into the binary.
package migrations

import "embed"

// FS holds the goose migration files.
//
//go:embed *.sql
var FS embed.FS
