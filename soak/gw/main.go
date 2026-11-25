// Command soakgw is the soak run's cloud side: the REAL svc-sync gateway (service.New, api.Mount) on the full
// stack's Postgres with its transactional outbox on, the real LAN hub (hub.New), and a control port the soak
// driver uses for faults and the virtual clock.
//
// Why this exists and is not svc-sync's cmd/gateway: that binary, with HOSTRY_SYNC_DIRECTORY=stub, keeps its
// stub identity and its token issuer inside the process with no way to register a device or to mint a device
// token from outside, and nothing relays its outbox to NATS (cmd/gateway has no relay). This process uses the
// same library code with three additions, all listed in the soak report:
//
//  1. the stub directory (identitystub) is activated with the device ids and the series codes the REAL
//     identity and tenancy services issued (read from soak-onboard's output), instead of its own codes;
//  2. go-common's outbox.Relay (the library every other service uses) relays the gateway's outbox to NATS with
//     sync's own NATS credential, so orders and billing receive the sync.op.* events the gateway publishes;
//  3. a clock that the driver sets, so a trading day can be compressed without clock-skew alarms.
//
// Dev and test only (ADR-0001 AM12). The keys are generated per run; nothing here is a secret.
package main

import (
	"context"
	"crypto/x509"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	auth "github.com/hostryhq/go-auth"
	"github.com/hostryhq/go-auth/authtest"
	"github.com/hostryhq/go-common/bus"
	"github.com/hostryhq/go-common/clock"
	"github.com/hostryhq/go-common/ids"
	"github.com/hostryhq/go-common/outbox"
	"github.com/hostryhq/svc-sync/api"
	"github.com/hostryhq/svc-sync/devepoch"
	"github.com/hostryhq/svc-sync/directory"
	"github.com/hostryhq/svc-sync/engine"
	"github.com/hostryhq/svc-sync/hub"
	"github.com/hostryhq/svc-sync/identitystub"
	"github.com/hostryhq/svc-sync/repository"
	"github.com/hostryhq/svc-sync/service"
	sp "github.com/hostryhq/svc-sync/syncproto"
)

type onboardDevice struct {
	ID     string           `json:"id"`
	Kind   string           `json:"kind"`
	Name   string           `json:"name"`
	Series []map[string]any `json:"series"`
}

type onboard struct {
	Tenant  string          `json:"tenant_id"`
	Brand   string          `json:"brand_id"`
	Outlet  string          `json:"outlet_id"`
	Devices []onboardDevice `json:"devices"`
}

// dir is the stub identity with the series registry replaced by the codes tenancy issued.
type dir struct {
	*identitystub.Identity
	mu     sync.Mutex
	series map[string]directory.SeriesInfo // tenant|code
}

func (d *dir) Series(tenant, code string) (directory.SeriesInfo, bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	s, ok := d.series[tenant+"|"+code]
	return s, ok
}

func (d *dir) SeriesOf(tenant, device string) []identitystub.SeriesInfo {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []identitystub.SeriesInfo
	for _, s := range d.series {
		if s.Tenant == tenant && s.Device == device {
			out = append(out, s)
		}
	}
	sort.Slice(out, func(a, b int) bool { return out[a].Code < out[b].Code })
	return out
}

// swap is an http.Handler whose target can be replaced or taken down (a restart, a kill).
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

type app struct {
	serviceKeys auth.KeySet
	log      *slog.Logger
	ctx      context.Context
	dsn      string
	hubFile  string
	cloudURL string
	ob       onboard
	nowNS    atomic.Int64 // virtual clock (unix ns)
	id       *dir
	issuer   *authtest.Issuer
	st       *repository.SQL
	gwMux    swap
	hubMux   swap
	uplink   atomic.Bool

	mu        sync.Mutex
	gwCancel  context.CancelFunc
	hubCancel context.CancelFunc
	gw        *service.Gateway
	hub       *hub.Hub
	hubKey    *sp.KeyPair
	hubCred   sp.CredentialEnvelope
	peers     []sp.CredentialEnvelope
	hubID     string
}

func (a *app) now() time.Time { return time.Unix(0, a.nowNS.Load()).UTC() }

func (a *app) startGateway(epochDSN string) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.gwCancel != nil {
		a.gwCancel()
		a.gwCancel = nil
	}
	ctx, cancel := context.WithCancel(a.ctx)
	ep, err := devepoch.Reader(ctx, epochDSN)
	if err != nil {
		cancel()
		return err
	}
	gw, err := service.New(ctx, service.Config{Store: a.st, Epoch: ep, Dir: a.id, OpKey: a.id.CloudKey, Now: a.now, Log: a.log, Outbox: true})
	if err != nil {
		cancel()
		return err
	}
	mux := http.NewServeMux()
	api.Mount(mux, api.Options{Auth: api.BearerAuth{Verifier: a.issuer.Verifier(), Dir: a.id}, Backend: api.GatewayBackend{G: gw}})
	// Service tokens (emit from catalog and billing) are verified against the stack's own service-key registry, in
	// real time: the real catalog and billing processes sign with their real keys.
	api.Admin(mux, gw, api.AdminAuth{Tenant: a.issuer.Verifier(), Services: &auth.ServiceVerifier{Registry: a.serviceKeys, Self: "sync", Clock: clock.System}, Audit: &repository.AccessSink{S: a.st}, Clock: clock.Func(a.now)})
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"status":"ok"}`)) })
	a.gw = gw
	a.gwMux.set(mux)
	a.gwCancel = cancel
	a.log.Info("gateway up", "epoch", gw.Epoch())
	return nil
}

func (a *app) stopGateway() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.gwMux.set(nil)
	if a.gwCancel != nil {
		a.gwCancel()
		a.gwCancel = nil
	}
}

// startHub starts the real hub. wipe=true removes its disk first (a hub machine with a wiped disk).
func (a *app) startHub(wipe bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.hubCancel != nil {
		a.hubCancel()
		a.hubCancel = nil
	}
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
	cloudKeys := map[string]*hub.PubKey{a.id.CloudKey.Kid: &a.id.CloudKey.Priv.PublicKey}
	h, err := hub.New(ctx, hub.Config{Tenant: a.ob.Tenant, Outlet: a.ob.Outlet, Brand: a.ob.Brand, Cred: a.hubCred, Key: a.hubKey, IdentityPub: a.id.IdentityPub(),
		CloudKeys: cloudKeys, Store: hst, Now: a.now, Peers: a.peers,
		Members:     func(actor string) bool { return a.id.InAnyPackOf(a.ob.Tenant, a.ob.Outlet, actor) },
		SeriesOwner: func(c string) (string, bool) { s, ok := a.id.Series(a.ob.Tenant, c); return s.Device, ok }})
	if err != nil {
		cancel()
		return err
	}
	up := &engine.HTTPTransport{Base: a.cloudURL, Authorize: func(r *http.Request, _ []byte) error {
		if !a.uplink.Load() {
			return fmt.Errorf("uplink down (internet cut)")
		}
		r.Header.Set("Authorization", "Bearer "+a.mint(a.hubID))
		return nil
	}}
	h.SetUpstream(up)
	a.hub = h // rounds with the cloud are driven by the soak (POST /soak/hub?op=sync), not by a timer with a 60 s backoff
	a.hubMux.set(h.Handler())
	a.hubCancel = func() { cancel(); _ = hst.Close() }
	a.log.Info("hub up", "wiped", wipe)
	return nil
}

func (a *app) stopHub() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.hubMux.set(nil)
	if a.hubCancel != nil {
		a.hubCancel()
		a.hubCancel = nil
	}
}

func (a *app) mint(device string) string {
	return a.issuer.Mint(authtest.Spec{Type: auth.TypeDevice, Tenant: ids.ID(a.ob.Tenant), Device: device, TTL: 14 * time.Minute})
}

func main() {
	obFile := flag.String("onboard", "onboard.json", "soak-onboard output")
	out := flag.String("out", "fixture.json", "fixture file to write")
	dsn := flag.String("db", os.Getenv("SOAK_PG_DSN_SYNC"), "gateway Postgres DSN")
	cloudAddr := flag.String("cloud", "127.0.0.1:28104", "gateway listen address")
	hubAddr := flag.String("hub", "127.0.0.1:28115", "hub listen address")
	ctlAddr := flag.String("ctl", "127.0.0.1:28116", "control listen address")
	natsURL := flag.String("nats", os.Getenv("SOAK_NATS_URL"), "NATS URL")
	natsSeed := flag.String("nats-seed", os.Getenv("SOAK_NATS_SEED_SYNC"), "sync's NATS seed file")
	hubDir := flag.String("hub-dir", os.TempDir(), "directory of the hub's disk")
	svcKeys := flag.String("service-keys", os.Getenv("SOAK_STATE")+"/keys/service-keys.jwks.json", "the stack's service-key registry (JWKS)")
	startMS := flag.Int64("start-ms", 0, "virtual clock start (unix ms); default now")
	flag.Parse()

	logger := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	a := &app{log: logger, ctx: ctx, dsn: *dsn}
	kraw, err := os.ReadFile(*svcKeys)
	check(err)
	km, err := auth.ParseJWKS(kraw)
	check(err)
	a.serviceKeys = auth.NewStaticKeySet(auth.KeyDoc{Keys: km})
	raw, err := os.ReadFile(*obFile)
	check(err)
	check(json.Unmarshal(raw, &a.ob))
	if *startMS == 0 {
		*startMS = time.Now().UnixMilli()
	}
	a.nowNS.Store(*startMS * int64(time.Millisecond))
	a.hubFile = *hubDir + "/hub-" + a.ob.Outlet + ".db"
	_ = os.Remove(a.hubFile)

	stub, err := identitystub.New(a.now, nil)
	check(err)
	a.id = &dir{Identity: stub, series: map[string]directory.SeriesInfo{}}
	a.issuer = authtest.NewTenantIssuer(clock.Func(a.now))

	// Staff the app's StubIdentity signs in (ids m-asha ...) hold every permission the intent registry names, in
	// every pack: per-role enforcement is the app's; the gateway re-checks "still holds" per op.
	perms := map[string]bool{"kds.bump": true, "menu.availability.set": true}
	for _, in := range sp.Intents {
		if in.Permission != "" {
			perms[in.Permission] = true
		}
	}
	var pl []string
	for p := range perms {
		pl = append(pl, p)
	}
	sort.Strings(pl)
	for _, m := range []string{"m-asha", "m-ravi", "m-meena", "m-anand"} {
		a.id.SetMember(a.ob.Tenant, m, pl...)
	}

	fx := map[string]any{"tenant_id": a.ob.Tenant, "outlet_id": a.ob.Outlet, "brand_id": a.ob.Brand,
		"identity_pub": sp.EncodePub(a.id.IdentityPub()),
		"cloud_keys":   map[string]string{a.id.CloudKey.Kid: a.id.CloudKey.PublicB64()}}
	var devices []map[string]any
	for _, d := range a.ob.Devices {
		kp, err := sp.NewKeyPair("k-"+d.Name, nil)
		check(err)
		kind := map[string]string{"pos": sp.KindPOS, "waiter": sp.KindWaiter, "kds": sp.KindKDS}[d.Kind]
		cred, err := a.id.Activate(a.ob.Tenant, a.ob.Outlet, a.ob.Brand, d.ID, kind, kp, "")
		check(err)
		a.peers = append(a.peers, cred)
		a.id.IssuePack(a.ob.Tenant, d.ID, "pack-1", 30*24*time.Hour)
		var series []map[string]string
		for _, s := range d.Series {
			code, _ := s["code"].(string)
			dt, _ := s["doc_type"].(string)
			status, _ := s["status"].(string)
			a.id.mu.Lock()
			a.id.series[a.ob.Tenant+"|"+code] = directory.SeriesInfo{Tenant: a.ob.Tenant, Code: code, Device: d.ID, DocType: dt, State: status}
			a.id.mu.Unlock()
			series = append(series, map[string]string{"code": code, "docType": dt, "state": status})
		}
		pk, err := x509.MarshalPKCS8PrivateKey(kp.Priv)
		check(err)
		devices = append(devices, map[string]any{"device_id": d.ID, "kind": d.Kind, "name": d.Name, "kid": kp.Kid, "pub": kp.PublicB64(),
			"pkcs8": base64.RawURLEncoding.EncodeToString(pk), "cred": cred, "series": series})
	}
	fx["devices"] = devices
	for _, s := range []string{"outlet:" + a.ob.Outlet, "brand:" + a.ob.Brand, "tenant:" + a.ob.Tenant} {
		a.id.DeclareStream(a.ob.Tenant, s)
	}

	a.hubID = ids.New().String()
	a.hubKey, err = sp.NewKeyPair("k-hub", nil)
	check(err)
	a.hubCred, err = a.id.Activate(a.ob.Tenant, a.ob.Outlet, a.ob.Brand, a.hubID, sp.KindHub, a.hubKey, "")
	check(err)
	fx["hub"] = map[string]any{"id": a.hubID, "cred": a.hubCred}

	st, err := repository.Open(*dsn)
	check(err)
	defer st.Close()
	a.st = st
	if err := st.CheckAppRole(ctx); err != nil {
		logger.Warn("development only: " + err.Error())
	}
	a.cloudURL = serve(ctx, *cloudAddr, &a.gwMux)
	check(a.startGateway(*dsn))
	a.uplink.Store(false)
	check(a.startHub(false))
	fx["cloud_url"] = a.cloudURL
	fx["hub_url"] = serve(ctx, *hubAddr, &a.hubMux)
	fx["ctl_url"] = "http://" + *ctlAddr

	// The outbox relay: go-common's, with sync's NATS credential.
	if *natsURL != "" {
		nc, err := bus.Connect(*natsURL, "sync", *natsSeed)
		check(err)
		pub, err := bus.NewPublisher(nc)
		check(err)
		pgdb, err := sql.Open("pgx", *dsn)
		check(err)
		// FINDING: svc-sync's migrations create the outbox table but not outbox_relay_state, which the relay's
		// bus-generation check needs (go-common outbox.RelayStateSchema). The harness applies the library's DDL.
		if _, err := pgdb.ExecContext(ctx, outbox.RelayStateSchema); err != nil {
			log.Fatal(err)
		}
		rel := &outbox.Relay{DB: pgdb, Sink: pub, LockKey: 7_464_011_104, Log: logger, Generation: bus.GenerationFunc(nc, "sync"), Stream: "sync"}
		go func() { _ = rel.Run(ctx) }()
		fx["outbox_relay"] = "go-common outbox.Relay -> NATS " + *natsURL
	}

	ctl := http.NewServeMux()
	ctl.HandleFunc("GET /soak/token", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(a.mint(r.URL.Query().Get("device"))))
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
			_ = json.NewEncoder(w).Encode(map[string]any{"pushed": res.Pushed, "pulled": res.Pulled, "refused": res.Refused, "epoch_changed": res.EpochChanged})
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
	ctl.HandleFunc("POST /soak/gateway", func(w http.ResponseWriter, r *http.Request) {
		var err error
		switch r.URL.Query().Get("op") {
		case "down":
			a.stopGateway()
		case "up", "restart":
			err = a.startGateway(*dsn)
		case "epoch": // a cloud restore: stamp a newer restore epoch, restart so the gateway reads it
			if err = devepoch.Stamp(ctx, *dsn, r.URL.Query().Get("id")); err == nil {
				err = a.startGateway(*dsn)
			}
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
	// FINDING: Gateway.ErasePII (the cloud-signed sync.pii.erase op and the sync.pii.erased event) has no HTTP route in
	// svc-sync's api package, so no caller outside the process can request an erasure. The soak calls the method here.
	ctl.HandleFunc("POST /soak/erase", func(w http.ResponseWriter, r *http.Request) {
		seq, err := strconv.ParseInt(r.URL.Query().Get("seq"), 10, 64)
		if err != nil {
			http.Error(w, "seq", 400)
			return
		}
		a.mu.Lock()
		g := a.gw
		a.mu.Unlock()
		ref, err := g.ErasePII(r.Context(), a.ob.Tenant, sp.Ref{Origin: r.URL.Query().Get("origin"), Stream: r.URL.Query().Get("stream"), Seq: seq})
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"origin": ref.Origin, "stream": ref.Stream, "seq": ref.Seq})
	})
	ctl.HandleFunc("POST /soak/identity", func(w http.ResponseWriter, r *http.Request) {
		a.id.SetDown(r.URL.Query().Get("down") == "1")
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
