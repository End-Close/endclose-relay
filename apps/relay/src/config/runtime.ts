// Runtime settings: everything that applies at boot and never hot-applies — the End
// Close endpoint, listener ports, dispatch/retention tuning. These live in the
// environment, NOT in the config document, so that everything in the (UI-editable,
// DB-authoritative) config applies live and "restart pending" isn't a concept the
// operator has to track. The config document contains routes only.

import { hostname } from 'node:os'
import { DEFAULT_DISPATCH, DEFAULT_RETENTION } from '@endclose/relay'

export interface RuntimeSettings {
  endcloseBaseUrl: string
  /** Lease owner for claimed batches. Unique per running task; stable across restarts of the same container. */
  instanceId: string
  ingest: { port: number; host: string }
  admin: { port: number; host: string }
  metrics: { port: number; host: string }
  dispatch: {
    batch_max: number
    poll_interval_ms: number
    backoff_base_ms: number
    backoff_cap_ms: number
    park_after_ms: number
    lease_ms: number
    recover_interval_ms: number
  }
  retention: {
    delivered_days: number
    ledger_days: number
  }
  telemetry: { enabled: boolean }
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
    endcloseBaseUrl: env.ENDCLOSE_BASE_URL || 'https://api.endclose.com/v1',
    // Container hostname = container id on Docker/ECS: unique per task, stable across restarts.
    instanceId: env.RELAY_INSTANCE_ID || hostname(),
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
      batch_max: int(env, 'RELAY_BATCH_MAX', DEFAULT_DISPATCH.batchMax),
      poll_interval_ms: int(env, 'RELAY_POLL_INTERVAL_MS', DEFAULT_DISPATCH.pollIntervalMs),
      backoff_base_ms: int(env, 'RELAY_BACKOFF_BASE_MS', DEFAULT_DISPATCH.backoffBaseMs),
      backoff_cap_ms: int(env, 'RELAY_BACKOFF_CAP_MS', DEFAULT_DISPATCH.backoffCapMs),
      park_after_ms: int(env, 'RELAY_PARK_AFTER_MS', DEFAULT_DISPATCH.parkAfterMs),
      lease_ms: int(env, 'RELAY_LEASE_MS', DEFAULT_DISPATCH.leaseMs),
      recover_interval_ms: int(env, 'RELAY_RECOVER_INTERVAL_MS', DEFAULT_DISPATCH.recoverIntervalMs),
    },
    retention: {
      delivered_days: int(env, 'RELAY_RETENTION_DELIVERED_DAYS', DEFAULT_RETENTION.deliveredDays),
      ledger_days: int(env, 'RELAY_RETENTION_LEDGER_DAYS', DEFAULT_RETENTION.ledgerDays),
    },
    telemetry: { enabled: isTelemetryEnabled(env) },
  }
}

/** Default on. RELAY_TELEMETRY=off (or 0 / false) disables the operational call-home. */
export function isTelemetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.RELAY_TELEMETRY ?? '').trim().toLowerCase()
  return raw !== 'off' && raw !== '0' && raw !== 'false'
}
