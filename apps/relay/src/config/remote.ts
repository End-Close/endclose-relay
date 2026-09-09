import { stringify } from 'yaml'
import {
  fetchRemoteConfig,
  RemoteConfigError,
  type EndCloseClient,
  type Logger,
  type RemoteConfig,
  type SecretResolver,
} from '@end-close/relay'
import { KvRepo, type Db } from '@end-close/relay-sqlite'
import { parseConfig, type LoadedConfig } from './load.js'
import { getActiveConfig, saveConfig } from './store.js'

// Configuration owned by End Close. End Close keeps one routes document per
// environment; a relay API key is scoped to one environment, so the key alone selects
// it. The status code of GET /relays/config is the whole answer to who owns the
// configuration:
//   200  End Close owns it. The document is stored as a new config version attributed
//        to `endclose` (audited like any apply; routes are read live, so it applies at
//        once), its ETag is kept, and the local editor is locked.
//   304  Owned and unchanged since the ETag sent. The common case while polling.
//   404  End Close is not managing this environment: a state, not a terminal answer.
//        The relay runs what it has (the last document End Close served, a seed file,
//        or whatever the editor applies) and keeps asking at the same cadence, so
//        management switched on later is picked up without a restart.
// RELAY_REMOTE_CONFIG=off never asks at all. Secrets stay references to env var names.

export const REMOTE_ACTOR = 'endclose'
const ETAG_KEY = 'remote_config.etag'
// The active config hash the ETag describes. A conditional GET is only honest while
// the stored document is still End Close's: after a local apply (management off, or
// RELAY_REMOTE_CONFIG toggled) a 304 must not pass a local edit off as End Close's.
const HASH_KEY = 'remote_config.hash'
const ENVIRONMENT_KEY = 'remote_config.environment'

export type RemoteCheck =
  | { kind: 'managed'; loaded: LoadedConfig; changed: boolean; environment?: string }
  | { kind: 'unmanaged' }
  | { kind: 'disabled'; reason: 'env' | 'no_api_key' }
  | { kind: 'failed'; error: string; retryable: boolean }

/** What the admin plane reports. */
export interface RemoteConfigStatus {
  state: 'managed' | 'unmanaged' | 'disabled' | 'failed' | 'unknown'
  /** True while End Close owns the configuration: the local editor is locked. */
  managed: boolean
  environment: string | null
  error: string | null
  /** True while a transient failure is being retried in the background. */
  retrying: boolean
  last_checked_at: string | null
}

export interface RemoteCheckOptions {
  client: EndCloseClient
  apiKey: string
  baseUrl: string
  enabled: boolean
  secrets: SecretResolver
}

/**
 * Serialize End Close's routes document as the YAML the version history stores. Must be
 * deterministic for a given document: the version hash is the hash of this text, and an
 * unchanged document must not produce a new version on every poll.
 */
export function remoteConfigToYaml(config: RemoteConfig, baseUrl: string): string {
  const env = config.environment ? ` (environment: ${config.environment})` : ''
  return (
    `# Configuration managed by End Close${env} — ${baseUrl}/relays/config\n` +
    `# Edit it in End Close; changes reach this relay within a minute. The local editor\n` +
    `# is locked while End Close manages this environment.\n` +
    stringify(config.document)
  )
}

/** Ask End Close once. Stores a fetched document; never throws. */
export async function checkEndClose(db: Db, opts: RemoteCheckOptions): Promise<RemoteCheck> {
  if (!opts.enabled) return { kind: 'disabled', reason: 'env' }
  if (!opts.apiKey) return { kind: 'disabled', reason: 'no_api_key' }

  const kv = new KvRepo(db)
  // A conditional GET only makes sense when the stored document is the one the ETag
  // describes: a missing, invalid or locally replaced stored config fetches in full.
  const stored = getActiveConfig(db)
  const etag = stored && kv.get(HASH_KEY) === stored.hash ? kv.get(ETAG_KEY) : undefined
  let config: RemoteConfig | null
  try {
    config = etag ? await fetchRemoteConfig(opts.client, { ifNoneMatch: etag }) : await fetchRemoteConfig(opts.client)
  } catch (err) {
    if (err instanceof RemoteConfigError) {
      if (err.kind === 'not_found') {
        kv.delete(ETAG_KEY)
        kv.delete(HASH_KEY)
        kv.delete(ENVIRONMENT_KEY)
        return { kind: 'unmanaged' }
      }
      return { kind: 'failed', error: err.message, retryable: err.retryable }
    }
    return { kind: 'failed', error: (err as Error).message, retryable: false }
  }

  if (config === null) {
    const environment = kv.get(ENVIRONMENT_KEY)
    return { kind: 'managed', loaded: stored!, changed: false, ...(environment ? { environment } : {}) }
  }

  const yamlText = remoteConfigToYaml(config, opts.baseUrl)
  const changed = stored?.hash !== parseConfig(yamlText).hash
  let loaded: LoadedConfig
  try {
    // saveConfig is a no-op when the hash matches the latest version.
    loaded = saveConfig(db, yamlText, REMOTE_ACTOR, opts.secrets)
  } catch (err) {
    // Missing secret env vars, or a document this build's schema rejects: the operator
    // has to act (set the variable / fix it in End Close). No ETag is kept, so the next
    // check fetches in full and tries again.
    return {
      kind: 'failed',
      error: `configuration from End Close could not be applied: ${(err as Error).message}`,
      retryable: false,
    }
  }
  if (config.etag) {
    kv.set(ETAG_KEY, config.etag)
    kv.set(HASH_KEY, loaded.hash)
  } else {
    kv.delete(ETAG_KEY)
    kv.delete(HASH_KEY)
  }
  if (config.environment) kv.set(ENVIRONMENT_KEY, config.environment)
  else kv.delete(ENVIRONMENT_KEY)
  return {
    kind: 'managed',
    loaded,
    changed,
    ...(config.environment !== undefined ? { environment: config.environment } : {}),
  }
}

/**
 * Tracks whether End Close owns the configuration and keeps it current. `check()` asks
 * once; `start()` polls at a fixed cadence for as long as asking is enabled — a 404 hands
 * ownership to the local editor but the question keeps being asked, because polling is
 * the only way to learn that management was switched back on.
 */
export class RemoteConfigManager {
  private status: RemoteConfigStatus = {
    state: 'unknown',
    managed: false,
    environment: null,
    error: null,
    retrying: false,
    last_checked_at: null,
  }
  private retryable = false
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<RemoteCheck> | undefined

  constructor(
    private db: Db,
    private opts: RemoteCheckOptions,
    private log: Logger,
  ) {}

  get managed(): boolean {
    return this.status.managed
  }

  /** Polling is pointless only when asking is disabled outright. */
  get shouldPoll(): boolean {
    return this.status.state !== 'disabled'
  }

  snapshot(): RemoteConfigStatus {
    return { ...this.status, retrying: this.timer !== undefined && this.status.state === 'failed' && this.retryable }
  }

  async check(): Promise<RemoteCheck> {
    if (this.inFlight) return this.inFlight
    this.inFlight = checkEndClose(this.db, this.opts)
      .then((result) => {
        this.record(result)
        return result
      })
      .finally(() => {
        this.inFlight = undefined
      })
    return this.inFlight
  }

  /** Poll every `intervalMs` while it can matter; `onCheck` sees every result. */
  start(intervalMs: number, onCheck?: (result: RemoteCheck) => void): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      if (!this.shouldPoll) return
      void this.check().then((r) => onCheck?.(r))
    }, intervalMs)
    this.timer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private record(result: RemoteCheck): void {
    const now = new Date().toISOString()
    const wasManaged = this.status.managed
    switch (result.kind) {
      case 'managed':
        this.status = {
          state: 'managed',
          managed: true,
          environment: result.environment ?? this.status.environment,
          error: null,
          retrying: false,
          last_checked_at: now,
        }
        this.retryable = false
        if (result.changed) {
          this.log.info('configuration updated from End Close', {
            environment: result.environment ?? null,
            config_hash: result.loaded.hash,
            routes: result.loaded.config.routes.length,
          })
        }
        break
      case 'unmanaged':
        this.status = { state: 'unmanaged', managed: false, environment: null, error: null, retrying: false, last_checked_at: now }
        this.retryable = false
        if (wasManaged) this.log.warn('End Close stopped managing this configuration; the local editor is unlocked')
        break
      case 'disabled':
        this.status = { state: 'disabled', managed: false, environment: null, error: null, retrying: false, last_checked_at: now }
        this.retryable = false
        break
      case 'failed':
        // A transient failure does not change who owns the configuration: keep running
        // (and, if End Close owned it, keep the editor locked) until an answer arrives.
        this.status = {
          ...this.status,
          state: 'failed',
          managed: wasManaged && result.retryable,
          error: result.error,
          last_checked_at: now,
        }
        this.retryable = result.retryable
        break
    }
  }
}
