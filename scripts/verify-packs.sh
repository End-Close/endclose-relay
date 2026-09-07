#!/usr/bin/env bash
# Pack the publishable packages exactly as `pnpm publish` would, check the tarball contents,
# then install them into a throwaway project and import them — proving the `files` lists and
# `exports` maps work outside the workspace. Run by CI on every PR and usable locally:
#   pnpm build:packages && scripts/verify-packs.sh
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${RUNNER_TEMP:-$(mktemp -d)}/verify-packs
rm -rf "$WORK" && mkdir -p "$WORK/packs" "$WORK/consumer"
PACKS="$WORK/packs"

cd "$ROOT"
pnpm -r --filter './packages/**' exec pnpm pack --pack-destination "$PACKS" > /dev/null

CORE=$(ls "$PACKS"/end-close-relay-[0-9]*.tgz)
SQLITE=$(ls "$PACKS"/end-close-relay-sqlite-*.tgz)
CONTRACT=$(ls "$PACKS"/end-close-relay-store-contract-*.tgz)

check() { # check <tgz> <required path>...
  local tgz=$1; shift
  local listing; listing=$(tar -tzf "$tgz")
  for want in "$@"; do
    grep -qx "$want" <<< "$listing" || { echo "$(basename "$tgz"): missing $want" >&2; exit 1; }
  done
  if grep -qE '^package/(test/|.*\.tsbuildinfo$)' <<< "$listing"; then
    echo "$(basename "$tgz"): ships test files or tsbuildinfo" >&2; exit 1
  fi
  # The manifest inside the tarball must be publishable: not private, workspace: specifiers rewritten.
  local manifest; manifest=$(tar -xOzf "$tgz" package/package.json)
  if node -e 'const m=JSON.parse(process.argv[1]); if (m.private) process.exit(1); if (JSON.stringify(m).includes("workspace:")) process.exit(2)' "$manifest"; then :; else
    echo "$(basename "$tgz"): manifest is private or still contains workspace: specifiers" >&2; exit 1
  fi
}

COMMON=(package/package.json package/LICENSE package/README.md package/dist/index.js package/dist/index.d.ts package/src/index.ts)
check "$CORE" "${COMMON[@]}" package/COMPATIBILITY.md
check "$SQLITE" "${COMMON[@]}"
check "$CONTRACT" "${COMMON[@]}"
echo "tarball contents ok"

# Smoke install. core + sqlite in one command so sqlite's ^ peer on core resolves from the tarball.
cd "$WORK/consumer"
npm init -y > /dev/null
npm install --no-audit --no-fund --loglevel=error "$CORE" "$SQLITE"
node --input-type=module -e '
  const core = await import("@end-close/relay")
  const sqlite = await import("@end-close/relay-sqlite")
  const need = (m, k, name) => { if (typeof m[k] !== "function") { console.error(`${name} does not export ${k}`); process.exit(1) } }
  need(core, "createRelay", "@end-close/relay"); need(core, "parseRoutes", "@end-close/relay")
  need(sqlite, "openDb", "@end-close/relay-sqlite"); need(sqlite, "SqliteEventStore", "@end-close/relay-sqlite")
  // Exercise the native dependency end to end: open an in-memory db and migrate it.
  const db = sqlite.openDb(":memory:"); sqlite.migrate(db); new sqlite.SqliteEventStore(db); db.close()
  console.log("import smoke ok")
'
# The contract package peers on vitest; do not pull vitest from the registry here, only prove the
# exports map resolves.
npm install --no-audit --no-fund --loglevel=error --legacy-peer-deps "$CONTRACT"
node --input-type=module -e 'import.meta.resolve("@end-close/relay-store-contract"); console.log("contract resolves ok")'
echo "verify-packs: all good ($PACKS)"
