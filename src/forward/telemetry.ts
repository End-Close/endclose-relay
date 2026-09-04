import { statSync } from 'node:fs'
import type { Db } from '../db/db.js'
import { EventsRepo, type EventStatus } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo } from '../db/repo/kv.js'
import { readActiveConfigRaw } from '../config/store.js'
import { isDbPathPersistent } from '../db/persistence.js'
import { log } from '../log.js'
import type { EndCloseClient } from './endclose-client.js'
import type { RelayHooks } from '../engine/hooks.js'

export const TELEMETRY_ERROR_LIMIT = 20
export const TELEMETRY_ERROR_WINDOW_MS = 60_000
export const HEARTBEAT_INTERVAL_MS = 15 * 60_000
const STACK_MAX = 8 * 1024
const MESSAGE_MAX = 500
const STOP_WAIT_MS = 1_000

export type TelemetryEventName =
  | 'relay_boot'
  | 'relay_heartbeat'
  | 'relay_error'
  | 'relay_shutdown'
  | 'relay_killswitch'
  | 'relay_config_applied'
  | 'relay_batch_parked'

export const EVENT_KEYS: Record<TelemetryEventName, readonly string[]> = {
  relay_boot: ['version', 'mode', 'persistent', 'route_count', 'has_api_key', 'config'],
  relay_heartbeat: [
    'version',
    'uptime_s',
    'killswitch',
    'queue',
    'db_bytes',
    'persistent',
    'config',
    'routes',
  ],
  relay_error: ['version', 'kind', 'message', 'stack', 'op', 'route', 'config', 'missing'],
  relay_shutdown: ['version', 'signal', 'uptime_s'],
  relay_killswitch: ['version', 'before', 'after'],
  relay_config_applied: ['version', 'config'],
  relay_batch_parked: ['version', 'route', 'status', 'events'],
}

const QUEUE_STATUSES: EventStatus[] = [
  'pending',
  'retry',
  'delivering',
  'delivered',
  'parked',
  'dropped_by_filter',
]

const SECRET_RE = /Bearer\s+\S+|Basic\s+\S+|x-api-key["'\s:=]+\S+/gi

export type TelemetryKind =
  | 'fatal_boot'
  | 'setup_missing_env'
  | 'config_invalid'
  | 'dispatch_cycle'
  | 'ingest_persist'
  | 'prune'
  | 'recover_delivering'
  | 'uncaught'
  | 'unhandled_rejection'

export interface HeartbeatRoute {
  id: string
  source: string
  paused: boolean
  counts: Partial<Record<EventStatus, number>>
  last_delivered_at: string | null
  oldest_pending_age_s: number | null
}

export interface HeartbeatSnapshot {
  version: string
  uptime_s: number
  killswitch: string
  queue: Record<string, number>
  db_bytes: number
  persistent: boolean | null
  config: string | null
  routes: HeartbeatRoute[]
}

export interface TelemetryClient {
  postRelayEvent(event: { name: string; properties: Record<string, unknown> }): Promise<void>
}

export interface TelemetryOpts {
  enabled: boolean
  client: TelemetryClient | null
  version: string
  startedAt: number
  heartbeatIntervalMs?: number
  errorLimit?: number
}

export function pickEventProperties(
  name: TelemetryEventName,
  props: Record<string, unknown>,
): Record<string, unknown> {
  const allowed = new Set(EVENT_KEYS[name])
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(props)) {
    if (allowed.has(k) && v !== undefined) out[k] = v
  }
  return out
}

export function sanitizeError(err: unknown): { message: string; stack: string } {
  const e = err as Error & { body?: unknown; op?: string }
  const message = redactSecrets(String(e?.message ?? err)).slice(0, MESSAGE_MAX)
  const stack = redactSecrets(typeof e?.stack === 'string' ? e.stack : '').slice(0, STACK_MAX)
  return { message, stack }
}

export function redactSecrets(s: string): string {
  return s.replace(SECRET_RE, '[REDACTED]')
}

export function buildHeartbeatSnapshot(
  version: string,
  startedAt: number,
  src: {
    now?: number
    killswitch: string
    queue: Record<string, number>
    dbBytes: number
    persistent: boolean | null
    config: string | null
    routes: Array<{
      id: string
      source: string
      paused: boolean
      counts: Partial<Record<EventStatus, number>>
      last_delivered_at: string | null
      oldest_pending_at: string | null
    }>
  },
): HeartbeatSnapshot {
  const now = src.now ?? Date.now()
  const queue: Record<string, number> = {}
  for (const status of QUEUE_STATUSES) queue[status] = src.queue[status] ?? 0
  return {
    version,
    uptime_s: Math.max(0, Math.round((now - startedAt) / 1000)),
    killswitch: src.killswitch,
    queue,
    db_bytes: src.dbBytes,
    persistent: src.persistent,
    config: src.config,
    routes: src.routes.map((r) => ({
      id: r.id,
      source: r.source,
      paused: r.paused,
      counts: r.counts,
      last_delivered_at: r.last_delivered_at,
      oldest_pending_age_s:
        r.oldest_pending_at != null
          ? Math.round((now - Date.parse(r.oldest_pending_at)) / 1000)
          : null,
    })),
  }
}

export function snapshotFromDb(db: Db, dbPath: string, startedAt: number, version: string): HeartbeatSnapshot {
  const events = new EventsRepo(db)
  const kv = new KvRepo(db)
  const routes = new RoutesRepo(db)
  const stats = new Map(events.perRouteStats().map((s) => [s.route_id, s]))
  let dbBytes = 0
  try {
    dbBytes = statSync(dbPath).size
  } catch {
    dbBytes = 0
  }
  return buildHeartbeatSnapshot(version, startedAt, {
    killswitch: kv.globalKillswitch(),
    queue: events.countByStatus(),
    dbBytes,
    persistent: isDbPathPersistent(dbPath),
    config: readActiveConfigRaw(db)?.yamlText ?? null,
    routes: routes.all().map((r) => {
      const s = stats.get(r.id)
      return {
        id: r.id,
        source: r.source,
        paused: kv.isRoutePaused(r.id),
        counts: s?.counts ?? {},
        last_delivered_at: s?.last_delivered_at ?? null,
        oldest_pending_at: s?.oldest_pending_at ?? null,
      }
    }),
  })
}

export class Telemetry {
  private snapshot: (() => HeartbeatSnapshot) | undefined
  private timer: NodeJS.Timeout | undefined
  private running = false
  private pending = new Set<Promise<void>>()
  private errorTimes: number[] = []
  private onUncaught: ((err: Error) => void) | undefined
  private onUnhandled: ((reason: unknown) => void) | undefined

  constructor(private opts: TelemetryOpts) {}

  get enabled(): boolean {
    return this.opts.enabled && this.opts.client != null
  }

  /** Forward engine errors and batch rejections to the call-home. */
  subscribe(hooks: RelayHooks): void {
    hooks.on('error', (e) =>
      this.captureError(e.kind, e.error, {
        ...(e.op ? { op: e.op } : {}),
        ...(e.routeId ? { route: e.routeId } : {}),
      }),
    )
    hooks.on('batch.parked', (e) =>
      this.capture('relay_batch_parked', { route: e.routeId, status: e.status, events: e.events }),
    )
  }

  /** Register crash handlers and start the heartbeat loop. */
  start(snapshot: () => HeartbeatSnapshot): void {
    this.snapshot = snapshot
    if (!this.enabled) return
    this.running = true
    this.onUncaught = (err: Error) => {
      this.captureError('uncaught', err)
      void this.stop().finally(() => process.exit(1))
    }
    this.onUnhandled = (reason: unknown) => {
      this.captureError('unhandled_rejection', reason)
    }
    process.on('uncaughtException', this.onUncaught)
    process.on('unhandledRejection', this.onUnhandled)
    this.scheduleBeat(0)
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearTimeout(this.timer)
    if (this.onUncaught) process.off('uncaughtException', this.onUncaught)
    if (this.onUnhandled) process.off('unhandledRejection', this.onUnhandled)
    await Promise.race([Promise.all([...this.pending]), sleep(STOP_WAIT_MS)])
  }

  capture(name: TelemetryEventName, props: Record<string, unknown> = {}): void {
    if (!this.enabled || !this.opts.client) return
    const properties = pickEventProperties(name, { version: this.opts.version, ...props })
    const client = this.opts.client
    const p = client.postRelayEvent({ name, properties }).catch((err: unknown) => {
      log.warn('telemetry event failed', { name, error: (err as Error).message })
    })
    this.track(p)
  }

  captureError(
    kind: TelemetryKind,
    err: unknown,
    extra: { op?: string; route?: string; config?: string; missing?: string } = {},
  ): void {
    if (!this.allowError()) return
    const { message, stack } = sanitizeError(err)
    this.capture('relay_error', {
      kind,
      message,
      stack,
      ...(extra.op ? { op: extra.op } : {}),
      ...(extra.route ? { route: extra.route } : {}),
      ...(extra.config ? { config: extra.config } : {}),
      ...(extra.missing ? { missing: extra.missing } : {}),
    })
  }

  private allowError(): boolean {
    const now = Date.now()
    const windowMs = TELEMETRY_ERROR_WINDOW_MS
    const limit = this.opts.errorLimit ?? TELEMETRY_ERROR_LIMIT
    this.errorTimes = this.errorTimes.filter((t) => now - t < windowMs)
    if (this.errorTimes.length >= limit) return false
    this.errorTimes.push(now)
    return true
  }

  private scheduleBeat(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.beat()
      if (this.running) this.scheduleBeat(jitter(this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS))
    }, delayMs)
  }

  private beat(): void {
    if (!this.snapshot) return
    try {
      const snap = this.snapshot()
      this.capture('relay_heartbeat', snap as unknown as Record<string, unknown>)
    } catch (err) {
      log.warn('telemetry heartbeat skipped', { error: (err as Error).message })
    }
  }

  private track(p: Promise<void>): void {
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }
}

export function createTelemetry(
  opts: { enabled: boolean; apiKey: string; client: EndCloseClient; version: string; startedAt: number },
): Telemetry {
  return new Telemetry({
    enabled: opts.enabled && Boolean(opts.apiKey),
    client: opts.apiKey ? opts.client : null,
    version: opts.version,
    startedAt: opts.startedAt,
  })
}

function jitter(intervalMs: number): number {
  return Math.round(intervalMs * (0.8 + Math.random() * 0.4))
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
