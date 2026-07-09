import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildSetupServer, checkRequiredEnv } from '../src/admin/setup-server.js'

describe('boot env checks', () => {
  it('flags missing and invalid required env', () => {
    expect(checkRequiredEnv({})).toEqual([
      { name: 'RELAY_DATA_KEY', problem: 'not set' },
      { name: 'MASKING_HMAC_KEY', problem: 'not set' },
      { name: 'ADMIN_BASIC_AUTH', problem: 'not set' },
    ])
    expect(
      checkRequiredEnv({
        RELAY_DATA_KEY: 'short',
        MASKING_HMAC_KEY: 'long-enough-key-0123456789',
        ADMIN_BASIC_AUTH: 'no-colon',
      }),
    ).toEqual([
      { name: 'RELAY_DATA_KEY', problem: 'too short (min 16 chars)' },
      { name: 'ADMIN_BASIC_AUTH', problem: 'must be user:password' },
    ])
    expect(
      checkRequiredEnv({
        RELAY_DATA_KEY: 'long-enough-key-0123456789',
        MASKING_HMAC_KEY: 'long-enough-key-0123456789',
        ADMIN_BASIC_AUTH: 'admin:pw',
      }),
    ).toEqual([])
  })

  it('surfaces a broken secrets file first — it explains everything else', () => {
    const checks = checkRequiredEnv({}, 'RELAY_SECRETS_FILE is set but unreadable: /host-config/relay.env')
    expect(checks[0]).toEqual({
      name: 'RELAY_SECRETS_FILE',
      problem: 'RELAY_SECRETS_FILE is set but unreadable: /host-config/relay.env',
    })
    expect(checks.length).toBe(4)
  })
})

describe('setup server', () => {
  let server: ReturnType<typeof buildSetupServer>

  beforeEach(async () => {
    server = buildSetupServer([
      { name: 'MASKING_HMAC_KEY', problem: 'not set' },
      { name: 'ADMIN_BASIC_AUTH', problem: 'not set' },
    ])
    await server.ready()
  })

  afterEach(async () => {
    await server.close()
  })

  it('serves an unauthenticated warning page naming the missing vars', async () => {
    const res = await server.inject({ method: 'GET', url: '/' })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toContain('text/html')
    expect(res.body).toContain('setup required')
    expect(res.body).toContain('<td><code>MASKING_HMAC_KEY</code></td>')
    expect(res.body).toContain('<td><code>ADMIN_BASIC_AUTH</code></td>')
    // the missing-variables table lists only what's actually missing (RELAY_DATA_KEY
    // appears elsewhere on the page in the key-generation guidance)
    expect(res.body).not.toContain('<td><code>RELAY_DATA_KEY</code></td>')
  })

  it('answers everything else with 503 not-configured', async () => {
    const res = await server.inject({ method: 'GET', url: '/status' })
    expect(res.statusCode).toBe(503)
    expect(res.json().missing).toEqual(['MASKING_HMAC_KEY', 'ADMIN_BASIC_AUTH'])
  })

  it('healthz answers 200 so autoheal never restart-loops setup mode', async () => {
    const res = await server.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, mode: 'env-setup' })
  })

  it('explains key generation and config-referenced secrets', async () => {
    const body = (await server.inject({ method: 'GET', url: '/' })).body
    expect(body).toContain('openssl rand -hex 32')
    expect(body).toContain('ENDCLOSE_API_KEY')
    expect(body).toContain("can't be\nknown before a configuration exists")
  })

  it('warns about a missing volume alongside the env problems', async () => {
    const withStorage = buildSetupServer(
      [{ name: 'ADMIN_BASIC_AUTH', problem: 'not set' }],
      { dbPath: '/var/lib/endclose-relay/relay.db', persistent: false },
    )
    await withStorage.ready()
    const body = (await withStorage.inject({ method: 'GET', url: '/' })).body
    expect(body).toContain('no persistent volume detected')
    expect(body).toContain('/var/lib/endclose-relay/relay.db')
    await withStorage.close()

    // persistent or unknown → no storage warning
    const noWarn = buildSetupServer(
      [{ name: 'ADMIN_BASIC_AUTH', problem: 'not set' }],
      { dbPath: '/var/lib/endclose-relay/relay.db', persistent: null },
    )
    await noWarn.ready()
    expect((await noWarn.inject({ method: 'GET', url: '/' })).body).not.toContain(
      'persistent volume',
    )
    await noWarn.close()
  })
})
