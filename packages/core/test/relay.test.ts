import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  createRelay,
  parseRoutes,
  memoryStore,
  StoreUnavailableError,
  MemoryControlStore,
  EnrichmentError,
  type Enrichment,
  type Json,
  type RelayOptions,
  type RouteConfig,
} from '../src/index.js'
import { FIXTURES, TEST_CONFIG_YAML, TRANSACTION_ROUTES_YAML } from './helpers.js'

// The SDK path end to end: no HTTP server, no SQLite, no process environment. A host
// calls relay.ingest() with raw request parts and relay.dispatchOnce() from a scheduler.

const settlement = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))

function fakeEndClose() {
  const posts: { headers: Headers; body: any }[] = []
  let failNext = 0
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    if (init?.method === 'POST' && url.endsWith('/records/bulk')) {
      if (failNext > 0) {
        failNext--
        return new Response('{"error":"down"}', { status: 503 })
      }
      posts.push({ headers: new Headers(init.headers), body: JSON.parse(String(init.body)) })
      return new Response(JSON.stringify({ id: 'br_1', status: 'processing' }), { status: 202 })
    }
    if (url.includes('/bulk_requests/')) {
      return new Response(JSON.stringify({ id: 'br_1', status: 'completed', results: [] }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { posts, fetchImpl, fail: (n: number) => (failNext = n) }
}

function makeRelay(ec = fakeEndClose(), extra: Partial<RelayOptions> = {}) {
  const relay = createRelay({
    routes: parseRoutes(parse(TEST_CONFIG_YAML)),
    store: memoryStore(),
    secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
    endclose: { apiKey: 'k', baseUrl: 'https://ec.test/v1', fetch: ec.fetchImpl },
    encryption: { dataKey: 'test-data-key-0123456789' },
    maskingKey: 'test-masking-key-0123456789',
    instanceId: 'sdk-test',
    ...extra,
    dispatch: { backoffBaseMs: 1, backoffCapMs: 1, ...extra.dispatch },
  })
  return { relay, ec }
}

const req = (body: Buffer, auth = 'Bearer test-webhook-secret') => ({
  rawBody: body,
  headers: { authorization: auth, 'content-type': 'application/json' },
  remoteIp: '54.166.54.170',
})

describe('createRelay (embedded engine)', () => {
  it('ingests, deduplicates, and forwards mapped records on dispatchOnce', async () => {
    const { relay, ec } = makeRelay()
    const accepted = await relay.ingest('payabli-settlements', req(settlement))
    expect(accepted).toMatchObject({ status: 200, outcome: 'accepted' })
    expect(typeof accepted.id).toBe('string')
    const settled: unknown[] = []
    relay.on('settled', (e) => settled.push(e))
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({
      status: 200,
      outcome: 'duplicate',
    })
    expect(await relay.ingest('payabli-settlements', req(settlement, 'Bearer wrong'))).toMatchObject({
      status: 401,
      outcome: 'rejected_auth',
    })
    expect(await relay.ingest('nope', req(settlement))).toMatchObject({ status: 404, outcome: 'unknown_route' })

    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
    expect(settled).toEqual([{ id: accepted.id, routeId: 'payabli-settlements', result: 'delivered' }])
    expect(ec.posts.length).toBe(1)
    expect(ec.posts[0]!.headers.get('x-api-key')).toBe('k')
    expect(ec.posts[0]!.body.records[0]).toMatchObject({
      data_stream_key: 'payabli_settlements_funded',
      external_id: 'trf_9f8e7d6c',
      amount: 376287,
      direction: 'credit',
      date: '2026-07-03',
      metadata: { batch_id: '87', paypoint: 'Acme Field Services' },
    })
    // Nothing unmapped leaks.
    expect(JSON.stringify(ec.posts[0]!.body)).not.toContain('Contact us')
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 0, parked: 0 })
  })

  it('retries transient failures with backoff and honours pause', async () => {
    const { relay, ec } = makeRelay()
    ec.fail(3) // exhausts the in-request retries and leaves the batch failed
    await relay.ingest('payabli-settlements', req(settlement))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 1, parked: 0 })

    await relay.control.setKillswitch('pause')
    await new Promise((r) => setTimeout(r, 5))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 0, parked: 0 })
    await relay.control.setKillswitch('none')
    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
  })

  it('flush drains through transient failures and reports what is left', async () => {
    const { relay, ec } = makeRelay()
    ec.fail(3) // the first batch exhausts in-request retries and is scheduled for backoff
    const { id } = await relay.ingest('payabli-settlements', req(settlement))
    const settled: { id: string; result: string }[] = []
    relay.on('settled', (e) => settled.push({ id: e.id, result: e.result }))

    const flushed = await relay.flush({ timeoutMs: 10_000 })
    expect(flushed).toMatchObject({ delivered: 1, retried: 1, parked: 0, drained: true })
    expect(flushed.reason).toBeUndefined()
    expect(settled).toEqual([
      { id, result: 'retried' },
      { id, result: 'delivered' },
    ])
    expect(await relay.flush()).toEqual({ delivered: 0, retried: 0, parked: 0, drained: true })
  })

  it('flush stops early when forwarding is paused or the deadline passes', async () => {
    const { relay, ec } = makeRelay()
    await relay.ingest('payabli-settlements', req(settlement))
    await relay.control.setKillswitch('pause')
    expect(await relay.flush()).toMatchObject({ delivered: 0, drained: false, reason: 'paused' })
    await relay.control.setKillswitch('none')

    ec.fail(1000) // End Close stays down for the whole window
    const t = Date.now()
    const out = await relay.flush({ timeoutMs: 100 })
    expect(out).toMatchObject({ delivered: 0, drained: false, reason: 'timeout' })
    expect(out.retried).toBeGreaterThan(0)
    expect(Date.now() - t).toBeLessThan(5_000)
  })

  it('a running instance recovers a crashed peer\'s expired lease on a later cycle', async () => {
    const ec = fakeEndClose()
    const store = memoryStore()
    const relay = createRelay({
      routes: parseRoutes(parse(TEST_CONFIG_YAML)),
      store,
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', fetch: ec.fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
      dispatch: { recoverIntervalMs: 1 },
      instanceId: 'b',
    })
    await relay.dispatchOnce() // first cycle: nothing to recover, clock starts
    const { id } = await relay.ingest('payabli-settlements', req(settlement))
    // Peer 'a' claims the row and dies; its lease expired a second ago.
    const now = new Date().toISOString()
    await store.claimDue('payabli-settlements', now, 10, { owner: 'a', until: new Date(Date.now() - 1000).toISOString() })
    expect((await store.getById(id!))?.status).toBe('delivering')
    await new Promise((r) => setTimeout(r, 5))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
  })

  it('flush keeps waiting for another route\'s backoff instead of reporting "paused"', async () => {
    const { relay, ec } = makeRelay()
    // Settlements: paused with a pending event. Batches: one event that just failed and
    // is in backoff. Flush must deliver the batches event, then report the paused rest.
    await relay.ingest('payabli-settlements', req(settlement))
    await relay.control.setRoutePaused('payabli-settlements', true)
    ec.fail(3)
    await relay.ingest('payabli-batches', req(readFileSync(join(FIXTURES, 'payabli-batch-paid.json'))))
    const out = await relay.flush({ timeoutMs: 10_000 })
    expect(out).toMatchObject({ delivered: 1, retried: 1, drained: false, reason: 'paused' })
    expect(ec.posts.length).toBe(1)
  })

  it('a periodic sweep never steals a live lease held under its own id', async () => {
    const store = memoryStore()
    const relay = createRelay({
      routes: parseRoutes(parse(TEST_CONFIG_YAML)),
      store,
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', fetch: fakeEndClose().fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
      dispatch: { recoverIntervalMs: 1 },
      instanceId: 'shared-id',
    })
    await relay.dispatchOnce() // boot reclaim done
    const { id } = await relay.ingest('payabli-settlements', req(settlement))
    // Another process using the same id has this row in flight with a live lease.
    await store.claimDue('payabli-settlements', new Date().toISOString(), 10, { owner: 'shared-id', until: new Date(Date.now() + 60_000).toISOString() })
    await new Promise((r) => setTimeout(r, 5))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 0, parked: 0 })
    expect((await store.getById(id!))?.status).toBe('delivering')
  })

  it('a store failure anywhere in ingest is classified, never thrown', async () => {
    const control = new MemoryControlStore()
    control.getKillswitch = async () => { throw new StoreUnavailableError('database is locked', 'killswitch') }
    const relay = createRelay({
      routes: parseRoutes(parse(TEST_CONFIG_YAML)),
      store: memoryStore(),
      control,
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', fetch: fakeEndClose().fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
    })
    const errors: unknown[] = []
    relay.on('error', (e) => errors.push(e.kind))
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 503, outcome: 'unavailable' })
    expect(errors).toEqual(['ingest_persist'])
  })

  it('flush returns "unroutable" instead of spinning when due events have no route', async () => {
    const ec = fakeEndClose()
    const known = new Map(parseRoutes(parse(TEST_CONFIG_YAML)).map((r) => [r.id, r]))
    const relay = createRelay({
      routes: { get: async (id) => known.get(id), all: async () => [...known.values()] },
      store: memoryStore(),
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', fetch: ec.fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
    })
    await relay.ingest('payabli-settlements', req(settlement))
    known.delete('payabli-settlements')
    const t = Date.now()
    expect(await relay.flush({ timeoutMs: 10_000 })).toMatchObject({ drained: false, reason: 'unroutable' })
    expect(Date.now() - t).toBeLessThan(2_000)
    // A detached reference works too.
    const { flush } = relay
    expect(await flush({ timeoutMs: 100 })).toMatchObject({ reason: 'unroutable' })
  })

  it('exposes preview and audited payload reads without sending anything', async () => {
    const { relay, ec } = makeRelay()
    const route = parseRoutes(parse(TEST_CONFIG_YAML))[0]!
    const { record, report } = relay.preview(route, JSON.parse(settlement.toString()))
    expect(record.external_id).toBe('trf_9f8e7d6c')
    expect(report.not_forwarded).toContain('ContactUs')

    await relay.ingest('payabli-settlements', req(settlement))
    const [row] = await (relay.store as any).list({})
    expect((await relay.readPayload(row.id))?.equals(settlement)).toBe(true)
    expect(ec.posts.length).toBe(0)
  })

  it('plain encryption stores bytes as-is; the store is still opaque to the engine', async () => {
    const ec = fakeEndClose()
    const store = memoryStore()
    const relay = createRelay({
      routes: parseRoutes(parse(TEST_CONFIG_YAML)),
      store,
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', fetch: ec.fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
    })
    await relay.ingest('payabli-settlements', req(settlement))
    const [row] = await store.list({})
    expect((await store.getById(row!.id))?.payload.equals(settlement)).toBe(true)
    expect((await store.getById(row!.id))?.payload_iv).toBeNull()
  })
})

describe('route schema policy', () => {
  it('only accepts secret references (secret_env), never a value-shaped key', async () => {
    const { routeSchema, parseRoutes } = await import('../src/index.js')
    const map = { data_stream_key: 'k', external_id: 'a', amount: 'b', direction: 'credit' }
    expect(() =>
      routeSchema.parse({ id: 'x', source: 'payabli', auth: { mode: 'static_header', secret: 'whsec_value' }, map }),
    ).toThrow()
    expect(() =>
      parseRoutes({ routes: [{ id: 'x', source: 'payabli_', auth: { mode: 'static_header', secret_env: 'S' }, map }] }),
    ).toThrow(/no adapter for source "payabli_"/)
    expect(
      parseRoutes({ routes: [{ id: 'x', source: 'acme', auth: { mode: 'static_header', secret_env: 'S' }, map }] }, {
        adapters: { acme: (await import('../src/index.js')).payabliAdapter },
      })[0]!.source,
    ).toBe('acme')
  })

  it('rejects static routes whose source has no adapter, and accepts host-registered ones', async () => {
    const { createRelay, memoryStore, payabliAdapter } = await import('../src/index.js')
    const base = {
      store: memoryStore(),
      secrets: {},
      endclose: { apiKey: 'k' },
      encryption: 'none' as const,
      maskingKey: 'test-masking-key-0123456789',
    }
    const route = {
      id: 'x',
      source: 'acme',
      auth: { mode: 'static_header' as const, header: 'authorization', secret_env: 'S', allowed_ips: [] },
      map: { data_stream_key: 'k', external_id: 'a', amount: 'b', direction: 'credit' as const, metadata: {} },
      max_body_bytes: 1024,
    }
    expect(() => createRelay({ ...base, routes: [route] })).toThrow(/no adapter for source "acme"/)
    expect(() => createRelay({ ...base, routes: [route], adapters: { acme: { ...payabliAdapter, name: 'acme' } } })).not.toThrow()
  })
})

describe('enrichments (host functions named from the map)', () => {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, 'payabli-transaction.json'), 'utf8')) as Record<string, Json>
  /** The transaction fixture with its own ids, serialised for ingest. */
  const txn = (id: string, payor = `payor_${id}`) =>
    req(Buffer.from(JSON.stringify({ ...fixture, TransactionId: id, PayorId: payor })))
  const txnRoutes = (enrichments: Record<string, Enrichment>, edit: (r: RouteConfig) => RouteConfig = (r) => r) =>
    parseRoutes(parse(TRANSACTION_ROUTES_YAML), { enrichments }).map(edit)
  const withEnrichments = (enrichments: Record<string, Enrichment>, extra: Partial<RelayOptions> = {}, edit?: (r: RouteConfig) => RouteConfig) =>
    makeRelay(fakeEndClose(), { routes: txnRoutes(enrichments, edit), enrichments, ...extra })
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  it('fills the enriched field from the source value and reports names, never values', async () => {
    const seen: unknown[] = []
    const { relay, ec } = withEnrichments({
      resident_name: (payorId, ctx) => {
        seen.push({ payorId, field: ctx.field, routeId: ctx.routeId, eventType: ctx.eventType, hasPayload: ctx.payload !== undefined })
        return payorId === 'payor_a' ? 'Pat Example' : undefined
      },
    })
    const hookEvents: unknown[] = []
    for (const name of ['enrich', 'settled', 'forward', 'delivered', 'batch.forwarded'] as const) {
      relay.on(name, (e) => hookEvents.push({ name, ...e }))
    }
    const a = await relay.ingest('payabli-transactions', txn('a'))
    const b = await relay.ingest('payabli-transactions', txn('b'))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 2, retried: 0, parked: 0 })

    expect(seen).toEqual([
      { payorId: 'payor_a', field: 'metadata.resident_name', routeId: 'payabli-transactions', eventType: 'ApprovedPayment', hasPayload: true },
      { payorId: 'payor_b', field: 'metadata.resident_name', routeId: 'payabli-transactions', eventType: 'ApprovedPayment', hasPayload: true },
    ])
    const records = ec.posts[0]!.body.records
    expect(records[0]).toMatchObject({ external_id: 'a', metadata: { paypoint: 'Acme Field Services', resident_name: 'Pat Example' } })
    expect(records[1].metadata).toEqual({ paypoint: 'Acme Field Services' }) // undefined → omitted, still sent
    expect(hookEvents).toContainEqual({ name: 'enrich', routeId: 'payabli-transactions', id: a.id, field: 'metadata.resident_name', enrichment: 'resident_name', result: 'applied' })
    expect(hookEvents).toContainEqual({ name: 'enrich', routeId: 'payabli-transactions', id: b.id, field: 'metadata.resident_name', enrichment: 'resident_name', result: 'omitted' })
    expect(JSON.stringify(hookEvents)).not.toContain('Pat Example')
    expect(JSON.stringify(hookEvents)).not.toContain('payor_')
  })

  it('a throwing enrichment retries only that event; the rest of the batch ships', async () => {
    let dbDown = true
    const { relay, ec } = withEnrichments({
      resident_name: async (payorId) => {
        if (dbDown && payorId === 'payor_b') throw new Error('residents db unavailable')
        return 'Resident ' + String(payorId)
      },
    })
    const settled: unknown[] = []
    relay.on('settled', (e) => settled.push(e))
    await relay.ingest('payabli-transactions', txn('a'))
    const b = await relay.ingest('payabli-transactions', txn('b'))

    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 1, parked: 0 })
    expect(ec.posts).toHaveLength(1)
    expect(ec.posts[0]!.body.records.map((r: any) => r.external_id)).toEqual(['a'])
    expect(settled).toContainEqual({ id: b.id, routeId: 'payabli-transactions', result: 'retried', error: expect.stringMatching(/^enrichment failed: metadata.resident_name \(resident_name\): residents db unavailable$/) })
    const row = await relay.store.getById(b.id!)
    expect(row).toMatchObject({ status: 'retry', attempts: 1 })
    expect(row!.last_error).toMatch(/residents db unavailable/)

    dbDown = false
    await sleep(5)
    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
    expect(ec.posts[1]!.body.records[0]).toMatchObject({ external_id: 'b', metadata: { resident_name: 'Resident payor_b' } })
  })

  it('a slow enrichment is bounded by enrichTimeoutMs and retried', async () => {
    const { relay } = withEnrichments({ resident_name: () => new Promise(() => {}) }, { dispatch: { enrichTimeoutMs: 20 } })
    const settled: any[] = []
    relay.on('enrich', (e) => settled.push(e))
    await relay.ingest('payabli-transactions', txn('a'))
    const t = Date.now()
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 1, parked: 0 })
    expect(Date.now() - t).toBeLessThan(2000)
    expect(settled[0]).toMatchObject({ result: 'failed', error: 'resident_name: timed out after 20 ms' })
  })

  it('parks, never retries, when the host says so or returns something unforwardable', async () => {
    const cases: { name: string; enrichment: Enrichment; reason: RegExp; edit?: (r: RouteConfig) => RouteConfig }[] = [
      { name: 'EnrichmentError', enrichment: () => { throw new EnrichmentError('no such resident') }, reason: /^enrichment failed: metadata.resident_name \(resident_name\): no such resident$/ },
      { name: 'non-JSON', enrichment: () => (() => 1) as unknown as Json, reason: /is not JSON/ },
      { name: 'sensitive nested key', enrichment: () => ({ ssn: '1' }), reason: /metadata.resident_name.ssn" matches the hard denylist/ },
      {
        name: 'non-string description',
        enrichment: () => ({ a: 1 }),
        reason: /description \(resident_name\): enriched description must be a string/,
        edit: (r) => ({ ...r, map: { ...r.map, metadata: { paypoint: 'Paypoint' }, description: { source: 'PayorId', enrich: 'resident_name' } } }),
      },
    ]
    for (const c of cases) {
      const { relay, ec } = withEnrichments({ resident_name: c.enrichment }, {}, c.edit)
      const enrich: any[] = []
      relay.on('enrich', (e) => enrich.push(e))
      const { id } = await relay.ingest('payabli-transactions', txn('a'))
      expect(await relay.dispatchOnce(), c.name).toEqual({ delivered: 0, retried: 0, parked: 1 })
      expect((await relay.store.getById(id!))!.last_error, c.name).toMatch(c.reason)
      expect(enrich[0].result, c.name).toBe('rejected')
      expect(ec.posts, c.name).toHaveLength(0)
    }
  })

  it('a route from a provider that names an unregistered enrichment parks its events', async () => {
    const ec = fakeEndClose()
    const route = txnRoutes({ resident_name: () => 'x' })[0]!
    const relay = createRelay({
      routes: { get: async (id) => (id === route.id ? route : undefined), all: async () => [route] },
      store: memoryStore(),
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', fetch: ec.fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
      // no enrichments registered
    })
    const { id } = await relay.ingest('payabli-transactions', txn('a'))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 0, parked: 1 })
    expect((await relay.store.getById(id!))!.last_error).toMatch(/references unknown enrichment "resident_name"/)
  })

  it('static routes naming an unregistered enrichment are rejected at construction', () => {
    const routes = txnRoutes({ resident_name: () => 'x' })
    expect(() => makeRelay(fakeEndClose(), { routes })).toThrow(/unknown enrichment "resident_name"/)
    expect(() => makeRelay(fakeEndClose(), { routes, enrichments: { resident_name: () => 'x' } })).not.toThrow()
  })

  it('enriched strings pass the hard denylist, and routes without enrich emit no enrich events', async () => {
    const { relay, ec } = withEnrichments({ resident_name: () => 'card 4111 1111 1111 1111' })
    const enrich: unknown[] = []
    relay.on('enrich', (e) => enrich.push(e))
    await relay.ingest('payabli-transactions', txn('a'))
    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
    expect(ec.posts[0]!.body.records[0].metadata.resident_name).toBe('card [REDACTED]')
    expect(enrich).toHaveLength(1)

    const plain = makeRelay()
    plain.relay.on('enrich', (e) => enrich.push(e))
    await plain.relay.ingest('payabli-settlements', req(settlement))
    expect(await plain.relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
    expect(enrich).toHaveLength(1)
  })

  it('preview lists enriched fields as pending instead of running the host function', () => {
    let calls = 0
    const { relay } = withEnrichments({ resident_name: () => { calls++; return 'x' } })
    const route = txnRoutes({ resident_name: () => 'x' })[0]!
    const { record, report, pending } = relay.preview(route, fixture)
    expect(calls).toBe(0)
    expect(record.metadata).toEqual({ paypoint: 'Acme Field Services' })
    expect(report.enriched).toEqual(['metadata.resident_name'])
    expect(pending).toHaveLength(1)
  })
})
