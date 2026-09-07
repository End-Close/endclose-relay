import type { ProcessorAdapter } from './types.js'
import { payabliAdapter } from './payabli.js'
import { genericHmacAdapter } from './generic-hmac.js'

const adapters: Record<string, ProcessorAdapter> = {
  payabli: payabliAdapter,
  generic_hmac: genericHmacAdapter,
}

export function adapterFor(
  source: string,
  extra?: Record<string, ProcessorAdapter>,
): ProcessorAdapter {
  const adapter = extra?.[source] ?? adapters[source]
  if (!adapter) throw new Error(`no adapter for source: ${source}`)
  return adapter
}

export function hasAdapter(source: string, extra?: Record<string, ProcessorAdapter>): boolean {
  return Boolean(extra?.[source] ?? adapters[source])
}
