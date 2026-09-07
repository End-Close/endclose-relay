#!/usr/bin/env bash
# Publish the workspace packages to npm. Packs with pnpm (which rewrites `workspace:` specifiers
# to real ranges) and uploads each tarball with the npm CLI directly. pnpm's own publish is not
# used because it picks the npm sitting next to the running node (npm 10 on Node 22, which has
# no trusted-publishing support) and its knobs for changing that all leak into npm as warnings.
#
#   NPM=/path/to/npm   the npm binary to publish with (>= 11.5.1 for trusted publishing)
#   --dry-run          pack and check, but hand --dry-run to npm publish
#
# Idempotent: versions already in the registry are skipped, so re-running after a partial
# failure only publishes what is missing. Core goes first; the other two peer on it.
set -euo pipefail

NPM=${NPM:-npm}
DRY=()
[ "${1:-}" = "--dry-run" ] && DRY=(--dry-run)

ROOT=$(cd "$(dirname "$0")/.." && pwd)
PACKS=${RUNNER_TEMP:-$(mktemp -d)}/publish-packs
rm -rf "$PACKS" && mkdir -p "$PACKS"

cd "$ROOT"
pnpm -r --filter './packages/**' exec pnpm pack --pack-destination "$PACKS" > /dev/null

publish_one() {
  local tgz=$1 spec
  spec=$(tar -xOzf "$tgz" package/package.json \
    | node -p 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); `${m.name}@${m.version}`')
  if [ -n "$("$NPM" view "$spec" version 2>/dev/null || true)" ]; then
    echo "$spec is already in the registry, skipping"
    return 0
  fi
  echo "publishing $spec from $(basename "$tgz")"
  "$NPM" publish "$tgz" --access public --provenance "${DRY[@]}" || {
    echo "::group::verbose retry of $spec (npm states here why the OIDC exchange failed)"
    "$NPM" publish "$tgz" --access public --provenance --loglevel verbose "${DRY[@]}"
    echo "::endgroup::"
  }
}

# The core tarball is end-close-relay-<version>.tgz; the digit class keeps the glob off
# end-close-relay-sqlite-* and end-close-relay-store-contract-*.
publish_one "$PACKS"/end-close-relay-[0-9]*.tgz
publish_one "$PACKS"/end-close-relay-store-contract-*.tgz
publish_one "$PACKS"/end-close-relay-sqlite-*.tgz
