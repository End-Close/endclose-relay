import { refEnrichment, relayConfigSchema, type RelayConfig, type RouteConfig } from '../config/schema.js'
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

/** Every `enrich:` reference in a route's map, as [field, enrichment name]. */
export function routeEnrichments(route: RouteConfig): [field: string, enrichment: string][] {
  const out: [string, string][] = []
  const desc = route.map.description === undefined ? undefined : refEnrichment(route.map.description)
  if (desc !== undefined) out.push(['description', desc])
  for (const [key, ref] of Object.entries(route.map.metadata)) {
    const name = refEnrichment(ref)
    if (name !== undefined) out.push([`metadata.${key}`, name])
  }
  return out
}

/** Reject routes whose map names an enrichment the host has not registered. */
export function assertKnownEnrichments(
  routes: RouteConfig[],
  enrichments?: Record<string, unknown>,
): void {
  for (const r of routes) {
    for (const [field, name] of routeEnrichments(r)) {
      if (!enrichments || !Object.hasOwn(enrichments, name)) {
        throw new Error(`route ${r.id}: ${field} references unknown enrichment "${name}"`)
      }
    }
  }
}

export interface ParseRoutesOptions {
  adapters?: Record<string, ProcessorAdapter>
  enrichments?: Record<string, unknown>
}

/**
 * Validate a routes document (parsed YAML or a plain object) into RouteConfig[]. Applies
 * defaults, the hard-denylist check on metadata names, duplicate-id, unknown-source and
 * unknown-enrichment checks. Pass the host's extra adapters and enrichments so routes
 * that use them validate too; with none registered, any `enrich:` reference is rejected.
 */
export function parseRoutes(doc: unknown, opts: ParseRoutesOptions = {}): RouteConfig[] {
  const config: RelayConfig = relayConfigSchema.parse(doc)
  const seen = new Set<string>()
  for (const route of config.routes) {
    if (seen.has(route.id)) throw new Error(`duplicate route id: ${route.id}`)
    seen.add(route.id)
  }
  assertKnownSources(config.routes, opts.adapters)
  assertKnownEnrichments(config.routes, opts.enrichments)
  return config.routes
}
