// Package validation holds the error type for rejected user input.
package validation

// CodeFailed is the code of a generic validation error.
const CodeFailed = "validation_failed"

// Error describes input that was rejected.
type Error struct {
	// Code is machine readable; empty means CodeFailed.
	Code string
	// Field is the name of the offending request field, if any.
	Field   string
	Message string
}

func (e *Error) Error() string {
	if e.Field == "" {
		return e.Message
	}
	return e.Field + ": " + e.Message
}

func (e *Error) ErrorCode() string {
	if e.Code == "" {
		return CodeFailed
	}
	return e.Code
}
