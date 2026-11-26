#!/usr/bin/env bash
# Run a command with the Phase 2 soak stack environment: with-stack-env.sh <cmd> [args...]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-env.sh
. "$here/stack-env.sh"
exec "$@"
