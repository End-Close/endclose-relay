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
import type { LoadedConfig } from './load.js'
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
// Anything else (unreachable, rejected key, unusable document) changes nothing about
// who owns the configuration: the last answer stands until a new one arrives, and the
// error is reported. RELAY_REMOTE_CONFIG=off never asks at all. Secrets stay references
// to env var names.

export const REMOTE_ACTOR = 'endclose'
const ETAG_KEY = 'remote_config.etag'
// The active config hash the ETag describes. A conditional GET is only honest while
// the stored document is still End Close's: after a local apply (management off, or
// RELAY_REMOTE_CONFIG toggled) a 304 must not pass a local edit off as End Close's.
// The pair also records, across restarts, that End Close owned the configuration.
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
  /** When End Close last answered at all (including failures). */
  last_checked_at: string | null
  /** When End Close last answered 200/304/404 — the last time ownership was confirmed. */
  last_confirmed_at: string | null
}

export interface RemoteCheckOptions {
  client: EndCloseClient
  apiKey: string
  baseUrl: string
  enabled: boolean
  secrets: SecretResolver
}

/**
 * Serialize End Close's routes document as the YAML the version history stores. The
 * version hash is the hash of this text, so it must depend on the document alone: no
 * timestamps, URLs or environment names in the header, or an unchanged document would
 * become a new version on every poll or base-URL change.
 */
export function remoteConfigToYaml(config: RemoteConfig): string {
  return (
    `# Configuration managed by End Close (GET /relays/config).\n` +
    `# Edit it in End Close; changes reach this relay within a minute. The local editor\n` +
    `# is locked while End Close manages this environment.\n` +
    stringify(config.document)
  )
}

/** Whether End Close owned the configuration when this database was last written. */
export function wasManagedByEndClose(db: Db): boolean {
  const stored = getActiveConfig(db)
  return stored !== undefined && new KvRepo(db).get(HASH_KEY) === stored.hash
}

/** Ask End Close once. Stores a fetched document. Never throws. */
export async function checkEndClose(db: Db, opts: RemoteCheckOptions): Promise<RemoteCheck> {
  if (!opts.enabled) return { kind: 'disabled', reason: 'env' }
  if (!opts.apiKey) return { kind: 'disabled', reason: 'no_api_key' }
  try {
    return await checkEndCloseInner(db, opts)
  } catch (err) {
    // Store errors on the way in or out (locked database, full volume): the relay keeps
    // running and asks again next time.
    return { kind: 'failed', error: `local store error: ${(err as Error).message}`, retryable: true }
  }
}

async function checkEndCloseInner(db: Db, opts: RemoteCheckOptions): Promise<RemoteCheck> {
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
    throw err
  }

  if (config === null) {
    const environment = kv.get(ENVIRONMENT_KEY)
    return { kind: 'managed', loaded: stored!, changed: false, ...(environment ? { environment } : {}) }
  }

  const yamlText = remoteConfigToYaml(config)
  let loaded: LoadedConfig
  try {
    // saveConfig is a no-op when the hash matches the latest version.
    loaded = saveConfig(db, yamlText, REMOTE_ACTOR, opts.secrets)
  } catch (err) {
    // A store error is transient. Anything else — a secret env var not set, a document
    // this build's schema rejects — needs the operator (set the variable) or End Close
    // (fix the document). No ETag is kept, so the next check fetches in full.
    return {
      kind: 'failed',
      error: `configuration from End Close could not be applied: ${(err as Error).message}`,
      retryable: isStoreError(err),
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
    changed: stored?.hash !== loaded.hash,
    ...(config.environment !== undefined ? { environment: config.environment } : {}),
  }
}

function isStoreError(err: unknown): boolean {
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith('SQLITE')
}

/**
 * Tracks whether End Close owns the configuration and keeps it current. `check()` asks
 * once; `start()` polls at a fixed cadence for as long as asking is enabled — a 404 hands
 * ownership to the local editor but the question keeps being asked, because polling is
 * the only way to learn that management was switched back on. Ownership survives a
 * restart: until End Close answers, a relay that was managed stays managed.
 */
export class RemoteConfigManager {
  private status: RemoteConfigStatus
  private timer: NodeJS.Timeout | undefined
  private inFlight: Promise<RemoteCheck> | undefined

  constructor(
    private db: Db,
    private opts: RemoteCheckOptions,
    private log: Logger,
  ) {
    const managed = opts.enabled && Boolean(opts.apiKey) && wasManagedByEndClose(db)
    this.status = {
      state: 'unknown',
      managed,
      environment: managed ? (new KvRepo(db).get(ENVIRONMENT_KEY) ?? null) : null,
      error: null,
      retrying: false,
      last_checked_at: null,
      last_confirmed_at: null,
    }
  }

  get managed(): boolean {
    return this.status.managed
  }

  /** Polling is pointless only when asking is disabled outright. */
  get shouldPoll(): boolean {
    return this.status.state !== 'disabled'
  }

  snapshot(): RemoteConfigStatus {
    return { ...this.status }
  }

  /** Never rejects. */
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
      void this.check().then(
        (r) => onCheck?.(r),
        (err: unknown) => this.log.error('End Close configuration check failed unexpectedly', { error: String(err) }),
      )
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
          last_confirmed_at: now,
        }
        if (result.changed) {
          this.log.info('configuration updated from End Close', {
            environment: result.environment ?? null,
            config_hash: result.loaded.hash,
            routes: result.loaded.config.routes.length,
          })
        }
        break
      case 'unmanaged':
        this.status = {
          state: 'unmanaged',
          managed: false,
          environment: null,
          error: null,
          retrying: false,
          last_checked_at: now,
          last_confirmed_at: now,
        }
        if (wasManaged) this.log.warn('End Close stopped managing this configuration; the local editor is unlocked')
        break
      case 'disabled':
        this.status = {
          state: 'disabled',
          managed: false,
          environment: null,
          error: null,
          retrying: false,
          last_checked_at: now,
          last_confirmed_at: null,
        }
        break
      case 'failed':
        // Who owns the configuration is not in question until End Close answers; only
        // the error and, if it may clear on its own, the retrying flag change.
        this.status = {
          ...this.status,
          state: 'failed',
          error: result.error,
          retrying: result.retryable,
          last_checked_at: now,
        }
        break
    }
  }
}
