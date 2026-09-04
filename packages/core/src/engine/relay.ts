import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { relayConfigSchema, type RelayConfig, type RouteConfig } from '../config/schema.js'
import { deriveKey } from '../crypto/keys.js'
import { EndCloseClient } from '../forward/endclose-client.js'
import { Dispatcher, type CycleSummary } from '../forward/dispatcher.js'
import { mapEvent, type MappedEvent } from '../forward/mapper.js'
import { hasAdapter } from '../ingest/adapters/registry.js'
import type { ProcessorAdapter, RawRequest } from '../ingest/adapters/types.js'
import type { Json } from '../mask/paths.js'
import { noopLogger, type Logger } from '../logger.js'
import { sleep } from '../util/strings.js'
import { aesGcmCodec, plainCodec, type PayloadCodec } from './codec.js'
import { RelayHooks, type RelayEventName, type RelayHandler } from './hooks.js'
import { ingestWebhook, type IngestResult } from './ingest.js'
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

// The embeddable engine: everything the appliance does between "webhook arrives" and
// "record accepted by End Close", with storage, secrets, logging and observability
// supplied by the host.

export interface RelayOptions {
  /** Route definitions: the same shape as the `routes` block of relay.yaml. */
  routes: RouteConfig[] | RouteProvider
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
  /** Supply a pre-built client (the appliance shares one with telemetry). */
  client?: EndCloseClient
}

export interface DispatchOnceResult {
  delivered: number
  retried: number
  parked: number
}

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
  readonly routes: RouteProvider
  readonly client: EndCloseClient
  readonly codec: PayloadCodec
}

function toKey(name: string, v: string | Buffer): Buffer {
  if (typeof v === 'string') return deriveKey(name, v)
  if (v.length !== 32) throw new Error(`${name} must be a 32-byte Buffer or a string of 16+ chars`)
  return v
}

/** Reject routes whose `source` has no adapter (built-in or host-registered). */
export function assertKnownSources(
  routes: RouteConfig[],
  adapters?: Record<string, ProcessorAdapter>,
): void {
  for (const r of routes) {
    if (!hasAdapter(r.source, adapters)) {
      throw new Error(`route ${r.id}: no adapter for source "${r.source}"`)
    }
  }
}

/**
 * Validate a routes document (parsed YAML or a plain object) into RouteConfig[]. Applies
 * defaults, the hard-denylist check on metadata names, duplicate-id and unknown-source
 * checks. Pass the host's extra adapters so their sources validate too.
 */
export function parseRoutes(
  doc: unknown,
  opts: { adapters?: Record<string, ProcessorAdapter> } = {},
): RouteConfig[] {
  const config: RelayConfig = relayConfigSchema.parse(doc)
  const seen = new Set<string>()
  for (const route of config.routes) {
    if (seen.has(route.id)) throw new Error(`duplicate route id: ${route.id}`)
    seen.add(route.id)
  }
  assertKnownSources(config.routes, opts.adapters)
  return config.routes
}

const FLUSH_POLL_MIN_MS = 50
const FLUSH_POLL_MAX_MS = 1000

export function createRelay(opts: RelayOptions): Relay {
  if (Array.isArray(opts.routes)) assertKnownSources(opts.routes, opts.adapters)
  const routes = Array.isArray(opts.routes) ? staticRoutes(opts.routes) : opts.routes
  const control = opts.control ?? new MemoryControlStore()
  const secrets = toSecretResolver(opts.secrets)
  const logger = opts.logger ?? noopLogger
  const hooks = opts.hooks ?? new RelayHooks()
  const codec =
    opts.encryption === 'none' ? plainCodec : aesGcmCodec(toKey('dataKey', opts.encryption.dataKey))
  const maskingKey = toKey('maskingKey', opts.maskingKey)
  const client =
    opts.client ??
    new EndCloseClient(
      opts.endclose.baseUrl ?? 'https://api.endclose.com/v1',
      opts.endclose.apiKey,
      opts.endclose.fetch ?? fetch,
    )
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

  const counts = (c: CycleSummary): DispatchOnceResult => ({
    delivered: c.delivered,
    retried: c.retried,
    parked: c.parked,
  })

  const dispatchOnce = async (o: { prune?: boolean } = {}): Promise<DispatchOnceResult> => {
    const summary = await dispatcher.runOnce()
    if (o.prune) await dispatcher.pruneNow()
    return counts(summary)
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

      const status = await store.countByStatus()
      if ((status['pending'] ?? 0) + (status['retry'] ?? 0) === 0) return { ...totals, drained: true }

      // Due work the cycle left untouched will not clear on its own.
      const touched = c.delivered + c.retried + c.parked
      if (touched === 0 && c.due.length > 0 && c.skipped.length === c.due.length) {
        const allPaused = c.skipped.every((s) => s.reason === 'paused')
        return { ...totals, reason: allPaused ? 'paused' : 'unroutable' }
      }

      const remaining = deadline - Date.now()
      if (remaining <= 0) return { ...totals, reason: 'timeout' }
      // Backoff timers are what we are waiting on; poll gently.
      await sleep(Math.min(pollMs, remaining))
      pollMs = touched > 0 ? FLUSH_POLL_MIN_MS : Math.min(pollMs * 2, FLUSH_POLL_MAX_MS)
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
    client,
    codec,
  }
}
