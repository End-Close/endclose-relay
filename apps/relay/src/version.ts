import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The product version lives in the workspace root package.json (the one the release
// workflow bumps). Its distance from this file differs by layout — three levels in the
// repo (apps/relay/src or apps/relay/dist), two in the image (/app/app/dist next to
// /app/package.json) — so walk up until the manifest named `endclose-relay` appears.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'endclose-relay' && pkg.version) return pkg.version
    } catch {
      // not here; keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}

export const VERSION = readVersion()
