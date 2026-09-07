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
  behavioural contract in `@endclose/relay-store-contract`. New optional methods may be added;
  required methods are not. A store signals lock contention or loss of connection by throwing
  `StoreUnavailableError` (ingest answers 503); any other `StoreError` answers 500.
- **`IngestResult`** status codes and outcomes.
- **Hook event names and payload fields** (fields may be added).
- **Adapter interface** `ProcessorAdapter` (`verify`, `extractEventId`, `extractEventType`).

Not covered: the internal `Dispatcher` class, package file layout, log message text.

The packages are unpublished and carry version `0.0.0`; the product version is the
workspace root's. Semantic versions are assigned at first publish.
