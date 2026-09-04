import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Db } from '../db/db.js'
import { EventsRepo } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo } from '../db/repo/kv.js'
import { INGEST_BUSY_RETRY_ATTEMPTS, isSqliteBusy, withBusyRetry } from '../db/busy.js'
import { encrypt } from '../crypto/at-rest.js'
import { adapterFor } from './adapters/registry.js'
import type { Json } from '../mask/paths.js'
import type { Metrics } from '../metrics/metrics.js'
import type { Telemetry } from '../forward/telemetry.js'
import { log, type Logger } from '../log.js'
import { jsonTopLevelKeys, requestHeaderNames } from '../util/payload-shape.js'

// Headers persisted alongside the payload for debugging/replay. Auth headers are
// deliberately excluded — secrets never reach the database.
const PERSISTED_HEADERS = ['content-type', 'user-agent']

export interface IngestDeps {
  db: Db
  dataKey: Buffer
  /** Emits 'event' whenever a new deliverable event lands, so the dispatcher wakes immediately. */
  signal: EventEmitter
  metrics: Metrics
  telemetry?: Telemetry
  logger?: Logger
}

function eventTypeMatches(patterns: string[], eventType: string | null): boolean {
  if (patterns.length === 0) return true
  if (eventType === null) return false
  return patterns.some((p) =>
    p.includes('*') ? new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`).test(eventType) : p === eventType,
  )
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function buildIngestServer(deps: IngestDeps): FastifyInstance {
  const { db, dataKey, signal, metrics, telemetry } = deps
  const logger = deps.logger ?? log
  const events = new EventsRepo(db)
  const routes = new RoutesRepo(db)
  const kv = new KvRepo(db)

  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024, // hard ceiling; per-route limits enforced below
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
    const route = routes.get(routeId)
    if (!route) return reply.code(404).send({ error: 'unknown route' })

    // Panic refuses at the door; the processor's own retries carry the window.
    if (kv.globalKillswitch() === 'panic') {
      metrics.ingest(routeId, 'panic')
      return reply.code(503).send({ error: 'relay is in panic mode' })
    }

    const rawBody = request.body as Buffer
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      metrics.ingest(routeId, 'rejected_json')
      return reply.code(400).send({ error: 'empty body' })
    }
    if (rawBody.length > route.max_body_bytes) {
      metrics.ingest(routeId, 'rejected_size')
      return reply.code(413).send({ error: 'body too large' })
    }

    const adapter = adapterFor(route.source)
    const raw = { rawBody, headers: request.headers, remoteIp: request.ip }
    const verdict = adapter.verify(raw, route)
    if (!verdict.ok) {
      metrics.ingest(routeId, 'rejected_auth')
      logger.warn('ingest rejected', { route: routeId, reason: verdict.reason })
      return reply.code(401).send({ error: 'verification failed' })
    }

    let body: Json
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Json
    } catch {
      metrics.ingest(routeId, 'rejected_json')
      return reply.code(400).send({ error: 'invalid JSON' })
    }

    const eventId = adapter.extractEventId(body, raw, route)
    const eventType = adapter.extractEventType(body, raw, route)
    const filtered = route.events && !eventTypeMatches(route.events, eventType)
    // Shape-only debug metadata (no values) — enable with LOG_LEVEL=debug.
    logger.debug('ingest shape', {
      route: routeId,
      event_type: eventType,
      body_bytes: rawBody.length,
      remote_ip: request.ip,
      header_names: requestHeaderNames(request.headers as Record<string, unknown>),
      payload_keys: jsonTopLevelKeys(body),
    })

    const { ciphertext, iv } = encrypt(dataKey, rawBody)
    const headersJson = JSON.stringify(
      Object.fromEntries(
        PERSISTED_HEADERS.map((h) => [h, request.headers[h]]).filter(([, v]) => v !== undefined),
      ),
    )

    let insertedId: number | null
    try {
      insertedId = await withBusyRetry(
        'insert',
        () =>
          events.insert({
            route_id: routeId,
            source: route.source,
            event_id: eventId,
            event_type: eventType,
            payload_enc: ciphertext,
            payload_iv: iv,
            headers_json: headersJson,
            received_at: new Date().toISOString(),
            status: filtered ? 'dropped_by_filter' : 'pending',
            idempotency_key:
              'sha256:' + createHash('sha256').update(`${route.source}:${eventId}`).digest('hex'),
          }),
        { attempts: INGEST_BUSY_RETRY_ATTEMPTS, logger },
      )
    } catch (err) {
      logger.error('ingest persist failed', { route: routeId, error: (err as Error).message })
      telemetry?.captureError('ingest_persist', err, { route: routeId })
      const retryable = isSqliteBusy(err)
      return reply
        .code(retryable ? 503 : 500)
        .send({ error: retryable ? 'temporarily unavailable' : 'internal error' })
    }

    if (insertedId === null) {
      metrics.ingest(routeId, 'duplicate')
      logger.info('duplicate event acked', { route: routeId, event_type: eventType })
      return reply.code(200).send({ status: 'duplicate' })
    }

    metrics.ingest(routeId, filtered ? 'filtered' : 'accepted')
    logger.info('event ingested', {
      route: routeId,
      event_type: eventType,
      filtered: Boolean(filtered),
    })
    if (!filtered) signal.emit('event', routeId)
    return reply.code(200).send({ status: filtered ? 'filtered' : 'accepted' })
  })

  return app
}
