#!/usr/bin/env bash
# Run each service's own unit, contract and integration suites from a pinned snapshot (git archive of an exact
# SHA per repo), so the recorded SHAs are what actually ran even while other branches keep moving.
# Usage: scripts/run-service-suites.sh <out-dir> [pins-file]
# pins-file lines: <repo> <sha>. Postgres: infra dev compose, own project `e2eit`, port 55442; removed at the end.
set -uo pipefail
mkdir -p "$1"; out="$(cd "$1" && pwd)"
here="$(cd "$(dirname "$0")/.." && pwd)"
repos="${HOSTRY_REPOS:-$(cd "$here/.." && pwd)}"
pins="${2:-$here/scripts/pins.txt}"
snap=/tmp/e2e/snap; rm -rf "$snap"; mkdir -p "$snap"
export GOPRIVATE='*/hostryhq/*'
: > "$out/pins.txt"
while read -r repo sha; do
  [ -z "$repo" ] && continue
  git -C "$repos/$repo" archive --prefix="$repo/" "$sha" | tar -x -C "$snap"
  echo "$repo $(git -C "$repos/$repo" rev-parse "$sha")" >> "$out/pins.txt"
done < "$pins"
cat > "$snap/go.work" <<EOF
go 1.27.1

use (
	./go-common
	./go-auth
	./api-specs
	./svc-identity
	./svc-admin
	./svc-sync
)
EOF
: > "$out/steps.tsv"
step() { # name, dir, command...
  local name="$1" dir="$2"; shift 2
  local t0 s0; t0=$(date +%s); s0=$(date -u +%FT%TZ)
  (cd "$dir" && "$@") > "$out/$name.log" 2>&1; local rc=$?
  printf '%s\t%s\t%s\t%s\t%s\n' "$name" "$rc" "$(( $(date +%s) - t0 ))" "$s0" "$(date -u +%FT%TZ)" >> "$out/steps.tsv"
}
HOSTRY_PG_PORT=55442 docker compose -p e2eit -f "$repos/infra/dev/compose.yaml" up -d --wait postgres > "$out/compose-up.log" 2>&1
pg='postgres://hostry:hostry-dev-only@127.0.0.1:55442/hostry?sslmode=disable'

step identity-unit-contract "$snap/svc-identity" go test -race -count=1 ./...
step identity-integration "$snap/svc-identity" env HOSTRY_PG_DSN="$pg" go test -race -count=1 -tags integration ./integration/... ./contract/...
step tenancy-unit-contract "$snap/svc-tenancy" env GOWORK=off go test -race -count=1 ./...
step tenancy-integration "$snap/svc-tenancy" env GOWORK=off TENANCY_TEST_PG_ADMIN_DSN="$pg" go test -race -count=1 -tags integration ./...
step admin-unit-contract "$snap/svc-admin" go test -race -count=1 ./...
step sync-unit-sim "$snap/svc-sync" go test -race -count=1 ./...
step client-core-sync-unit "$repos/client-core-sync" pnpm vitest run

HOSTRY_PG_PORT=55442 docker compose -p e2eit -f "$repos/infra/dev/compose.yaml" down -v > "$out/compose-down.log" 2>&1
echo done >> "$out/steps.tsv"
