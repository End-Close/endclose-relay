import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import { openDb, type Db } from './db/db.js'
import { migrate } from './db/migrate.js'
import { seedIfEmpty } from './config/store.js'
import { loadSecretsFile } from './config/secrets.js'
import { deriveKey } from './crypto/keys.js'
import { buildIngestServer } from './ingest/server.js'
import { buildAdminServer } from './admin/server.js'
import { buildSetupServer, checkRequiredEnv } from './admin/setup-server.js'
import { buildMetricsServer } from './metrics/server.js'
import { Metrics } from './metrics/metrics.js'
import { Dispatcher } from './forward/dispatcher.js'
import { EndCloseClient } from './forward/endclose-client.js'
import { EventsRepo } from './db/repo/events.js'
import { KvRepo } from './db/repo/kv.js'
import { VERSION } from './version.js'
import { log } from './log.js'

const DEFAULT_DB_PATH = '/var/lib/endclose-relay/relay.db'

function buildMetrics(db: Db, dbPath: string): Metrics {
  const events = new EventsRepo(db)
  const kv = new KvRepo(db)
  return new Metrics({
    queueDepths: () => events.countByStatus(),
    killswitch: () => kv.globalKillswitch(),
    dbBytes: () => {
      try {
        return statSync(dbPath).size
      } catch {
        return 0
      }
    },
  })
}

function dbReady(db: Db): boolean {
  try {
    db.prepare('SELECT 1').get()
    return true
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  // Strict mode: optionally hydrate the environment from a mounted secrets file before
  // anything validates it.
  const secrets = loadSecretsFile()
  if (secrets.loaded.length > 0) {
    log.info('secrets file loaded', { vars: secrets.loaded.join(', ') })
  }
  if (secrets.error) log.error('secrets file problem', { error: secrets.error })

  // Boot check: with required env missing we can't run — but instead of crash-looping,
  // serve a setup page on the admin port naming exactly what's wrong.
  const missingEnv = checkRequiredEnv(process.env, secrets.error)
  if (missingEnv.length > 0) {
    log.error('setup required: missing/invalid environment', {
      missing: missingEnv.map((m) => `${m.name} (${m.problem})`).join(', '),
    })
    const setup = buildSetupServer(missingEnv)
    await setup.listen({ port: 8081, host: '0.0.0.0' })
    log.warn('serving setup page on :8081 — webhooks are NOT being accepted')
    return
  }

  const dataKey = deriveKey('RELAY_DATA_KEY', process.env.RELAY_DATA_KEY)
  const maskingKey = deriveKey('MASKING_HMAC_KEY', process.env.MASKING_HMAC_KEY)
  const adminAuth = process.env.ADMIN_BASIC_AUTH!

  const dbPath = process.env.RELAY_DB_PATH ?? DEFAULT_DB_PATH
  const db = openDb(dbPath)
  migrate(db)

  // DB is authoritative; RELAY_CONFIG only seeds an empty database on first boot.
  const loaded = seedIfEmpty(db, process.env.RELAY_CONFIG ?? '/etc/endclose-relay/relay.yaml')

  if (!loaded) {
    // Bootstrap mode: no config yet. Serve the (authenticated) admin UI so the initial
    // config can be entered; ingest and dispatch stay down. After the first apply the
    // process exits cleanly and the container restart policy boots it into running mode.
    log.warn('no configuration — bootstrap mode: admin UI on :8081, webhooks NOT accepted')
    const metrics = buildMetrics(db, dbPath)
    let restarting = false
    const admin = buildAdminServer({
      db,
      dbPath,
      startedAt: Date.now(),
      basicAuth: adminAuth,
      maskingKey,
      bootConfigHash: '',
      mode: 'bootstrap',
      onBootstrapApplied: () => {
        if (restarting) return
        restarting = true
        log.info('initial config applied — restarting into running mode')
        setTimeout(() => process.exit(0), 500) // let the HTTP response flush
      },
    })
    const metricsServer = buildMetricsServer({
      metrics,
      ready: () => dbReady(db),
      basicAuth: process.env.METRICS_BASIC_AUTH,
    })
    await admin.listen({ port: 8081, host: '0.0.0.0' })
    await metricsServer.listen({ port: 9090, host: '0.0.0.0' })
    log.info('bootstrap mode ready', { version: VERSION, admin_port: 8081 })
    return
  }

  const { config } = loaded
  log.info('config active', { config_hash: loaded.hash, routes: config.routes.length })

  const metrics = buildMetrics(db, dbPath)
  const signal = new EventEmitter()
  // A missing API key must not crash the relay: webhooks keep buffering (the point of
  // store-and-forward) and the admin UI banners the missing secret. Forwarding retries
  // until the key is provided and the container restarted.
  const apiKey = process.env[config.endclose.api_key_env] ?? ''
  if (!apiKey) {
    log.error('End Close API key env not set — buffering only, nothing will forward', {
      env: config.endclose.api_key_env,
    })
  }
  const client = new EndCloseClient(config.endclose.base_url, apiKey)

  const dispatcher = new Dispatcher({ db, config, client, dataKey, maskingKey, signal, metrics })
  dispatcher.start()

  const ingest = buildIngestServer({ db, dataKey, signal, metrics })
  const admin = buildAdminServer({
    db,
    dbPath,
    startedAt: Date.now(),
    basicAuth: adminAuth,
    maskingKey,
    bootConfigHash: loaded.hash,
  })
  const metricsServer = buildMetricsServer({
    metrics,
    ready: () => dbReady(db),
    basicAuth: process.env.METRICS_BASIC_AUTH,
  })

  await ingest.listen({ port: config.ingest.port, host: config.ingest.host })
  await admin.listen({ port: config.admin.port, host: config.admin.host })
  await metricsServer.listen({ port: config.metrics.port, host: config.metrics.host })
  log.info('relay started', {
    version: VERSION,
    ingest_port: config.ingest.port,
    admin_port: config.admin.port,
    metrics_port: config.metrics.port,
  })

  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal: sig })
    await ingest.close() // stop accepting webhooks first
    await dispatcher.stop() // drain the in-flight dispatch cycle
    await Promise.all([admin.close(), metricsServer.close()])
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  log.error('fatal boot error', { error: (err as Error).message })
  process.exit(1)
})
