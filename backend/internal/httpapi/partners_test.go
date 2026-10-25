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
