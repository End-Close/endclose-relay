import Fastify, { type FastifyInstance } from 'fastify'
import fastifyStatic from '@fastify/static'
import { timingSafeEqual } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Db } from '../db/db.js'
import { EventsRepo, type EventStatus } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo, type GlobalKillswitch } from '../db/repo/kv.js'
import { AuditRepo } from '../db/repo/audit.js'
import { parseConfig } from '../config/load.js'
import {
  getActiveConfig,
  getConfigVersion,
  listConfigVersions,
  saveConfig,
} from '../config/store.js'
import { mapEvent, MappingError } from '../forward/mapper.js'
import type { Json } from '../mask/paths.js'
import { VERSION } from '../version.js'
import { log } from '../log.js'

// The admin plane is the single management surface (UI + API). Basic auth is mandatory;
// mutations additionally reject cross-site browser requests. Attribution is
// instance-level: audit entries record the interface, not a person.

const ACTOR = 'admin'

export interface AdminDeps {
  db: Db
  dbPath: string
  startedAt: number
  /** "user:password" — required. */
  basicAuth: string
  maskingKey: Buffer
  bootConfigHash: string
}

export function buildAdminServer(deps: AdminDeps): FastifyInstance {
  const events = new EventsRepo(deps.db)
  const routes = new RoutesRepo(deps.db)
  const kv = new KvRepo(deps.db)
  const audit = new AuditRepo(deps.db)

  const app = Fastify({ logger: false, bodyLimit: 5 * 1024 * 1024 })

  const expectedAuth = 'Basic ' + Buffer.from(deps.basicAuth, 'utf8').toString('base64')
  app.addHook('onRequest', async (request, reply) => {
    const presented = Buffer.from(request.headers.authorization ?? '', 'utf8')
    const expected = Buffer.from(expectedAuth, 'utf8')
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
      await new Promise((r) => setTimeout(r, 250)) // blunt brute-force damper
      return reply
        .code(401)
        .header('www-authenticate', 'Basic realm="endclose-relay"')
        .send({ error: 'unauthorized' })
    }
  })

  // Browsers attach cached basic-auth credentials to cross-site requests; refuse
  // mutations that a third-party page could have triggered. Non-browser clients don't
  // send Sec-Fetch-Site and must present credentials explicitly, so they pass.
  app.addHook('preHandler', async (request, reply) => {
    if (request.method === 'GET' || request.method === 'HEAD') return
    const site = request.headers['sec-fetch-site']
    if (site && site !== 'same-origin' && site !== 'none') {
      return reply.code(403).send({ error: 'cross-site request refused' })
    }
  })

  // The React management UI (ui/ → dist/admin-ui via `pnpm build`).
  const uiDir = join(dirname(fileURLToPath(import.meta.url)), '../..', 'dist/admin-ui')
  if (existsSync(join(uiDir, 'index.html'))) {
    app.register(fastifyStatic, { root: uiDir })
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .header('content-type', 'text/html')
        .send('<!doctype html><title>endclose-relay</title><body>endclose-relay admin — UI not built (run <code>pnpm build</code>); the JSON API is at <a href="/status">/status</a>.'),
    )
  }

  app.get('/status', async () => {
    const stats = new Map(events.perRouteStats().map((s) => [s.route_id, s]))
    const now = Date.now()
    const current = deps.db
      .prepare('SELECT config_hash, applied_at FROM config_versions ORDER BY id DESC LIMIT 1')
      .get() as { config_hash: string; applied_at: string } | undefined
    return {
      version: VERSION,
      uptime_s: Math.round((now - deps.startedAt) / 1000),
      config_hash: current?.config_hash ?? null,
      config_applied_at: current?.applied_at ?? null,
      restart_pending: current !== undefined && current.config_hash !== deps.bootConfigHash,
      killswitch: {
        global: kv.globalKillswitch(),
        routes_paused: routes
          .all()
          .filter((r) => routes.isPaused(r.id))
          .map((r) => r.id),
      },
      queue: events.countByStatus(),
      routes: routes.all().map((r) => {
        const s = stats.get(r.id)
        return {
          id: r.id,
          source: r.source,
          data_stream_key: r.map.data_stream_key,
          paused: routes.isPaused(r.id),
          counts: s?.counts ?? {},
          last_delivered_at: s?.last_delivered_at ?? null,
          oldest_pending_age_s: s?.oldest_pending_at
            ? Math.round((now - Date.parse(s.oldest_pending_at)) / 1000)
            : null,
        }
      }),
      storage: { db_path: deps.dbPath, db_bytes: dbBytes(deps.dbPath) },
    }
  })

  app.post('/killswitch', async (request, reply) => {
    const { state } = (request.body ?? {}) as { state?: string }
    if (state !== 'none' && state !== 'pause' && state !== 'panic') {
      return reply.code(400).send({ error: 'state must be none|pause|panic' })
    }
    const before = kv.globalKillswitch()
    kv.setGlobalKillswitch(state as GlobalKillswitch)
    audit.log(ACTOR, 'killswitch.' + state, { before })
    log.warn('killswitch changed', { before, after: state })
    return { global: state }
  })

  app.post('/routes/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { paused } = (request.body ?? {}) as { paused?: boolean }
    if (!routes.get(id)) return reply.code(404).send({ error: 'unknown route' })
    if (typeof paused !== 'boolean') return reply.code(400).send({ error: 'paused must be boolean' })
    routes.setPaused(id, paused)
    audit.log(ACTOR, paused ? 'route.pause' : 'route.resume', { route: id })
    return { route: id, paused }
  })

  app.get('/events', async (request) => {
    const q = request.query as { status?: EventStatus; route?: string; limit?: string }
    return events.list({
      ...(q.status ? { status: q.status } : {}),
      ...(q.route ? { route: q.route } : {}),
      limit: q.limit ? Number(q.limit) : 50,
    })
  })

  app.post('/events/:id/replay', async (request, reply) => {
    const id = Number((request.params as { id: string }).id)
    if (!events.replay(id)) {
      return reply.code(409).send({ error: 'event not found or not parked' })
    }
    audit.log(ACTOR, 'event.replay', { event_id: id })
    return { replayed: id }
  })

  app.post('/events/replay-parked', async () => {
    const count = events.replayAllParked()
    if (count > 0) audit.log(ACTOR, 'event.replay_all_parked', { count })
    return { replayed: count }
  })

  app.get('/audit', async (request) => {
    const q = request.query as { limit?: string }
    return deps.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(q.limit ? Number(q.limit) : 100)
  })

  // ── config management (DB-authoritative; YAML is the interchange format) ──────

  app.get('/config', async (_req, reply) => {
    const active = getActiveConfig(deps.db)
    if (!active) return reply.code(404).send({ error: 'no config' })
    return { yaml: active.yamlText, hash: active.hash }
  })

  app.post('/config/validate', async (request) => {
    const { yaml } = (request.body ?? {}) as { yaml?: string }
    try {
      const loaded = parseConfig(yaml ?? '')
      return {
        valid: true,
        hash: loaded.hash,
        routes: loaded.config.routes.map((r) => r.id),
        secret_envs: envStatus(loaded.config),
      }
    } catch (err) {
      return { valid: false, error: (err as Error).message }
    }
  })

  app.post('/config', async (request, reply) => {
    const { yaml } = (request.body ?? {}) as { yaml?: string }
    if (!yaml) return reply.code(400).send({ error: 'yaml required' })
    let loaded
    try {
      loaded = saveConfig(deps.db, yaml, ACTOR)
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
    return {
      applied: loaded.hash,
      // Route changes apply live; ports/endclose/dispatch changes need a restart.
      restart_pending: loaded.hash !== deps.bootConfigHash,
    }
  })

  // Preview a route's mapping against a sample payload — works on DRAFT yaml so the
  // sign-off ceremony can iterate before anything is saved. Local only; sends nothing.
  app.post('/config/preview', async (request, reply) => {
    const { yaml, route: routeId, sample } = (request.body ?? {}) as {
      yaml?: string
      route?: string
      sample?: Json
    }
    if (!routeId || sample === undefined) {
      return reply.code(400).send({ error: 'route and sample required' })
    }
    let config
    try {
      config = yaml ? parseConfig(yaml).config : getActiveConfig(deps.db)?.config
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
    const route = config?.routes.find((r) => r.id === routeId)
    if (!route) return reply.code(404).send({ error: `unknown route: ${routeId}` })
    try {
      const { record, report } = mapEvent(route, sample, new Date().toISOString(), deps.maskingKey)
      return { record, report }
    } catch (err) {
      if (err instanceof MappingError) return reply.code(422).send({ error: err.message })
      throw err
    }
  })

  app.get('/config/versions', async () => listConfigVersions(deps.db))

  app.get('/config/versions/:id', async (request, reply) => {
    const version = getConfigVersion(deps.db, Number((request.params as { id: string }).id))
    if (!version) return reply.code(404).send({ error: 'unknown version' })
    return version
  })

  return app
}

function envStatus(config: { endclose: { api_key_env: string }; routes: { auth: { secret_env: string } }[] }) {
  const names = [
    'RELAY_DATA_KEY',
    'MASKING_HMAC_KEY',
    ...new Set([config.endclose.api_key_env, ...config.routes.map((r) => r.auth.secret_env)]),
  ]
  return names.map((name) => ({ name, set: Boolean(process.env[name]) }))
}

function dbBytes(dbPath: string): number {
  try {
    return statSync(dbPath).size
  } catch {
    return 0
  }
}
