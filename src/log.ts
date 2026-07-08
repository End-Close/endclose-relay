import { pino } from 'pino'

// Log metadata is restricted to scalars: there is deliberately no way to pass an object
// (and therefore a payload) into a log line.
export type LogMeta = Record<string, string | number | boolean | null | undefined>

const base = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['*.authorization', '*.secret'], censor: '[REDACTED]' },
})

export const log = {
  info: (msg: string, meta: LogMeta = {}) => base.info(meta, msg),
  warn: (msg: string, meta: LogMeta = {}) => base.warn(meta, msg),
  error: (msg: string, meta: LogMeta = {}) => base.error(meta, msg),
  debug: (msg: string, meta: LogMeta = {}) => base.debug(meta, msg),
}
