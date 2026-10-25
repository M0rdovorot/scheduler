// Package visibility defines who may see the title of a task (FR-11.5).
package visibility

import "github.com/m0rdovorot/scheduler/backend/internal/validation"

const (
	// Partners: every partner sees the title.
	Partners = "partners"
	// Granted: partners who were given access to tasks see the title.
	Granted = "granted"
	// Private: nobody sees the title; partners see only that the time is busy.
	Private = "private"
)

// Validate checks a value of the given request field.
func Validate(field, v string) error {
	switch v {
	case Partners, Granted, Private:
		return nil
	}
	return &validation.Error{Field: field, Message: "must be one of partners, granted, private"}
}
