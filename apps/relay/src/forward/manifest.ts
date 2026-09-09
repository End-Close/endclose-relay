import { buildManifest, type ConfigSource, type EndCloseClient, type InstanceManifest, type ManifestReason } from '@end-close/relay'
import { log } from '../log.js'

// The application's call-home: one instance manifest (PUT /relays/instances/{id}) at
// boot, every HEARTBEAT_INTERVAL_MS, at shutdown, after a local config apply, and when
// the engine reports an error. It says what this instance is — host kind, engine and
// routes-schema version, where its configuration comes from, the built-in adapters — and
// the `reason` is the whole message: no queue depths, no payloads, no error text or
// stacks (End Close stores unknown keys verbatim, and a stack from a webhook relay can
// carry payload fragments). Failures are logged and never affect ingest, dispatch or the
// admin plane.

export const HEARTBEAT_INTERVAL_MS = 15 * 60_000
/** At most one `error` check-in per minute; the reason carries no detail anyway. */
export const ERROR_REPORT_MIN_INTERVAL_MS = 60_000
const STOP_WAIT_MS = 1_000

export interface InstanceReporterClient {
  putRelayInstance(instanceId: string, manifest: InstanceManifest): Promise<void>
}

export interface InstanceReporterOpts {
  enabled: boolean
  client: InstanceReporterClient
  instanceId: string
  /** Read at send time: 'remote' while End Close owns the configuration. */
  configSource: () => ConfigSource
  heartbeatIntervalMs?: number
  errorMinIntervalMs?: number
}

export class InstanceReporter {
  private timer: NodeJS.Timeout | undefined
  private running = false
  private pending = new Set<Promise<void>>()
  private lastErrorAt = 0

  constructor(private opts: InstanceReporterOpts) {}

  get enabled(): boolean {
    return this.opts.enabled
  }

  /** Send `boot` now and a `heartbeat` on every interval until stopped. */
  start(): void {
    if (!this.enabled || this.running) return
    this.running = true
    this.announce('boot')
    this.schedule()
  }

  /** Send `shutdown` and wait briefly for in-flight requests. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    if (this.running) {
      this.running = false
      this.announce('shutdown')
    }
    await Promise.race([Promise.all([...this.pending]), sleep(STOP_WAIT_MS)])
  }

  /** A local config apply: End Close learns the configuration source may have changed. */
  configApplied(): void {
    this.announce('config_applied')
  }

  /** An engine error happened. Throttled; says nothing about the error itself. */
  reportError(): void {
    const now = Date.now()
    if (now - this.lastErrorAt < (this.opts.errorMinIntervalMs ?? ERROR_REPORT_MIN_INTERVAL_MS)) return
    this.lastErrorAt = now
    this.announce('error')
  }

  /** Fire-and-forget; never throws. */
  announce(reason: ManifestReason): void {
    if (!this.enabled) return
    const manifest = buildManifest({ host: 'application', configSource: this.opts.configSource() }, reason)
    const p = this.opts.client.putRelayInstance(this.opts.instanceId, manifest).catch((err: unknown) => {
      log.warn('End Close instance manifest not accepted', { reason, error: (err as Error).message })
    })
    this.pending.add(p)
    void p.finally(() => this.pending.delete(p))
  }

  private schedule(): void {
    const base = this.opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    this.timer = setTimeout(() => {
      if (!this.running) return
      this.announce('heartbeat')
      this.schedule()
    }, Math.round(base * (0.8 + Math.random() * 0.4)))
    this.timer.unref()
  }
}

export function createInstanceReporter(opts: {
  enabled: boolean
  apiKey: string
  client: EndCloseClient
  instanceId: string
  configSource: () => ConfigSource
}): InstanceReporter {
  return new InstanceReporter({
    enabled: opts.enabled && Boolean(opts.apiKey),
    client: opts.client,
    instanceId: opts.instanceId,
    configSource: opts.configSource,
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
