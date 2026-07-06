import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { payabliAdapter } from '../src/ingest/adapters/payabli.js'
import { genericHmacAdapter } from '../src/ingest/adapters/generic-hmac.js'
import { routeSchema } from '../src/config/schema.js'
import type { Json } from '../src/mask/paths.js'
import { FIXTURES } from './helpers.js'

const settlementRaw = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))
const settlement = JSON.parse(settlementRaw.toString()) as Json

const payabliRoute = routeSchema.parse({
  id: 'payabli-settlements',
  source: 'payabli',
  auth: {
    mode: 'static_header',
    header: 'authorization',
    secret_env: 'PAYABLI_WEBHOOK_SECRET',
    allowed_ips: ['54.166.54.170'],
  },
  map: {
    data_stream_key: 'x',
    external_id_pointer: '/transferId',
    amount_pointer: '/NetAmount',
    direction: 'credit',
  },
})

function req(headers: Record<string, string>, ip = '54.166.54.170', body: Buffer = settlementRaw) {
  return { rawBody: body, headers, remoteIp: ip }
}

beforeEach(() => {
  process.env.PAYABLI_WEBHOOK_SECRET = 'Bearer s3cret'
})

describe('payabli adapter', () => {
  it('accepts matching header + allowed ip', () => {
    expect(payabliAdapter.verify(req({ authorization: 'Bearer s3cret' }), payabliRoute)).toEqual({
      ok: true,
    })
  })
  it('rejects wrong header value', () => {
    expect(payabliAdapter.verify(req({ authorization: 'Bearer nope' }), payabliRoute)).toMatchObject(
      { ok: false, reason: 'bad auth header' },
    )
  })
  it('rejects missing header and bad ip', () => {
    expect(payabliAdapter.verify(req({}), payabliRoute)).toMatchObject({ ok: false })
    expect(
      payabliAdapter.verify(req({ authorization: 'Bearer s3cret' }, '10.0.0.1'), payabliRoute),
    ).toMatchObject({ ok: false, reason: 'source ip not allowed' })
  })
  it('extracts stable event ids per event type', () => {
    expect(payabliAdapter.extractEventId(settlement, req({}), payabliRoute)).toBe(
      'TransferFunded:trf_9f8e7d6c',
    )
    const batch = { Event: 'PayOutBatchPaid', BatchId: '341' }
    expect(payabliAdapter.extractEventId(batch, req({}), payabliRoute)).toBe('PayOutBatchPaid:341')
  })
  it('falls back to a body hash for unknown events', () => {
    const id = payabliAdapter.extractEventId({ Event: 'Mystery' }, req({}), payabliRoute)
    expect(id).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('generic hmac adapter', () => {
  const route = routeSchema.parse({
    id: 'generic',
    source: 'generic_hmac',
    auth: {
      mode: 'hmac',
      header: 'x-signature',
      secret_env: 'GENERIC_SECRET',
      signed_content: 'timestamp.body',
      timestamp_header: 'x-timestamp',
      event_id_pointer: '/id',
    },
    map: {
      data_stream_key: 'x',
      external_id_pointer: '/id',
      amount_pointer: '/amount',
      direction: 'credit',
    },
  })

  it('verifies timestamp.body signatures and rejects stale/bad ones', () => {
    process.env.GENERIC_SECRET = 'topsecret'
    const body = Buffer.from('{"id":"evt_1","amount":"5.00"}')
    const ts = String(Math.floor(Date.now() / 1000))
    const sig = createHmac('sha256', 'topsecret').update(`${ts}.${body.toString()}`).digest('hex')

    expect(
      genericHmacAdapter.verify(
        { rawBody: body, headers: { 'x-signature': sig, 'x-timestamp': ts }, remoteIp: '1.1.1.1' },
        route,
      ),
    ).toEqual({ ok: true })

    expect(
      genericHmacAdapter.verify(
        {
          rawBody: body,
          headers: { 'x-signature': `sha256=${sig}`, 'x-timestamp': ts },
          remoteIp: '1.1.1.1',
        },
        route,
      ),
    ).toEqual({ ok: true })

    const staleTs = String(Math.floor(Date.now() / 1000) - 3600)
    const staleSig = createHmac('sha256', 'topsecret')
      .update(`${staleTs}.${body.toString()}`)
      .digest('hex')
    expect(
      genericHmacAdapter.verify(
        {
          rawBody: body,
          headers: { 'x-signature': staleSig, 'x-timestamp': staleTs },
          remoteIp: '1.1.1.1',
        },
        route,
      ),
    ).toMatchObject({ ok: false, reason: 'stale timestamp' })

    expect(
      genericHmacAdapter.verify(
        {
          rawBody: body,
          headers: { 'x-signature': 'deadbeef', 'x-timestamp': ts },
          remoteIp: '1.1.1.1',
        },
        route,
      ),
    ).toMatchObject({ ok: false, reason: 'bad signature' })
  })
})
