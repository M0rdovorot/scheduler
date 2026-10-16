package httpapi

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/stats"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

func (s *Server) GetStats(ctx context.Context, req GetStatsRequestObject) (GetStatsResponseObject, error) {
	rep, err := s.Stats.Report(ctx, userID(ctx), req.Params.From, req.Params.To)
	var verr *validation.Error
	if errors.As(err, &verr) {
		return GetStats400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	}
	if err != nil {
		return nil, err
	}
	return GetStats200JSONResponse(toStatsReport(rep)), nil
}

func (s *Server) ListRunningInstances(ctx context.Context, _ ListRunningInstancesRequestObject) (ListRunningInstancesResponseObject, error) {
	list, err := s.Tasks.Running(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	out := make(ListRunningInstances200JSONResponse, len(list))
	for i, in := range list {
		out[i] = toInstance(in)
	}
	return out, nil
}

func toStatsReport(r stats.Report) StatsReport {
	out := StatsReport{
		From: r.From, To: r.To,
		ActualMinutes: r.ActualMinutes, PlannedMinutes: r.PlannedMinutes,
		UnplannedMinutes: r.UnplannedMinutes, UnplannedCount: r.UnplannedCount,
		LongRunningTimers: r.LongRunning, UncategorizedMinutes: r.UncategorizedMinutes,
		Categories: make([]CategoryMinutes, len(r.Categories)),
		Tasks:      make([]TaskMinutes, len(r.Tasks)),
		Days:       make([]StatsDay, len(r.Days)),
		Deviations: make([]Instance, len(r.Deviations)),
		PlanVsFact: PlanVsFact{
			PlannedCount: r.PlanVsFact.PlannedCount, Done: r.PlanVsFact.Done, Partial: r.PlanVsFact.Partial,
			NotDone: r.PlanVsFact.NotDone, InProgress: r.PlanVsFact.InProgress, Unmarked: r.PlanVsFact.Unmarked,
			Upcoming: r.PlanVsFact.Upcoming, Rescheduled: r.PlanVsFact.Rescheduled,
			LateStarts: r.PlanVsFact.LateStarts, Overran: r.PlanVsFact.Overran,
			PercentDone: r.PlanVsFact.PercentDone,
		},
	}
	for i, c := range r.Categories {
		out.Categories[i] = CategoryMinutes{CategoryId: c.CategoryID, Minutes: c.Minutes}
	}
	for i, t := range r.Tasks {
		out.Tasks[i] = TaskMinutes{Title: t.Title, Count: t.Count, Minutes: t.Minutes}
	}
	for i, d := range r.Days {
		day := StatsDay{Date: d.Date, Minutes: d.Minutes, ByCategory: make([]DayCategoryMinutes, len(d.ByCategory))}
		for j, c := range d.ByCategory {
			var id *uuid.UUID
			if c.CategoryID != uuid.Nil {
				id = &c.CategoryID
			}
			day.ByCategory[j] = DayCategoryMinutes{CategoryId: id, Minutes: c.Minutes}
		}
		out.Days[i] = day
	}
	for i, d := range r.Deviations {
		out.Deviations[i] = toInstance(d.Instance)
	}
	return out
}
