#!/usr/bin/env bash
# One soak run on a running soak stack: run-one.sh <work-dir> <tag> <seed> <settle|print> <0|1 restore-epoch>
# Provisions a fresh organisation and gateway/hub (provision.sh), runs the TypeScript soak under the stack environment,
# stops the gateway, and leaves <work-dir>/<tag>/{vitest.out,result.json,gw.log,onboard.json,times.json}.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1" tag="$2" seed="$3" mode="$4" epoch="${5:-0}"
out="$work/$tag"
mkdir -p "$out"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$here/provision.sh" "$work" "$tag" >"$out/provision.log" 2>&1
cd "$here/../ts"
set +e
SOAK_VENDOR_STATE="$work/vendor-state.json" SOAK_EPOCH="$epoch" SOAK_ONBOARD="$work/$tag.onboard.json" SOAK_ONBOARD_BIN="$work/soak-onboard" SOAK_STATE="${HOSTRY_LOCAL_DIR:-/tmp/hostry-soak/local}" \
  SOAK_FIXTURE="$work/$tag.fixture.json" SOAK_SEED="$seed" SOAK_MODE="$mode" SOAK_OUT="$out/run" \
  "$here/with-stack-env.sh" timeout 1800 node_modules/.bin/vitest run src/soak.soak.ts --silent=false >"$out/vitest.out" 2>&1
rc=$?
set -e
finished="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
kill "$(cat "$work/$tag.gw.pid")" 2>/dev/null || true
cp "$work/$tag.gw.log" "$out/gw.log" 2>/dev/null || true
python3 -I -c "
import json,sys
o=json.load(open(sys.argv[1]))
for k in ('owner_access_token',):
    o.pop(k,None)
json.dump(o,open(sys.argv[2],'w'),indent=1)
" "$work/$tag.onboard.json" "$out/onboard.sanitised.json"
printf '{"started":"%s","finished":"%s","vitest_exit":%s}\n' "$started" "$finished" "$rc" >"$out/times.json"
echo "$tag: vitest exit $rc"
