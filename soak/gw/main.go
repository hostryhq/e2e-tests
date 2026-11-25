// Command soakgw is what the soak still needs beside the stack, now that the LAN hub is svc-sync's own cmd/hub (activated with an
// identity-issued hub pack, TLS 1.3, run as a process by the driver) and the devices' LAN credentials are identity's.
//
// What soakgw still does, and why (each is a harness need, not a stand-in for a product):
//
//  1. The INTERNET SWITCH. The hub reaches identity and the cloud gateway through two reverse proxies of this process; `uplink` down
//     answers 503 to both, so the hub loses the internet exactly as a real outlet does, while the LAN (hub to devices) is untouched.
//  2. The WALL CLOCK. The real hub, gateway and identity run on wall time and nothing in them can be set; the driver reads the wall
//     time of this process (GET /soak/now) so the virtual trading day starts at it and the waits that depend on real minutes (the
//     approval window, S6) are measured on the clock the gateway really uses. There is no hook to advance the gateway's clock.
//  3. Device bearer tokens (the real identity's createDeviceToken with a device-key assertion, cached) for the devices' direct path to the
//     gateway, and the restore epoch of a cloud rollback (svc-sync's dev epoch table, devepoch.Stamp). Plumbing of the harness.
//  4. A read-only check of the hub's disk for T1 (the hub's rows are column-encrypted: the harness counts rows and looks for a value
//     in the clear).
//
// Dev and test only (ADR-0001 AM12). Keys are generated per run; nothing here is a secret.
package main

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"github.com/hostryhq/svc-sync/devepoch"
	sp "github.com/hostryhq/svc-sync/syncproto"
)

type onboardDevice struct {
	ID      string           `json:"id"`
	Kind    string           `json:"kind"`
	Name    string           `json:"name"`
	Kid     string           `json:"kid"`
	Pub     string           `json:"pub"`
	PKCS8   string           `json:"pkcs8"`
	Series  []map[string]any `json:"series"`
	Pack    map[string]any   `json:"pack_claims"`
	PackJWS string           `json:"pack_jws"`
}

type onboard struct {
	Tenant  string          `json:"tenant_id"`
	Brand   string          `json:"brand_id"`
	Outlet  string          `json:"outlet_id"`
	Devices []onboardDevice `json:"devices"`
}

type tokenEntry struct {
	tok string
	exp time.Time
}

type app struct {
	idURL   string
	uplink  atomic.Bool
	devKeys map[string]*ecdsa.PrivateKey
	mu      sync.Mutex
	tokens  map[string]tokenEntry
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

// assertion is the device-key ES256 JWS identity's token routes expect (aud, did, jti, iat).
func assertion(k *ecdsa.PrivateKey, did string) string {
	h := b64([]byte(`{"alg":"ES256","typ":"JWT"}`))
	jti := make([]byte, 12)
	_, _ = rand.Read(jti)
	pl, _ := json.Marshal(map[string]any{"aud": "hostry-identity", "did": did, "jti": b64(jti), "iat": time.Now().Unix()})
	in := h + "." + b64(pl)
	sum := sha256.Sum256([]byte(in))
	r, s, err := ecdsa.Sign(rand.Reader, k, sum[:])
	if err != nil {
		panic(err)
	}
	sig := make([]byte, 64)
	r.FillBytes(sig[:32])
	s.FillBytes(sig[32:])
	return in + "." + b64(sig)
}

// mint returns a real identity device token for the device (createDeviceToken, device grant).
func (a *app) mint(device string) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if e, ok := a.tokens[device]; ok && time.Now().Before(e.exp) {
		return e.tok, nil
	}
	k := a.devKeys[device]
	if k == nil {
		return "", fmt.Errorf("no key for device %s", device)
	}
	body, _ := json.Marshal(map[string]any{"grant_type": "device", "device_id": device, "assertion": assertion(k, device)})
	req, _ := http.NewRequest("POST", a.idURL+"/v1/tokens/device", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	idem := make([]byte, 12)
	_, _ = rand.Read(idem)
	req.Header.Set("Idempotency-Key", b64(idem))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	if res.StatusCode != 200 && res.StatusCode != 201 {
		return "", fmt.Errorf("createDeviceToken %d: %s", res.StatusCode, raw)
	}
	var out struct {
		Access string    `json:"access_token"`
		Exp    time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", err
	}
	a.tokens[device] = tokenEntry{tok: out.Access, exp: out.Exp.Add(-time.Minute)}
	return out.Access, nil
}

func parseKey(p8 string) *ecdsa.PrivateKey {
	der, err := base64.RawURLEncoding.DecodeString(p8)
	check(err)
	k, err := x509.ParsePKCS8PrivateKey(der)
	check(err)
	return k.(*ecdsa.PrivateKey)
}

func jwkPub(j map[string]any) *ecdsa.PublicKey {
	x, err := base64.RawURLEncoding.DecodeString(j["x"].(string))
	check(err)
	y, err := base64.RawURLEncoding.DecodeString(j["y"].(string))
	check(err)
	return &ecdsa.PublicKey{Curve: elliptic.P256(), X: new(big.Int).SetBytes(x), Y: new(big.Int).SetBytes(y)}
}

// gated is a reverse proxy to target that answers 503 while the internet is cut.
func (a *app) gated(target string) http.Handler {
	u, err := url.Parse(target)
	check(err)
	rp := httputil.NewSingleHostReverseProxy(u)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !a.uplink.Load() {
			http.Error(w, `{"status":"internet cut"}`, http.StatusServiceUnavailable)
			return
		}
		rp.ServeHTTP(w, r)
	})
}

func main() {
	obFile := flag.String("onboard", "onboard.json", "soak-onboard output")
	out := flag.String("out", "fixture.json", "fixture file to write")
	dsn := flag.String("db", os.Getenv("SOAK_PG_DSN_SYNC"), "gateway Postgres DSN (restore epoch stamp)")
	idURL := flag.String("identity", os.Getenv("SOAK_IDENTITY_URL"), "identity base URL")
	cloudURL := flag.String("cloud", "http://127.0.0.1:28104", "the real gateway's URL")
	hubAddr := flag.String("hub", "127.0.0.1:28115", "the address the real cmd/hub listens on (TLS 1.3)")
	ctlAddr := flag.String("ctl", "127.0.0.1:28116", "control listen address")
	cloudProxy := flag.String("cloud-proxy", "127.0.0.1:28117", "the internet switch in front of the gateway, for the hub")
	idProxy := flag.String("identity-proxy", "127.0.0.1:28118", "the internet switch in front of identity, for the hub")
	hubDir := flag.String("hub-dir", os.TempDir(), "directory of the hub's state")
	flag.Parse()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	a := &app{idURL: *idURL, tokens: map[string]tokenEntry{}, devKeys: map[string]*ecdsa.PrivateKey{}}
	raw, err := os.ReadFile(*obFile)
	check(err)
	var ob onboard
	check(json.Unmarshal(raw, &ob))
	fx := map[string]any{"tenant_id": ob.Tenant, "outlet_id": ob.Outlet, "brand_id": ob.Brand}
	var devices []map[string]any
	for _, d := range ob.Devices {
		a.devKeys[d.ID] = parseKey(d.PKCS8)
		devices = append(devices, map[string]any{"device_id": d.ID, "kind": d.Kind, "name": d.Name, "kid": d.Kid, "pub": d.Pub, "pkcs8": d.PKCS8, "series": d.Series, "pack": d.Pack, "pack_jws": d.PackJWS})
	}
	if len(ob.Devices) == 0 {
		log.Fatal("onboard.json has no device")
	}
	if k, ok := ob.Devices[0].Pack["op_signing_public_key"].(map[string]any); ok {
		kid, _ := k["kid"].(string)
		fx["cloud_keys"] = map[string]string{kid: sp.EncodePub(jwkPub(k))}
	}
	fx["devices"] = devices
	a.uplink.Store(false)

	statePath := filepath.Join(*hubDir, "hub-state")
	fx["cloud_url"] = *cloudURL
	fx["hub_url"] = "https://" + *hubAddr
	fx["ctl_url"] = "http://" + *ctlAddr
	fx["hub"] = map[string]any{"state_dir": statePath, "addr": *hubAddr, "cloud_url": "http://" + *cloudProxy, "identity_url": "http://" + *idProxy, "identity_direct_url": *idURL}
	serve(ctx, *cloudProxy, a.gated(*cloudURL))
	serve(ctx, *idProxy, a.gated(*idURL))

	ctl := http.NewServeMux()
	ctl.HandleFunc("GET /soak/token", func(w http.ResponseWriter, r *http.Request) {
		tok, err := a.mint(r.URL.Query().Get("device"))
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		_, _ = w.Write([]byte(tok))
	})
	ctl.HandleFunc("GET /soak/now", func(w http.ResponseWriter, r *http.Request) {
		_, _ = fmt.Fprint(w, time.Now().UnixMilli())
	})
	ctl.HandleFunc("POST /soak/uplink", func(w http.ResponseWriter, r *http.Request) {
		a.uplink.Store(r.URL.Query().Get("up") == "1")
		w.WriteHeader(204)
	})
	// The hub's disk: rows of op_pii (column-encrypted) and how many files of the state directory hold `needle` in the clear.
	ctl.HandleFunc("GET /soak/hub/pii", func(w http.ResponseWriter, r *http.Request) {
		needle := r.URL.Query().Get("needle")
		rows := -1
		if db, err := sql.Open("sqlite", "file:"+filepath.Join(statePath, "hub.db")+"?mode=ro"); err == nil {
			defer db.Close()
			var n int
			if db.QueryRowContext(ctx, `SELECT count(*) FROM op_pii`).Scan(&n) == nil {
				rows = n
			}
		}
		clear := 0
		ents, _ := os.ReadDir(statePath)
		for _, e := range ents {
			if e.IsDir() || e.Name() == "device.key" {
				continue
			}
			if b, err := os.ReadFile(filepath.Join(statePath, e.Name())); err == nil && needle != "" && bytes.Contains(b, []byte(needle)) {
				clear++
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]int{"rows": rows, "files_with_needle_in_clear": clear})
	})
	ctl.HandleFunc("POST /soak/epoch", func(w http.ResponseWriter, r *http.Request) {
		if err := devepoch.Stamp(ctx, *dsn, r.URL.Query().Get("id")); err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
	serve(ctx, *ctlAddr, ctl)

	rawfx, _ := json.MarshalIndent(fx, "", "  ")
	check(os.WriteFile(*out, rawfx, 0o600))
	fmt.Printf("soakgw up: ctl %s hub %s (real cmd/hub) fixture %s\n", fx["ctl_url"], fx["hub_url"], *out)
	<-ctx.Done()
}

func serve(ctx context.Context, addr string, h http.Handler) {
	ln, err := net.Listen("tcp", addr)
	check(err)
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	go func() { <-ctx.Done(); _ = srv.Shutdown(context.Background()) }()
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
