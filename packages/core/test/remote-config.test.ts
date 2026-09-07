import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { describe, expect, it } from 'vitest'
import {
  createRelay,
  fetchRemoteConfig,
  memoryStore,
  remoteRoutes,
  RemoteConfigError,
  StoreUnavailableError,
} from '../src/index.js'
import { FIXTURES, TEST_CONFIG_YAML } from './helpers.js'

// Routes fetched from End Close instead of supplied by the host: the API key selects the
// environment, the engine fetches GET /relays/config, serves it, and re-fetches in the
// background. Nothing here touches the network — fetch is faked.

const settlement = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))
const DOC = parse(TEST_CONFIG_YAML) as { routes: unknown[] }

type Reply = { status: number; body?: unknown }

function fakeEndClose(initial: Reply = { status: 200, body: { environment: 'sandbox', ...DOC } }) {
  const configGets: Headers[] = []
  const posts: any[] = []
  let reply = initial
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.endsWith('/relays/config')) {
      configGets.push(new Headers(init?.headers))
      if (reply.status === -1) throw new TypeError('fetch failed')
      return new Response(reply.body === undefined ? '' : JSON.stringify(reply.body), { status: reply.status })
    }
    if (method === 'POST' && url.endsWith('/records/bulk')) {
      posts.push(JSON.parse(String(init!.body)))
      return new Response(JSON.stringify({ id: 'br_1', status: 'processing' }), { status: 202 })
    }
    if (url.includes('/bulk_requests/')) {
      return new Response(JSON.stringify({ id: 'br_1', status: 'completed', results: [] }), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  }
  return { configGets, posts, fetchImpl, set: (r: Reply) => (reply = r) }
}

const req = (body: Buffer) => ({
  rawBody: body,
  headers: { authorization: 'Bearer test-webhook-secret', 'content-type': 'application/json' },
  remoteIp: '54.166.54.170',
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('fetchRemoteConfig', () => {
  it('fetches with the API key and validates the routes document', async () => {
    const ec = fakeEndClose()
    const config = await fetchRemoteConfig({ apiKey: 'k', baseUrl: 'https://ec.test/v1', fetch: ec.fetchImpl })
    expect(ec.configGets).toHaveLength(1)
    expect(ec.configGets[0]!.get('x-api-key')).toBe('k')
    expect(config.environment).toBe('sandbox')
    expect(config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
    // defaults applied on the validated routes, but the document is what End Close sent
    expect(config.routes[0]!.max_body_bytes).toBe(1024 * 1024)
    expect(config.document).toEqual({ routes: DOC.routes })
    expect(typeof config.fetchedAt).toBe('string')
  })

  it.each([
    [{ status: 404, body: { error: 'no config' } }, 'not_found', false],
    [{ status: 401, body: { error: 'bad key' } }, 'unauthorized', false],
    [{ status: 403, body: { error: 'forbidden' } }, 'unauthorized', false],
    [{ status: 503, body: { error: 'down' } }, 'unavailable', true],
    [{ status: -1 }, 'unavailable', true],
    [{ status: 200, body: { routes: [] } }, 'invalid', false],
    [{ status: 200, body: { hello: 'world' } }, 'invalid', false],
    [{ status: 200, body: { routes: [{ id: 'x', source: 'nope' }] } }, 'invalid', false],
    [{ status: 400, body: {} }, 'invalid', false],
  ] as [Reply, string, boolean][])('classifies %j as %s', async (reply, kind, retryable) => {
    const ec = fakeEndClose(reply)
    const err = await fetchRemoteConfig({ apiKey: 'k', fetch: ec.fetchImpl }).catch((e) => e)
    expect(err).toBeInstanceOf(RemoteConfigError)
    expect(err.kind).toBe(kind)
    expect(err.retryable).toBe(retryable)
  })

  it('validates enrich: references against the host-registered enrichments', async () => {
    const route = { ...(DOC.routes[0] as { map: object }) }
    route.map = { ...route.map, metadata: { resident_name: { source: 'PayorId', enrich: 'resident_name' } } }
    const ec = fakeEndClose({ status: 200, body: { routes: [route] } })
    const src = { apiKey: 'k', fetch: ec.fetchImpl }
    await expect(fetchRemoteConfig(src)).rejects.toMatchObject({ kind: 'invalid' })
    const config = await fetchRemoteConfig(src, { enrichments: { resident_name: () => 'x' } })
    expect(config.routes[0]!.map.metadata['resident_name']).toEqual({ source: 'PayorId', enrich: 'resident_name' })
  })

  it('validates host-registered adapter sources', async () => {
    const doc = { routes: [{ ...(DOC.routes[0] as object), source: 'custom' }] }
    const ec = fakeEndClose({ status: 200, body: doc })
    const src = { apiKey: 'k', fetch: ec.fetchImpl }
    await expect(fetchRemoteConfig(src)).rejects.toMatchObject({ kind: 'invalid' })
    const adapter = { verify: () => ({ ok: true as const }), extractEventId: () => 'e', extractEventType: () => null }
    const config = await fetchRemoteConfig(src, { adapters: { custom: adapter } })
    expect(config.routes[0]!.source).toBe('custom')
  })
})

describe('createRelay without routes (fetched from End Close)', () => {
  function makeRelay(ec: ReturnType<typeof fakeEndClose>, refreshIntervalMs?: number) {
    return createRelay({
      store: memoryStore(),
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', baseUrl: 'https://ec.test/v1', fetch: ec.fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
      dispatch: { backoffBaseMs: 1, backoffCapMs: 1 },
      ...(refreshIntervalMs !== undefined ? { remoteConfig: { refreshIntervalMs } } : {}),
    })
  }

  it('fetches once, then ingests and forwards on the fetched routes', async () => {
    const ec = fakeEndClose()
    const relay = makeRelay(ec)
    expect(ec.configGets).toHaveLength(0) // lazy: nothing fetched until a route is needed
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 200, outcome: 'accepted' })
    expect(await relay.ingest('nope', req(settlement))).toMatchObject({ status: 404, outcome: 'unknown_route' })
    expect(await relay.dispatchOnce()).toEqual({ delivered: 1, retried: 0, parked: 0 })
    expect(ec.posts[0].records[0]).toMatchObject({ data_stream_key: 'payabli_settlements_funded', external_id: 'trf_9f8e7d6c' })
    expect(ec.configGets).toHaveLength(1)
    expect((await relay.routes.all()).map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
  })

  it('answers 503 until End Close is reachable, without fetching per webhook', async () => {
    const ec = fakeEndClose({ status: 503, body: { error: 'down' } })
    const relay = makeRelay(ec)
    const errors: unknown[] = []
    relay.on('error', (e) => errors.push(e))
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 503, outcome: 'unavailable' })
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 503, outcome: 'unavailable' })
    expect(ec.configGets).toHaveLength(1) // the failure is held, not retried on every request
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ kind: 'ingest_persist', op: 'routes.get' })
    expect((errors[0] as { error: unknown }).error).toBeInstanceOf(StoreUnavailableError)
    // dispatch survives too (nothing to deliver; the cycle must not throw)
    expect(await relay.dispatchOnce()).toEqual({ delivered: 0, retried: 0, parked: 0 })
  })

  it('picks up a changed document after the refresh interval and survives a failed refresh', async () => {
    const ec = fakeEndClose()
    const relay = makeRelay(ec, 20)
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 200 })
    expect(await relay.ingest('payabli-batches', req(settlement))).toMatchObject({ status: 200 })

    // End Close drops the second route.
    ec.set({ status: 200, body: { routes: [DOC.routes[0]] } })
    await sleep(30)
    await relay.routes.get('payabli-settlements') // stale: serves the cache, refreshes in the background
    await sleep(10)
    expect(ec.configGets).toHaveLength(2)
    expect(await relay.ingest('payabli-batches', req(settlement))).toMatchObject({ status: 404, outcome: 'unknown_route' })

    // A failed refresh keeps the last document.
    ec.set({ status: 503, body: { error: 'down' } })
    await sleep(30)
    await relay.routes.get('payabli-settlements')
    await sleep(10)
    expect(ec.configGets).toHaveLength(3)
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 200 })
  })
})

describe('remoteRoutes (explicit provider)', () => {
  it('load() fetches once, refresh() re-fetches, and failures surface as RemoteConfigError', async () => {
    const ec = fakeEndClose()
    const routes = remoteRoutes({ apiKey: 'k', fetch: ec.fetchImpl })
    expect(routes.current()).toBeUndefined()
    const first = await routes.load()
    expect(first.environment).toBe('sandbox')
    expect(await routes.load()).toBe(first) // cached
    expect(ec.configGets).toHaveLength(1)

    ec.set({ status: 401, body: {} })
    await expect(routes.refresh()).rejects.toMatchObject({ kind: 'unauthorized' })
    expect(routes.current()).toBe(first) // the cache survives a failed refresh
    expect(await routes.get('payabli-batches')).toBeDefined()
  })

  it('load() rejects when nothing has ever been fetched', async () => {
    const ec = fakeEndClose({ status: 404, body: {} })
    const routes = remoteRoutes({ apiKey: 'k', fetch: ec.fetchImpl })
    await expect(routes.load()).rejects.toBeInstanceOf(RemoteConfigError)
    await expect(routes.all()).rejects.toBeInstanceOf(StoreUnavailableError)
  })
})
