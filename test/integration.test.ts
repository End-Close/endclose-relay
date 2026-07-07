import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildIngestServer } from '../src/ingest/server.js'
import { Dispatcher } from '../src/forward/dispatcher.js'
import { EndCloseClient } from '../src/forward/endclose-client.js'
import { EventsRepo } from '../src/db/repo/events.js'
import { KvRepo } from '../src/db/repo/kv.js'
import { DATA_KEY, FIXTURES, MASKING_KEY, setupDb, testConfig } from './helpers.js'

const settlementBody = readFileSync(join(FIXTURES, 'payabli-settlement-funded.json'))
const batchPaidBody = readFileSync(join(FIXTURES, 'payabli-batch-paid.json'))

interface CapturedRequest {
  method: string
  url: string
  headers: Record<string, string | string[] | undefined>
  body: string
}

class MockEndClose {
  server: Server
  requests: CapturedRequest[] = []
  up = true
  port = 0

  constructor() {
    this.server = createServer((req, res) => {
      let data = ''
      req.on('data', (c) => (data += c))
      req.on('end', () => {
        this.requests.push({
          method: req.method!,
          url: req.url!,
          headers: req.headers,
          body: data,
        })
        if (!this.up) {
          res.statusCode = 503
          return res.end('{"error":"down"}')
        }
        if (req.method === 'POST' && req.url === '/v1/records/bulk') {
          res.statusCode = 202
          return res.end(JSON.stringify({ id: 'br_1', status: 'processing' }))
        }
        if (req.method === 'GET' && req.url?.startsWith('/v1/bulk_requests/')) {
          res.statusCode = 200
          return res.end(JSON.stringify({ id: 'br_1', status: 'completed', results: [] }))
        }
        res.statusCode = 404
        res.end('{}')
      })
    })
  }

  async listen(): Promise<number> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.port = (this.server.address() as AddressInfo).port
    return this.port
  }

  bulkPosts(): CapturedRequest[] {
    return this.requests.filter((r) => r.method === 'POST' && r.url === '/v1/records/bulk')
  }

  async close(): Promise<void> {
    // Sever pooled keep-alive connections from the relay's fetch client; otherwise
    // close() waits for them to idle out and the vitest process can linger.
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('ingest → store → forward', () => {
  let mock: MockEndClose
  let db: ReturnType<typeof setupDb>['db']
  let dispatcher: Dispatcher
  let ingest: ReturnType<typeof buildIngestServer>
  let events: EventsRepo

  beforeEach(async () => {
    mock = new MockEndClose()
    const port = await mock.listen()
    const setup = setupDb(port)
    db = setup.db
    events = new EventsRepo(db)
    const config = testConfig(port)
    const client = new EndCloseClient(`http://127.0.0.1:${port}/v1`, 'test-api-key')
    dispatcher = new Dispatcher({
      db,
      config,
      client,
      dataKey: DATA_KEY,
      maskingKey: MASKING_KEY,
      signal: setup.signal,
      metrics: setup.metrics,
    })
    ingest = buildIngestServer({ db, dataKey: DATA_KEY, signal: setup.signal, metrics: setup.metrics })
    await ingest.ready()
    dispatcher.start()
  })

  afterEach(async () => {
    await dispatcher.stop()
    await ingest.close()
    await mock.close()
    db.close()
  })

  const post = (routeId: string, body: Buffer, headers: Record<string, string> = {}) =>
    ingest.inject({
      method: 'POST',
      url: `/ingest/${routeId}`,
      payload: body,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer test-webhook-secret',
        ...headers,
      },
    })

  it('delivers both payabli event types as mapped, masked records', async () => {
    expect((await post('payabli-settlements', settlementBody)).statusCode).toBe(200)
    expect((await post('payabli-batches', batchPaidBody)).statusCode).toBe(200)

    await waitFor(() => (events.countByStatus()['delivered'] ?? 0) === 2)

    const posts = mock.bulkPosts()
    expect(posts.length).toBeGreaterThanOrEqual(2)
    for (const p of posts) {
      expect(p.headers['x-api-key']).toBe('test-api-key')
      expect(p.headers['idempotency-key']).toMatch(/^relay-[0-9a-f]{40}$/)
    }
    const allRecords = posts.flatMap((p) => JSON.parse(p.body).records)
    const settlement = allRecords.find((r: any) => r.data_stream_key === 'payabli_settlements_funded')
    expect(settlement).toMatchObject({
      external_id: 'trf_9f8e7d6c',
      amount: 376287,
      direction: 'credit',
      date: '2026-07-03',
    })
    // only mapped fields appear in metadata, under their configured output names
    expect(settlement.metadata).toHaveProperty('batch_number')
    expect(settlement.metadata).not.toHaveProperty('transferId')
    expect(settlement.metadata).not.toHaveProperty('NetAmount')
    for (const p of posts) expect(JSON.parse(p.body).on_conflict).toBe('skip')

    const batch = allRecords.find((r: any) => r.data_stream_key === 'payabli_batches_paid')
    expect(batch).toMatchObject({ external_id: '341', amount: 1245010, direction: 'debit' })
  })

  it('acks duplicates without redelivering', async () => {
    expect((await post('payabli-settlements', settlementBody)).statusCode).toBe(200)
    const dup = await post('payabli-settlements', settlementBody)
    expect(dup.statusCode).toBe(200)
    expect(JSON.parse(dup.body).status).toBe('duplicate')
    await waitFor(() => (events.countByStatus()['delivered'] ?? 0) === 1)
    expect(Object.values(events.countByStatus()).reduce((a, b) => a + b, 0)).toBe(1)
  })

  it('rejects bad auth and unknown routes', async () => {
    const bad = await post('payabli-settlements', settlementBody, { authorization: 'Bearer wrong' })
    expect(bad.statusCode).toBe(401)
    const unknown = await post('nope', settlementBody)
    expect(unknown.statusCode).toBe(404)
    expect(events.countByStatus()).toEqual({})
  })

  it('filters non-matching event types but persists them', async () => {
    const res = await post('payabli-settlements', batchPaidBody) // wrong event type for route
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body).status).toBe('filtered')
    expect(events.countByStatus()).toEqual({ dropped_by_filter: 1 })
  })

  it('buffers while End Close is down and drains on recovery', async () => {
    mock.up = false
    expect((await post('payabli-settlements', settlementBody)).statusCode).toBe(200)

    await waitFor(() => (events.countByStatus()['retry'] ?? 0) === 1)
    expect(events.countByStatus()['delivered'] ?? 0).toBe(0)

    mock.up = true
    await waitFor(() => (events.countByStatus()['delivered'] ?? 0) === 1)
  })

  it('global pause buffers without forwarding; resume drains', async () => {
    const kv = new KvRepo(db)
    kv.setGlobalKillswitch('pause')
    expect((await post('payabli-batches', batchPaidBody)).statusCode).toBe(200)
    await new Promise((r) => setTimeout(r, 300))
    expect(mock.bulkPosts().length).toBe(0)
    expect(events.countByStatus()['pending']).toBe(1)

    kv.setGlobalKillswitch('none')
    await waitFor(() => (events.countByStatus()['delivered'] ?? 0) === 1)
  })

  it('panic refuses ingest with 503', async () => {
    const kv = new KvRepo(db)
    kv.setGlobalKillswitch('panic')
    expect((await post('payabli-settlements', settlementBody)).statusCode).toBe(503)
    expect(events.countByStatus()).toEqual({})
  })
})
