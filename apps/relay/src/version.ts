import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The product version lives in the workspace root package.json (the one the release
// workflow bumps), not in this package's. Walk up from this file until we find it; in
// the container image the root manifest sits next to the built application.
function readVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'endclose-relay' && pkg.version) return pkg.version
    } catch {
      // keep walking
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return 'unknown'
}

export const VERSION = readVersion()
