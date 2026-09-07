import { stringify } from 'yaml'
import {
  fetchRemoteConfig,
  RemoteConfigError,
  type EndCloseClient,
  type RemoteConfig,
  type SecretResolver,
} from '@end-close/relay'
import type { Db } from '@end-close/relay-sqlite'
import type { LoadedConfig } from './load.js'
import { readActiveConfigRaw, saveConfig } from './store.js'

// Initial configuration from End Close. When the application boots with neither a stored
// config nor a seed file, it fetches the routes document End Close holds for its API key
// (the key is environment-scoped, so it alone selects the environment) and stores it as
// the first config version, attributed to `endclose`. From then on the database is
// authoritative exactly as for a file seed: End Close never overwrites a stored config,
// and every later change is an audited admin apply.

export const REMOTE_ACTOR = 'endclose'

export type RemoteSeedResult =
  | { kind: 'seeded'; loaded: LoadedConfig; environment?: string }
  /** End Close holds no configuration for this key: bootstrap mode as before. */
  | { kind: 'none' }
  /** RELAY_REMOTE_CONFIG=off, or no API key to fetch with. */
  | { kind: 'disabled'; reason: 'env' | 'no_api_key' }
  /** A configuration was applied locally while the fetch was in flight; nothing saved. */
  | { kind: 'superseded' }
  | { kind: 'failed'; error: string; retryable: boolean }

/** What the admin plane reports about the fetch (bootstrap mode). */
export interface RemoteConfigStatus {
  state: 'none' | 'disabled' | 'failed'
  error?: string
  /** True while the application keeps retrying a transient failure in the background. */
  retrying: boolean
}

export interface RemoteSeedOptions {
  client: EndCloseClient
  apiKey: string
  baseUrl: string
  enabled: boolean
  secrets: SecretResolver
}

/** Serialize End Close's routes document as the YAML the version history stores. */
export function remoteConfigToYaml(config: RemoteConfig, baseUrl: string): string {
  const env = config.environment ? ` (environment: ${config.environment})` : ''
  return (
    `# Configuration fetched from End Close${env} on ${config.fetchedAt}\n` +
    `# Source: ${baseUrl}/relays/config. Edits applied here become new local versions;\n` +
    `# End Close does not overwrite a stored configuration.\n` +
    stringify(config.document)
  )
}

/**
 * Fetch the configuration End Close holds for this API key and store it as the first
 * config version. Only called when the database holds no configuration.
 */
export async function seedFromEndClose(db: Db, opts: RemoteSeedOptions): Promise<RemoteSeedResult> {
  if (!opts.enabled) return { kind: 'disabled', reason: 'env' }
  if (!opts.apiKey) return { kind: 'disabled', reason: 'no_api_key' }

  let config: RemoteConfig
  try {
    config = await fetchRemoteConfig(opts.client)
  } catch (err) {
    if (err instanceof RemoteConfigError) {
      if (err.kind === 'not_found') return { kind: 'none' }
      return { kind: 'failed', error: err.message, retryable: err.retryable }
    }
    return { kind: 'failed', error: (err as Error).message, retryable: false }
  }

  // An operator may have applied a configuration through the admin UI while the fetch
  // was in flight; the local apply wins. saveConfig is synchronous, so this check and
  // the write cannot interleave with another apply.
  if (readActiveConfigRaw(db)) return { kind: 'superseded' }
  const yamlText = remoteConfigToYaml(config, opts.baseUrl)
  try {
    const loaded = saveConfig(db, yamlText, REMOTE_ACTOR, opts.secrets)
    return {
      kind: 'seeded',
      loaded,
      ...(config.environment !== undefined ? { environment: config.environment } : {}),
    }
  } catch (err) {
    // Missing secret env vars or a document this build's schema rejects: the operator
    // has to act (set the variable / fix it in End Close) and restart.
    return {
      kind: 'failed',
      error: `configuration fetched from End Close could not be applied: ${(err as Error).message}`,
      retryable: false,
    }
  }
}

export function remoteStatusOf(result: RemoteSeedResult, retrying: boolean): RemoteConfigStatus | undefined {
  switch (result.kind) {
    case 'none':
      return { state: 'none', retrying: false }
    case 'disabled':
      return { state: 'disabled', retrying: false }
    case 'failed':
      return { state: 'failed', error: result.error, retrying: retrying && result.retryable }
    default:
      return undefined
  }
}
