#!/usr/bin/env bash
# Start the soak gateway + hub for one onboarded organisation and wait for its fixture.
#   start-gw.sh <gw-binary> <onboard.json> <fixture.json> <hub-dir> <log> <pidfile> [start-ms]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bin="$1" onb="$2" fx="$3" hubdir="$4" log="$5" pidf="$6"
rm -f "$fx"
"$here/with-stack-env.sh" "$bin" -onboard "$onb" -out "$fx" -hub-dir "$hubdir" >"$log" 2>&1 &
echo $! >"$pidf"
for _ in $(seq 1 60); do
  [ -s "$fx" ] && exit 0
  kill -0 "$(cat "$pidf")" 2>/dev/null || { echo "soakgw exited:" >&2; tail -5 "$log" >&2; exit 1; }
  sleep 0.5
done
echo "soakgw did not write its fixture" >&2
exit 1
