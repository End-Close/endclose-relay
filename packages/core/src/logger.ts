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

export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** console-backed logger at warn level and above. */
export const consoleLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg, meta) => console.warn(msg, meta ?? ''),
  error: (msg, meta) => console.error(msg, meta ?? ''),
}
