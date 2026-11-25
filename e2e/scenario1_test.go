//go:build e2e

package e2e

import (
	"testing"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

// gstin builds a syntactically valid GSTIN (state code, PAN, entity, Z, check character).
func gstin(state, pan string) string {
	const cs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	body := state + pan + "1Z"
	sum := 0
	for i, c := range body {
		v := indexOf(cs, byte(c))
		if i%2 == 1 {
			v *= 2
		}
		sum += v/36 + v%36
	}
	return body + string(cs[(36-sum%36)%36])
}

func indexOf(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// org is one onboarded organisation with its owner session.
type org struct {
	ID, BrandID, OutletID, RegID, InviteID, DeviceID string
	Mobile, GSTIN                                    string
	Owner                                            *owner
}

var (
	admin1, admin2 *vendorUser
	orgA, orgB     *org
)

// onboard creates the organisation, first outlet and owner invitation through svc-admin.
func onboard(t *testing.T, v *vendorUser, name, state, gst, mobile string) *org {
	t.Helper()
	key := hx.NewID()
	form := map[string]any{
		"name":             name,
		"outlet":           map[string]any{"name": name + " Main", "kind": "restaurant", "state_code": state},
		"tax_registration": map[string]any{"legal_name": name + " Pvt Ltd", "regime": "regular", "gstin": gst},
		"owner":            map[string]any{"name": "Owner " + name, "mobile_e164": mobile},
	}
	r := v.mut("POST", "/v1/organisations", form, key)
	expect(t, "createOrganisation", r, 201)
	m := r.Map()
	if m["state"] != "complete" {
		t.Fatalf("onboarding state = %v, want complete: %s", m["state"], r)
	}
	cr := m["created"].(map[string]any)
	o := &org{Mobile: mobile, GSTIN: gst}
	o.ID = cr["organisation"].(map[string]any)["id"].(string)
	o.BrandID = cr["brand"].(map[string]any)["id"].(string)
	o.OutletID = cr["outlet"].(map[string]any)["id"].(string)
	o.RegID = cr["tax_registration"].(map[string]any)["id"].(string)
	o.InviteID = m["owner_invitation"].(map[string]any)["id"].(string)
	// One Idempotency-Key spans tenancy then identity: a replay returns the same organisation, not a second one.
	r2 := v.mut("POST", "/v1/organisations", form, key)
	expect(t, "createOrganisation replay", r2, 200, 201)
	id2 := ""
	if c, ok := r2.Map()["created"].(map[string]any); ok {
		if og, ok := c["organisation"].(map[string]any); ok {
			id2, _ = og["id"].(string)
		}
	}
	if id2 != o.ID {
		t.Fatalf("replay with the same Idempotency-Key returned organisation %q, want %s: %s", id2, o.ID, r2)
	}
	return o
}

func TestScenario1_VendorBootstrapToOfflinePack(t *testing.T) {
	t1, t2 := bootstrap(t, "admin1@example.test"), bootstrap(t, "admin2@example.test")
	admin1, admin2 = newVendorUser("admin1@example.test"), newVendorUser("admin2@example.test")
	admin1.setup(t, t1)
	admin2.setup(t, t2)
	t.Run("vendor sign-in through svc-admin sets cookie and CSRF", func(t *testing.T) {
		r := admin1.signIn(t)
		expect(t, "signIn", r, 201)
		if got := admin1.get("/v1/sessions/current"); got.Status != 200 {
			t.Fatalf("getSession with the cookie: %s", got)
		}
		// A state-changing call without the CSRF token is refused.
		bad := admin1.c.Do("POST", "/v1/vendor-users", map[string]any{}, "Cookie", "__Host-hostry-admin="+admin1.cookie, "Origin", st.AdminOrigin, "Idempotency-Key", hx.NewID())
		if bad.Status != 403 {
			t.Fatalf("mutation without CSRF token: want 403, got %s", bad)
		}
		admin2.signIn(t)
	})
	t.Run("organisation, outlet and owner invite in one onboarding", func(t *testing.T) {
		orgA = onboard(t, admin1, "Alpha Foods", "33", gstin("33", "ABCDE1234F"), "+919876500001")
		orgB = onboard(t, admin1, "Bravo Stays", "29", gstin("29", "BCDEF2345G"), "+919876500002")
	})
	t.Run("owner OTP login consumes the invitation", func(t *testing.T) {
		orgA.Owner = newOwner(orgA.Mobile)
		r := orgA.Owner.login(t)
		expect(t, "createSession (owner A)", r, 201)
		if r.Map()["invitation_accepted"] != true {
			t.Fatalf("invitation_accepted = %v, want true: %s", r.Map()["invitation_accepted"], r)
		}
		orgB.Owner = newOwner(orgB.Mobile)
		expect(t, "createSession (owner B)", orgB.Owner.login(t), 201)
	})
}
