import { EventEmitter } from 'node:events'
import { openDb } from './db/db.js'
import { migrate } from './db/migrate.js'
import { loadConfig, resolveSecret } from './config/load.js'
import { applyConfig } from './config/apply.js'
import { deriveKey } from './crypto/keys.js'
import { buildIngestServer } from './ingest/server.js'
import { Dispatcher } from './forward/dispatcher.js'
import { EndCloseClient } from './forward/endclose-client.js'
import { log } from './log.js'

async function main(): Promise<void> {
  const configPath = process.env.RELAY_CONFIG ?? '/etc/endclose-relay/relay.yaml'
  const loaded = loadConfig(configPath)
  const { config } = loaded

  const dataKey = deriveKey('RELAY_DATA_KEY', process.env.RELAY_DATA_KEY)
  const maskingKey = deriveKey('MASKING_HMAC_KEY', process.env.MASKING_HMAC_KEY)

  const db = openDb(process.env.RELAY_DB_PATH ?? config.storage.db_path)
  migrate(db)
  applyConfig(db, loaded, 'boot')
  log.info('config applied', { config_hash: loaded.hash, routes: config.routes.length })

  const signal = new EventEmitter()
  const client = new EndCloseClient(
    config.endclose.base_url,
    resolveSecret(config.endclose.api_key_env),
  )

  const dispatcher = new Dispatcher({ db, config, client, dataKey, maskingKey, signal })
  dispatcher.start()

  const ingest = buildIngestServer({ db, dataKey, signal })
  await ingest.listen({ port: config.ingest.port, host: config.ingest.host })
  log.info('relay started', { ingest_port: config.ingest.port })

  let shuttingDown = false
  const shutdown = async (sig: string) => {
    if (shuttingDown) return
    shuttingDown = true
    log.info('shutting down', { signal: sig })
    await ingest.close() // stop accepting webhooks first
    await dispatcher.stop() // drain the in-flight dispatch cycle
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
