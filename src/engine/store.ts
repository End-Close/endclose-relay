import type { RouteConfig } from '../config/schema.js'

// The persistence contracts the engine depends on. A host supplies implementations: the
// appliance uses SQLite; an embedding application may use its own database. Every
// method is async so implementations can be backed by a network database.

export type EventStatus =
  | 'pending'
  | 'retry'
  | 'delivering'
  | 'delivered'
  | 'parked'
  | 'dropped_by_filter'

export interface EventRecord {
  id: number
  route_id: string
  source: string
  event_id: string
  event_type: string | null
  payload_enc: Buffer
  payload_iv: Buffer
  headers_json: string
  received_at: string
  status: EventStatus
  attempts: number
  next_attempt_at: string | null
  delivered_at: string | null
  bulk_request_id: string | null
  last_error: string | null
  idempotency_key: string
}

export interface NewEvent {
  route_id: string
  source: string
  event_id: string
  event_type: string | null
  payload_enc: Buffer
  payload_iv: Buffer
  headers_json: string
  received_at: string
  status: EventStatus
  idempotency_key: string
}

export interface RouteStats {
  route_id: string
  counts: Partial<Record<EventStatus, number>>
  last_delivered_at: string | null
  oldest_pending_at: string | null
}

export type EventSummary = Omit<EventRecord, 'payload_enc' | 'payload_iv' | 'headers_json' | 'idempotency_key'>

export type InsertResult = { duplicate: false; id: number } | { duplicate: true }

/**
 * Thrown by a store when it is temporarily unable to serve a request (lock contention,
 * connection loss). Ingest answers 503 so the processor retries; anything else is 500.
 */
export class StoreUnavailableError extends Error {
  constructor(
    message: string,
    readonly op: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'StoreUnavailableError'
  }
}

/** What the engine needs from event storage. */
export interface EventStore {
  /** Persist a new event; `duplicate: true` when the idempotency key already exists. */
  insert(e: NewEvent): Promise<InsertResult>
  routesWithDueEvents(now: string): Promise<string[]>
  /**
   * Atomically select up to `limit` due events for a route (oldest first) and mark them
   * `delivering`. Concurrent callers must never receive overlapping rows.
   */
  claimDue(routeId: string, now: string, limit: number): Promise<EventRecord[]>
  markDelivered(ids: number[], deliveredAt: string, bulkRequestId: string | null): Promise<void>
  markFailed(ids: number[], nextAttemptAt: string, error: string): Promise<void>
  markParked(ids: number[], error: string): Promise<void>
  /** Return the given rows to `retry` if (and only if) they are still `delivering`. */
  releaseDelivering(ids: number[], nextAttemptAt: string, error: string): Promise<number>
  /** Return rows stuck in `delivering` (e.g. after a crash) to `retry`. */
  recoverDelivering(now: string): Promise<number>
  /** Park events that have been retrying longer than `maxAgeMs`. */
  parkExpired(now: string, maxAgeMs: number): Promise<number>
  /** One bounded retention step; callers loop until it returns zeros. */
  pruneBatch(
    now: string,
    deliveredDays: number,
    ledgerDays: number,
    limit: number,
  ): Promise<{ wiped: number; deleted: number }>
  close?(): Promise<void>
}

/** Optional inspection/replay capability used by an operator surface. */
export interface EventStoreAdmin {
  getById(id: number): Promise<EventRecord | undefined>
  list(filter: { status?: EventStatus; route?: string; limit?: number }): Promise<EventSummary[]>
  countByStatus(): Promise<Record<string, number>>
  perRouteStats(): Promise<RouteStats[]>
  replay(id: number): Promise<boolean>
  replayAllParked(): Promise<number>
}

export function hasAdmin(store: EventStore): store is EventStore & EventStoreAdmin {
  return typeof (store as Partial<EventStoreAdmin>).list === 'function'
}

export type Killswitch = 'none' | 'pause' | 'panic'

/** Runtime-mutable operator state: the global killswitch and per-route pauses. */
export interface ControlStore {
  getKillswitch(): Promise<Killswitch>
  setKillswitch(state: Killswitch): Promise<void>
  isRoutePaused(routeId: string): Promise<boolean>
  setRoutePaused(routeId: string, paused: boolean): Promise<void>
}

/** Where the engine reads route definitions. Static for an embedding app; live for the appliance. */
export interface RouteProvider {
  get(id: string): Promise<RouteConfig | undefined>
  all(): Promise<RouteConfig[]>
}

export function staticRoutes(routes: RouteConfig[]): RouteProvider {
  const byId = new Map(routes.map((r) => [r.id, r]))
  return {
    get: async (id) => byId.get(id),
    all: async () => [...byId.values()],
  }
}

export class MemoryControlStore implements ControlStore {
  private killswitch: Killswitch = 'none'
  private paused = new Set<string>()
  async getKillswitch(): Promise<Killswitch> {
    return this.killswitch
  }
  async setKillswitch(state: Killswitch): Promise<void> {
    this.killswitch = state
  }
  async isRoutePaused(routeId: string): Promise<boolean> {
    return this.paused.has(routeId)
  }
  async setRoutePaused(routeId: string, paused: boolean): Promise<void> {
    if (paused) this.paused.add(routeId)
    else this.paused.delete(routeId)
  }
}
