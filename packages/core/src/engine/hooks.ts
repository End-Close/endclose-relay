// Typed, metadata-only events the engine emits. Hosts subscribe to drive metrics,
// telemetry, or their own observability; the engine itself depends on none of them.
// Payloads carry route ids, counts, timestamps and error kinds — never webhook data.

export type IngestOutcome =
  | 'accepted'
  | 'duplicate'
  | 'filtered'
  | 'rejected_auth'
  | 'rejected_size'
  | 'rejected_json'
  | 'panic'
export type ForwardResult = 'delivered' | 'retried' | 'parked'

export type EngineErrorKind = 'dispatch_cycle' | 'ingest_persist' | 'prune' | 'recover_delivering'

export interface RelayEvents {
  /** Every ingest request that reached a known route, by outcome. */
  ingest: { routeId: string; outcome: IngestOutcome; eventType: string | null; bodyBytes: number }
  /** A new event row was persisted (not emitted for duplicates). */
  stored: { routeId: string; id: string; filtered: boolean }
  /** Per-event forwarding results. */
  forward: { routeId: string; result: ForwardResult; count: number }
  /** One event confirmed delivered; carries the timestamps for lag measurement. */
  delivered: { routeId: string; receivedAt: string; deliveredAt: string }
  'batch.forwarded': { routeId: string; events: number; bulkRequestId: string }
  /** A whole batch was permanently rejected by End Close. */
  'batch.parked': { routeId: string; status: number; events: number }
  prune: { wiped: number; deleted: number }
  /** An operational failure inside the engine (already logged). */
  error: { kind: EngineErrorKind; error: unknown; op?: string; routeId?: string }
}

export type RelayEventName = keyof RelayEvents
export type RelayHandler<E extends RelayEventName> = (payload: RelayEvents[E]) => void

export class RelayHooks {
  // Internally untyped; the public on/emit signatures enforce payload types.
  private handlers = new Map<RelayEventName, Set<(payload: unknown) => void>>()

  /** Subscribe; returns an unsubscribe function. */
  on<E extends RelayEventName>(name: E, handler: RelayHandler<E>): () => void {
    let set = this.handlers.get(name)
    if (!set) {
      set = new Set()
      this.handlers.set(name, set)
    }
    const h = handler as (payload: unknown) => void
    set.add(h)
    return () => set.delete(h)
  }

  /** Handlers must not throw; a throwing handler is isolated so it cannot break the engine. */
  emit<E extends RelayEventName>(name: E, payload: RelayEvents[E]): void {
    const set = this.handlers.get(name)
    if (!set) return
    for (const h of set) {
      try {
        h(payload)
      } catch {
        // observers never affect ingest or dispatch
      }
    }
  }
}
