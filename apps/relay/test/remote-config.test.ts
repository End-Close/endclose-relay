import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { parse } from 'yaml'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EndCloseClient, envSecrets, noopLogger, type RemoteConfig } from '@end-close/relay'
import { KvRepo, openDb, type Db } from '@end-close/relay-sqlite'
import { migrate } from '../src/db/migrate.js'
import { RoutesRepo } from '../src/db/repo/routes.js'
import { listConfigVersions, readActiveConfigRaw, resolveActiveConfig, saveConfig } from '../src/config/store.js'
import { parseConfig } from '../src/config/load.js'
import { checkEndClose, remoteConfigToYaml, RemoteConfigManager, REMOTE_ACTOR } from '../src/config/remote.js'
import { isRemoteConfigEnabled, loadRuntimeSettings } from '../src/config/runtime.js'
import { buildAdminServer } from '../src/admin/server.js'
import { DATA_KEY, MASKING_KEY, TEST_CONFIG_YAML } from './helpers.js'

// Who owns the configuration is decided by GET /relays/config: 200 = End Close (stored
// as a version by "endclose", kept current with the ETag, local editor locked), 304 =
// unchanged, 404 = configured locally.

const DOC = parse(TEST_CONFIG_YAML) as { routes: unknown[] }
const AUTH = { authorization: 'Basic ' + Buffer.from('a:b').toString('base64') }

class MockEndClose {
  server: Server
  requests: { method: string; url: string; headers: Record<string, string | string[] | undefined> }[] = []
  reply: { status: number; body: unknown } = { status: 200, body: { environment: 'sandbox', ...DOC } }
  port = 0
  constructor() {
    this.server = createServer((req, res) => {
      this.requests.push({ method: req.method!, url: req.url!, headers: req.headers })
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url === '/v1/relays/config') {
        if (this.reply.status !== 200) {
          res.statusCode = this.reply.status
          return res.end(JSON.stringify(this.reply.body))
        }
        const body = JSON.stringify(this.reply.body)
        const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 12)}"`
        if (req.headers['if-none-match'] === etag) {
          res.statusCode = 304
          return res.end()
        }
        res.statusCode = 200
        res.setHeader('etag', etag)
        return res.end(body)
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
  configGets() {
    return this.requests.filter((r) => r.method === 'GET' && r.url === '/v1/relays/config')
  }
  async close(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }
}

describe('checkEndClose', () => {
  let mock: MockEndClose
  let db: Db
  const env = { ENDCLOSE_API_KEY: 'test-api-key', PAYABLI_WEBHOOK_SECRET: 'Bearer test-webhook-secret' }

  const opts = (over: Partial<Parameters<typeof checkEndClose>[1]> = {}) => ({
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

  it('200: stores the document as a version by "endclose", keeps the ETag, applies live', async () => {
    const result = await checkEndClose(db, opts())
    expect(result).toMatchObject({ kind: 'managed', changed: true, environment: 'sandbox' })
    if (result.kind !== 'managed') return
    expect(result.loaded.config.routes.map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])

    expect(mock.configGets()).toHaveLength(1)
    expect(mock.configGets()[0]!.headers['x-api-key']).toBe('test-api-key')
    expect(mock.configGets()[0]!.headers['if-none-match']).toBeUndefined()

    const versions = listConfigVersions(db)
    expect(versions).toHaveLength(1)
    expect(versions[0]!.applied_by).toBe(REMOTE_ACTOR)
    expect(versions[0]!.config_hash).toBe(result.loaded.hash)
    expect(new RoutesRepo(db).all().map((r) => r.id)).toEqual(['payabli-settlements', 'payabli-batches'])
    expect(new KvRepo(db).get('remote_config.etag')).toMatch(/^"[0-9a-f]{12}"$/)

    const raw = readActiveConfigRaw(db)!
    expect(raw.yamlText).toMatch(/^# Configuration managed by End Close \(environment: sandbox\)/)
    expect(parseConfig(raw.yamlText).config.routes).toHaveLength(2)
    expect(resolveActiveConfig(db, undefined).kind).toBe('ok')
    const audit = db.prepare('SELECT actor, action FROM audit_log').all() as { actor: string; action: string }[]
    expect(audit).toEqual([{ actor: REMOTE_ACTOR, action: 'config.apply' }])
  })

  it('304: the next check sends If-None-Match, stays managed, adds no version', async () => {
    await checkEndClose(db, opts())
    const again = await checkEndClose(db, opts())
    expect(again).toMatchObject({ kind: 'managed', changed: false, environment: 'sandbox' })
    expect(mock.configGets()[1]!.headers['if-none-match']).toBe(new KvRepo(db).get('remote_config.etag'))
    expect(listConfigVersions(db)).toHaveLength(1)
  })

  it('a changed document becomes a new version and the routes change live', async () => {
    await checkEndClose(db, opts())
    mock.reply = { status: 200, body: { environment: 'sandbox', routes: [DOC.routes[0]] } }
    const changed = await checkEndClose(db, opts())
    expect(changed).toMatchObject({ kind: 'managed', changed: true })
    expect(listConfigVersions(db)).toHaveLength(2)
    expect(new RoutesRepo(db).all().map((r) => r.id)).toEqual(['payabli-settlements'])
  })

  it('the stored YAML is deterministic and serializes the document as sent, not the defaults', () => {
    const config: RemoteConfig = {
      routes: parseConfig(TEST_CONFIG_YAML).config.routes,
      document: DOC,
      etag: '"x"',
      fetchedAt: '2026-09-07T00:00:00.000Z',
    }
    const a = remoteConfigToYaml(config, 'https://api.endclose.com/v1')
    const b = remoteConfigToYaml({ ...config, fetchedAt: '2030-01-01T00:00:00.000Z' }, 'https://api.endclose.com/v1')
    expect(a).toBe(b)
    expect(a).not.toContain('max_body_bytes')
    expect(a).not.toContain('allowed_ips')
    expect(parseConfig(a).config.routes[0]!.max_body_bytes).toBe(1024 * 1024)
  })

  it('404: not managed — nothing stored, and a kept ETag is dropped', async () => {
    await checkEndClose(db, opts())
    mock.reply = { status: 404, body: { error: 'not managed' } }
    expect(await checkEndClose(db, opts())).toEqual({ kind: 'unmanaged' })
    expect(new KvRepo(db).get('remote_config.etag')).toBeUndefined()
    expect(listConfigVersions(db)).toHaveLength(1) // the last document stays as the local config
  })

  it('a transient failure is retryable; a rejected key is not', async () => {
    mock.reply = { status: 503, body: { error: 'down' } }
    expect(await checkEndClose(db, opts())).toMatchObject({ kind: 'failed', retryable: true })
    mock.reply = { status: 401, body: { error: 'bad key' } }
    expect(await checkEndClose(db, opts())).toMatchObject({ kind: 'failed', retryable: false })
    mock.reply = { status: 403, body: { error: 'not a relay key' } }
    expect(await checkEndClose(db, opts())).toMatchObject({ kind: 'failed', retryable: false })
    expect(readActiveConfigRaw(db)).toBeUndefined()
  })

  it('a document naming an unset secret env var is not applied and keeps no ETag', async () => {
    const result = await checkEndClose(db, opts({ secrets: envSecrets({}) }))
    expect(result).toMatchObject({ kind: 'failed', retryable: false })
    if (result.kind === 'failed') expect(result.error).toMatch(/PAYABLI_WEBHOOK_SECRET/)
    expect(readActiveConfigRaw(db)).toBeUndefined()
    expect(new KvRepo(db).get('remote_config.etag')).toBeUndefined()
  })

  it('an invalid document from End Close is reported, not stored', async () => {
    mock.reply = { status: 200, body: { routes: [{ id: 'x' }] } }
    expect(await checkEndClose(db, opts())).toMatchObject({ kind: 'failed', retryable: false })
    expect(readActiveConfigRaw(db)).toBeUndefined()
  })

  it('never asks when disabled or without an API key', async () => {
    expect(await checkEndClose(db, opts({ enabled: false }))).toEqual({ kind: 'disabled', reason: 'env' })
    expect(await checkEndClose(db, opts({ apiKey: '' }))).toEqual({ kind: 'disabled', reason: 'no_api_key' })
    expect(mock.requests).toHaveLength(0)
  })

  it('a locally edited config is replaced when End Close turns out to own the environment', async () => {
    saveConfig(db, TEST_CONFIG_YAML, 'admin', envSecrets(env))
    const result = await checkEndClose(db, opts())
    expect(result).toMatchObject({ kind: 'managed', changed: true })
    expect(listConfigVersions(db).map((v) => v.applied_by)).toEqual([REMOTE_ACTOR, 'admin'])
  })

  it('never sends a stale ETag: a local apply after management forces a full fetch', async () => {
    await checkEndClose(db, opts()) // managed, ETag kept
    // Management off (or RELAY_REMOTE_CONFIG toggled): the operator applies locally.
    saveConfig(db, TEST_CONFIG_YAML, 'admin', envSecrets(env))
    const again = await checkEndClose(db, opts())
    // A 304 here would have passed the local edit off as End Close's document.
    expect(mock.configGets()[1]!.headers['if-none-match']).toBeUndefined()
    expect(again).toMatchObject({ kind: 'managed', changed: true })
    expect(listConfigVersions(db).map((v) => v.applied_by)).toEqual([REMOTE_ACTOR, 'admin', REMOTE_ACTOR])
  })

  describe('RemoteConfigManager', () => {
    it('tracks ownership, polls while managed, and keeps polling after a 404', async () => {
      const m = new RemoteConfigManager(db, opts(), noopLogger)
      expect(m.snapshot().state).toBe('unknown')
      expect((await m.check()).kind).toBe('managed')
      expect(m.managed).toBe(true)
      expect(m.snapshot()).toMatchObject({ state: 'managed', managed: true, environment: 'sandbox', error: null })

      const seen: string[] = []
      m.start(15, (r) => seen.push(r.kind))
      mock.reply = { status: 200, body: { environment: 'sandbox', routes: [DOC.routes[0]] } }
      await new Promise((r) => setTimeout(r, 40))
      expect(listConfigVersions(db)).toHaveLength(2)

      mock.reply = { status: 404, body: {} }
      await new Promise((r) => setTimeout(r, 40))
      expect(m.managed).toBe(false)
      expect(m.snapshot().state).toBe('unmanaged')
      const gets = mock.configGets().length
      await new Promise((r) => setTimeout(r, 40))
      expect(mock.configGets().length).toBeGreaterThan(gets) // 404 is a state: keep asking
      // Management switched back on is noticed without a restart.
      mock.reply = { status: 200, body: { environment: 'sandbox', ...DOC } }
      await new Promise((r) => setTimeout(r, 40))
      expect(m.managed).toBe(true)
      expect(listConfigVersions(db)).toHaveLength(3)
      m.stop()
      expect(seen).toContain('managed')
      expect(seen).toContain('unmanaged')
    })

    it('a transient failure keeps the last ownership answer and reports retrying', async () => {
      const m = new RemoteConfigManager(db, opts(), noopLogger)
      await m.check()
      mock.reply = { status: 503, body: {} }
      await m.check()
      expect(m.snapshot()).toMatchObject({ state: 'failed', managed: true })
      m.start(60_000)
      expect(m.snapshot().retrying).toBe(true)
      expect(m.shouldPoll).toBe(true)
      m.stop()
    })
  })

  it('the admin plane refuses a local apply while End Close owns the configuration', async () => {
    const m = new RemoteConfigManager(db, opts(), noopLogger)
    await m.check()
    const admin = await buildAdminServer({
      db,
      dbPath: ':memory:',
      startedAt: Date.now(),
      basicAuth: 'a:b',
      maskingKey: MASKING_KEY,
      dataKey: DATA_KEY,
      secrets: envSecrets(env),
      remoteConfig: () => m.snapshot(),
    })
    const status = (await admin.inject({ method: 'GET', url: '/status', headers: AUTH })).json()
    expect(status.remote_config).toMatchObject({ state: 'managed', managed: true, environment: 'sandbox' })
    const apply = await admin.inject({ method: 'POST', url: '/config', payload: { yaml: TEST_CONFIG_YAML }, headers: AUTH })
    expect(apply.statusCode).toBe(409)
    expect(apply.json().error).toMatch(/managed by End Close/)
    // Drafts can still be validated and previewed.
    expect((await admin.inject({ method: 'POST', url: '/config/validate', payload: { yaml: TEST_CONFIG_YAML }, headers: AUTH })).json().valid).toBe(true)
    expect(listConfigVersions(db)).toHaveLength(1)

    mock.reply = { status: 404, body: {} }
    await m.check()
    const applyAgain = await admin.inject({ method: 'POST', url: '/config', payload: { yaml: TEST_CONFIG_YAML }, headers: AUTH })
    expect(applyAgain.statusCode).toBe(200)
    await admin.close()
  })
})

describe('RELAY_REMOTE_CONFIG', () => {
  it('defaults on; off/0/false disable; poll interval is configurable', () => {
    expect(isRemoteConfigEnabled({})).toBe(true)
    expect(isRemoteConfigEnabled({ RELAY_REMOTE_CONFIG: 'on' })).toBe(true)
    for (const v of ['off', '0', 'false', ' FALSE ']) {
      expect(isRemoteConfigEnabled({ RELAY_REMOTE_CONFIG: v })).toBe(false)
    }
    expect(loadRuntimeSettings({ RELAY_REMOTE_CONFIG: 'off' }).remoteConfig).toEqual({ enabled: false, pollIntervalMs: 60_000 })
    expect(loadRuntimeSettings({ RELAY_REMOTE_POLL_MS: '5000' }).remoteConfig.pollIntervalMs).toBe(5000)
  })
})
