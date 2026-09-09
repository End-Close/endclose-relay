import type { RouteConfig } from '../config/schema.js'
import {
  ENDCLOSE_API_URL,
  EndCloseClient,
  PermanentHttpError,
} from '../forward/endclose-client.js'
import type { ProcessorAdapter } from '../ingest/adapters/types.js'
import { noopLogger, type Logger } from '../logger.js'
import { buildManifest, type ManifestReason, type ManifestSource } from './manifest.js'
import { parseRoutes } from './routes.js'
import { StoreUnavailableError, type RouteProvider } from './store.js'

// Routes held by End Close instead of supplied by the host. An End Close API key is
// issued per relay and scoped to one environment, so the key alone determines which
// environment's document comes back; End Close keeps one configuration per environment.
// The status code of GET /relays/config is the whole answer to who owns the
// configuration: 200 = End Close does (run the document, keep its ETag), 304 = owned and
// unchanged since the ETag sent, 404 = not managed. Only route definitions travel this
// way; secrets stay references to names the host's SecretResolver resolves.

export type RemoteConfigErrorKind =
  /** End Close could not be reached or answered with a transient status; retry later. */
  | 'unavailable'
  /** The API key was rejected (401: missing/wrong/revoked; 403: not a relay key). */
  | 'unauthorized'
  /** End Close is not managing this environment (no document, or the switch off). */
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
  /** Send back as `ifNoneMatch` to learn cheaply whether the document changed. */
  etag?: string
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
  /** Host-registered enrichments, so `enrich:` references validate. */
  enrichments?: Record<string, unknown>
  /** Request timeout (default 10 s). */
  timeoutMs?: number
  /** The ETag of the document already held; resolves to `null` when it is unchanged. */
  ifNoneMatch?: string
}

/**
 * Fetch and validate the routes document End Close holds for this API key's
 * environment (`GET /relays/config`). With `ifNoneMatch`, resolves to `null` when End
 * Close answers 304 (owned and unchanged). Throws `RemoteConfigError` otherwise.
 */
export function fetchRemoteConfig(
  src: EndCloseSource,
  opts: FetchRemoteConfigOptions & { ifNoneMatch: string },
): Promise<RemoteConfig | null>
export function fetchRemoteConfig(
  src: EndCloseSource,
  opts?: FetchRemoteConfigOptions & { ifNoneMatch?: undefined },
): Promise<RemoteConfig>
export function fetchRemoteConfig(src: EndCloseSource, opts: FetchRemoteConfigOptions = {}): Promise<RemoteConfig | null> {
  return fetchDocument(toEndCloseClient(src), opts)
}

async function fetchDocument(client: EndCloseClient, opts: FetchRemoteConfigOptions): Promise<RemoteConfig | null> {
  let res: Awaited<ReturnType<EndCloseClient['getRelayConfig']>>
  try {
    res = await client.getRelayConfig({
      ...(opts.ifNoneMatch !== undefined ? { etag: opts.ifNoneMatch } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    })
  } catch (err) {
    if (err instanceof PermanentHttpError) {
      if (err.status === 404) {
        throw new RemoteConfigError('not_found', 'End Close is not managing this environment\'s configuration', {
          cause: err,
        })
      }
      if (err.status === 401 || err.status === 403) {
        throw new RemoteConfigError('unauthorized', `End Close rejected the API key (HTTP ${err.status})`, {
          cause: err,
        })
      }
      throw new RemoteConfigError('invalid', `unexpected response from End Close: ${err.message}`, {
        cause: err,
      })
    }
    throw new RemoteConfigError('unavailable', `End Close is unreachable: ${(err as Error).message}`, {
      cause: err,
    })
  }
  if (res.status === 'unchanged') return null

  const doc = res.body as { routes?: unknown; environment?: unknown } | null
  if (!doc || typeof doc !== 'object' || !('routes' in doc)) {
    throw new RemoteConfigError('invalid', 'End Close configuration response carries no routes document')
  }
  let routes: RouteConfig[]
  try {
    routes = parseRoutes(
      { routes: doc.routes },
      {
        ...(opts.adapters ? { adapters: opts.adapters } : {}),
        ...(opts.enrichments ? { enrichments: opts.enrichments } : {}),
      },
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
    ...(res.etag !== undefined ? { etag: res.etag } : {}),
    fetchedAt: new Date().toISOString(),
  }
}

export interface RemoteRoutesOptions extends Omit<FetchRemoteConfigOptions, 'ifNoneMatch'> {
  /**
   * How long a fetched document is served before the next access triggers a background
   * re-fetch (default 60 s). The re-fetch sends the ETag, so an unchanged document
   * costs a 304. A failed refresh keeps the last document.
   */
  refreshIntervalMs?: number
  logger?: Logger | null
  /**
   * Announce this instance to End Close (`PUT /relays/instances/{id}`): `boot` with the
   * first fetch, `heartbeat` on the first refresh after `heartbeatIntervalMs` (default
   * 15 min), `shutdown` on request. That is how End Close knows this instance's adapters
   * and enrichments when the configuration is authored. Omit to send nothing.
   */
  manifest?: ManifestSource & { instanceId: string; heartbeatIntervalMs?: number }
}

export interface RemoteRouteProvider extends RouteProvider {
  /** The cached document, fetching first if nothing is loaded yet. Throws `RemoteConfigError`. */
  load(): Promise<RemoteConfig>
  /** Fetch now, replacing the cached document; on failure the cache stays and the error is thrown. */
  refresh(): Promise<RemoteConfig>
  /** The document currently served, if any. */
  current(): RemoteConfig | undefined
  /** Send the instance manifest now (no-op without `manifest`). Never throws. */
  announce(reason: ManifestReason, opts?: { timeoutMs?: number }): Promise<void>
}

export const DEFAULT_REMOTE_REFRESH_MS = 60_000
export const DEFAULT_MANIFEST_HEARTBEAT_MS = 15 * 60_000
// After a failed initial load, further lookups answer "unavailable" from the cached
// error for this long instead of re-fetching per webhook.
const FAILED_LOAD_HOLD_MS = 5_000

/**
 * A `RouteProvider` backed by End Close. The first lookup fetches (and fails with
 * `StoreUnavailableError`, so ingest answers 503 and the processor retries, until a
 * document has been loaded); later lookups serve the cached document and re-fetch in
 * the background once it is older than `refreshIntervalMs`. Once a document is held,
 * nothing End Close answers later takes it away: a 404 (management switched off) or an
 * error keeps the last document running and is logged.
 */
export function remoteRoutes(src: EndCloseSource, opts: RemoteRoutesOptions = {}): RemoteRouteProvider {
  const client = toEndCloseClient(src)
  const logger = opts.logger ?? noopLogger
  const refreshMs = opts.refreshIntervalMs ?? DEFAULT_REMOTE_REFRESH_MS
  const fetchOpts: FetchRemoteConfigOptions = {
    ...(opts.adapters ? { adapters: opts.adapters } : {}),
    ...(opts.enrichments ? { enrichments: opts.enrichments } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  }

  let cached: RemoteConfig | undefined
  let byId = new Map<string, RouteConfig>()
  let inFlight: Promise<RemoteConfig> | undefined
  let lastError: RemoteConfigError | undefined
  let holdUntil = 0
  let lastAnnouncedAt: number | undefined
  const heartbeatMs = opts.manifest?.heartbeatIntervalMs ?? DEFAULT_MANIFEST_HEARTBEAT_MS

  const announce = async (reason: ManifestReason, o: { timeoutMs?: number } = {}): Promise<void> => {
    if (!opts.manifest) return
    lastAnnouncedAt = Date.now()
    try {
      await client.putRelayInstance(opts.manifest.instanceId, buildManifest(opts.manifest, reason), o)
    } catch (err) {
      logger.warn('End Close instance manifest not accepted', { reason, error: (err as Error).message })
    }
  }

  const fetchNow = (): Promise<RemoteConfig> => {
    if (inFlight) return inFlight
    holdUntil = Date.now() + (cached ? refreshMs : FAILED_LOAD_HOLD_MS)
    // The manifest goes first so End Close learns this instance's capabilities even
    // when it has nothing to serve yet (register, then author). Its content never
    // changes, so later refreshes only re-announce at the heartbeat cadence.
    if (lastAnnouncedAt === undefined) void announce('boot')
    else if (Date.now() - lastAnnouncedAt >= heartbeatMs) void announce('heartbeat')
    const held = cached
    inFlight = fetchDocument(client, {
      ...fetchOpts,
      ...(held?.etag !== undefined ? { ifNoneMatch: held.etag } : {}),
    })
      .then((config) => {
        lastError = undefined
        holdUntil = Date.now() + refreshMs
        if (config === null) {
          // 304: owned and unchanged. Only the fetch time moves.
          cached = { ...held!, fetchedAt: new Date().toISOString() }
          return cached
        }
        const first = held === undefined
        const changed = first || JSON.stringify(held!.document) !== JSON.stringify(config.document)
        cached = config
        byId = new Map(config.routes.map((r) => [r.id, r]))
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
          logger.warn(
            e.kind === 'not_found'
              ? 'End Close is no longer managing this configuration; serving the last document'
              : 'End Close configuration refresh failed; serving the last document',
            { kind: e.kind, error: e.message },
          )
        } else {
          logger.error(
            e.kind === 'not_found'
              ? 'End Close is not managing this environment and no local routes were given: nothing can be ingested (503) until management is switched on'
              : 'End Close configuration unavailable',
            { kind: e.kind, error: e.message },
          )
        }
        throw e
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  const unavailable = (e: RemoteConfigError, op: string) =>
    new StoreUnavailableError(`End Close configuration unavailable: ${e.message}`, op, { cause: e })

  const ready = async (op: string): Promise<void> => {
    if (cached) {
      if (Date.now() >= holdUntil && !inFlight) void fetchNow().catch(() => {}) // logged in fetchNow
      return
    }
    if (!inFlight && lastError && Date.now() < holdUntil) throw unavailable(lastError, op)
    try {
      await fetchNow()
    } catch (err) {
      throw unavailable(err as RemoteConfigError, op)
    }
  }

  return {
    get: async (id) => {
      await ready('routes.get')
      return byId.get(id)
    },
    all: async () => {
      await ready('routes.all')
      return [...byId.values()]
    },
    load: () => (cached ? Promise.resolve(cached) : fetchNow()),
    refresh: fetchNow,
    current: () => cached,
    announce,
  }
}
