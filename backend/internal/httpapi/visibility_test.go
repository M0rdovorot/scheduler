package httpapi

import (
	"net/http"
	"testing"
)

func TestVisibilityThroughTheAPI(t *testing.T) {
	api := newTestAPI(t, true)
	tok := api.devLogin("anna")

	if _, me := api.do("GET", "/me", tok, ""); me["default_visibility"] != "private" {
		t.Errorf("default_visibility = %v, want private", me["default_visibility"])
	}
	if code, _ := api.do("PATCH", "/me/settings", tok, `{"default_visibility":"everyone"}`); code != http.StatusBadRequest {
		t.Errorf("bad default_visibility: status %d, want 400", code)
	}
	if code, me := api.do("PATCH", "/me/settings", tok, `{"default_visibility":"granted"}`); code != http.StatusOK || me["default_visibility"] != "granted" {
		t.Fatalf("set default_visibility: status %d, body %v", code, me)
	}

	const times = `"planned_start":"2026-10-14T09:00:00Z","planned_end":"2026-10-14T10:00:00Z"`
	code, in := api.do("POST", "/tasks", tok, `{"title":"a",`+times+`}`)
	if code != http.StatusCreated || in["visibility"] != "granted" {
		t.Fatalf("create with the default: status %d, body %v", code, in)
	}
	code, in = api.do("POST", "/tasks", tok, `{"title":"b","visibility":"partners",`+times+`}`)
	if code != http.StatusCreated || in["visibility"] != "partners" {
		t.Fatalf("create explicit: status %d, body %v", code, in)
	}
	code, in = api.do("PATCH", "/instances/"+in["id"].(string), tok, `{"visibility":"private"}`)
	if code != http.StatusOK || in["visibility"] != "private" {
		t.Fatalf("patch: status %d, body %v", code, in)
	}
	if code, _ := api.do("PATCH", "/instances/"+in["id"].(string), tok, `{"visibility":"x"}`); code != http.StatusBadRequest {
		t.Errorf("bad visibility: status %d, want 400", code)
	}
}
