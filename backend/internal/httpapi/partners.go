package httpapi

import (
	"context"
	"errors"

	"github.com/m0rdovorot/scheduler/backend/internal/partner"
)

func (s *Server) ListPartners(ctx context.Context, _ ListPartnersRequestObject) (ListPartnersResponseObject, error) {
	list, err := s.Partners.List(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	out := make(ListPartners200JSONResponse, len(list))
	for i, p := range list {
		out[i] = toPartner(p)
	}
	return out, nil
}

func (s *Server) CreatePartnerInvite(ctx context.Context, _ CreatePartnerInviteRequestObject) (CreatePartnerInviteResponseObject, error) {
	inv, err := s.Partners.CreateInvite(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	return CreatePartnerInvite201JSONResponse{Token: inv.Token, ExpiresAt: inv.ExpiresAt}, nil
}

func (s *Server) AcceptPartnerInvite(ctx context.Context, req AcceptPartnerInviteRequestObject) (AcceptPartnerInviteResponseObject, error) {
	p, err := s.Partners.Accept(ctx, userID(ctx), req.Body.Token)
	switch {
	case errors.Is(err, partner.ErrInvalidInvite):
		return AcceptPartnerInvite404JSONResponse{NotFoundJSONResponse{
			Code: "invite_invalid", Message: "the invite is invalid, expired or already used",
		}}, nil
	case errors.Is(err, partner.ErrOwnInvite):
		return AcceptPartnerInvite409JSONResponse{Code: "own_invite", Message: "this is your own invite"}, nil
	case errors.Is(err, partner.ErrAlreadyLinked):
		return AcceptPartnerInvite409JSONResponse{Code: "already_partners", Message: "you are already partners"}, nil
	case err != nil:
		return nil, err
	}
	return AcceptPartnerInvite200JSONResponse(toPartner(p)), nil
}

func (s *Server) RemovePartner(ctx context.Context, req RemovePartnerRequestObject) (RemovePartnerResponseObject, error) {
	err := s.Partners.Remove(ctx, userID(ctx), req.Id)
	if errors.Is(err, partner.ErrNotFound) {
		return RemovePartner404JSONResponse{NotFoundJSONResponse(partnerNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return RemovePartner204Response{}, nil
}

func (s *Server) SetPartnerAccess(ctx context.Context, req SetPartnerAccessRequestObject) (SetPartnerAccessResponseObject, error) {
	p, err := s.Partners.SetAccess(ctx, userID(ctx), req.Id, partner.AccessPatch{
		Tasks: req.Body.Tasks, Habits: req.Body.Habits,
	})
	if errors.Is(err, partner.ErrNotFound) {
		return SetPartnerAccess404JSONResponse{NotFoundJSONResponse(partnerNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return SetPartnerAccess200JSONResponse(toPartner(p)), nil
}

func partnerNotFound() Error {
	return Error{Code: "not_found", Message: "partner not found"}
}

func toPartner(p partner.Partner) Partner {
	return Partner{
		Id: p.ID, DisplayName: p.DisplayName, CreatedAt: p.CreatedAt,
		TasksShared: p.TasksShared, HabitsShared: p.HabitsShared,
	}
}
