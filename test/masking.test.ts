import { describe, expect, it } from 'vitest'
import { mapEvent } from '../src/forward/mapper.js'
import { REDACTED, hardDenyValue, keyNameIsSensitive } from '../src/mask/defaults.js'
import { routeSchema } from '../src/config/schema.js'
import { MASKING_KEY } from './helpers.js'

// The map IS the allowlist: these tests pin the security properties of the mapping —
// nothing unmapped leaves, hashing is deterministic/keyed, and the hard denylist cannot
// be configured away.

function route(map: Record<string, unknown>) {
  return routeSchema.parse({
    id: 'r',
    source: 'generic_hmac',
    auth: { mode: 'hmac', header: 'x-sig', secret_env: 'S' },
    map: { data_stream_key: 'ds', external_id: 'id', amount: 'amount', direction: 'credit', ...map },
  })
}

describe('mapping as allowlist', () => {
  it('forwards only mapped fields; everything else is reported not_forwarded', () => {
    const { record, report } = mapEvent(
      route({ metadata: { note: 'note' } }),
      { id: 'e1', amount: '5.00', note: 'ok', secret_thing: 'x', nested: { deep: 1 } },
      '2026-07-07T00:00:00Z',
      MASKING_KEY,
    )
    expect(record.metadata).toEqual({ note: 'ok' })
    expect(report.not_forwarded.sort()).toEqual(['nested.deep', 'secret_thing'])
    expect(report.mapped).toMatchObject({ external_id: 'id', amount: 'amount', 'metadata.note': 'note' })
  })

  it('renames output fields and supports nested + wildcard paths', () => {
    const { record } = mapEvent(
      route({ metadata: { batch_number: 'batch.number', line_ids: 'lines.*.id' } }),
      {
        id: 'e1',
        amount: '1.00',
        batch: { number: 'b-9' },
        lines: [{ id: 'l1', pii: 'x' }, { id: 'l2' }],
      },
      '2026-07-07T00:00:00Z',
      MASKING_KEY,
    )
    expect(record.metadata).toEqual({ batch_number: 'b-9', line_ids: ['l1', 'l2'] })
  })

  it('transform arrays apply in order (normalize before hash)', () => {
    const chained = route({
      metadata: { customer_email: { source: 'email', transform: ['trim', 'lowercase', 'hash'] } },
    })
    const messy = mapEvent(chained, { id: 'e', amount: '1.00', email: '  A@B.com ' }, '2026-07-07T00:00:00Z', MASKING_KEY)
    const clean = mapEvent(chained, { id: 'e', amount: '1.00', email: 'a@b.com' }, '2026-07-07T00:00:00Z', MASKING_KEY)
    // normalization makes the hashes join across inconsistent source formatting
    expect(messy.record.metadata['customer_email']).toBe(clean.record.metadata['customer_email'])
    expect(messy.report.hashed).toContain('metadata.customer_email')

    // without normalization the hashes differ — order matters
    const hashOnly = route({
      metadata: { customer_email: { source: 'email', transform: 'hash' } },
    })
    const rawHash = mapEvent(hashOnly, { id: 'e', amount: '1.00', email: '  A@B.com ' }, '2026-07-07T00:00:00Z', MASKING_KEY)
    expect(rawHash.record.metadata['customer_email']).not.toBe(clean.record.metadata['customer_email'])
  })

  it('trim/lowercase apply elementwise over wildcard arrays', () => {
    const { record } = mapEvent(
      route({ metadata: { emails: { source: 'people.*.email', transform: ['trim', 'lowercase'] } } }),
      { id: 'e', amount: '1.00', people: [{ email: ' X@Y.com ' }, { email: 'z@w.com' }] },
      '2026-07-07T00:00:00Z',
      MASKING_KEY,
    )
    expect(record.metadata['emails']).toEqual(['x@y.com', 'z@w.com'])
  })

  it('hash transform is deterministic, keyed, and irreversible-looking', () => {
    const r = route({ metadata: { customer_email: { source: 'email', transform: 'hash' } } })
    const one = mapEvent(r, { id: 'e', amount: '1.00', email: 'a@b.com' }, '2026-07-07T00:00:00Z', MASKING_KEY)
    const two = mapEvent(r, { id: 'e', amount: '1.00', email: 'a@b.com' }, '2026-07-07T00:00:00Z', MASKING_KEY)
    expect(one.record.metadata['customer_email']).toBe(two.record.metadata['customer_email'])
    expect(one.record.metadata['customer_email']).toMatch(/^hmac256:[0-9a-f]{64}$/)
    expect(one.report.hashed).toContain('metadata.customer_email')
  })

  it('hard denylist redacts PANs/SSNs inside mapped values', () => {
    const { record } = mapEvent(
      route({ description: 'memo', metadata: { note: 'note' } }),
      {
        id: 'e1',
        amount: '1.00',
        memo: 'card 4111111111111111 used',
        note: 'ssn 123-45-6789',
      },
      '2026-07-07T00:00:00Z',
      MASKING_KEY,
    )
    expect(record.description).toBe(`card ${REDACTED} used`)
    expect(record.metadata['note']).toBe(`ssn ${REDACTED}`)
  })

  it('config refuses to map sensitive-named fields in clear', () => {
    expect(() => route({ metadata: { cvv: 'cvv' } })).toThrow(/hard denylist/)
    expect(() => route({ metadata: { acct: 'payment.accountNumber' } })).toThrow(/hard denylist/)
    // hashed is allowed
    expect(() => route({ metadata: { acct: { source: 'payment.accountNumber', transform: 'hash' } } })).not.toThrow()
  })
})

describe('hard denylist primitives', () => {
  it('detects sensitive key names across naming styles', () => {
    for (const k of ['cvv', 'CVV2', 'card_cvc', 'password', 'apiKey', 'api_key', 'ssn', 'AccountNumber']) {
      expect(keyNameIsSensitive(k), k).toBe(true)
    }
    for (const k of ['amount', 'batchNumber', 'entryPoint', 'transferId', 'account_type']) {
      expect(keyNameIsSensitive(k), k).toBe(false)
    }
  })

  it('redacts SSNs and PANs but not ordinary long numbers', () => {
    expect(hardDenyValue('ssn 123-45-6789')).toBe(`ssn ${REDACTED}`)
    expect(hardDenyValue('pan 4111-1111-1111-1111')).toBe(`pan ${REDACTED}`)
    // 16 digits failing Luhn stays (e.g. an order number)
    expect(hardDenyValue('order 1234567890123456')).toBe('order 1234567890123456')
    expect(hardDenyValue('batch b2f6a3e0')).toBe('batch b2f6a3e0')
  })
})
