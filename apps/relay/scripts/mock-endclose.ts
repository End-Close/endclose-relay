// Standalone mock of the End Close API for local development (see mprocs.yaml).
// Accepts POST /v1/records/bulk and prints every record it receives, so you can watch
// exactly what the relay forwards.
import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_EC_PORT ?? 4100)
let bulkCounter = 0

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
          ` (X-API-KEY: ${req.headers['x-api-key']}, Idempotency-Key: ${req.headers['idempotency-key']})`,
      )
      for (const r of body.records) console.log(JSON.stringify(r, null, 2))
      res.statusCode = 202
      return res.end(JSON.stringify({ id, status: 'processing' }))
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
