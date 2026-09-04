// @endclose/relay — the embeddable store-and-forward engine behind the End Close relay.

export { createRelay, parseRoutes, DEFAULT_DISPATCH, DEFAULT_RETENTION } from './engine/relay.js'
export type { Relay, RelayOptions, DispatchSettings, RetentionSettings, DispatchOnceResult } from './engine/relay.js'
export { ingestWebhook, eventTypeMatches, eventIdempotencyKey } from './engine/ingest.js'
export type { IngestDeps, IngestResult, IngestResultOutcome } from './engine/ingest.js'
export { Dispatcher } from './forward/dispatcher.js'
export type { DispatcherDeps, DispatcherSettings } from './forward/dispatcher.js'

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
  EngineErrorKind,
} from './engine/hooks.js'
export {
  envSecrets,
  staticSecrets,
  toSecretResolver,
  hasSecret,
  requireSecret,
  SecretUnavailableError,
} from './engine/secrets.js'
export type { SecretResolver } from './engine/secrets.js'
export { noopLogger, consoleLogger } from './logger.js'
export type { Logger, LogMeta } from './logger.js'

export * from './config/schema.js'
export { mapEvent, toCents, parseDate, MappingError } from './forward/mapper.js'
export type { EndCloseRecord, MapReport, MappedEvent } from './forward/mapper.js'
export { EndCloseClient, TransientHttpError, PermanentHttpError } from './forward/endclose-client.js'
export type { BulkRequestSummary, BulkResultItem } from './forward/endclose-client.js'
export { backoffMs, nextAttemptAt } from './forward/backoff.js'
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
