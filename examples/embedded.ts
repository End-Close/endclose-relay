// Minimal embedding with nothing but Node built-ins: the engine mounted on node:http with an
// in-memory store, dispatching once per second. Run from the repo root after
// `pnpm build:packages`:
//
//   ENDCLOSE_API_KEY=... PAYABLI_WEBHOOK_SECRET='Bearer x' pnpm exec tsx examples/embedded.ts
//
// Then POST a Payabli fixture:
//   curl -X POST localhost:9000/webhooks/payabli-settlements -H 'authorization: Bearer x' \
//        --data-binary @test/fixtures/payabli-settlement-funded.json
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { createRelay, parseRoutes, envSecrets, memoryStore, consoleLogger } from '@endclose/relay'

const relay = createRelay({
  routes: parseRoutes(parse(readFileSync('relay.example.yaml', 'utf8'))).map((r) => ({
    ...r,
    auth: { ...r.auth, allowed_ips: [] }, // the example config pins Payabli's egress IP
  })),
  store: memoryStore(),
  secrets: envSecrets(process.env),
  endclose: { apiKey: process.env.ENDCLOSE_API_KEY ?? '', baseUrl: process.env.ENDCLOSE_BASE_URL },
  encryption: 'none',
  maskingKey: 'example-masking-key-not-a-secret',
  logger: consoleLogger,
})
relay.on('delivered', (e) => console.log('delivered', e.routeId))
relay.on('forward', (e) => e.result !== 'delivered' && console.log(e.result, e.routeId, e.count))

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
