#!/usr/bin/env bash
# One organisation + one soak gateway/hub for one run: provision.sh <work-dir> <tag>
# Onboards through the real services (soak-onboard), then starts soakgw on the full stack's sync database.
# Leaves <work-dir>/<tag>.onboard.json, <tag>.fixture.json, <tag>.gw.log, <tag>.gw.pid.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1" tag="$2"
mkdir -p "$work"
"$here/with-stack-env.sh" "$work/soak-onboard" -vendor-state "$work/vendor-state.json" -out "$work/$tag.onboard.json" \
  -name "Soak $tag" -devices pos:A07,pos:A08,pos:A09,waiter:B3K,waiter:B4K,waiter:B5K,kds:K9K,kds:K8K,hub:H1
"$here/start-gw.sh" "$work/soakgw" "$work/$tag.onboard.json" "$work/$tag.fixture.json" "$work" "$work/$tag.gw.log" "$work/$tag.gw.pid" "${3:-0}"
