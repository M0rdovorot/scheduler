package httpapi

import (
	"context"
	"errors"

	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

func (s *Server) CompleteInstance(ctx context.Context, req CompleteInstanceRequestObject) (CompleteInstanceResponseObject, error) {
	in, err := s.Tasks.Complete(ctx, userID(ctx), req.Id)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return CompleteInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return CompleteInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return CompleteInstance200JSONResponse(toInstance(in)), nil
}

func (s *Server) StartInstance(ctx context.Context, req StartInstanceRequestObject) (StartInstanceResponseObject, error) {
	in, err := s.Tasks.Start(ctx, userID(ctx), req.Id)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return StartInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return StartInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return StartInstance200JSONResponse(toInstance(in)), nil
}

func (s *Server) StopInstance(ctx context.Context, req StopInstanceRequestObject) (StopInstanceResponseObject, error) {
	in, err := s.Tasks.Stop(ctx, userID(ctx), req.Id)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return StopInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return StopInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return StopInstance200JSONResponse(toInstance(in)), nil
}

func (s *Server) UpdateTracking(ctx context.Context, req UpdateTrackingRequestObject) (UpdateTrackingResponseObject, error) {
	b := req.Body
	in := task.TrackingInput{ActualStart: b.ActualStart, ActualEnd: b.ActualEnd, Comment: b.Comment}
	if b.Status != nil {
		status := string(*b.Status)
		in.Status = &status
	}

	updated, err := s.Tasks.EditTracking(ctx, userID(ctx), req.Id, in)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UpdateTracking400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return UpdateTracking404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return UpdateTracking200JSONResponse(toInstance(updated)), nil
}

func (s *Server) RescheduleInstance(ctx context.Context, req RescheduleInstanceRequestObject) (RescheduleInstanceResponseObject, error) {
	b := req.Body
	comment := ""
	if b.Comment != nil {
		comment = *b.Comment
	}

	moved, err := s.Tasks.Reschedule(ctx, userID(ctx), req.Id, b.PlannedStart, b.PlannedEnd, comment)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return RescheduleInstance400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, task.ErrNotFound):
		return RescheduleInstance404JSONResponse{NotFoundJSONResponse(taskNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return RescheduleInstance201JSONResponse(toInstance(moved)), nil
}

func (s *Server) CreateUnplanned(ctx context.Context, req CreateUnplannedRequestObject) (CreateUnplannedResponseObject, error) {
	b := req.Body
	in := task.UnplannedInput{Title: b.Title, ActualStart: b.ActualStart, ActualEnd: b.ActualEnd}
	if b.Description != nil {
		in.Description = *b.Description
	}
	if b.CategoryIds != nil {
		in.CategoryIDs = *b.CategoryIds
	}

	created, err := s.Tasks.CreateUnplanned(ctx, userID(ctx), in)
	var verr *validation.Error
	if errors.As(err, &verr) {
		return CreateUnplanned400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	}
	if err != nil {
		return nil, err
	}
	return CreateUnplanned201JSONResponse(toInstance(created)), nil
}
