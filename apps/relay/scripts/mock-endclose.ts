// Standalone mock of the End Close API for local development (see mprocs.yaml).
// Accepts POST /v1/records/bulk and prints every record it receives, so you can watch
// exactly what the relay forwards. GET /v1/relays/config serves the routes document in
// MOCK_EC_CONFIG (default dev/relay.dev.yaml; 404 when the file is missing) — the
// relay polls it with the ETag it last saw (304 when unchanged) and treats a 200 as End
// Close owning the configuration — start with `RELAY_CONFIG= pnpm dev`, then edit the file
// and watch a new version arrive. PUT /v1/relays/instances/{id} prints each manifest.
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { parse } from 'yaml'

const PORT = Number(process.env.MOCK_EC_PORT ?? 4100)
const CONFIG_PATH = process.env.MOCK_EC_CONFIG ?? 'dev/relay.dev.yaml'
let bulkCounter = 0

// Even a dev mock must not echo credentials: say whether a key was presented, never which.
function apiKeyNote(header: string | string[] | undefined): string {
  return header ? 'X-API-KEY: present' : 'X-API-KEY: missing'
}

createServer((req, res) => {
  let data = ''
  req.on('data', (c) => (data += c))
  req.on('end', () => {
    res.setHeader('content-type', 'application/json')

    if (req.method === 'POST' && req.url === '/v1/records/bulk') {
      const id = `br_dev_${++bulkCounter}`
      const body = JSON.parse(data) as { records: unknown[] }
      console.log(
        `\n── bulk request ${id} ── ${body.records.length} record(s)` +
          ` (${apiKeyNote(req.headers['x-api-key'])}, Idempotency-Key: ${req.headers['idempotency-key']})`,
      )
      for (const r of body.records) console.log(JSON.stringify(r, null, 2))
      res.statusCode = 202
      return res.end(JSON.stringify({ id, status: 'processing' }))
    }

    if (req.method === 'GET' && req.url === '/v1/relays/config') {
      if (!existsSync(CONFIG_PATH)) {
        res.statusCode = 404
        return res.end('{"error":"End Close is not managing this environment"}')
      }
      const doc = parse(readFileSync(CONFIG_PATH, 'utf8')) as { routes: unknown }
      const body = JSON.stringify({ environment: 'development', routes: doc.routes })
      const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 16)}"`
      if (req.headers['if-none-match'] === etag) {
        res.statusCode = 304
        return res.end()
      }
      console.log(`\n── relay config served from ${CONFIG_PATH} (${apiKeyNote(req.headers['x-api-key'])}, ETag ${etag})`)
      res.statusCode = 200
      res.setHeader('etag', etag)
      return res.end(body)
    }

    if (req.method === 'PUT' && req.url?.startsWith('/v1/relays/instances/')) {
      const id = decodeURIComponent(req.url.split('/').pop()!)
      const m = JSON.parse(data) as { reason: string; host: string; config_source: string; capabilities: unknown }
      console.log(
        `\n── instance ${id}: ${m.reason} (${m.host}, config ${m.config_source}, ${apiKeyNote(req.headers['x-api-key'])}) ` +
          JSON.stringify(m.capabilities),
      )
      res.statusCode = 204
      return res.end()
    }

    if (req.method === 'GET' && req.url?.startsWith('/v1/bulk_requests/')) {
      const id = req.url.split('/').pop()
      res.statusCode = 200
      return res.end(JSON.stringify({ id, status: 'completed', results: [] }))
    }

    res.statusCode = 404
    res.end('{"error":"not found"}')
  })
}).listen(PORT, '127.0.0.1', () => {
  console.log(`mock End Close API listening on http://127.0.0.1:${PORT}/v1`)
})
