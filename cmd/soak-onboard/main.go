// Command soak-onboard onboards one organisation on a RUNNING Phase 2 local stack through the real
// services (vendor bootstrap, svc-admin, svc-tenancy, svc-identity) and writes what the soak needs:
// tenant, outlet, tax registration, an owner access token, and the devices registered through identity
// with the series tenancy issued to them. Nothing here is a secret outside the throw-away dev stack.
//
//	SOAK_IDENTITY_URL SOAK_TENANCY_URL SOAK_ADMIN_URL SOAK_ADMIN_ORIGIN SOAK_IDENTITY_BIN  (+ the identity
//	binary's own environment, which soak/scripts/stack-env.sh exports)
//	soak-onboard -out onboard.json -name "Soak Foods" -devices pos:A,pos:B,waiter:C1,waiter:C2,kds:K1,kds:K2
package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/hostryhq/e2e-tests/internal/hx"
	"golang.org/x/crypto/argon2"
)

func must(r hx.Resp, what string, want ...int) hx.Resp {
	for _, w := range want {
		if r.Status == w {
			return r
		}
	}
	log.Fatalf("%s: want %v, got %s", what, want, r)
	return r
}

func gstin(state, pan string) string {
	const cs = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	body := state + pan + "1Z"
	sum := 0
	for i, c := range body {
		v := strings.IndexByte(cs, byte(c))
		if i%2 == 1 {
			v *= 2
		}
		sum += v/36 + v%36
	}
	return body + string(cs[(36-sum%36)%36])
}

// identityServiceToken signs the 60-second service token identity would send to tenancy (ES256, kid and iss
// "identity", aud "tenancy") with the stack's identity service key: the real identity binary issues only a
// tax_invoice series per billing device in this build, and tenancy's issueDocumentSeries is identity-only.
func identityServiceToken(keyFile, tenant string) string {
	b, err := os.ReadFile(keyFile)
	if err != nil {
		log.Fatal(err)
	}
	blk, _ := pem.Decode(b)
	k, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		log.Fatal(err)
	}
	key := k.(*ecdsa.PrivateKey)
	now := time.Now()
	jti := make([]byte, 16)
	_, _ = rand.Read(jti)
	hb, _ := json.Marshal(map[string]string{"alg": "ES256", "typ": "JWT", "kid": "identity"})
	pb, _ := json.Marshal(map[string]any{"iss": "identity", "aud": []string{"tenancy"}, "sub": "identity", "typ": "service", "tid": tenant,
		"iat": now.Unix(), "exp": now.Add(55 * time.Second).Unix(), "jti": fmt.Sprintf("%x", jti)})
	in := base64.RawURLEncoding.EncodeToString(hb) + "." + base64.RawURLEncoding.EncodeToString(pb)
	sum := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, key, sum[:])
	if err != nil {
		log.Fatal(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return in + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// ownerLogin runs the owner's OTP sign-in on a fresh device key and returns the access token.
func ownerLogin(idURL, mobile string) string {
	idc := hx.New(idURL)
	ownerDev, ownerKey := hx.NewID(), hx.NewDeviceKey()
	r := must(idc.Post("/v1/otp-challenges", map[string]any{"mobile_e164": mobile, "device_id": ownerDev, "device_public_key": ownerKey.JWK()}, "Idempotency-Key", hx.NewID()), "otp challenge", 202)
	cid := r.Map()["id"].(string)
	cp := idc.Get("/dev/otp/" + strings.TrimPrefix(mobile, "+"))
	if cp.Status != 200 {
		cp = must(idc.Get("/dev/otp/%2B"+strings.TrimPrefix(mobile, "+")), "dev otp", 200)
	}
	otp, _ := cp.Map()["code"].(string)
	assertion := ownerKey.Assertion(map[string]any{"aud": "hostry-identity", "did": ownerDev, "jti": hx.NewJTI(), "iat": time.Now().Unix(), "cid": cid})
	r = must(idc.Post("/v1/sessions", map[string]any{"grant_type": "otp", "challenge_id": cid, "code": otp, "device_id": ownerDev, "device_assertion": assertion}, "Idempotency-Key", hx.NewID()), "owner session", 201)
	return r.Map()["tokens"].(map[string]any)["access_token"].(string)
}

func env(k string) string {
	v := os.Getenv(k)
	if v == "" {
		log.Fatalf("%s is required", k)
	}
	return v
}

type device struct {
	ID      string           `json:"id"`
	Kind    string           `json:"kind"`
	Name    string           `json:"name"`
	Series  []map[string]any `json:"series"`
	Pack    map[string]any   `json:"pack_claims,omitempty"`
	PackJWS string           `json:"pack_jws,omitempty"`
	Kid     string           `json:"kid"`
	Pub     string           `json:"pub"`
	PKCS8   string           `json:"pkcs8"`
}

func main() {
	out := flag.String("out", "onboard.json", "output file")
	name := flag.String("name", "Soak Foods", "organisation name")
	devs := flag.String("devices", "pos:A", "kind:name list")
	vstate := flag.String("vendor-state", "vendor-state.json", "vendor bootstrap credentials (created on first use)")
	recoverEmail := flag.String("recover-email", "", "recover this existing platform_admin when the vendor state file is missing")
	mobile := flag.String("mobile", "", "owner mobile (+91...)")
	loginOnly := flag.Bool("login-only", false, "sign the owner of -mobile in again (access tokens live 15 minutes) and print the access token")
	flag.Parse()
	idURL, tnURL, adURL, origin := env("SOAK_IDENTITY_URL"), env("SOAK_TENANCY_URL"), env("SOAK_ADMIN_URL"), env("SOAK_ADMIN_ORIGIN")
	if *loginOnly {
		fmt.Print(ownerLogin(idURL, *mobile))
		return
	}
	suffix := hx.NewJTI()[:8]
	if *mobile == "" {
		*mobile = fmt.Sprintf("+9198%08d", time.Now().UnixNano()%100000000)
	}

	// The stack allows one bootstrap platform_admin (no HTTP route, by design): create it once, keep its
	// throw-away credentials in the vendor state file, and sign in with them on later runs.
	type vendor struct {
		Email, Pass, Secret string
		Last                int64
	}
	var v vendor
	ac := hx.New(adURL).With("Origin", origin)
	if raw, err := os.ReadFile(*vstate); err == nil {
		if err := json.Unmarshal(raw, &v); err != nil {
			log.Fatal(err)
		}
	} else {
		v = vendor{Email: "soak-" + suffix + "@example.test", Pass: "soak-pass-phrase-" + suffix}
		verb := "bootstrap"
		if *recoverEmail != "" { // the state file was lost: recover the existing platform_admin instead
			v.Email, verb = *recoverEmail, "recover"
		}
		cmd := exec.Command(env("SOAK_IDENTITY_BIN"), "vendor", verb, "--email", v.Email)
		var ob bytes.Buffer
		cmd.Stdout, cmd.Stderr = &ob, &ob
		if err := cmd.Run(); err != nil {
			log.Fatalf("vendor bootstrap: %v: %s", err, ob.String())
		}
		lines := strings.Split(strings.TrimSpace(ob.String()), "\n")
		tok := strings.TrimSpace(lines[len(lines)-1])
		r := must(ac.Post("/v1/account-setups", map[string]any{"setup_token": tok}, "Idempotency-Key", hx.NewID()), "beginAccountSetup", 201)
		secret, err := hx.TOTPFromURI(r.Map()["totp_provisioning_uri"].(string))
		if err != nil {
			log.Fatal(err)
		}
		v.Secret = secret
		code, _ := hx.TOTPNext(v.Secret, &v.Last)
		must(ac.Post("/v1/account-setup-completions", map[string]any{"setup_token": tok, "password": v.Pass, "totp_code": code}, "Idempotency-Key", hx.NewID()), "completeAccountSetup", 200)
	}
	code, _ := hx.TOTPNext(v.Secret, &v.Last)
	r := must(ac.Post("/v1/sessions", map[string]any{"email": v.Email, "password": v.Pass, "totp_code": code}, "Idempotency-Key", hx.NewID()), "admin sign-in", 201)
	if raw, err := json.Marshal(v); err == nil {
		_ = os.WriteFile(*vstate, raw, 0o600)
	}
	var cookie string
	for _, sc := range r.Header.Values("Set-Cookie") {
		if strings.HasPrefix(sc, "__Host-hostry-admin=") {
			cookie = strings.SplitN(strings.SplitN(sc, ";", 2)[0], "=", 2)[1]
		}
	}
	csrf, _ := r.Map()["csrf_token"].(string)
	mut := func(method, path string, body any) hx.Resp {
		return ac.Do(method, path, body, "Cookie", "__Host-hostry-admin="+cookie, "X-CSRF-Token", csrf, "Origin", origin, "Idempotency-Key", hx.NewID())
	}

	pb := make([]byte, 5)
	_, _ = rand.Read(pb)
	pan := ""
	for _, b := range pb {
		pan += string(rune('A' + b%26))
	}
	gst := gstin("33", pan+fmt.Sprintf("%04d", time.Now().UnixNano()%10000)+"F") // one organisation per GSTIN
	form := map[string]any{
		"name":             *name,
		"outlet":           map[string]any{"name": *name + " Main", "kind": "restaurant", "state_code": "33"},
		"tax_registration": map[string]any{"legal_name": *name + " Pvt Ltd", "regime": "regular", "gstin": gst},
		"owner":            map[string]any{"name": "Anand", "mobile_e164": *mobile},
	}
	r = must(mut("POST", "/v1/organisations", form), "createOrganisation", 201)
	m := r.Map()
	cr := m["created"].(map[string]any)
	orgID := cr["organisation"].(map[string]any)["id"].(string)
	brandID := cr["brand"].(map[string]any)["id"].(string)
	outletID := cr["outlet"].(map[string]any)["id"].(string)
	regID := cr["tax_registration"].(map[string]any)["id"].(string)

	// Owner OTP login (the dev capture aid returns the code the test SMS sender "sent").
	idc := hx.New(idURL)
	ownerDev, ownerKey := hx.NewID(), hx.NewDeviceKey()
	r = must(idc.Post("/v1/otp-challenges", map[string]any{"mobile_e164": *mobile, "device_id": ownerDev, "device_public_key": ownerKey.JWK()}, "Idempotency-Key", hx.NewID()), "otp challenge", 202)
	cid := r.Map()["id"].(string)
	cp := idc.Get("/dev/otp/" + strings.TrimPrefix(*mobile, "+"))
	if cp.Status != 200 {
		cp = must(idc.Get("/dev/otp/%2B"+strings.TrimPrefix(*mobile, "+")), "dev otp", 200)
	}
	otp, _ := cp.Map()["code"].(string)
	assertion := ownerKey.Assertion(map[string]any{"aud": "hostry-identity", "did": ownerDev, "jti": hx.NewJTI(), "iat": time.Now().Unix(), "cid": cid})
	r = must(idc.Post("/v1/sessions", map[string]any{"grant_type": "otp", "challenge_id": cid, "code": otp, "device_id": ownerDev, "device_assertion": assertion}, "Idempotency-Key", hx.NewID()), "owner session", 201)
	access := r.Map()["tokens"].(map[string]any)["access_token"].(string)
	oc := hx.New(idURL).With("Authorization", "Bearer "+access)
	tc := hx.New(tnURL).With("Authorization", "Bearer "+access)

	must(mut("PUT", "/v1/organisations/"+orgID+"/tax-registrations/"+regID+"/verification", map[string]any{"method": "certificate_seen", "note": "Certificate seen (soak)."}), "verifyTaxRegistration", 200)

	// The paper bill book (entry-only series MB1) is registered with tenancy by the owner; best effort, the result is printed.
	mb := tc.Post("/v1/manual-book-series", map[string]any{"tax_registration_id": regID, "code": "MB1", "outlet_ids": []string{outletID}}, "Idempotency-Key", hx.NewID())
	fmt.Printf("registerManualBookSeries MB1: HTTP %d %s\n", mb.Status, strings.TrimSpace(string(mb.Body)[:min(len(mb.Body), 160)]))

	// Roles: the restaurant templates of app-restaurant (fixtures/demo-pack.ts ROLE_PERMS) as identity roles.
	roleIDs := map[string]string{}
	for _, rn := range []string{"waiter", "cashier", "manager"} {
		rid := hx.NewID()
		must(oc.Post("/v1/roles", map[string]any{"id": rid, "name": rn, "permissions": rolePerms[rn]}, "Idempotency-Key", hx.NewID()), "createRole "+rn, 201)
		roleIDs[rn] = rid
	}

	var devices []device
	for _, spec := range strings.Split(*devs, ",") {
		kv := strings.SplitN(spec, ":", 2)
		kind, dname := kv[0], kv[1]
		key, did := hx.NewDeviceKey(), hx.NewID()
		nr := must(idc.Post("/v1/device-nonces", nil, "Idempotency-Key", hx.NewID()), "nonce", 200, 201)
		nonce := nr.Map()["nonce"].(string)
		reg := oc.Post("/v1/devices", map[string]any{"id": did, "kind": kind, "name": dname, "outlet_id": outletID, "public_key": key.JWK(),
			"key_protection": "os-software", "nonce": nonce, "nonce_signature": key.SignRaw(nonce)}, "Idempotency-Key", hx.NewID())
		must(reg, "registerDevice "+kind+":"+dname, 201)
		pk, err := x509.MarshalPKCS8PrivateKey(key.Priv)
		if err != nil {
			log.Fatal(err)
		}
		pub := key.Priv.PublicKey
		raw := append([]byte{4}, append(pub.X.FillBytes(make([]byte, 32)), pub.Y.FillBytes(make([]byte, 32))...)...)
		d := device{ID: did, Kind: kind, Name: dname, Kid: deviceKID(did), Pub: base64.RawURLEncoding.EncodeToString(raw), PKCS8: base64.RawURLEncoding.EncodeToString(pk)}
		if kind == "pos" {
			ci := hx.New(tnURL).With("Hostry-Service-Token", identityServiceToken(os.Getenv("SOAK_STATE")+"/keys/identity.key", orgID))
			must(ci.Post("/internal/v1/document-series-issuances", map[string]any{"outlet_id": outletID, "device_id": did, "doc_types": []string{"credit_note"}, "state": "active"}, "Idempotency-Key", hx.NewID()), "issue credit_note series", 200, 201)
		}
		devices = append(devices, d)
	}
	if len(devices) == 0 {
		log.Fatal("no devices")
	}

	// Staff: members with roles scoped to the outlet, each signs in once by OTP on a device key of their own to choose a PIN
	// (setPin is the member's own call, ADR-0005 s5). The proof key the identity derives from the PIN is derived again here from the
	// pack's salt: that is the native shell's job (H1), which this harness stands in for.
	type staffRec struct {
		ID   string `json:"id"`
		Name string `json:"name"`
		Role string `json:"role"`
		PIN  string `json:"pin"`
	}
	var staff []staffRec
	ownerMember := ""
	{
		ml := oc.Get("/v1/members")
		var lst struct {
			Items []struct {
				ID          string `json:"id"`
				DisplayName string `json:"display_name"`
			} `json:"items"`
		}
		_ = json.Unmarshal(ml.Body, &lst)
		if ml.Status != 200 || len(lst.Items) == 0 {
			log.Fatalf("listMembers: %s", ml)
		}
		ownerMember = lst.Items[0].ID
	}
	staff = append(staff, staffRec{ID: ownerMember, Name: "Anand", Role: "owner", PIN: "264097"})
	for _, st := range []struct{ name, role, pin string }{{"Asha", "cashier", "482915"}, {"Ravi", "waiter", "539204"}, {"Meena", "manager", "718305"}} {
		mid := hx.NewID()
		mob := fmt.Sprintf("+9197%08d", time.Now().UnixNano()%100000000+int64(len(staff)))
		must(oc.Post("/v1/members", map[string]any{"id": mid, "display_name": st.name, "mobile_e164": mob,
			"role_assignments": []map[string]any{{"id": hx.NewID(), "role_id": roleIDs[st.role], "outlet_ids": []string{outletID}}}}, "Idempotency-Key", hx.NewID()), "createMember "+st.name, 201)
		mtok := ownerLogin(idURL, mob)
		mc := hx.New(idURL).With("Authorization", "Bearer "+mtok)
		must(mc.Put("/v1/members/"+mid+"/pin", map[string]any{"device_id": devices[0].ID, "pin": st.pin}, "Idempotency-Key", hx.NewID()), "setPin "+st.name, 200)
		staff = append(staff, staffRec{ID: mid, Name: st.name, Role: st.role, PIN: st.pin})
	}
	// The owner chooses a PIN on the first device (the owner session is the OTP session above).
	must(oc.Put("/v1/members/"+ownerMember+"/pin", map[string]any{"device_id": devices[0].ID, "pin": "264097"}, "Idempotency-Key", hx.NewID()), "setPin Anand", 200)

	// The packs as they stand now (members, PIN salts, series) and the series registry.
	for i := range devices {
		pack := oc.Get("/v1/devices/" + devices[i].ID + "/offline-packs/latest")
		if pack.Status != 200 {
			log.Fatalf("offline pack of %s: %s", devices[i].Name, pack)
		}
		claims, _ := pack.Map()["claims"].(map[string]any)
		devices[i].Pack = claims
		devices[i].PackJWS, _ = pack.Map()["jws"].(string)
	}
	reg := tc.Get("/v1/document-series?outlet_id=" + outletID)
	var regDoc struct {
		Items []map[string]any `json:"items"`
	}
	_ = reg.JSON(&regDoc)
	for i := range devices {
		devices[i].Series = nil
		for _, it := range regDoc.Items {
			if it["device_id"] == devices[i].ID {
				devices[i].Series = append(devices[i].Series, it)
			}
		}
	}
	// Proof keys of every staff member, from the PIN and the salt in the pack (the shell stands in).
	proofKeys := map[string]map[string]any{}
	for _, m := range devices[0].Pack["members"].([]any) {
		mm := m.(map[string]any)
		salt, _ := mm["pin_salt"].(string)
		pv, _ := mm["pin_v"].(float64)
		for _, st := range staff {
			if st.ID == mm["member_id"] && salt != "" {
				// identity stores the salt as unpadded base64url (crypto.B64); the contract text says "Base64".
				sb, err := base64.RawURLEncoding.DecodeString(salt)
				if err != nil {
					if sb, err = base64.StdEncoding.DecodeString(salt); err != nil {
						log.Fatalf("pin_salt of %s: %v", st.Name, err)
					}
				}
				proofKeys[st.ID] = map[string]any{"pin_v": pv, "proof_key": base64.StdEncoding.EncodeToString(proofKey(st.PIN, sb))}
			}
		}
	}

	o := map[string]any{"tenant_id": orgID, "brand_id": brandID, "outlet_id": outletID, "registration_id": regID, "gstin": gst,
		"owner_mobile": *mobile, "owner_access_token": access, "devices": devices, "staff": staff, "proof_keys": proofKeys, "document_series_raw": json.RawMessage(reg.Body)}
	raw, _ := json.MarshalIndent(o, "", "  ")
	if err := os.WriteFile(*out, raw, 0o600); err != nil {
		log.Fatal(err)
	}
	fmt.Printf("onboarded tenant %s outlet %s with %d devices -> %s\n", orgID, outletID, len(devices), *out)
}

// deviceKID is the key id identity gives a device key (svc-identity service.DeviceKID).
func deviceKID(id string) string {
	t := id
	if len(t) > 4 {
		t = t[len(t)-4:]
	}
	return "dev-" + t + "-1"
}

// proofKey is the PIN-derived proof key (ADR-0005 s5): HKDF-SHA256 over Argon2id(pin, salt, t=2, m=19 MiB, p=1), info
// "hostry/pin/proof/v1". The native shell does this on a device; identity does the same to verify (H1: no shell yet).
func proofKey(pin string, salt []byte) []byte {
	s := argon2.IDKey([]byte(pin), salt, 2, 19*1024, 1, 32)
	k, err := hkdf.Key(sha256.New, s, nil, "hostry/pin/proof/v1", 32)
	if err != nil {
		log.Fatal(err)
	}
	return k
}

var rolePerms = map[string][]string{}

func init() {
	waiter := []string{"order.create", "order.edit", "bill.request", "bill.present", "bill.new", "bill.split", "order.items.move", "order.table.move", "kot.handover", "menu.availability.set"}
	cashier := append(append([]string{}, waiter...), "bill.finalize", "payment.record", "bill.discount.apply", "bill.service_charge.remove", "bill.customer_details.edit",
		"order.table.merge", "bill.merge", "shift.open", "shift.close", "drawer.cash_move", "drawer.open_no_sale", "kot.reprint", "kds.bump", "bill.reprint")
	manager := append(append([]string{}, cashier...), "order.line.cancel", "bill.discount.over_limit", "bill.line.comp", "bill.credit_note.create", "bill.rebill", "bill.cancel",
		"payment.refund", "day.close", "shift.close.any", "bill.manual_entry", "report.view.day", "report.view.outlet", "floor.manage", "menu.manage", "menu.price.edit", "settings.outlet.edit")
	rolePerms["waiter"], rolePerms["cashier"], rolePerms["manager"] = waiter, cashier, manager
}
