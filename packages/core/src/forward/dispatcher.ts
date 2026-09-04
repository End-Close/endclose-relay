import type { EventEmitter } from 'node:events'
import {
  storeOp,
  type ControlStore,
  type EventRecord,
  type EventStore,
  type RouteProvider,
} from '../engine/store.js'
import type { PayloadCodec } from '../engine/codec.js'
import type { DispatchSettings, RetentionSettings } from '../engine/settings.js'
import type { RouteConfig } from '../config/schema.js'
import type { Json } from '../mask/paths.js'
import { RelayHooks } from '../engine/hooks.js'
import { noopLogger, type Logger } from '../logger.js'
import { jsonTopLevelKeys } from '../util/payload-shape.js'
import { sleep } from '../util/strings.js'
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
  store: EventStore
  control: ControlStore
  routes: RouteProvider
  dispatch: DispatchSettings
  /** null disables retention pruning. */
  retention: RetentionSettings | null
  client: EndCloseClient
  codec: PayloadCodec
  maskingKey: Buffer
  /** Lease owner recorded on claimed rows; a stable id lets a restarted instance reclaim its own. */
  instanceId: string
  signal: EventEmitter
  hooks?: RelayHooks
  logger?: Logger
}

/** What one dispatch cycle did, and what it deliberately left alone. */
export interface CycleSummary {
  delivered: number
  retried: number
  parked: number
  /** Routes that had due events when the cycle started. */
  due: string[]
  /** Due routes the cycle did not touch, and why. */
  skipped: { routeId: string; reason: 'paused' | 'unknown_route' }[]
  /** True when the global killswitch stopped the cycle before any forwarding. */
  halted: boolean
}

type Abort = () => boolean
const NEVER: Abort = () => false

export class Dispatcher {
  private log: Logger
  private hooks: RelayHooks
  private running = false
  private wakeRequested = false
  // Rows left 'delivering' by a crash are recovered on the first cycle, then periodically
  // so a long-lived instance also reclaims what a crashed peer left behind.
  private needsRecover = true
  private lastRecoverAt = 0
  private inFlight: Promise<void> = Promise.resolve()
  private pruneWork: Promise<unknown> = Promise.resolve()
  private timer: NodeJS.Timeout | undefined
  private pruneTimer: NodeJS.Timeout | undefined
  // Counters for the cycle in progress. Cycles are serialised on `inFlight`.
  private tally = { delivered: 0, retried: 0, parked: 0 }

  constructor(private deps: DispatcherDeps) {
    this.log = deps.logger ?? noopLogger
    this.hooks = deps.hooks ?? new RelayHooks()
  }

  start(): void {
    if (this.running) return
    this.running = true
    this.deps.signal.on('event', this.onSignal)
    this.timer = setInterval(() => this.wake(), this.deps.dispatch.pollIntervalMs)
    if (this.deps.retention) {
      this.pruneTimer = setInterval(() => this.schedulePrune(), PRUNE_INTERVAL_MS)
      this.schedulePrune()
    }
    this.wake()
  }

  private onSignal = () => this.wake()

  /**
   * Run exactly one dispatch cycle, serialised with the background loop if it is running.
   * Errors propagate to the caller (they are also emitted as hooks).
   */
  runOnce(): Promise<CycleSummary> {
    const run = this.inFlight.then(() => this.cycle(NEVER).catch((err) => {
      this.reportCycleError(err)
      throw err
    }))
    this.inFlight = run.then(() => {}, () => {})
    return run
  }

  /** Run retention pruning to completion, serialised with any scheduled prune. */
  pruneNow(): Promise<{ wiped: number; deleted: number }> {
    const run = this.pruneWork.then(() => this.runPrune(NEVER))
    this.pruneWork = run.then(() => {}, () => {})
    return run
  }

  /** Stop accepting new work and wait for the in-flight cycle and prune to drain. */
  async stop(): Promise<void> {
    this.running = false
    this.deps.signal.off('event', this.onSignal)
    if (this.timer) clearInterval(this.timer)
    if (this.pruneTimer) clearInterval(this.pruneTimer)
    await this.inFlight
    await this.pruneWork
  }

  private wake(): void {
    if (!this.running) return
    this.wakeRequested = true
    const stopped: Abort = () => !this.running
    this.inFlight = this.inFlight.then(async () => {
      while (this.wakeRequested && this.running) {
        this.wakeRequested = false
        try {
          await this.cycle(stopped)
        } catch (err) {
          this.reportCycleError(err)
        }
      }
    })
  }

  private reportCycleError(err: unknown): void {
    const op = storeOp(err)
    this.log.error('dispatch cycle failed', { error: (err as Error).message, ...(op ? { op } : {}) })
    this.hooks.emit('error', { kind: 'dispatch_cycle', error: err, ...(op ? { op } : {}) })
  }

  private async cycle(abort: Abort): Promise<CycleSummary> {
    const now = new Date().toISOString()
    this.tally = { delivered: 0, retried: 0, parked: 0 }
    const summary: CycleSummary = { ...this.tally, due: [], skipped: [], halted: false }

    if (this.needsRecover || Date.now() - this.lastRecoverAt >= this.deps.dispatch.recoverIntervalMs) {
      try {
        const recovered = await this.deps.store.recoverDelivering(now, this.deps.instanceId)
        this.needsRecover = false
        this.lastRecoverAt = Date.now()
        if (recovered > 0) this.log.info('recovered in-flight events', { count: recovered })
      } catch (err) {
        this.log.error('recover delivering failed', { error: (err as Error).message })
        this.hooks.emit('error', { kind: 'recover_delivering', error: err })
      }
    }

    if ((await this.deps.control.getKillswitch()) !== 'none') {
      summary.halted = true
      return summary // pause/panic: buffer, do not forward
    }

    await this.deps.store.parkExpired(now, this.deps.dispatch.parkAfterMs)

    summary.due = await this.deps.store.routesWithDueEvents(now)
    for (const routeId of summary.due) {
      if (abort()) break
      const [paused, route] = await Promise.all([
        this.deps.control.isRoutePaused(routeId),
        this.deps.routes.get(routeId),
      ])
      if (paused) {
        summary.skipped.push({ routeId, reason: 'paused' })
        continue
      }
      if (!route) {
        summary.skipped.push({ routeId, reason: 'unknown_route' })
        continue
      }

      const claimed = await this.deps.store.claimDue(routeId, now, this.deps.dispatch.batchMax, {
        owner: this.deps.instanceId,
        until: new Date(Date.now() + this.deps.dispatch.leaseMs).toISOString(),
      })
      if (claimed.length === 0) continue
      try {
        await this.deliverBatch(route, claimed)
      } finally {
        await this.releaseLeftover(claimed, 'left delivering after batch')
      }
    }
    return { ...summary, ...this.tally }
  }

  private async deliverBatch(route: RouteConfig, claimed: EventRecord[]): Promise<void> {
    const routeId = route.id
    // Map each event independently; unmappable events park without wedging the batch.
    const records: EndCloseRecord[] = []
    const mapped: EventRecord[] = []
    for (const event of claimed) {
      let payloadKeys: string | undefined
      let bodyBytes: number | undefined
      try {
        const plaintext = this.deps.codec.decode(event.payload, event.payload_iv)
        bodyBytes = plaintext.length
        const payload = JSON.parse(plaintext.toString('utf8')) as Json
        payloadKeys = jsonTopLevelKeys(payload)
        records.push(mapEvent(route, payload, event.received_at, this.deps.maskingKey).record)
        mapped.push(event)
      } catch (err) {
        if (err instanceof MappingError) {
          const reason = `mapping failed: ${err.message}`
          await this.deps.store.markParked([event.id], reason)
          this.recordParked([event], reason)
          this.log.warn('event parked: mapping failed', {
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
      this.log.info('batch forwarded', {
        route: routeId,
        events: mapped.length,
        bulk_request_id: summary.id,
      })
      this.hooks.emit('batch.forwarded', { routeId, events: mapped.length, bulkRequestId: summary.id })
    } catch (err) {
      if (err instanceof PermanentHttpError && (err.status === 400 || err.status === 422)) {
        const reason = `${err.message}: ${err.body}`
        await this.deps.store.markParked(mapped.map((e) => e.id), reason)
        this.recordParked(mapped, reason)
        this.log.error('batch parked: permanent rejection', { route: routeId, status: err.status })
        this.hooks.emit('batch.parked', { routeId, status: err.status, events: mapped.length })
      } else {
        // Transient network failure, 5xx, or auth problem (fixable server-side or in
        // config): schedule redelivery with backoff. attempts is per-event.
        const maxAttempts = Math.max(...mapped.map((e) => e.attempts))
        const next = nextAttemptAt(maxAttempts, this.deps.dispatch.backoffBaseMs, this.deps.dispatch.backoffCapMs)
        const message = (err as Error).message
        await this.deps.store.markFailed(mapped.map((e) => e.id), next, message)
        this.tally.retried += mapped.length
        this.hooks.emit('forward', { routeId, result: 'retried', count: mapped.length })
        for (const e of mapped) this.hooks.emit('settled', { id: e.id, routeId, result: 'retried', error: message })
        this.log.warn('batch delivery failed, will retry', {
          route: routeId,
          events: mapped.length,
          error: message,
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
  private async settleResults(bulkRequestId: string, mapped: EventRecord[]): Promise<void> {
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
      const parked: EventRecord[] = []
      const ok: EventRecord[] = []
      mapped.forEach((event, index) => {
        const key = extResultKey(event, index)
        ;(failed.has(key.externalId) || failed.has(key.index) ? parked : ok).push(event)
      })
      const reason = 'rejected by End Close bulk processing'
      await this.deps.store.markParked(parked.map((e) => e.id), reason)
      await this.deps.store.markDelivered(ok.map((e) => e.id), deliveredAt, bulkRequestId)
      this.recordDelivered(ok, deliveredAt)
      this.recordParked(parked, reason)
      return
    }
    await this.deps.store.markDelivered(mapped.map((e) => e.id), deliveredAt, bulkRequestId)
    this.recordDelivered(mapped, deliveredAt)
  }

  private recordDelivered(events: EventRecord[], deliveredAt: string): void {
    if (events.length === 0) return
    this.tally.delivered += events.length
    this.hooks.emit('forward', { routeId: events[0]!.route_id, result: 'delivered', count: events.length })
    for (const e of events) {
      this.hooks.emit('delivered', { routeId: e.route_id, receivedAt: e.received_at, deliveredAt })
      this.hooks.emit('settled', { id: e.id, routeId: e.route_id, result: 'delivered' })
    }
  }

  private recordParked(events: EventRecord[], reason: string): void {
    if (events.length === 0) return
    this.tally.parked += events.length
    this.hooks.emit('forward', { routeId: events[0]!.route_id, result: 'parked', count: events.length })
    for (const e of events) {
      this.hooks.emit('settled', { id: e.id, routeId: e.route_id, result: 'parked', error: reason })
    }
  }

  private schedulePrune(): void {
    const stopped: Abort = () => !this.running
    // Prune must not block forwarding: failures are logged and emitted, never propagated.
    this.pruneWork = this.pruneWork.then(() => this.runPrune(stopped)).catch(() => {})
  }

  /** Bounded batches with a yield between them so ingest and dispatch keep running. */
  private async runPrune(abort: Abort): Promise<{ wiped: number; deleted: number }> {
    const { retention } = this.deps
    if (!retention) return { wiped: 0, deleted: 0 }
    const now = new Date().toISOString()
    let wiped = 0
    let deleted = 0
    try {
      while (!abort()) {
        const batch = await this.deps.store.pruneBatch(
          now,
          retention.deliveredDays,
          retention.ledgerDays,
          PRUNE_BATCH,
        )
        wiped += batch.wiped
        deleted += batch.deleted
        this.hooks.emit('prune', { wiped: batch.wiped, deleted: batch.deleted })
        if (batch.wiped === 0 && batch.deleted === 0) break
        await sleep(PRUNE_YIELD_MS)
      }
      if (wiped || deleted) this.log.info('retention prune', { wiped, deleted })
    } catch (err) {
      this.log.error('retention prune failed', { error: (err as Error).message })
      this.hooks.emit('error', { kind: 'prune', error: err })
      throw err
    }
    return { wiped, deleted }
  }

  private async releaseLeftover(claimed: EventRecord[], error: string): Promise<void> {
    const ids = claimed.map((e) => e.id)
    try {
      const n = await this.deps.store.releaseDelivering(ids, new Date().toISOString(), error)
      if (n > 0) {
        this.log.warn('released leftover delivering events', { count: n, error })
      }
    } catch (err) {
      this.needsRecover = true
      this.log.error('failed to release leftover delivering events', {
        error: (err as Error).message,
        count: ids.length,
      })
      this.hooks.emit('error', { kind: 'recover_delivering', error: err })
    }
  }
}

function extResultKey(event: EventRecord, index: number): { externalId: string; index: string } {
  // Result rows may be keyed by external_id or by index depending on API version.
  const externalId = event.event_id.includes(':')
    ? event.event_id.slice(event.event_id.indexOf(':') + 1)
    : event.event_id
  return { externalId, index: String(index) }
}
