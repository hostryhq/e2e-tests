#!/usr/bin/env bash
# The Phase 2 full local stack on the soak's own ports (infra/dev/up-full.sh, branch feat/phase2-local-dev):
#   stack.sh up | down | status
# Own compose project, own state dir, own ports, so nothing else on the machine is touched.
# svc-sync cmd/gateway runs the REAL identity and tenancy directory (SYNC_DIRECTORY=identity) on its soak port.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra="${HOSTRY_INFRA_DIR:-$here/../../../infra}"
export COMPOSE_PROJECT_NAME=hostry-soak
export HOSTRY_LOCAL_DIR="${HOSTRY_LOCAL_DIR:-/tmp/hostry-soak/local}"
export HOSTRY_PG_PORT=15432 HOSTRY_NATS_PORT=14222
export HOSTRY_IDENTITY_PORT=28101 HOSTRY_TENANCY_PORT=28102 HOSTRY_ADMIN_PORT=28103 HOSTRY_SYNC_PORT=28104
export HOSTRY_CATALOG_PORT=28105 HOSTRY_ORDERS_PORT=28106 HOSTRY_BILLING_PORT=28107
export HOSTRY_SYNC_DIRECTORY=identity
# SOAK_SYNC_PATCH=1: build svc-sync with soak/patches/svc-sync-credential-brand.patch applied through a go build overlay (the checkout is not
# touched). Identity's credential has no brand_id, so the real directory refuses every brand-stream op (stream_outside_binding); see the report.
if [ "${SOAK_SYNC_PATCH:-0}" = 1 ]; then
  repos="$(cd "$here/../../.." && pwd)"
  mkdir -p "$HOSTRY_LOCAL_DIR/overlay"
  cp "$repos/svc-sync/realdir/realdir.go" "$HOSTRY_LOCAL_DIR/overlay/realdir.go"
  (cd "$HOSTRY_LOCAL_DIR/overlay" && patch -s -p2 realdir.go <"$here/../patches/svc-sync-credential-brand.patch")
  printf '{"Replace":{"%s":"%s"}}\n' "$repos/svc-sync/realdir/realdir.go" "$HOSTRY_LOCAL_DIR/overlay/realdir.go" >"$HOSTRY_LOCAL_DIR/overlay/overlay.json"
  export GOFLAGS="-overlay=$HOSTRY_LOCAL_DIR/overlay/overlay.json"
fi
case "${1:-status}" in
  up)
    "$infra/dev/up-full.sh" up
    ;;
  down) "$infra/dev/up-full.sh" down ;;
  status) "$infra/dev/up-full.sh" status ;;
  stop|start|restart|rebuild) "$infra/dev/up-full.sh" "$@" ;;
  *) echo "usage: stack.sh up|down|status|stop|start|restart <service>" >&2; exit 2 ;;
esac
