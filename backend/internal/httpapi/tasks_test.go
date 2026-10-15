package httpapi

import (
	"fmt"
	"net/http"
	"net/url"
	"testing"
)

func taskBody(title, start, end string, extra string) string {
	return fmt.Sprintf(`{"title":%q,"planned_start":%q,"planned_end":%q%s}`, title, start, end, extra)
}

func (a *testAPI) createTask(token, title, start, end string, extra string) map[string]any {
	a.t.Helper()
	code, out := a.do("POST", "/tasks", token, taskBody(title, start, end, extra))
	if code != http.StatusCreated {
		a.t.Fatalf("create task %q: status %d, body %v", title, code, out)
	}
	return out
}

func (a *testAPI) listTasks(token, from, to string) []map[string]any {
	a.t.Helper()
	return a.getArray("/instances?from="+url.QueryEscape(from)+"&to="+url.QueryEscape(to), token)
}

func TestTasksRequireSession(t *testing.T) {
	api := newTestAPI(t, true)
	id := "00000000-0000-0000-0000-000000000001"
	for _, tt := range []struct{ method, path, body string }{
		{"GET", "/instances?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z", ""},
		{"POST", "/tasks", taskBody("x", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", "")},
		{"PATCH", "/instances/" + id, `{"title":"x"}`},
		{"DELETE", "/instances/" + id, ""},
	} {
		if code, _ := api.do(tt.method, tt.path, "", tt.body); code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: status %d, want 401", tt.method, tt.path, code)
		}
	}
}

func TestTaskFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	cat := api.createCat(token, "Работа", nil)

	created := api.createTask(token, "Планёрка", "2026-10-14T10:00:00+03:00", "2026-10-14T11:30:00+03:00",
		fmt.Sprintf(`,"description":"обсудить","category_ids":[%q]`, cat))
	id := created["id"].(string)
	// Instants come back in UTC.
	if created["planned_start"] != "2026-10-14T07:00:00Z" || created["planned_end"] != "2026-10-14T08:30:00Z" {
		t.Errorf("times = %v – %v", created["planned_start"], created["planned_end"])
	}
	if created["status"] != "planned" || created["description"] != "обсудить" {
		t.Errorf("task = %v", created)
	}
	if ids, _ := created["category_ids"].([]any); len(ids) != 1 || ids[0] != cat {
		t.Errorf("category_ids = %v", created["category_ids"])
	}

	// Without categories the field is an empty array, never null.
	bare := api.createTask(token, "Без категорий", "2026-10-14T12:00:00Z", "2026-10-14T13:00:00Z", "")
	if ids, ok := bare["category_ids"].([]any); !ok || len(ids) != 0 {
		t.Errorf("category_ids = %#v, want []", bare["category_ids"])
	}

	list := api.listTasks(token, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z")
	if len(list) != 2 || list[0]["id"] != id {
		t.Fatalf("list = %v", list)
	}

	code, out := api.do("PATCH", "/instances/"+id, token, `{"title":"Планёрка 2","planned_end":"2026-10-14T09:00:00Z","category_ids":[]}`)
	if code != http.StatusOK || out["title"] != "Планёрка 2" || out["planned_end"] != "2026-10-14T09:00:00Z" {
		t.Errorf("PATCH: status %d, body %v", code, out)
	}
	if ids, _ := out["category_ids"].([]any); len(ids) != 0 {
		t.Errorf("category_ids after clear = %v", out["category_ids"])
	}
	if out["description"] != "обсудить" {
		t.Errorf("description changed: %v", out["description"])
	}

	if code, _ := api.do("DELETE", "/instances/"+id, token, ""); code != http.StatusNoContent {
		t.Errorf("DELETE: status %d", code)
	}
	if code, _ := api.do("DELETE", "/instances/"+id, token, ""); code != http.StatusNotFound {
		t.Errorf("second DELETE: status %d, want 404", code)
	}
	if list := api.listTasks(token, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); len(list) != 1 {
		t.Errorf("after delete: %v", list)
	}
}

func TestTaskCrossingMidnightAppearsOnBothDays(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	api.createTask(token, "Ночь", "2026-10-14T22:00:00Z", "2026-10-15T06:00:00Z", "")

	for _, day := range [][2]string{
		{"2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"},
		{"2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z"},
	} {
		if list := api.listTasks(token, day[0], day[1]); len(list) != 1 {
			t.Errorf("%s: %d tasks, want the night task", day[0], len(list))
		}
	}
	if list := api.listTasks(token, "2026-10-13T00:00:00Z", "2026-10-14T00:00:00Z"); len(list) != 0 {
		t.Errorf("previous day shows %d tasks", len(list))
	}
}

func TestOverlappingTasksAreAllowed(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	api.createTask(token, "A", "2026-10-14T10:00:00Z", "2026-10-14T12:00:00Z", "")
	api.createTask(token, "B", "2026-10-14T10:00:00Z", "2026-10-14T12:00:00Z", "")
	api.createTask(token, "C", "2026-10-14T11:00:00Z", "2026-10-14T11:30:00Z", "")
	if list := api.listTasks(token, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); len(list) != 3 {
		t.Errorf("got %d tasks, want 3", len(list))
	}
}

func TestTaskValidationErrors(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	foreign := api.createCat(api.devLogin("b"), "Чужая", nil)

	tests := []struct {
		name, body, field string
	}{
		{"empty title", taskBody("", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", ""), "title"},
		{"end before start", taskBody("x", "2026-10-14T10:00:00Z", "2026-10-14T09:00:00Z", ""), "planned_end"},
		{"empty interval", taskBody("x", "2026-10-14T10:00:00Z", "2026-10-14T10:00:00Z", ""), "planned_end"},
		{"foreign category", taskBody("x", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", fmt.Sprintf(`,"category_ids":[%q]`, foreign)), "category_ids"},
	}
	for _, tt := range tests {
		code, out := api.do("POST", "/tasks", token, tt.body)
		if code != http.StatusBadRequest || out["code"] != "validation_failed" || out["field"] != tt.field {
			t.Errorf("%s: status %d, body %v, want 400 on %q", tt.name, code, out, tt.field)
		}
	}
	for _, body := range []string{
		`{"title":"x"}`, // missing times
		`{"title":"x","planned_start":"yesterday","planned_end":"2026-10-14T11:00:00Z"}`,
		`{"title":"x","planned_start":"2026-10-14T10:00:00Z","planned_end":"2026-10-14T11:00:00Z","category_ids":["nope"]}`,
	} {
		if code, _ := api.do("POST", "/tasks", token, body); code != http.StatusBadRequest {
			t.Errorf("POST %s: status %d, want 400", body, code)
		}
	}

	// Range query.
	for _, q := range []string{
		"", "?from=2026-10-14T00:00:00Z", "?from=bad&to=2026-10-15T00:00:00Z",
		"?from=2026-10-15T00:00:00Z&to=2026-10-14T00:00:00Z",
		"?from=2026-01-01T00:00:00Z&to=2026-12-31T00:00:00Z", // over 100 days
	} {
		if code, _ := api.do("GET", "/instances"+q, token, ""); code != http.StatusBadRequest {
			t.Errorf("GET /instances%s: status %d, want 400", q, code)
		}
	}
}

func TestTasksAreIsolatedBetweenUsers(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	mine := api.createTask(a, "Моё", "2026-10-14T10:00:00Z", "2026-10-14T11:00:00Z", "")["id"].(string)

	if list := api.listTasks(b, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); len(list) != 0 {
		t.Errorf("user B sees %v", list)
	}
	if code, _ := api.do("PATCH", "/instances/"+mine, b, `{"title":"hacked"}`); code != http.StatusNotFound {
		t.Errorf("PATCH by another user: status %d, want 404", code)
	}
	if code, _ := api.do("DELETE", "/instances/"+mine, b, ""); code != http.StatusNotFound {
		t.Errorf("DELETE by another user: status %d, want 404", code)
	}
	if list := api.listTasks(a, "2026-10-14T00:00:00Z", "2026-10-15T00:00:00Z"); len(list) != 1 || list[0]["title"] != "Моё" {
		t.Errorf("task was changed: %v", list)
	}
}
