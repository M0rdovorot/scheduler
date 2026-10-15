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
	b := req.Body
	updated, err := s.Tasks.Update(ctx, userID(ctx), req.Id, task.UpdateInput{
		Title: b.Title, Description: b.Description, PlannedStart: b.PlannedStart,
		PlannedEnd: b.PlannedEnd, CategoryIDs: b.CategoryIds,
	})
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UpdateInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return UpdateInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return UpdateInstance200JSONResponse(toInstance(updated)), nil
}

func (s *Server) DeleteInstance(ctx context.Context, req DeleteInstanceRequestObject) (DeleteInstanceResponseObject, error) {
	err := s.Tasks.Delete(ctx, userID(ctx), req.Id)
	if errors.Is(err, task.ErrNotFound) {
		return DeleteInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return DeleteInstance204Response{}, nil
}

func toInstance(in task.Instance) Instance {
	ids := in.CategoryIDs
	if ids == nil {
		ids = []uuid.UUID{}
	}
	return Instance{
		Id: in.ID, Title: in.Title, Description: in.Description,
		PlannedStart: in.PlannedStart, PlannedEnd: in.PlannedEnd,
		Status: InstanceStatus(in.Status), CategoryIds: ids,
	}
}

func taskNotFound() Error {
	return Error{Code: "not_found", Message: "task not found"}
}
