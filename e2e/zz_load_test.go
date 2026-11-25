//go:build e2e

package e2e

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/hostryhq/e2e-tests/internal/hx"
)

// LOCAL load baseline. Environment: this developer machine, services as local processes on one Postgres 17
// container, load generator on the same host. It is NOT production shape and the numbers are only comparable
// to later runs of this same test on comparable hardware. Enabled with E2E_LOAD=1.

type loadResult struct {
	Name        string  `json:"name"`
	Concurrency int     `json:"concurrency"`
	Requests    int     `json:"requests"`
	Errors      int     `json:"errors"`
	DurationS   float64 `json:"duration_s"`
	RPS         float64 `json:"rps"`
	P50ms       float64 `json:"p50_ms"`
	P95ms       float64 `json:"p95_ms"`
	P99ms       float64 `json:"p99_ms"`
	MaxMs       float64 `json:"max_ms"`
	Note        string  `json:"note,omitempty"`
}

func pct(sorted []time.Duration, p float64) float64 {
	if len(sorted) == 0 {
		return 0
	}
	i := int(float64(len(sorted)-1) * p)
	return float64(sorted[i].Microseconds()) / 1000
}

// run drives fn from conc workers for d (or until maxReq calls when maxReq > 0). fn returns true on success.
func run(name string, conc int, d time.Duration, maxReq int, note string, fn func(worker int) bool) loadResult {
	var mu sync.Mutex
	var lat []time.Duration
	errs := 0
	var wg sync.WaitGroup
	start := time.Now()
	deadline := start.Add(d)
	var count int
	for w := 0; w < conc; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for time.Now().Before(deadline) {
				mu.Lock()
				if maxReq > 0 && count >= maxReq {
					mu.Unlock()
					return
				}
				count++
				mu.Unlock()
				t0 := time.Now()
				ok := fn(w)
				e := time.Since(t0)
				mu.Lock()
				lat = append(lat, e)
				if !ok {
					errs++
				}
				mu.Unlock()
			}
		}(w)
	}
	wg.Wait()
	el := time.Since(start)
	sort.Slice(lat, func(i, j int) bool { return lat[i] < lat[j] })
	r := loadResult{Name: name, Concurrency: conc, Requests: len(lat), Errors: errs, DurationS: el.Seconds(), RPS: float64(len(lat)) / el.Seconds(),
		P50ms: pct(lat, .50), P95ms: pct(lat, .95), P99ms: pct(lat, .99), Note: note}
	if len(lat) > 0 {
		r.MaxMs = float64(lat[len(lat)-1].Microseconds()) / 1000
	}
	return r
}

func TestLoadLocalBaseline(t *testing.T) {
	if os.Getenv("E2E_LOAD") != "1" {
		t.Skip("set E2E_LOAD=1 to run the local load baseline")
	}
	if orgA == nil || orgA.DeviceID == "" || admin1 == nil {
		t.Fatal("scenarios 1-3 must run first in the same process")
	}
	dur := 15 * time.Second
	var results []loadResult
	a := orgA.Owner
	tc, ic := a.tenancy(), a.C

	// Tenancy reads with a tenant token (RLS-scoped Postgres reads).
	results = append(results, run("tenancy GET /v1/outlets/{id}", 16, dur, 0, "", func(int) bool {
		return tc.Get("/v1/outlets/"+orgA.OutletID).Status == 200
	}))
	results = append(results, run("tenancy GET /v1/document-series", 16, dur, 0, "", func(int) bool {
		return tc.Get("/v1/document-series?outlet_id="+orgA.OutletID).Status == 200
	}))
	// Identity reads and the offline pack (signs a JWS per call).
	results = append(results, run("identity GET /v1/members/{id}", 16, dur, 0, "", func(int) bool {
		return ic.Get("/v1/members/"+a.MemberID).Status == 200
	}))
	results = append(results, run("identity GET offline pack", 8, dur, 0, "signs and builds a pack per request", func(int) bool {
		return ic.Get("/v1/devices/"+orgA.DeviceID+"/offline-packs/latest").Status == 200
	}))
	// Admin BFF: cookie session read and a directory list that calls tenancy and identity upstream.
	results = append(results, run("admin GET /v1/sessions/current", 16, dur, 0, "", func(int) bool {
		return admin1.get("/v1/sessions/current").Status == 200
	}))
	results = append(results, run("admin GET /v1/organisations", 16, dur, 0, "svc-admin to tenancy and identity", func(int) bool {
		return admin1.get("/v1/organisations").Status == 200
	}))
	// Session refresh: refresh tokens rotate, so one chain, one request at a time.
	refresh := a.Refresh
	var rmu sync.Mutex
	results = append(results, run("identity POST /v1/tokens/refresh", 1, dur, 200, "one rotating chain, sequential", func(int) bool {
		rmu.Lock()
		defer rmu.Unlock()
		proof := a.Key.Assertion(map[string]any{"aud": "hostry-identity", "did": a.DeviceID, "jti": hx.NewJTI(), "iat": time.Now().Unix(),
			"rth": refreshHash(refresh)})
		r := a.ID.Post("/v1/tokens/refresh", map[string]any{"refresh_token": refresh, "device_id": a.DeviceID, "proof": proof}, "Idempotency-Key", hx.NewID())
		if r.Status != 200 && r.Status != 201 {
			return false
		}
		v, _ := r.Map()["refresh_token"].(string)
		if v == "" {
			return false
		}
		refresh = v
		return true
	}))
	// OTP challenge: rate limited by design (per-IP 40/day, per-device 20/day); a small sample of the accepted path.
	results = append(results, run("identity POST /v1/otp-challenges", 1, dur, 12, "sample of 12: per-device/per-IP daily limits make a rate meaningless", func(w int) bool {
		k := hx.NewDeviceKey()
		r := hx.New(st.IdentityURL).Post("/v1/otp-challenges", map[string]any{"mobile_e164": "+9198765" + pad5(), "device_id": hx.NewID(), "device_public_key": k.JWK()}, "Idempotency-Key", hx.NewID())
		return r.Status == 202
	}))

	out := map[string]any{
		"environment": "local dev machine (" + runtime.GOOS + "/" + runtime.GOARCH + ", " + itoa(runtime.NumCPU()) + " logical CPUs), services as local processes, Postgres 17 in Docker, load generator on the same host. NOT production shape.",
		"baseline":    "none stored: this run is recorded as the new baseline, not as a pass",
		"results":     results,
	}
	b, _ := json.MarshalIndent(out, "", "  ")
	dir := env("E2E_OUT", os.TempDir())
	if err := os.WriteFile(filepath.Join(dir, "load.json"), b, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, r := range results {
		t.Logf("%-40s c=%-2d n=%-6d err=%-4d rps=%8.1f p50=%7.2fms p95=%7.2fms p99=%7.2fms", r.Name, r.Concurrency, r.Requests, r.Errors, r.RPS, r.P50ms, r.P95ms, r.P99ms)
	}
}

func refreshHash(rt string) string {
	sum := sha256.Sum256([]byte(rt))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func pad5() string { return fmt.Sprintf("%05d", rand.Intn(100000)) }

func itoa(n int) string { return strconv.Itoa(n) }
