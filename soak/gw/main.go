// Command soakgw is what the soak still needs beside the stack, now that svc-sync's own cmd/gateway runs the real identity and
// tenancy directory, relays its outbox to NATS and exposes the erasure route: the real LAN hub (hub.New) of the outlet, a
// control port the soak driver uses for faults and the virtual clock, and the device tokens.
//
// What is still missing in the products and therefore here (each listed in the run report):
//
//  1. The hub has no pack source against the real directory. cmd/hub reads a pack file; the only producer of that file is the
//     dev route of the STUB directory (/dev/v1/hub-packs), which cmd/gateway refuses to mount with SYNC_DIRECTORY=identity. And the
//     LAN trust root is an identity signature over each credential (syncproto.CredentialEnvelope) that real identity does not
//     produce (its getDeviceCredential answer is unsigned, "the gateway trusts the route"). This process builds the same pack the
//     stub would, from what the real identity and tenancy issued (device keys, kids, kinds, series, staff), and signs the
//     envelopes with a throw-away LAN key of its own.
//  2. A clock the driver sets for the hub (a trading day is compressed; the hub judges ops against its own time). The real
//     gateway runs on wall time; the soak's trading day is yesterday, so every op is in its past.
//  3. A switch for the internet between hub and cloud, and per-device bearer tokens: the tokens are the real identity's
//     (createDeviceToken, device grant signed with the device key), cached until a minute before they expire.
//  4. The restore epoch of a cloud rollback is stamped through svc-sync's dev epoch table (devepoch.Stamp); the gateway process
//     is restarted by the stack script.
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
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/hostryhq/svc-sync/devepoch"
	"github.com/hostryhq/svc-sync/engine"
	"github.com/hostryhq/svc-sync/hub"
	"github.com/hostryhq/svc-sync/repository"
	sp "github.com/hostryhq/svc-sync/syncproto"
)

type onboardDevice struct {
	ID     string           `json:"id"`
	Kind   string           `json:"kind"`
	Name   string           `json:"name"`
	Kid    string           `json:"kid"`
	Pub    string           `json:"pub"`
	PKCS8  string           `json:"pkcs8"`
	Series []map[string]any `json:"series"`
	Pack   map[string]any   `json:"pack_claims"`
}

type onboard struct {
	Tenant  string          `json:"tenant_id"`
	Brand   string          `json:"brand_id"`
	Outlet  string          `json:"outlet_id"`
	Devices []onboardDevice `json:"devices"`
	Staff   []struct {
		ID string `json:"id"`
	} `json:"staff"`
}

// swap is an http.Handler whose target can be replaced or taken down (a hub restart, a kill).
type swap struct{ h atomic.Value }

type hh struct{ http.Handler }

func (s *swap) set(h http.Handler) { s.h.Store(hh{h}) }
func (s *swap) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	v, _ := s.h.Load().(hh)
	if v.Handler == nil {
		http.Error(w, `{"status":"down"}`, http.StatusServiceUnavailable)
		return
	}
	v.ServeHTTP(w, r)
}

type tokenEntry struct {
	tok string
	exp time.Time
}

type app struct {
	log      *slog.Logger
	ctx      context.Context
	hubFile  string
	cloudURL string
	idURL    string
	ob       onboard
	nowNS    atomic.Int64 // the hub's virtual clock (unix ns)
	hubMux   swap
	uplink   atomic.Bool

	lan       *sp.KeyPair
	devKeys   map[string]*ecdsa.PrivateKey
	cloudKeys map[string]*ecdsa.PublicKey
	peers     []sp.CredentialEnvelope
	members   map[string]bool
	owners    map[string]string

	mu      sync.Mutex
	tokens  map[string]tokenEntry
	hubDev  onboardDevice
	hubKey  *sp.KeyPair
	hubCred sp.CredentialEnvelope
	hub     *hub.Hub
	cancel  context.CancelFunc
}

func (a *app) now() time.Time { return time.Unix(0, a.nowNS.Load()).UTC() }

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

func (a *app) startHub(wipe bool) error {
	a.mu.Lock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
	a.mu.Unlock()
	if wipe {
		_ = os.Remove(a.hubFile)
		_ = os.Remove(a.hubFile + "-wal")
		_ = os.Remove(a.hubFile + "-shm")
	}
	ctx, cancel := context.WithCancel(a.ctx)
	hst, err := repository.Open("file:" + a.hubFile)
	if err != nil {
		cancel()
		return err
	}
	h, err := hub.New(ctx, hub.Config{Tenant: a.ob.Tenant, Outlet: a.ob.Outlet, Brand: a.ob.Brand, Cred: a.hubCred, Key: a.hubKey, IdentityPub: &a.lan.Priv.PublicKey,
		CloudKeys: a.cloudKeys, Store: hst, Now: a.now, Peers: a.peers,
		Members:     func(actor string) bool { return a.members[actor] },
		SeriesOwner: func(c string) (string, bool) { d, ok := a.owners[c]; return d, ok }})
	if err != nil {
		cancel()
		return err
	}
	up := &engine.HTTPTransport{Base: a.cloudURL, Authorize: func(r *http.Request, _ []byte) error {
		if !a.uplink.Load() {
			return fmt.Errorf("uplink down (internet cut)")
		}
		tok, err := a.mint(a.hubDev.ID)
		if err != nil {
			return err
		}
		r.Header.Set("Authorization", "Bearer "+tok)
		return nil
	}}
	h.SetUpstream(up)
	a.mu.Lock()
	a.hub = h // rounds with the cloud are driven by the soak (POST /soak/hub?op=sync), not by a timer with a 60 s backoff
	a.cancel = func() { cancel(); _ = hst.Close() }
	a.mu.Unlock()
	a.hubMux.set(h.Handler())
	a.log.Info("hub up", "wiped", wipe)
	return nil
}

func (a *app) stopHub() {
	a.hubMux.set(nil)
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.cancel != nil {
		a.cancel()
		a.cancel = nil
	}
}

func kindOf(k string) string {
	return map[string]string{"pos": sp.KindPOS, "waiter": sp.KindWaiter, "kds": sp.KindKDS, "hub": sp.KindHub}[k]
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

func main() {
	obFile := flag.String("onboard", "onboard.json", "soak-onboard output")
	out := flag.String("out", "fixture.json", "fixture file to write")
	dsn := flag.String("db", os.Getenv("SOAK_PG_DSN_SYNC"), "gateway Postgres DSN (restore epoch stamp)")
	idURL := flag.String("identity", os.Getenv("SOAK_IDENTITY_URL"), "identity base URL")
	cloudURL := flag.String("cloud", "http://127.0.0.1:28104", "the real gateway's URL")
	hubAddr := flag.String("hub", "127.0.0.1:28115", "hub listen address")
	ctlAddr := flag.String("ctl", "127.0.0.1:28116", "control listen address")
	hubDir := flag.String("hub-dir", os.TempDir(), "directory of the hub's disk")
	startMS := flag.Int64("start-ms", 0, "virtual clock start (unix ms); default now")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	a := &app{log: logger, ctx: ctx, cloudURL: *cloudURL, idURL: *idURL, tokens: map[string]tokenEntry{}, devKeys: map[string]*ecdsa.PrivateKey{},
		cloudKeys: map[string]*ecdsa.PublicKey{}, members: map[string]bool{}, owners: map[string]string{}}
	raw, err := os.ReadFile(*obFile)
	check(err)
	check(json.Unmarshal(raw, &a.ob))
	if *startMS == 0 {
		*startMS = time.Now().UnixMilli()
	}
	a.nowNS.Store(*startMS * int64(time.Millisecond))
	a.hubFile = *hubDir + "/hub-" + a.ob.Outlet + ".db"
	_ = os.Remove(a.hubFile)

	a.lan, err = sp.NewKeyPair("soak-lan-identity", nil)
	check(err)
	for _, s := range a.ob.Staff {
		a.members[s.ID] = true
	}
	notAfter := time.Now().Add(30 * 24 * time.Hour).Unix()
	fx := map[string]any{"tenant_id": a.ob.Tenant, "outlet_id": a.ob.Outlet, "brand_id": a.ob.Brand, "identity_pub": sp.EncodePub(&a.lan.Priv.PublicKey)}
	var devices []map[string]any
	var haveHub bool
	for _, d := range a.ob.Devices {
		priv := parseKey(d.PKCS8)
		a.devKeys[d.ID] = priv
		cred, err := sp.SignCredential(a.lan, sp.Credential{DeviceID: d.ID, TenantID: a.ob.Tenant, OutletID: a.ob.Outlet, BrandID: a.ob.Brand, Kind: kindOf(d.Kind), Kid: d.Kid, Pub: d.Pub, NotAfter: notAfter})
		check(err)
		for _, s := range d.Series {
			if c, _ := s["code"].(string); c != "" {
				a.owners[c] = d.ID
			}
		}
		if d.Kind == "hub" {
			a.hubDev, a.hubCred, haveHub = d, cred, true
			a.hubKey = &sp.KeyPair{Kid: d.Kid, Priv: priv}
			fx["hub"] = map[string]any{"id": d.ID, "cred": cred}
			continue
		}
		a.peers = append(a.peers, cred)
		devices = append(devices, map[string]any{"device_id": d.ID, "kind": d.Kind, "name": d.Name, "kid": d.Kid, "pub": d.Pub, "pkcs8": d.PKCS8, "cred": cred, "series": d.Series, "pack": d.Pack})
	}
	if !haveHub {
		log.Fatal("onboard.json has no hub device")
	}
	if len(a.ob.Devices) > 0 {
		if k, ok := a.ob.Devices[0].Pack["op_signing_public_key"].(map[string]any); ok {
			kid, _ := k["kid"].(string)
			a.cloudKeys[kid] = jwkPub(k)
			fx["cloud_keys"] = map[string]string{kid: sp.EncodePub(a.cloudKeys[kid])}
		}
	}
	fx["devices"] = devices

	check(a.startHub(false))
	a.uplink.Store(false)
	fx["cloud_url"] = a.cloudURL
	fx["hub_url"] = serve(ctx, *hubAddr, &a.hubMux)
	fx["ctl_url"] = "http://" + *ctlAddr

	ctl := http.NewServeMux()
	ctl.HandleFunc("GET /soak/token", func(w http.ResponseWriter, r *http.Request) {
		tok, err := a.mint(r.URL.Query().Get("device"))
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		_, _ = w.Write([]byte(tok))
	})
	ctl.HandleFunc("POST /soak/clock", func(w http.ResponseWriter, r *http.Request) {
		ms, err := strconv.ParseInt(r.URL.Query().Get("ms"), 10, 64)
		if err != nil {
			http.Error(w, "ms", 400)
			return
		}
		a.nowNS.Store(ms * int64(time.Millisecond))
		w.WriteHeader(204)
	})
	ctl.HandleFunc("POST /soak/uplink", func(w http.ResponseWriter, r *http.Request) {
		a.uplink.Store(r.URL.Query().Get("up") == "1")
		w.WriteHeader(204)
	})
	ctl.HandleFunc("POST /soak/hub", func(w http.ResponseWriter, r *http.Request) {
		var err error
		switch r.URL.Query().Get("op") {
		case "sync": // one hub round with the cloud (fails while the internet is cut)
			a.mu.Lock()
			h := a.hub
			a.mu.Unlock()
			if h == nil {
				http.Error(w, "hub down", 503)
				return
			}
			res, serr := h.SyncUpstream(ctx)
			if serr != nil {
				http.Error(w, serr.Error(), 502)
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"pushed": res.Pushed, "pulled": res.Pulled, "refused": res.Refused, "epoch_changed": res.EpochChanged, "refusals": h.LastRefused()})
			return
		case "stop":
			a.stopHub()
		case "start":
			err = a.startHub(false)
		case "wipe":
			a.stopHub()
			err = a.startHub(true)
		default:
			http.Error(w, "op", 400)
			return
		}
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.WriteHeader(204)
	})
	// Where the hub holds personal values (ADR-0014 A3.1): rows of its op_pii table, and how many of them carry `needle` (a customer name of the script).
	ctl.HandleFunc("GET /soak/hub/pii", func(w http.ResponseWriter, r *http.Request) {
		db, err := sql.Open("sqlite", "file:"+a.hubFile+"?mode=ro")
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer db.Close()
		rows, err := db.QueryContext(ctx, `SELECT data FROM op_pii`)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer rows.Close()
		needle := r.URL.Query().Get("needle")
		n, with := 0, 0
		for rows.Next() {
			var d any
			if err := rows.Scan(&d); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			n++
			var s string
			switch v := d.(type) {
			case []byte:
				s = string(v)
			case string:
				s = v
			}
			if needle != "" && strings.Contains(s, needle) {
				with++
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]int{"rows": n, "with_needle": with})
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
	fmt.Printf("soakgw up: cloud %s hub %s ctl %s fixture %s\n", a.cloudURL, fx["hub_url"], fx["ctl_url"], *out)
	<-ctx.Done()
}

func serve(ctx context.Context, addr string, h http.Handler) string {
	ln, err := net.Listen("tcp", addr)
	check(err)
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	go func() { <-ctx.Done(); _ = srv.Shutdown(context.Background()) }()
	return "http://" + ln.Addr().String()
}

func check(err error) {
	if err != nil {
		log.Fatal(err)
	}
}
