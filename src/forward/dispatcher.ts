import type { EventEmitter } from 'node:events'
import type { Db } from '../db/db.js'
import type { RelayConfig } from '../config/schema.js'
import { EventsRepo, type EventRow } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo } from '../db/repo/kv.js'
import { decrypt } from '../crypto/at-rest.js'
import type { Json } from '../mask/paths.js'
import { log } from '../log.js'
import { nextAttemptAt } from './backoff.js'
import { mapEvent, MappingError, type EndCloseRecord } from './mapper.js'
import {
  EndCloseClient,
  PermanentHttpError,
  TransientHttpError,
  type BulkResultItem,
} from './endclose-client.js'

const IN_REQUEST_RETRIES = 2
const RESULT_POLL_ATTEMPTS = 5
const RESULT_POLL_DELAY_MS = 1000

export interface DispatcherDeps {
  db: Db
  config: RelayConfig
  client: EndCloseClient
  dataKey: Buffer
  maskingKey: Buffer
  signal: EventEmitter
}

export class Dispatcher {
  private events: EventsRepo
  private routes: RoutesRepo
  private kv: KvRepo
  private running = false
  private wakeRequested = false
  private inFlight: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined

  constructor(private deps: DispatcherDeps) {
    this.events = new EventsRepo(deps.db)
    this.routes = new RoutesRepo(deps.db)
    this.kv = new KvRepo(deps.db)
  }

  start(): void {
    this.running = true
    // Events stuck mid-dispatch from a previous crash go back on the queue.
    const recovered = this.events.recoverDelivering(new Date().toISOString())
    if (recovered > 0) log.info('recovered in-flight events after restart', { count: recovered })

    this.deps.signal.on('event', () => this.wake())
    this.timer = setInterval(() => this.wake(), this.deps.config.dispatch.poll_interval_ms)
    this.wake()
  }

  /** Stop accepting new work and wait for the in-flight cycle to drain. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    await this.inFlight
  }

  private wake(): void {
    if (!this.running) return
    this.wakeRequested = true
    this.inFlight = this.inFlight.then(async () => {
      while (this.wakeRequested && this.running) {
        this.wakeRequested = false
        try {
          await this.cycle()
        } catch (err) {
          log.error('dispatch cycle failed', { error: (err as Error).message })
        }
      }
    })
  }

  private async cycle(): Promise<void> {
    if (this.kv.globalKillswitch() !== 'none') return // pause/panic: buffer, do not forward

    const now = new Date().toISOString()
    this.events.parkExpired(now, this.deps.config.dispatch.park_after_ms)

    for (const routeId of this.events.routesWithDueEvents(now)) {
      if (!this.running) return
      if (this.routes.isPaused(routeId)) continue
      const route = this.routes.get(routeId)
      if (!route) continue

      const claimed = this.events.claimDue(routeId, now, this.deps.config.dispatch.batch_max)
      if (claimed.length === 0) continue
      await this.deliverBatch(route.id, claimed)
    }
  }

  private async deliverBatch(routeId: string, claimed: EventRow[]): Promise<void> {
    const route = this.routes.get(routeId)
    if (!route) return

    // Map each event independently; unmappable events park without wedging the batch.
    const records: EndCloseRecord[] = []
    const mapped: EventRow[] = []
    for (const event of claimed) {
      try {
        const payload = JSON.parse(
          decrypt(this.deps.dataKey, event.payload_enc, event.payload_iv).toString('utf8'),
        ) as Json
        records.push(mapEvent(route, payload, event.received_at, this.deps.maskingKey).record)
        mapped.push(event)
      } catch (err) {
        if (err instanceof MappingError) {
          this.events.markParked([event.id], `mapping failed: ${err.message}`)
          log.warn('event parked: mapping failed', { route: routeId, event_id: event.event_id })
        } else {
          throw err
        }
      }
    }
    if (records.length === 0) return

    try {
      const summary = await this.postWithRetries(records)
      await this.settleResults(summary.id, mapped)
      log.info('batch forwarded', {
        route: routeId,
        events: mapped.length,
        bulk_request_id: summary.id,
      })
    } catch (err) {
      const ids = mapped.map((e) => e.id)
      if (err instanceof PermanentHttpError && (err.status === 400 || err.status === 422)) {
        this.events.markParked(ids, `${err.message}: ${err.body}`)
        log.error('batch parked: permanent rejection', { route: routeId, status: err.status })
      } else {
        // Transient network failure, 5xx, or auth problem (fixable server-side or in
        // config): schedule redelivery with backoff. attempts is per-event.
        const maxAttempts = Math.max(...mapped.map((e) => e.attempts))
        const next = nextAttemptAt(
          maxAttempts,
          this.deps.config.dispatch.backoff_base_ms,
          this.deps.config.dispatch.backoff_cap_ms,
        )
        this.events.markFailed(ids, next, (err as Error).message)
        log.warn('batch delivery failed, will retry', {
          route: routeId,
          events: ids.length,
          error: (err as Error).message,
          next_attempt_at: next,
        })
      }
    }
  }

  private async postWithRetries(records: EndCloseRecord[]) {
    let lastErr: unknown
    for (let attempt = 0; attempt <= IN_REQUEST_RETRIES; attempt++) {
      try {
        return await this.deps.client.bulkCreateRecords(records)
      } catch (err) {
        lastErr = err
        if (!(err instanceof TransientHttpError)) throw err
        await sleep(500 * (attempt + 1))
      }
    }
    throw lastErr
  }

  /**
   * Bulk processing is async server-side: poll briefly for per-row results. Rows the API
   * rejected park; everything else is delivered. If results don't settle in time, mark
   * delivered with the bulk_request_id recorded for later inspection.
   */
  private async settleResults(bulkRequestId: string, mapped: EventRow[]): Promise<void> {
    const deliveredAt = new Date().toISOString()
    for (let i = 0; i < RESULT_POLL_ATTEMPTS; i++) {
      let status
      try {
        status = await this.deps.client.getBulkRequest(bulkRequestId)
      } catch {
        break // polling is best-effort; the batch was accepted
      }
      if (status.status === 'pending' || status.status === 'processing') {
        await sleep(RESULT_POLL_DELAY_MS)
        continue
      }
      const failed = new Set(
        (status.results ?? [])
          .filter((r: BulkResultItem) => r.status === 'failed' || r.status === 'rejected')
          .map((r: BulkResultItem) => r.external_id ?? String(r.index)),
      )
      if (failed.size === 0) break
      const parked: number[] = []
      const ok: number[] = []
      mapped.forEach((event, index) => {
        const key = extResultKey(event, index)
        ;(failed.has(key.externalId) || failed.has(key.index) ? parked : ok).push(event.id)
      })
      this.events.markParked(parked, 'rejected by End Close bulk processing')
      this.events.markDelivered(ok, deliveredAt, bulkRequestId)
      return
    }
    this.events.markDelivered(
      mapped.map((e) => e.id),
      deliveredAt,
      bulkRequestId,
    )
  }
}

function extResultKey(event: EventRow, index: number): { externalId: string; index: string } {
  // Result rows may be keyed by external_id or by index depending on API version.
  const externalId = event.event_id.includes(':')
    ? event.event_id.slice(event.event_id.indexOf(':') + 1)
    : event.event_id
  return { externalId, index: String(index) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
