import { statSync } from 'node:fs'
import { openDb, SqliteControlStore, SqliteEventStore, EventsRepo, KvRepo, type Db } from '@end-close/relay-sqlite'
import { createRelay, deriveKey, EndCloseClient, envSecrets, RelayHooks } from '@end-close/relay'
import { migrate } from './db/migrate.js'
import { DbRouteProvider } from './db/route-provider.js'
import { resolveActiveConfig, type ActiveConfigState } from './config/store.js'
import { RemoteConfigManager, type RemoteCheck } from './config/remote.js'
import { loadRuntimeSettings } from './config/runtime.js'
import { loadSecretsFile } from './config/secrets.js'
import { buildIngestServer } from './ingest/server.js'
import { buildAdminServer } from './admin/server.js'
import { buildSetupServer, checkRequiredEnv } from './admin/setup-server.js'
import { isDbPathPersistent } from './db/persistence.js'
import { buildMetricsServer } from './metrics/server.js'
import { Metrics } from './metrics/metrics.js'
import { createInstanceReporter } from './forward/manifest.js'
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
  // serve a setup page on the admin port naming exactly what's wrong (including a
  // missing data volume, so env and storage get fixed in one redeploy).
  const missingEnv = checkRequiredEnv(process.env, secrets.error)
  if (missingEnv.length > 0) {
    log.error('setup required: missing/invalid environment', {
      missing: missingEnv.map((m) => `${m.name} (${m.problem})`).join(', '),
    })
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

  const apiKey = process.env.ENDCLOSE_API_KEY ?? ''
  const client = new EndCloseClient(settings.endcloseBaseUrl, apiKey)
  const startedAt = Date.now()

  // Who owns the configuration. End Close is asked first (the API key is
  // environment-scoped, so it alone selects the environment): a 200 means End Close
  // owns it — the document is stored as a version attributed to "endclose", applied
  // live, kept current by polling, and the local editor is locked. A 404 means the relay
  // is configured locally: the stored config, else the seed file, else bootstrap mode.
  const remote = new RemoteConfigManager(
    db,
    {
      client,
      apiKey,
      baseUrl: settings.endcloseBaseUrl,
      enabled: settings.remoteConfig.enabled,
      secrets: secretResolver,
    },
    log,
  )
  const stored = resolveActiveConfig(db, undefined, secretResolver)
  const check = await remote.check()
  let state: ActiveConfigState
  if (check.kind === 'managed') {
    state = { kind: 'ok', loaded: check.loaded }
    log.info('configuration managed by End Close', {
      base_url: settings.endcloseBaseUrl,
      environment: check.environment ?? null,
      config_hash: check.loaded.hash,
      updated: check.changed,
    })
  } else {
    logRemoteCheck(check)
    state =
      stored.kind === 'empty'
        ? resolveActiveConfig(db, process.env.RELAY_CONFIG ?? '/etc/endclose-relay/relay.yaml', secretResolver)
        : stored
  }

  // Instance manifest call-home: boot, heartbeats, shutdown. Metadata only.
  const reporter = createInstanceReporter({
    enabled: settings.telemetry.enabled,
    apiKey,
    client,
    instanceId: settings.instanceId,
    configSource: () => (remote.managed ? 'remote' : 'local'),
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
    } else {
      log.warn('no configuration — bootstrap mode: admin UI on :8081, webhooks NOT accepted')
    }
    const metrics = buildMetrics(db, dbPath)
    let restarting = false
    const restart = (why: string) => {
      if (restarting) return
      restarting = true
      log.info(why)
      remote.stop()
      void reporter.stop().finally(() => setTimeout(() => process.exit(0), 500)) // let the HTTP response flush
    }
    // Keep asking: a relay that came up before its egress was ready, or before End Close
    // started managing it, configures itself without a manual restart. An operator apply
    // in the meantime restarts the process first; End Close's answer then wins at next boot.
    remote.start(settings.remoteConfig.pollIntervalMs, (again) => {
      if (restarting) return
      if (again.kind === 'managed') {
        restart('configuration received from End Close — restarting into running mode')
      } else {
        logRemoteCheck(again)
      }
    })
    const admin = await buildAdminServer({
      db,
      dbPath,
      startedAt,
      basicAuth: adminAuth,
      maskingKey,
      dataKey,
      mode: 'bootstrap',
      secrets: secretResolver,
      ...(state.kind === 'invalid' ? { configError: state.error } : {}),
      remoteConfig: () => remote.snapshot(),
      onConfigApplied: () => reporter.configApplied(),
      onBootstrapApplied: () => restart('initial config applied — restarting into running mode'),
    })
    const metricsServer = buildMetricsServer({
      metrics,
      ready: () => dbReady(db),
      basicAuth: process.env.METRICS_BASIC_AUTH,
    })
    await admin.listen({ port: settings.admin.port, host: settings.admin.host })
    await metricsServer.listen({ port: settings.metrics.port, host: settings.metrics.host })
    log.info('bootstrap mode ready', { version: VERSION, admin_port: settings.admin.port })
    reporter.start()
    return
  }

  const { loaded } = state
  const { config } = loaded
  log.info('config active', { config_hash: loaded.hash, routes: config.routes.length })
  log.info('forwarding to', { base_url: settings.endcloseBaseUrl })

  const metrics = buildMetrics(db, dbPath)
  const hooks = new RelayHooks()
  metrics.subscribe(hooks)
  hooks.on('error', () => reporter.reportError())
  // A missing API key must not crash the relay: webhooks keep buffering (the point of
  // store-and-forward) and the admin UI banners the missing secret. Forwarding retries
  // until the key is provided and the container restarted.
  if (!apiKey) {
    log.error('ENDCLOSE_API_KEY not set — buffering only, nothing will forward')
  }

  const relay = createRelay({
    routes: new DbRouteProvider(db, log),
    store: new SqliteEventStore(db, { logger: log }),
    control: new SqliteControlStore(db, { logger: log }),
    secrets: secretResolver,
    endclose: { apiKey, baseUrl: settings.endcloseBaseUrl },
    client,
    encryption: { dataKey },
    maskingKey,
    dispatch: settings.dispatch,
    retention: settings.retention,
    logger: log,
    instanceId: settings.instanceId,
    hooks,
  })
  relay.start()
  // While End Close owns the configuration, keep it current: a changed document becomes
  // a new version and applies live (routes are read from the database per request).
  remote.start(settings.remoteConfig.pollIntervalMs, (again) => {
    if (again.kind === 'failed') log.warn('End Close configuration check failed', { error: again.error })
  })

  const ingest = buildIngestServer({ ingest: relay.ingest, logger: log })
  const admin = await buildAdminServer({
    db,
    dbPath,
    startedAt,
    basicAuth: adminAuth,
    maskingKey,
    dataKey,
    secrets: secretResolver,
    remoteConfig: () => remote.snapshot(),
    onConfigApplied: () => reporter.configApplied(),
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
  reporter.start()

  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal: sig })
    remote.stop()
    await ingest.close() // stop accepting webhooks first
    await relay.stop() // drain the in-flight dispatch cycle
    await reporter.stop()
    await Promise.all([admin.close(), metricsServer.close()])
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

function logRemoteCheck(result: RemoteCheck): void {
  switch (result.kind) {
    case 'unmanaged':
      log.info('End Close is not managing this configuration — configured locally')
      break
    case 'disabled':
      log.info(
        result.reason === 'env'
          ? 'remote configuration disabled (RELAY_REMOTE_CONFIG) — configured locally'
          : 'no ENDCLOSE_API_KEY to ask End Close for a configuration — configured locally',
      )
      break
    case 'failed':
      log.error(
        result.retryable
          ? 'End Close could not be reached for the configuration — retrying in the background'
          : 'the configuration from End Close could not be used',
        { error: result.error },
      )
      break
    case 'managed':
      break
  }
}

main().catch((err) => {
  log.error('fatal boot error', { error: (err as Error).message })
  process.exit(1)
})
