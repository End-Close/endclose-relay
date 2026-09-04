import { describe, expect, it } from 'vitest'
import { jsonTopLevelKeys, requestHeaderNames } from '../src/index.js'

describe('payload-shape helpers', () => {
  it('lists sorted top-level keys without values', () => {
    expect(jsonTopLevelKeys({ Event: 'X', transferId: 1, NetAmount: '1.00' })).toBe(
      'Event,NetAmount,transferId',
    )
    expect(jsonTopLevelKeys([1, 2])).toBe('(array)')
    expect(jsonTopLevelKeys('hi')).toBe('string')
    expect(jsonTopLevelKeys(null)).toBe('object')
  })

  it('lists header names excluding authorization/secret headers', () => {
    expect(
      requestHeaderNames({
        'content-type': 'application/json',
        authorization: 'Bearer secret',
        'x-api-key': 'nope',
        'user-agent': 'test',
        'x-webhook-secret': 'nope',
      }),
    ).toBe('content-type,user-agent')
  })
})
