//go:build e2e

package e2e

import (
	"context"
	"strings"
	"testing"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

// Scenario 3: the two-person approval rule of ADR-0005 A2.3 end to end through svc-admin and svc-identity.
// An approver needs an account at least 7 days old. The real binary has no injectable clock, so the age is
// seeded: the vendor user's cred_at document field is moved 8 days back in the identity database. That is
// the documented seed (service/vendor.go, vendorUser.CredAt); there is no other way to age an account.
func TestScenario3_TwoPersonApproval(t *testing.T) {
	if admin1 == nil || admin2 == nil || orgB == nil {
		t.Fatal("scenario 1 did not leave two signed-in vendor users and an organisation")
	}
	file := func(v *vendorUser) hx.Resp {
		return v.mut("POST", "/v1/approvals", map[string]any{
			"kind": "org_suspend", "organisation_id": orgB.ID, "ticket_reference": "SUP-E2E-1",
			"reason": "Non-payment, suspension requested by the founder.", "verification_method": "callback_to_registered_number",
		})
	}

	var approvalID string
	t.Run("two young accounts cannot form a pair: filing is refused second_approver_unavailable", func(t *testing.T) {
		r := file(admin1)
		if r.Status != 409 || !strings.Contains(string(r.Body), "second_approver_unavailable") {
			t.Fatalf("filing with no account older than 7 days: want 409 second_approver_unavailable, got %s", r)
		}
	})

	t.Run("seed admin2's account age to 8 days", func(t *testing.T) {
		out, err := st.PSQL(context.Background(), "identity", `
UPDATE global_records
   SET doc = jsonb_set(doc, '{cred_at}', to_jsonb(to_char((now() AT TIME ZONE 'UTC') - interval '8 days', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')))
 WHERE kind = 'vendor_user' AND doc->>'email' = 'admin2@example.test';`)
		if err != nil {
			t.Fatalf("seed: %v: %s", err, out)
		}
	})

	t.Run("admin1 files, a pending approval exists", func(t *testing.T) {
		r := file(admin1)
		expect(t, "fileVendorApproval", r, 201)
		approvalID, _ = r.Map()["id"].(string)
		if r.Map()["state"] != "pending" || approvalID == "" {
			t.Fatalf("filed approval is not pending: %s", r)
		}
	})

	t.Run("the requester cannot approve their own request", func(t *testing.T) {
		code, err := hx.TOTPNext(admin1.Secret, &admin1.lastStep)
		if err != nil {
			t.Fatal(err)
		}
		r := admin1.mut("PUT", "/v1/approvals/"+approvalID+"/decision", map[string]any{"totp_code": code})
		if r.Status < 400 || r.Status >= 500 {
			t.Fatalf("self-approval: want a 4xx refusal, got %s", r)
		}
		g := admin1.get("/v1/approvals/" + approvalID)
		expect(t, "getVendorApproval", g, 200)
		if g.Map()["state"] != "pending" {
			t.Fatalf("approval state after refused self-approval = %v, want pending", g.Map()["state"])
		}
	})

	t.Run("an approver older than 7 days approves with a fresh TOTP", func(t *testing.T) {
		code, err := hx.TOTPNext(admin2.Secret, &admin2.lastStep)
		if err != nil {
			t.Fatal(err)
		}
		r := admin2.mut("PUT", "/v1/approvals/"+approvalID+"/decision", map[string]any{"totp_code": code})
		expect(t, "approveVendorApproval", r, 200)
		ap, _ := r.Map()["approval"].(map[string]any)
		if ap["state"] != "approved" || ap["approved_by"] != admin2.UserID {
			t.Fatalf("approval after admin2's decision: %s", r)
		}
	})

	t.Run("the vendor audit log records the approval", func(t *testing.T) {
		r := admin1.get("/v1/audit-entries")
		expect(t, "listAuditEntries", r, 200)
		if !strings.Contains(string(r.Body), "approval") {
			t.Fatalf("vendor audit log has no approval entry: %s", r)
		}
	})
}
