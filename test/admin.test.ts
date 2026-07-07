import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAdminServer } from '../src/admin/server.js'
import { buildIngestServer } from '../src/ingest/server.js'
import { buildMetricsServer } from '../src/metrics/server.js'
import { EventsRepo } from '../src/db/repo/events.js'
import { KvRepo } from '../src/db/repo/kv.js'
import { DATA_KEY, FIXTURES, TEST_CONFIG_YAML, setupDb } from './helpers.js'
import type { Metrics } from '../src/metrics/metrics.js'

const settlementBody = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))

describe('admin API', () => {
  let setup: ReturnType<typeof setupDb>
  let admin: ReturnType<typeof buildAdminServer>
  let ingest: ReturnType<typeof buildIngestServer>
  let events: EventsRepo
  let configPath: string

  beforeEach(async () => {
    setup = setupDb()
    events = new EventsRepo(setup.db)
    configPath = join(mkdtempSync(join(tmpdir(), 'relay-test-')), 'relay.yaml')
    writeFileSync(configPath, TEST_CONFIG_YAML.replaceAll('__EC_PORT__', '9999'))
    admin = buildAdminServer({
      db: setup.db,
      configPath,
      dbPath: ':memory:',
      startedAt: Date.now(),
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

  it('GET /status reports routes, queue, killswitch, config hash', async () => {
    await postWebhook()
    const res = await admin.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(200)
    const s = res.json()
    expect(s.config_hash).toMatch(/^sha256:/)
    expect(s.killswitch).toEqual({ global: 'none', routes_paused: [] })
    expect(s.queue.pending).toBe(1)
    const route = s.routes.find((r: any) => r.id === 'payabli-settlements')
    expect(route).toMatchObject({
      data_stream_key: 'payabli_settlements_funded',
      paused: false,
      counts: { pending: 1 },
    })
    expect(route.oldest_pending_age_s).toBeGreaterThanOrEqual(0)
  })

  it('killswitch flips via API affect ingest and are audited', async () => {
    await admin.inject({
      method: 'POST',
      url: '/killswitch',
      payload: { state: 'panic', actor: 'cli:david' },
    })
    expect((await postWebhook()).statusCode).toBe(503)

    await admin.inject({ method: 'POST', url: '/killswitch', payload: { state: 'none' } })
    expect((await postWebhook()).statusCode).toBe(200)

    const audit = (await admin.inject({ method: 'GET', url: '/audit' })).json()
    const actions = audit.map((a: any) => a.action)
    expect(actions).toContain('killswitch.panic')
    expect(actions).toContain('killswitch.none')
    expect(audit.find((a: any) => a.action === 'killswitch.panic').actor).toBe('cli:david')

    const bad = await admin.inject({ method: 'POST', url: '/killswitch', payload: { state: 'nope' } })
    expect(bad.statusCode).toBe(400)
  })

  it('per-route pause is reflected in status', async () => {
    const res = await admin.inject({
      method: 'POST',
      url: '/routes/payabli-settlements/pause',
      payload: { paused: true },
    })
    expect(res.statusCode).toBe(200)
    const s = (await admin.inject({ method: 'GET', url: '/status' })).json()
    expect(s.killswitch.routes_paused).toEqual(['payabli-settlements'])
    expect(
      (await admin.inject({ method: 'POST', url: '/routes/nope/pause', payload: { paused: true } }))
        .statusCode,
    ).toBe(404)
  })

  it('lists events without payloads and replays parked ones', async () => {
    await postWebhook()
    const [row] = events.list({})
    expect(row).not.toHaveProperty('payload_enc')
    events.markParked([row!.id], 'test parking')

    const list = (
      await admin.inject({ method: 'GET', url: '/events?status=parked' })
    ).json()
    expect(list).toHaveLength(1)

    const replay = await admin.inject({ method: 'POST', url: `/events/${row!.id}/replay`, payload: {} })
    expect(replay.statusCode).toBe(200)
    expect(events.getById(row!.id)!.status).toBe('retry')
    expect(events.getById(row!.id)!.attempts).toBe(0)

    // replaying a non-parked event is a 409
    expect(
      (await admin.inject({ method: 'POST', url: `/events/${row!.id}/replay`, payload: {} })).statusCode,
    ).toBe(409)
  })

  it('config plan detects drift and apply converges', async () => {
    const inSync = (await admin.inject({ method: 'GET', url: '/config/plan' })).json()
    expect(inSync.in_sync).toBe(true)

    writeFileSync(
      configPath,
      TEST_CONFIG_YAML.replaceAll('__EC_PORT__', '9999').replace('id: payabli-batches', 'id: payabli-batches-v2'),
    )
    const plan = (await admin.inject({ method: 'GET', url: '/config/plan' })).json()
    expect(plan.in_sync).toBe(false)
    expect(plan.routes_added).toEqual(['payabli-batches-v2'])
    expect(plan.routes_removed).toEqual(['payabli-batches'])

    const apply = await admin.inject({ method: 'POST', url: '/config/apply', payload: {} })
    expect(apply.statusCode).toBe(200)
    expect((await admin.inject({ method: 'GET', url: '/config/plan' })).json().in_sync).toBe(true)

    // invalid config is rejected without being applied
    writeFileSync(configPath, 'routes: []')
    expect((await admin.inject({ method: 'POST', url: '/config/apply', payload: {} })).statusCode).toBe(422)
  })

  it('serves the status page', async () => {
    const res = await admin.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('endclose-relay')
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
    await ingest.inject({
      method: 'POST',
      url: '/ingest/payabli-settlements',
      payload: settlementBody,
      headers: { 'content-type': 'application/json', authorization: 'Bearer wrong' },
    })
    new KvRepo(setup.db).setGlobalKillswitch('pause')

    const body = (await metricsServer.inject({ method: 'GET', url: '/metrics' })).body
    expect(body).toContain('relay_ingest_total{route="payabli-settlements",result="accepted"} 1')
    expect(body).toContain('relay_ingest_total{route="payabli-settlements",result="rejected_auth"} 1')
    expect(body).toContain('relay_queue_depth{status="pending"} 1')
    expect(body).toContain('relay_killswitch_state 1')
    expect((await metricsServer.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200)
    expect((await metricsServer.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200)
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
    insert('old-delivered', daysAgo(10), 'delivered') // payload wiped, row kept
    insert('ancient-delivered', daysAgo(40), 'delivered') // row deleted
    insert('old-filtered', daysAgo(10), 'dropped_by_filter')
    insert('old-parked', daysAgo(40), 'parked') // untouched forever

    const { wiped, deleted } = events.prune(new Date().toISOString(), 7, 30)
    expect(wiped).toBe(3) // old-delivered + old-filtered + ancient-delivered (wiped then deleted)
    expect(deleted).toBe(1) // ancient-delivered

    const remaining = events.list({ limit: 100 })
    const ids = remaining.map((r) => r.event_id)
    expect(ids).not.toContain('ancient-delivered')
    expect(ids).toContain('old-parked')
    const oldDelivered = db
      .prepare(`SELECT length(payload_enc) AS n FROM events WHERE event_id = 'old-delivered'`)
      .get() as { n: number }
    expect(oldDelivered.n).toBe(0)
    const recent = db
      .prepare(`SELECT length(payload_enc) AS n FROM events WHERE event_id = 'recent-delivered'`)
      .get() as { n: number }
    expect(recent.n).toBeGreaterThan(0)
    db.close()
  })
})
