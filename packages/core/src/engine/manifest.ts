import { BUILTIN_SOURCES } from '../config/schema.js'
import type { Enrichment } from '../forward/enrich.js'
import { ENGINE_VERSION } from '../version.js'

// What a running relay instance tells End Close about itself: which host it is, which
// engine and routes-schema version it runs, where its configuration comes from, and the
// adapters and enrichments its map may reference. End Close keeps one record per
// instance and uses the capabilities to validate and suggest while authoring that
// environment's configuration. Nothing operational travels here — no queue depths, no
// payloads, no errors — and the engine only sends it when it runs on End Close's
// configuration (or the host opts in).

/** The routes-document schema version this engine understands. */
export const CONFIG_SCHEMA_VERSION = 1

/**
 * Why this check-in is happening. End Close accepts any lowercase `[a-z][a-z0-9_]*` word
 * and documents these; `shutdown` is recorded without refreshing the instance's liveness.
 */
export type ManifestReason = 'boot' | 'heartbeat' | 'config_applied' | 'error' | 'shutdown'
export type ManifestHost = 'application' | 'embedded'
export type ConfigSource = 'remote' | 'local'
export type EnrichmentOutput = 'string' | 'number' | 'boolean'

/** What End Close shows for an enrichment when authoring a map that names it. */
export interface EnrichmentDescriptor {
  description?: string
  output?: EnrichmentOutput
}

/** A bare function, or a function with a descriptor for End Close's authoring UI. */
export type EnrichmentRegistration = Enrichment | ({ fn: Enrichment } & EnrichmentDescriptor)

export interface InstanceManifest {
  schema: 1
  reason: ManifestReason
  host: ManifestHost
  engine_version: string
  config_schema: number
  config_source: ConfigSource
  capabilities: {
    adapters: string[]
    enrichments: Record<string, EnrichmentDescriptor>
  }
}

export function splitEnrichments(regs: Record<string, EnrichmentRegistration> | undefined): {
  functions: Record<string, Enrichment>
  descriptors: Record<string, EnrichmentDescriptor>
} {
  const functions: Record<string, Enrichment> = {}
  const descriptors: Record<string, EnrichmentDescriptor> = {}
  for (const [name, reg] of Object.entries(regs ?? {})) {
    if (typeof reg === 'function') {
      functions[name] = reg
      descriptors[name] = {}
    } else {
      const { fn, ...descriptor } = reg
      functions[name] = fn
      descriptors[name] = descriptor
    }
  }
  return { functions, descriptors }
}

export interface ManifestSource {
  host: ManifestHost
  configSource: ConfigSource
  /** Host-registered adapters (keys); the built-ins are always included. */
  adapters?: Record<string, unknown> | undefined
  enrichments?: Record<string, EnrichmentDescriptor> | undefined
}

export function buildManifest(src: ManifestSource, reason: ManifestReason): InstanceManifest {
  const adapters = [...new Set([...BUILTIN_SOURCES, ...Object.keys(src.adapters ?? {})])]
  return {
    schema: 1,
    reason,
    host: src.host,
    engine_version: ENGINE_VERSION,
    config_schema: CONFIG_SCHEMA_VERSION,
    config_source: src.configSource,
    capabilities: { adapters, enrichments: { ...(src.enrichments ?? {}) } },
  }
}
