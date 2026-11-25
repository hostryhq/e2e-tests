//go:build e2e

package e2e

import (
	"strings"
	"testing"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

func nested(m map[string]any, path ...string) any {
	var cur any = m
	for _, p := range path {
		mm, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = mm[p]
	}
	return cur
}

// TestScenario1b continues scenario 1 on the organisation it created (tests run in file order).
func TestScenario1b_GSTINVerifyDeviceAndOfflinePack(t *testing.T) {
	if orgA == nil || orgA.Owner == nil {
		t.Fatal("scenario 1 did not leave an onboarded organisation with a signed-in owner")
	}
	t.Run("GSTIN verification by a vendor user is visible to the tenant", func(t *testing.T) {
		tc := orgA.Owner.tenancy()
		before := tc.Get("/v1/tax-registrations/" + orgA.RegID)
		expect(t, "getTaxRegistration (before)", before, 200)
		if got := nested(before.Map(), "verification", "state"); got != "unverified" {
			t.Fatalf("verification.state before = %v, want unverified", got)
		}
		r := admin1.mut("PUT", "/v1/organisations/"+orgA.ID+"/tax-registrations/"+orgA.RegID+"/verification",
			map[string]any{"method": "certificate_seen", "note": "Certificate seen on the onboarding call."})
		expect(t, "verifyTaxRegistration", r, 200)
		after := tc.Get("/v1/tax-registrations/" + orgA.RegID)
		expect(t, "getTaxRegistration (after)", after, 200)
		if got := nested(after.Map(), "verification", "state"); got != "verified" {
			t.Fatalf("verification.state after = %v, want verified", got)
		}
	})
	t.Run("device registration and an offline pack with the series tenancy issued", func(t *testing.T) {
		o := orgA.Owner
		devKey := hx.NewDeviceKey()
		devID := hx.NewID()
		nr := o.ID.Post("/v1/device-nonces", nil, "Idempotency-Key", hx.NewID())
		expect(t, "createDeviceNonce", nr, 200, 201)
		nonce, _ := nr.Map()["nonce"].(string)
		reg := o.C.Post("/v1/devices", map[string]any{
			"id": devID, "kind": "pos", "name": "Counter 1", "outlet_id": orgA.OutletID, "public_key": devKey.JWK(),
			"key_protection": "os-software", "nonce": nonce, "nonce_signature": devKey.SignRaw(nonce),
		}, "Idempotency-Key", hx.NewID())
		expect(t, "registerDevice", reg, 201)
		if bc := reg.Map()["billing_capability"]; bc != "active" {
			t.Fatalf("billing_capability = %v, want active (registration verified): %s", bc, reg)
		}
		orgA.DeviceID = devID
		pack := o.C.Get("/v1/devices/" + devID + "/offline-packs/latest")
		expect(t, "getDeviceOfflinePack", pack, 200)
		series, _ := nested(pack.Map(), "claims", "series").([]any)
		if len(series) == 0 {
			t.Fatalf("offline pack carries no series: %s", pack)
		}
		var codes []string
		for _, e := range series {
			m := e.(map[string]any)
			if m["state"] != "active" || m["tax_registration_id"] != orgA.RegID {
				t.Fatalf("series entry %v: want active for registration %s", m, orgA.RegID)
			}
			codes = append(codes, m["code"].(string))
		}
		// The codes in the pack are the ones tenancy holds in its registry.
		reg2 := o.tenancy().Get("/v1/document-series?outlet_id=" + orgA.OutletID)
		expect(t, "listDocumentSeries", reg2, 200)
		for _, c := range codes {
			if !strings.Contains(string(reg2.Body), `"`+c+`"`) {
				t.Fatalf("pack series %s is not in tenancy's registry: %s", c, reg2)
			}
		}
		if got := nested(pack.Map(), "claims", "organisation_id"); got != orgA.ID {
			t.Fatalf("pack organisation_id = %v, want %s", got, orgA.ID)
		}
	})
}
