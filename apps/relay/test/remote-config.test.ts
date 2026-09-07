import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EndCloseClient, envSecrets, type RemoteConfig } from '@end-close/relay'
import { openDb, type Db } from '@end-close/relay-sqlite'
import { migrate } from '../src/db/migrate.js'
import { RoutesRepo } from '../src/db/repo/routes.js'
import { listConfigVersions, readActiveConfigRaw, resolveActiveConfig, saveConfig } from '../src/config/store.js'
import { parseConfig } from '../src/config/load.js'
import { remoteConfigToYaml, seedFromEndClose, remoteStatusOf, REMOTE_ACTOR } from '../src/config/remote.js'
import { isRemoteConfigEnabled, loadRuntimeSettings } from '../src/config/runtime.js'
import { buildAdminServer } from '../src/admin/server.js'
import { DATA_KEY, MASKING_KEY, TEST_CONFIG_YAML } from './helpers.js'

// The application's first-boot fetch: with nothing stored and no seed file, the routes
// document End Close holds for the API key becomes config version 1, attributed to
// "endclose". Every other outcome leaves the database empty (bootstrap mode).

const DOC = parse(TEST_CONFIG_YAML) as { routes: unknown[] }

class MockEndClose {
  server: Server
  requests: { url: string; headers: Record<string, string | string[] | undefined> }[] = []
  reply: { status: number; body: unknown } = { status: 200, body: { environment: 'sandbox', ...DOC } }
  port = 0
  constructor() {
    this.server = createServer((req, res) => {
      this.requests.push({ url: req.url!, headers: req.headers })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url === '/v1/relays/config') {
        res.statusCode = this.reply.status
        return res.end(JSON.stringify(this.reply.body))
      }
      res.statusCode = 404
      res.end('{}')
    })
  }
  async listen(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
  }
  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}/v1`
  }
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }
}

describe('seedFromEndClose', () => {
  let mock: MockEndClose
  let db: Db
  const env = { ENDCLOSE_API_KEY: 'test-api-key', PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' }

  const opts = (over: Partial<Parameters<typeof seedFromEndClose>[1]> = {}) => ({
    client: new EndCloseClient(mock.baseUrl, 'test-api-key'),
    apiKey: 'test-api-key',
    baseUrl: mock.baseUrl,
    enabled: true,
    secrets: envSecrets(env),
    ...over,
  })

  beforeEach(async () => {
    mock = new MockEndClose()
    await mock.listen()
    db = openDb(':memory:')
    migrate(db)
  })
  afterEach(async () => {
    db.close()
    await mock.close()
  })

  it('stores the fetched document as version 1, applied by "endclose", with routes materialized', async () => {
    const result = await seedFromEndClose(db, opts())
    expect(result.kind).toBe('seeded')
    if (result.kind !== 'seeded') return
    expect(result.environment).toBe('sandbox')
    expect(result.loaded.config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])

    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]!.url).toBe('/v1/relays/config')
    expect(mock.requests[0]!.headers['x-api-key']).toBe('test-api-key')

    const versions = listConfigVersions(db)
    expect(versions).toHaveLength(1)
    expect(versions[0]!.applied_by).toBe(REMOTE_ACTOR)
    expect(versions[0]!.config_hash).toBe(result.loaded.hash)
    expect(new RoutesRepo(db).all().map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])

    // The stored YAML round-trips through the normal loader and says where it came from.
    const raw = readActiveConfigRaw(db)!
    expect(raw.yamlText).toMatch(/^# Configuration fetched from End Close \(environment: sandbox\) on /)
    expect(raw.yamlText).toContain(`${mock.baseUrl}/relays/config`)
    expect(parseConfig(raw.yamlText).config.routes).toHaveLength(2)
    expect(resolveActiveConfig(db, undefined).kind).toBe('ok')

    const audit = db.prepare('SELECT actor, action FROM audit_log').all() as { actor: string; action: string }[]
    expect(audit).toEqual([{ actor: REMOTE_ACTOR, action: 'config.apply' }])
  })

  it('serializes the document End Close sent, not the defaults-applied routes', () => {
    const config: RemoteConfig = {
      routes: parseConfig(TEST_CONFIG_YAML).config.routes,
      document: DOC,
      fetchedAt: '2026-09-07T00:00:00.000Z',
    }
    const yaml = remoteConfigToYaml(config, 'https://api.endclose.com/v1')
    expect(yaml).not.toContain('max_body_bytes')
    expect(yaml).not.toContain('allowed_ips')
    expect(parseConfig(yaml).config.routes[0]!.max_body_bytes).toBe(1024 * 1024)
  })

  it('404 → none (plain bootstrap), nothing stored', async () => {
    mock.reply = { status: 404, body: { error: 'no relay configuration' } }
    expect(await seedFromEndClose(db, opts())).toEqual({ kind: 'none' })
    expect(readActiveConfigRaw(db)).toBeUndefined()
    expect(remoteStatusOf({ kind: 'none' }, false)).toEqual({ state: 'none', retrying: false })
  })

  it('a transient failure is retryable; a rejected key is not', async () => {
    mock.reply = { status: 503, body: { error: 'down' } }
    const down = await seedFromEndClose(db, opts())
    expect(down).toMatchObject({ kind: 'failed', retryable: true })
    expect(remoteStatusOf(down, true)).toMatchObject({ state: 'failed', retrying: true })

    mock.reply = { status: 401, body: { error: 'bad key' } }
    const rejected = await seedFromEndClose(db, opts())
    expect(rejected).toMatchObject({ kind: 'failed', retryable: false })
    expect(remoteStatusOf(rejected, true)).toMatchObject({ state: 'failed', retrying: false })
    expect(readActiveConfigRaw(db)).toBeUndefined()
  })

  it('a document naming an unset secret env var is not applied (operator must act)', async () => {
    const result = await seedFromEndClose(db, opts({ secrets: envSecrets({}) }))
    expect(result).toMatchObject({ kind: 'failed', retryable: false })
    if (result.kind === 'failed') expect(result.error).toMatch(/PAYABLI_WEBHOOK_SECRET/)
    expect(readActiveConfigRaw(db)).toBeUndefined()
    expect(listConfigVersions(db)).toHaveLength(0)
  })

  it('an invalid document from End Close is reported, not stored', async () => {
    mock.reply = { status: 200, body: { routes: [{ id: 'x' }] } }
    const result = await seedFromEndClose(db, opts())
    expect(result).toMatchObject({ kind: 'failed', retryable: false })
    expect(readActiveConfigRaw(db)).toBeUndefined()
  })

  it('never fetches when disabled or without an API key', async () => {
    expect(await seedFromEndClose(db, opts({ enabled: false }))).toEqual({ kind: 'disabled', reason: 'env' })
    expect(await seedFromEndClose(db, opts({ apiKey: '' }))).toEqual({ kind: 'disabled', reason: 'no_api_key' })
    expect(mock.requests).toHaveLength(0)
  })

  it('a configuration applied locally while fetching wins', async () => {
    // Simulate the operator's apply landing before the fetch resolves.
    mock.server.prependListener('request', () => {
      if (!readActiveConfigRaw(db)) saveConfig(db, TEST_CONFIG_YAML, 'admin', envSecrets(env))
    })
    expect(await seedFromEndClose(db, opts())).toEqual({ kind: 'superseded' })
    expect(listConfigVersions(db).map((v) => v.applied_by)).toEqual(['admin'])
  })

  it('the admin status reports the outcome in bootstrap mode', async () => {
    mock.reply = { status: 503, body: { error: 'down' } }
    const result = await seedFromEndClose(db, opts())
    const admin = await buildAdminServer({
      db,
      dbPath: ':memory:',
      startedAt: Date.now(),
      basicAuth: 'a:b',
      maskingKey: MASKING_KEY,
      dataKey: DATA_KEY,
      mode: 'bootstrap',
      remoteConfig: () => remoteStatusOf(result, true),
    })
    const res = await admin.inject({
      method: 'GET',
      url: '/status',
      headers: { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') },
    })
    expect(res.json().remote_config).toEqual({
      state: 'failed',
      error: expect.stringMatching(/HTTP 503/),
      retrying: true,
    })
    await admin.close()
  })
})

describe('RELAY_REMOTE_CONFIG', () => {
  it('defaults on; off/0/false disable', () => {
    expect(isRemoteConfigEnabled({})).toBe(true)
    expect(isRemoteConfigEnabled({ RELAY_REMOTE_CONFIG: 'on' })).toBe(true)
    for (const v of ['off', '0', 'false', ' FALSE ']) {
      expect(isRemoteConfigEnabled({ RELAY_REMOTE_CONFIG: v })).toBe(false)
    }
    expect(loadRuntimeSettings({ RELAY_REMOTE_CONFIG: 'off' }).remoteConfig.enabled).toBe(false)
  })
})
