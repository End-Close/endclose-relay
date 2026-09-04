import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import { openDb, type Db } from './db/db.js'
import { migrate } from './db/migrate.js'
import { resolveActiveConfig, readActiveConfigRaw } from './config/store.js'
import { loadRuntimeSettings, isTelemetryEnabled } from './config/runtime.js'
import { loadSecretsFile } from './config/secrets.js'
import { deriveKey } from './crypto/keys.js'
import { buildIngestServer } from './ingest/server.js'
import { buildAdminServer } from './admin/server.js'
import { buildSetupServer, checkRequiredEnv } from './admin/setup-server.js'
import { isDbPathPersistent } from './db/persistence.js'
import { buildMetricsServer } from './metrics/server.js'
import { Metrics } from './metrics/metrics.js'
import { Dispatcher } from './forward/dispatcher.js'
import { EndCloseClient } from './forward/endclose-client.js'
import { createTelemetry, snapshotFromDb, type Telemetry } from './forward/telemetry.js'
import { EventsRepo } from './db/repo/events.js'
import { KvRepo } from './db/repo/kv.js'
import { VERSION } from './version.js'
import { envSecrets } from './engine/secrets.js'
import { RelayHooks } from './engine/hooks.js'
import { DbRouteProvider, SqliteControlStore, SqliteEventStore } from './db/sqlite-store.js'
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
  // serve a setup page on the admin port naming exactly what's wrong (including a
  // missing data volume, so env and storage get fixed in one redeploy).
  const missingEnv = checkRequiredEnv(process.env, secrets.error)
  if (missingEnv.length > 0) {
    log.error('setup required: missing/invalid environment', {
      missing: missingEnv.map((m) => `${m.name} (${m.problem})`).join(', '),
    })
    await emitSetupTelemetry(missingEnv)
    const setupDbPath = process.env.RELAY_DB_PATH ?? DEFAULT_DB_PATH
    const setup = buildSetupServer(missingEnv, {
      dbPath: setupDbPath,
      persistent: isDbPathPersistent(setupDbPath),
    })
    await setup.listen({ port: 8081, host: '0.0.0.0' })
    log.warn('serving setup page on :8081 — webhooks are NOT being accepted')
    return
  }

  const dataKey = deriveKey('RELAY_DATA_KEY', process.env.RELAY_DATA_KEY)
  const maskingKey = deriveKey('MASKING_HMAC_KEY', process.env.MASKING_HMAC_KEY)
  const adminAuth = process.env.ADMIN_BASIC_AUTH!
  const settings = loadRuntimeSettings()
  const secretResolver = envSecrets(process.env)

  const dbPath = process.env.RELAY_DB_PATH ?? DEFAULT_DB_PATH
  const db = openDb(dbPath)
  migrate(db)

  // DB is authoritative; RELAY_CONFIG only seeds an empty database on first boot.
  const state = resolveActiveConfig(
    db,
    process.env.RELAY_CONFIG ?? '/etc/endclose-relay/relay.yaml',
    secretResolver,
  )

  const apiKey = process.env.ENDCLOSE_API_KEY ?? ''
  const client = new EndCloseClient(settings.endcloseBaseUrl, apiKey)
  const startedAt = Date.now()
  const telemetry = createTelemetry({
    enabled: settings.telemetry.enabled,
    apiKey,
    client,
    version: VERSION,
    startedAt,
  })

  if (state.kind !== 'ok') {
    // Bootstrap mode: no config yet — or a stored config that fails validation (e.g.
    // written under an older schema). Crash-looping on the latter would leave no way to
    // fix it; instead the (authenticated) admin UI serves the setup editor, preloaded
    // with the stored document and its validation error. Ingest and dispatch stay down.
    // After a successful apply the process exits cleanly and the container restart
    // policy boots it into running mode.
    if (state.kind === 'invalid') {
      log.error('stored configuration fails validation — recovery via the admin UI', {
        error: state.error,
      })
      const raw = readActiveConfigRaw(db)
      telemetry.captureError('config_invalid', new Error(state.error), {
        ...(raw?.yamlText ? { config: raw.yamlText } : {}),
      })
    } else {
      log.warn('no configuration — bootstrap mode: admin UI on :8081, webhooks NOT accepted')
    }
    const metrics = buildMetrics(db, dbPath)
    let restarting = false
    const admin = buildAdminServer({
      db,
      dbPath,
      startedAt,
      basicAuth: adminAuth,
      maskingKey,
      dataKey,
      mode: 'bootstrap',
      telemetry,
      secrets: secretResolver,
      ...(state.kind === 'invalid' ? { configError: state.error } : {}),
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
    await admin.listen({ port: settings.admin.port, host: settings.admin.host })
    await metricsServer.listen({ port: settings.metrics.port, host: settings.metrics.host })
    log.info('bootstrap mode ready', { version: VERSION, admin_port: settings.admin.port })
    telemetry.start(() => snapshotFromDb(db, dbPath, startedAt, VERSION))
    telemetry.capture('relay_boot', {
      mode: 'bootstrap',
      persistent: isDbPathPersistent(dbPath),
      route_count: 0,
      has_api_key: Boolean(apiKey),
    })
    return
  }

  const { loaded } = state
  const { config } = loaded
  log.info('config active', { config_hash: loaded.hash, routes: config.routes.length })
  log.info('forwarding to', { base_url: settings.endcloseBaseUrl })

  const metrics = buildMetrics(db, dbPath)
  const signal = new EventEmitter()
  const hooks = new RelayHooks()
  metrics.subscribe(hooks)
  telemetry.subscribe(hooks)
  // A missing API key must not crash the relay: webhooks keep buffering (the point of
  // store-and-forward) and the admin UI banners the missing secret. Forwarding retries
  // until the key is provided and the container restarted.
  if (!apiKey) {
    log.error('ENDCLOSE_API_KEY not set — buffering only, nothing will forward')
  }

  const store = new SqliteEventStore(db)
  const control = new SqliteControlStore(db)
  const routes = new DbRouteProvider(db)
  const dispatcher = new Dispatcher({
    store,
    control,
    routes,
    settings,
    client,
    dataKey,
    maskingKey,
    signal,
    hooks,
  })
  dispatcher.start()

  const ingest = buildIngestServer({
    store,
    control,
    routes,
    dataKey,
    signal,
    hooks,
    secrets: secretResolver,
  })
  const admin = buildAdminServer({
    db,
    dbPath,
    startedAt,
    basicAuth: adminAuth,
    maskingKey,
    dataKey,
    telemetry,
    secrets: secretResolver,
  })
  const metricsServer = buildMetricsServer({
    metrics,
    ready: () => dbReady(db),
    basicAuth: process.env.METRICS_BASIC_AUTH,
  })

  await ingest.listen({ port: settings.ingest.port, host: settings.ingest.host })
  await admin.listen({ port: settings.admin.port, host: settings.admin.host })
  await metricsServer.listen({ port: settings.metrics.port, host: settings.metrics.host })
  log.info('relay started', {
    version: VERSION,
    ingest_port: settings.ingest.port,
    admin_port: settings.admin.port,
    metrics_port: settings.metrics.port,
  })
  telemetry.start(() => snapshotFromDb(db, dbPath, startedAt, VERSION))
  telemetry.capture('relay_boot', {
    mode: 'running',
    persistent: isDbPathPersistent(dbPath),
    route_count: config.routes.length,
    has_api_key: Boolean(apiKey),
    config: loaded.yamlText,
  })

  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal: sig })
    telemetry.capture('relay_shutdown', {
      signal: sig,
      uptime_s: Math.round((Date.now() - startedAt) / 1000),
    })
    await ingest.close() // stop accepting webhooks first
    await dispatcher.stop() // drain the in-flight dispatch cycle
    await telemetry.stop()
    await Promise.all([admin.close(), metricsServer.close()])
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((err) => {
  log.error('fatal boot error', { error: (err as Error).message })
  void emitFatalTelemetry(err).finally(() => process.exit(1))
})

async function emitSetupTelemetry(missing: { name: string }[]): Promise<void> {
  const t = telemetryFromEnv()
  if (!t) return
  t.captureError('setup_missing_env', new Error('setup required'), {
    missing: missing.map((m) => m.name).join(','),
  })
  await t.stop()
}

async function emitFatalTelemetry(err: unknown): Promise<void> {
  try {
    const t = telemetryFromEnv()
    if (!t) return
    t.captureError('fatal_boot', err)
    await t.stop()
  } catch {
    // never block process exit
  }
}

function telemetryFromEnv(): Telemetry | undefined {
  const apiKey = process.env.ENDCLOSE_API_KEY ?? ''
  if (!apiKey || !isTelemetryEnabled()) return undefined
  const settings = loadRuntimeSettings()
  return createTelemetry({
    enabled: true,
    apiKey,
    client: new EndCloseClient(settings.endcloseBaseUrl, apiKey),
    version: VERSION,
    startedAt: Date.now(),
  })
}
