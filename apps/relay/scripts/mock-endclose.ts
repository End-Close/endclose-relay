// Standalone mock of the End Close API for local development (see mprocs.yaml).
// Accepts POST /v1/records/bulk and prints every record it receives, so you can watch
// exactly what the relay forwards. GET /v1/relays/config serves the routes document in
// MOCK_EC_CONFIG (default dev/relay.dev.yaml; 404 when the file is missing) — the
// relay fetches it when it boots without a stored config or seed file, e.g.
// `RELAY_CONFIG= pnpm dev`.
import { createServer } from 'node:http'
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
        return res.end('{"error":"no relay configuration for this key"}')
      }
      const doc = parse(readFileSync(CONFIG_PATH, 'utf8')) as { routes: unknown }
      console.log(`\n── relay config served from ${CONFIG_PATH} (${apiKeyNote(req.headers['x-api-key'])})`)
      res.statusCode = 200
      return res.end(JSON.stringify({ environment: 'development', routes: doc.routes }))
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
