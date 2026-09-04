import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import { createRelay, parseRoutes } from '../src/engine/relay.js'
import { memoryStore } from '../src/engine/memory-store.js'
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
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({
      status: 200,
      outcome: 'accepted',
    })
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
