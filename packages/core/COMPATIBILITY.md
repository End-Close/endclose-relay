# Compatibility

Within a major version the following are stable and change only additively:

- **`createRelay()` and its options** (`RelayOptions` including `enrichments`,
  `DispatchSettings` including `enrichTimeoutMs`, `RetentionSettings` and their defaults),
  the `Relay` methods (`ingest`, `start`, `stop`, `dispatchOnce`, `flush`, `prune`, `preview`,
  `readPayload`, `on`) and their result shapes (`IngestResult`, `DispatchOnceResult`,
  `FlushResult` including its `reason` values).
- **The enrichment contract**: `Enrichment` (`(input, ctx) => value | undefined`, sync or
  async), `EnrichContext` fields (may be added, never removed or retyped), the meaning of
  `undefined` (omit), a throw (retry) and `EnrichmentError` (park). Validation of returned
  values may tighten in a minor release, like denylist patterns.
- **The routes document** (`routes:` in relay.yaml / `parseRoutes`): field names, transforms
  (`trim`, `lowercase`, `hash`), the `enrich:` key on `description` and `metadata` field refs,
  `auth` modes, the hard denylist's *existence*. Field-ref objects are strict: unknown keys
  are errors. Secrets are referenced by name (`auth.secret_env`), never by value. Denylist
  *patterns* may tighten in a minor release.
- **`mapEvent` output**: the record shape (`date`, `data_stream_key`, `amount` in integer
  cents, `direction`, `external_id`, `currency?`, `description?`, `metadata`), plus
  `pending` (enriched fields the dispatcher fills) and `report.enriched`.
- **Idempotency derivations**: per event `sha256(source + ":" + eventId)`; per bulk request
  `"relay-" + sha256("<data_stream_key>:<external_id>\n" per record)[0:40]`; bulk POSTs use
  `on_conflict: "skip"`.
- **`EventStore` / `EventStoreAdmin` / `ControlStore` / `RouteProvider`** interfaces and the
  behavioural contract in `@end-close/relay-store-contract`. New optional methods may be added;
  required methods are not. A store signals lock contention or loss of connection by throwing
  `StoreUnavailableError` (ingest answers 503); any other `StoreError` answers 500.
- **Configuration from End Close**: `routes` omitted from `createRelay()` means fetch from
  `GET /relays/config` with the API key (200 = owned, 304 = unchanged for the ETag sent,
  404 = not managed); `fetchRemoteConfig`, `remoteRoutes` and its
  `load`/`refresh`/`current`/`announce`, `RemoteConfig` fields, and `RemoteConfigError.kind`
  values. The response's `routes` is the same document as `routes:` in relay.yaml.
- **Instance manifest**: the `InstanceManifest` shape sent to `PUT /relays/instances/{id}`
  (`schema: 1`), `buildManifest`, `CONFIG_SCHEMA_VERSION`, and the `EnrichmentRegistration`
  form `{ fn, description?, output? }` alongside a bare function.
- **`IngestResult`** status codes and outcomes.
- **Hook event names and payload fields** (fields may be added).
- **Adapter interface** `ProcessorAdapter` (`verify`, `extractEventId`, `extractEventType`).

Not covered: the internal `Dispatcher` class, package file layout, log message text.

`@end-close/relay`, `@end-close/relay-sqlite` and `@end-close/relay-store-contract` are published
to npm in lockstep with the relay application: every release tags one version, and all three
packages carry it. Install them at the same version. The release PR stamps the product
version into each package manifest (`0.0.0` only ever means "not yet released"). While the
major is `0`, a minor bump may carry breaking changes; patch releases are additive.
