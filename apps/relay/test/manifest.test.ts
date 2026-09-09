import { describe, expect, it } from 'vitest'
import { CONFIG_SCHEMA_VERSION, ENGINE_VERSION, type InstanceManifest } from '@end-close/relay'
import { InstanceReporter } from '../src/forward/manifest.js'

// The application's call-home is one manifest per instance: boot, heartbeats, shutdown.

function mockClient(fail = false) {
  const puts: { id: string; manifest: InstanceManifest }[] = []
  return {
    puts,
    client: {
      async putRelayInstance(id: string, manifest: InstanceManifest) {
        if (fail) throw new Error('HTTP 500')
        puts.push({ id, manifest })
      },
    },
  }
}

describe('InstanceReporter', () => {
  it('sends boot on start, heartbeats on the interval, shutdown on stop', async () => {
    const { puts, client } = mockClient()
    let source: 'remote' | 'local' = 'local'
    const r = new InstanceReporter({
      enabled: true,
      client,
      instanceId: 'relay',
      configSource: () => source,
      heartbeatIntervalMs: 20,
    })
    r.start()
    source = 'remote' // read at send time, so a later heartbeat reflects the change
    await new Promise((res) => setTimeout(res, 60))
    await r.stop()
    const reasons = puts.map((p) => p.manifest.reason)
    expect(reasons[0]).toBe('boot')
    expect(reasons.at(-1)).toBe('shutdown')
    expect(reasons.filter((x) => x === 'heartbeat').length).toBeGreaterThanOrEqual(1)
    expect(puts[0]!.id).toBe('relay')
    expect(puts[0]!.manifest).toEqual({
      schema: 1,
      reason: 'boot',
      host: 'application',
      engine_version: ENGINE_VERSION,
      config_schema: CONFIG_SCHEMA_VERSION,
      config_source: 'local',
      capabilities: { adapters: ['payabli', 'generic_hmac'], enrichments: {} },
    })
    expect(puts.at(-1)!.manifest.config_source).toBe('remote')
    // Nothing operational rides along.
    expect(Object.keys(puts[0]!.manifest).sort()).toEqual(
      ['capabilities', 'config_schema', 'config_source', 'engine_version', 'host', 'reason', 'schema'],
    )
  })

  it('reports config applies and throttled errors, each as a bare reason', async () => {
    const { puts, client } = mockClient()
    const r = new InstanceReporter({
      enabled: true,
      client,
      instanceId: 'relay',
      configSource: () => 'local',
      errorMinIntervalMs: 50,
    })
    r.configApplied()
    r.reportError()
    r.reportError() // throttled
    await new Promise((res) => setTimeout(res, 60))
    r.reportError()
    await r.stop()
    expect(puts.map((p) => p.manifest.reason)).toEqual(['config_applied', 'error', 'error'])
    for (const p of puts) {
      expect(Object.keys(p.manifest).sort()).toEqual(
        ['capabilities', 'config_schema', 'config_source', 'engine_version', 'host', 'reason', 'schema'],
      )
    }
  })

  it('sends nothing when disabled', async () => {
    const { puts, client } = mockClient()
    const r = new InstanceReporter({ enabled: false, client, instanceId: 'relay', configSource: () => 'local' })
    r.start()
    r.announce('heartbeat')
    await r.stop()
    expect(puts).toEqual([])
  })

  it('swallows a failed PUT', async () => {
    const { client } = mockClient(true)
    const r = new InstanceReporter({ enabled: true, client, instanceId: 'relay', configSource: () => 'local' })
    expect(() => r.start()).not.toThrow()
    await expect(r.stop()).resolves.toBeUndefined()
  })
})
