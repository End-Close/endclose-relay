import Fastify, { type FastifyInstance } from 'fastify'
import type { IngestResult, Logger, RawRequest } from '@end-close/relay'

// The application's webhook listener: a thin Fastify shell around the engine's ingest path.

export interface IngestDeps {
  ingest(routeId: string, req: RawRequest): Promise<IngestResult>
  logger?: Logger
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

  // The engine classifies store failures itself; anything that still escapes is a bug,
  // and the processor must not see its message (it may name paths or SQL state).
  app.setErrorHandler((err, request, reply) => {
    deps.logger?.error('ingest handler failed', { url: request.url, error: (err as Error).message })
    return reply.code(500).send({ error: 'internal error' })
  })

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
