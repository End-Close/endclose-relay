import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { createRelay, parseRoutes } from '../src/index.js'
import { memoryStore } from '../src/index.js'
import { FIXTURES, TEST_CONFIG_YAML } from './helpers.js'

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

function makeRelay(ec = fakeEndClose()) {
  const relay = createRelay({
    routes: parseRoutes(parse(TEST_CONFIG_YAML)),
    store: memoryStore(),
    secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
    endclose: { apiKey: 'k', baseUrl: 'https://ec.test/v1', fetch: ec.fetchImpl },
    encryption: { dataKey: 'test-data-key-0123456789' },
    maskingKey: 'test-masking-key-0123456789',
    dispatch: { backoffBaseMs: 1, backoffCapMs: 1 },
    instanceId: 'sdk-test',
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
  it('accepts auth.secret as an alias of auth.secret_env', async () => {
    const { routeSchema } = await import('../src/index.js')
    const r = routeSchema.parse({
      id: 'x',
      source: 'payabli',
      auth: { mode: 'static_header', secret: 'MY_SECRET' },
      map: { data_stream_key: 'k', external_id: 'a', amount: 'b', direction: 'credit' },
    })
    expect(r.auth.secret_env).toBe('MY_SECRET')
    expect((r.auth as Record<string, unknown>)['secret']).toBeUndefined()
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
