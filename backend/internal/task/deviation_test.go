package task

import (
	"fmt"
	"testing"
	"time"
)

func tm(h, m int) *time.Time {
	t := time.Date(2026, 10, 14, h, m, 0, 0, time.UTC)
	return &t
}

func kinds(ds []Deviation) string {
	out := make([]string, len(ds))
	for i, d := range ds {
		out[i] = fmt.Sprintf("%s:%d", d.Kind, d.Minutes)
	}
	return fmt.Sprint(out)
}

func TestDeviations(t *testing.T) {
	// Plan 10:00-11:00.
	tests := []struct {
		name      string
		start     *time.Time
		end       *time.Time
		threshold int
		want      string
	}{
		{"as planned", tm(10, 0), tm(11, 0), 5, "[]"},
		{"started late, ended late, same length", tm(10, 20), tm(11, 20), 5, "[started_late:20 finished_late:20]"},
		{"started early", tm(9, 40), tm(10, 40), 5, "[started_early:20 finished_early:20]"},
		{"started on time, overran", tm(10, 0), tm(11, 30), 5, "[finished_late:30 took_longer:30]"},
		{"started on time, finished early", tm(10, 0), tm(10, 40), 5, "[finished_early:20 took_shorter:20]"},
		{"started late, finished on time: shorter", tm(10, 20), tm(11, 0), 5, "[started_late:20 took_shorter:20]"},
		{"started early, finished on time: longer", tm(9, 30), tm(11, 0), 5, "[started_early:30 took_longer:30]"},
		{"shifted and longer", tm(10, 10), tm(11, 40), 5, "[started_late:10 finished_late:40 took_longer:30]"},
		{"below the threshold is no deviation", tm(10, 4), tm(11, 4), 5, "[]"},
		{"exactly the threshold counts", tm(10, 5), tm(11, 5), 5, "[started_late:5 finished_late:5]"},
		{"threshold 0: any whole minute", tm(10, 1), tm(11, 0), 0, "[started_late:1 took_shorter:1]"},
		{"threshold 0: nothing at zero", tm(10, 0), tm(11, 0), 0, "[]"},
		{"a big threshold hides small shifts", tm(10, 20), tm(11, 20), 30, "[]"},
		{"running: only the start", tm(10, 20), nil, 5, "[started_late:20]"},
		{"running, on time", tm(10, 0), nil, 5, "[]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Deviations(tm(10, 0), tm(11, 0), tt.start, tt.end, tt.threshold)
			if kinds(got) != tt.want {
				t.Errorf("got %s, want %s", kinds(got), tt.want)
			}
		})
	}
}

func TestDeviationsNeedAPlanAndAFact(t *testing.T) {
	if got := Deviations(nil, nil, tm(10, 0), tm(11, 0), 0); got != nil {
		t.Errorf("unplanned task: %v", got)
	}
	if got := Deviations(tm(10, 0), tm(11, 0), nil, nil, 0); got != nil {
		t.Errorf("no fact: %v", got)
	}
}

func TestDeviationsRoundToWholeMinutes(t *testing.T) {
	start := time.Date(2026, 10, 14, 10, 4, 40, 0, time.UTC) // 4m40s late: rounds to 5
	end := time.Date(2026, 10, 14, 11, 0, 0, 0, time.UTC)
	got := Deviations(tm(10, 0), tm(11, 0), &start, &end, 5)
	if kinds(got) != "[started_late:5 took_shorter:5]" {
		t.Errorf("got %s", kinds(got))
	}
}
