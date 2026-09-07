import { describe, expect, it } from 'vitest'
import { EnrichmentError, EnrichTimeoutError, validateEnrichedValue, withTimeout, REDACTED } from '../src/index.js'

describe('validateEnrichedValue', () => {
  it('passes JSON through and treats undefined as "omit"', () => {
    expect(validateEnrichedValue(undefined, 'metadata.x')).toBeUndefined()
    expect(validateEnrichedValue(null, 'metadata.x')).toBeNull()
    expect(validateEnrichedValue('Pat', 'metadata.x')).toBe('Pat')
    expect(validateEnrichedValue(12, 'metadata.x')).toBe(12)
    expect(validateEnrichedValue(false, 'metadata.x')).toBe(false)
    expect(validateEnrichedValue({ name: 'Pat', units: ['12B', 3], nested: { ok: true } }, 'metadata.x')).toEqual({
      name: 'Pat',
      units: ['12B', 3],
      nested: { ok: true },
    })
  })

  it('rejects non-JSON values with the offending path', () => {
    expect(() => validateEnrichedValue(() => 1, 'metadata.x')).toThrow(EnrichmentError)
    expect(() => validateEnrichedValue(NaN, 'metadata.x')).toThrow(/"metadata.x" is not JSON/)
    expect(() => validateEnrichedValue(new Date(0), 'metadata.x')).toThrow(/not JSON \(a Date\)/)
    expect(() => validateEnrichedValue({ a: { b: undefined } }, 'metadata.x')).toThrow(/"metadata.x.a.b" is not JSON/)
    expect(() => validateEnrichedValue([1, Symbol('s')], 'metadata.x')).toThrow(/"metadata.x\[1\]" is not JSON/)
  })

  it('rejects sensitive key names at any depth', () => {
    expect(() => validateEnrichedValue({ resident: { ssn: '1' } }, 'metadata.x')).toThrow(
      /"metadata.x.resident.ssn" matches the hard denylist/,
    )
    expect(() => validateEnrichedValue({ accountNumber: '1' }, 'description')).toThrow(EnrichmentError)
  })

  it('applies the hard denylist to strings', () => {
    expect(validateEnrichedValue('card 4111 1111 1111 1111 on file', 'metadata.x')).toBe(`card ${REDACTED} on file`)
    expect(validateEnrichedValue({ note: 'ssn 123-45-6789' }, 'metadata.x')).toEqual({ note: `ssn ${REDACTED}` })
  })
})

describe('withTimeout', () => {
  it('resolves fast values, sync or async', async () => {
    expect(await withTimeout(() => 1, 50)).toBe(1)
    expect(await withTimeout(async () => 'a', 50)).toBe('a')
  })

  it('turns a synchronous throw into a rejection', async () => {
    await expect(withTimeout(() => { throw new Error('boom') }, 50)).rejects.toThrow('boom')
  })

  it('rejects a slow call with EnrichTimeoutError and does not hold the loop open', async () => {
    const t = Date.now()
    await expect(withTimeout(() => new Promise(() => {}), 20)).rejects.toBeInstanceOf(EnrichTimeoutError)
    expect(Date.now() - t).toBeLessThan(1000)
    // A call that settles well before its deadline must not leave a live timer behind.
    const timers = new Set<NodeJS.Timeout>()
    const origSet = globalThis.setTimeout
    const origClear = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms?: number) => { const id = origSet(fn, ms); timers.add(id); return id }) as typeof setTimeout
    globalThis.clearTimeout = ((id: NodeJS.Timeout) => { timers.delete(id); origClear(id) }) as typeof clearTimeout
    try {
      await withTimeout(() => 'quick', 60_000)
    } finally {
      globalThis.setTimeout = origSet
      globalThis.clearTimeout = origClear
    }
    expect(timers.size).toBe(0)
  })
})
