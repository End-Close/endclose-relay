import { createHash } from 'node:crypto'
import type { EventEmitter } from 'node:events'
import { StoreUnavailableError, type ControlStore, type EventStore, type RouteProvider } from './store.js'
import type { PayloadCodec } from './codec.js'
import { adapterFor } from '../ingest/adapters/registry.js'
import type { ProcessorAdapter, RawRequest } from '../ingest/adapters/types.js'
import type { Json } from '../mask/paths.js'
import { RelayHooks, type IngestOutcome } from './hooks.js'
import { noopLogger, type Logger } from '../logger.js'
import type { SecretResolver } from './secrets.js'
import { jsonTopLevelKeys, requestHeaderNames } from '../util/payload-shape.js'

// The framework-agnostic ingest path: verify → encrypt → persist → ack. A host adapts its
// HTTP request into a RawRequest and maps the IngestResult back onto its response.

// Headers persisted alongside the payload for debugging/replay. Auth headers are
// deliberately excluded — secrets never reach the database.
const PERSISTED_HEADERS = ['content-type', 'user-agent']

export interface IngestDeps {
  store: EventStore
  control: ControlStore
  routes: RouteProvider
  secrets: SecretResolver
  /** How buffered payloads are stored (encrypted or plain). */
  codec: PayloadCodec
  /** Emits 'event' whenever a new deliverable event lands, so the dispatcher wakes immediately. */
  signal?: EventEmitter
  hooks?: RelayHooks
  logger?: Logger
  /** Additional processor adapters keyed by route `source` (override built-ins by name). */
  adapters?: Record<string, ProcessorAdapter>
}

export type IngestResultOutcome =
  | IngestOutcome
  | 'unknown_route'
  | 'secret_unavailable'
  | 'persist_failed'
  | 'unavailable'

/** HTTP-shaped so any host can answer the processor without knowing the engine's rules. */
export interface IngestResult {
  status: 200 | 400 | 401 | 404 | 413 | 500 | 503
  body: { status: string } | { error: string }
  outcome: IngestResultOutcome
  /** Store id of the buffered event; present for `accepted` and `filtered`. Correlate with the `settled` hook. */
  id?: string
}

export function eventTypeMatches(patterns: string[], eventType: string | null): boolean {
  if (patterns.length === 0) return true
  if (eventType === null) return false
  return patterns.some((p) =>
    p.includes('*') ? new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`).test(eventType) : p === eventType,
  )
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Idempotency key for one inbound event: stable across redeliveries of the same processor event. */
export function eventIdempotencyKey(source: string, eventId: string): string {
  return 'sha256:' + createHash('sha256').update(`${source}:${eventId}`).digest('hex')
}

export async function ingestWebhook(
  deps: IngestDeps,
  routeId: string,
  raw: RawRequest,
): Promise<IngestResult> {
  const { store, control, routes, secrets, codec, signal } = deps
  const hooks = deps.hooks ?? new RelayHooks()
  const logger = deps.logger ?? noopLogger

  const route = await routes.get(routeId)
  if (!route) return { status: 404, body: { error: 'unknown route' }, outcome: 'unknown_route' }

  const { rawBody } = raw
  const bodyBytes = Buffer.isBuffer(rawBody) ? rawBody.length : 0
  const ingested = (outcome: IngestOutcome, eventType: string | null = null) =>
    hooks.emit('ingest', { routeId, outcome, eventType, bodyBytes })

  // Panic refuses at the door; the processor's own retries carry the window.
  if ((await control.getKillswitch()) === 'panic') {
    ingested('panic')
    return { status: 503, body: { error: 'relay is in panic mode' }, outcome: 'panic' }
  }

  if (!Buffer.isBuffer(rawBody) || rawBody.length === 0) {
    ingested('rejected_json')
    return { status: 400, body: { error: 'empty body' }, outcome: 'rejected_json' }
  }
  if (rawBody.length > route.max_body_bytes) {
    ingested('rejected_size')
    return { status: 413, body: { error: 'body too large' }, outcome: 'rejected_size' }
  }

  const adapter = adapterFor(route.source, deps.adapters)
  const secret = secrets.resolve(route.auth.secret_env)
  if (secret === undefined) {
    logger.error('ingest secret unavailable', { route: routeId, secret_env: route.auth.secret_env })
    return { status: 500, body: { error: 'internal error' }, outcome: 'secret_unavailable' }
  }
  const verdict = adapter.verify(raw, route, { secret })
  if (!verdict.ok) {
    ingested('rejected_auth')
    logger.warn('ingest rejected', { route: routeId, reason: verdict.reason })
    return { status: 401, body: { error: 'verification failed' }, outcome: 'rejected_auth' }
  }

  let body: Json
  try {
    body = JSON.parse(rawBody.toString('utf8')) as Json
  } catch {
    ingested('rejected_json')
    return { status: 400, body: { error: 'invalid JSON' }, outcome: 'rejected_json' }
  }

  const eventId = adapter.extractEventId(body, raw, route)
  const eventType = adapter.extractEventType(body, raw, route)
  const filtered = Boolean(route.events && !eventTypeMatches(route.events, eventType))
  // Shape-only debug metadata (no values).
  logger.debug('ingest shape', {
    route: routeId,
    event_type: eventType,
    body_bytes: rawBody.length,
    remote_ip: raw.remoteIp,
    header_names: requestHeaderNames(raw.headers as Record<string, unknown>),
    payload_keys: jsonTopLevelKeys(body),
  })

  const { payload, iv } = codec.encode(rawBody)
  const headersJson = JSON.stringify(
    Object.fromEntries(
      PERSISTED_HEADERS.map((h) => [h, raw.headers[h]]).filter(([, v]) => v !== undefined),
    ),
  )

  let inserted
  try {
    inserted = await store.insert({
      route_id: routeId,
      source: route.source,
      event_id: eventId,
      event_type: eventType,
      payload,
      payload_iv: iv,
      headers_json: headersJson,
      received_at: new Date().toISOString(),
      status: filtered ? 'dropped_by_filter' : 'pending',
      idempotency_key: eventIdempotencyKey(route.source, eventId),
    })
  } catch (err) {
    logger.error('ingest persist failed', { route: routeId, error: (err as Error).message })
    hooks.emit('error', { kind: 'ingest_persist', error: err, routeId })
    if (err instanceof StoreUnavailableError) {
      return { status: 503, body: { error: 'temporarily unavailable' }, outcome: 'unavailable' }
    }
    return { status: 500, body: { error: 'internal error' }, outcome: 'persist_failed' }
  }

  if (inserted.duplicate) {
    ingested('duplicate', eventType)
    logger.info('duplicate event acked', { route: routeId, event_type: eventType })
    return { status: 200, body: { status: 'duplicate' }, outcome: 'duplicate' }
  }

  ingested(filtered ? 'filtered' : 'accepted', eventType)
  hooks.emit('stored', { routeId, id: inserted.id, filtered })
  logger.info('event ingested', { route: routeId, event_type: eventType, filtered })
  if (!filtered) signal?.emit('event', routeId)
  return {
    status: 200,
    body: { status: filtered ? 'filtered' : 'accepted' },
    outcome: filtered ? 'filtered' : 'accepted',
    id: inserted.id,
  }
}
