import type { Db } from './db.js'
import { EventsRepo, type EventRow } from './repo/events.js'
import { KvRepo } from './repo/kv.js'
import { BUSY_RETRY_ATTEMPTS, INGEST_BUSY_RETRY_ATTEMPTS, isSqliteBusy, withBusyRetry } from './busy.js'
import {
  noopLogger,
  StoreUnavailableError,
  type ControlStore,
  type Logger,
  type EventRecord,
  type EventStatus,
  type EventStore,
  type EventStoreAdmin,
  type EventSummary,
  type InsertResult,
  type Killswitch,
  type Lease,
  type NewEvent,
  type RouteStats,
} from '@endclose/relay'

// SQLite implementations of the engine's storage contracts. Lock contention (SQLITE_BUSY,
// common on network filesystems such as EFS) is retried here and surfaced as
// StoreUnavailableError; every other error is rethrown tagged with the operation name.

function toRecord(row: EventRow): EventRecord {
  const { payload_enc, payload_iv, ...rest } = row
  return {
    ...rest,
    id: String(row.id),
    payload: payload_enc,
    payload_iv: payload_iv.length === 0 ? null : payload_iv,
  }
}

function toSummary<T extends { id: number }>(row: T): Omit<T, 'id'> & { id: string } {
  return { ...row, id: String(row.id) }
}

const numericIds = (ids: string[]) => ids.map(Number)

export class SqliteEventStore implements EventStore, EventStoreAdmin {
  readonly repo: EventsRepo
  private log: Logger

  constructor(db: Db, opts: { logger?: Logger } = {}) {
    this.repo = new EventsRepo(db)
    this.log = opts.logger ?? noopLogger
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
    const { payload, payload_iv, ...rest } = e
    const row = { ...rest, payload_enc: payload, payload_iv: payload_iv ?? Buffer.alloc(0) }
    const id = await this.run('insert', () => this.repo.insert(row), INGEST_BUSY_RETRY_ATTEMPTS)
    return id === null ? { duplicate: true } : { duplicate: false, id: String(id) }
  }
  routesWithDueEvents(now: string): Promise<string[]> {
    return this.run('routesWithDueEvents', () => this.repo.routesWithDueEvents(now))
  }
  async claimDue(routeId: string, now: string, limit: number, lease: Lease): Promise<EventRecord[]> {
    const rows = await this.run('claimDue', () =>
      this.repo.claimDue(routeId, now, limit, lease.owner, lease.until),
    )
    return rows.map(toRecord)
  }
  markDelivered(ids: string[], deliveredAt: string, bulkRequestId: string | null): Promise<void> {
    return this.run('markDelivered', () =>
      this.repo.markDelivered(numericIds(ids), deliveredAt, bulkRequestId),
    )
  }
  markFailed(ids: string[], nextAttemptAt: string, error: string): Promise<void> {
    return this.run('markFailed', () => this.repo.markFailed(numericIds(ids), nextAttemptAt, error))
  }
  markParked(ids: string[], error: string): Promise<void> {
    return this.run('markParked', () => this.repo.markParked(numericIds(ids), error))
  }
  releaseDelivering(ids: string[], nextAttemptAt: string, error: string): Promise<number> {
    return this.run('releaseDelivering', () =>
      this.repo.releaseDelivering(numericIds(ids), nextAttemptAt, error),
    )
  }
  recoverDelivering(now: string, owner?: string): Promise<number> {
    return this.run('recoverDelivering', () => this.repo.recoverDelivering(now, owner))
  }
  parkExpired(now: string, maxAgeMs: number): Promise<number> {
    return this.run('parkExpired', () => this.repo.parkExpired(now, maxAgeMs))
  }
  pruneBatch(now: string, deliveredDays: number, ledgerDays: number, limit: number) {
    return this.run('prune', () => this.repo.pruneBatch(now, deliveredDays, ledgerDays, limit))
  }

  // ── admin capability ──
  async getById(id: string): Promise<EventRecord | undefined> {
    const row = await this.run('getById', () => this.repo.getById(Number(id)))
    return row ? toRecord(row) : undefined
  }
  async list(filter: { status?: EventStatus; route?: string; limit?: number }): Promise<EventSummary[]> {
    const rows = await this.run('list', () => this.repo.list(filter))
    return rows.map(toSummary)
  }
  countByStatus(): Promise<Record<string, number>> {
    return this.run('countByStatus', () => this.repo.countByStatus())
  }
  perRouteStats(): Promise<RouteStats[]> {
    return this.run('perRouteStats', () => this.repo.perRouteStats())
  }
  replay(id: string): Promise<boolean> {
    return this.run('replay', () => this.repo.replay(Number(id)))
  }
  replayAllParked(): Promise<number> {
    return this.run('replayAllParked', () => this.repo.replayAllParked())
  }
}

export class SqliteControlStore implements ControlStore {
  private kv: KvRepo
  constructor(db: Db) {
    this.kv = new KvRepo(db)
  }
  async getKillswitch(): Promise<Killswitch> {
    return this.kv.globalKillswitch()
  }
  async setKillswitch(state: Killswitch): Promise<void> {
    this.kv.setGlobalKillswitch(state)
  }
  async isRoutePaused(routeId: string): Promise<boolean> {
    return this.kv.isRoutePaused(routeId)
  }
  async setRoutePaused(routeId: string, paused: boolean): Promise<void> {
    this.kv.setRoutePaused(routeId, paused)
  }
}

