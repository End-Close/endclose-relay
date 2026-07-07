import Fastify, { type FastifyInstance } from 'fastify'
import { statSync } from 'node:fs'
import type { Db } from '../db/db.js'
import { EventsRepo, type EventStatus } from '../db/repo/events.js'
import { RoutesRepo } from '../db/repo/routes.js'
import { KvRepo, type GlobalKillswitch } from '../db/repo/kv.js'
import { AuditRepo } from '../db/repo/audit.js'
import { loadConfig } from '../config/load.js'
import { applyConfig } from '../config/apply.js'
import { VERSION } from '../version.js'
import { log } from '../log.js'
import { STATUS_PAGE_HTML } from './status-page.js'

// The admin plane binds to loopback by default and carries no authentication: the
// security boundary is host access. It is the ONLY place killswitches can be flipped —
// deliberately not reachable by End Close.

export interface AdminDeps {
  db: Db
  /** Path of the active relay.yaml, for config plan/apply. */
  configPath: string
  dbPath: string
  startedAt: number
}

export function buildAdminServer(deps: AdminDeps): FastifyInstance {
  const events = new EventsRepo(deps.db)
  const routes = new RoutesRepo(deps.db)
  const kv = new KvRepo(deps.db)
  const audit = new AuditRepo(deps.db)

  const app = Fastify({ logger: false })

  app.get('/', async (_req, reply) => reply.header('content-type', 'text/html').send(STATUS_PAGE_HTML))

  app.get('/status', async () => {
    const stats = new Map(events.perRouteStats().map((s) => [s.route_id, s]))
    const now = Date.now()
    const currentConfig = deps.db
      .prepare('SELECT config_hash, applied_at FROM config_versions ORDER BY id DESC LIMIT 1')
      .get() as { config_hash: string; applied_at: string } | undefined
    return {
      version: VERSION,
      uptime_s: Math.round((now - deps.startedAt) / 1000),
      config_hash: currentConfig?.config_hash ?? null,
      config_applied_at: currentConfig?.applied_at ?? null,
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
    const { state, actor } = (request.body ?? {}) as { state?: string; actor?: string }
    if (state !== 'none' && state !== 'pause' && state !== 'panic') {
      return reply.code(400).send({ error: 'state must be none|pause|panic' })
    }
    const before = kv.globalKillswitch()
    kv.setGlobalKillswitch(state as GlobalKillswitch)
    audit.log(actor ?? 'admin-api', 'killswitch.' + state, { before })
    log.warn('killswitch changed', { before, after: state, actor: actor ?? 'admin-api' })
    return { global: state }
  })

  app.post('/routes/:id/pause', async (request, reply) => {
    const { id } = request.params as { id: string }
    const { paused, actor } = (request.body ?? {}) as { paused?: boolean; actor?: string }
    if (!routes.get(id)) return reply.code(404).send({ error: 'unknown route' })
    if (typeof paused !== 'boolean') return reply.code(400).send({ error: 'paused must be boolean' })
    routes.setPaused(id, paused)
    audit.log(actor ?? 'admin-api', paused ? 'route.pause' : 'route.resume', { route: id })
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
    const { actor } = (request.body ?? {}) as { actor?: string }
    if (!events.replay(id)) {
      return reply.code(409).send({ error: 'event not found or not parked' })
    }
    audit.log(actor ?? 'admin-api', 'event.replay', { event_id: id })
    return { replayed: id }
  })

  app.post('/events/replay-parked', async (request) => {
    const { actor } = (request.body ?? {}) as { actor?: string }
    const count = events.replayAllParked()
    if (count > 0) audit.log(actor ?? 'admin-api', 'event.replay_all_parked', { count })
    return { replayed: count }
  })

  app.get('/audit', async (request) => {
    const q = request.query as { limit?: string }
    return deps.db
      .prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT ?')
      .all(q.limit ? Number(q.limit) : 100)
  })

  app.get('/config/plan', async (_req, reply) => {
    let loaded
    try {
      loaded = loadConfig(deps.configPath)
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
    const current = deps.db
      .prepare('SELECT config_hash FROM config_versions ORDER BY id DESC LIMIT 1')
      .get() as { config_hash: string } | undefined
    const runningRoutes = new Set(routes.all().map((r) => r.id))
    const fileRoutes = new Set(loaded.config.routes.map((r) => r.id))
    return {
      file: deps.configPath,
      file_hash: loaded.hash,
      applied_hash: current?.config_hash ?? null,
      in_sync: loaded.hash === current?.config_hash,
      routes_added: [...fileRoutes].filter((r) => !runningRoutes.has(r)),
      routes_removed: [...runningRoutes].filter((r) => !fileRoutes.has(r)),
    }
  })

  app.post('/config/apply', async (request, reply) => {
    const { actor } = (request.body ?? {}) as { actor?: string }
    let loaded
    try {
      loaded = loadConfig(deps.configPath)
      applyConfig(deps.db, loaded, actor ?? 'admin-api')
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message })
    }
    return { applied: loaded.hash }
  })

  return app
}

function dbBytes(dbPath: string): number {
  try {
    return statSync(dbPath).size
  } catch {
    return 0
  }
}
