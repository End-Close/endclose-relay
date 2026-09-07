import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import type { RouteConfig } from '../config/schema.js'
import { deriveKey } from '../crypto/keys.js'
import { ENDCLOSE_API_URL, EndCloseClient } from '../forward/endclose-client.js'
import { Dispatcher, type DispatchCounts } from '../forward/dispatcher.js'
import { mapEvent, type MappedEvent } from '../forward/mapper.js'
import type { ProcessorAdapter, RawRequest } from '../ingest/adapters/types.js'
import type { Json } from '../mask/paths.js'
import { noopLogger, type Logger } from '../logger.js'
import { sleep } from '../util/strings.js'
import { aesGcmCodec, plainCodec } from './codec.js'
import { RelayHooks, type RelayEventName, type RelayHandler } from './hooks.js'
import { ingestWebhook, type IngestResult } from './ingest.js'
import { remoteRoutes } from './remote-config.js'
import { assertKnownSources } from './routes.js'
import { toSecretResolver, type SecretResolver } from './secrets.js'
import {
  DEFAULT_DISPATCH,
  DEFAULT_RETENTION,
  type DispatchSettings,
  type RetentionSettings,
} from './settings.js'
import {
  hasAdmin,
  MemoryControlStore,
  staticRoutes,
  type ControlStore,
  type EventStore,
  type RouteProvider,
} from './store.js'

// The embeddable engine: everything the application does between "webhook arrives" and
// "record accepted by End Close", with storage, secrets, logging and observability
// supplied by the host.

export interface RelayOptions {
  /**
   * Route definitions: the same shape as the `routes` block of relay.yaml, or a live
   * provider. Omit to fetch them from End Close with the API key — the key is
   * environment-scoped, so it alone determines which environment's configuration the
   * relay runs (see `remoteRoutes`).
   */
  routes?: RouteConfig[] | RouteProvider
  store: EventStore
  /** Killswitch and per-route pause state. Default: in-memory, nothing paused. */
  control?: ControlStore
  /** Where `auth.secret_env` references resolve. */
  secrets: SecretResolver | Record<string, string>
  endclose: { apiKey: string; baseUrl?: string; fetch?: typeof fetch }
  /** Explicit: encrypt buffered payloads at rest under this key, or store them as-is. */
  encryption: { dataKey: string | Buffer } | 'none'
  /** Keys the deterministic `hash` transform. Never leaves the host. */
  maskingKey: string | Buffer
  dispatch?: Partial<DispatchSettings>
  /** `false` disables retention pruning entirely. */
  retention?: Partial<RetentionSettings> | false
  /** Default: silent. */
  logger?: Logger | null
  /** Additional processor adapters keyed by route `source`. */
  adapters?: Record<string, ProcessorAdapter>
  /** Lease owner for claimed batches. Give each long-lived replica a stable id. */
  instanceId?: string
  hooks?: RelayHooks
  /** Supply a pre-built client (the application shares one with telemetry). */
  client?: EndCloseClient
  /** Tuning for routes fetched from End Close (only used when `routes` is omitted). */
  remoteConfig?: { refreshIntervalMs?: number }
}

export type DispatchOnceResult = DispatchCounts

export interface FlushResult extends DispatchOnceResult {
  /** True when nothing deliverable remained when flush returned. */
  drained: boolean
  /**
   * Why flush stopped early: the deadline passed, forwarding is paused (killswitch or
   * every due route), or due events belong to routes the provider no longer knows.
   */
  reason?: 'timeout' | 'paused' | 'unroutable'
}

export interface Relay {
  /** Framework-agnostic webhook entrypoint. */
  ingest(routeId: string, req: RawRequest): Promise<IngestResult>
  /** Start the background dispatch loop (long-lived processes). */
  start(): void
  /** Stop the loop and drain in-flight work. */
  stop(): Promise<void>
  /** Run one dispatch cycle (cron / serverless / tests). */
  dispatchOnce(opts?: { prune?: boolean }): Promise<DispatchOnceResult>
  /**
   * Run dispatch cycles until nothing deliverable remains or `timeoutMs` (default 30 s)
   * passes, retrying as backoff timers expire. Returns immediately if forwarding is
   * paused. Events still `retried` when it returns need a later cycle or a durable store.
   */
  flush(opts?: { timeoutMs?: number }): Promise<FlushResult>
  /** Run retention pruning to completion. */
  prune(): Promise<{ wiped: number; deleted: number }>
  /** Map a sample payload through a route without storing or sending anything. */
  preview(route: RouteConfig, sample: Json, receivedAt?: string): MappedEvent
  /** Decode a buffered payload. Sensitive: the caller is responsible for auditing. */
  readPayload(id: string): Promise<Buffer | undefined>
  on<E extends RelayEventName>(name: E, handler: RelayHandler<E>): () => void
  readonly store: EventStore
  readonly control: ControlStore
  /** Where routes are read from: static, the host's provider, or End Close when `routes` was omitted. */
  readonly routes: RouteProvider
}

function toKey(name: string, v: string | Buffer): Buffer {
  if (typeof v === 'string') return deriveKey(name, v)
  if (v.length !== 32) throw new Error(`${name} must be a 32-byte Buffer or a string of 16+ chars`)
  return v
}

export { assertKnownSources, parseRoutes } from './routes.js'

const FLUSH_POLL_MIN_MS = 50
const FLUSH_POLL_MAX_MS = 1000
// Asking for "due" events at this time returns every route holding pending/retry rows.
const FAR_FUTURE = '9999-12-31T23:59:59.999Z'

export function createRelay(opts: RelayOptions): Relay {
  const logger = opts.logger ?? noopLogger
  const client =
    opts.client ??
    new EndCloseClient(
      opts.endclose.baseUrl ?? ENDCLOSE_API_URL,
      opts.endclose.apiKey,
      opts.endclose.fetch ?? fetch,
    )
  if (Array.isArray(opts.routes)) assertKnownSources(opts.routes, opts.adapters)
  const routes: RouteProvider =
    opts.routes === undefined
      ? remoteRoutes(client, {
          logger,
          ...(opts.adapters ? { adapters: opts.adapters } : {}),
          ...(opts.remoteConfig?.refreshIntervalMs !== undefined
            ? { refreshIntervalMs: opts.remoteConfig.refreshIntervalMs }
            : {}),
        })
      : Array.isArray(opts.routes)
        ? staticRoutes(opts.routes)
        : opts.routes
  const control = opts.control ?? new MemoryControlStore()
  const secrets = toSecretResolver(opts.secrets)
  const hooks = opts.hooks ?? new RelayHooks()
  const codec =
    opts.encryption === 'none' ? plainCodec : aesGcmCodec(toKey('dataKey', opts.encryption.dataKey))
  const maskingKey = toKey('maskingKey', opts.maskingKey)
  const dispatch: DispatchSettings = { ...DEFAULT_DISPATCH, ...opts.dispatch }
  const retention = opts.retention === false ? null : { ...DEFAULT_RETENTION, ...opts.retention }
  const signal = new EventEmitter()
  const { store } = opts

  const ingestDeps = {
    store,
    control,
    routes,
    secrets,
    codec,
    signal,
    hooks,
    logger,
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
  }

  const dispatcher = new Dispatcher({
    store,
    control,
    routes,
    dispatch,
    retention,
    client,
    codec,
    maskingKey,
    instanceId: opts.instanceId ?? randomUUID(),
    signal,
    hooks,
    logger,
  })

  const dispatchOnce = async (o: { prune?: boolean } = {}): Promise<DispatchOnceResult> => {
    const { delivered, retried, parked } = await dispatcher.runOnce()
    if (o.prune) await dispatcher.pruneNow()
    return { delivered, retried, parked }
  }

  const flush = async ({ timeoutMs = 30_000 } = {}): Promise<FlushResult> => {
    const deadline = Date.now() + timeoutMs
    const totals: FlushResult = { delivered: 0, retried: 0, parked: 0, drained: false }
    let pollMs = FLUSH_POLL_MIN_MS
    for (;;) {
      const c = await dispatcher.runOnce()
      totals.delivered += c.delivered
      totals.retried += c.retried
      totals.parked += c.parked
      if (c.halted) return { ...totals, reason: 'paused' }

      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ...totals, reason: 'timeout' }
      const touched = c.delivered + c.retried + c.parked
      if (touched > 0) continue // there may be more than one batch's worth; go straight back

      const backlog = await store.routesWithDueEvents(FAR_FUTURE)
      if (backlog.length === 0) return { ...totals, drained: true }
      // Backlog confined to routes the cycle deliberately skipped will not clear on its
      // own. Anything else is waiting on a backoff timer.
      const skipped = new Map(c.skipped.map((s) => [s.routeId, s.reason]))
      if (backlog.every((r) => skipped.has(r))) {
        const allPaused = backlog.every((r) => skipped.get(r) === 'paused')
        return { ...totals, reason: allPaused ? 'paused' : 'unroutable' }
      }

      await sleep(Math.min(pollMs, remaining))
      pollMs = Math.min(pollMs * 2, FLUSH_POLL_MAX_MS)
    }
  }

  const readPayload = async (id: string): Promise<Buffer | undefined> => {
    if (!hasAdmin(store)) throw new Error('store does not support inspection (EventStoreAdmin)')
    const row = await store.getById(id)
    if (!row || row.payload.length === 0) return undefined
    return codec.decode(row.payload, row.payload_iv)
  }

  return {
    ingest: (routeId, req) => ingestWebhook(ingestDeps, routeId, req),
    start: () => dispatcher.start(),
    stop: () => dispatcher.stop(),
    dispatchOnce,
    flush,
    prune: () => dispatcher.pruneNow(),
    preview: (route, sample, receivedAt = new Date().toISOString()) =>
      mapEvent(route, sample, receivedAt, maskingKey),
    readPayload,
    on: (name, handler) => hooks.on(name, handler),
    store,
    control,
    routes,
  }
}
