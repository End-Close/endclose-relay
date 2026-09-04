# Compatibility

Within a major version the following are stable and change only additively:

- **The routes document** (`routes:` in relay.yaml / `parseRoutes`): field names, transforms
  (`trim`, `lowercase`, `hash`), `auth` modes, the hard denylist's *existence*. `auth.secret`
  is an alias of `auth.secret_env`. Denylist *patterns* may tighten in a minor release.
- **`mapEvent` output**: the record shape (`date`, `data_stream_key`, `amount` in integer
  cents, `direction`, `external_id`, `currency?`, `description?`, `metadata`).
- **Idempotency derivations**: per event `sha256(source + ":" + eventId)`; per bulk request
  `"relay-" + sha256("<data_stream_key>:<external_id>\n" per record)[0:40]`; bulk POSTs use
  `on_conflict: "skip"`.
- **`EventStore` / `EventStoreAdmin` / `ControlStore` / `RouteProvider`** interfaces and the
  behavioural contract in `@endclose/relay-store-contract`. New optional methods may be added.
- **`IngestResult`** status codes and outcomes.
- **Hook event names and payload fields** (fields may be added).
- **Adapter interface** `ProcessorAdapter` (`verify`, `extractEventId`, `extractEventType`).

Not covered: the internal `Dispatcher` class, package file layout, log message text.
