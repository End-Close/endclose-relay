import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildAdminServer } from '../src/admin/server.js'
import { AdminClient } from '../src/cli/client.js'
import { MASKING_KEY, DATA_KEY, TEST_CONFIG_YAML, setupDb } from './helpers.js'
import type { AddressInfo } from 'node:net'

describe('relayctl admin client', () => {
  let setup: ReturnType<typeof setupDb>
  let admin: ReturnType<typeof buildAdminServer>
  let client: AdminClient

  beforeEach(async () => {
    setup = setupDb()
    admin = buildAdminServer({
      db: setup.db,
      dbPath: ':memory:',
      startedAt: Date.now(),
      basicAuth: 'admin:hunter2',
      maskingKey: MASKING_KEY,
      dataKey: DATA_KEY,
      mode: 'bootstrap',
    })
    await admin.listen({ port: 0, host: '127.0.0.1' })
    const addr = admin.server.address() as AddressInfo
    client = new AdminClient({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      basicAuth: 'admin:hunter2',
    })
  })

  afterEach(async () => {
    await admin.close()
    setup.db.close()
  })

  it('reads status in bootstrap mode', async () => {
    const { data } = await client.get<{ mode: string }>('/status')
    expect(data.mode).toBe('bootstrap')
  })

  it('validates and applies YAML config', async () => {
    const check = await client.post<{ valid: boolean; hash?: string; error?: string }>(
      '/config/validate',
      { yaml: TEST_CONFIG_YAML },
    )
    expect(check.data.valid, check.data.error).toBe(true)

    const applied = await client.post<{ applied: string }>('/config', { yaml: TEST_CONFIG_YAML })
    expect(applied.data.applied).toMatch(/^sha256:/)

    const got = await client.get<{ yaml: string; hash: string }>('/config')
    expect(got.data.hash).toBe(applied.data.applied)
    expect(got.data.yaml).toContain('payabli-settlements')
  })

  it('rejects wrong credentials', async () => {
    const addr = admin.server.address() as AddressInfo
    const bad = new AdminClient({
      baseUrl: `http://127.0.0.1:${addr.port}`,
      basicAuth: 'admin:wrong',
    })
    await expect(bad.get('/status')).rejects.toMatchObject({ status: 401 })
  })
})
