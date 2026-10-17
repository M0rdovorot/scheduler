package httpapi

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"

	"github.com/google/uuid"

	"github.com/m0rdovorot/scheduler/backend/internal/reminder"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

var clockRe = regexp.MustCompile(`^([01]\d|2[0-3]):([0-5]\d)$`)

// minutesOf reads "07:30" as minutes from midnight.
func minutesOf(s string) (int, bool) {
	m := clockRe.FindStringSubmatch(s)
	if m == nil {
		return 0, false
	}
	h, _ := strconv.Atoi(m[1])
	mm, _ := strconv.Atoi(m[2])
	return h*60 + mm, true
}

func clockOf(minutes int) string { return fmt.Sprintf("%02d:%02d", minutes/60, minutes%60) }

func scopeOf(s string) (reminder.Scope, bool) {
	switch sc := reminder.Scope(s); sc {
	case reminder.ScopeCategory, reminder.ScopeSeries, reminder.ScopeInstance, reminder.ScopeHabit:
		return sc, true
	}
	return "", false
}

func toRule(r ReminderRule) (reminder.Rule, error) {
	out := reminder.Rule{Kind: reminder.Kind(r.Kind)}
	bad := &validation.Error{Field: "rules", Message: "a reminder needs offset_minutes, or time_of_day for habit_time"}
	if out.Kind == reminder.HabitTime {
		if r.TimeOfDay == nil || r.OffsetMinutes != nil {
			return out, bad
		}
		m, ok := minutesOf(*r.TimeOfDay)
		if !ok {
			return out, bad
		}
		out.TimeOfDay = m
		return out, nil
	}
	if r.OffsetMinutes == nil || r.TimeOfDay != nil {
		return out, bad
	}
	out.OffsetMinutes = *r.OffsetMinutes
	return out, nil
}

func toRules(in []ReminderRule) ([]reminder.Rule, error) {
	out := make([]reminder.Rule, 0, len(in))
	for _, r := range in {
		rule, err := toRule(r)
		if err != nil {
			return nil, err
		}
		out = append(out, rule)
	}
	return out, nil
}

func fromRules(in []reminder.Rule) []ReminderRule {
	out := make([]ReminderRule, len(in))
	for i, r := range in {
		out[i] = ReminderRule{Kind: ReminderRuleKind(r.Kind)}
		if r.Kind == reminder.HabitTime {
			t := clockOf(r.TimeOfDay)
			out[i].TimeOfDay = &t
		} else {
			o := r.OffsetMinutes
			out[i].OffsetMinutes = &o
		}
	}
	return out
}

func toGlobal(g reminder.Global) GlobalReminders {
	out := GlobalReminders{Enabled: g.Enabled, Rules: fromRules(g.Rules)}
	if g.Quiet != nil {
		out.QuietHours = &QuietHours{Start: clockOf(g.Quiet.Start), End: clockOf(g.Quiet.End)}
	}
	return out
}

func (s *Server) GetGlobalReminders(ctx context.Context, _ GetGlobalRemindersRequestObject) (GetGlobalRemindersResponseObject, error) {
	g, err := s.Reminders.GetGlobal(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	return GetGlobalReminders200JSONResponse(toGlobal(g)), nil
}

func (s *Server) SetGlobalReminders(ctx context.Context, req SetGlobalRemindersRequestObject) (SetGlobalRemindersResponseObject, error) {
	bad := func(err error) (SetGlobalRemindersResponseObject, error) {
		var verr *validation.Error
		if errors.As(err, &verr) {
			return SetGlobalReminders400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
		}
		return nil, err
	}
	rules, err := toRules(req.Body.Rules)
	if err != nil {
		return bad(err)
	}
	g := reminder.Global{Enabled: req.Body.Enabled, Rules: rules}
	if q := req.Body.QuietHours; q != nil {
		start, ok1 := minutesOf(q.Start)
		end, ok2 := minutesOf(q.End)
		if !ok1 || !ok2 {
			return bad(&validation.Error{Field: "quiet_hours", Message: "times must look like 23:00"})
		}
		g.Quiet = &reminder.Quiet{Start: start, End: end}
	}
	if err := s.Reminders.SetGlobal(ctx, userID(ctx), g); err != nil {
		return bad(err)
	}
	out, err := s.Reminders.GetGlobal(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	return SetGlobalReminders200JSONResponse(toGlobal(out)), nil
}

// level reads the settings of a level in the form of the API.
func (s *Server) level(ctx context.Context, scope reminder.Scope, id uuid.UUID) (ReminderLevel, error) {
	own, err := s.Reminders.Get(ctx, userID(ctx), scope, id)
	if err != nil {
		return ReminderLevel{}, err
	}
	eff, err := s.Reminders.Effective(ctx, userID(ctx), scope, id)
	if err != nil {
		return ReminderLevel{}, err
	}
	out := ReminderLevel{Effective: EffectiveReminders{Source: EffectiveRemindersSource(eff.Source), Rules: fromRules(eff.Rules)}}
	if own != nil {
		out.Override = &ReminderOverride{Enabled: own.Enabled, Rules: fromRules(own.Rules)}
	}
	return out, nil
}

func remindersNotFound() Error {
	return Error{Code: "not_found", Message: "nothing to set reminders for"}
}

func (s *Server) GetReminders(ctx context.Context, req GetRemindersRequestObject) (GetRemindersResponseObject, error) {
	scope, ok := scopeOf(req.Scope)
	if !ok {
		return GetReminders404JSONResponse{NotFoundJSONResponse(remindersNotFound())}, nil
	}
	out, err := s.level(ctx, scope, req.Id)
	if errors.Is(err, reminder.ErrNotFound) {
		return GetReminders404JSONResponse{NotFoundJSONResponse(remindersNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return GetReminders200JSONResponse(out), nil
}

func (s *Server) SetReminders(ctx context.Context, req SetRemindersRequestObject) (SetRemindersResponseObject, error) {
	scope, ok := scopeOf(req.Scope)
	if !ok {
		return SetReminders404JSONResponse{NotFoundJSONResponse(remindersNotFound())}, nil
	}
	rules, err := toRules(req.Body.Rules)
	if err == nil {
		err = s.Reminders.Put(ctx, userID(ctx), scope, req.Id, reminder.Setting{Enabled: req.Body.Enabled, Rules: rules})
	}
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return SetReminders400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, reminder.ErrNotFound):
		return SetReminders404JSONResponse{NotFoundJSONResponse(remindersNotFound())}, nil
	case err != nil:
		return nil, err
	}
	out, err := s.level(ctx, scope, req.Id)
	if err != nil {
		return nil, err
	}
	return SetReminders200JSONResponse(out), nil
}

func (s *Server) DeleteReminders(ctx context.Context, req DeleteRemindersRequestObject) (DeleteRemindersResponseObject, error) {
	scope, ok := scopeOf(req.Scope)
	if !ok {
		return DeleteReminders404JSONResponse{NotFoundJSONResponse(remindersNotFound())}, nil
	}
	err := s.Reminders.Delete(ctx, userID(ctx), scope, req.Id)
	if errors.Is(err, reminder.ErrNotFound) {
		return DeleteReminders404JSONResponse{NotFoundJSONResponse(remindersNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	out, err := s.level(ctx, scope, req.Id)
	if err != nil {
		return nil, err
	}
	return DeleteReminders200JSONResponse(out), nil
}
