import type {
  EventRecord,
  EventStatus,
  EventStore,
  EventStoreAdmin,
  EventSummary,
  InsertResult,
  Lease,
  NewEvent,
  RouteStats,
} from './store.js'

// In-process EventStore for development, tests and single-process experiments. Not
// durable: everything is lost when the process exits. It is the reference semantics for
// the store contract (see the contract test suite).

const DUE: EventStatus[] = ['pending', 'retry']
const TERMINAL: EventStatus[] = ['delivered', 'dropped_by_filter']

export class MemoryEventStore implements EventStore, EventStoreAdmin {
  private rows = new Map<string, EventRecord>()
  private byKey = new Map<string, string>()
  private nextId = 1

  async insert(e: NewEvent): Promise<InsertResult> {
    if (this.byKey.has(e.idempotency_key)) return { duplicate: true }
    const id = String(this.nextId++)
    this.rows.set(id, {
      ...e,
      id,
      attempts: 0,
      next_attempt_at: e.received_at,
      delivered_at: null,
      bulk_request_id: null,
      last_error: null,
      claimed_by: null,
      lease_until: null,
    })
    this.byKey.set(e.idempotency_key, id)
    return { duplicate: false, id }
  }

  async routesWithDueEvents(now: string): Promise<string[]> {
    const out = new Set<string>()
    for (const r of this.rows.values()) if (this.isDue(r, now)) out.add(r.route_id)
    return [...out]
  }

  async claimDue(routeId: string, now: string, limit: number, lease: Lease): Promise<EventRecord[]> {
    const due = [...this.rows.values()]
      .filter((r) => r.route_id === routeId && this.isDue(r, now))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .slice(0, limit)
    for (const r of due) {
      r.status = 'delivering'
      r.next_attempt_at = now
      r.claimed_by = lease.owner
      r.lease_until = lease.until
    }
    return due.map((r) => ({ ...r }))
  }

  async markDelivered(ids: string[], deliveredAt: string, bulkRequestId: string | null): Promise<void> {
    for (const r of this.pick(ids)) {
      r.status = 'delivered'
      r.delivered_at = deliveredAt
      r.bulk_request_id = bulkRequestId
      r.last_error = null
      this.clearLease(r)
    }
  }

  async markFailed(ids: string[], nextAttemptAt: string, error: string): Promise<void> {
    for (const r of this.pick(ids)) {
      r.status = 'retry'
      r.attempts += 1
      r.next_attempt_at = nextAttemptAt
      r.last_error = error.slice(0, 500)
      this.clearLease(r)
    }
  }

  async markParked(ids: string[], error: string): Promise<void> {
    for (const r of this.pick(ids)) {
      r.status = 'parked'
      r.last_error = error.slice(0, 500)
      this.clearLease(r)
    }
  }

  async releaseDelivering(ids: string[], nextAttemptAt: string, error: string): Promise<number> {
    let n = 0
    for (const r of this.pick(ids)) {
      if (r.status !== 'delivering') continue
      r.status = 'retry'
      r.attempts += 1
      r.next_attempt_at = nextAttemptAt
      r.last_error = error.slice(0, 500)
      this.clearLease(r)
      n++
    }
    return n
  }

  async recoverDelivering(now: string, owner = ''): Promise<number> {
    let n = 0
    for (const r of this.rows.values()) {
      if (r.status !== 'delivering') continue
      if (r.lease_until === null || r.lease_until < now || r.claimed_by === owner) {
        r.status = 'retry'
        r.next_attempt_at = now
        this.clearLease(r)
        n++
      }
    }
    return n
  }

  async parkExpired(now: string, maxAgeMs: number): Promise<number> {
    const cutoff = new Date(Date.parse(now) - maxAgeMs).toISOString()
    let n = 0
    for (const r of this.rows.values()) {
      if (r.status === 'retry' && r.received_at < cutoff) {
        r.status = 'parked'
        r.last_error = 'retry window exhausted'
        n++
      }
    }
    return n
  }

  async pruneBatch(now: string, deliveredDays: number, ledgerDays: number, limit: number) {
    const wipeCutoff = new Date(Date.parse(now) - deliveredDays * 86_400_000).toISOString()
    const deleteCutoff = new Date(Date.parse(now) - ledgerDays * 86_400_000).toISOString()
    const terminal = [...this.rows.values()].filter((r) => TERMINAL.includes(r.status))
    const toWipe = terminal.filter((r) => r.received_at < wipeCutoff && r.payload.length > 0).slice(0, limit)
    if (toWipe.length > 0) {
      for (const r of toWipe) {
        r.payload = Buffer.alloc(0)
        r.payload_iv = null
        r.headers_json = '{}'
      }
      return { wiped: toWipe.length, deleted: 0 }
    }
    const toDelete = terminal.filter((r) => r.received_at < deleteCutoff).slice(0, limit)
    for (const r of toDelete) {
      this.rows.delete(r.id)
      this.byKey.delete(r.idempotency_key)
    }
    return { wiped: 0, deleted: toDelete.length }
  }

  // ── admin ──
  async getById(id: string): Promise<EventRecord | undefined> {
    const r = this.rows.get(id)
    return r ? { ...r } : undefined
  }

  async list(filter: { status?: EventStatus; route?: string; limit?: number }): Promise<EventSummary[]> {
    return [...this.rows.values()]
      .filter((r) => (!filter.status || r.status === filter.status) && (!filter.route || r.route_id === filter.route))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, filter.limit ?? 50)
      .map(({ payload: _p, payload_iv: _iv, headers_json: _h, idempotency_key: _k, claimed_by: _c, lease_until: _l, ...rest }) => rest)
  }

  async countByStatus(): Promise<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const r of this.rows.values()) out[r.status] = (out[r.status] ?? 0) + 1
    return out
  }

  async perRouteStats(): Promise<RouteStats[]> {
    const byRoute = new Map<string, RouteStats>()
    for (const r of this.rows.values()) {
      const s =
        byRoute.get(r.route_id) ??
        ({ route_id: r.route_id, counts: {}, last_delivered_at: null, oldest_pending_at: null } as RouteStats)
      s.counts[r.status] = (s.counts[r.status] ?? 0) + 1
      if (r.delivered_at && (!s.last_delivered_at || r.delivered_at > s.last_delivered_at)) {
        s.last_delivered_at = r.delivered_at
      }
      if (DUE.includes(r.status) && (!s.oldest_pending_at || r.received_at < s.oldest_pending_at)) {
        s.oldest_pending_at = r.received_at
      }
      byRoute.set(r.route_id, s)
    }
    return [...byRoute.values()]
  }

  async replay(id: string): Promise<boolean> {
    const r = this.rows.get(id)
    if (!r || r.status !== 'parked') return false
    this.requeue(r)
    return true
  }

  async replayAllParked(): Promise<number> {
    let n = 0
    for (const r of this.rows.values()) {
      if (r.status !== 'parked') continue
      this.requeue(r)
      n++
    }
    return n
  }

  private requeue(r: EventRecord): void {
    r.status = 'retry'
    r.attempts = 0
    r.next_attempt_at = new Date().toISOString()
    r.last_error = null
  }

  private isDue(r: EventRecord, now: string): boolean {
    return DUE.includes(r.status) && r.next_attempt_at !== null && r.next_attempt_at <= now
  }

  private pick(ids: string[]): EventRecord[] {
    return ids.map((id) => this.rows.get(id)).filter((r): r is EventRecord => r !== undefined)
  }

  private clearLease(r: EventRecord): void {
    r.claimed_by = null
    r.lease_until = null
  }
}

export function memoryStore(): MemoryEventStore {
  return new MemoryEventStore()
}
