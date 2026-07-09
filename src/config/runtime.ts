// Runtime settings: everything that applies at boot and never hot-applies — the End
// Close endpoint, listener ports, dispatch/retention tuning. These live in the
// environment, NOT in the config document, so that everything in the (UI-editable,
// DB-authoritative) config applies live and "restart pending" isn't a concept the
// operator has to track. The config document contains routes only.

export interface RuntimeSettings {
  endcloseBaseUrl: string
  ingest: { port: number; host: string }
  admin: { port: number; host: string }
  metrics: { port: number; host: string }
  dispatch: {
    batch_max: number
    poll_interval_ms: number
    backoff_base_ms: number
    backoff_cap_ms: number
    park_after_ms: number
  }
  retention: {
    delivered_days: number
    ledger_days: number
  }
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
      batch_max: int(env, 'RELAY_BATCH_MAX', 100),
      poll_interval_ms: int(env, 'RELAY_POLL_INTERVAL_MS', 250),
      backoff_base_ms: int(env, 'RELAY_BACKOFF_BASE_MS', 1000),
      backoff_cap_ms: int(env, 'RELAY_BACKOFF_CAP_MS', 600_000),
      park_after_ms: int(env, 'RELAY_PARK_AFTER_MS', 7 * 24 * 3600 * 1000),
    },
    retention: {
      delivered_days: int(env, 'RELAY_RETENTION_DELIVERED_DAYS', 7),
      ledger_days: int(env, 'RELAY_RETENTION_LEDGER_DAYS', 30),
    },
  }
}
