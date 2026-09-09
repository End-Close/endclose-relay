# @end-close/relay

The store-and-forward engine behind the End Close relay application, as a library you embed in
your own Node backend. Same code, same guarantees:

1. **Verify** each webhook over the raw bytes (Payabli static header + source IP; HMAC for
   processors that sign).
2. **Persist it durably before acknowledging** in a store you choose.
3. **Map** it to an End Close record through an explicit field map: the map *is* the
   allowlist, and a non-configurable hard denylist (PANs, SSNs, secret-named fields) applies
   on top. A mapped field may name an **enrichment**: a function of yours that turns the
   payload value into what is forwarded (a resident's name from a payer id, say). The map
   still names every field; your code only fills the ones it points at.
4. **Forward** in batches to End Close's public API with exponential backoff, idempotency
   at both ends, and parking (never silent dropping) of events that cannot be delivered.

Node `>=22.12`, ESM. The only runtime dependency is `zod`.

## Install

```sh
npm install @end-close/relay @end-close/relay-sqlite
```

Install both at the same version: `@end-close/relay-sqlite` peers on `@end-close/relay`, and the
packages are released together in lockstep with the relay application (the version on npm is the
product version). Skip `@end-close/relay-sqlite` if you bring your own `EventStore`. MIT licensed.

## Quick start

```ts
import { createRelay, parseRoutes, envSecrets } from '@end-close/relay'
import { SqliteEventStore, SqliteControlStore, openDb, migrate } from '@end-close/relay-sqlite'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'

const db = openDb('/var/lib/myapp/relay.db')
migrate(db)

const relay = createRelay({
  // The `routes` block of relay.yaml, validated. Only fields named in each `map` are forwarded
  // (pass `{ enrichments }` as the second argument if any route uses `enrich:`).
  // Omit `routes` entirely to run the configuration End Close holds for the API key (below).
  routes: parseRoutes(parse(readFileSync('relay.yaml', 'utf8'))),
  store: new SqliteEventStore(db),
  control: new SqliteControlStore(db),      // killswitch + per-route pause; omit for in-memory
  secrets: envSecrets(process.env),         // resolves `auth.secret_env` names
  endclose: { apiKey: process.env.ENDCLOSE_API_KEY! },
  encryption: { dataKey: process.env.RELAY_DATA_KEY! },   // or 'none' (be explicit)
  maskingKey: process.env.MASKING_HMAC_KEY!,              // keys the `hash` transform
  logger: myLogger,                          // { debug, info, warn, error }(msg, scalarMeta)
  instanceId: 'api-1',                       // stable per replica: a restart reclaims its own batch at once
})

// 1. Mount the ingest path in your HTTP framework. Give it the RAW body bytes.
app.post('/webhooks/:route', async (req, res) => {
  const result = await relay.ingest(req.params.route, {
    rawBody: req.rawBody,                    // Buffer, exactly as sent
    headers: req.headers,
    remoteIp: req.ip,                        // the true client IP (see below)
  })
  res.status(result.status).json(result.body)
})

// 2a. Long-lived process: run the dispatch loop.
relay.start()
process.on('SIGTERM', () => relay.stop().then(() => process.exit(0)))

// 2b. Serverless / cron: run one cycle per invocation instead.
//     await relay.dispatchOnce({ prune: true })
// 2c. Deliver before this process exits (shutdown, a serverless function):
//     const out = await relay.flush({ timeoutMs: 5_000 })   // { delivered, retried, parked, drained, reason? }
```

## Configuration from End Close

Leave `routes` out and the engine fetches them from End Close (`GET /relays/config`) with
the API key. Keys are issued per relay and scoped to one environment, and End Close keeps
one document per environment, so the key alone determines which routes come back. The
status code is the whole answer to who owns the configuration: **200** End Close does
(document + ETag), **304** owned and unchanged since the ETag sent, **404** not managed.

```ts
const relay = createRelay({
  store, secrets, encryption, maskingKey,
  endclose: { apiKey: process.env.ENDCLOSE_API_KEY! },
  instanceId: 'api-1',
  enrichments: {
    // A descriptor alongside the function is what End Close shows when authoring a map
    // that names it. A bare function still works.
    resident_name: { fn: lookupResident, description: 'Resident full name from the payor id', output: 'string' },
  },
  remoteConfig: { refreshIntervalMs: 60_000, announce: true },   // defaults
})
```

- The first lookup fetches. Until a document has loaded, `ingest()` answers **503**
  (`outcome: 'unavailable'`) so the processor retries, and a failed fetch is held for a
  few seconds rather than repeated per webhook.
- Afterwards lookups serve the cached document; once it is older than
  `refreshIntervalMs` the next lookup re-fetches in the background with the ETag, so an
  unchanged document costs a 304 and a change reaches a running relay within roughly one
  interval. A failed refresh — or a 404 once a document is held — keeps the last document
  and is logged, and polling continues at the same cadence (a 404 is a state; polling is
  how the engine learns management was switched back on). An engine that gets a 404
  before it has ever held a document answers 503 to every webhook and logs why: nothing
  is dropped silently. To fail at startup instead, load explicitly (below).
- The document is validated exactly like a local one (`parseRoutes`, including the hard
  denylist and your registered `adapters` and `enrichments` — an `enrich:` naming a
  function you have not registered is rejected). Secrets are still references to names
  your `SecretResolver` resolves; no secret travels from End Close.
- `RemoteConfigError.kind` tells `unavailable` (retryable) from `unauthorized`,
  `not_found` (not managed) and `invalid`.

**Instance manifest.** With `announce` on (the default when routes come from End Close),
the engine PUTs `/relays/instances/{instanceId}` before the first fetch (`boot`), on the
first refresh after each 15-minute heartbeat interval (`heartbeat`) and on `stop()`
(`shutdown`, bounded to a second): `{ schema: 1, reason, host: 'embedded', engine_version, config_schema,
config_source: 'remote', capabilities: { adapters, enrichments } }`. That is how End
Close knows which adapters and enrichment names it may reference when authoring this
environment's configuration — register first, author second. It carries nothing
operational. Give each replica a stable `instanceId`. An engine given local routes sends
nothing.

For fail-fast boots, load explicitly — same options as `endclose:` — and pass the provider in:

```ts
import { remoteRoutes } from '@end-close/relay'
const routes = remoteRoutes({ apiKey }, { logger, manifest: { instanceId: 'api-1', host: 'embedded', configSource: 'remote' } })
await routes.load()                              // throws RemoteConfigError
const relay = createRelay({ routes, ... })
routes.current()?.environment                    // e.g. 'sandbox', when End Close names it
```

`fetchRemoteConfig({ apiKey })` returns one validated document (`routes`, the raw
`document`, `environment?`, `etag?`, `fetchedAt`) without a provider; pass
`{ ifNoneMatch: etag }` to get `null` back when it is unchanged.

## Knowing what happened to an event

`ingest()` resolves as soon as the event is durably in the store; a 2xx means **buffered**,
never **sent**. The accepted result carries the store `id`. From there:

- `dispatchOnce()` runs exactly one cycle (at most `batchMax` per route) and returns counts.
  Use it from a scheduler; overlapping runs are safe because claims are leased.
- `flush()` loops cycles until nothing deliverable remains or the deadline passes, retrying
  as backoff timers expire. It returns immediately with `reason: 'paused'` if forwarding is
  paused, `reason: 'unroutable'` if due events belong to routes the provider no longer
  returns, and `reason: 'timeout'` with `retried > 0` if End Close stayed down. Flushing
  cannot make an unavailable End Close accept records: with `memoryStore()` those events
  are lost when the process exits, with a durable store the next cycle picks them up.
- `relay.on('settled', e => …)` fires per event with `{ id, routeId, result, error? }` where
  `result` is `delivered`, `retried` or `parked` — correlate with the `id` from `ingest()`.
- `relay.store.getById(id)` (stores with the admin capability) gives the current `status`,
  `attempts`, `next_attempt_at` and `last_error`.

**Serverless recipe:** a durable store shared across invocations, `dispatchOnce()` on a
schedule as the guarantee, and optionally `await relay.flush()` after `ingest()` for low
latency when End Close is healthy.

## Enriching fields from your own data

A webhook rarely carries everything End Close should see. When the missing value lives in
your own systems, register an **enrichment** and name it from the map:

```ts
const enrichments = {
  // (value at `source` after transforms, ctx) → the value to forward. undefined → omit the field.
  resident_name: async (payorId, ctx) => {
    const r = await residents.findByPayerId(String(payorId))   // your database, your code
    return r?.fullName
  },
}
const relay = createRelay({
  routes: parseRoutes(parse(yaml), { enrichments }),   // validation knows the registered names
  enrichments,
  dispatch: { enrichTimeoutMs: 3_000 },                 // per call; default 5 s
  ...
})
```

```yaml
map:
  external_id: TransactionId
  amount: NetAmount
  direction: credit
  metadata:
    paypoint: Paypoint
    resident_name: { source: PayorId, enrich: resident_name }
    resident_unit: { source: PayorId, transform: trim, enrich: resident_unit }
```

How it behaves:

- **The map stays the allowlist.** `enrich:` is allowed on `metadata` entries and
  `description` only; `external_id` and `amount` are never host-computed. A route that names
  an enrichment you have not registered fails `parseRoutes` / `createRelay` (or parks its
  events, for routes from a `RouteProvider`). The shipped application registers none, so it
  rejects `enrich:` outright.
- **Order per field:** source value → `transform`s → your function → validation → hard
  denylist → record. If the source is absent the function is not called and the field is
  omitted. `ctx` carries `routeId`, `source`, `eventId`, `eventType`, `receivedAt`, `field`
  and the decrypted `payload` for inputs beyond the one value.
- **Return `undefined`** to omit the field and still send the record (unknown payer).
  **Throw** to retry the whole event with backoff — the rest of its batch still ships, and it
  parks after `parkAfterMs` like any retrying event. **Throw `EnrichmentError`** to park it
  now. A call slower than `enrichTimeoutMs` counts as a throw.
- **What you return is checked like any mapped value:** JSON only, no sensitive key names
  at any depth, PANs and SSNs inside strings redacted, and a sensitive output name (`ssn`,
  `account_number`, …) is refused by the schema even with `transform: hash`, since the
  hash protects the input, not your output. A bad value parks the event with the reason.
- **Enrichments are reads that may run more than once per event** (retry, lease recovery,
  replay). Keep them idempotent and side-effect free, and keep thrown messages free of
  personal data: they are stored as `last_error` and emitted on `settled`.
- Calls run one at a time per event, so a batch can take up to `batchMax × enrichments per
  event × enrichTimeoutMs`; keep that under `leaseMs` (defaults: 100 × 1 × 5 s vs 600 s).
- `relay.on('enrich', e => …)` reports each call as `{ routeId, id, field, enrichment,
  result: applied | omitted | failed | rejected, error? }` — names only, never values.
- `relay.preview(route, sample)` does not run enrichments; it lists their fields in
  `report.enriched` and `pending`.

What your framework must do because the engine cannot:

- **Hand over the raw body.** Signature verification and the stored payload operate on the
  exact bytes the processor sent. Disable JSON pre-parsing for the webhook route.
- **Cap request size** before it reaches `ingest` (the application uses 10 MB); per-route
  `max_body_bytes` is enforced inside.
- **Pass the real client IP** if you use `allowed_ips` (configure your proxy trust).

## Storage

`EventStore` is an async interface (`packages/core/src/engine/store.ts`). Ships with:

- `@end-close/relay-sqlite` — the application's store. Rollback journal + `synchronous=FULL`,
  safe on network filesystems. Add `SqliteControlStore` for killswitch state.
- `memoryStore()` — in-process, **not durable**. For development and tests.

Any implementation that passes `describeEventStoreContract()` from
`@end-close/relay-store-contract` works. Claiming is lease-based, so several instances can
share one store (a SQL store would use `FOR UPDATE SKIP LOCKED` in `claimDue`). Give each
long-lived replica a stable, distinct `instanceId`: on boot an instance reclaims batches it
left `delivering` (a crash), and every `recoverIntervalMs` it sweeps leases other instances
let expire. A random id works too; a crashed replica's batch then waits out `leaseMs`.

## Observability

`relay.on(event, handler)` delivers metadata-only events: `ingest`, `stored`, `settled`,
`forward`, `delivered`, `enrich`, `batch.forwarded`, `batch.parked`, `prune`, `error`. Payloads
and enriched values are never included.
The application drives its Prometheus metrics from these. The engine contacts End Close
on its own only to fetch configuration and, in that case, to announce its instance manifest.

## Operating

- `relay.control.setKillswitch('pause' | 'panic' | 'none')`, `setRoutePaused(id, bool)`.
- `relay.store` with `EventStoreAdmin` (SQLite and memory stores have it): `list`, `getById`,
  `replay`, `replayAllParked`, `countByStatus`, `perRouteStats`.
- `relay.preview(route, samplePayload)` shows exactly what would leave your network, with
  enriched fields listed as pending rather than computed.
- `relay.readPayload(id)` decrypts a buffered payload. Audit it yourself.
- Retention (`retention: { deliveredDays, ledgerDays }`, or `false`) runs hourly under
  `start()` or on `dispatchOnce({ prune: true })` / `relay.prune()`.

## Lower-level pieces

For a backend with its own queue: `verify` via `adapterFor(source).verify(raw, route, { secret })`,
`mapEvent(route, payload, receivedAt, maskingKey)`, `EndCloseClient`, `hardDenyDeep`,
`keyNameIsSensitive`, `parseRoutes`.

See [`COMPATIBILITY.md`](./COMPATIBILITY.md) for what is a stable contract.
