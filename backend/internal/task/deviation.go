package task

import (
	"math"
	"time"
)

// DeviationKind says how the fact differs from the plan.
type DeviationKind string

const (
	StartedLate   DeviationKind = "started_late"
	StartedEarly  DeviationKind = "started_early"
	FinishedLate  DeviationKind = "finished_late"
	FinishedEarly DeviationKind = "finished_early"
	TookLonger    DeviationKind = "took_longer"
	TookShorter   DeviationKind = "took_shorter"
)

// Deviation is one difference between plan and fact, in whole minutes (always positive).
type Deviation struct {
	Kind    DeviationKind
	Minutes int
}

// Deviations compares the fact with the plan (FR-5.5). Nothing is stored: the
// result follows from the plan, the fact and the user's threshold. A difference
// counts from the threshold on; with a threshold of 0 any difference of a whole
// minute counts. A running task (no end yet) has only its start compared.
func Deviations(plannedStart, plannedEnd, actualStart, actualEnd *time.Time, thresholdMinutes int) []Deviation {
	if plannedStart == nil || plannedEnd == nil || actualStart == nil {
		return nil
	}
	var out []Deviation
	add := func(minutes int, positive, negative DeviationKind) {
		abs := minutes
		kind := positive
		if minutes < 0 {
			abs, kind = -minutes, negative
		}
		if abs > 0 && abs >= thresholdMinutes {
			out = append(out, Deviation{Kind: kind, Minutes: abs})
		}
	}

	add(wholeMinutes(actualStart.Sub(*plannedStart)), StartedLate, StartedEarly)
	if actualEnd != nil {
		add(wholeMinutes(actualEnd.Sub(*plannedEnd)), FinishedLate, FinishedEarly)
		planned := plannedEnd.Sub(*plannedStart)
		add(wholeMinutes(actualEnd.Sub(*actualStart)-planned), TookLonger, TookShorter)
	}
	return out
}

func wholeMinutes(d time.Duration) int {
	return int(math.Round(d.Minutes()))
}
