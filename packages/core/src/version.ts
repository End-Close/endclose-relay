import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The engine's own version, from its package manifest (the release workflow stamps it in
// lockstep with the product). Both `src/` and `dist/` sit one level below package.json,
// and an installed copy keeps the same layout, so walk up until the manifest appears.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === '@end-close/relay' && pkg.version) return pkg.version
    } catch {
      // not here; keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}

export const ENGINE_VERSION = readVersion()
