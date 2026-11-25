//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

// vendorUser is a vendor staff member driving the admin API the way admin-web does: session cookie, CSRF
// token and a matching Origin. The cookie is carried by hand because Go's jar refuses a Secure cookie over
// plain http, and the test stack has no TLS.
type vendorUser struct {
	Email, Password, Secret string
	lastStep                int64
	c                       *hx.Client
	cookie, csrf            string
	UserID                  string
}

func newVendorUser(email string) *vendorUser {
	return &vendorUser{Email: email, Password: "e2e-pass-phrase-" + hx.NewJTI()[:8], c: hx.New(st.AdminURL).With("Origin", st.AdminOrigin)}
}

// bootstrap runs `svc-identity vendor bootstrap` and returns the one-time setup token (last output line).
func bootstrap(t *testing.T, email string) string {
	t.Helper()
	out, err := st.RunIdentity(context.Background(), "vendor", "bootstrap", "--email", email)
	if err != nil {
		t.Fatalf("vendor bootstrap %s: %v: %s", email, err, out)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	tok := strings.TrimSpace(lines[len(lines)-1])
	if len(tok) < 20 {
		t.Fatalf("no setup token in bootstrap output: %q", out)
	}
	return tok
}

// setup completes the one-time account setup (password and TOTP enrolment).
func (v *vendorUser) setup(t *testing.T, token string) {
	t.Helper()
	r := v.c.Post("/v1/account-setups", map[string]any{"setup_token": token}, "Idempotency-Key", hx.NewID())
	if r.Status != 201 {
		t.Fatalf("beginAccountSetup: %s", r)
	}
	uri, _ := r.Map()["totp_provisioning_uri"].(string)
	sec, err := hx.TOTPFromURI(uri)
	if err != nil {
		t.Fatal(err)
	}
	v.Secret = sec
	code, err := hx.TOTPNext(v.Secret, &v.lastStep)
	if err != nil {
		t.Fatal(err)
	}
	r = v.c.Post("/v1/account-setup-completions", map[string]any{"setup_token": token, "password": v.Password, "totp_code": code}, "Idempotency-Key", hx.NewID())
	if r.Status != 200 {
		t.Fatalf("completeAccountSetup: %s", r)
	}
	v.UserID, _ = r.Map()["id"].(string)
}

// signIn opens an admin session (cookie plus CSRF).
func (v *vendorUser) signIn(t *testing.T) hx.Resp {
	t.Helper()
	code, err := hx.TOTPNext(v.Secret, &v.lastStep)
	if err != nil {
		t.Fatal(err)
	}
	r := v.c.Post("/v1/sessions", map[string]any{"email": v.Email, "password": v.Password, "totp_code": code}, "Idempotency-Key", hx.NewID())
	if r.Status != 201 {
		return r
	}
	for _, sc := range r.Header.Values("Set-Cookie") {
		if strings.HasPrefix(sc, "__Host-hostry-admin=") {
			v.cookie = strings.SplitN(strings.SplitN(sc, ";", 2)[0], "=", 2)[1]
		}
	}
	v.csrf, _ = r.Map()["csrf_token"].(string)
	if v.cookie == "" || v.csrf == "" {
		t.Fatalf("sign-in gave no cookie or csrf token: %s", r)
	}
	return r
}

// get is a cookie-authenticated read.
func (v *vendorUser) get(path string) hx.Resp {
	return v.c.Get(path, "Cookie", "__Host-hostry-admin="+v.cookie)
}

// mut is a state-changing call: cookie, CSRF token, Origin and an Idempotency-Key (a fresh one unless given).
func (v *vendorUser) mut(method, path string, body any, idem ...string) hx.Resp {
	key := hx.NewID()
	if len(idem) > 0 {
		key = idem[0]
	}
	return v.c.Do(method, path, body, "Cookie", "__Host-hostry-admin="+v.cookie, "X-CSRF-Token", v.csrf, "Origin", st.AdminOrigin, "Idempotency-Key", key)
}

// eventually polls until fn returns true or the deadline passes (no fixed sleeps for synchronisation).
func eventually(t *testing.T, what string, d time.Duration, fn func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if fn() {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", what)
}

func expect(t *testing.T, what string, r hx.Resp, want ...int) {
	t.Helper()
	for _, w := range want {
		if r.Status == w {
			return
		}
	}
	t.Fatalf("%s: want %v, got %s", what, want, r)
}

var _ = fmt.Sprintf
