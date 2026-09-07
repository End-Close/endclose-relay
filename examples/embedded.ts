// Minimal embedding with nothing but Node built-ins: the engine mounted on node:http with an
// in-memory store, dispatching once per second. From the repo root:
//
//   pnpm build:packages
//   ENDCLOSE_API_KEY=... PAYABLI_WEBHOOK_SECRET='Bearer x' pnpm --filter @endclose/relay-examples embedded
//
// Then POST a Payabli fixture:
//   curl -X POST localhost:9000/webhooks/payabli-settlements -H 'authorization: Bearer x' \
//        --data-binary @apps/relay/test/fixtures/payabli-settlement-funded.json
// or a transaction, whose resident_name is filled by the enrichment below:
//   curl -X POST localhost:9000/webhooks/payabli-transactions -H 'authorization: Bearer x' \
//        --data-binary @apps/relay/test/fixtures/payabli-transaction.json
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { createRelay, parseRoutes, envSecrets, memoryStore, consoleLogger, type Enrichment } from '@endclose/relay'

// Stand-in for the host's own database: payer id → resident. In a real backend this is
// a query; the engine never sees the connection and makes no call of its own.
const residents = new Map([['payor_4471', { fullName: 'Pat Example', unit: '12B' }]])
const enrichments: Record<string, Enrichment> = {
  // Receives the value at the field's `source` (PayorId). undefined omits the field;
  // a throw retries the event later; `throw new EnrichmentError(...)` parks it.
  resident_name: (payorId) => residents.get(String(payorId))?.fullName,
}

// The shipped example config stays routes-only; the transaction route with its enriched
// field is added here, where the enrichment it names is registered.
const transactionRoutes = `
routes:
  - id: payabli-transactions
    source: payabli
    auth: { mode: static_header, header: authorization, secret_env: PAYABLI_WEBHOOK_SECRET }
    events: ["ApprovedPayment"]
    map:
      data_stream_key: payabli_transactions
      external_id: TransactionId
      amount: NetAmount
      direction: credit
      date: { source: TransactionTime, format: mdy_hms }
      metadata:
        paypoint: Paypoint
        resident_name: { source: PayorId, enrich: resident_name }
`

const relay = createRelay({
  routes: [
    ...parseRoutes(parse(readFileSync(new URL('../relay.example.yaml', import.meta.url), 'utf8'))).map((r) => ({
      ...r,
      auth: { ...r.auth, allowed_ips: [] }, // the example config pins Payabli's egress IP
    })),
    ...parseRoutes(parse(transactionRoutes), { enrichments }),
  ],
  store: memoryStore(),
  secrets: envSecrets(process.env),
  endclose: {
    apiKey: process.env.ENDCLOSE_API_KEY ?? '',
    ...(process.env.ENDCLOSE_BASE_URL ? { baseUrl: process.env.ENDCLOSE_BASE_URL } : {}),
  },
  encryption: 'none',
  maskingKey: 'example-masking-key-not-a-secret',
  enrichments,
  logger: consoleLogger,
})
relay.on('delivered', (e) => console.log('delivered', e.routeId))
relay.on('forward', (e) => e.result !== 'delivered' && console.log(e.result, e.routeId, e.count))
relay.on('enrich', (e) => console.log('enrich', e.field, e.result, e.error ?? ''))

createServer(async (req, res) => {
  const m = req.url?.match(/^\/webhooks\/([a-z0-9-_]+)$/)
  if (req.method !== 'POST' || !m) return res.writeHead(404).end()
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const result = await relay.ingest(m[1]!, {
    rawBody: Buffer.concat(chunks),
    headers: req.headers,
    remoteIp: req.socket.remoteAddress ?? '',
  })
  res.writeHead(result.status, { 'content-type': 'application/json' }).end(JSON.stringify(result.body))
}).listen(9000, () => console.log('listening on :9000'))

setInterval(() => void relay.dispatchOnce().catch((err) => console.error(err)), 1000)
