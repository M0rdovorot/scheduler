package httpapi

import (
	"net/http"
	"net/url"
	"testing"
)

func (a *testAPI) stats(token, from, to string) (int, map[string]any) {
	a.t.Helper()
	return a.do("GET", "/stats?from="+url.QueryEscape(from)+"&to="+url.QueryEscape(to), token, "")
}

func TestStatsReport(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	api.do("PATCH", "/me/settings", token, `{"timezone":"Europe/Moscow"}`)
	cat := api.createCat(token, "Работа", nil)

	id := api.createTask(token, "Планёрка", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z", `,"category_ids":["`+cat+`"]`)["id"].(string)
	api.do("POST", "/instances/"+id+"/complete", token, "")
	api.do("POST", "/instances/unplanned", token, `{"title":"Звонок","actual_start":"2026-10-14T08:00:00Z","actual_end":"2026-10-14T08:30:00Z"}`)

	code, out := api.stats(token, "2026-10-13T21:00:00Z", "2026-10-14T21:00:00Z") // the 14th in Moscow
	if code != http.StatusOK {
		t.Fatalf("status %d, body %v", code, out)
	}
	if out["actual_minutes"] != 90.0 || out["planned_minutes"] != 60.0 || out["unplanned_minutes"] != 30.0 || out["uncategorized_minutes"] != 30.0 {
		t.Errorf("report = %v", out)
	}
	cats := out["categories"].([]any)
	if len(cats) != 1 || cats[0].(map[string]any)["category_id"] != cat || cats[0].(map[string]any)["minutes"] != 60.0 {
		t.Errorf("categories = %v", cats)
	}
	days := out["days"].([]any)
	if len(days) != 1 || days[0].(map[string]any)["date"] != "2026-10-14" {
		t.Fatalf("days = %v", days)
	}
	byCat := days[0].(map[string]any)["by_category"].([]any)
	if len(byCat) != 2 {
		t.Errorf("by_category = %v", byCat)
	}
	// A task without a category has a null category id, never a zero uuid.
	var nulls int
	for _, c := range byCat {
		if c.(map[string]any)["category_id"] == nil {
			nulls++
		}
	}
	if nulls != 1 {
		t.Errorf("by_category = %v, want one null category", byCat)
	}
	pf := out["plan_vs_fact"].(map[string]any)
	if pf["done"] != 1.0 || pf["planned_count"] != 1.0 || pf["percent_done"] != 100.0 {
		t.Errorf("plan_vs_fact = %v", pf)
	}
	// Lists are arrays, never null.
	for _, k := range []string{"tasks", "deviations", "categories"} {
		if _, ok := out[k].([]any); !ok {
			t.Errorf("%s = %#v, want an array", k, out[k])
		}
	}
}

func TestStatsEmptyPeriodHasNoNulls(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	code, out := api.stats(token, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z")
	if code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	for _, k := range []string{"categories", "tasks", "days", "deviations"} {
		if _, ok := out[k].([]any); !ok {
			t.Errorf("%s = %#v, want an array", k, out[k])
		}
	}
	if pf := out["plan_vs_fact"].(map[string]any); pf["percent_done"] != nil {
		t.Errorf("percent_done = %v, want null", pf["percent_done"])
	}
}

func TestStatsValidationAndAccess(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	api.task(a, "Моё", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z")

	if code, _ := api.stats("", "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); code != http.StatusUnauthorized {
		t.Errorf("without a session: status %d", code)
	}
	for _, q := range []string{"", "?from=2026-10-14T00:00:00Z", "?from=bad&to=2026-10-15T00:00:00Z",
		"?from=2026-10-15T00:00:00Z&to=2026-10-14T00:00:00Z", "?from=2025-01-01T00:00:00Z&to=2026-12-31T00:00:00Z"} {
		if code, _ := api.do("GET", "/stats"+q, a, ""); code != http.StatusBadRequest {
			t.Errorf("GET /stats%s: status %d, want 400", q, code)
		}
	}
	if code, out := api.stats(b, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); code != http.StatusOK || out["planned_minutes"] != 0.0 {
		t.Errorf("another user: status %d, body %v", code, out)
	}
}

func TestRunningTimers(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")

	first := api.task(a, "Первое", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z")
	// Started on an earlier day, still running: found whatever the day.
	api.do("POST", "/instances/unplanned", a, `{"title":"Давно","actual_start":"2026-10-10T08:00:00Z"}`)
	api.do("POST", "/instances/"+first+"/start", a, "")
	api.task(a, "Не запущено", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z")

	list := api.getArray("/instances/running", a)
	if len(list) != 2 || list[0]["title"] != "Давно" || list[1]["title"] != "Первое" {
		t.Fatalf("running = %v, want the two timers, the longest first", list)
	}
	if list[0]["status"] != "in_progress" {
		t.Errorf("status = %v", list[0]["status"])
	}
	if got := api.getArray("/instances/running", b); len(got) != 0 {
		t.Errorf("another user sees %v", got)
	}

	api.do("POST", "/instances/"+first+"/stop", a, "")
	if got := api.getArray("/instances/running", a); len(got) != 1 {
		t.Errorf("after a stop: %v", got)
	}
	if code, _ := api.do("GET", "/instances/running", "", ""); code != http.StatusUnauthorized {
		t.Errorf("without a session: status %d", code)
	}
}
