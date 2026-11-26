#!/usr/bin/env bash
# Activate the real cmd/hub for a run (also used by the driver after a disk wipe: a replaced hub is a NEW device with a NEW code):
#   hub-activate.sh <work-dir> <tag> <owner-mobile> <outlet-id>
# Leaves <work>/<tag>-hub/hub-state (hub.db, hub-device.json, device.key) and <work>/<tag>-hub/dev.key (the dev key provider's key, created by the
# provider itself since svc-sync c0499fa / F26 fixed; NOT protection, so this hub declares store unprotected).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
work="$1" tag="$2" mobile="$3" outlet="$4"
hubdir="$work/$tag-hub"
. "$here/stack-env.sh"
code="$("$work/soak-onboard" -hub-code -mobile "$mobile" -outlet "$outlet" -onboard-file "$work/$tag.onboard.json")"
rm -rf "$hubdir/hub-state"
HOSTRY_ENV=dev SYNC_HUB_STATE_DIR="$hubdir/hub-state" SYNC_HUB_IDENTITY_URL="$SOAK_IDENTITY_URL" SYNC_HUB_ACTIVATION_CODE="$code" SYNC_HUB_NAME="Soak hub" \
  SYNC_HUB_KEY_PROVIDER=dev SYNC_HUB_DEV_KEY_FILE="$hubdir/dev.key" "$work/hub" activate >"$hubdir/activate.log" 2>&1 || { cat "$hubdir/activate.log" >&2; exit 1; }
tail -1 "$hubdir/activate.log"
