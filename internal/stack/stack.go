// Package stack starts the real Hostry services as local processes against the infra dev stack (its own
// compose project `e2e`, own ports) and stops everything again. Nothing here talks to a live third party.
package stack

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Config says where binaries and infra live and which ports the run uses.
type Config struct {
	BinDir                                       string // prebuilt svc-identity, tenancy, admin (scripts/build.sh)
	InfraDir                                     string // infra/dev
	OutDir                                       string // logs and generated keys
	PGPort, IdentityPort, TenancyPort, AdminPort int
}

// Defaults fills ports that differ from every other local stack on this machine.
func (c *Config) Defaults() {
	if c.PGPort == 0 {
		c.PGPort = 55500
	}
	if c.IdentityPort == 0 {
		c.IdentityPort = 18101
	}
	if c.TenancyPort == 0 {
		c.TenancyPort = 18102
	}
	if c.AdminPort == 0 {
		c.AdminPort = 18103
	}
}

// Stack is a running local stack.
type Stack struct {
	Cfg                               Config
	Keys                              keyFiles
	IdentityURL, TenancyURL, AdminURL string
	AdminOrigin                       string
	procs                             []*exec.Cmd
	logs                              []*os.File
	composeUp                         bool
	idEnv                             []string
}

const (
	pgSuper = "hostry"
	pgPass  = "hostry-dev-only"
	rolePw  = "e2e-local-only"
	project = "e2e"
)

func (s *Stack) pgDSN(user, pass, db string) string {
	return fmt.Sprintf("postgres://%s:%s@127.0.0.1:%d/%s?sslmode=disable", user, pass, s.Cfg.PGPort, db)
}

// Start brings the stack up. The caller must call Stop.
func Start(ctx context.Context, cfg Config) (*Stack, error) {
	cfg.Defaults()
	s := &Stack{Cfg: cfg}
	if err := os.MkdirAll(filepath.Join(cfg.OutDir, "logs"), 0o755); err != nil {
		return nil, err
	}
	keyDir, err := os.MkdirTemp("", "e2e-keys-")
	if err != nil {
		return nil, err
	}
	s.Keys = generateKeys(keyDir)
	s.IdentityURL = fmt.Sprintf("http://127.0.0.1:%d", cfg.IdentityPort)
	s.TenancyURL = fmt.Sprintf("http://127.0.0.1:%d", cfg.TenancyPort)
	s.AdminOrigin = fmt.Sprintf("http://localhost:%d", cfg.AdminPort)
	s.AdminURL = s.AdminOrigin

	// Postgres from the infra dev compose file, own project and port.
	up := exec.CommandContext(ctx, "docker", "compose", "-p", project, "-f", filepath.Join(cfg.InfraDir, "compose.yaml"), "up", "-d", "--wait", "postgres")
	up.Env = append(os.Environ(), fmt.Sprintf("HOSTRY_PG_PORT=%d", cfg.PGPort))
	if out, err := up.CombinedOutput(); err != nil {
		return s, fmt.Errorf("compose up: %v: %s", err, out)
	}
	s.composeUp = true
	if err := s.provision(ctx); err != nil {
		return s, err
	}

	idEnv := []string{
		"HOSTRY_ENV=dev", "HOSTRY_IDENTITY_ALLOW_TEST_SMS=1", "HOSTRY_IDENTITY_DB_ROLE=identity_app",
		"HOSTRY_IDENTITY_DSN=" + s.pgDSN(pgSuper, pgPass, "identity"),
		"HOSTRY_IDENTITY_LISTEN=" + fmt.Sprintf("127.0.0.1:%d", cfg.IdentityPort),
		"HOSTRY_IDENTITY_TENANT_KEY_FILE=" + s.Keys.Tenant, "HOSTRY_IDENTITY_VENDOR_KEY_FILE=" + s.Keys.Vendor,
		"HOSTRY_IDENTITY_PACK_KEY_FILE=" + s.Keys.Pack, "HOSTRY_IDENTITY_MAC_KEY_FILE=" + s.Keys.MAC,
		"HOSTRY_IDENTITY_PROOF_KEY_FILE=" + s.Keys.Proof, "HOSTRY_IDENTITY_TOTP_KEY_FILE=" + s.Keys.TOTP,
		"HOSTRY_SERVICE_KEYS_DIR=" + s.Keys.ServiceKeysDir, "HOSTRY_OP_SIGNING_PUB_FILE=" + s.Keys.OpPub,
		"HOSTRY_TENANCY_URL=" + s.TenancyURL, "HOSTRY_SERVICE_SIGNING_KEY_FILE=" + s.Keys.IdentitySvcKey,
	}
	s.idEnv = idEnv
	if out, err := s.RunIdentity(ctx, "migrate"); err != nil {
		return s, fmt.Errorf("identity migrate: %v: %s", err, out)
	}
	tenBase := []string{"TENANCY_DB_MIGRATE_DSN=" + s.pgDSN("tenancy_migrator", rolePw, "tenancy")}
	mig := exec.CommandContext(ctx, filepath.Join(cfg.BinDir, "tenancy"), "migrate")
	mig.Env = append(os.Environ(), tenBase...)
	if out, err := mig.CombinedOutput(); err != nil {
		return s, fmt.Errorf("tenancy migrate: %v: %s", err, out)
	}

	if err := s.spawn("identity", filepath.Join(cfg.BinDir, "svc-identity"), []string{"serve"}, idEnv, s.IdentityURL+"/v1/jwks"); err != nil {
		return s, err
	}
	tenEnv := []string{
		"TENANCY_ADDR=" + fmt.Sprintf("127.0.0.1:%d", cfg.TenancyPort),
		"TENANCY_DB_APP_DSN=" + s.pgDSN("tenancy_app", rolePw, "tenancy"),
		"TENANCY_DB_VENDOR_DSN=" + s.pgDSN("tenancy_vendor", rolePw, "tenancy"),
		"TENANCY_TENANT_JWKS=" + s.IdentityURL + "/v1/jwks", "TENANCY_VENDOR_JWKS=" + s.IdentityURL + "/v1/vendor-jwks",
		"TENANCY_SERVICE_KEYS=" + s.Keys.ServiceJWKS,
	}
	if err := s.spawn("tenancy", filepath.Join(cfg.BinDir, "tenancy"), []string{"serve"}, tenEnv, s.TenancyURL+"/healthz"); err != nil {
		return s, err
	}
	adEnv := []string{
		"ADMIN_PUBLIC_ORIGIN=" + s.AdminOrigin, "ADMIN_IDENTITY_URL=" + s.IdentityURL, "ADMIN_TENANCY_URL=" + s.TenancyURL,
		"ADMIN_SERVICE_KEY_FILE=" + s.Keys.AdminSvcKey, "ADMIN_LISTEN=" + fmt.Sprintf("127.0.0.1:%d", cfg.AdminPort),
	}
	if err := s.spawn("admin", filepath.Join(cfg.BinDir, "admin"), nil, adEnv, s.AdminURL+"/healthz"); err != nil {
		return s, err
	}
	return s, nil
}

// RunIdentity runs a one-shot svc-identity command (migrate, vendor bootstrap ...) with the stack's configuration.
func (s *Stack) RunIdentity(ctx context.Context, args ...string) (string, error) {
	c := exec.CommandContext(ctx, filepath.Join(s.Cfg.BinDir, "svc-identity"), args...)
	c.Env = append(os.Environ(), s.idEnv...)
	var out bytes.Buffer
	c.Stdout, c.Stderr = &out, &out
	err := c.Run()
	return out.String(), err
}

// provision creates the cluster roles and the two databases (what deployment will own later).
func (s *Stack) provision(ctx context.Context) error {
	sql := fmt.Sprintf(`
CREATE ROLE tenancy_migrator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%[1]s';
CREATE ROLE tenancy_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%[1]s';
CREATE ROLE tenancy_vendor LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%[1]s';
CREATE ROLE tenancy_relay LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD '%[1]s';
CREATE DATABASE tenancy OWNER tenancy_migrator;
CREATE DATABASE identity;`, rolePw)
	_, err := s.PSQL(ctx, "hostry", sql)
	return err
}

// PSQL runs SQL in the compose Postgres container and returns the unaligned output.
func (s *Stack) PSQL(ctx context.Context, db, sql string) (string, error) {
	c := exec.CommandContext(ctx, "docker", "exec", "-i", project+"-postgres-1", "psql", "-U", pgSuper, "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-q")
	c.Stdin = strings.NewReader(sql)
	var out bytes.Buffer
	c.Stdout, c.Stderr = &out, &out
	err := c.Run()
	return strings.TrimSpace(out.String()), err
}

// MACKey returns the identity MAC key file path (the keyed-hash key; see the OTP helper).
func (s *Stack) MACKeyFile() string { return s.Keys.MAC }

func (s *Stack) spawn(name, bin string, args, env []string, healthURL string) error {
	lf, err := os.Create(filepath.Join(s.Cfg.OutDir, "logs", name+".log"))
	if err != nil {
		return err
	}
	s.logs = append(s.logs, lf)
	c := exec.Command(bin, args...)
	c.Env = append(os.Environ(), env...)
	c.Stdout, c.Stderr = lf, lf
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := c.Start(); err != nil {
		return err
	}
	s.procs = append(s.procs, c)
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(healthURL)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 500 {
				return nil
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return fmt.Errorf("%s did not become healthy at %s (see logs/%s.log)", name, healthURL, name)
}

// Stop ends every process and removes the compose project including its volumes.
func (s *Stack) Stop() {
	for i := len(s.procs) - 1; i >= 0; i-- {
		p := s.procs[i]
		if p.Process != nil {
			_ = syscall.Kill(-p.Process.Pid, syscall.SIGTERM)
			done := make(chan struct{})
			go func() { _ = p.Wait(); close(done) }()
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				_ = syscall.Kill(-p.Process.Pid, syscall.SIGKILL)
			}
		}
	}
	for _, f := range s.logs {
		_ = f.Close()
	}
	if s.composeUp {
		down := exec.Command("docker", "compose", "-p", project, "-f", filepath.Join(s.Cfg.InfraDir, "compose.yaml"), "down", "-v")
		down.Env = append(os.Environ(), fmt.Sprintf("HOSTRY_PG_PORT=%d", s.Cfg.PGPort))
		_, _ = down.CombinedOutput()
	}
	_ = os.RemoveAll(s.Keys.Dir)
}
