package httpapi

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

// createCat creates a category through the API and returns its id.
func (a *testAPI) createCat(token, name string, parent any) string {
	a.t.Helper()
	body := fmt.Sprintf(`{"name":%q,"color":"#3b82f6"`, name)
	if parent != nil {
		body += fmt.Sprintf(`,"parent_id":%q`, parent)
	}
	code, out := a.do("POST", "/categories", token, body+"}")
	if code != http.StatusCreated {
		a.t.Fatalf("create %q: status %d, body %v", name, code, out)
	}
	return out["id"].(string)
}

func (a *testAPI) listCats(token string) []map[string]any {
	a.t.Helper()
	req := httptest.NewRequestWithContext(a.t.Context(), "GET", "/api/v1/categories", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	a.handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		a.t.Fatalf("list categories: status %d, body %s", rec.Code, rec.Body)
	}
	var out []map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		a.t.Fatalf("list categories: not a JSON array: %q", rec.Body)
	}
	return out
}

func TestCategoriesRequireSession(t *testing.T) {
	api := newTestAPI(t, true)
	id := "00000000-0000-0000-0000-000000000001"
	for _, tt := range []struct{ method, path, body string }{
		{"GET", "/categories", ""},
		{"POST", "/categories", `{"name":"x","color":"#aabbcc"}`},
		{"PATCH", "/categories/" + id, `{"name":"x"}`},
		{"DELETE", "/categories/" + id, ""},
		{"POST", "/categories/" + id + "/move", `{}`},
		{"POST", "/categories/" + id + "/archive", ""},
		{"POST", "/categories/" + id + "/unarchive", ""},
	} {
		if code, _ := api.do(tt.method, tt.path, "", tt.body); code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: status %d, want 401", tt.method, tt.path, code)
		}
	}
}

func TestCategoriesFlow(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")

	sport := api.createCat(token, "Спорт", nil)
	run := api.createCat(token, "Бег", sport)

	cats := api.listCats(token)
	if len(cats) != 2 {
		t.Fatalf("list = %v", cats)
	}
	byID := map[string]map[string]any{}
	for _, c := range cats {
		byID[c["id"].(string)] = c
	}
	if byID[sport]["parent_id"] != nil || byID[run]["parent_id"] != sport {
		t.Errorf("parents: sport=%v run=%v", byID[sport]["parent_id"], byID[run]["parent_id"])
	}
	if byID[sport]["archived_at"] != nil || byID[sport]["color"] != "#3b82f6" {
		t.Errorf("sport = %v", byID[sport])
	}

	// Rename and recolor.
	code, out := api.do("PATCH", "/categories/"+run, token, `{"name":"Пробежка","color":"#FF0000"}`)
	if code != http.StatusOK || out["name"] != "Пробежка" || out["color"] != "#ff0000" {
		t.Errorf("PATCH: status %d, body %v", code, out)
	}

	// Move to the top level (no parent_id) and back.
	code, out = api.do("POST", "/categories/"+run+"/move", token, `{}`)
	if code != http.StatusOK || out["parent_id"] != nil {
		t.Errorf("move to top: status %d, body %v", code, out)
	}
	code, out = api.do("POST", "/categories/"+run+"/move", token, fmt.Sprintf(`{"parent_id":%q}`, sport))
	if code != http.StatusOK || out["parent_id"] != sport {
		t.Errorf("move under sport: status %d, body %v", code, out)
	}

	// Cycle.
	code, out = api.do("POST", "/categories/"+sport+"/move", token, fmt.Sprintf(`{"parent_id":%q}`, run))
	if code != http.StatusBadRequest || out["code"] != "category_cycle" || out["field"] != "parent_id" {
		t.Errorf("cycle: status %d, body %v", code, out)
	}

	// Archive the parent: the subtree follows; the child cannot be restored alone.
	code, out = api.do("POST", "/categories/"+sport+"/archive", token, "")
	if code != http.StatusOK || out["archived_at"] == nil {
		t.Errorf("archive: status %d, body %v", code, out)
	}
	for _, c := range api.listCats(token) {
		if c["archived_at"] == nil {
			t.Errorf("%v is not archived", c["name"])
		}
	}
	code, out = api.do("POST", "/categories/"+run+"/unarchive", token, "")
	if code != http.StatusBadRequest || out["code"] != "parent_archived" {
		t.Errorf("unarchive child: status %d, body %v", code, out)
	}
	code, out = api.do("POST", "/categories/"+sport+"/unarchive", token, "")
	if code != http.StatusOK || out["archived_at"] != nil {
		t.Errorf("unarchive parent: status %d, body %v", code, out)
	}

	// Delete removes the subtree.
	if code, _ := api.do("DELETE", "/categories/"+sport, token, ""); code != http.StatusNoContent {
		t.Errorf("DELETE: status %d, want 204", code)
	}
	if cats := api.listCats(token); len(cats) != 0 {
		t.Errorf("after delete: %v", cats)
	}
	if code, _ := api.do("DELETE", "/categories/"+sport, token, ""); code != http.StatusNotFound {
		t.Errorf("second DELETE: status %d, want 404", code)
	}
}

func TestCategoryValidationErrors(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")

	for _, body := range []string{
		`{"name":"","color":"#aabbcc"}`,
		`{"name":"x","color":"blue"}`,
		`{"name":"x","color":"#aabbcc","parent_id":"00000000-0000-0000-0000-000000000009"}`,
	} {
		code, out := api.do("POST", "/categories", token, body)
		if code != http.StatusBadRequest || out["code"] != "validation_failed" || out["field"] == nil {
			t.Errorf("POST %s: status %d, body %v", body, code, out)
		}
	}
	if code, _ := api.do("POST", "/categories", token, `{"name":"x"}`); code != http.StatusBadRequest {
		t.Errorf("missing color: status %d, want 400", code)
	}
	if code, _ := api.do("PATCH", "/categories/not-a-uuid", token, `{}`); code != http.StatusBadRequest {
		t.Errorf("bad id: status %d, want 400", code)
	}
}

func TestCategoriesAreIsolatedBetweenUsers(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	mine := api.createCat(a, "Моя", nil)

	if cats := api.listCats(b); len(cats) != 0 {
		t.Errorf("user B sees %v", cats)
	}
	for _, tt := range []struct{ method, path, body string }{
		{"PATCH", "/categories/" + mine, `{"name":"hacked"}`},
		{"DELETE", "/categories/" + mine, ""},
		{"POST", "/categories/" + mine + "/move", `{}`},
		{"POST", "/categories/" + mine + "/archive", ""},
		{"POST", "/categories/" + mine + "/unarchive", ""},
	} {
		if code, _ := api.do(tt.method, tt.path, b, tt.body); code != http.StatusNotFound {
			t.Errorf("%s %s by another user: status %d, want 404", tt.method, tt.path, code)
		}
	}
	if code, _ := api.do("POST", "/categories", b, fmt.Sprintf(`{"name":"x","color":"#aabbcc","parent_id":%q}`, mine)); code != http.StatusBadRequest {
		t.Errorf("child under another user's category: status %d, want 400", code)
	}
	cats := api.listCats(a)
	if len(cats) != 1 || cats[0]["name"] != "Моя" || cats[0]["archived_at"] != nil {
		t.Errorf("category was changed: %v", cats)
	}
}
