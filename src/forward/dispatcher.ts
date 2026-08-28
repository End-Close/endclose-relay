import type { EventEmitter } from 'node:events'
import type { Db } from '../db/db.js'
import type { RuntimeSettings } from '../config/runtime.js'
import { EventsRepo, type EventRow } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo } from '../db/repo/kv.js'
import { withBusyRetry } from '../db/busy.js'
import { decrypt } from '../crypto/at-rest.js'
import type { Json } from '../mask/paths.js'
import type { Metrics } from '../metrics/metrics.js'
import { log } from '../log.js'
import { jsonTopLevelKeys } from '../util/payload-shape.js'
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
const PRUNE_INTERVAL_MS = 3600_000
const PRUNE_BATCH = 50
const PRUNE_YIELD_MS = 25

export interface DispatcherDeps {
  db: Db
  settings: Pick<RuntimeSettings, 'dispatch' | 'retention'>
  client: EndCloseClient
  dataKey: Buffer
  maskingKey: Buffer
  signal: EventEmitter
  metrics: Metrics
}

export class Dispatcher {
  private events: EventsRepo
  private routes: RoutesRepo
  private kv: KvRepo
  private running = false
  private wakeRequested = false
  private needsRecover = false
  private inFlight: Promise<void> = Promise.resolve()
  private pruneWork: Promise<void> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined

  constructor(private deps: DispatcherDeps) {
    this.events = new EventsRepo(deps.db)
    this.routes = new RoutesRepo(deps.db)
    this.kv = new KvRepo(deps.db)
  }

  start(): void {
    this.running = true
    // Events stuck mid-dispatch from a previous crash go back on the queue.
    try {
      const recovered = this.events.recoverDelivering(new Date().toISOString())
      if (recovered > 0) log.info('recovered in-flight events after restart', { count: recovered })
    } catch (err) {
      this.needsRecover = true
      log.error('boot recover delivering failed', { error: (err as Error).message })
    }

    this.deps.signal.on('event', () => this.wake())
    this.timer = setInterval(() => this.wake(), this.deps.settings.dispatch.poll_interval_ms)
    this.pruneTimer = setInterval(() => this.schedulePrune(), PRUNE_INTERVAL_MS)
    this.schedulePrune()
    this.wake()
  }

  /** Stop accepting new work and wait for the in-flight cycle and prune to drain. */
  async stop(): Promise<void> {
    this.running = false
    if (this.timer) clearInterval(this.timer)
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    await this.inFlight
    await this.pruneWork
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
          const op = (err as { op?: string }).op
          log.error('dispatch cycle failed', {
            error: (err as Error).message,
            ...(op ? { op } : {}),
          })
        }
      }
    })
  }

  private async cycle(): Promise<void> {
    const now = new Date().toISOString()
    if (this.needsRecover) {
      try {
        const recovered = await this.dbOp('recoverDelivering', () =>
          this.events.recoverDelivering(now),
        )
        this.needsRecover = false
        if (recovered > 0) log.warn('recovered stuck delivering events', { count: recovered })
      } catch (err) {
        log.error('recover delivering failed', { error: (err as Error).message })
      }
    }

    if ((await this.dbOp('killswitch', () => this.kv.globalKillswitch())) !== 'none') {
      return // pause/panic: buffer, do not forward
    }

    await this.dbOp('parkExpired', () =>
      this.events.parkExpired(now, this.deps.settings.dispatch.park_after_ms),
    )

    for (const routeId of await this.dbOp('routesWithDueEvents', () =>
      this.events.routesWithDueEvents(now),
    )) {
      if (!this.running) return
      if (await this.dbOp('isPaused', () => this.routes.isPaused(routeId))) continue
      const route = await this.dbOp('routes.get', () => this.routes.get(routeId))
      if (!route) continue

      const claimed = await this.dbOp('claimDue', () =>
        this.events.claimDue(routeId, now, this.deps.settings.dispatch.batch_max),
      )
      if (claimed.length === 0) continue
      try {
        await this.deliverBatch(route.id, claimed)
      } finally {
        await this.releaseLeftover(claimed, 'left delivering after batch')
      }
    }
  }

  private async deliverBatch(routeId: string, claimed: EventRow[]): Promise<void> {
    const route = await this.dbOp('routes.get', () => this.routes.get(routeId))
    if (!route) return

    // Map each event independently; unmappable events park without wedging the batch.
    const records: EndCloseRecord[] = []
    const mapped: EventRow[] = []
    for (const event of claimed) {
      let payloadKeys: string | undefined
      let bodyBytes: number | undefined
      try {
        const plaintext = decrypt(this.deps.dataKey, event.payload_enc, event.payload_iv)
        bodyBytes = plaintext.length
        const payload = JSON.parse(plaintext.toString('utf8')) as Json
        payloadKeys = jsonTopLevelKeys(payload)
        records.push(mapEvent(route, payload, event.received_at, this.deps.maskingKey).record)
        mapped.push(event)
      } catch (err) {
        if (err instanceof MappingError) {
          await this.dbOp('markParked', () =>
            this.events.markParked([event.id], `mapping failed: ${err.message}`),
          )
          this.deps.metrics.forward(routeId, 'parked')
          log.warn('event parked: mapping failed', {
            route: routeId,
            event_id: event.event_id,
            body_bytes: bodyBytes,
            payload_keys: payloadKeys,
          })
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
        await this.dbOp('markParked', () =>
          this.events.markParked(ids, `${err.message}: ${err.body}`),
        )
        this.deps.metrics.forward(routeId, 'parked', ids.length)
        log.error('batch parked: permanent rejection', { route: routeId, status: err.status })
      } else {
        // Transient network failure, 5xx, or auth problem (fixable server-side or in
        // config): schedule redelivery with backoff. attempts is per-event.
        const maxAttempts = Math.max(...mapped.map((e) => e.attempts))
        const next = nextAttemptAt(
          maxAttempts,
          this.deps.settings.dispatch.backoff_base_ms,
          this.deps.settings.dispatch.backoff_cap_ms,
        )
        await this.dbOp('markFailed', () => this.events.markFailed(ids, next, (err as Error).message))
        this.deps.metrics.forward(routeId, 'retried', ids.length)
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
      const parked: EventRow[] = []
      const ok: EventRow[] = []
      mapped.forEach((event, index) => {
        const key = extResultKey(event, index)
        ;(failed.has(key.externalId) || failed.has(key.index) ? parked : ok).push(event)
      })
      await this.dbOp('markParked', () =>
        this.events.markParked(
          parked.map((e) => e.id),
          'rejected by End Close bulk processing',
        ),
      )
      await this.dbOp('markDelivered', () =>
        this.events.markDelivered(
          ok.map((e) => e.id),
          deliveredAt,
          bulkRequestId,
        ),
      )
      this.recordDelivered(ok, deliveredAt)
      for (const e of parked) this.deps.metrics.forward(e.route_id, 'parked')
      return
    }
    await this.dbOp('markDelivered', () =>
      this.events.markDelivered(
        mapped.map((e) => e.id),
        deliveredAt,
        bulkRequestId,
      ),
    )
    this.recordDelivered(mapped, deliveredAt)
  }

  private recordDelivered(events: EventRow[], deliveredAt: string): void {
    for (const e of events) {
      this.deps.metrics.forward(e.route_id, 'delivered')
      this.deps.metrics.observeDeliveryLag(e.received_at, deliveredAt)
    }
  }

  private schedulePrune(): void {
    this.pruneWork = this.pruneWork.then(() => this.runPrune())
  }

  private async runPrune(): Promise<void> {
    if (!this.running) return
    const { retention } = this.deps.settings
    const now = new Date().toISOString()
    let wiped = 0
    let deleted = 0
    try {
      for (;;) {
        if (!this.running) break
        const batch = await this.dbOp('prune', () =>
          this.events.pruneBatch(now, retention.delivered_days, retention.ledger_days, PRUNE_BATCH),
        )
        wiped += batch.wiped
        deleted += batch.deleted
        this.deps.metrics.pruned('wiped', batch.wiped)
        this.deps.metrics.pruned('deleted', batch.deleted)
        if (batch.wiped === 0 && batch.deleted === 0) break
        await sleep(PRUNE_YIELD_MS)
      }
      if (wiped || deleted) log.info('retention prune', { wiped, deleted })
    } catch (err) {
      // Prune must not block forwarding. lastPruneAt used to be set before prune()
      // ran, so a lock error skipped both dispatch and the next hour of retention.
      log.error('retention prune failed', { error: (err as Error).message })
    }
  }

  private async releaseLeftover(claimed: EventRow[], error: string): Promise<void> {
    const ids = claimed.map((e) => e.id)
    try {
      const n = await this.dbOp('releaseDelivering', () =>
        this.events.releaseDelivering(ids, new Date().toISOString(), error),
      )
      if (n > 0) {
        log.warn('released leftover delivering events', { count: n, error })
      }
    } catch (err) {
      this.needsRecover = true
      log.error('failed to release leftover delivering events', {
        error: (err as Error).message,
        count: ids.length,
      })
    }
  }

  private async dbOp<T>(op: string, fn: () => T): Promise<T> {
    try {
      return await withBusyRetry(op, fn)
    } catch (err) {
      ;(err as { op?: string }).op = op
      throw err
    }
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
