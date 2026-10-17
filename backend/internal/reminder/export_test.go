package reminder

import "time"

// SetClock replaces the clock of the service in tests.
func (s *Service) SetClock(now func() time.Time) { s.now = now }
