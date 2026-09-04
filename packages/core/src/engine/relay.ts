import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { relayConfigSchema, type RelayConfig, type RouteConfig } from '../config/schema.js'
import { deriveKey } from '../crypto/keys.js'
import { EndCloseClient } from '../forward/endclose-client.js'
import { Dispatcher } from '../forward/dispatcher.js'
import { mapEvent, type MappedEvent } from '../forward/mapper.js'
import type { ProcessorAdapter, RawRequest } from '../ingest/adapters/types.js'
import { hasAdapter } from '../ingest/adapters/registry.js'
import type { Json } from '../mask/paths.js'
import { noopLogger, type Logger } from '../logger.js'
import { aesGcmCodec, plainCodec, type PayloadCodec } from './codec.js'
import { RelayHooks, type RelayEventName, type RelayHandler } from './hooks.js'
import { ingestWebhook, type IngestResult } from './ingest.js'
import { toSecretResolver, type SecretResolver } from './secrets.js'
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

export interface DispatchSettings {
  /** Records per bulk POST. */
  batchMax: number
  /** How often the loop wakes when idle (it also wakes immediately on ingest). */
  pollIntervalMs: number
  backoffBaseMs: number
  backoffCapMs: number
  /** Retrying events park (never dropped) after this long. */
  parkAfterMs: number
  /** How long a claimed batch is protected from recovery by other instances. */
  leaseMs: number
}

export interface RetentionSettings {
  /** Payloads of delivered/filtered events are wiped after this many days. */
  deliveredDays: number
  /** Their rows (the idempotency ledger) are deleted after this many days. */
  ledgerDays: number
}

export const DEFAULT_DISPATCH: DispatchSettings = {
  batchMax: 100,
  pollIntervalMs: 250,
  backoffBaseMs: 1000,
  backoffCapMs: 600_000,
  parkAfterMs: 7 * 24 * 3600 * 1000,
  leaseMs: 600_000,
}

export const DEFAULT_RETENTION: RetentionSettings = { deliveredDays: 7, ledgerDays: 30 }

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

export interface Relay {
  /** Framework-agnostic webhook entrypoint. */
  ingest(routeId: string, req: RawRequest): Promise<IngestResult>
  /** Start the background dispatch loop (long-lived processes). */
  start(): void
  /** Stop the loop and drain in-flight work. */
  stop(): Promise<void>
  /** Run one dispatch cycle (cron / serverless / tests). */
  dispatchOnce(opts?: { prune?: boolean }): Promise<DispatchOnceResult>
  /** Run retention pruning to completion. */
  prune(): Promise<{ wiped: number; deleted: number }>
  /** Map a sample payload through a route without storing or sending anything. */
  preview(route: RouteConfig, sample: Json, receivedAt?: string): MappedEvent
  /** Decode a buffered payload. Sensitive: the caller is responsible for auditing. */
  readPayload(id: string): Promise<Buffer | undefined>
  on<E extends RelayEventName>(name: E, handler: RelayHandler<E>): () => void
  readonly hooks: RelayHooks
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

/** Validate a routes document (parsed YAML or a plain object) into RouteConfig[]. */
export function parseRoutes(doc: unknown): RouteConfig[] {
  const config: RelayConfig = relayConfigSchema.parse(doc)
  const seen = new Set<string>()
  for (const route of config.routes) {
    if (seen.has(route.id)) throw new Error(`duplicate route id: ${route.id}`)
    seen.add(route.id)
  }
  return config.routes
}

export function createRelay(opts: RelayOptions): Relay {
  if (Array.isArray(opts.routes)) {
    for (const r of opts.routes) {
      if (!hasAdapter(r.source, opts.adapters)) {
        throw new Error(`route ${r.id}: no adapter for source "${r.source}"`)
      }
    }
  }
  const routes = Array.isArray(opts.routes) ? staticRoutes(opts.routes) : opts.routes
  const control = opts.control ?? new MemoryControlStore()
  const secrets = toSecretResolver(opts.secrets)
  const logger = opts.logger === null ? noopLogger : (opts.logger ?? noopLogger)
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
  const dispatch = { ...DEFAULT_DISPATCH, ...opts.dispatch }
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
    client,
    codec,
    maskingKey,
    instanceId: opts.instanceId ?? randomUUID(),
    signal,
    hooks,
    logger,
    settings: {
      dispatch: {
        batch_max: dispatch.batchMax,
        poll_interval_ms: dispatch.pollIntervalMs,
        backoff_base_ms: dispatch.backoffBaseMs,
        backoff_cap_ms: dispatch.backoffCapMs,
        park_after_ms: dispatch.parkAfterMs,
        lease_ms: dispatch.leaseMs,
      },
      retention: retention
        ? { delivered_days: retention.deliveredDays, ledger_days: retention.ledgerDays }
        : null,
    },
  })

  return {
    ingest: (routeId, req) => ingestWebhook(ingestDeps, routeId, req),
    start: () => dispatcher.start(),
    stop: () => dispatcher.stop(),
    async dispatchOnce(o = {}) {
      const result: DispatchOnceResult = { delivered: 0, retried: 0, parked: 0 }
      const off = hooks.on('forward', (e) => {
        result[e.result] += e.count
      })
      try {
        await dispatcher.runOnce()
        if (o.prune) await dispatcher.pruneNow()
      } finally {
        off()
      }
      return result
    },
    prune: () => dispatcher.pruneNow(),
    preview: (route, sample, receivedAt = new Date().toISOString()) =>
      mapEvent(route, sample, receivedAt, maskingKey),
    async readPayload(id) {
      if (!hasAdmin(store)) throw new Error('store does not support inspection (EventStoreAdmin)')
      const row = await store.getById(id)
      if (!row || row.payload.length === 0) return undefined
      return codec.decode(row.payload, row.payload_iv)
    },
    on: (name, handler) => hooks.on(name, handler),
    hooks,
    store,
    control,
    routes,
    client,
    codec,
  }
}
