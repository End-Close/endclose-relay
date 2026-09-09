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
  CONFIG_SCHEMA_VERSION,
  ENGINE_VERSION,
} from '../src/index.js'
import { FIXTURES, TEST_CONFIG_YAML } from './helpers.js'

// Routes owned by End Close instead of supplied by the host: the API key selects the
// environment, the engine fetches GET /relays/config, serves it, re-fetches with the
// ETag in the background, and announces itself with PUT /relays/instances/{id}.
// Nothing here touches the network — fetch is faked.

const settlement = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))
const DOC = parse(TEST_CONFIG_YAML) as { routes: unknown[] }

type Reply = { status: number; body?: unknown; raw?: string; etag?: string }

function fakeEndClose(initial: Reply = { status: 200, body: { environment: 'sandbox', ...DOC }, etag: '"v1"' }) {
  const configGets: Headers[] = []
  const manifests: { id: string; body: any }[] = []
  const posts: any[] = []
  let reply = initial
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const headers = new Headers(init?.headers)
    if (method === 'GET' && url.endsWith('/relays/config')) {
      configGets.push(headers)
      if (reply.status === -1) throw new TypeError('fetch failed')
      // Conditional GET: an unchanged document costs a 304.
      if (reply.status === 200 && reply.etag && headers.get('if-none-match') === reply.etag) {
        return new Response(null, { status: 304 })
      }
      const text = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body))
      return new Response(reply.status === 304 ? null : text, {
        status: reply.status,
        headers: reply.etag ? { etag: reply.etag } : {},
      })
    }
    if (method === 'PUT' && url.includes('/relays/instances/')) {
      manifests.push({ id: decodeURIComponent(url.split('/').pop()!), body: JSON.parse(String(init!.body)) })
      return new Response(null, { status: 204 })
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
  return { configGets, manifests, posts, fetchImpl, set: (r: Reply) => (reply = r) }
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
    expect(ec.configGets[0]!.get('if-none-match')).toBeNull()
    expect(config.environment).toBe('sandbox')
    expect(config.etag).toBe('"v1"')
    expect(config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
    // defaults applied on the validated routes, but the document is what End Close sent
    expect(config.routes[0]!.max_body_bytes).toBe(1024 * 1024)
    expect(config.document).toEqual({ routes: DOC.routes })
    expect(typeof config.fetchedAt).toBe('string')
  })

  it('sends If-None-Match and resolves to null on 304', async () => {
    const ec = fakeEndClose()
    const src = { apiKey: 'k', fetch: ec.fetchImpl }
    const first = await fetchRemoteConfig(src)
    expect(await fetchRemoteConfig(src, { ifNoneMatch: first.etag! })).toBeNull()
    expect(ec.configGets[1]!.get('if-none-match')).toBe('"v1"')
    ec.set({ status: 200, body: DOC, etag: '"v2"' })
    const next = await fetchRemoteConfig(src, { ifNoneMatch: first.etag! })
    expect(next?.etag).toBe('"v2"')
  })

  it.each([
    [{ status: 404, body: { error: 'not managed' } }, 'not_found', false],
    [{ status: 401, body: { error: 'bad key' } }, 'unauthorized', false],
    [{ status: 403, body: { error: 'not a relay key' } }, 'unauthorized', false],
    [{ status: 503, body: { error: 'down' } }, 'unavailable', true],
    [{ status: -1 }, 'unavailable', true],
    [{ status: 200, body: { routes: [] } }, 'invalid', false],
    [{ status: 200, body: { hello: 'world' } }, 'invalid', false],
    [{ status: 200, body: { routes: [{ id: 'x', source: 'nope' }] } }, 'invalid', false],
    [{ status: 400, body: {} }, 'invalid', false],
    // Unsolicited 304 (no If-None-Match was sent) and a non-JSON 200 are misbehaving
    // upstreams, not outages: never "unavailable", which would be retried forever.
    [{ status: 304 }, 'invalid', false],
    [{ status: 200, raw: '<html>captive portal</html>' }, 'invalid', false],
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

describe('createRelay without routes (owned by End Close)', () => {
  function makeRelay(ec: ReturnType<typeof fakeEndClose>, remoteConfig?: { refreshIntervalMs?: number; announce?: boolean }) {
    return createRelay({
      store: memoryStore(),
      secrets: { PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' },
      endclose: { apiKey: 'k', baseUrl: 'https://ec.test/v1', fetch: ec.fetchImpl },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
      dispatch: { backoffBaseMs: 1, backoffCapMs: 1 },
      instanceId: 'api-1',
      enrichments: {
        resident_name: { fn: () => 'Pat', description: 'Resident full name', output: 'string' },
        resident_unit: () => '12B',
      },
      ...(remoteConfig ? { remoteConfig } : {}),
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

  it('announces the instance manifest on the first fetch and on stop', async () => {
    const ec = fakeEndClose()
    const relay = makeRelay(ec)
    await relay.routes.all()
    await sleep(5)
    expect(ec.manifests).toHaveLength(1)
    expect(ec.manifests[0]!.id).toBe('api-1')
    expect(ec.manifests[0]!.body).toEqual({
      schema: 1,
      reason: 'boot',
      host: 'embedded',
      engine_version: ENGINE_VERSION,
      config_schema: CONFIG_SCHEMA_VERSION,
      config_source: 'remote',
      capabilities: {
        adapters: ['payabli', 'generic_hmac'],
        enrichments: {
          resident_name: { description: 'Resident full name', output: 'string' },
          resident_unit: {},
        },
      },
    })
    expect(ENGINE_VERSION).toMatch(/^\d+\.\d+\.\d+/)
    await relay.stop()
    expect(ec.manifests.map((m) => m.body.reason)).toEqual(['boot', 'shutdown'])
  })

  it('sends no manifest when announce is off or routes are local', async () => {
    const ec = fakeEndClose()
    const relay = makeRelay(ec, { announce: false })
    await relay.routes.all()
    await relay.stop()
    expect(ec.manifests).toHaveLength(0)
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

  it('refreshes with the ETag: 304 keeps the document, 200 replaces it, errors and 404 keep the last one', async () => {
    const ec = fakeEndClose()
    const relay = makeRelay(ec, { refreshIntervalMs: 20 })
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 200 })
    expect(await relay.ingest('payabli-batches', req(settlement))).toMatchObject({ status: 200 })

    // Unchanged: the refresh is a conditional GET answered 304.
    await sleep(30)
    await relay.routes.get('payabli-settlements')
    await sleep(10)
    expect(ec.configGets).toHaveLength(2)
    expect(ec.configGets[1]!.get('if-none-match')).toBe('"v1"')
    expect(await relay.ingest('payabli-batches', req(settlement))).toMatchObject({ status: 200 })

    // End Close drops the second route: a new ETag, a new document.
    ec.set({ status: 200, body: { routes: [DOC.routes[0]] }, etag: '"v2"' })
    await sleep(30)
    await relay.routes.get('payabli-settlements')
    await sleep(10)
    expect(ec.configGets).toHaveLength(3)
    expect(await relay.ingest('payabli-batches', req(settlement))).toMatchObject({ status: 404, outcome: 'unknown_route' })

    // A failed refresh keeps the last document.
    ec.set({ status: 503, body: { error: 'down' } })
    await sleep(30)
    await relay.routes.get('payabli-settlements')
    await sleep(10)
    expect(ec.configGets).toHaveLength(4)
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 200 })

    // Management switched off: nothing local to fall back to, so the last document stays.
    ec.set({ status: 404, body: { error: 'not managed' } })
    await sleep(30)
    await relay.routes.get('payabli-settlements')
    await sleep(10)
    expect(await relay.ingest('payabli-settlements', req(settlement))).toMatchObject({ status: 200 })
    // The manifest never changes, so refreshes do not re-announce it before the
    // heartbeat interval (15 min by default) has passed.
    expect(ec.manifests.map((m) => m.body.reason)).toEqual(['boot'])
  })

  it('a bounded shutdown announce never holds stop() for long', async () => {
    const ec = fakeEndClose()
    const slow: typeof fetch = async (input, init) => {
      if (String(input).includes('/relays/instances/') && JSON.parse(String(init!.body)).reason === 'shutdown') {
        await new Promise((_, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))
      }
      return ec.fetchImpl(input, init)
    }
    const relay = createRelay({
      store: memoryStore(),
      secrets: {},
      endclose: { apiKey: 'k', fetch: slow },
      encryption: 'none',
      maskingKey: 'test-masking-key-0123456789',
    })
    await relay.routes.all()
    const started = Date.now()
    await relay.stop()
    expect(Date.now() - started).toBeLessThan(3_000)
  })
})

describe('remoteRoutes (explicit provider)', () => {
  it('heartbeats on the first refresh after the heartbeat interval', async () => {
    const ec = fakeEndClose()
    const routes = remoteRoutes({ apiKey: 'k', fetch: ec.fetchImpl }, {
      refreshIntervalMs: 1,
      manifest: { instanceId: 'i', host: 'embedded', configSource: 'remote', heartbeatIntervalMs: 30 },
    })
    await routes.load()
    await routes.refresh() // too soon for a heartbeat
    await sleep(40)
    await routes.refresh()
    await sleep(5)
    expect(ec.manifests.map((m) => m.body.reason)).toEqual(['boot', 'heartbeat'])
  })

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
    expect(ec.manifests).toHaveLength(0) // no manifest without one configured
  })

  it('load() rejects when nothing has ever been fetched', async () => {
    const ec = fakeEndClose({ status: 404, body: {} })
    const routes = remoteRoutes({ apiKey: 'k', fetch: ec.fetchImpl })
    await expect(routes.load()).rejects.toBeInstanceOf(RemoteConfigError)
    await expect(routes.all()).rejects.toBeInstanceOf(StoreUnavailableError)
  })
})
