import { describe, expect, it } from 'vitest'
import { mask, REDACTED } from '../src/mask/engine.js'
import { hardDenyValue, keyNameIsSensitive } from '../src/mask/defaults.js'
import { maskConfigSchema } from '../src/config/schema.js'
import { MASKING_KEY } from './helpers.js'

const rules = (raw: unknown) => maskConfigSchema.parse(raw)

describe('mask engine', () => {
  it('allowlist mode drops everything not named', () => {
    const { output, report } = mask(
      rules({ mode: 'allowlist', allow: ['/keep'] }),
      { keep: 'yes', drop_me: 'no', nested: { x: 1 } },
      MASKING_KEY,
    )
    expect(output).toEqual({ keep: 'yes' })
    expect(report.dropped).toContain('/drop_me')
    expect(report.dropped).toContain('/nested/x')
  })

  it('allowlist entries cover whole subtrees and wildcards', () => {
    const doc = {
      transactions: [
        { Id: 'a', amount: 5, pii: 'x' },
        { Id: 'b', amount: 6, pii: 'y' },
      ],
    }
    const { output } = mask(
      rules({ mode: 'allowlist', allow: ['/transactions/*/Id', '/transactions/*/amount'] }),
      doc,
      MASKING_KEY,
    )
    expect(output).toEqual({
      transactions: [
        { Id: 'a', amount: 5 },
        { Id: 'b', amount: 6 },
      ],
    })
  })

  it('hash transform is deterministic and keyed', () => {
    const r = rules({
      mode: 'allowlist',
      allow: [],
      transforms: [{ path: '/email', action: 'hash' }],
    })
    const one = mask(r, { email: 'a@b.com' }, MASKING_KEY)
    const two = mask(r, { email: 'a@b.com' }, MASKING_KEY)
    expect(one.output).toEqual(two.output)
    const hashed = (one.output as { email: string }).email
    expect(hashed).toMatch(/^hmac256:[0-9a-f]{64}$/)
    expect(hashed).not.toContain('a@b.com')
  })

  it('redact and drop transforms', () => {
    const { output, report } = mask(
      rules({
        mode: 'denylist',
        transforms: [
          { path: '/masked_pan', action: 'redact' },
          { path: '/customer', action: 'drop' },
        ],
      }),
      { masked_pan: '4111 1XXXXXX1111', customer: { email: 'a@b.com' }, amount: '5.00' },
      MASKING_KEY,
    )
    expect(output).toEqual({ masked_pan: REDACTED, amount: '5.00' })
    expect(report.dropped).toContain('/customer')
  })

  it('drop transform beats allowlist', () => {
    const { output } = mask(
      rules({ mode: 'allowlist', allow: ['/a'], transforms: [{ path: '/a', action: 'drop' }] }),
      { a: 'secret' },
      MASKING_KEY,
    )
    expect(output).toEqual({})
  })

  it('hard denylist redacts Luhn-valid PANs inside allowed strings, in every mode', () => {
    const { output, report } = mask(
      rules({ mode: 'allowlist', allow: ['/note'] }),
      { note: 'card 4111111111111111 was used' },
      MASKING_KEY,
    )
    expect((output as { note: string }).note).toBe(`card ${REDACTED} was used`)
    expect(report.hard_denied).toContain('/note')
  })

  it('hard denylist strips sensitive key names even in denylist mode', () => {
    const { output, report } = mask(
      rules({ mode: 'denylist' }),
      { cvv: '123', RoutingNumber: '021000021', accountNumber: '12345678', fine: 'ok' },
      MASKING_KEY,
    )
    expect(output).toEqual({ fine: 'ok' })
    expect(report.hard_denied).toEqual(
      expect.arrayContaining(['/cvv', '/RoutingNumber', '/accountNumber']),
    )
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
