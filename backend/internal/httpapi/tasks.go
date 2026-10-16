package httpapi

import (
	"context"
	"errors"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

func (s *Server) ListInstances(ctx context.Context, req ListInstancesRequestObject) (ListInstancesResponseObject, error) {
	list, err := s.Tasks.List(ctx, userID(ctx), req.Params.From, req.Params.To)
	var verr *validation.Error
	if errors.As(err, &verr) {
		return ListInstances400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	}
	if err != nil {
		return nil, err
	}
	out := make(ListInstances200JSONResponse, len(list))
	for i, in := range list {
		out[i] = toInstance(in)
	}
	return out, nil
}

func (s *Server) CreateTask(ctx context.Context, req CreateTaskRequestObject) (CreateTaskResponseObject, error) {
	b := req.Body
	in := task.CreateInput{Title: b.Title, PlannedStart: b.PlannedStart, PlannedEnd: b.PlannedEnd}
	if b.Description != nil {
		in.Description = *b.Description
	}
	if b.CategoryIds != nil {
		in.CategoryIDs = *b.CategoryIds
	}
	if b.Recurrence != nil {
		in.Recurrence = &b.Recurrence.Rrule
	}

	created, err := s.Tasks.Create(ctx, userID(ctx), in)
	var verr *validation.Error
	if errors.As(err, &verr) {
		return CreateTask400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	}
	if err != nil {
		return nil, err
	}
	return CreateTask201JSONResponse(toInstance(created)), nil
}

func (s *Server) UpdateInstance(ctx context.Context, req UpdateInstanceRequestObject) (UpdateInstanceResponseObject, error) {
	scope, ok := parseScope(req.Params.Scope)
	if !ok {
		return UpdateInstance400JSONResponse{BadRequestJSONResponse(scopeError())}, nil
	}
	b := req.Body
	in := task.UpdateInput{
		Title: b.Title, Description: b.Description, PlannedStart: b.PlannedStart,
		PlannedEnd: b.PlannedEnd, CategoryIDs: b.CategoryIds,
	}
	if b.Recurrence != nil {
		in.Recurrence = &b.Recurrence.Rrule
	}

	updated, err := s.Tasks.Update(ctx, userID(ctx), req.Id, scope, in)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UpdateInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return UpdateInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	if updated == nil {
		return UpdateInstance204Response{}, nil
	}
	return UpdateInstance200JSONResponse(toInstance(*updated)), nil
}

func (s *Server) DeleteInstance(ctx context.Context, req DeleteInstanceRequestObject) (DeleteInstanceResponseObject, error) {
	scope, ok := parseScope(req.Params.Scope)
	if !ok {
		return DeleteInstance400JSONResponse{BadRequestJSONResponse(scopeError())}, nil
	}
	err := s.Tasks.Delete(ctx, userID(ctx), req.Id, scope)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return DeleteInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return DeleteInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return DeleteInstance204Response{}, nil
}

func (s *Server) GetSeries(ctx context.Context, req GetSeriesRequestObject) (GetSeriesResponseObject, error) {
	series, err := s.Tasks.GetSeries(ctx, userID(ctx), req.Id)
	if errors.Is(err, task.ErrSeriesNotFound) {
		return GetSeries404JSONResponse{NotFoundJSONResponse(Error{Code: "not_found", Message: "series not found"})}, nil
	}
	if err != nil {
		return nil, err
	}
	return GetSeries200JSONResponse{
		Id: series.ID, Title: series.Title, Description: series.Description, Rrule: series.RRule,
		StartLocal: series.StartLocal, Timezone: series.Timezone,
		DurationMinutes: series.DurationMinutes, CategoryIds: series.CategoryIDs,
	}, nil
}

// parseScope reads the optional scope parameter of an edit or a delete.
func parseScope[T ~string](p *T) (task.Scope, bool) {
	if p == nil {
		return task.ScopeThis, true
	}
	return task.ParseScope(string(*p))
}

func scopeError() Error {
	return Error{Code: "validation_failed", Message: "scope: must be this, following or all", Field: ptrTo("scope")}
}

func ptrTo[T any](v T) *T { return &v }

func toInstance(in task.Instance) Instance {
	ids := in.CategoryIDs
	if ids == nil {
		ids = []uuid.UUID{}
	}
	deviations := make([]Deviation, len(in.Deviations))
	for i, d := range in.Deviations {
		deviations[i] = Deviation{Kind: DeviationKind(d.Kind), Minutes: d.Minutes}
	}
	return Instance{
		Id: in.ID, Title: in.Title, Description: in.Description,
		PlannedStart: in.PlannedStart, PlannedEnd: in.PlannedEnd,
		ActualStart: in.ActualStart, ActualEnd: in.ActualEnd,
		Status: InstanceStatus(in.Status), Comment: in.Comment, CategoryIds: ids, SeriesId: in.SeriesID,
		RescheduledFrom: toLink(in.RescheduledFrom), RescheduledTo: toLink(in.RescheduledTo),
		Deviations: deviations,
	}
}

func toLink(l *task.Link) *InstanceLink {
	if l == nil {
		return nil
	}
	return &InstanceLink{Id: l.ID, PlannedStart: l.PlannedStart, PlannedEnd: l.PlannedEnd}
}

func taskNotFound() Error {
	return Error{Code: "not_found", Message: "task not found"}
}
