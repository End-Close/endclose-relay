import { pino } from 'pino'

// Log metadata is restricted to scalars: there is deliberately no way to pass an object
// (and therefore a payload) into a log line.
export type LogMeta = Record<string, string | number | boolean | null | undefined>

/** The logging contract the engine depends on. Any host can supply its own implementation. */
export interface Logger {
  debug(msg: string, meta?: LogMeta): void
  info(msg: string, meta?: LogMeta): void
  warn(msg: string, meta?: LogMeta): void
  error(msg: string, meta?: LogMeta): void
}

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

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}
