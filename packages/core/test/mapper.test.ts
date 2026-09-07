import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { mapEvent, parseDate, parseRoutes, routeSchema, toCents, MappingError } from '../src/index.js'
import { FIXTURES, MASKING_KEY, TRANSACTION_ROUTES_YAML, testConfig } from './helpers.js'
import type { Json } from '../src/index.js'

const settlement = JSON.parse(
  readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'), 'utf8'),
) as Json
const batchPaid = JSON.parse(
  readFileSync(join(FIXTURES, 'payabli-batch-paid.json'), 'utf8'),
) as Json
const transaction = JSON.parse(
  readFileSync(join(FIXTURES, 'payabli-transaction.json'), 'utf8'),
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
    const { record, report } = mapEvent(
      settlementsRoute,
      settlement,
      '2026-07-03T14:25:00Z',
      MASKING_KEY,
    )
    expect(record).toMatchObject({
      data_stream_key: 'payabli_settlements_funded',
      external_id: 'trf_9f8e7d6c',
      amount: 376287,
      direction: 'credit',
      date: '2026-07-03',
    })
    // metadata is exactly the mapped set, under the configured output names
    expect(record.metadata).toEqual({
      batch_id: '87',
      batch_number: 'b2f6a3e0-4c1d-4e8a-9b7f-1a2b3c4d5e6f',
      total_amount: '3,800.00',
      return_amount: '0.00',
      entry_point: 'acme-main',
      paypoint: 'Acme Field Services',
    })
    // unmapped payload fields are reported as staying local
    expect(report.not_forwarded).toEqual(expect.arrayContaining(['Text', 'ContactUs']))
    expect(report.not_forwarded).not.toContain('transferId')
  })

  it('maps batch paid; date falls back to received_at (payload has no timestamp)', () => {
    const { record, report } = mapEvent(batchesRoute, batchPaid, '2026-07-04T09:00:00Z', MASKING_KEY)
    expect(record).toMatchObject({
      data_stream_key: 'payabli_batches_paid',
      external_id: '341',
      amount: 1245010,
      direction: 'debit',
      date: '2026-07-04',
    })
    expect(record.metadata).toEqual({
      method: 'ach',
      paypoint: 'Acme Field Services',
    })
    expect(report.mapped['date']).toBe('(receive time)')
  })

  it('parks unmappable payloads via MappingError', () => {
    expect(() =>
      mapEvent(settlementsRoute, { Event: 'TransferFunded' }, '2026-07-03T00:00:00Z', MASKING_KEY),
    ).toThrow(MappingError)
  })
})

describe('enriched fields', () => {
  const enrichments = { resident_name: () => 'never called by mapEvent' }
  const txnRoute = parseRoutes(parse(TRANSACTION_ROUTES_YAML), { enrichments })[0]!
  const baseMap = { data_stream_key: 'k', external_id: 'TransactionId', amount: 'NetAmount', direction: 'credit' as const }
  const routeWith = (map: Record<string, unknown>) =>
    routeSchema.parse({ id: 'x', source: 'payabli', auth: { mode: 'static_header', secret_env: 'S' }, map: { ...baseMap, ...map } })

  it('mapEvent leaves enriched fields to the host and reports them as pending', () => {
    const { record, report, pending } = mapEvent(txnRoute, transaction, '2026-07-05T09:15:00Z', MASKING_KEY)
    expect(record).toMatchObject({ external_id: 'txn_0a1b2c3d', amount: 12500, date: '2026-07-05' })
    expect(record.metadata).toEqual({ paypoint: 'Acme Field Services' })
    expect(pending).toEqual([
      { field: 'metadata.resident_name', enrichment: 'resident_name', input: 'payor_4471', source: 'PayorId' },
    ])
    expect(report.enriched).toEqual(['metadata.resident_name'])
    expect(report.mapped['metadata.resident_name']).toBe('PayorId → enrich:resident_name')
    // The lookup key was used, so it is not "kept local".
    expect(report.not_forwarded).not.toContain('PayorId')
    expect(report.not_forwarded).toContain('ContactUs')
  })

  it('applies transforms before handing the input over, and skips absent sources', () => {
    const route = routeWith({
      description: { source: 'PayorId', transform: ['trim', 'lowercase'], enrich: 'summary' },
      metadata: { unit: { source: 'Missing', enrich: 'unit' } },
    })
    const { record, pending, report } = mapEvent(route, { ...(transaction as object), PayorId: '  PAYOR_1 ' } as Json, '2026-07-05T00:00:00Z', MASKING_KEY)
    expect(pending).toEqual([{ field: 'description', enrichment: 'summary', input: 'payor_1', source: 'PayorId' }])
    expect(record.description).toBeUndefined()
    expect(record.metadata).toEqual({})
    expect(report.enriched).toEqual(['description'])
  })

  it('the schema allows enrich only on description and metadata', () => {
    expect(() => routeWith({ external_id: { source: 'TransactionId', enrich: 'e' } })).toThrow()
    expect(() => routeWith({ amount: { source: 'NetAmount', enrich: 'e' } })).toThrow()
    expect(() => routeWith({ metadata: { r: { source: 'PayorId', enrich: 'Not-Snake' } } })).toThrow(/snake_case/)
    expect(routeWith({ description: { source: 'PayorId', enrich: 'e' } }).map.description).toEqual({ source: 'PayorId', enrich: 'e' })
  })

  it('a sensitive output name stays forbidden for enriched fields even with hash', () => {
    // hash protects a forwarded source value...
    expect(() => routeWith({ metadata: { ssn: { source: 'X', transform: 'hash' } } })).not.toThrow()
    // ...but not an enriched output, which forwards whatever the host returns.
    expect(() => routeWith({ metadata: { ssn: { source: 'X', transform: 'hash', enrich: 'e' } } })).toThrow(
      /an enriched field cannot use it as an output name/,
    )
    expect(() => routeWith({ metadata: { ssn: { source: 'X', enrich: 'e' } } })).toThrow(/hard denylist/)
  })

  it('parseRoutes rejects enrichments the host has not registered', () => {
    expect(() => parseRoutes(parse(TRANSACTION_ROUTES_YAML))).toThrow(
      /route payabli-transactions: metadata.resident_name references unknown enrichment "resident_name"/,
    )
    expect(() => parseRoutes(parse(TRANSACTION_ROUTES_YAML), { enrichments: { other: () => 1 } })).toThrow(/unknown enrichment/)
    expect(parseRoutes(parse(TRANSACTION_ROUTES_YAML), { enrichments })).toHaveLength(1)
  })
})
