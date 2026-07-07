import { EventEmitter } from 'node:events'
import { statSync } from 'node:fs'
import { openDb } from './db/db.js'
import { migrate } from './db/migrate.js'
import { loadConfig, resolveSecret } from './config/load.js'
import { applyConfig } from './config/apply.js'
import { deriveKey } from './crypto/keys.js'
import { buildIngestServer } from './ingest/server.js'
import { buildAdminServer } from './admin/server.js'
import { buildMetricsServer } from './metrics/server.js'
import { Metrics } from './metrics/metrics.js'
import { Dispatcher } from './forward/dispatcher.js'
import { EndCloseClient } from './forward/endclose-client.js'
import { EventsRepo } from './db/repo/events.js'
import { KvRepo } from './db/repo/kv.js'
import { VERSION } from './version.js'
import { log } from './log.js'

async function main(): Promise<void> {
  const configPath = process.env.RELAY_CONFIG ?? '/etc/endclose-relay/relay.yaml'
  const loaded = loadConfig(configPath)
  const { config } = loaded

  const dataKey = deriveKey('RELAY_DATA_KEY', process.env.RELAY_DATA_KEY)
  const maskingKey = deriveKey('MASKING_HMAC_KEY', process.env.MASKING_HMAC_KEY)

  const dbPath = process.env.RELAY_DB_PATH ?? config.storage.db_path
  const db = openDb(dbPath)
  migrate(db)
  applyConfig(db, loaded, 'boot')
  log.info('config applied', { config_hash: loaded.hash, routes: config.routes.length })

  const events = new EventsRepo(db)
  const kv = new KvRepo(db)
  const metrics = new Metrics({
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

  const signal = new EventEmitter()
  const client = new EndCloseClient(
    config.endclose.base_url,
    resolveSecret(config.endclose.api_key_env),
  )

  const dispatcher = new Dispatcher({ db, config, client, dataKey, maskingKey, signal, metrics })
  dispatcher.start()

  const ingest = buildIngestServer({ db, dataKey, signal, metrics })
  const admin = buildAdminServer({ db, configPath, dbPath, startedAt: Date.now() })
  const metricsServer = buildMetricsServer({
    metrics,
    ready: () => {
      try {
        db.prepare('SELECT 1').get()
        return true
      } catch {
        return false
      }
    },
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
