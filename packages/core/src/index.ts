// @endclose/relay — the embeddable store-and-forward engine behind the End Close relay.

export { createRelay, parseRoutes, assertKnownSources, assertKnownEnrichments, routeEnrichments } from './engine/relay.js'
export type { Relay, RelayOptions, DispatchOnceResult, FlushResult } from './engine/relay.js'
export type { DispatchCounts } from './forward/dispatcher.js'
export { DEFAULT_DISPATCH, DEFAULT_RETENTION } from './engine/settings.js'
export type { DispatchSettings, RetentionSettings } from './engine/settings.js'
export type { IngestResult, IngestResultOutcome } from './engine/ingest.js'
export { eventIdempotencyKey } from './engine/ingest.js'
export {
  fetchRemoteConfig,
  remoteRoutes,
  RemoteConfigError,
  DEFAULT_REMOTE_REFRESH_MS,
} from './engine/remote-config.js'
export type {
  RemoteConfig,
  RemoteConfigErrorKind,
  RemoteRouteProvider,
  RemoteRoutesOptions,
  FetchRemoteConfigOptions,
  EndCloseSource,
} from './engine/remote-config.js'

export * from './engine/store.js'
export { MemoryEventStore, memoryStore } from './engine/memory-store.js'
export { aesGcmCodec, plainCodec } from './engine/codec.js'
export type { PayloadCodec } from './engine/codec.js'
export { RelayHooks } from './engine/hooks.js'
export type {
  RelayEvents,
  RelayEventName,
  RelayHandler,
  IngestOutcome,
  ForwardResult,
  EnrichOutcome,
  EngineErrorKind,
} from './engine/hooks.js'
export { envSecrets, staticSecrets, hasSecret, requireSecret, SecretUnavailableError } from './engine/secrets.js'
export type { SecretResolver } from './engine/secrets.js'
export { noopLogger, consoleLogger } from './logger.js'
export type { Logger, LogMeta } from './logger.js'

export * from './config/schema.js'
export { mapEvent, toCents, parseDate, MappingError } from './forward/mapper.js'
export type { EndCloseRecord, MapReport, MappedEvent, PendingEnrichment } from './forward/mapper.js'
export { EnrichmentError, EnrichTimeoutError, validateEnrichedValue, withTimeout } from './forward/enrich.js'
export type { Enrichment, EnrichContext } from './forward/enrich.js'
export { EndCloseClient, TransientHttpError, PermanentHttpError, ENDCLOSE_API_URL } from './forward/endclose-client.js'
export type { BulkRequestSummary, BulkResultItem } from './forward/endclose-client.js'
export { adapterFor, hasAdapter } from './ingest/adapters/registry.js'
export { payabliAdapter } from './ingest/adapters/payabli.js'
export { genericHmacAdapter } from './ingest/adapters/generic-hmac.js'
export { headerValue } from './ingest/adapters/types.js'
export type { ProcessorAdapter, RawRequest, VerifyContext, VerifyResult } from './ingest/adapters/types.js'
export { hardDenyValue, hardDenyDeep, keyNameIsSensitive, REDACTED } from './mask/defaults.js'
export { getAtPath, leafPaths } from './mask/paths.js'
export type { Json } from './mask/paths.js'
export { encrypt, decrypt } from './crypto/at-rest.js'
export { deriveKey } from './crypto/keys.js'
export { jsonTopLevelKeys, requestHeaderNames } from './util/payload-shape.js'
