package httpapi

import (
	"context"
	"errors"

	"github.com/oapi-codegen/runtime/types"

	"github.com/m0rdovorot/scheduler/backend/internal/habit"
	"github.com/m0rdovorot/scheduler/backend/internal/validation"
)

func (s *Server) ListHabits(ctx context.Context, _ ListHabitsRequestObject) (ListHabitsResponseObject, error) {
	list, err := s.Habits.List(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	out := make(ListHabits200JSONResponse, len(list))
	for i, h := range list {
		out[i] = toHabit(h)
	}
	return out, nil
}

func (s *Server) CreateHabit(ctx context.Context, req CreateHabitRequestObject) (CreateHabitResponseObject, error) {
	b := req.Body
	in := habit.Input{
		Title: b.Title, Kind: habit.Kind(b.Kind), Color: b.Color,
		Schedule: habit.Schedule{Frequency: habit.Frequency(b.Frequency)},
	}
	if b.TargetValue != nil {
		in.Target = *b.TargetValue
	}
	if b.Unit != nil {
		in.Unit = *b.Unit
	}
	if b.Weekdays != nil {
		in.Schedule.Weekdays = *b.Weekdays
	}
	if b.TimesPerWeek != nil {
		in.Schedule.TimesPerWeek = *b.TimesPerWeek
	}
	if b.Placement != nil {
		in.Placement = &habit.Placement{Time: b.Placement.Time, DurationMinutes: b.Placement.DurationMinutes}
	}
	h, err := s.Habits.Create(ctx, userID(ctx), in)
	var verr *validation.Error
	if errors.As(err, &verr) {
		return CreateHabit400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	}
	if err != nil {
		return nil, err
	}
	return CreateHabit201JSONResponse(toHabit(h)), nil
}

func (s *Server) GetHabit(ctx context.Context, req GetHabitRequestObject) (GetHabitResponseObject, error) {
	h, err := s.Habits.Get(ctx, userID(ctx), req.Id)
	if errors.Is(err, habit.ErrNotFound) {
		return GetHabit404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return GetHabit200JSONResponse(toHabit(h)), nil
}

func (s *Server) UpdateHabit(ctx context.Context, req UpdateHabitRequestObject) (UpdateHabitResponseObject, error) {
	b := req.Body
	patch := habit.Patch{Title: b.Title, Target: b.TargetValue, Unit: b.Unit, Color: b.Color}
	var err error
	switch {
	case b.Frequency != nil:
		sched := habit.Schedule{Frequency: habit.Frequency(*b.Frequency)}
		if b.Weekdays != nil {
			sched.Weekdays = *b.Weekdays
		}
		if b.TimesPerWeek != nil {
			sched.TimesPerWeek = *b.TimesPerWeek
		}
		patch.Schedule = &sched
	case b.Weekdays != nil || b.TimesPerWeek != nil:
		err = &validation.Error{Field: "frequency", Message: "give the frequency together with weekdays or times_per_week"}
	}
	var h habit.Habit
	if err == nil {
		h, err = s.Habits.Update(ctx, userID(ctx), req.Id, patch)
	}
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return UpdateHabit400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, habit.ErrNotFound):
		return UpdateHabit404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return UpdateHabit200JSONResponse(toHabit(h)), nil
}

func (s *Server) DeleteHabit(ctx context.Context, req DeleteHabitRequestObject) (DeleteHabitResponseObject, error) {
	err := s.Habits.Delete(ctx, userID(ctx), req.Id)
	if errors.Is(err, habit.ErrNotFound) {
		return DeleteHabit404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return DeleteHabit204Response{}, nil
}

func (s *Server) ArchiveHabit(ctx context.Context, req ArchiveHabitRequestObject) (ArchiveHabitResponseObject, error) {
	h, err := s.Habits.Archive(ctx, userID(ctx), req.Id, true)
	if errors.Is(err, habit.ErrNotFound) {
		return ArchiveHabit404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return ArchiveHabit200JSONResponse(toHabit(h)), nil
}

func (s *Server) UnarchiveHabit(ctx context.Context, req UnarchiveHabitRequestObject) (UnarchiveHabitResponseObject, error) {
	h, err := s.Habits.Archive(ctx, userID(ctx), req.Id, false)
	if errors.Is(err, habit.ErrNotFound) {
		return UnarchiveHabit404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return UnarchiveHabit200JSONResponse(toHabit(h)), nil
}

func (s *Server) SetHabitPlacement(ctx context.Context, req SetHabitPlacementRequestObject) (SetHabitPlacementResponseObject, error) {
	h, err := s.Habits.SetPlacement(ctx, userID(ctx), req.Id, habit.Placement{Time: req.Body.Time, DurationMinutes: req.Body.DurationMinutes})
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return SetHabitPlacement400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, habit.ErrNotFound):
		return SetHabitPlacement404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return SetHabitPlacement200JSONResponse(toHabit(h)), nil
}

func (s *Server) ClearHabitPlacement(ctx context.Context, req ClearHabitPlacementRequestObject) (ClearHabitPlacementResponseObject, error) {
	h, err := s.Habits.ClearPlacement(ctx, userID(ctx), req.Id)
	if errors.Is(err, habit.ErrNotFound) {
		return ClearHabitPlacement404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	}
	if err != nil {
		return nil, err
	}
	return ClearHabitPlacement200JSONResponse(toHabit(h)), nil
}

func (s *Server) SetHabitLog(ctx context.Context, req SetHabitLogRequestObject) (SetHabitLogResponseObject, error) {
	err := s.Habits.SetMark(ctx, userID(ctx), req.Id, habit.DayOf(req.Date.Year(), req.Date.Month(), req.Date.Day()), req.Body.Value)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return SetHabitLog400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, habit.ErrNotFound):
		return SetHabitLog404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	case err != nil:
		return nil, err
	}
	return SetHabitLog204Response{}, nil
}

func (s *Server) GetHabitsToday(ctx context.Context, _ GetHabitsTodayRequestObject) (GetHabitsTodayResponseObject, error) {
	items, today, err := s.Habits.Today(ctx, userID(ctx))
	if err != nil {
		return nil, err
	}
	out := GetHabitsToday200JSONResponse{Date: toDate(today), Items: make([]HabitTodayItem, len(items))}
	for i, it := range items {
		out.Items[i] = HabitTodayItem{
			Habit: toHabit(it.Habit), Value: it.Value, Done: it.Done, WeekDone: it.WeekDone,
			Streaks: toStreaks(it.Habit, it.Streaks),
		}
	}
	return out, nil
}

func (s *Server) GetHabitStats(ctx context.Context, req GetHabitStatsRequestObject) (GetHabitStatsResponseObject, error) {
	from := habit.DayOf(req.Params.From.Year(), req.Params.From.Month(), req.Params.From.Day())
	to := habit.DayOf(req.Params.To.Year(), req.Params.To.Month(), req.Params.To.Day())
	st, err := s.Habits.Stats(ctx, userID(ctx), req.Id, from, to)
	var verr *validation.Error
	switch {
	case errors.As(err, &verr):
		return GetHabitStats400JSONResponse{BadRequestJSONResponse(validationError(verr))}, nil
	case errors.Is(err, habit.ErrNotFound):
		return GetHabitStats404JSONResponse{NotFoundJSONResponse(habitNotFound())}, nil
	case err != nil:
		return nil, err
	}
	out := GetHabitStats200JSONResponse{
		Habit: toHabit(st.Habit), Today: toDate(st.Today), Streaks: toStreaks(st.Habit, st.Streaks),
		PercentAll: st.PercentAll, Percent30: st.Percent30, Percent90: st.Percent90,
		Days: make([]HabitDay, len(st.Cells)),
	}
	for i, c := range st.Cells {
		out.Days[i] = HabitDay{Date: toDate(c.Date), Value: c.Value, Done: c.Done, Planned: c.Planned}
	}
	return out, nil
}

func toDate(d habit.Day) types.Date { return types.Date{Time: d} }

func toStreaks(h habit.Habit, s habit.Streaks) HabitStreaks {
	unit := HabitStreaksUnitDay
	if h.Schedule.Weekly() {
		unit = HabitStreaksUnitWeek
	}
	return HabitStreaks{Current: s.Current, Best: s.Best, Unit: unit}
}

func toHabit(h habit.Habit) Habit {
	weekdays := h.Schedule.Weekdays
	if weekdays == nil {
		weekdays = []int{}
	}
	out := Habit{
		Id: h.ID, Title: h.Title, Kind: HabitKind(h.Kind), TargetValue: h.Target, Unit: h.Unit,
		Frequency: HabitFrequency(h.Schedule.Frequency), Weekdays: weekdays, Color: h.Color,
		ArchivedAt: h.ArchivedAt, CreatedAt: h.CreatedAt,
	}
	if h.Schedule.Weekly() {
		n := h.Schedule.TimesPerWeek
		out.TimesPerWeek = &n
	}
	if h.Placement != nil {
		out.Placement = &HabitPlacement{Time: h.Placement.Time, DurationMinutes: h.Placement.DurationMinutes}
	}
	return out
}

func habitNotFound() Error {
	return Error{Code: "not_found", Message: "habit not found"}
}
