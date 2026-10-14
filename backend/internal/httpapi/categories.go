package httpapi

import (
	"context"
	"errors"

	"github.com/m0rdovorot/scheduler/backend/internal/category"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

func (s *Server) ListCategories(ctx context.Context, _ ListCategoriesRequestObject) (ListCategoriesResponseObject, error) {
	list, err := s.Categories.List(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	out := make(ListCategories200JSONResponse, len(list))
	for i, c := range list {
		out[i] = toCategory(c)
	}
	return out, nil
}

func (s *Server) CreateCategory(ctx context.Context, req CreateCategoryRequestObject) (CreateCategoryResponseObject, error) {
	c, err := s.Categories.Create(ctx, userID(ctx), category.CreateInput{
		Name: req.Body.Name, Color: req.Body.Color, ParentID: req.Body.ParentId,
	})
	var verr *validation.Error
	if errors.As(err, &verr) {
		return CreateCategory400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	}
	if err != nil {
		return nil, err
	}
	return CreateCategory201JSONResponse(toCategory(c)), nil
}

func (s *Server) UpdateCategory(ctx context.Context, req UpdateCategoryRequestObject) (UpdateCategoryResponseObject, error) {
	c, err := s.Categories.Update(ctx, userID(ctx), req.Id, category.UpdateInput{
		Name: req.Body.Name, Color: req.Body.Color,
	})
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UpdateCategory400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, category.ErrNotFound):
		return UpdateCategory404JSONResponse{NotFoundJSONResponse(categoryNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return UpdateCategory200JSONResponse(toCategory(c)), nil
}

func (s *Server) DeleteCategory(ctx context.Context, req DeleteCategoryRequestObject) (DeleteCategoryResponseObject, error) {
	err := s.Categories.Delete(ctx, userID(ctx), req.Id)
	if errors.Is(err, category.ErrNotFound) {
		return DeleteCategory404JSONResponse{NotFoundJSONResponse(categoryNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return DeleteCategory204Response{}, nil
}

func (s *Server) MoveCategory(ctx context.Context, req MoveCategoryRequestObject) (MoveCategoryResponseObject, error) {
	c, err := s.Categories.Move(ctx, userID(ctx), req.Id, req.Body.ParentId)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return MoveCategory400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, category.ErrNotFound):
		return MoveCategory404JSONResponse{NotFoundJSONResponse(categoryNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return MoveCategory200JSONResponse(toCategory(c)), nil
}

func (s *Server) ArchiveCategory(ctx context.Context, req ArchiveCategoryRequestObject) (ArchiveCategoryResponseObject, error) {
	c, err := s.Categories.Archive(ctx, userID(ctx), req.Id)
	if errors.Is(err, category.ErrNotFound) {
		return ArchiveCategory404JSONResponse{NotFoundJSONResponse(categoryNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return ArchiveCategory200JSONResponse(toCategory(c)), nil
}

func (s *Server) UnarchiveCategory(ctx context.Context, req UnarchiveCategoryRequestObject) (UnarchiveCategoryResponseObject, error) {
	c, err := s.Categories.Unarchive(ctx, userID(ctx), req.Id)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UnarchiveCategory400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, category.ErrNotFound):
		return UnarchiveCategory404JSONResponse{NotFoundJSONResponse(categoryNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return UnarchiveCategory200JSONResponse(toCategory(c)), nil
}

func toCategory(c category.Category) Category {
	return Category{Id: c.ID, ParentId: c.ParentID, Name: c.Name, Color: c.Color, ArchivedAt: c.ArchivedAt}
}

func categoryNotFound() Error {
	return Error{Code: "not_found", Message: "category not found"}
}
