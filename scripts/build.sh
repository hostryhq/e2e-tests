#!/usr/bin/env bash
# Build the services under test from the committed HEAD of each repo and record what was built.
# Usage: scripts/build.sh <bin-dir> <src-scratch-dir>
# A repo with a clean tree is built in place (its go.work resolves sibling library checkouts); a repo with
# uncommitted changes is built from `git archive HEAD` so the binary always matches the recorded SHA.
set -euo pipefail
bin="${1:?bin dir}"; scratch="${2:?scratch dir}"
repos="${HOSTRY_REPOS:-$(cd "$(dirname "$0")/../.." && pwd)}"
export GOPRIVATE='*/hostryhq/*'
mkdir -p "$bin" "$scratch"
info="$bin/build-info.txt"; : > "$info"
build() { # repo, package, output name
  local repo="$1" pkg="$2" out="$3" dir sha dirty
  dir="$repos/$repo"
  sha="$(git -C "$dir" rev-parse HEAD)"
  dirty="$(git -C "$dir" status --porcelain | wc -l)"
  if [ "$dirty" != 0 ]; then
    rm -rf "$scratch/$repo"; mkdir -p "$scratch"
    git -C "$dir" archive --prefix="$repo/" HEAD | tar -x -C "$scratch"
    dir="$scratch/$repo"; echo "$repo $sha built-from-archive (working tree had $dirty uncommitted paths)" >> "$info"
  else
    echo "$repo $sha built-in-place" >> "$info"
  fi
  (cd "$dir" && go build -o "$bin/$out" "$pkg")
}
build svc-identity ./cmd/svc-identity svc-identity
build svc-tenancy ./cmd/tenancy tenancy
build svc-admin ./cmd/admin admin
sort -u "$info" -o "$info"
cat "$info"
