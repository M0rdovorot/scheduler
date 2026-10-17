package reminder

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/store"
	"github.com/m0rdovorot/scheduler/backend/internal/task"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

const (
	maxRules  = 20
	maxOffset = 10080 // a week, in minutes
)

var (
	ErrNotFound = errors.New("reminder target not found")
)

// Global is the settings of the user as a whole: the master switch, the quiet hours and the default rules.
type Global struct {
	Enabled bool
	// Quiet is nil without quiet hours.
	Quiet *Quiet
	Rules []Rule
}

// Effective says which level's rules apply to a target, and what they are.
type Effective struct {
	Source Scope
	Rules  []Rule
}

// NewService makes the service. The sender is what reaches Telegram; log may be nil.
func NewService(st *store.Store, tasks *task.Service, habits *habit.Service, sender Sender, log *slog.Logger) *Service {
	if log == nil {
		log = slog.Default()
	}
	return &Service{store: st, tasks: tasks, habits: habits, sender: sender, log: log, now: time.Now}
}

// SetSender sets what reaches Telegram; the bot needs the service, so it comes after it.
func (s *Service) SetSender(sender Sender) { s.sender = sender }

// Service keeps the settings, queues reminders and sends them.
type Service struct {
	store  *store.Store
	tasks  *task.Service
	habits *habit.Service
	sender Sender
	log    *slog.Logger
	now    func() time.Time
}

func (r Rule) valid(scope Scope) bool {
	if scope == ScopeHabit {
		return r.Kind == HabitTime && r.TimeOfDay >= 0 && r.TimeOfDay < 1440
	}
	switch r.Kind {
	case BeforeStart, AfterEnd, NotStarted, Overrun:
		return r.OffsetMinutes >= 0 && r.OffsetMinutes <= maxOffset
	}
	return false
}

func checkRules(scope Scope, rules []Rule) ([]Rule, error) {
	if len(rules) > maxRules {
		return nil, &validation.Error{Field: "rules", Message: fmt.Sprintf("at most %d reminders on a level", maxRules)}
	}
	for _, r := range rules {
		if !r.valid(scope) {
			return nil, &validation.Error{Field: "rules", Message: "a reminder is not valid for this level"}
		}
	}
	return normalize(slices.Clone(rules)), nil
}

func fromRule(r store.ReminderRule) Rule {
	out := Rule{Kind: Kind(r.Kind)}
	if r.OffsetMinutes != nil {
		out.OffsetMinutes = int(*r.OffsetMinutes)
	}
	if r.TimeOfDay != nil {
		out.TimeOfDay = int(*r.TimeOfDay)
	}
	return out
}

// snapshot is everything the user has set, loaded at once.
type snapshot struct {
	global    *Setting
	quiet     *Quiet
	category  map[uuid.UUID]*Setting
	series    map[uuid.UUID]*Setting
	instance  map[uuid.UUID]*Setting
	habit     map[uuid.UUID]*Setting
	parents   map[uuid.UUID]uuid.UUID
	maxBefore time.Duration
	maxAfter  time.Duration
}

func load(ctx context.Context, q *store.Queries, userID uuid.UUID) (*snapshot, error) {
	settings, err := q.ListReminderSettings(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list reminder settings: %w", err)
	}
	rules, err := q.ListReminderRules(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list reminder rules: %w", err)
	}
	cats, err := q.ListCategories(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("list categories: %w", err)
	}

	snap := &snapshot{
		category: map[uuid.UUID]*Setting{}, series: map[uuid.UUID]*Setting{},
		instance: map[uuid.UUID]*Setting{}, habit: map[uuid.UUID]*Setting{}, parents: map[uuid.UUID]uuid.UUID{},
	}
	for _, c := range cats {
		if c.ParentID.Valid {
			snap.parents[c.ID] = c.ParentID.UUID
		}
	}
	byID := map[uuid.UUID]*Setting{}
	for _, s := range settings {
		set := &Setting{Enabled: s.Enabled}
		byID[s.ID] = set
		switch Scope(s.Scope) {
		case ScopeGlobal:
			snap.global = set
			if s.QuietStart != nil && s.QuietEnd != nil {
				snap.quiet = &Quiet{Start: int(*s.QuietStart), End: int(*s.QuietEnd)}
			}
		case ScopeCategory:
			snap.category[s.CategoryID.UUID] = set
		case ScopeSeries:
			snap.series[s.SeriesID.UUID] = set
		case ScopeInstance:
			snap.instance[s.InstanceID.UUID] = set
		case ScopeHabit:
			snap.habit[s.HabitID.UUID] = set
		}
	}
	for _, r := range rules {
		set := byID[r.SettingID]
		if set == nil {
			continue
		}
		rule := fromRule(r)
		set.Rules = append(set.Rules, rule)
		d := time.Duration(rule.OffsetMinutes) * time.Minute
		if rule.Kind == BeforeStart {
			snap.maxBefore = max(snap.maxBefore, d)
		} else if rule.Kind != HabitTime {
			snap.maxAfter = max(snap.maxAfter, d)
		}
	}
	if snap.global == nil {
		// Every user gets the row when created; this is only a guard.
		snap.global = &Setting{Enabled: false}
	}
	return snap, nil
}

// levelsFor assembles the levels that apply to a task.
func (s *snapshot) levelsFor(instanceID uuid.UUID, seriesID *uuid.UUID, categoryIDs []uuid.UUID) Levels {
	l := Levels{Global: s.global, Instance: s.instance[instanceID]}
	if seriesID != nil {
		l.Series = s.series[*seriesID]
	}
	l.Categories = CategorySettings(categoryIDs, s.parents, s.category)
	return l
}

// GetGlobal returns the settings of the user as a whole.
func (s *Service) GetGlobal(ctx context.Context, userID uuid.UUID) (Global, error) {
	snap, err := load(ctx, s.store.Queries, userID)
	if err != nil {
		return Global{}, err
	}
	return Global{Enabled: snap.global.Enabled, Quiet: snap.quiet, Rules: normalize(slices.Clone(snap.global.Rules))}, nil
}

func (s *Service) SetGlobal(ctx context.Context, userID uuid.UUID, g Global) error {
	rules, err := checkRules(ScopeGlobal, g.Rules)
	if err != nil {
		return err
	}
	var qs, qe *int16
	if g.Quiet != nil {
		if g.Quiet.Start < 0 || g.Quiet.Start > 1439 || g.Quiet.End < 0 || g.Quiet.End > 1439 || g.Quiet.Start == g.Quiet.End {
			return &validation.Error{Field: "quiet_hours", Message: "the start and the end must differ, both within a day"}
		}
		a, b := int16(g.Quiet.Start), int16(g.Quiet.End)
		qs, qe = &a, &b
	}
	return s.store.InTx(ctx, func(q *store.Queries) error {
		row, err := q.GetGlobalReminderSettings(ctx, userID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			row, err = q.InsertReminderSettings(ctx, store.InsertReminderSettingsParams{
				UserID: userID, Scope: string(ScopeGlobal), Enabled: g.Enabled, QuietStart: qs, QuietEnd: qe,
			})
		case err == nil:
			row, err = q.UpdateReminderSettings(ctx, store.UpdateReminderSettingsParams{
				ID: row.ID, UserID: userID, Enabled: g.Enabled, QuietStart: qs, QuietEnd: qe,
			})
		}
		if err != nil {
			return fmt.Errorf("save global reminder settings: %w", err)
		}
		return replaceRules(ctx, q, userID, row.ID, rules)
	})
}

// targetKey names one level.
type targetKey struct {
	scope  Scope
	target uuid.UUID
}

func (k targetKey) params(userID uuid.UUID) store.GetReminderSettingsParams {
	p := store.GetReminderSettingsParams{UserID: userID, Scope: string(k.scope)}
	id := uuid.NullUUID{UUID: k.target, Valid: true}
	switch k.scope {
	case ScopeCategory:
		p.CategoryID = id
	case ScopeSeries:
		p.SeriesID = id
	case ScopeInstance:
		p.InstanceID = id
	case ScopeHabit:
		p.HabitID = id
	}
	return p
}

// exists checks that the target belongs to the user.
func (k targetKey) exists(ctx context.Context, q *store.Queries, userID uuid.UUID) error {
	var err error
	switch k.scope {
	case ScopeCategory:
		_, err = q.GetCategory(ctx, store.GetCategoryParams{ID: k.target, UserID: userID})
	case ScopeSeries:
		_, err = q.GetSeries(ctx, store.GetSeriesParams{ID: k.target, UserID: userID})
	case ScopeInstance:
		var in store.InstanceDetail
		in, err = q.GetInstance(ctx, store.GetInstanceParams{ID: k.target, UserID: userID})
		// A deleted occurrence is gone for the user.
		if err == nil && in.Status == "cancelled" {
			err = pgx.ErrNoRows
		}
	case ScopeHabit:
		_, err = q.GetHabit(ctx, store.GetHabitParams{ID: k.target, UserID: userID})
	default:
		return &validation.Error{Field: "scope", Message: "must be category, series, instance or habit"}
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return fmt.Errorf("check reminder target: %w", err)
	}
	return nil
}

// Get returns the settings of a level of its own, or nil when it inherits.
func (s *Service) Get(ctx context.Context, userID uuid.UUID, scope Scope, target uuid.UUID) (*Setting, error) {
	k := targetKey{scope, target}
	if err := k.exists(ctx, s.store.Queries, userID); err != nil {
		return nil, err
	}
	row, err := s.store.GetReminderSettings(ctx, k.params(userID))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get reminder settings: %w", err)
	}
	rules, err := s.store.ListReminderRulesOf(ctx, row.ID)
	if err != nil {
		return nil, fmt.Errorf("list reminder rules: %w", err)
	}
	out := &Setting{Enabled: row.Enabled}
	for _, r := range rules {
		out.Rules = append(out.Rules, fromRule(r))
	}
	return out, nil
}

// Put gives a level settings of its own, replacing the ones it had.
func (s *Service) Put(ctx context.Context, userID uuid.UUID, scope Scope, target uuid.UUID, set Setting) error {
	rules, err := checkRules(scope, set.Rules)
	if err != nil {
		return err
	}
	k := targetKey{scope, target}
	return s.store.InTx(ctx, func(q *store.Queries) error {
		if err := k.exists(ctx, q, userID); err != nil {
			return err
		}
		row, err := q.GetReminderSettings(ctx, k.params(userID))
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			p := k.params(userID)
			row, err = q.InsertReminderSettings(ctx, store.InsertReminderSettingsParams{
				UserID: userID, Scope: string(scope), CategoryID: p.CategoryID, SeriesID: p.SeriesID,
				InstanceID: p.InstanceID, HabitID: p.HabitID, Enabled: set.Enabled,
			})
		case err == nil:
			row, err = q.UpdateReminderSettings(ctx, store.UpdateReminderSettingsParams{ID: row.ID, UserID: userID, Enabled: set.Enabled})
		}
		if err != nil {
			return fmt.Errorf("save reminder settings: %w", err)
		}
		return replaceRules(ctx, q, userID, row.ID, rules)
	})
}

// Delete takes the settings of a level away: it inherits again.
func (s *Service) Delete(ctx context.Context, userID uuid.UUID, scope Scope, target uuid.UUID) error {
	k := targetKey{scope, target}
	return s.store.InTx(ctx, func(q *store.Queries) error {
		if err := k.exists(ctx, q, userID); err != nil {
			return err
		}
		row, err := q.GetReminderSettings(ctx, k.params(userID))
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("get reminder settings: %w", err)
		}
		if _, err := q.DeleteReminderSettings(ctx, store.DeleteReminderSettingsParams{ID: row.ID, UserID: userID}); err != nil {
			return fmt.Errorf("delete reminder settings: %w", err)
		}
		// Messages that were queued under the old settings are no longer wanted.
		return q.DeletePendingNotifications(ctx, userID)
	})
}

func replaceRules(ctx context.Context, q *store.Queries, userID, settingID uuid.UUID, rules []Rule) error {
	if err := q.DeleteReminderRules(ctx, settingID); err != nil {
		return fmt.Errorf("delete reminder rules: %w", err)
	}
	for _, r := range rules {
		p := store.AddReminderRuleParams{SettingID: settingID, Kind: string(r.Kind)}
		if r.Kind == HabitTime {
			t := int16(r.TimeOfDay)
			p.TimeOfDay = &t
		} else {
			o := int32(r.OffsetMinutes)
			p.OffsetMinutes = &o
		}
		if err := q.AddReminderRule(ctx, p); err != nil {
			return fmt.Errorf("add reminder rule: %w", err)
		}
	}
	// Messages that were queued under the old rules are no longer wanted.
	return q.DeletePendingNotifications(ctx, userID)
}

// Effective says which settings apply to a level now: its own, or what it inherits.
func (s *Service) Effective(ctx context.Context, userID uuid.UUID, scope Scope, target uuid.UUID) (Effective, error) {
	k := targetKey{scope, target}
	if scope != ScopeGlobal {
		if err := k.exists(ctx, s.store.Queries, userID); err != nil {
			return Effective{}, err
		}
	}
	snap, err := load(ctx, s.store.Queries, userID)
	if err != nil {
		return Effective{}, err
	}
	switch scope {
	case ScopeGlobal:
		return Effective{Source: ScopeGlobal, Rules: normalize(slices.Clone(snap.global.rules()))}, nil
	case ScopeHabit:
		if set := snap.habit[target]; set != nil {
			return Effective{Source: ScopeHabit, Rules: normalize(slices.Clone(set.rules()))}, nil
		}
		return Effective{Source: ScopeHabit}, nil
	case ScopeCategory:
		src, rules := Explain(Levels{Global: snap.global, Categories: CategorySettings([]uuid.UUID{target}, snap.parents, snap.category)})
		return Effective{Source: src, Rules: rules}, nil
	case ScopeSeries:
		ids, err := s.store.ListSeriesCategoryIDs(ctx, store.ListSeriesCategoryIDsParams{SeriesID: target, UserID: userID})
		if err != nil {
			return Effective{}, fmt.Errorf("list series categories: %w", err)
		}
		src, rules := Explain(snap.levelsFor(uuid.Nil, &target, ids))
		return Effective{Source: src, Rules: rules}, nil
	default: // instance
		in, err := s.store.GetInstance(ctx, store.GetInstanceParams{ID: target, UserID: userID})
		if err != nil {
			return Effective{}, fmt.Errorf("get instance: %w", err)
		}
		var series *uuid.UUID
		if in.SeriesID.Valid {
			series = &in.SeriesID.UUID
		}
		src, rules := Explain(snap.levelsFor(target, series, in.CategoryIds))
		return Effective{Source: src, Rules: rules}, nil
	}
}
