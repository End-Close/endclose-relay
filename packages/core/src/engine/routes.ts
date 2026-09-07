import { relayConfigSchema, type RelayConfig, type RouteConfig } from '../config/schema.js'
import { hasAdapter } from '../ingest/adapters/registry.js'
import type { ProcessorAdapter } from '../ingest/adapters/types.js'

// Validation of a routes document, shared by every way routes reach the engine: passed
// in by the host, seeded from a file by the application, or fetched from End Close.

/** Reject routes whose `source` has no adapter (built-in or host-registered). */
export function assertKnownSources(
  routes: RouteConfig[],
  adapters?: Record<string, ProcessorAdapter>,
): void {
  for (const r of routes) {
    if (!hasAdapter(r.source, adapters)) {
      throw new Error(`route ${r.id}: no adapter for source "${r.source}"`)
    }
  }
}

/**
 * Validate a routes document (parsed YAML or a plain object) into RouteConfig[]. Applies
 * defaults, the hard-denylist check on metadata names, duplicate-id and unknown-source
 * checks. Pass the host's extra adapters so their sources validate too.
 */
export function parseRoutes(
  doc: unknown,
  opts: { adapters?: Record<string, ProcessorAdapter> } = {},
): RouteConfig[] {
  const config: RelayConfig = relayConfigSchema.parse(doc)
  const seen = new Set<string>()
  for (const route of config.routes) {
    if (seen.has(route.id)) throw new Error(`duplicate route id: ${route.id}`)
    seen.add(route.id)
  }
  assertKnownSources(config.routes, opts.adapters)
  return config.routes
}
