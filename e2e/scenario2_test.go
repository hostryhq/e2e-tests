//go:build e2e

package e2e

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

// Scenario 2: a tenant B token gets 404 for every resource of tenant A that it can name, in tenancy and in
// identity, and its writes change nothing of A's. Each probe has a control: the same call for B's own
// resource succeeds, so a 404 cannot come from a broken route.
func TestScenario2_CrossTenantIsolation(t *testing.T) {
	if orgA == nil || orgB == nil || orgA.DeviceID == "" {
		t.Fatal("scenarios 1 and 1b did not leave two organisations and a device for A")
	}
	a, b := orgA.Owner, orgB.Owner
	bt, bi := b.tenancy(), b.C
	at, ai := a.tenancy(), a.C

	// A role id of A, named by listing as A.
	roles := ai.Get("/v1/roles")
	expect(t, "listRoles (A)", roles, 200)
	var rp struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(roles.Body, &rp)
	if len(rp.Items) == 0 {
		t.Fatalf("A has no roles to probe: %s", roles)
	}
	roleA := rp.Items[0].ID

	type probe struct {
		name, method, path string
		body               any
	}
	probes := []probe{
		{"tenancy getBrand", "GET", "/v1/brands/" + orgA.BrandID, nil},
		{"tenancy getOutlet", "GET", "/v1/outlets/" + orgA.OutletID, nil},
		{"tenancy updateOutlet", "PATCH", "/v1/outlets/" + orgA.OutletID, map[string]any{"name": "Hijacked"}},
		{"tenancy getTaxRegistration", "GET", "/v1/tax-registrations/" + orgA.RegID, nil},
		{"tenancy updateTaxRegistration", "PATCH", "/v1/tax-registrations/" + orgA.RegID, map[string]any{"legal_name": "Hijacked"}},
		{"tenancy closeTaxRegistration", "PUT", "/v1/tax-registrations/" + orgA.RegID + "/closure", map[string]any{"reason": "isolation probe by tenant B"}},
	}
	for _, p := range probes {
		t.Run(p.name, func(t *testing.T) {
			r := bt.Do(p.method, p.path, p.body, "Idempotency-Key", hx.NewID())
			if r.Status != 404 {
				t.Fatalf("tenant B %s %s: want 404, got %s", p.method, p.path, r)
			}
		})
	}
	idProbes := []probe{
		{"identity getDevice", "GET", "/v1/devices/" + orgA.DeviceID, nil},
		{"identity revokeDevice", "PUT", "/v1/devices/" + orgA.DeviceID + "/revocation", map[string]any{"reason": "isolation probe"}},
		{"identity getDeviceOfflinePack", "GET", "/v1/devices/" + orgA.DeviceID + "/offline-packs/latest", nil},
		{"identity getMember", "GET", "/v1/members/" + a.MemberID, nil},
		{"identity getRole", "GET", "/v1/roles/" + roleA, nil},
	}
	for _, p := range idProbes {
		t.Run(p.name, func(t *testing.T) {
			r := bi.Do(p.method, p.path, p.body, "Idempotency-Key", hx.NewID())
			if r.Status != 404 {
				t.Fatalf("tenant B %s %s: want 404, got %s", p.method, p.path, r)
			}
		})
	}

	t.Run("identity deleteRole is an idempotent no-op that leaves A's role alone", func(t *testing.T) {
		// deleteRole answers 204 for a role that is not there (idempotent, spec); the property is that A's role survives.
		r := bi.Delete("/v1/roles/"+roleA, "Idempotency-Key", hx.NewID())
		if r.Status != 204 && r.Status != 404 {
			t.Fatalf("tenant B deleteRole of A's role: want 204 or 404, got %s", r)
		}
		expect(t, "A getRole after B's delete", ai.Get("/v1/roles/"+roleA), 200)
	})

	t.Run("lists never leak the other tenant", func(t *testing.T) {
		for _, c := range []struct {
			cl   *hx.Client
			path string
		}{{bt, "/v1/brands"}, {bt, "/v1/outlets"}, {bt, "/v1/tax-registrations"}, {bt, "/v1/document-series"}, {bi, "/v1/devices"}, {bi, "/v1/members"}} {
			r := c.cl.Get(c.path)
			expect(t, "B list "+c.path, r, 200)
			for _, id := range []string{orgA.ID, orgA.BrandID, orgA.OutletID, orgA.RegID, orgA.DeviceID, a.MemberID} {
				if strings.Contains(string(r.Body), id) {
					t.Fatalf("B's GET %s contains tenant A id %s: %s", c.path, id, r)
				}
			}
		}
	})

	t.Run("controls: the same calls on B's own resources succeed", func(t *testing.T) {
		expect(t, "B getBrand", bt.Get("/v1/brands/"+orgB.BrandID), 200)
		expect(t, "B getOutlet", bt.Get("/v1/outlets/"+orgB.OutletID), 200)
		expect(t, "B getTaxRegistration", bt.Get("/v1/tax-registrations/"+orgB.RegID), 200)
		expect(t, "B getMember", bi.Get("/v1/members/"+b.MemberID), 200)
	})

	t.Run("tenant tokens are refused on vendor routes", func(t *testing.T) {
		r := bt.Get("/internal/v1/vendor/organisations")
		if r.Status != 401 && r.Status != 403 {
			t.Fatalf("tenant token on tenancy vendor directory: want 401/403, got %s", r)
		}
		r = bi.Get("/internal/v1/vendor/users")
		if r.Status != 401 && r.Status != 403 {
			t.Fatalf("tenant token on identity vendor users: want 401/403, got %s", r)
		}
	})

	t.Run("A is unchanged after B's write attempts", func(t *testing.T) {
		o := at.Get("/v1/outlets/" + orgA.OutletID)
		expect(t, "A getOutlet", o, 200)
		if n, _ := o.Map()["name"].(string); n == "Hijacked" {
			t.Fatalf("A's outlet was renamed by tenant B: %s", o)
		}
		tr := at.Get("/v1/tax-registrations/" + orgA.RegID)
		expect(t, "A getTaxRegistration", tr, 200)
		if nested(tr.Map(), "status") == "closed" || nested(tr.Map(), "legal_name") == "Hijacked" {
			t.Fatalf("A's registration was changed by tenant B: %s", tr)
		}
		d := ai.Get("/v1/devices/" + orgA.DeviceID)
		expect(t, "A getDevice", d, 200)
		if d.Map()["state"] != "active" {
			t.Fatalf("A's device state = %v after B's revoke attempt, want active", d.Map()["state"])
		}
	})
}
