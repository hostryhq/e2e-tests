//go:build e2e

package e2e

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

// owner is a tenant user on one device, signed in by OTP.
type owner struct {
	Mobile    string
	DeviceID  string
	Key       hx.DeviceKey
	ID        *hx.Client // identity, unauthenticated
	C         *hx.Client // identity, bearer
	Access    string
	Refresh   string
	MemberID  string
	SessionID string
}

// otpFor recovers the code of a challenge. The identity binary's test SMS sender sends nothing and records
// nothing (svc-identity cmd/svc-identity/config.go, testSMS), so the code is found the only way a black-box
// test can: the challenge keeps HMAC-SHA256(MAC key, "otp" 0x00 id 0x00 code); the MAC key file is the
// run's own throw-away key, and the code space is 10^6. This is a test-only workaround, reported as an open
// issue: the test sender should record the code for dev use.
func otpFor(t *testing.T, challengeID string) string {
	t.Helper()
	raw, err := os.ReadFile(st.MACKeyFile())
	if err != nil {
		t.Fatal(err)
	}
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	want, err := st.PSQL(context.Background(), "identity", fmt.Sprintf(`SELECT doc->>'code_mac' FROM global_records WHERE kind='otp_challenge' AND id='%s'`, challengeID))
	if err != nil || want == "" {
		t.Fatalf("challenge %s not found: %v %q", challengeID, err, want)
	}
	wantB, _ := hex.DecodeString(want)
	for i := 0; i < 1000000; i++ {
		m := hmac.New(sha256.New, key)
		m.Write([]byte("otp"))
		m.Write([]byte{0})
		m.Write([]byte(challengeID))
		m.Write([]byte{0})
		m.Write([]byte(fmt.Sprintf("%06d", i)))
		if hmac.Equal(m.Sum(nil), wantB) {
			return fmt.Sprintf("%06d", i)
		}
	}
	t.Fatalf("no 6-digit code matches challenge %s", challengeID)
	return ""
}

// newOwner makes a device identity for a mobile number.
func newOwner(mobile string) *owner {
	return &owner{Mobile: mobile, DeviceID: hx.NewID(), Key: hx.NewDeviceKey(), ID: hx.New(st.IdentityURL)}
}

// login runs OTP challenge then session creation. It returns the session response.
func (o *owner) login(t *testing.T) hx.Resp {
	t.Helper()
	r := o.ID.Post("/v1/otp-challenges", map[string]any{"mobile_e164": o.Mobile, "device_id": o.DeviceID, "device_public_key": o.Key.JWK()}, "Idempotency-Key", hx.NewID())
	if r.Status != 202 {
		t.Fatalf("createOtpChallenge: %s", r)
	}
	cid, _ := r.Map()["id"].(string)
	code := otpFor(t, cid)
	assertion := o.Key.Assertion(map[string]any{"aud": "hostry-identity", "did": o.DeviceID, "jti": hx.NewJTI(), "iat": time.Now().Unix(), "cid": cid})
	r = o.ID.Post("/v1/sessions", map[string]any{"grant_type": "otp", "challenge_id": cid, "code": code, "device_id": o.DeviceID, "device_assertion": assertion}, "Idempotency-Key", hx.NewID())
	if r.Status != 201 {
		return r
	}
	m := r.Map()
	tok := m["tokens"].(map[string]any)
	o.Access, _ = tok["access_token"].(string)
	o.Refresh, _ = tok["refresh_token"].(string)
	o.MemberID, _ = m["member_id"].(string)
	o.SessionID, _ = m["session_id"].(string)
	o.C = hx.New(st.IdentityURL).With("Authorization", "Bearer "+o.Access)
	return r
}

// tenancy returns a bearer client for the tenancy service with this owner's token.
func (o *owner) tenancy() *hx.Client {
	return hx.New(st.TenancyURL).With("Authorization", "Bearer "+o.Access)
}
