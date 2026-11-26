#!/usr/bin/env bash
# Ad-hoc read of a soak service as the onboarded owner: q.sh <work-dir> <tag> <billing|orders> <path>
# Uses <work-dir>/<tag>.token (soak-onboard -login-only) and the outlet in <tag>.onboard.json.
set -euo pipefail
work="$1" tag="$2" svc="$3" path="$4"
outlet="$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['outlet_id'])" "$work/$tag.onboard.json")"
case "$svc" in billing) port="${HOSTRY_BILLING_PORT:-28107}" ;; orders) port="${HOSTRY_ORDERS_PORT:-28106}" ;; *) exit 2 ;; esac
curl -s -H "Authorization: Bearer $(cat "$work/$tag.token")" -H "X-Outlet-Id: $outlet" "http://127.0.0.1:$port$path"
