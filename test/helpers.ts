import { EventEmitter } from 'node:events'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from '../src/db/db.js'
import { migrate } from '../src/db/migrate.js'
import { parseConfig } from '../src/config/load.js'
import { applyConfig } from '../src/config/apply.js'
import { deriveKey } from '../src/crypto/keys.js'
import { Metrics } from '../src/metrics/metrics.js'
import { EventsRepo } from '../src/db/repo/events.js'
import { KvRepo } from '../src/db/repo/kv.js'

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

export const DATA_KEY = deriveKey('RELAY_DATA_KEY', 'test-data-key-0123456789')
export const MASKING_KEY = deriveKey('MASKING_HMAC_KEY', 'test-masking-key-0123456789')

export const TEST_CONFIG_YAML = `
endclose:
  base_url: http://127.0.0.1:__EC_PORT__/v1
  api_key_env: ENDCLOSE_API_KEY
storage:
  db_path: ":memory:"
dispatch:
  poll_interval_ms: 50
  backoff_base_ms: 20
  backoff_cap_ms: 200
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
        entry_point: entryPoint
        paypoint: Paypoint
`

export function setupDb(ecPort = 9999): { db: Db; signal: EventEmitter; metrics: Metrics } {
  process.env.ENDCLOSE_API_KEY = 'test-api-key'
  process.env.PAYABLI_WEBHOOK_SECRET = 'Bearer test-webhook-secret'
  const db = openDb(':memory:')
  migrate(db)
  const loaded = parseConfig(TEST_CONFIG_YAML.replaceAll('__EC_PORT__', String(ecPort)))
  applyConfig(db, loaded, 'test')
  const events = new EventsRepo(db)
  const kv = new KvRepo(db)
  const metrics = new Metrics({
    queueDepths: () => events.countByStatus(),
    killswitch: () => kv.globalKillswitch(),
    dbBytes: () => 0,
  })
  return { db, signal: new EventEmitter(), metrics }
}

export function testConfig(ecPort = 9999) {
  return parseConfig(TEST_CONFIG_YAML.replaceAll('__EC_PORT__', String(ecPort))).config
}
