import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { deriveKey, parseRoutes } from '../src/index.js'

// Fixtures live once, at the repo root (scripts/send-webhooks.sh uses them too).
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test', 'fixtures')

export const DATA_KEY = deriveKey('RELAY_DATA_KEY', 'test-data-key-0123456789')
export const MASKING_KEY = deriveKey('MASKING_HMAC_KEY', 'test-masking-key-0123456789')

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

export function testConfig() {
  return { routes: parseRoutes(parse(TEST_CONFIG_YAML)) }
}
