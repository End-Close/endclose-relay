import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import type { EventStore, EventStoreAdmin, NewEvent } from '../src/engine/store.js'

// The behavioural contract every EventStore implementation must satisfy. Run it against
// each store: `describeEventStoreContract('sqlite', () => new SqliteEventStore(db))`.

type Store = EventStore & EventStoreAdmin

const T0 = '2026-01-01T00:00:00.000Z'
const later = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const daysAgo = (days: number, from = T0) => new Date(Date.parse(from) - days * 86_400_000).toISOString()

function event(n: number, over: Partial<NewEvent> = {}): NewEvent {
  return {
    route_id: 'r1',
    source: 'payabli',
    event_id: `evt_${n}`,
    event_type: 'TransferFunded',
    payload: Buffer.from(`payload-${n}`),
    payload_iv: Buffer.from('0123456789ab'),
    headers_json: '{}',
    received_at: T0,
    status: 'pending',
    idempotency_key: `key_${n}`,
    ...over,
  }
}

export function describeEventStoreContract(
  name: string,
  factory: () => Promise<Store> | Store,
  cleanup?: (store: Store) => Promise<void> | void,
): void {
  describe(`EventStore contract: ${name}`, () => {
    let store: Store
    const lease = { owner: 'a', until: later(60_000) }

    beforeEach(async () => {
      store = await factory()
    })
    afterEach(async () => {
      await cleanup?.(store)
      await store.close?.()
    })

    it('inserts with idempotency and round-trips payload bytes', async () => {
      const r = await store.insert(event(1))
      expect(r.duplicate).toBe(false)
      expect(await store.insert(event(1))).toEqual({ duplicate: true })
      const id = (r as { id: string }).id
      expect(typeof id).toBe('string')
      const row = await store.getById(id)
      expect(row?.payload.equals(Buffer.from('payload-1'))).toBe(true)
      expect(row?.payload_iv?.equals(Buffer.from('0123456789ab'))).toBe(true)
      expect(row).toMatchObject({ status: 'pending', attempts: 0, next_attempt_at: T0, claimed_by: null })
      expect(await store.countByStatus()).toEqual({ pending: 1 })
    })

    it('stores a null iv (plain codec) as null', async () => {
      const { id } = (await store.insert(event(1, { payload_iv: null }))) as { id: string }
      expect((await store.getById(id))?.payload_iv).toBeNull()
    })

    it('claims due events oldest-first, up to the limit, with a lease', async () => {
      for (const n of [1, 2, 3]) await store.insert(event(n))
      await store.insert(event(4, { route_id: 'r2' }))
      expect((await store.routesWithDueEvents(T0)).sort()).toEqual(['r1', 'r2'])

      const first = await store.claimDue('r1', later(1), 2, lease)
      expect(first.map((e) => e.event_id)).toEqual(['evt_1', 'evt_2'])
      expect(first[0]).toMatchObject({ status: 'delivering', claimed_by: 'a', lease_until: lease.until })
      const second = await store.claimDue('r1', later(1), 10, lease)
      expect(second.map((e) => e.event_id)).toEqual(['evt_3'])
      expect(await store.claimDue('r1', later(1), 10, lease)).toEqual([])
      expect(await store.routesWithDueEvents(later(1))).toEqual(['r2'])
    })

    it('does not claim events whose next attempt is in the future or that are not pending/retry', async () => {
      const { id } = (await store.insert(event(1))) as { id: string }
      await store.markFailed([id], later(10_000), 'boom')
      expect(await store.claimDue('r1', later(5_000), 10, lease)).toEqual([])
      expect((await store.claimDue('r1', later(10_000), 10, lease)).length).toBe(1)
      await store.markParked([id], 'nope')
      expect(await store.claimDue('r1', later(20_000), 10, lease)).toEqual([])
    })

    it('never hands overlapping rows to concurrent claimers', async () => {
      for (let n = 1; n <= 20; n++) await store.insert(event(n))
      const [a, b] = await Promise.all([
        store.claimDue('r1', later(1), 10, { owner: 'a', until: later(60_000) }),
        store.claimDue('r1', later(1), 10, { owner: 'b', until: later(60_000) }),
      ])
      const ids = [...a, ...b].map((e) => e.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.length).toBe(20)
    })

    it('marks delivered / failed / parked and clears the lease', async () => {
      const ids = []
      for (const n of [1, 2, 3]) ids.push(((await store.insert(event(n))) as { id: string }).id)
      await store.claimDue('r1', later(1), 10, lease)
      await store.markDelivered([ids[0]!], later(2), 'br_1')
      await store.markFailed([ids[1]!], later(3), 'x'.repeat(600))
      await store.markParked([ids[2]!], 'rejected')
      expect(await store.getById(ids[0]!)).toMatchObject({
        status: 'delivered', delivered_at: later(2), bulk_request_id: 'br_1', last_error: null, claimed_by: null, lease_until: null,
      })
      const failed = await store.getById(ids[1]!)
      expect(failed).toMatchObject({ status: 'retry', attempts: 1, next_attempt_at: later(3), claimed_by: null })
      expect(failed?.last_error?.length).toBe(500)
      expect(await store.getById(ids[2]!)).toMatchObject({ status: 'parked', last_error: 'rejected', claimed_by: null })
    })

    it('releaseDelivering only touches rows still delivering', async () => {
      const a = ((await store.insert(event(1))) as { id: string }).id
      const b = ((await store.insert(event(2))) as { id: string }).id
      await store.claimDue('r1', later(1), 10, lease)
      await store.markDelivered([a], later(2), null)
      expect(await store.releaseDelivering([a, b], later(3), 'left over')).toBe(1)
      expect(await store.getById(a)).toMatchObject({ status: 'delivered' })
      expect(await store.getById(b)).toMatchObject({ status: 'retry', attempts: 1, last_error: 'left over' })
    })

    it('recovers expired leases, the owner\'s own leases, and legacy rows without a lease', async () => {
      for (const n of [1, 2, 3]) await store.insert(event(n))
      await store.claimDue('r1', later(1), 1, { owner: 'a', until: later(60_000) })
      await store.claimDue('r1', later(1), 1, { owner: 'b', until: later(60_000) })
      await store.claimDue('r1', later(1), 1, { owner: 'c', until: later(1_000) })
      // Another instance: only the expired lease (c) is recoverable before expiry of the rest.
      expect(await store.recoverDelivering(later(2_000), 'zzz')).toBe(1)
      // The owner reclaims its own immediately.
      expect(await store.recoverDelivering(later(2_000), 'a')).toBe(1)
      expect(await store.recoverDelivering(later(2_000), 'a')).toBe(0)
      // Everything expires eventually.
      expect(await store.recoverDelivering(later(120_000))).toBe(1)
      expect(await store.countByStatus()).toEqual({ retry: 3 })
    })

    it('parks events that have been retrying longer than the window', async () => {
      const old = ((await store.insert(event(1, { received_at: daysAgo(8) }))) as { id: string }).id
      const fresh = ((await store.insert(event(2))) as { id: string }).id
      await store.claimDue('r1', later(1), 10, lease)
      await store.markFailed([old, fresh], later(2), 'err')
      expect(await store.parkExpired(later(3), 7 * 86_400_000)).toBe(1)
      expect(await store.getById(old)).toMatchObject({ status: 'parked', last_error: 'retry window exhausted' })
      expect(await store.getById(fresh)).toMatchObject({ status: 'retry' })
    })

    it('prunes payloads first, then ledger rows, and never touches parked events', async () => {
      const delivered = ((await store.insert(event(1, { received_at: daysAgo(10) }))) as { id: string }).id
      const filtered = ((await store.insert(event(2, { received_at: daysAgo(40), status: 'dropped_by_filter' }))) as { id: string }).id
      const parked = ((await store.insert(event(3, { received_at: daysAgo(40) }))) as { id: string }).id
      const recent = ((await store.insert(event(4))) as { id: string }).id
      await store.claimDue('r1', later(1), 10, lease)
      await store.markDelivered([delivered], later(2), null)
      await store.markParked([parked], 'p')
      await store.markDelivered([recent], later(2), null)

      expect(await store.pruneBatch(T0, 7, 30, 1)).toEqual({ wiped: 1, deleted: 0 })
      expect(await store.pruneBatch(T0, 7, 30, 10)).toEqual({ wiped: 1, deleted: 0 })
      expect((await store.getById(delivered))?.payload.length).toBe(0)
      expect((await store.getById(delivered))?.payload_iv).toBeNull()
      expect(await store.pruneBatch(T0, 7, 30, 10)).toEqual({ wiped: 0, deleted: 1 })
      expect(await store.getById(filtered)).toBeUndefined()
      expect(await store.pruneBatch(T0, 7, 30, 10)).toEqual({ wiped: 0, deleted: 0 })
      expect(await store.getById(parked)).toMatchObject({ status: 'parked' })
      expect((await store.getById(recent))?.payload.length).toBeGreaterThan(0)
      // A pruned ledger row frees its idempotency key.
      expect((await store.insert(event(2))).duplicate).toBe(false)
    })

    it('lists newest-first with filters, replays parked events only, and reports per-route stats', async () => {
      const a = ((await store.insert(event(1))) as { id: string }).id
      const b = ((await store.insert(event(2, { route_id: 'r2' }))) as { id: string }).id
      await store.claimDue('r1', later(1), 10, lease)
      await store.markFailed([a], later(2), 'e')
      await store.claimDue('r1', later(3), 10, lease)
      await store.markParked([a], 'stuck')

      const all = await store.list({})
      expect(all.map((e) => e.id)).toEqual([b, a])
      expect(all[0]).not.toHaveProperty('payload')
      expect((await store.list({ status: 'parked' })).map((e) => e.id)).toEqual([a])
      expect((await store.list({ route: 'r2' })).map((e) => e.id)).toEqual([b])
      expect((await store.list({ limit: 1 })).length).toBe(1)

      expect(await store.replay(b)).toBe(false)
      expect(await store.replay(a)).toBe(true)
      expect(await store.getById(a)).toMatchObject({ status: 'retry', attempts: 0, last_error: null })
      await store.claimDue('r1', later(10), 10, lease)
      await store.markParked([a], 'again')
      expect(await store.replayAllParked()).toBe(1)

      const stats = await store.perRouteStats()
      expect(stats.find((s) => s.route_id === 'r1')).toMatchObject({ counts: { retry: 1 }, oldest_pending_at: T0 })
      expect(stats.find((s) => s.route_id === 'r2')).toMatchObject({ counts: { pending: 1 } })
    })
  })
}
