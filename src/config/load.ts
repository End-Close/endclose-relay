import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { relayConfigSchema, type RelayConfig } from './schema.js'

export interface LoadedConfig {
  config: RelayConfig
  yamlText: string
  hash: string
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
  const hash = 'sha256:' + createHash('sha256').update(yamlText, 'utf8').digest('hex')
  return { config, yamlText, hash }
}

/** Resolve a secret referenced by env-var name; throws with a clear message when missing. */
export function resolveSecret(envName: string): string {
  const v = process.env[envName]
  if (!v) throw new Error(`missing required secret env var: ${envName}`)
  return v
}
