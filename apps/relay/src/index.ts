import { statSync } from 'node:fs'
import { openDb, SqliteControlStore, SqliteEventStore, EventsRepo, KvRepo, type Db } from '@endclose/relay-sqlite'
import { createRelay, deriveKey, EndCloseClient, envSecrets, RelayHooks } from '@endclose/relay'
import { migrate } from './db/migrate.js'
import { DbRouteProvider } from './db/route-provider.js'
import { resolveActiveConfig, readActiveConfigRaw, type ActiveConfigState } from './config/store.js'
import { seedFromEndClose, remoteStatusOf, type RemoteSeedResult } from './config/remote.js'
import { loadRuntimeSettings, isTelemetryEnabled } from './config/runtime.js'
import { loadSecretsFile } from './config/secrets.js'
import { buildIngestServer } from './ingest/server.js'
import { buildAdminServer } from './admin/server.js'
import { buildSetupServer, checkRequiredEnv } from './admin/setup-server.js'
import { isDbPathPersistent } from './db/persistence.js'
import { buildMetricsServer } from './metrics/server.js'
import { Metrics } from './metrics/metrics.js'
import { createTelemetry, snapshotFromDb, type Telemetry } from './forward/telemetry.js'
import { VERSION } from './version.js'
import { log } from './log.js'

const DEFAULT_DB_PATH = '/var/lib/endclose-relay/relay.db'
// Bootstrap mode after End Close could not be reached: keep trying, so a relay that came
// up before its egress was ready configures itself without a manual restart.
const REMOTE_SEED_RETRY_MS = 60_000

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
  let state: ActiveConfigState = resolveActiveConfig(
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

  // Nothing stored and no seed file: End Close may hold the configuration for this API
  // key (the key is environment-scoped, so it alone selects the environment). A fetched
  // document is stored as the first version, attributed to "endclose"; after that the
  // database is authoritative exactly as for a file seed.
  const seedOpts = {
    client,
    apiKey,
    baseUrl: settings.endcloseBaseUrl,
    enabled: settings.remoteConfig.enabled,
    secrets: secretResolver,
  }
  let remote: RemoteSeedResult | undefined
  if (state.kind === 'empty') {
    remote = await seedFromEndClose(db, seedOpts)
    if (remote.kind === 'seeded') {
      state = { kind: 'ok', loaded: remote.loaded }
      log.info('configuration fetched from End Close', {
        base_url: settings.endcloseBaseUrl,
        environment: remote.environment ?? null,
        config_hash: remote.loaded.hash,
      })
    } else {
      logRemoteSeed(remote)
      if (remote.kind === 'failed') telemetry.captureError('remote_config', new Error(remote.error))
    }
  }

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
    const restart = (why: string) => {
      if (restarting) return
      restarting = true
      log.info(why)
      setTimeout(() => process.exit(0), 500) // let the HTTP response flush
    }
    // A transient End Close failure keeps being retried; success restarts into running
    // mode just like a first apply. An operator apply in the meantime wins (the retry
    // finds a stored config and saves nothing).
    let retryTimer: NodeJS.Timeout | undefined
    const stopRetrying = () => {
      if (retryTimer) clearInterval(retryTimer)
      retryTimer = undefined
    }
    if (remote?.kind === 'failed' && remote.retryable) {
      retryTimer = setInterval(() => {
        if (restarting) return
        void seedFromEndClose(db, seedOpts).then((again) => {
          remote = again
          if (again.kind === 'seeded') {
            stopRetrying()
            log.info('configuration fetched from End Close', {
              environment: again.environment ?? null,
              config_hash: again.loaded.hash,
            })
            restart('configuration fetched from End Close — restarting into running mode')
          } else if (again.kind === 'superseded' || (again.kind === 'failed' && !again.retryable)) {
            stopRetrying()
            logRemoteSeed(again)
          } else {
            log.warn('End Close configuration still unavailable; retrying', {
              error: again.kind === 'failed' ? again.error : again.kind,
            })
          }
        }, (err: unknown) => {
          log.error('End Close configuration retry failed', { error: (err as Error).message })
        })
      }, REMOTE_SEED_RETRY_MS)
      retryTimer.unref()
    }
    const admin = await buildAdminServer({
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
      remoteConfig: () => (remote ? remoteStatusOf(remote, retryTimer !== undefined) : undefined),
      onBootstrapApplied: () => {
        stopRetrying()
        restart('initial config applied — restarting into running mode')
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
  const hooks = new RelayHooks()
  metrics.subscribe(hooks)
  telemetry.subscribe(hooks)
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

  const ingest = buildIngestServer({ ingest: relay.ingest, logger: log })
  const admin = await buildAdminServer({
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
    await relay.stop() // drain the in-flight dispatch cycle
    await telemetry.stop()
    await Promise.all([admin.close(), metricsServer.close()])
    db.close()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

function logRemoteSeed(result: RemoteSeedResult): void {
  switch (result.kind) {
    case 'none':
      log.info('End Close holds no configuration for this API key — bootstrap mode')
      break
    case 'disabled':
      log.info(
        result.reason === 'env'
          ? 'remote configuration disabled (RELAY_REMOTE_CONFIG) — bootstrap mode'
          : 'no ENDCLOSE_API_KEY to fetch a configuration with — bootstrap mode',
      )
      break
    case 'superseded':
      log.info('a configuration was applied locally while fetching from End Close — keeping it')
      break
    case 'failed':
      log.error(
        result.retryable
          ? 'fetching the configuration from End Close failed — bootstrap mode, retrying in the background'
          : 'the configuration fetched from End Close could not be applied — bootstrap mode',
        { error: result.error },
      )
      break
    case 'seeded':
      break
  }
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
