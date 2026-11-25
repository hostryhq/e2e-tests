#!/usr/bin/env bash
# Phase 1 close-out run: every cross-service suite on this machine, raw output into <out-dir>.
# Usage: scripts/run-all.sh <out-dir> [soak-duration, default 30m]
# Needs: Go, Docker, Node + pnpm; sibling clones of svc-*, infra, client-core-sync (HOSTRY_REPOS, default ..).
# Services run as local processes on ports 18101-18103 and 18111-18112; Postgres is compose project `e2e`
# on port 55500. Everything is stopped at the end. Steps run in this order so the load baseline is measured
# on an otherwise idle machine and the 30-minute soak (CPU heavy) runs last.
set -uo pipefail
mkdir -p "$1"; out="$(cd "$1" && pwd)"
soak="${2:-30m}"
here="$(cd "$(dirname "$0")/.." && pwd)"
repos="${HOSTRY_REPOS:-$(cd "$here/.." && pwd)}"
export GOPRIVATE='*/hostryhq/*'
bin=/tmp/e2e/bin
: > "$out/steps.tsv"
step() { # name, command...  -> name, exit code, seconds, start, finish (UTC) appended to steps.tsv
  local name="$1"; shift
  local t0 s0; t0=$(date +%s); s0=$(date -u +%FT%TZ)
  "$@" > "$out/$name.log" 2>&1; local rc=$?
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$rc" "$(( $(date +%s) - t0 ))" "$s0" "$(date -u +%FT%TZ)" >> "$out/steps.tsv"
}

step build "$here/scripts/build.sh" "$bin" /tmp/e2e/src
cp "$bin/build-info.txt" "$out/build-info.txt" 2>/dev/null || true

# 1-3 and the local load baseline: one stack (own compose project), scenarios first, load last.
cd "$here"
step scenarios env E2E_OUT="$out" E2E_BIN="$bin" E2E_INFRA="$repos/infra/dev" E2E_LOAD=1 go test -tags e2e -count=1 -v -timeout 20m ./e2e

# 4a client-core sync e2e against svc-sync devstack on its own ports.
mkdir -p /tmp/e2e/sync; rm -f /tmp/e2e/sync/devstack.db* /tmp/e2e/sync/fixture.json*
(cd "$repos/svc-sync" && go build -o /tmp/e2e/bin/devstack ./cmd/devstack && go build -o /tmp/e2e/bin/simulate ./cmd/simulate) > "$out/sync-build.log" 2>&1
/tmp/e2e/bin/devstack -cloud 127.0.0.1:18111 -hub 127.0.0.1:18112 -out /tmp/e2e/sync/fixture.json -db file:/tmp/e2e/sync/devstack.db > "$out/sync-devstack.log" 2>&1 &
dpid=$!
for _ in $(seq 1 50); do [ -s /tmp/e2e/sync/fixture.json ] && break; sleep 0.2; done
(cd "$repos/client-core-sync" && SYNC_E2E_FIXTURE=/tmp/e2e/sync/fixture.json step sync-client-e2e pnpm vitest run src/sync/e2e.go.test.ts)
kill "$dpid" 2>/dev/null; wait "$dpid" 2>/dev/null

cd /tmp/e2e/sync
# 4b simulator: the one seed named in the brief, then 50 seeds.
step sim-seed1 /tmp/e2e/bin/simulate -seed 1 -v
step sim-50 /tmp/e2e/bin/simulate -from 1 -runs 50
# 4c soak, last.
step sim-soak /tmp/e2e/bin/simulate -soak "$soak"
echo done >> "$out/steps.tsv"
