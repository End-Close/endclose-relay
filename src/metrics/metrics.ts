import { Counter, Gauge, Histogram, Registry } from 'prom-client'
import type { GlobalKillswitch } from '../db/repo/kv.js'

export type IngestResult =
  | 'accepted'
  | 'duplicate'
  | 'filtered'
  | 'rejected_auth'
  | 'rejected_size'
  | 'rejected_json'
  | 'panic'
export type ForwardResult = 'delivered' | 'retried' | 'parked'

export interface MetricsProviders {
  queueDepths: () => Record<string, number>
  killswitch: () => GlobalKillswitch
  dbBytes: () => number
}

const KILLSWITCH_VALUE: Record<GlobalKillswitch, number> = { none: 0, pause: 1, panic: 2 }

export class Metrics {
  readonly registry = new Registry()
  private ingestTotal: Counter
  private forwardTotal: Counter
  private deliveryLag: Histogram
  private prunedTotal: Counter

  constructor(providers: MetricsProviders) {
    this.ingestTotal = new Counter({
      name: 'relay_ingest_total',
      help: 'Webhook ingest requests by route and result',
      labelNames: ['route', 'result'],
      registers: [this.registry],
    })
    this.forwardTotal = new Counter({
      name: 'relay_forward_total',
      help: 'Events forwarded to End Close by route and result',
      labelNames: ['route', 'result'],
      registers: [this.registry],
    })
    this.deliveryLag = new Histogram({
      name: 'relay_delivery_lag_seconds',
      help: 'Seconds between webhook receipt and successful delivery to End Close',
      buckets: [0.5, 1, 2, 5, 15, 60, 300, 1800, 7200, 86400],
      registers: [this.registry],
    })
    this.prunedTotal = new Counter({
      name: 'relay_events_pruned_total',
      help: 'Events whose payloads were wiped or rows expired by retention',
      labelNames: ['kind'],
      registers: [this.registry],
    })
    new Gauge({
      name: 'relay_queue_depth',
      help: 'Buffered events by status',
      labelNames: ['status'],
      registers: [this.registry],
      collect() {
        this.reset()
        for (const [status, n] of Object.entries(providers.queueDepths())) {
          this.set({ status }, n)
        }
      },
    })
    new Gauge({
      name: 'relay_killswitch_state',
      help: 'Global killswitch: 0=none 1=pause 2=panic',
      registers: [this.registry],
      collect() {
        this.set(KILLSWITCH_VALUE[providers.killswitch()])
      },
    })
    new Gauge({
      name: 'relay_db_bytes',
      help: 'Size of the SQLite buffer database in bytes',
      registers: [this.registry],
      collect() {
        this.set(providers.dbBytes())
      },
    })
  }

  ingest(route: string, result: IngestResult): void {
    this.ingestTotal.inc({ route, result })
  }

  forward(route: string, result: ForwardResult, count = 1): void {
    this.forwardTotal.inc({ route, result }, count)
  }

  observeDeliveryLag(receivedAt: string, deliveredAt: string): void {
    const lag = (Date.parse(deliveredAt) - Date.parse(receivedAt)) / 1000
    if (Number.isFinite(lag) && lag >= 0) this.deliveryLag.observe(lag)
  }

  pruned(kind: 'wiped' | 'deleted', count: number): void {
    if (count > 0) this.prunedTotal.inc({ kind }, count)
  }
}
