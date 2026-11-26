#!/usr/bin/env bash
# Runs the given soak runs one after the other, each on a FRESH stack (down, up, run): run-all.sh <work-dir> <tag:seed:mode:epoch>...
#   run-all.sh /tmp/hostry-soak/w5 r2:2:settle:1 r3:3:settle:0 r4:4:print:0 r1:1:settle:0:960000   (5th field: ms to wait for the S6 approval window; 0 = not waited)
# A fresh stack per run is deliberate: identity caps OTP sends per client address per day (40), and a poison event on the bus
# (finding F14) would otherwise block the next run's consumers.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1"
shift
export SOAK_BILLING_URL=http://127.0.0.1:28107 SOAK_ORDERS_URL=http://127.0.0.1:28106
for spec in "$@"; do
  IFS=: read -r tag seed mode epoch window <<<"$spec"
  export SOAK_APPROVAL_WINDOW_MS="${window:-0}"
  echo "== $tag: stack down, up"
  "$here/stack.sh" down >"$work/$tag.stack-down.log" 2>&1 || true
  rm -rf "${HOSTRY_LOCAL_DIR:-/tmp/hostry-soak/local}" "$work/vendor-state.json" "$work/$tag"
  "$here/stack.sh" up >"$work/$tag.stack-up.log" 2>&1 || { echo "$tag: stack did not come up"; tail -5 "$work/$tag.stack-up.log"; continue; }
  # commits of this run, for the archive
  "$here/run-one.sh" "$work" "$tag" "$seed" "$mode" "$epoch"
  cp -r "${HOSTRY_LOCAL_DIR:-/tmp/hostry-soak/local}/logs" "$work/$tag/stack-logs" 2>/dev/null || true
done
echo "== all runs done"
