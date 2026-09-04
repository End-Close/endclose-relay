import { describe, expect, it } from 'vitest'
import { PermanentHttpError } from '@endclose/relay'
import {
  TELEMETRY_ERROR_LIMIT,
  Telemetry,
  buildHeartbeatSnapshot,
  pickEventProperties,
  sanitizeError,
  type HeartbeatSnapshot,
  type TelemetryEventName,
} from '../src/forward/telemetry.js'
import { isTelemetryEnabled } from '../src/config/runtime.js'
import { EVENT_KEYS } from '../src/forward/telemetry.js'

function mockClient() {
  const posts: { name: string; properties: Record<string, unknown> }[] = []
  return {
    posts,
    client: {
      async postRelayEvent(event: { name: string; properties: Record<string, unknown> }) {
        posts.push(event)
      },
    },
  }
}

const sampleSnap: HeartbeatSnapshot = buildHeartbeatSnapshot('0.9.0', Date.now() - 5_000, {
  killswitch: 'none',
  queue: { pending: 2 },
  dbBytes: 1024,
  persistent: true,
  config: 'routes:\n  - id: payabli-settlements\n',
  routes: [
    {
      id: 'payabli-settlements',
      source: 'payabli',
      paused: false,
      counts: { pending: 2 },
      last_delivered_at: null,
      oldest_pending_at: new Date(Date.now() - 12_000).toISOString(),
    },
  ],
})

describe('isTelemetryEnabled', () => {
  it('defaults on and treats off/0/false as disabled', () => {
    expect(isTelemetryEnabled({})).toBe(true)
    expect(isTelemetryEnabled({ RELAY_TELEMETRY: 'off' })).toBe(false)
    expect(isTelemetryEnabled({ RELAY_TELEMETRY: '0' })).toBe(false)
    expect(isTelemetryEnabled({ RELAY_TELEMETRY: 'false' })).toBe(false)
    expect(isTelemetryEnabled({ RELAY_TELEMETRY: 'ON' })).toBe(true)
  })
})

describe('pickEventProperties', () => {
  it('drops keys that are not on the event allowlist', () => {
    const picked = pickEventProperties('relay_boot', {
      version: '0.9.0',
      mode: 'running',
      payload: 'secret-webhook',
      hostname: 'ip-10-0-1-1',
      db_path: '/var/lib/endclose-relay/relay.db',
    })
    expect(picked).toEqual({ version: '0.9.0', mode: 'running' })
  })
})

describe('buildHeartbeatSnapshot', () => {
  it('emits only allowlisted heartbeat keys and includes config', () => {
    expect(new Set(Object.keys(sampleSnap))).toEqual(new Set(EVENT_KEYS.relay_heartbeat))
    expect(sampleSnap.config).toContain('routes:')
    expect(sampleSnap.config).not.toMatch(/Bearer |sk_|password\s*=/i)
    expect(sampleSnap.queue.pending).toBe(2)
    expect(sampleSnap.queue.parked).toBe(0)
    expect(sampleSnap.routes[0]?.oldest_pending_age_s).toBeGreaterThanOrEqual(10)
  })
})

describe('sanitizeError', () => {
  it('keeps a stack and redacts Bearer tokens', () => {
    const err = new Error('failed Bearer super-secret-token')
    err.stack = `Error: failed Bearer super-secret-token\n    at dispatch (/app/src/forward/dispatcher.ts:90:11)`
    const s = sanitizeError(err)
    expect(s.stack).toContain('dispatcher.ts')
    expect(s.message).toContain('[REDACTED]')
    expect(s.message).not.toContain('super-secret-token')
    expect(s.stack).not.toContain('super-secret-token')
  })

  it('does not copy an HTTP error body', () => {
    const err = new PermanentHttpError('HTTP 422', 422, '{"card":"4111111111111111"}')
    const s = sanitizeError(err)
    expect(JSON.stringify(s)).not.toContain('4111111111111111')
    expect(s.message).toBe('HTTP 422')
  })
})

describe('Telemetry', () => {
  it('sends nothing when disabled', async () => {
    const { posts, client } = mockClient()
    const t = new Telemetry({
      enabled: false,
      client,
      version: '0.9.0',
      startedAt: Date.now(),
    })
    t.capture('relay_boot', { mode: 'running' })
    await t.stop()
    expect(posts).toEqual([])
  })

  it('rate-limits relay_error to 20 per minute', async () => {
    const { posts, client } = mockClient()
    const t = new Telemetry({
      enabled: true,
      client,
      version: '0.9.0',
      startedAt: Date.now(),
      errorLimit: TELEMETRY_ERROR_LIMIT,
    })
    for (let i = 0; i < TELEMETRY_ERROR_LIMIT + 5; i++) {
      t.captureError('dispatch_cycle', new Error(`lock ${i}`))
    }
    await t.stop()
    expect(posts.filter((p) => p.name === 'relay_error')).toHaveLength(TELEMETRY_ERROR_LIMIT)
  })

  it('swallows a failed POST', async () => {
    const t = new Telemetry({
      enabled: true,
      client: {
        async postRelayEvent() {
          throw new Error('HTTP 500')
        },
      },
      version: '0.9.0',
      startedAt: Date.now(),
    })
    expect(() => t.capture('relay_boot', { mode: 'running' })).not.toThrow()
    await t.stop()
  })

  it('posts a heartbeat after start', async () => {
    const { posts, client } = mockClient()
    const t = new Telemetry({
      enabled: true,
      client,
      version: '0.9.0',
      startedAt: Date.now(),
      heartbeatIntervalMs: 60_000,
    })
    t.start(() => sampleSnap)
    await new Promise((r) => setTimeout(r, 30))
    await t.stop()
    const beats = posts.filter((p) => p.name === 'relay_heartbeat')
    expect(beats.length).toBeGreaterThanOrEqual(1)
    expect(new Set(Object.keys(beats[0]!.properties))).toEqual(new Set(EVENT_KEYS.relay_heartbeat as unknown as string[]))
  })
})

describe('event names', () => {
  const names: TelemetryEventName[] = [
    'relay_boot',
    'relay_heartbeat',
    'relay_error',
    'relay_shutdown',
    'relay_killswitch',
    'relay_config_applied',
    'relay_batch_parked',
  ]
  it('has an allowlist for every catalogued event', () => {
    for (const name of names) expect(EVENT_KEYS[name].length).toBeGreaterThan(0)
  })
})
