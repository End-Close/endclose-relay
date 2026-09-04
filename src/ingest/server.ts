import Fastify, { type FastifyInstance } from 'fastify'
import type { RawRequest } from './adapters/types.js'
import type { IngestResult } from '../engine/ingest.js'

// The appliance's webhook listener: a thin Fastify shell around the engine's ingest path.

export interface IngestDeps {
  ingest(routeId: string, req: RawRequest): Promise<IngestResult>
}

export function buildIngestServer(deps: IngestDeps): FastifyInstance {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024, // hard ceiling; per-route limits enforced by the engine
    trustProxy: true,
  })

  // Keep the raw bytes: signature verification and the stored payload must operate on
  // exactly what the processor sent. The default JSON parser is removed so it can't
  // pre-parse application/json bodies.
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body))

  app.get('/healthz', async () => ({ ok: true }))

  app.post('/ingest/:routeId', async (request, reply) => {
    const { routeId } = request.params as { routeId: string }
    const result = await deps.ingest(routeId, {
      rawBody: request.body as Buffer,
      headers: request.headers,
      remoteIp: request.ip,
    })
    return reply.code(result.status).send(result.body)
  })

  return app
}
