package httpapi

import (
	"fmt"
	"net/http"
	"testing"
)

func recurrenceExtra(rrule string) string {
	return fmt.Sprintf(`,"recurrence":{"rrule":%q}`, rrule)
}

// createSeries creates a daily series whose first slot is 2026-10-14 09:00-10:00 Moscow.
func (a *testAPI) createSeries(token, rrule string) map[string]any {
	a.t.Helper()
	return a.createTask(token, "Планёрка", "2026-10-14T09:00:00+03:00", "2026-10-14T10:00:00+03:00", recurrenceExtra(rrule))
}

func starts(list []map[string]any) []string {
	out := make([]string, len(list))
	for i, in := range list {
		out[i] = in["planned_start"].(string)
	}
	return out
}

func TestSeriesFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a") // the dev user lives in Europe/Moscow
	api.do("PATCH", "/me/settings", token, `{"timezone":"Europe/Moscow"}`)

	first := api.createSeries(token, "FREQ=WEEKLY;BYDAY=MO,WE")
	seriesID, _ := first["series_id"].(string)
	if seriesID == "" || first["planned_start"] != "2026-10-14T06:00:00Z" {
		t.Fatalf("first occurrence = %v", first)
	}

	// Occurrences appear for the requested window only.
	list := api.listTasks(token, "2026-10-12T00:00:00Z", "2026-10-26T00:00:00Z")
	want := []string{"2026-10-14T06:00:00Z", "2026-10-19T06:00:00Z", "2026-10-21T06:00:00Z"}
	if fmt.Sprint(starts(list)) != fmt.Sprint(want) {
		t.Errorf("starts = %v, want %v", starts(list), want)
	}
	if list[1]["series_id"] != seriesID {
		t.Errorf("series_id = %v", list[1]["series_id"])
	}

	code, series := api.do("GET", "/series/"+seriesID, token, "")
	if code != http.StatusOK || series["rrule"] != "FREQ=WEEKLY;BYDAY=MO,WE" || series["start_local"] != "2026-10-14T09:00" ||
		series["timezone"] != "Europe/Moscow" || series["duration_minutes"] != 60.0 {
		t.Errorf("GET series: status %d, body %v", code, series)
	}

	// Edit only this occurrence: 200 with the task.
	id := list[1]["id"].(string)
	code, out := api.do("PATCH", "/instances/"+id+"?scope=this", token, `{"title":"Особая"}`)
	if code != http.StatusOK || out["title"] != "Особая" {
		t.Errorf("PATCH this: status %d, body %v", code, out)
	}

	// Edit all: 204 without a body; the others are rewritten, the edited one stays.
	code, out = api.do("PATCH", "/instances/"+id+"?scope=all", token, `{"title":"Общая","planned_start":"2026-10-19T12:00:00+03:00","planned_end":"2026-10-19T13:00:00+03:00"}`)
	if code != http.StatusNoContent || out != nil {
		t.Errorf("PATCH all: status %d, body %v", code, out)
	}
	titles := map[string]string{}
	for _, in := range api.listTasks(token, "2026-10-12T00:00:00Z", "2026-10-26T00:00:00Z") {
		titles[in["planned_start"].(string)] = in["title"].(string)
	}
	// The time of the series moved from 09:00 to 12:00. The detached occurrence keeps its own
	// slot (06:00 UTC) and, because the keys of occurrences are their original times, the
	// new template also produces its Monday occurrence (09:00 UTC): the same trade-off as
	// for deleted occurrences when the time of a series changes.
	wantTitles := map[string]string{
		"2026-10-14T09:00:00Z": "Общая", "2026-10-19T06:00:00Z": "Особая",
		"2026-10-19T09:00:00Z": "Общая", "2026-10-21T09:00:00Z": "Общая",
	}
	if fmt.Sprint(titles) != fmt.Sprint(wantTitles) {
		t.Errorf("titles = %v, want %v", titles, wantTitles)
	}

	// Delete the following ones from the 21st.
	list = api.listTasks(token, "2026-10-21T00:00:00Z", "2026-10-22T00:00:00Z")
	if code, _ := api.do("DELETE", "/instances/"+list[0]["id"].(string)+"?scope=following", token, ""); code != http.StatusNoContent {
		t.Errorf("DELETE following: status %d", code)
	}
	if got := api.listTasks(token, "2026-10-21T00:00:00Z", "2026-12-31T00:00:00Z"); len(got) != 0 {
		t.Errorf("after delete following: %v", starts(got))
	}
}

func TestSeriesErrors(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	api.do("PATCH", "/me/settings", token, `{"timezone":"Europe/Moscow"}`)
	first := api.createSeries(token, "FREQ=DAILY")
	id := first["id"].(string)
	oneOff := api.createTask(token, "Разовое", "2026-10-14T12:00:00Z", "2026-10-14T13:00:00Z", "")["id"].(string)

	// Invalid rules.
	for _, rule := range []string{"FREQ=HOURLY", "garbage", "FREQ=DAILY;COUNT=2;UNTIL=20261231T000000Z"} {
		code, out := api.do("POST", "/tasks", token, taskBody("x", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", recurrenceExtra(rule)))
		if code != http.StatusBadRequest || out["field"] != "recurrence" {
			t.Errorf("rule %q: status %d, body %v", rule, code, out)
		}
	}
	code, out := api.do("POST", "/tasks", token, taskBody("x", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", recurrenceExtra("FREQ=DAILY;UNTIL=20200101T000000Z")))
	if code != http.StatusBadRequest || out["code"] != "no_occurrences" {
		t.Errorf("no occurrences: status %d, body %v", code, out)
	}

	// A new date for the whole series is refused with its own code.
	code, out = api.do("PATCH", "/instances/"+id+"?scope=all", token, `{"planned_start":"2026-10-15T10:00:00+03:00","planned_end":"2026-10-15T11:00:00+03:00"}`)
	if code != http.StatusBadRequest || out["code"] != "series_date_change" {
		t.Errorf("date change: status %d, body %v", code, out)
	}
	// The rule is not an attribute of one occurrence.
	if code, _ = api.do("PATCH", "/instances/"+id, token, `{"recurrence":{"rrule":"FREQ=DAILY"}}`); code != http.StatusBadRequest {
		t.Errorf("recurrence with scope=this: status %d", code)
	}

	// Scopes.
	for _, scope := range []string{"everything", "ALL", "this_and_following"} {
		if code, _ := api.do("PATCH", "/instances/"+id+"?scope="+scope, token, `{"title":"x"}`); code != http.StatusBadRequest {
			t.Errorf("PATCH scope=%s: status %d, want 400", scope, code)
		}
		if code, _ := api.do("DELETE", "/instances/"+id+"?scope="+scope, token, ""); code != http.StatusBadRequest {
			t.Errorf("DELETE scope=%s: status %d, want 400", scope, code)
		}
	}
	for _, scope := range []string{"following", "all"} {
		if code, out := api.do("PATCH", "/instances/"+oneOff+"?scope="+scope, token, `{"title":"x"}`); code != http.StatusBadRequest || out["field"] != "scope" {
			t.Errorf("one-off PATCH scope=%s: status %d, body %v", scope, code, out)
		}
		if code, _ := api.do("DELETE", "/instances/"+oneOff+"?scope="+scope, token, ""); code != http.StatusBadRequest {
			t.Errorf("one-off DELETE scope=%s: status %d", scope, code)
		}
	}
}

func TestSeriesAreIsolatedBetweenUsers(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	first := api.createSeries(a, "FREQ=DAILY")
	id, seriesID := first["id"].(string), first["series_id"].(string)

	if code, _ := api.do("GET", "/series/"+seriesID, b, ""); code != http.StatusNotFound {
		t.Errorf("GET series by another user: status %d", code)
	}
	if code, _ := api.do("GET", "/series/"+seriesID, "", ""); code != http.StatusUnauthorized {
		t.Errorf("GET series without a session: status %d", code)
	}
	for _, scope := range []string{"this", "following", "all"} {
		if code, _ := api.do("PATCH", "/instances/"+id+"?scope="+scope, b, `{"title":"hacked"}`); code != http.StatusNotFound {
			t.Errorf("PATCH scope=%s by another user: status %d", scope, code)
		}
		if code, _ := api.do("DELETE", "/instances/"+id+"?scope="+scope, b, ""); code != http.StatusNotFound {
			t.Errorf("DELETE scope=%s by another user: status %d", scope, code)
		}
	}
	if list := api.listTasks(b, "2026-10-14T00:00:00Z", "2026-10-30T00:00:00Z"); len(list) != 0 {
		t.Errorf("user B sees %d tasks", len(list))
	}
	if list := api.listTasks(a, "2026-10-14T00:00:00Z", "2026-10-16T00:00:00Z"); len(list) != 2 || list[0]["title"] != "Планёрка" {
		t.Errorf("the series was changed: %v", list)
	}
}

func TestOneOffTasksHaveNoSeries(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	task := api.createTask(token, "Разовое", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", "")
	if v, present := task["series_id"]; !present || v != nil {
		t.Errorf("series_id = %v (present %v), want null", v, present)
	}
}
