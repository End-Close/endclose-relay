// Runtime settings: everything that applies at boot and never hot-applies — the End
// Close endpoint, listener ports, dispatch/retention tuning. These live in the
// environment, NOT in the config document, so that everything in the (UI-editable,
// DB-authoritative) config applies live and "restart pending" isn't a concept the
// operator has to track. The config document contains routes only.

import {
  DEFAULT_DISPATCH,
  DEFAULT_RETENTION,
  ENDCLOSE_API_URL,
  type DispatchSettings,
  type RetentionSettings,
} from '@end-close/relay'

export interface RuntimeSettings {
  endcloseBaseUrl: string
  /**
   * Lease owner recorded on claimed batches. The application is deployed single-writer, so
   * a fixed id lets a replacement task reclaim its predecessor's in-flight batch at boot
   * instead of waiting out the lease. Set RELAY_INSTANCE_ID uniquely per replica if more
   * than one writer ever shares a store.
   */
  instanceId: string
  ingest: { port: number; host: string }
  admin: { port: number; host: string }
  metrics: { port: number; host: string }
  dispatch: DispatchSettings
  retention: RetentionSettings
  telemetry: { enabled: boolean }
  /**
   * Ask End Close whether it owns this environment's configuration, and how often to
   * poll for changes while it does.
   */
  remoteConfig: { enabled: boolean; pollIntervalMs: number }
}

function int(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]
  if (raw === undefined || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`)
  }
  return n
}

export function loadRuntimeSettings(env: NodeJS.ProcessEnv = process.env): RuntimeSettings {
  return {
    // Override for staging/testing: ENDCLOSE_BASE_URL=https://api-staging.endclose.com/v1
    endcloseBaseUrl: env.ENDCLOSE_BASE_URL || ENDCLOSE_API_URL,
    instanceId: env.RELAY_INSTANCE_ID || 'relay',
    ingest: {
      port: int(env, 'RELAY_INGEST_PORT', 8443),
      host: env.RELAY_INGEST_HOST || '0.0.0.0',
    },
    admin: {
      port: int(env, 'RELAY_ADMIN_PORT', 8081),
      host: env.RELAY_ADMIN_HOST || '0.0.0.0',
    },
    metrics: {
      port: int(env, 'RELAY_METRICS_PORT', 9090),
      host: env.RELAY_METRICS_HOST || '0.0.0.0',
    },
    dispatch: {
      batchMax: int(env, 'RELAY_BATCH_MAX', DEFAULT_DISPATCH.batchMax),
      pollIntervalMs: int(env, 'RELAY_POLL_INTERVAL_MS', DEFAULT_DISPATCH.pollIntervalMs),
      backoffBaseMs: int(env, 'RELAY_BACKOFF_BASE_MS', DEFAULT_DISPATCH.backoffBaseMs),
      backoffCapMs: int(env, 'RELAY_BACKOFF_CAP_MS', DEFAULT_DISPATCH.backoffCapMs),
      parkAfterMs: int(env, 'RELAY_PARK_AFTER_MS', DEFAULT_DISPATCH.parkAfterMs),
      leaseMs: int(env, 'RELAY_LEASE_MS', DEFAULT_DISPATCH.leaseMs),
      recoverIntervalMs: int(env, 'RELAY_RECOVER_INTERVAL_MS', DEFAULT_DISPATCH.recoverIntervalMs),
      // The application registers no enrichments (a library-only feature), so no env knob.
      enrichTimeoutMs: DEFAULT_DISPATCH.enrichTimeoutMs,
    },
    retention: {
      deliveredDays: int(env, 'RELAY_RETENTION_DELIVERED_DAYS', DEFAULT_RETENTION.deliveredDays),
      ledgerDays: int(env, 'RELAY_RETENTION_LEDGER_DAYS', DEFAULT_RETENTION.ledgerDays),
    },
    telemetry: { enabled: isTelemetryEnabled(env) },
    remoteConfig: {
      enabled: isRemoteConfigEnabled(env),
      pollIntervalMs: int(env, 'RELAY_REMOTE_POLL_MS', 60_000),
    },
  }
}

/**
 * Default on. RELAY_REMOTE_CONFIG=off (or 0 / false) stops the application asking End
 * Close for its configuration at all: the relay is then always configured locally.
 */
export function isRemoteConfigEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOff(env.RELAY_REMOTE_CONFIG)
}

/** Default on. RELAY_TELEMETRY=off (or 0 / false) disables the instance manifest call-home. */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isOff(env.RELAY_TELEMETRY)
}

function isOff(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  return v === 'off' || v === '0' || v === 'false'
}
