import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mapEvent, parseDate, toCents, MappingError } from '../src/forward/mapper.js'
import { FIXTURES, MASKING_KEY, testConfig } from './helpers.js'
import type { Json } from '../src/mask/paths.js'

const settlement = JSON.parse(
  readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'), 'utf8'),
) as Json
const batchPaid = JSON.parse(
  readFileSync(join(FIXTURES, 'payabli-batch-paid.json'), 'utf8'),
) as Json

describe('toCents', () => {
  it('parses payabli string amounts', () => {
    expect(toCents('3762.87')).toBe(376287)
    expect(toCents('3,762.87')).toBe(376287)
    expect(toCents('$12,450.10')).toBe(1245010)
    expect(toCents('0.00')).toBe(0)
    expect(toCents('38')).toBe(3800)
    expect(toCents('-12.5')).toBe(-1250)
    expect(toCents(42.25)).toBe(4225)
  })
  it('rejects garbage', () => {
    expect(() => toCents('12.345')).toThrow(MappingError)
    expect(() => toCents('abc')).toThrow(MappingError)
    expect(() => toCents(null)).toThrow(MappingError)
  })
})

describe('parseDate', () => {
  it('parses payabli M/D/YYYY H:mm:ss', () => {
    expect(parseDate('7/3/2026 14:22:05', 'mdy_hms')).toBe('2026-07-03')
    expect(parseDate('12/31/2025 0:00:00', 'mdy_hms')).toBe('2025-12-31')
  })
  it('parses iso8601', () => {
    expect(parseDate('2026-07-03T14:22:05Z', 'iso8601')).toBe('2026-07-03')
  })
})

describe('mapEvent', () => {
  const config = testConfig()
  const settlementsRoute = config.routes[0]!
  const batchesRoute = config.routes[1]!

  it('maps settlement funded to an End Close record', () => {
    const record = mapEvent(settlementsRoute, settlement, '2026-07-03T14:25:00Z', MASKING_KEY)
    expect(record).toMatchObject({
      data_stream_key: 'payabli_settlements_funded',
      external_id: 'trf_9f8e7d6c',
      amount: 376287,
      direction: 'credit',
      date: '2026-07-03',
    })
    // metadata is exactly the allowlisted set
    expect(Object.keys(record.metadata).sort()).toEqual(
      ['Paypoint', 'RtAmount', 'TotalAmount', 'batchId', 'batchNumber', 'entryPoint'].sort(),
    )
    // the raw transferId/NetAmount/transferTime do not additionally leak via metadata
    expect(record.metadata).not.toHaveProperty('transferId')
    expect(record.metadata).not.toHaveProperty('NetAmount')
  })

  it('maps batch paid; date falls back to received_at (payload has no timestamp)', () => {
    const record = mapEvent(batchesRoute, batchPaid, '2026-07-04T09:00:00Z', MASKING_KEY)
    expect(record).toMatchObject({
      data_stream_key: 'payabli_batches_paid',
      external_id: '341',
      amount: 1245010,
      direction: 'debit',
      date: '2026-07-04',
    })
    expect(record.metadata).toEqual({
      Method: 'ach',
      entryPoint: 'acme-main',
      Paypoint: 'Acme Field Services',
    })
  })

  it('parks unmappable payloads via MappingError', () => {
    expect(() =>
      mapEvent(settlementsRoute, { Event: 'TransferFunded' }, '2026-07-03T00:00:00Z', MASKING_KEY),
    ).toThrow(MappingError)
  })
})
