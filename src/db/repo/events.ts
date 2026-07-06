import type { Db } from '../db.js'

export type EventStatus =
  | 'pending'
  | 'retry'
  | 'delivering'
  | 'delivered'
  | 'parked'
  | 'dropped_by_filter'

export interface EventRow {
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

export interface InsertEvent {
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

export class EventsRepo {
  constructor(private db: Db) {}

  /** Returns the new row id, or null if the idempotency key already exists (duplicate delivery). */
  insert(e: InsertEvent): number | null {
    const res = this.db
      .prepare(
        `INSERT INTO events
           (route_id, source, event_id, event_type, payload_enc, payload_iv,
            headers_json, received_at, status, next_attempt_at, idempotency_key)
         VALUES
           (@route_id, @source, @event_id, @event_type, @payload_enc, @payload_iv,
            @headers_json, @received_at, @status, @received_at, @idempotency_key)
         ON CONFLICT (idempotency_key) DO NOTHING`,
      )
      .run(e)
    return res.changes === 0 ? null : Number(res.lastInsertRowid)
  }

  /** Claim due events for a route, oldest first, and mark them 'delivering'. */
  claimDue(routeId: string, now: string, limit: number): EventRow[] {
    const claim = this.db.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM events
           WHERE route_id = ? AND status IN ('pending','retry') AND next_attempt_at <= ?
           ORDER BY id ASC LIMIT ?`,
        )
        .all(routeId, now, limit) as EventRow[]
      if (rows.length > 0) {
        const ids = rows.map((r) => r.id)
        this.db
          .prepare(
            `UPDATE events SET status = 'delivering' WHERE id IN (${ids.map(() => '?').join(',')})`,
          )
          .run(...ids)
      }
      return rows
    })
    return claim()
  }

  markDelivered(ids: number[], deliveredAt: string, bulkRequestId: string | null): void {
    if (ids.length === 0) return
    this.db
      .prepare(
        `UPDATE events SET status = 'delivered', delivered_at = ?, bulk_request_id = ?, last_error = NULL
         WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .run(deliveredAt, bulkRequestId, ...ids)
  }

  markFailed(ids: number[], nextAttemptAt: string, error: string): void {
    if (ids.length === 0) return
    this.db
      .prepare(
        `UPDATE events SET status = 'retry', attempts = attempts + 1,
           next_attempt_at = ?, last_error = ?
         WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .run(nextAttemptAt, error.slice(0, 500), ...ids)
  }

  markParked(ids: number[], error: string): void {
    if (ids.length === 0) return
    this.db
      .prepare(
        `UPDATE events SET status = 'parked', last_error = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
      )
      .run(error.slice(0, 500), ...ids)
  }

  /** Events stuck in 'delivering' after a crash are returned to 'retry' at boot. */
  recoverDelivering(now: string): number {
    return this.db
      .prepare(`UPDATE events SET status = 'retry', next_attempt_at = ? WHERE status = 'delivering'`)
      .run(now).changes
  }

  routesWithDueEvents(now: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT route_id FROM events
           WHERE status IN ('pending','retry') AND next_attempt_at <= ?`,
        )
        .all(now) as { route_id: string }[]
    ).map((r) => r.route_id)
  }

  countByStatus(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS n FROM events GROUP BY status')
      .all() as { status: string; n: number }[]
    return Object.fromEntries(rows.map((r) => [r.status, r.n]))
  }

  getById(id: number): EventRow | undefined {
    return this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as EventRow | undefined
  }

  /** Park events that have been retrying longer than maxAgeMs (never silently dropped). */
  parkExpired(now: string, maxAgeMs: number): number {
    const cutoff = new Date(Date.parse(now) - maxAgeMs).toISOString()
    return this.db
      .prepare(
        `UPDATE events SET status = 'parked', last_error = 'retry window exhausted'
         WHERE status = 'retry' AND received_at < ?`,
      )
      .run(cutoff).changes
  }
}
