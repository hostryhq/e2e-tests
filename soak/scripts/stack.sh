#!/usr/bin/env bash
# The Phase 2 full local stack on the soak's own ports (infra/dev/up-full.sh, branch feat/phase2-local-dev):
#   stack.sh up | down | status
# Own compose project, own state dir, own ports, so nothing else on the machine is touched.
# svc-sync's cmd/gateway (HOSTRY_SYNC_DIRECTORY=stub, the real identity directory is blocked on a pending ADR) is
# started by up-full.sh like the other services and then stopped: the soak runs soakgw on its port instead
# (see soak/gw/main.go for why).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra="${HOSTRY_INFRA_DIR:-$here/../../../infra}"
export COMPOSE_PROJECT_NAME=hostry-soak
export HOSTRY_LOCAL_DIR="${HOSTRY_LOCAL_DIR:-/tmp/hostry-soak/local}"
export HOSTRY_PG_PORT=15432 HOSTRY_NATS_PORT=14222
export HOSTRY_IDENTITY_PORT=28101 HOSTRY_TENANCY_PORT=28102 HOSTRY_ADMIN_PORT=28103 HOSTRY_SYNC_PORT=28104
export HOSTRY_CATALOG_PORT=28105 HOSTRY_ORDERS_PORT=28106 HOSTRY_BILLING_PORT=28107
export HOSTRY_SYNC_DIRECTORY=stub
# SOAK_BILLING_PATCH=1: build svc-billing with soak/patches/svc-billing-line-claim-body.patch applied through a go build
# overlay (the checkout is not touched). Without it the as-is svc-billing blocks on its first bill (see the report).
if [ "${SOAK_BILLING_PATCH:-0}" = 1 ]; then
  repos="$(cd "$here/../../.." && pwd)"
  mkdir -p "$HOSTRY_LOCAL_DIR/overlay"
  cp "$repos/svc-billing/service/bills.go" "$HOSTRY_LOCAL_DIR/overlay/bills.go"
  (cd "$HOSTRY_LOCAL_DIR/overlay" && patch -s -p2 bills.go <"$here/../patches/svc-billing-line-claim-body.patch")
  printf '{"Replace":{"%s":"%s"}}\n' "$repos/svc-billing/service/bills.go" "$HOSTRY_LOCAL_DIR/overlay/bills.go" >"$HOSTRY_LOCAL_DIR/overlay/overlay.json"
  export GOFLAGS="-overlay=$HOSTRY_LOCAL_DIR/overlay/overlay.json"
fi
case "${1:-status}" in
  up)
    "$infra/dev/up-full.sh" up
    if [ -f "$HOSTRY_LOCAL_DIR/run/sync.pid" ]; then kill "$(cat "$HOSTRY_LOCAL_DIR/run/sync.pid")" 2>/dev/null || true; rm -f "$HOSTRY_LOCAL_DIR/run/sync.pid"; fi
    ;;
  down) "$infra/dev/up-full.sh" down ;;
  status) "$infra/dev/up-full.sh" status ;;
  *) echo "usage: stack.sh up|down|status" >&2; exit 2 ;;
esac
