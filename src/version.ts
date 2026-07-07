import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

function readVersion(): string {
  // src/version.ts -> <root>/package.json ; dist/version.js -> <root>/package.json
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  try {
    return (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string })
      .version
  } catch {
    return 'unknown'
  }
}

export const VERSION = readVersion()
