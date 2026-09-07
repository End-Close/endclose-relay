import { noopLogger, type Logger } from '@endclose/relay'

export const SQLITE_BUSY_TIMEOUT_MS = 15_000
export const BUSY_RETRY_ATTEMPTS = 3
export const INGEST_BUSY_RETRY_ATTEMPTS = 2

const DEFAULT_DELAY_MS = 200

export function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code
  return typeof code === 'string' && (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_'))
}

export interface BusyRetryOpts {
  attempts?: number
  delayMs?: number
  logger?: Logger
}

/** Retry a synchronous SQLite call after SQLITE_BUSY; sqlite's busy_timeout already waited once. */
export async function withBusyRetry<T>(
  op: string,
  fn: () => T,
  opts: BusyRetryOpts = {},
): Promise<T> {
  const attempts = opts.attempts ?? BUSY_RETRY_ATTEMPTS
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS
  const logger = opts.logger ?? noopLogger
  let last: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return fn()
    } catch (err) {
      last = err
      if (!isSqliteBusy(err) || i === attempts - 1) {
        if (isSqliteBusy(err)) {
          logger.warn('sqlite busy exhausted', {
            op,
            attempts,
            error: (err as Error).message,
          })
        }
        throw err
      }
      logger.warn('sqlite busy, retrying', {
        op,
        attempt: i + 1,
        error: (err as Error).message,
      })
      await sleep(delayMs * (i + 1))
    }
  }
  throw last
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
