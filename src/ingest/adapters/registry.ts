import type { ProcessorAdapter } from './types.js'
import { payabliAdapter } from './payabli.js'
import { genericHmacAdapter } from './generic-hmac.js'

const adapters: Record<string, ProcessorAdapter> = {
  payabli: payabliAdapter,
  generic_hmac: genericHmacAdapter,
}

export function adapterFor(source: string): ProcessorAdapter {
  const adapter = adapters[source]
  if (!adapter) throw new Error(`no adapter for source: ${source}`)
  return adapter
}
