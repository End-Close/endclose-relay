import type { Db } from './db.js'
import { EventsRepo } from './repo/events.js'
import { KvRepo } from './repo/kv.js'
import { RoutesRepo } from './repo/routes.js'
import { BUSY_RETRY_ATTEMPTS, INGEST_BUSY_RETRY_ATTEMPTS, isSqliteBusy, withBusyRetry } from './busy.js'
import { log, type Logger } from '../log.js'
import {
  StoreUnavailableError,
  type ControlStore,
  type EventRecord,
  type EventStatus,
  type EventStore,
  type EventStoreAdmin,
  type EventSummary,
  type InsertResult,
  type Killswitch,
  type NewEvent,
  type RouteProvider,
  type RouteStats,
} from '../engine/store.js'
import type { RouteConfig } from '../config/schema.js'

// SQLite implementations of the engine's storage contracts. Lock contention (SQLITE_BUSY,
// common on network filesystems such as EFS) is retried here and surfaced as
// StoreUnavailableError; every other error is rethrown tagged with the operation name.

export class SqliteEventStore implements EventStore, EventStoreAdmin {
  readonly repo: EventsRepo
  private log: Logger

  constructor(db: Db, opts: { logger?: Logger } = {}) {
    this.repo = new EventsRepo(db)
    this.log = opts.logger ?? log
  }

  private async run<T>(op: string, fn: () => T, attempts = BUSY_RETRY_ATTEMPTS): Promise<T> {
    try {
      return await withBusyRetry(op, fn, { attempts, logger: this.log })
    } catch (err) {
      if (isSqliteBusy(err)) {
        throw new StoreUnavailableError((err as Error).message, op, { cause: err })
      }
      ;(err as { op?: string }).op = op
      throw err
    }
  }

  async insert(e: NewEvent): Promise<InsertResult> {
    const id = await this.run('insert', () => this.repo.insert(e), INGEST_BUSY_RETRY_ATTEMPTS)
    return id === null ? { duplicate: true } : { duplicate: false, id }
  }
  routesWithDueEvents(now: string): Promise<string[]> {
    return this.run('routesWithDueEvents', () => this.repo.routesWithDueEvents(now))
  }
  claimDue(routeId: string, now: string, limit: number): Promise<EventRecord[]> {
    return this.run('claimDue', () => this.repo.claimDue(routeId, now, limit))
  }
  markDelivered(ids: number[], deliveredAt: string, bulkRequestId: string | null): Promise<void> {
    return this.run('markDelivered', () => this.repo.markDelivered(ids, deliveredAt, bulkRequestId))
  }
  markFailed(ids: number[], nextAttemptAt: string, error: string): Promise<void> {
    return this.run('markFailed', () => this.repo.markFailed(ids, nextAttemptAt, error))
  }
  markParked(ids: number[], error: string): Promise<void> {
    return this.run('markParked', () => this.repo.markParked(ids, error))
  }
  releaseDelivering(ids: number[], nextAttemptAt: string, error: string): Promise<number> {
    return this.run('releaseDelivering', () => this.repo.releaseDelivering(ids, nextAttemptAt, error))
  }
  recoverDelivering(now: string): Promise<number> {
    return this.run('recoverDelivering', () => this.repo.recoverDelivering(now))
  }
  parkExpired(now: string, maxAgeMs: number): Promise<number> {
    return this.run('parkExpired', () => this.repo.parkExpired(now, maxAgeMs))
  }
  pruneBatch(now: string, deliveredDays: number, ledgerDays: number, limit: number) {
    return this.run('prune', () => this.repo.pruneBatch(now, deliveredDays, ledgerDays, limit))
  }

  // ── admin capability ──
  getById(id: number): Promise<EventRecord | undefined> {
    return this.run('getById', () => this.repo.getById(id))
  }
  list(filter: { status?: EventStatus; route?: string; limit?: number }): Promise<EventSummary[]> {
    return this.run('list', () => this.repo.list(filter))
  }
  countByStatus(): Promise<Record<string, number>> {
    return this.run('countByStatus', () => this.repo.countByStatus())
  }
  perRouteStats(): Promise<RouteStats[]> {
    return this.run('perRouteStats', () => this.repo.perRouteStats())
  }
  replay(id: number): Promise<boolean> {
    return this.run('replay', () => this.repo.replay(id))
  }
  replayAllParked(): Promise<number> {
    return this.run('replayAllParked', () => this.repo.replayAllParked())
  }
}

export class SqliteControlStore implements ControlStore {
  private kv: KvRepo
  private routes: RoutesRepo
  constructor(db: Db) {
    this.kv = new KvRepo(db)
    this.routes = new RoutesRepo(db)
  }
  async getKillswitch(): Promise<Killswitch> {
    return this.kv.globalKillswitch()
  }
  async setKillswitch(state: Killswitch): Promise<void> {
    this.kv.setGlobalKillswitch(state)
  }
  async isRoutePaused(routeId: string): Promise<boolean> {
    return this.routes.isPaused(routeId)
  }
  async setRoutePaused(routeId: string, paused: boolean): Promise<void> {
    this.routes.setPaused(routeId, paused)
  }
}

/** Live route definitions from the appliance database: every config apply is visible immediately. */
export class DbRouteProvider implements RouteProvider {
  private routes: RoutesRepo
  constructor(db: Db) {
    this.routes = new RoutesRepo(db)
  }
  async get(id: string): Promise<RouteConfig | undefined> {
    return this.routes.get(id)
  }
  async all(): Promise<RouteConfig[]> {
    return this.routes.all()
  }
}
