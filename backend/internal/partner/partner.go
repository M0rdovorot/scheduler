// Package partner manages mutual partnerships between users: invites, the
// access a user gives to a partner, and breaking the link.
package partner

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/store"
)

// InviteTTL is how long an invite link works.
const InviteTTL = 7 * 24 * time.Hour

var (
	// ErrInvalidInvite covers an unknown, expired and already used invite alike:
	// the caller learns nothing about which tokens exist.
	ErrInvalidInvite = errors.New("invite is invalid or expired")
	ErrOwnInvite     = errors.New("cannot accept your own invite")
	ErrAlreadyLinked = errors.New("already partners")
	// ErrNotFound means there is no partnership with that user.
	ErrNotFound = errors.New("partner not found")
)

type Partner struct {
	ID           uuid.UUID
	DisplayName  string
	CreatedAt    time.Time
	TasksShared  bool // the user lets this partner see task titles
	HabitsShared bool // the user lets this partner see habits
}

// Invite is a freshly created invite. Token is shown once; only its hash is stored.
type Invite struct {
	Token     string
	ExpiresAt time.Time
}

// AccessPatch changes the access given to a partner; nil fields stay as they are.
type AccessPatch struct {
	Tasks  *bool
	Habits *bool
}

type Service struct {
	store *store.Store
	tasks Materializer
	now   func() time.Time
}

func NewService(s *store.Store, tasks Materializer) *Service {
	return &Service{store: s, tasks: tasks, now: time.Now}
}

// SetClock replaces the clock; for tests.
func (s *Service) SetClock(now func() time.Time) { s.now = now }

// CreateInvite makes a new single-use invite link for the user.
func (s *Service) CreateInvite(ctx context.Context, userID uuid.UUID) (Invite, error) {
	token, err := newToken()
	if err != nil {
		return Invite{}, err
	}
	expires := s.now().Add(InviteTTL)
	if err := s.store.CreatePartnerInvite(ctx, store.CreatePartnerInviteParams{
		InviterID: userID, TokenHash: hashToken(token), ExpiresAt: expires,
	}); err != nil {
		return Invite{}, fmt.Errorf("create invite: %w", err)
	}
	return Invite{Token: token, ExpiresAt: expires}, nil
}

// Accept links the user with the inviter and returns the new partner. A failed
// accept (own invite, already partners) leaves the invite usable.
func (s *Service) Accept(ctx context.Context, userID uuid.UUID, token string) (Partner, error) {
	var inviter uuid.UUID
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		inv, err := q.LockPartnerInvite(ctx, hashToken(token))
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrInvalidInvite
		}
		if err != nil {
			return fmt.Errorf("lock invite: %w", err)
		}
		now := s.now()
		if inv.AcceptedBy.Valid || !inv.ExpiresAt.After(now) {
			return ErrInvalidInvite
		}
		if inv.InviterID == userID {
			return ErrOwnInvite
		}
		linked, err := q.ArePartners(ctx, store.ArePartnersParams{UserID: userID, PartnerID: inv.InviterID})
		if err != nil {
			return fmt.Errorf("check partnership: %w", err)
		}
		if linked {
			return ErrAlreadyLinked
		}
		for _, p := range [][2]uuid.UUID{{userID, inv.InviterID}, {inv.InviterID, userID}} {
			if err := q.CreatePartnership(ctx, store.CreatePartnershipParams{UserID: p[0], PartnerID: p[1]}); err != nil {
				return fmt.Errorf("create partnership: %w", err)
			}
		}
		if err := q.AcceptPartnerInvite(ctx, store.AcceptPartnerInviteParams{
			ID: inv.ID, AcceptedBy: uuid.NullUUID{UUID: userID, Valid: true}, AcceptedAt: &now,
		}); err != nil {
			return fmt.Errorf("accept invite: %w", err)
		}
		inviter = inv.InviterID
		return nil
	})
	if err != nil {
		return Partner{}, err
	}
	return s.get(ctx, userID, inviter)
}

// List returns the user's partners.
func (s *Service) List(ctx context.Context, userID uuid.UUID) ([]Partner, error) {
	rows, err := s.store.ListPartners(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list partners: %w", err)
	}
	out := make([]Partner, len(rows))
	for i, r := range rows {
		out[i] = Partner{
			ID: r.ID, DisplayName: r.DisplayName, CreatedAt: r.CreatedAt,
			TasksShared: r.TasksShared, HabitsShared: r.HabitsShared,
		}
	}
	return out, nil
}

// Remove breaks the link in both directions; the access given either way goes with it.
func (s *Service) Remove(ctx context.Context, userID, partnerID uuid.UUID) error {
	n, err := s.store.DeletePartnership(ctx, store.DeletePartnershipParams{UserID: userID, PartnerID: partnerID})
	if err != nil {
		return fmt.Errorf("delete partnership: %w", err)
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAccess gives or takes back the user's access for a partner and returns the
// partner as it is afterwards.
func (s *Service) SetAccess(ctx context.Context, userID, partnerID uuid.UUID, patch AccessPatch) (Partner, error) {
	err := s.store.InTx(ctx, func(q *store.Queries) error {
		linked, err := q.ArePartners(ctx, store.ArePartnersParams{UserID: userID, PartnerID: partnerID})
		if err != nil {
			return fmt.Errorf("check partnership: %w", err)
		}
		if !linked {
			return ErrNotFound
		}
		if patch.Tasks != nil {
			if *patch.Tasks {
				err = q.GrantTaskAccess(ctx, store.GrantTaskAccessParams{OwnerID: userID, GranteeID: partnerID})
			} else {
				err = q.RevokeTaskAccess(ctx, store.RevokeTaskAccessParams{OwnerID: userID, GranteeID: partnerID})
			}
			if err != nil {
				return fmt.Errorf("set task access: %w", err)
			}
		}
		if patch.Habits != nil {
			if *patch.Habits {
				err = q.GrantHabitAccess(ctx, store.GrantHabitAccessParams{OwnerID: userID, GranteeID: partnerID})
			} else {
				err = q.RevokeHabitAccess(ctx, store.RevokeHabitAccessParams{OwnerID: userID, GranteeID: partnerID})
			}
			if err != nil {
				return fmt.Errorf("set habit access: %w", err)
			}
		}
		return nil
	})
	if err != nil {
		return Partner{}, err
	}
	return s.get(ctx, userID, partnerID)
}

func (s *Service) get(ctx context.Context, userID, partnerID uuid.UUID) (Partner, error) {
	list, err := s.List(ctx, userID)
	if err != nil {
		return Partner{}, err
	}
	for _, p := range list {
		if p.ID == partnerID {
			return p, nil
		}
	}
	return Partner{}, ErrNotFound
}

func newToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("generate token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

func hashToken(token string) []byte {
	sum := sha256.Sum256([]byte(token))
	return sum[:]
}
