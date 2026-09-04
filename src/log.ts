import { pino } from 'pino'
import type { Logger } from '@endclose/relay'

export type { Logger, LogMeta } from '@endclose/relay'

const base = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['*.authorization', '*.secret'], censor: '[REDACTED]' },
})

/** The appliance's pino-backed logger. */
export const log: Logger = {
  info: (msg, meta = {}) => base.info(meta, msg),
  warn: (msg, meta = {}) => base.warn(meta, msg),
  error: (msg, meta = {}) => base.error(meta, msg),
  debug: (msg, meta = {}) => base.debug(meta, msg),
}
