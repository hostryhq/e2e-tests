#!/usr/bin/env bash
# One organisation + the real LAN hub + soakgw for one run: provision.sh <work-dir> <tag>
# 1. soak-onboard onboards through the real services (devices registered, store protected on tills and tablets).
# 2. The owner asks identity for a hub activation code; the REAL cmd/hub activates with it (identity-issued hub pack, issuer_env dev,
#    peers = the devices above), keys through the dev key provider. The hub is then run by the driver (HubProc in net.ts).
# 3. soakgw (internet switch, wall clock, device tokens) is started and writes the fixture.
# Leaves <work-dir>/<tag>.onboard.json, <tag>.fixture.json, <tag>.gw.log, <tag>.gw.pid, <work-dir>/<tag>-hub/.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1" tag="$2"
mkdir -p "$work"
"$here/with-stack-env.sh" "$work/soak-onboard" -vendor-state "$work/vendor-state.json" -out "$work/$tag.onboard.json" \
  -name "Soak $tag" -devices pos:A07,pos:A08,pos:A09,waiter:B3K,waiter:B4K,waiter:B5K,kds:K9K,kds:K8K
hubdir="$work/$tag-hub"
rm -rf "$hubdir"
mkdir -p "$hubdir"
mobile="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["owner_mobile"])' "$work/$tag.onboard.json")"
outlet="$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["outlet_id"])' "$work/$tag.onboard.json")"
"$here/hub-activate.sh" "$work" "$tag" "$mobile" "$outlet"
"$here/start-gw.sh" "$work/soakgw" "$work/$tag.onboard.json" "$work/$tag.fixture.json" "$hubdir" "$work/$tag.gw.log" "$work/$tag.gw.pid"
