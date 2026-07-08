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
    expect(res.body).toContain('MASKING_HMAC_KEY')
    expect(res.body).toContain('ADMIN_BASIC_AUTH')
    // no payloads, no secrets — just names
    expect(res.body).not.toContain('RELAY_DATA_KEY')
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
})
