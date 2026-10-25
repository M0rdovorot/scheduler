package httpapi

import (
	"net/http"
	"testing"
)

func (a *testAPI) myID(token string) string {
	a.t.Helper()
	code, out := a.do("GET", "/me", token, "")
	if code != http.StatusOK {
		a.t.Fatalf("GET /me: status %d", code)
	}
	return out["id"].(string)
}

// link makes the owners of two sessions partners.
func (a *testAPI) link(inviter, accepter string) {
	a.t.Helper()
	code, inv := a.do("POST", "/partners/invites", inviter, "")
	if code != http.StatusCreated {
		a.t.Fatalf("create invite: status %d, body %v", code, inv)
	}
	code, out := a.do("POST", "/partners/invites/accept", accepter, `{"token":"`+inv["token"].(string)+`"}`)
	if code != http.StatusOK {
		a.t.Fatalf("accept invite: status %d, body %v", code, out)
	}
}

func TestPartnersRequireSession(t *testing.T) {
	api := newTestAPI(t, true)
	id := "00000000-0000-0000-0000-000000000001"
	for _, tt := range []struct{ method, path, body string }{
		{"GET", "/partners", ""},
		{"POST", "/partners/invites", ""},
		{"POST", "/partners/invites/accept", `{"token":"x"}`},
		{"DELETE", "/partners/" + id, ""},
		{"PUT", "/partners/" + id + "/access", `{"tasks":true}`},
		{"GET", "/partners/" + id + "/busy?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z", ""},
		{"GET", "/free-time?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z", ""},
	} {
		if code, _ := api.do(tt.method, tt.path, "", tt.body); code != http.StatusUnauthorized {
			t.Errorf("%s %s without a session: status %d, want 401", tt.method, tt.path, code)
		}
	}
}

func TestPartnerFlow(t *testing.T) {
	api := newTestAPI(t, true)
	anna, boris := api.devLogin("anna"), api.devLogin("boris")
	annaID, borisID := api.myID(anna), api.myID(boris)

	api.link(anna, boris)

	list := api.getArray("/partners", boris)
	if len(list) != 1 || list[0]["id"] != annaID {
		t.Fatalf("boris's partners = %v, want anna", list)
	}

	code, out := api.do("PUT", "/partners/"+annaID+"/access", boris, `{"habits":true}`)
	if code != http.StatusOK || out["habits_shared"] != true || out["tasks_shared"] != false {
		t.Fatalf("set access: status %d, body %v", code, out)
	}
	// The access is boris's gift to anna, not the other way round.
	if list := api.getArray("/partners", anna); list[0]["habits_shared"] != false {
		t.Errorf("anna's view shows habits shared: %v", list[0])
	}

	if code, _ := api.do("DELETE", "/partners/"+borisID, anna, ""); code != http.StatusNoContent {
		t.Fatalf("remove: status %d", code)
	}
	if code, _ := api.do("DELETE", "/partners/"+borisID, anna, ""); code != http.StatusNotFound {
		t.Errorf("second remove: status %d, want 404", code)
	}
	if list := api.getArray("/partners", boris); len(list) != 0 {
		t.Errorf("boris still has partners: %v", list)
	}
}

func TestPartnerInviteErrors(t *testing.T) {
	api := newTestAPI(t, true)
	anna, boris := api.devLogin("anna"), api.devLogin("boris")

	if code, out := api.do("POST", "/partners/invites/accept", boris, `{"token":"nope"}`); code != http.StatusNotFound || out["code"] != "invite_invalid" {
		t.Errorf("unknown token: status %d, body %v", code, out)
	}
	if code, _ := api.do("POST", "/partners/invites/accept", boris, `{}`); code != http.StatusNotFound {
		t.Errorf("no token: status %d, want 404", code)
	}
	if code, _ := api.do("POST", "/partners/invites/accept", boris, `{`); code != http.StatusBadRequest {
		t.Errorf("broken body: status %d, want 400", code)
	}

	_, inv := api.do("POST", "/partners/invites", anna, "")
	token := inv["token"].(string)
	if code, out := api.do("POST", "/partners/invites/accept", anna, `{"token":"`+token+`"}`); code != http.StatusConflict || out["code"] != "own_invite" {
		t.Errorf("own invite: status %d, body %v", code, out)
	}
	api.link(anna, boris)
	if code, out := api.do("POST", "/partners/invites/accept", boris, `{"token":"`+token+`"}`); code != http.StatusConflict || out["code"] != "already_partners" {
		t.Errorf("already partners: status %d, body %v", code, out)
	}
}

func TestPartnerAccessOfStranger(t *testing.T) {
	api := newTestAPI(t, true)
	anna, boris := api.devLogin("anna"), api.devLogin("boris")
	borisID := api.myID(boris)
	if code, _ := api.do("PUT", "/partners/"+borisID+"/access", anna, `{"tasks":true}`); code != http.StatusNotFound {
		t.Errorf("access for a non-partner: status %d, want 404", code)
	}
}

func (a *testAPI) plan(token, title, visibility, start, end string) {
	a.t.Helper()
	body := `{"title":"` + title + `","visibility":"` + visibility + `","planned_start":"` + start + `","planned_end":"` + end + `"}`
	if code, out := a.do("POST", "/tasks", token, body); code != http.StatusCreated {
		a.t.Fatalf("create %q: status %d, body %v", title, code, out)
	}
}

func TestPartnerBusyShowsNothingBeyondTheAllowedTitle(t *testing.T) {
	api := newTestAPI(t, true)
	anna, boris, clara := api.devLogin("anna"), api.devLogin("boris"), api.devLogin("clara")
	annaID := api.myID(anna)
	api.link(anna, boris)

	api.plan(anna, "Открыто", "partners", "2026-10-14T06:00:00Z", "2026-10-14T07:00:00Z")
	api.plan(anna, "Секрет", "private", "2026-10-14T08:00:00Z", "2026-10-14T09:00:00Z")
	// A description must never reach a partner.
	api.do("POST", "/tasks", anna, `{"title":"Скрытое","description":"личное","visibility":"private","planned_start":"2026-10-14T10:00:00Z","planned_end":"2026-10-14T11:00:00Z"}`)

	list := api.getArray("/partners/"+annaID+"/busy?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z", boris)
	if len(list) != 3 {
		t.Fatalf("busy = %v, want 3 blocks", list)
	}
	if list[0]["title"] != "Открыто" || list[1]["title"] != nil || list[2]["title"] != nil {
		t.Errorf("titles = %v %v %v, want only the first", list[0]["title"], list[1]["title"], list[2]["title"])
	}
	for _, b := range list {
		if len(b) != 3 {
			t.Errorf("block %v has fields beyond start, end and title", b)
		}
	}

	// Someone who is not a partner learns nothing, not even that the user exists.
	code, _ := api.do("GET", "/partners/"+annaID+"/busy?from=2026-10-14T00:00:00Z&to=2026-10-15T00:00:00Z", clara, "")
	if code != http.StatusNotFound {
		t.Errorf("busy of a non-partner: status %d, want 404", code)
	}
	if code, _ := api.do("GET", "/partners/"+annaID+"/busy?from=2026-10-15T00:00:00Z&to=2026-10-14T00:00:00Z", boris, ""); code != http.StatusBadRequest {
		t.Errorf("backwards window: status %d, want 400", code)
	}
}

func TestFreeTimeThroughTheAPI(t *testing.T) {
	api := newTestAPI(t, true)
	anna, boris, clara := api.devLogin("anna"), api.devLogin("boris"), api.devLogin("clara")
	borisID, claraID := api.myID(boris), api.myID(clara)
	api.link(anna, boris)

	api.plan(anna, "a", "private", "2026-10-14T06:00:00Z", "2026-10-14T08:00:00Z")
	api.plan(boris, "b", "private", "2026-10-14T07:00:00Z", "2026-10-14T10:00:00Z")

	window := "from=2026-10-14T05:00:00Z&to=2026-10-14T12:00:00Z"
	list := api.getArray("/free-time?"+window+"&with="+borisID, anna)
	if len(list) != 2 || list[0]["end"] != "2026-10-14T06:00:00Z" || list[1]["start"] != "2026-10-14T10:00:00Z" {
		t.Errorf("free time = %v, want 05-06 and 10-12", list)
	}
	list = api.getArray("/free-time?"+window+"&with="+borisID+"&min_minutes=90", anna)
	if len(list) != 1 || list[0]["start"] != "2026-10-14T10:00:00Z" {
		t.Errorf("free time of at least 90 minutes = %v, want 10-12 only", list)
	}
	if code, _ := api.do("GET", "/free-time?"+window+"&with="+claraID, anna, ""); code != http.StatusNotFound {
		t.Errorf("with a non-partner: status %d, want 404", code)
	}
	if code, _ := api.do("GET", "/free-time?"+window+"&with=nope", anna, ""); code != http.StatusBadRequest {
		t.Errorf("bad id: status %d, want 400", code)
	}
}
