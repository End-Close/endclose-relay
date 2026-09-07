import Fastify, { type FastifyInstance } from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import type { Metrics } from './metrics.js'

export interface MetricsServerDeps {
  metrics: Metrics
  /** Liveness of the storage layer, e.g. a `SELECT 1`. */
  ready: () => boolean
  /** Optional "user:pass" guard for /metrics (METRICS_BASIC_AUTH). */
  basicAuth?: string | undefined
}

export function buildMetricsServer(deps: MetricsServerDeps): FastifyInstance {
  const app = Fastify({ logger: false })

  app.get('/healthz', async () => ({ ok: true }))

  app.get('/readyz', async (_req, reply) => {
    if (!deps.ready()) return reply.code(503).send({ ok: false })
    return { ok: true }
  })

  app.get('/metrics', async (request, reply) => {
    if (deps.basicAuth) {
      const header = request.headers.authorization ?? ''
      const expected = 'Basic ' + Buffer.from(deps.basicAuth, 'utf8').toString('base64')
      const a = Buffer.from(header, 'utf8')
      const b = Buffer.from(expected, 'utf8')
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(401).header('www-authenticate', 'Basic realm="relay"').send('unauthorized')
      }
    }
    reply.header('content-type', deps.metrics.registry.contentType)
    return deps.metrics.registry.metrics()
  })

  return app
}
