import Fastify, { type FastifyInstance } from 'fastify'
import type { EventEmitter } from 'node:events'
import type { ControlStore, EventStore, RouteProvider } from '../engine/store.js'
import type { RelayHooks } from '../engine/hooks.js'
import { log, type Logger } from '../log.js'
import { envSecrets, type SecretResolver } from '../engine/secrets.js'
import { ingestWebhook } from '../engine/ingest.js'

// The appliance's webhook listener: a thin Fastify shell around the engine's ingest path.

export interface IngestDeps {
  store: EventStore
  control: ControlStore
  routes: RouteProvider
  dataKey: Buffer
  /** Emits 'event' whenever a new deliverable event lands, so the dispatcher wakes immediately. */
  signal: EventEmitter
  hooks?: RelayHooks
  logger?: Logger
  /** Where `auth.secret_env` references resolve. Defaults to the process environment. */
  secrets?: SecretResolver
}

export function buildIngestServer(deps: IngestDeps): FastifyInstance {
  const engineDeps = {
    ...deps,
    logger: deps.logger ?? log,
    secrets: deps.secrets ?? envSecrets(),
  }

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
    const result = await ingestWebhook(engineDeps, routeId, {
      rawBody: request.body as Buffer,
      headers: request.headers,
      remoteIp: request.ip,
    })
    return reply.code(result.status).send(result.body)
  })

  return app
}
