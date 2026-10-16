package httpapi

import (
	"net/http"
	"testing"
	"time"
)

const dailyHabit = `{"title":"Читать","kind":"boolean","frequency":"daily","color":"#3b82f6"}`

// today is the local date of the user in Moscow, the same the server works out.
func today() time.Time {
	msk, _ := time.LoadLocation("Europe/Moscow")
	y, m, d := time.Now().In(msk).Date()
	return time.Date(y, m, d, 0, 0, 0, 0, time.UTC)
}

func ymd(t time.Time) string { return t.Format(time.DateOnly) }

func TestHabitLifecycle(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")

	code, h := api.do("POST", "/habits", token, `{"title":"Вода","kind":"quantity","target_value":8,"unit":"стаканов","frequency":"weekdays","weekdays":[1,3,5],"color":"#3b82f6"}`)
	if code != http.StatusCreated {
		t.Fatalf("create: %d %v", code, h)
	}
	id := h["id"].(string)
	if h["target_value"] != 8.0 || h["unit"] != "стаканов" || h["placement"] != nil || h["archived_at"] != nil || h["times_per_week"] != nil {
		t.Errorf("habit = %v", h)
	}
	if w := h["weekdays"].([]any); len(w) != 3 {
		t.Errorf("weekdays = %v", w)
	}

	// Lists are arrays, and a habit with no weekdays has an empty array, never null.
	api.do("POST", "/habits", token, dailyHabit)
	list := api.getArray("/habits", token)
	if len(list) != 2 {
		t.Fatalf("list = %v", list)
	}
	if _, ok := list[1]["weekdays"].([]any); !ok {
		t.Errorf("weekdays = %#v, want an array", list[1]["weekdays"])
	}

	code, got := api.do("PATCH", "/habits/"+id, token, `{"title":"Вода дома","target_value":10,"frequency":"times_per_week","times_per_week":4}`)
	if code != http.StatusOK || got["title"] != "Вода дома" || got["target_value"] != 10.0 || got["times_per_week"] != 4.0 || len(got["weekdays"].([]any)) != 0 {
		t.Errorf("patch: %d %v", code, got)
	}
	if code, out := api.do("PATCH", "/habits/"+id, token, `{"weekdays":[1]}`); code != http.StatusBadRequest {
		t.Errorf("weekdays without frequency: %d %v", code, out)
	}

	code, got = api.do("POST", "/habits/"+id+"/archive", token, "")
	if code != http.StatusOK || got["archived_at"] == nil {
		t.Errorf("archive: %d %v", code, got)
	}
	code, got = api.do("POST", "/habits/"+id+"/unarchive", token, "")
	if code != http.StatusOK || got["archived_at"] != nil {
		t.Errorf("unarchive: %d %v", code, got)
	}
	if code, _ := api.do("DELETE", "/habits/"+id, token, ""); code != http.StatusNoContent {
		t.Errorf("delete: %d", code)
	}
	if code, _ := api.do("GET", "/habits/"+id, token, ""); code != http.StatusNotFound {
		t.Errorf("get after delete: %d", code)
	}
}

func TestHabitValidation(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	for name, body := range map[string]string{
		"no title":      `{"title":" ","kind":"boolean","frequency":"daily","color":"#3b82f6"}`,
		"no weekdays":   `{"title":"a","kind":"boolean","frequency":"weekdays","color":"#3b82f6"}`,
		"quantity goal": `{"title":"a","kind":"quantity","frequency":"daily","color":"#3b82f6"}`,
		"weekly grid":   `{"title":"a","kind":"boolean","frequency":"times_per_week","times_per_week":2,"color":"#3b82f6","placement":{"time":"07:00","duration_minutes":10}}`,
		"unknown kind":  `{"title":"a","kind":"x","frequency":"daily","color":"#3b82f6"}`,
	} {
		if code, out := api.do("POST", "/habits", token, body); code != http.StatusBadRequest {
			t.Errorf("%s: status %d, body %v", name, code, out)
		}
	}
	if list := api.getArray("/habits", token); len(list) != 0 {
		t.Errorf("rejected habits were stored: %v", list)
	}
}

func TestHabitTodayMarksAndStats(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	_, h := api.do("POST", "/habits", token, dailyHabit)
	id := h["id"].(string)

	code, out := api.do("GET", "/habits/today", token, "")
	if code != http.StatusOK || out["date"] != ymd(today()) {
		t.Fatalf("today: %d %v", code, out)
	}
	items := out["items"].([]any)
	if len(items) != 1 || items[0].(map[string]any)["done"] != false || items[0].(map[string]any)["value"] != 0.0 {
		t.Fatalf("items = %v", items)
	}

	if code, out := api.do("PUT", "/habits/"+id+"/logs/"+ymd(today()), token, `{"value":1}`); code != http.StatusNoContent {
		t.Fatalf("mark: %d %v", code, out)
	}
	_, out = api.do("GET", "/habits/today", token, "")
	item := out["items"].([]any)[0].(map[string]any)
	if item["done"] != true || item["value"] != 1.0 || item["streaks"].(map[string]any)["current"] != 1.0 || item["streaks"].(map[string]any)["unit"] != "day" {
		t.Errorf("item = %v", item)
	}

	from, to := today().AddDate(0, 0, -6), today()
	code, st := api.do("GET", "/habits/"+id+"/stats?from="+ymd(from)+"&to="+ymd(to), token, "")
	if code != http.StatusOK {
		t.Fatalf("stats: %d %v", code, st)
	}
	days := st["days"].([]any)
	if len(days) != 7 || days[6].(map[string]any)["done"] != true || days[6].(map[string]any)["date"] != ymd(to) {
		t.Errorf("days = %v", days)
	}
	if st["percent_all"] != 100.0 || st["today"] != ymd(today()) {
		t.Errorf("stats = %v", st)
	}

	// Taking the mark off.
	api.do("PUT", "/habits/"+id+"/logs/"+ymd(today()), token, `{"value":0}`)
	_, out = api.do("GET", "/habits/today", token, "")
	if out["items"].([]any)[0].(map[string]any)["done"] != false {
		t.Errorf("mark was not removed: %v", out)
	}

	for name, c := range map[string]struct{ path, body string }{
		"future":   {"/habits/" + id + "/logs/" + ymd(today().AddDate(0, 0, 2)), `{"value":1}`},
		"negative": {"/habits/" + id + "/logs/" + ymd(today()), `{"value":-1}`},
		"yes/no 2": {"/habits/" + id + "/logs/" + ymd(today()), `{"value":2}`},
	} {
		if code, _ := api.do("PUT", c.path, token, c.body); code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, code)
		}
	}
	if code, _ := api.do("GET", "/habits/"+id+"/stats?from="+ymd(to)+"&to="+ymd(from), token, ""); code != http.StatusBadRequest {
		t.Errorf("upside down range: %d", code)
	}
	if code, _ := api.do("GET", "/habits/"+id+"/stats?from=2026-13-01&to=2026-13-02", token, ""); code != http.StatusBadRequest {
		t.Errorf("bad date: %d", code)
	}
}

func TestHabitPlacementShowsUpInTheCalendarAndCredits(t *testing.T) {
	api := newTestAPI(t, true)
	token := api.devLogin("a")
	_, h := api.do("POST", "/habits", token, `{"title":"Зарядка","kind":"boolean","frequency":"daily","color":"#ef4444","placement":{"time":"07:30","duration_minutes":20}}`)
	id := h["id"].(string)
	if p, _ := h["placement"].(map[string]any); p["time"] != "07:30" || p["duration_minutes"] != 20.0 {
		t.Fatalf("placement = %v", h["placement"])
	}

	// Today's occurrence is in the calendar, whatever the clock says: ask for the whole day plus a day each side.
	from, to := today().AddDate(0, 0, -1).Format("2006-01-02")+"T00:00:00Z", today().AddDate(0, 0, 2).Format("2006-01-02")+"T00:00:00Z"
	list := api.listTasks(token, from, to)
	var occ map[string]any
	for _, in := range list {
		if in["habit_id"] == id {
			occ = in
			break
		}
	}
	if occ == nil {
		t.Fatalf("no occurrence of the habit in %v", list)
	}
	if occ["title"] != "Зарядка" || occ["series_id"] == nil {
		t.Errorf("occurrence = %v", occ)
	}
	// An ordinary task has a null habit.
	plain := api.createTask(token, "Дело", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z", "")
	if v, ok := plain["habit_id"]; !ok || v != nil {
		t.Errorf("habit_id of a plain task = %#v", v)
	}

	// Doing it credits its day: the stats show a done cell for the date of its plan.
	if code, out := api.do("POST", "/instances/"+occ["id"].(string)+"/complete", token, ""); code != http.StatusOK {
		t.Fatalf("complete: %d %v", code, out)
	}
	planned := occ["planned_start"].(string)[:10]
	_, st := api.do("GET", "/habits/"+id+"/stats?from="+planned+"&to="+planned, token, "")
	day0 := st["days"].([]any)[0].(map[string]any)
	if day0["done"] != true {
		t.Errorf("the day was not credited: %v", st)
	}

	// Take it out of the grid, put it back with another time.
	if code, out := api.do("DELETE", "/habits/"+id+"/placement", token, ""); code != http.StatusOK || out["placement"] != nil {
		t.Errorf("clear: %d %v", code, out)
	}
	code, out := api.do("PUT", "/habits/"+id+"/placement", token, `{"time":"21:15","duration_minutes":30}`)
	if code != http.StatusOK || out["placement"].(map[string]any)["time"] != "21:15" {
		t.Errorf("set: %d %v", code, out)
	}
	if code, _ := api.do("PUT", "/habits/"+id+"/placement", token, `{"time":"25:00","duration_minutes":30}`); code != http.StatusBadRequest {
		t.Errorf("bad time: %d", code)
	}
	// The schedule of a habit in the grid cannot be edited from the calendar.
	for _, in := range api.listTasks(token, from, to) {
		if in["habit_id"] == id {
			code, out := api.do("PATCH", "/instances/"+in["id"].(string)+"?scope=all", token, `{"recurrence":"FREQ=WEEKLY;BYDAY=MO"}`)
			if code != http.StatusBadRequest {
				t.Errorf("recurrence edit: %d %v", code, out)
			}
			break
		}
	}
}

func TestHabitsOfOtherUsersAreInvisible(t *testing.T) {
	api := newTestAPI(t, true)
	a, b := api.devLogin("a"), api.devLogin("b")
	_, h := api.do("POST", "/habits", a, dailyHabit)
	id := h["id"].(string)

	for _, c := range []struct{ method, path, body string }{
		{"GET", "/habits/" + id, ""},
		{"PATCH", "/habits/" + id, `{"title":"x"}`},
		{"DELETE", "/habits/" + id, ""},
		{"POST", "/habits/" + id + "/archive", ""},
		{"POST", "/habits/" + id + "/unarchive", ""},
		{"PUT", "/habits/" + id + "/placement", `{"time":"07:00","duration_minutes":10}`},
		{"DELETE", "/habits/" + id + "/placement", ""},
		{"PUT", "/habits/" + id + "/logs/" + ymd(today()), `{"value":1}`},
		{"GET", "/habits/" + id + "/stats?from=" + ymd(today()) + "&to=" + ymd(today()), ""},
	} {
		if code, _ := api.do(c.method, c.path, b, c.body); code != http.StatusNotFound {
			t.Errorf("%s %s: status %d, want 404", c.method, c.path, code)
		}
	}
	if list := api.getArray("/habits", b); len(list) != 0 {
		t.Errorf("list = %v", list)
	}
	if code, _ := api.do("GET", "/habits", "", ""); code != http.StatusUnauthorized {
		t.Errorf("without a session: %d", code)
	}
	// Still there for the owner.
	if code, _ := api.do("GET", "/habits/"+id, a, ""); code != http.StatusOK {
		t.Errorf("owner: %d", code)
	}
}
