import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { parseRoutes, type RelayConfig } from '@endclose/relay'

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
  const config: RelayConfig = { routes: parseRoutes(raw) }
  const hash = 'sha256:' + createHash('sha256').update(yamlText, 'utf8').digest('hex')
  return { config, yamlText, hash }
}
