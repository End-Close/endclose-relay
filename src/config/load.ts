import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { LEGACY_CONFIG_KEYS, relayConfigSchema, type RelayConfig } from './schema.js'

export interface LoadedConfig {
  config: RelayConfig
  yamlText: string
  hash: string
  /** e.g. legacy top-level sections that are now env-only runtime settings. */
  warnings: string[]
}

export function loadConfig(path: string): LoadedConfig {
  const yamlText = readFileSync(path, 'utf8')
  return parseConfig(yamlText)
}

export function parseConfig(yamlText: string): LoadedConfig {
  const raw: unknown = parse(yamlText)
  const config = relayConfigSchema.parse(raw)
  const seen = new Set<string>()
  for (const route of config.routes) {
    if (seen.has(route.id)) throw new Error(`duplicate route id: ${route.id}`)
    seen.add(route.id)
  }
  const warnings: string[] = []
  if (raw && typeof raw === 'object') {
    const legacy = LEGACY_CONFIG_KEYS.filter((k) => k in (raw as Record<string, unknown>))
    if (legacy.length > 0) {
      warnings.push(
        `ignored legacy section(s): ${legacy.join(', ')} — these are now environment settings (ENDCLOSE_BASE_URL, RELAY_* — see docs/CONFIG.md); the config document is routes only`,
      )
    }
  }
  const hash = 'sha256:' + createHash('sha256').update(yamlText, 'utf8').digest('hex')
  return { config, yamlText, hash, warnings }
}

/** Resolve a secret referenced by env-var name; throws with a clear message when missing. */
export function resolveSecret(envName: string): string {
  const v = process.env[envName]
  if (!v) throw new Error(`missing required secret env var: ${envName}`)
  return v
}
