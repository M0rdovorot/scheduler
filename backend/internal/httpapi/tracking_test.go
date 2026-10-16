package httpapi

import (
	"fmt"
	"net/http"
	"testing"
	"time"
)

func (a *testAPI) task(token, title, start, end string) string {
	a.t.Helper()
	return a.createTask(token, title, start, end, "")["id"].(string)
}

func TestTrackingFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	id := api.task(token, "Спорт", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z")

	// Done in one tap: the fact equals the plan.
	code, out := api.do("POST", "/instances/"+id+"/complete", token, "")
	if code != http.StatusOK || out["status"] != "done" || out["actual_start"] != "2026-10-14T10:00:00Z" || out["actual_end"] != "2026-10-14T11:00:00Z" {
		t.Fatalf("complete: status %d, body %v", code, out)
	}
	if devs, ok := out["deviations"].([]any); !ok || len(devs) != 0 {
		t.Errorf("deviations = %#v, want []", out["deviations"])
	}

	// Edit the fact by hand: 25 minutes late and 20 minutes over.
	code, out = api.do("PATCH", "/instances/"+id+"/tracking", token,
		`{"actual_start":"2026-10-14T10:25:00Z","actual_end":"2026-10-14T11:20:00Z","comment":"пробки"}`)
	if code != http.StatusOK || out["comment"] != "пробки" {
		t.Fatalf("tracking: status %d, body %v", code, out)
	}
	devs := out["deviations"].([]any)
	got := map[string]float64{}
	for _, d := range devs {
		m := d.(map[string]any)
		got[m["kind"].(string)] = m["minutes"].(float64)
	}
	// The default threshold is 10 minutes; the duration (55 vs 60) is within it.
	if fmt.Sprint(got) != fmt.Sprint(map[string]float64{"started_late": 25, "finished_late": 20}) {
		t.Errorf("deviations = %v", got)
	}

	// Remove the mark.
	code, out = api.do("PATCH", "/instances/"+id+"/tracking", token, `{"status":"planned"}`)
	if code != http.StatusOK || out["status"] != "planned" || out["actual_start"] != nil || out["comment"] != "пробки" {
		t.Errorf("reset: status %d, body %v", code, out)
	}
}

func TestTimerFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	id := api.task(token, "Спорт", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z")

	before := time.Now().Add(-time.Second)
	code, out := api.do("POST", "/instances/"+id+"/start", token, "")
	if code != http.StatusOK || out["status"] != "in_progress" || out["actual_end"] != nil {
		t.Fatalf("start: status %d, body %v", code, out)
	}
	startedAt, err := time.Parse(time.RFC3339Nano, out["actual_start"].(string))
	if err != nil || startedAt.Before(before) || startedAt.After(time.Now().Add(time.Second)) {
		t.Errorf("actual_start = %v, want about now", out["actual_start"])
	}

	if code, out = api.do("POST", "/instances/"+id+"/start", token, ""); code != http.StatusBadRequest || out["code"] != "invalid_state" {
		t.Errorf("second start: status %d, body %v", code, out)
	}
	code, out = api.do("POST", "/instances/"+id+"/stop", token, "")
	if code != http.StatusOK || out["status"] != "done" || out["actual_end"] == nil {
		t.Errorf("stop: status %d, body %v", code, out)
	}
	if code, out = api.do("POST", "/instances/"+id+"/stop", token, ""); code != http.StatusBadRequest || out["code"] != "invalid_state" {
		t.Errorf("second stop: status %d, body %v", code, out)
	}
}

func TestRescheduleFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	cat := api.createCat(token, "Работа", nil)
	src := api.createTask(token, "Планёрка", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", fmt.Sprintf(`,"category_ids":[%q]`, cat))["id"].(string)

	code, moved := api.do("POST", "/instances/"+src+"/reschedule", token,
		`{"planned_start":"2026-10-15T12:00:00Z","planned_end":"2026-10-15T13:00:00Z","comment":"совещание"}`)
	if code != http.StatusCreated {
		t.Fatalf("reschedule: status %d, body %v", code, moved)
	}
	from := moved["rescheduled_from"].(map[string]any)
	if from["id"] != src || moved["status"] != "planned" || moved["planned_start"] != "2026-10-15T12:00:00Z" {
		t.Errorf("new task = %v", moved)
	}
	if ids := moved["category_ids"].([]any); len(ids) != 1 || ids[0] != cat {
		t.Errorf("category_ids = %v", moved["category_ids"])
	}

	list := api.listTasks(token, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z")
	if len(list) != 1 || list[0]["status"] != "rescheduled" || list[0]["comment"] != "совещание" {
		t.Fatalf("original = %v", list)
	}
	to := list[0]["rescheduled_to"].(map[string]any)
	if to["id"] != moved["id"] || to["planned_start"] != "2026-10-15T12:00:00Z" {
		t.Errorf("rescheduled_to = %v", to)
	}

	if code, out := api.do("POST", "/instances/"+src+"/reschedule", token, `{"planned_start":"2026-10-16T12:00:00Z","planned_end":"2026-10-16T13:00:00Z"}`); code != http.StatusBadRequest || out["code"] != "invalid_state" {
		t.Errorf("second reschedule: status %d, body %v", code, out)
	}
	if code, _ := api.do("POST", "/instances/"+src+"/reschedule", token, `{"planned_start":"2026-10-16T13:00:00Z","planned_end":"2026-10-16T12:00:00Z"}`); code != http.StatusBadRequest {
		t.Errorf("backwards: status %d", code)
	}
}

func TestUnplannedFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")

	code, out := api.do("POST", "/instances/unplanned", token,
		`{"title":"Звонок","actual_start":"2026-10-14T08:00:00Z","actual_end":"2026-10-14T08:20:00Z"}`)
	if code != http.StatusCreated || out["status"] != "done" || out["planned_start"] != nil || out["planned_end"] != nil {
		t.Fatalf("back-dated: status %d, body %v", code, out)
	}
	list := api.listTasks(token, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z")
	if len(list) != 1 || list[0]["title"] != "Звонок" {
		t.Errorf("list = %v", list)
	}

	code, out = api.do("POST", "/instances/unplanned", token, `{"title":"Таймер"}`)
	if code != http.StatusCreated || out["status"] != "in_progress" || out["actual_start"] == nil || out["actual_end"] != nil {
		t.Errorf("timer: status %d, body %v", code, out)
	}
	if code, _ := api.do("POST", "/instances/unplanned", token, `{"title":""}`); code != http.StatusBadRequest {
		t.Errorf("empty title: status %d", code)
	}
	if code, _ := api.do("POST", "/instances/unplanned", token, `{"title":"x","actual_start":"2026-10-14T09:00:00Z","actual_end":"2026-10-14T08:00:00Z"}`); code != http.StatusBadRequest {
		t.Errorf("backwards fact: status %d", code)
	}
}

func TestTrackingValidationAndIsolation(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	id := api.task(a, "Моё", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z")

	for _, body := range []string{
		`{"status":"finished"}`,
		`{"status":"planned","actual_start":"2026-10-14T10:00:00Z"}`,
		`{"actual_start":"2026-10-14T11:00:00Z","actual_end":"2026-10-14T10:00:00Z"}`,
		`{"actual_start":"yesterday"}`,
	} {
		if code, _ := api.do("PATCH", "/instances/"+id+"/tracking", a, body); code != http.StatusBadRequest {
			t.Errorf("PATCH tracking %s: status %d, want 400", body, code)
		}
	}

	for _, tt := range []struct{ method, path, body string }{
		{"POST", "/instances/" + id + "/complete", ""},
		{"POST", "/instances/" + id + "/start", ""},
		{"POST", "/instances/" + id + "/stop", ""},
		{"PATCH", "/instances/" + id + "/tracking", `{"comment":"x"}`},
		{"POST", "/instances/" + id + "/reschedule", `{"planned_start":"2026-10-16T12:00:00Z","planned_end":"2026-10-16T13:00:00Z"}`},
	} {
		if code, _ := api.do(tt.method, tt.path, b, tt.body); code != http.StatusNotFound {
			t.Errorf("%s %s by another user: status %d, want 404", tt.method, tt.path, code)
		}
		if code, _ := api.do(tt.method, tt.path, "", tt.body); code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: status %d, want 401", tt.method, tt.path, code)
		}
	}
	if code, _ := api.do("POST", "/instances/unplanned", "", `{"title":"x"}`); code != http.StatusUnauthorized {
		t.Errorf("unplanned without a session: status %d", code)
	}
	// And nothing changed.
	if list := api.listTasks(a, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); len(list) != 1 || list[0]["status"] != "planned" {
		t.Errorf("task changed: %v", list)
	}
}
