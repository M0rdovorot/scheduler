package httpapi

import (
	"net/http"
	"testing"
)

func TestGlobalReminders(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")

	code, g := api.do("GET", "/reminders/global", token, "")
	if code != http.StatusOK || g["enabled"] != true || g["quiet_hours"] != nil {
		t.Fatalf("defaults: %d %v", code, g)
	}
	rules := g["rules"].([]any)
	if len(rules) != 2 {
		t.Fatalf("default rules = %v", rules)
	}
	kinds := map[string]float64{}
	for _, r := range rules {
		m := r.(map[string]any)
		kinds[m["kind"].(string)] = m["offset_minutes"].(float64)
		if m["time_of_day"] != nil {
			t.Errorf("time_of_day of a task rule = %v", m["time_of_day"])
		}
	}
	if kinds["before_start"] != 10 || kinds["after_end"] != 0 {
		t.Errorf("default rules = %v", kinds)
	}

	body := `{"enabled":true,"quiet_hours":{"start":"23:00","end":"08:00"},"rules":[{"kind":"before_start","offset_minutes":1440},{"kind":"before_start","offset_minutes":10},{"kind":"not_started","offset_minutes":15}]}`
	code, got := api.do("PUT", "/reminders/global", token, body)
	if code != http.StatusOK {
		t.Fatalf("put: %d %v", code, got)
	}
	q := got["quiet_hours"].(map[string]any)
	if q["start"] != "23:00" || q["end"] != "08:00" || len(got["rules"].([]any)) != 3 {
		t.Errorf("saved = %v", got)
	}

	// Off, and without quiet hours.
	code, got = api.do("PUT", "/reminders/global", token, `{"enabled":false,"quiet_hours":null,"rules":[]}`)
	if code != http.StatusOK || got["enabled"] != false || got["quiet_hours"] != nil || len(got["rules"].([]any)) != 0 {
		t.Errorf("switched off: %d %v", code, got)
	}

	for name, bad := range map[string]string{
		"same quiet times": `{"enabled":true,"quiet_hours":{"start":"23:00","end":"23:00"},"rules":[]}`,
		"bad time":         `{"enabled":true,"quiet_hours":{"start":"25:00","end":"08:00"},"rules":[]}`,
		"habit rule":       `{"enabled":true,"quiet_hours":null,"rules":[{"kind":"habit_time","time_of_day":"21:00"}]}`,
		"no offset":        `{"enabled":true,"quiet_hours":null,"rules":[{"kind":"before_start"}]}`,
		"time on a task":   `{"enabled":true,"quiet_hours":null,"rules":[{"kind":"before_start","offset_minutes":5,"time_of_day":"21:00"}]}`,
		"offset too large": `{"enabled":true,"quiet_hours":null,"rules":[{"kind":"after_end","offset_minutes":20000}]}`,
		"unknown kind":     `{"enabled":true,"quiet_hours":null,"rules":[{"kind":"daily","offset_minutes":1}]}`,
	} {
		if code, out := api.do("PUT", "/reminders/global", token, bad); code != http.StatusBadRequest {
			t.Errorf("%s: status %d, body %v", name, code, out)
		}
	}
	// A failed save changed nothing.
	_, got = api.do("GET", "/reminders/global", token, "")
	if got["enabled"] != false {
		t.Errorf("a rejected save changed the settings: %v", got)
	}
}

func TestReminderLevels(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	work := api.createCat(token, "Работа", nil)
	proj := api.createCat(token, "Проект", work)
	id := api.createTask(token, "Дело", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z", `,"category_ids":["`+proj+`"]`)["id"].(string)

	// Nothing of its own: the global rules apply.
	code, lv := api.do("GET", "/reminders/instance/"+id, token, "")
	eff := lv["effective"].(map[string]any)
	if code != http.StatusOK || lv["override"] != nil || eff["source"] != "global" || len(eff["rules"].([]any)) != 2 {
		t.Fatalf("instance: %d %v", code, lv)
	}

	// The parent category gets its own; the subcategory and the task inherit it.
	code, lv = api.do("PUT", "/reminders/category/"+work, token, `{"enabled":true,"rules":[{"kind":"before_start","offset_minutes":60}]}`)
	if code != http.StatusOK || lv["override"].(map[string]any)["enabled"] != true {
		t.Fatalf("put category: %d %v", code, lv)
	}
	_, lv = api.do("GET", "/reminders/category/"+proj, token, "")
	if lv["override"] != nil || lv["effective"].(map[string]any)["source"] != "category" {
		t.Errorf("subcategory = %v", lv)
	}
	_, lv = api.do("GET", "/reminders/instance/"+id, token, "")
	rules := lv["effective"].(map[string]any)["rules"].([]any)
	if lv["effective"].(map[string]any)["source"] != "category" || len(rules) != 1 || rules[0].(map[string]any)["offset_minutes"] != 60.0 {
		t.Errorf("instance = %v", lv)
	}

	// Switched off on the occurrence; then inheriting again.
	code, lv = api.do("PUT", "/reminders/instance/"+id, token, `{"enabled":false,"rules":[]}`)
	if code != http.StatusOK || lv["effective"].(map[string]any)["source"] != "instance" || len(lv["effective"].(map[string]any)["rules"].([]any)) != 0 {
		t.Errorf("switched off: %d %v", code, lv)
	}
	code, lv = api.do("DELETE", "/reminders/instance/"+id, token, "")
	if code != http.StatusOK || lv["override"] != nil || lv["effective"].(map[string]any)["source"] != "category" {
		t.Errorf("delete: %d %v", code, lv)
	}

	// A habit takes times of day only.
	_, h := api.do("POST", "/habits", token, `{"title":"Вода","kind":"boolean","frequency":"daily","color":"#3b82f6"}`)
	hid := h["id"].(string)
	code, lv = api.do("PUT", "/reminders/habit/"+hid, token, `{"enabled":true,"rules":[{"kind":"habit_time","time_of_day":"21:30"}]}`)
	r := lv["effective"].(map[string]any)["rules"].([]any)
	if code != http.StatusOK || len(r) != 1 || r[0].(map[string]any)["time_of_day"] != "21:30" || r[0].(map[string]any)["offset_minutes"] != nil {
		t.Errorf("habit: %d %v", code, lv)
	}
	if code, _ := api.do("PUT", "/reminders/habit/"+hid, token, `{"enabled":true,"rules":[{"kind":"before_start","offset_minutes":5}]}`); code != http.StatusBadRequest {
		t.Errorf("task rule on a habit: %d", code)
	}
	if code, _ := api.do("PUT", "/reminders/category/"+work, token, `{"enabled":true,"rules":[{"kind":"habit_time","time_of_day":"21:30"}]}`); code != http.StatusBadRequest {
		t.Errorf("habit rule on a category: %d", code)
	}
}

func TestReminderLevelsOfOtherUsersAndUnknownScopes(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	cat := api.createCat(a, "Работа", nil)
	id := api.createTask(a, "Дело", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z", "")["id"].(string)
	_, h := api.do("POST", "/habits", a, `{"title":"Вода","kind":"boolean","frequency":"daily","color":"#3b82f6"}`)

	for _, c := range []struct{ scope, id string }{
		{"category", cat}, {"instance", id}, {"habit", h["id"].(string)}, {"series", id},
		{"category", "00000000-0000-0000-0000-000000000001"},
		{"global", cat}, {"bogus", cat},
	} {
		path := "/reminders/" + c.scope + "/" + c.id
		for _, m := range []struct{ method, body string }{
			{"GET", ""}, {"PUT", `{"enabled":true,"rules":[]}`}, {"DELETE", ""},
		} {
			if code, _ := api.do(m.method, path, b, m.body); code != http.StatusNotFound {
				t.Errorf("%s %s: status %d, want 404", m.method, path, code)
			}
		}
	}
	if code, _ := api.do("GET", "/reminders/global", "", ""); code != http.StatusUnauthorized {
		t.Errorf("without a session: %d", code)
	}
	// The owner still sees theirs.
	if code, _ := api.do("GET", "/reminders/category/"+cat, a, ""); code != http.StatusOK {
		t.Errorf("owner: %d", code)
	}
}
