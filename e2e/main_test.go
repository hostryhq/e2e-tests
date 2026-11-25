//go:build e2e

package e2e

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/hostryhq/e2e-tests/internal/stack"
)

var st *stack.Stack

func env(k, d string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return d
}

func TestMain(m *testing.M) {
	out := env("E2E_OUT", filepath.Join(os.TempDir(), "e2e-out"))
	_ = os.MkdirAll(out, 0o755)
	cfg := stack.Config{
		BinDir:   env("E2E_BIN", "/tmp/e2e/bin"),
		InfraDir: env("E2E_INFRA", "../../infra/dev"),
		OutDir:   out,
	}
	var err error
	st, err = stack.Start(context.Background(), cfg)
	code := 1
	if err != nil {
		fmt.Fprintln(os.Stderr, "stack start failed:", err)
	} else {
		code = m.Run()
	}
	if st != nil {
		st.Stop()
	}
	os.Exit(code)
}
