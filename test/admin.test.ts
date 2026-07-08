import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAdminServer } from '../src/admin/server.js'
import { buildIngestServer } from '../src/ingest/server.js'
import { buildMetricsServer } from '../src/metrics/server.js'
import { EventsRepo } from '../src/db/repo/events.js'
import { KvRepo } from '../src/db/repo/kv.js'
import { getActiveConfig } from '../src/config/store.js'
import { DATA_KEY, FIXTURES, MASKING_KEY, TEST_CONFIG_YAML, setupDb } from './helpers.js'
import type { Metrics } from '../src/metrics/metrics.js'

const settlementBody = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))
const AUTH = { authorization: 'Basic ' + Buffer.from('admin:hunter2').toString('base64') }

describe('admin API', () => {
  let setup: ReturnType<typeof setupDb>
  let admin: ReturnType<typeof buildAdminServer>
  let ingest: ReturnType<typeof buildIngestServer>
  let events: EventsRepo

  beforeEach(async () => {
    setup = setupDb()
    events = new EventsRepo(setup.db)
    admin = buildAdminServer({
      db: setup.db,
      dbPath: ':memory:',
      startedAt: Date.now(),
      basicAuth: 'admin:hunter2',
      maskingKey: MASKING_KEY,
      bootConfigHash: getActiveConfig(setup.db)!.hash,
    })
    ingest = buildIngestServer({
      db: setup.db,
      dataKey: DATA_KEY,
      signal: setup.signal,
      metrics: setup.metrics,
    })
    await admin.ready()
    await ingest.ready()
  })

  afterEach(async () => {
    await admin.close()
    await ingest.close()
    setup.db.close()
  })

  const get = (url: string) => admin.inject({ method: 'GET', url, headers: AUTH })
  const post = (url: string, payload?: unknown, extraHeaders: Record<string, string> = {}) =>
    admin.inject({ method: 'POST', url, payload: payload ?? {}, headers: { ...AUTH, ...extraHeaders } })

  const postWebhook = () =>
    ingest.inject({
      method: 'POST',
      url: '/ingest/payabli-settlements',
      payload: settlementBody,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-webhook-secret',
      },
    })

  it('requires basic auth on every route', async () => {
    for (const [method, url] of [
      ['GET', '/status'],
      ['GET', '/config'],
      ['POST', '/killswitch'],
    ] as const) {
      const res = await admin.inject({ method, url })
      expect(res.statusCode, `${method} ${url}`).toBe(401)
      expect(res.headers['www-authenticate']).toContain('Basic')
    }
    const wrong = await admin.inject({
      method: 'GET',
      url: '/status',
      headers: { authorization: 'Basic ' + Buffer.from('admin:wrong').toString('base64') },
    })
    expect(wrong.statusCode).toBe(401)
    expect((await get('/status')).statusCode).toBe(200)
  })

  it('refuses cross-site mutations (CSRF) but allows same-origin and non-browser', async () => {
    const crossSite = await post('/killswitch', { state: 'pause' }, { 'sec-fetch-site': 'cross-site' })
    expect(crossSite.statusCode).toBe(403)
    const sameOrigin = await post('/killswitch', { state: 'pause' }, { 'sec-fetch-site': 'same-origin' })
    expect(sameOrigin.statusCode).toBe(200)
    const noHeader = await post('/killswitch', { state: 'none' })
    expect(noHeader.statusCode).toBe(200)
  })

  it('GET /status reports routes, queue, killswitch, config hash', async () => {
    await postWebhook()
    const res = await get('/status')
    const s = res.json()
    expect(s.config_hash).toMatch(/^sha256:/)
    expect(s.restart_pending).toBe(false)
    // boot-check surface for the UI banner: all secrets set in the test env
    expect(s.secret_envs.length).toBeGreaterThan(0)
    expect(s.secret_envs.every((e: any) => e.set)).toBe(true)
    expect(s.killswitch).toEqual({ global: 'none', routes_paused: [] })
    expect(s.queue.pending).toBe(1)
    const route = s.routes.find((r: any) => r.id === 'payabli-settlements')
    expect(route).toMatchObject({
      data_stream_key: 'payabli_settlements_funded',
      paused: false,
      counts: { pending: 1 },
    })
  })

  it('killswitch flips via API affect ingest and are audited at instance level', async () => {
    await post('/killswitch', { state: 'panic' })
    expect((await postWebhook()).statusCode).toBe(503)
    await post('/killswitch', { state: 'none' })
    expect((await postWebhook()).statusCode).toBe(200)

    const audit = (await get('/audit')).json()
    const panic = audit.find((a: any) => a.action === 'killswitch.panic')
    expect(panic.actor).toBe('admin')
    expect((await post('/killswitch', { state: 'nope' })).statusCode).toBe(400)
  })

  it('per-route pause and parked replay', async () => {
    await post('/routes/payabli-settlements/pause', { paused: true })
    expect((await get('/status')).json().killswitch.routes_paused).toEqual(['payabli-settlements'])
    expect((await post('/routes/nope/pause', { paused: true })).statusCode).toBe(404)

    await postWebhook()
    const [row] = events.list({})
    expect(row).not.toHaveProperty('payload_enc')
    events.markParked([row!.id], 'test parking')
    expect((await post(`/events/${row!.id}/replay`)).statusCode).toBe(200)
    expect(events.getById(row!.id)!.status).toBe('retry')
    expect((await post(`/events/${row!.id}/replay`)).statusCode).toBe(409)
  })

  describe('config management', () => {
    it('GET /config returns the active yaml + hash', async () => {
      const res = await get('/config')
      expect(res.statusCode).toBe(200)
      const c = res.json()
      expect(c.hash).toMatch(/^sha256:/)
      expect(c.yaml).toContain('payabli-settlements')
    })

    it('validate reports schema errors and secret env status without saving', async () => {
      const bad = (await post('/config/validate', { yaml: 'routes: []' })).json()
      expect(bad.valid).toBe(false)
      expect(bad.error).toBeTruthy()

      const good = (await post('/config/validate', { yaml: (await get('/config')).json().yaml })).json()
      expect(good.valid).toBe(true)
      expect(good.routes).toEqual(['payabli-settlements', 'payabli-batches'])
      expect(good.secret_envs.find((s: any) => s.name === 'ENDCLOSE_API_KEY').set).toBe(true)
    })

    it('POST /config saves a version, rematerializes routes live, flags restart', async () => {
      const before = (await get('/config')).json()
      const edited = (before.yaml as string).replace('id: payabli-batches', 'id: payabli-batches-v2')
      const res = await post('/config', { yaml: edited })
      expect(res.statusCode).toBe(200)
      expect(res.json().restart_pending).toBe(true) // hash differs from boot

      // route change took effect live: new route exists, old one is gone
      const status = (await get('/status')).json()
      const ids = status.routes.map((r: any) => r.id)
      expect(ids).toContain('payabli-batches-v2')
      expect(ids).not.toContain('payabli-batches')

      // versions history has both, newest first
      const versions = (await get('/config/versions')).json()
      expect(versions.length).toBe(2)
      expect(versions[0].applied_by).toBe('admin')
      const old = (await get(`/config/versions/${versions[1].id}`)).json()
      expect(old.config_yaml).toContain('id: payabli-batches')

      // invalid yaml is rejected without saving
      expect((await post('/config', { yaml: 'routes: []' })).statusCode).toBe(422)
      expect((await get('/config/versions')).json().length).toBe(2)
    })

    it('preview maps a sample against draft yaml without saving', async () => {
      const yaml = (await get('/config')).json().yaml
      const sample = JSON.parse(settlementBody.toString())
      const res = await post('/config/preview', { yaml, route: 'payabli-settlements', sample })
      expect(res.statusCode).toBe(200)
      const p = res.json()
      expect(p.record).toMatchObject({ external_id: 'trf_9f8e7d6c', amount: 376287 })
      expect(p.report.not_forwarded).toContain('Text')

      expect((await post('/config/preview', { yaml, route: 'nope', sample })).statusCode).toBe(404)
      expect(
        (await post('/config/preview', { yaml, route: 'payabli-settlements', sample: {} })).statusCode,
      ).toBe(422)
    })
  })
})

describe('config store seeding', () => {
  it('seeds only when empty; later saves are versioned', async () => {
    const { db } = setupDb() // setupDb saved version 1
    const { seedIfEmpty } = await import('../src/config/store.js')
    // DB already has config: seed is a no-op returning the active config
    const active = seedIfEmpty(db, '/nonexistent/relay.yaml')
    expect(active.config.routes).toHaveLength(2)
    db.close()
  })
})

describe('metrics server', () => {
  let setup: ReturnType<typeof setupDb>
  let metricsServer: ReturnType<typeof buildMetricsServer>
  let ingest: ReturnType<typeof buildIngestServer>

  beforeEach(async () => {
    setup = setupDb()
    ingest = buildIngestServer({
      db: setup.db,
      dataKey: DATA_KEY,
      signal: setup.signal,
      metrics: setup.metrics,
    })
    metricsServer = buildMetricsServer({
      metrics: setup.metrics,
      ready: () => true,
      basicAuth: undefined,
    })
    await ingest.ready()
    await metricsServer.ready()
  })

  afterEach(async () => {
    await metricsServer.close()
    await ingest.close()
    setup.db.close()
  })

  it('exposes ingest counters, queue depth, and killswitch state', async () => {
    await ingest.inject({
      method: 'POST',
      url: '/ingest/payabli-settlements',
      payload: settlementBody,
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-webhook-secret' },
    })
    new KvRepo(setup.db).setGlobalKillswitch('pause')

    const body = (await metricsServer.inject({ method: 'GET', url: '/metrics' })).body
    expect(body).toContain('relay_ingest_total{route="payabli-settlements",result="accepted"} 1')
    expect(body).toContain('relay_queue_depth{status="pending"} 1')
    expect(body).toContain('relay_killswitch_state 1')
    expect((await metricsServer.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
  })

  it('enforces basic auth when configured', async () => {
    const guarded = buildMetricsServer({
      metrics: setup.metrics as Metrics,
      ready: () => true,
      basicAuth: 'scraper:hunter2',
    })
    await guarded.ready()
    expect((await guarded.inject({ method: 'GET', url: '/metrics' })).statusCode).toBe(401)
    const ok = await guarded.inject({
      method: 'GET',
      url: '/metrics',
      headers: { authorization: 'Basic ' + Buffer.from('scraper:hunter2').toString('base64') },
    })
    expect(ok.statusCode).toBe(200)
    await guarded.close()
  })
})

describe('retention pruning', () => {
  it('wipes old delivered payloads, expires ledger rows, never touches parked', () => {
    const { db } = setupDb()
    const events = new EventsRepo(db)
    const insert = (id: string, receivedAt: string, status: string) => {
      db.prepare(
        `INSERT INTO events (route_id, source, event_id, event_type, payload_enc, payload_iv,
           headers_json, received_at, status, idempotency_key)
         VALUES ('r', 'payabli', ?, 'T', x'deadbeef', x'0102', '{}', ?, ?, ?)`,
      ).run(id, receivedAt, status, `k-${id}`)
    }
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString()
    insert('recent-delivered', daysAgo(1), 'delivered')
    insert('old-delivered', daysAgo(10), 'delivered')
    insert('ancient-delivered', daysAgo(40), 'delivered')
    insert('old-parked', daysAgo(40), 'parked')

    const { wiped, deleted } = events.prune(new Date().toISOString(), 7, 30)
    expect(wiped).toBe(2)
    expect(deleted).toBe(1)
    const ids = events.list({ limit: 100 }).map((r) => r.event_id)
    expect(ids).not.toContain('ancient-delivered')
    expect(ids).toContain('old-parked')
    db.close()
  })
})
