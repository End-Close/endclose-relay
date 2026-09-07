import type { RouteConfig } from '../config/schema.js'
import {
  ENDCLOSE_API_URL,
  EndCloseClient,
  PermanentHttpError,
} from '../forward/endclose-client.js'
import type { ProcessorAdapter } from '../ingest/adapters/types.js'
import { noopLogger, type Logger } from '../logger.js'
import { parseRoutes } from './routes.js'
import { StoreUnavailableError, type RouteProvider } from './store.js'

// Routes held by End Close instead of supplied by the host. An End Close API key is
// issued per relay and scoped to one environment, so the key alone determines which
// environment's document comes back: a host that provides no routes fetches its
// configuration with the key it already has, and keeps it current by re-fetching in the
// background. Only route definitions travel this way; secrets stay references to names
// the host's SecretResolver resolves, exactly as in a local document.

export type RemoteConfigErrorKind =
  /** End Close could not be reached or answered with a transient status; retry later. */
  | 'unavailable'
  /** The API key was rejected. */
  | 'unauthorized'
  /** End Close holds no configuration for this key (nothing provisioned yet). */
  | 'not_found'
  /** The response is not a valid routes document (or an unexpected status). */
  | 'invalid'

export class RemoteConfigError extends Error {
  constructor(
    readonly kind: RemoteConfigErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options)
    this.name = 'RemoteConfigError'
  }
  /** Whether a later attempt could succeed without anyone changing anything. */
  get retryable(): boolean {
    return this.kind === 'unavailable'
  }
}

export interface RemoteConfig {
  /** Validated routes, defaults applied — what the engine runs on. */
  routes: RouteConfig[]
  /** The routes document exactly as End Close returned it, for storing or serialising. */
  document: { routes: unknown }
  /** The End Close environment the API key belongs to, when the response names it. */
  environment?: string
  fetchedAt: string
}

/** A prebuilt client, or the same `endclose` options `createRelay` takes. */
export type EndCloseSource =
  | EndCloseClient
  | { apiKey: string; baseUrl?: string; fetch?: typeof fetch }

export function toEndCloseClient(src: EndCloseSource): EndCloseClient {
  if (src instanceof EndCloseClient) return src
  return new EndCloseClient(src.baseUrl ?? ENDCLOSE_API_URL, src.apiKey, src.fetch ?? fetch)
}

export interface FetchRemoteConfigOptions {
  /** Host-registered adapters, so routes with their sources validate. */
  adapters?: Record<string, ProcessorAdapter>
  /** Request timeout (default 10 s). */
  timeoutMs?: number
}

/**
 * Fetch and validate the routes document End Close holds for this API key's
 * environment (`GET /relays/config`). Throws `RemoteConfigError`.
 */
export async function fetchRemoteConfig(
  src: EndCloseSource,
  opts: FetchRemoteConfigOptions = {},
): Promise<RemoteConfig> {
  const client = toEndCloseClient(src)
  let body: unknown
  try {
    body = await client.getRelayConfig(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs })
  } catch (err) {
    if (err instanceof PermanentHttpError) {
      if (err.status === 404) {
        throw new RemoteConfigError('not_found', 'End Close holds no relay configuration for this API key', {
          cause: err,
        })
      }
      if (err.status === 401 || err.status === 403) {
        throw new RemoteConfigError('unauthorized', `End Close rejected the API key (HTTP ${err.status})`, {
          cause: err,
        })
      }
      throw new RemoteConfigError('invalid', `unexpected response from End Close: HTTP ${err.status}`, {
        cause: err,
      })
    }
    throw new RemoteConfigError('unavailable', `End Close is unreachable: ${(err as Error).message}`, {
      cause: err,
    })
  }

  const doc = body as { routes?: unknown; environment?: unknown } | null
  if (!doc || typeof doc !== 'object' || !('routes' in doc)) {
    throw new RemoteConfigError('invalid', 'End Close configuration response carries no routes document')
  }
  let routes: RouteConfig[]
  try {
    routes = parseRoutes(
      { routes: doc.routes },
      opts.adapters ? { adapters: opts.adapters } : {},
    )
  } catch (err) {
    throw new RemoteConfigError(
      'invalid',
      `End Close configuration is not a valid routes document: ${(err as Error).message}`,
      { cause: err },
    )
  }
  const environment = typeof doc.environment === 'string' ? doc.environment : undefined
  return {
    routes,
    document: { routes: doc.routes },
    ...(environment !== undefined ? { environment } : {}),
    fetchedAt: new Date().toISOString(),
  }
}

export interface RemoteRoutesOptions extends FetchRemoteConfigOptions {
  /**
   * How long a fetched document is served before the next access triggers a background
   * re-fetch (default 60 s). A failed refresh keeps the last document.
   */
  refreshIntervalMs?: number
  logger?: Logger | null
}

export interface RemoteRouteProvider extends RouteProvider {
  /** The cached document, fetching first if nothing is loaded yet. Throws `RemoteConfigError`. */
  load(): Promise<RemoteConfig>
  /** Fetch now, replacing the cached document; on failure the cache stays and the error is thrown. */
  refresh(): Promise<RemoteConfig>
  /** The document currently served, if any. */
  current(): RemoteConfig | undefined
}

export const DEFAULT_REMOTE_REFRESH_MS = 60_000
// After a failed initial load, further lookups answer "unavailable" from the cached
// error for this long instead of re-fetching per webhook.
const FAILED_LOAD_HOLD_MS = 5_000

/**
 * A `RouteProvider` backed by End Close. The first lookup fetches (and fails with
 * `StoreUnavailableError`, so ingest answers 503 and the processor retries, until a
 * document has been loaded); later lookups serve the cached document and re-fetch in
 * the background once it is older than `refreshIntervalMs`.
 */
export function remoteRoutes(src: EndCloseSource, opts: RemoteRoutesOptions = {}): RemoteRouteProvider {
  const client = toEndCloseClient(src)
  const logger = opts.logger ?? noopLogger
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REMOTE_REFRESH_MS
  const fetchOpts: FetchRemoteConfigOptions = {
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  }

  let cached: RemoteConfig | undefined
  let byId = new Map<string, RouteConfig>()
  let inFlight: Promise<RemoteConfig> | undefined
  let lastError: RemoteConfigError | undefined
  let holdUntil = 0

  const fetchNow = (): Promise<RemoteConfig> => {
    if (inFlight) return inFlight
    holdUntil = Date.now() + (cached ? refreshMs : FAILED_LOAD_HOLD_MS)
    inFlight = fetchRemoteConfig(client, fetchOpts)
      .then((config) => {
        const first = cached === undefined
        const changed = first || JSON.stringify(cached!.document) !== JSON.stringify(config.document)
        cached = config
        byId = new Map(config.routes.map((r) => [r.id, r]))
        lastError = undefined
        holdUntil = Date.now() + refreshMs
        if (changed) {
          logger.info(first ? 'End Close configuration loaded' : 'End Close configuration updated', {
            routes: config.routes.map((r) => r.id).join(','),
            environment: config.environment ?? null,
          })
        }
        return config
      })
      .catch((err: unknown) => {
        const e = err instanceof RemoteConfigError ? err : new RemoteConfigError('unavailable', String(err), { cause: err })
        lastError = e
        if (cached) {
          logger.warn('End Close configuration refresh failed; serving the last document', {
            kind: e.kind,
            error: e.message,
          })
        } else {
          logger.error('End Close configuration unavailable', { kind: e.kind, error: e.message })
        }
        throw e
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  const unavailable = (e: RemoteConfigError) =>
    new StoreUnavailableError(`End Close configuration unavailable: ${e.message}`, 'routes.get', {
      cause: e,
    })

  const ready = async (): Promise<void> => {
    if (cached) {
      if (Date.now() >= holdUntil && !inFlight) void fetchNow().catch(() => {}) // logged in fetchNow
      return
    }
    if (!inFlight && lastError && Date.now() < holdUntil) throw unavailable(lastError)
    try {
      await fetchNow()
    } catch (err) {
      throw unavailable(err as RemoteConfigError)
    }
  }

  return {
    get: async (id) => {
      await ready()
      return byId.get(id)
    },
    all: async () => {
      await ready()
      return [...byId.values()]
    },
    load: () => (cached ? Promise.resolve(cached) : fetchNow()),
    refresh: fetchNow,
    current: () => cached,
  }
}
