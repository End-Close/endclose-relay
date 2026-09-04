import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  EventsRepo,
  KvRepo,
  openDb,
  SqliteControlStore,
  SqliteEventStore,
  type Db,
} from '@endclose/relay-sqlite'
import {
  aesGcmCodec,
  createRelay,
  deriveKey,
  envSecrets,
  RelayHooks,
  type DispatchSettings,
  type Relay,
} from '@endclose/relay'
import { migrate } from '../src/db/migrate.js'
import { DbRouteProvider } from '../src/db/route-provider.js'
import { parseConfig } from '../src/config/load.js'
import { saveConfig } from '../src/config/store.js'
import { Metrics } from '../src/metrics/metrics.js'
import { log } from '../src/log.js'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export const DATA_KEY = deriveKey('RELAY_DATA_KEY', 'test-data-key-0123456789')
export const MASKING_KEY = deriveKey('MASKING_HMAC_KEY', 'test-masking-key-0123456789')
export const CODEC = aesGcmCodec(DATA_KEY)

export const TEST_CONFIG_YAML = `
routes:
  - id: payabli-settlements
    source: payabli
    auth:
      mode: static_header
      header: authorization
      secret_env: PAYABLI_WEBHOOK_SECRET
    events: ["TransferFunded"]
    map:
      data_stream_key: payabli_settlements_funded
      external_id: transferId
      amount: NetAmount
      direction: credit
      date: { source: transferTime, format: mdy_hms }
      metadata:
        batch_id: batchId
        batch_number: batchNumber
        total_amount: TotalAmount
        return_amount: RtAmount
        entry_point: entryPoint
        paypoint: Paypoint
  - id: payabli-batches
    source: payabli
    auth:
      mode: static_header
      header: authorization
      secret_env: PAYABLI_WEBHOOK_SECRET
    events: ["PayOutBatchPaid"]
    map:
      data_stream_key: payabli_batches_paid
      external_id: BatchId
      amount: TotalAmount
      direction: debit
      metadata:
        method: Method
        paypoint: Paypoint
`

export function setupDb(ecPort = 9999): {
  db: Db
  signal: EventEmitter
  metrics: Metrics
  hooks: RelayHooks
  store: SqliteEventStore
  control: SqliteControlStore
  routes: DbRouteProvider
} {
  process.env.ENDCLOSE_API_KEY = 'test-api-key'
  process.env.PAYABLI_WEBHOOK_SECRET = 'Bearer test-webhook-secret'
  process.env.RELAY_DATA_KEY = 'test-data-key-0123456789'
  process.env.MASKING_HMAC_KEY = 'test-masking-key-0123456789'
  const db = openDb(':memory:')
  migrate(db)
  saveConfig(db, TEST_CONFIG_YAML.replaceAll('__EC_PORT__', String(ecPort)), 'test')
  const events = new EventsRepo(db)
  const kv = new KvRepo(db)
  const metrics = new Metrics({
    queueDepths: () => events.countByStatus(),
    killswitch: () => kv.globalKillswitch(),
    dbBytes: () => 0,
  })
  const hooks = new RelayHooks()
  metrics.subscribe(hooks)
  return {
    db,
    signal: new EventEmitter(),
    metrics,
    hooks,
    store: new SqliteEventStore(db),
    control: new SqliteControlStore(db),
    routes: new DbRouteProvider(db),
  }
}

export function testConfig(ecPort = 9999) {
  return parseConfig(TEST_CONFIG_YAML.replaceAll('__EC_PORT__', String(ecPort))).config
}

/** Fast dispatch settings for tests (poll 50ms, backoff 20→200ms). */
export function testDispatch(): DispatchSettings {
  return {
    batchMax: 100,
    pollIntervalMs: 50,
    backoffBaseMs: 20,
    backoffCapMs: 200,
    parkAfterMs: 7 * 24 * 3600 * 1000,
    leaseMs: 600_000,
  }
}

/** An engine over the test database, pointed at a mock End Close on `ecPort`. Not started. */
export function setupRelay(setup: ReturnType<typeof setupDb>, ecPort = 9999): Relay {
  return createRelay({
    routes: setup.routes,
    store: setup.store,
    control: setup.control,
    secrets: envSecrets(),
    endclose: { apiKey: 'test-api-key', baseUrl: `http://127.0.0.1:${ecPort}/v1` },
    encryption: { dataKey: DATA_KEY },
    maskingKey: MASKING_KEY,
    dispatch: testDispatch(),
    logger: log,
    instanceId: 'test',
    hooks: setup.hooks,
  })
}

/** Fast dispatch/retention settings for tests (poll 50ms, backoff 20→200ms). */
export function testSettings() {
  return {
    dispatch: {
      batch_max: 100,
      poll_interval_ms: 50,
      backoff_base_ms: 20,
      backoff_cap_ms: 200,
      park_after_ms: 7 * 24 * 3600 * 1000,
      lease_ms: 600_000,
    },
    retention: { delivered_days: 7, ledger_days: 30 },
  }
}
