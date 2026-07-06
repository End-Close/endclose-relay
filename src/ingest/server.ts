import Fastify, { type FastifyInstance } from 'fastify'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import type { Db } from '../db/db.js'
import { EventsRepo } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo } from '../db/repo/kv.js'
import { encrypt } from '../crypto/at-rest.js'
import { adapterFor } from './adapters/registry.js'
import type { Json } from '../mask/paths.js'
import { log } from '../log.js'

// Headers persisted alongside the payload for debugging/replay. Auth headers are
// deliberately excluded — secrets never reach the database.
const PERSISTED_HEADERS = ['content-type', 'user-agent']

export interface IngestDeps {
  db: Db
  dataKey: Buffer
  /** Emits 'event' whenever a new deliverable event lands, so the dispatcher wakes immediately. */
  signal: EventEmitter
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
  const { db, dataKey, signal } = deps
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
      return reply.code(503).send({ error: 'relay is in panic mode' })
    }

    const rawBody = request.body as Buffer
    if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
      return reply.code(400).send({ error: 'empty body' })
    }
    if (rawBody.length > route.max_body_bytes) {
      return reply.code(413).send({ error: 'body too large' })
    }

    const adapter = adapterFor(route.source)
    const raw = { rawBody, headers: request.headers, remoteIp: request.ip }
    const verdict = adapter.verify(raw, route)
    if (!verdict.ok) {
      log.warn('ingest rejected', { route: routeId, reason: verdict.reason })
      return reply.code(401).send({ error: 'verification failed' })
    }

    let body: Json
    try {
      body = JSON.parse(rawBody.toString('utf8')) as Json
    } catch {
      return reply.code(400).send({ error: 'invalid JSON' })
    }

    const eventId = adapter.extractEventId(body, raw, route)
    const eventType = adapter.extractEventType(body, raw, route)
    const filtered = route.filter && !eventTypeMatches(route.filter.event_types, eventType)

    const { ciphertext, iv } = encrypt(dataKey, rawBody)
    const headersJson = JSON.stringify(
      Object.fromEntries(
        PERSISTED_HEADERS.map((h) => [h, request.headers[h]]).filter(([, v]) => v !== undefined),
      ),
    )

    const insertedId = events.insert({
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
    })

    if (insertedId === null) {
      log.info('duplicate event acked', { route: routeId, event_type: eventType })
      return reply.code(200).send({ status: 'duplicate' })
    }

    log.info('event ingested', {
      route: routeId,
      event_type: eventType,
      filtered: Boolean(filtered),
    })
    if (!filtered) signal.emit('event', routeId)
    return reply.code(200).send({ status: filtered ? 'filtered' : 'accepted' })
  })

  return app
}
