# @endclose/relay

The store-and-forward engine behind the End Close relay appliance, as a library you embed in
your own Node backend. Same code, same guarantees:

1. **Verify** each webhook over the raw bytes (Payabli static header + source IP; HMAC for
   processors that sign).
2. **Persist it durably before acknowledging** in a store you choose.
3. **Map** it to an End Close record through an explicit field map: the map *is* the
   allowlist, and a non-configurable hard denylist (PANs, SSNs, secret-named fields) applies
   on top.
4. **Forward** in batches to End Close's public API with exponential backoff, idempotency
   at both ends, and parking (never silent dropping) of events that cannot be delivered.

Node `>=22.12`, ESM. The only runtime dependency is `zod`.

## Quick start

```ts
import { createRelay, parseRoutes, envSecrets } from '@endclose/relay'
import { SqliteEventStore, SqliteControlStore, openDb, migrate } from '@endclose/relay-sqlite'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'

const db = openDb('/var/lib/myapp/relay.db')
migrate(db)

const relay = createRelay({
  // The `routes` block of relay.yaml, validated. Only fields named in each `map` are forwarded.
  routes: parseRoutes(parse(readFileSync('relay.yaml', 'utf8'))),
  store: new SqliteEventStore(db),
  control: new SqliteControlStore(db),      // killswitch + per-route pause; omit for in-memory
  secrets: envSecrets(process.env),         // resolves `auth.secret_env` names
  endclose: { apiKey: process.env.ENDCLOSE_API_KEY! },
  encryption: { dataKey: process.env.RELAY_DATA_KEY! },   // or 'none' (be explicit)
  maskingKey: process.env.MASKING_HMAC_KEY!,              // keys the `hash` transform
  logger: myLogger,                          // { debug, info, warn, error }(msg, scalarMeta)
  instanceId: process.env.HOSTNAME,          // unique per replica; stable across restarts of the same one
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

What your framework must do because the engine cannot:

- **Hand over the raw body.** Signature verification and the stored payload operate on the
  exact bytes the processor sent. Disable JSON pre-parsing for the webhook route.
- **Cap request size** before it reaches `ingest` (the appliance uses 10 MB); per-route
  `max_body_bytes` is enforced inside.
- **Pass the real client IP** if you use `allowed_ips` (configure your proxy trust).

## Storage

`EventStore` is an async interface (`packages/core/src/engine/store.ts`). Ships with:

- `@endclose/relay-sqlite` — the appliance's store. Rollback journal + `synchronous=FULL`,
  safe on network filesystems. Add `SqliteControlStore` for killswitch state.
- `memoryStore()` — in-process, **not durable**. For development and tests.

Any implementation that passes `describeEventStoreContract()` from
`@endclose/relay-store-contract` works. Claiming is lease-based, so several instances can
share one store (a SQL store would use `FOR UPDATE SKIP LOCKED` in `claimDue`).

## Observability

`relay.on(event, handler)` delivers metadata-only events: `ingest`, `stored`, `settled`,
`forward`, `delivered`, `batch.forwarded`, `batch.parked`, `prune`, `error`. Payloads are never
included.
The appliance drives its Prometheus metrics and call-home from these; the engine itself
never phones home.

## Operating

- `relay.control.setKillswitch('pause' | 'panic' | 'none')`, `setRoutePaused(id, bool)`.
- `relay.store` with `EventStoreAdmin` (SQLite and memory stores have it): `list`, `getById`,
  `replay`, `replayAllParked`, `countByStatus`, `perRouteStats`.
- `relay.preview(route, samplePayload)` shows exactly what would leave your network.
- `relay.readPayload(id)` decrypts a buffered payload. Audit it yourself.
- Retention (`retention: { deliveredDays, ledgerDays }`, or `false`) runs hourly under
  `start()` or on `dispatchOnce({ prune: true })` / `relay.prune()`.

## Lower-level pieces

For a backend with its own queue: `verify` via `adapterFor(source).verify(raw, route, { secret })`,
`mapEvent(route, payload, receivedAt, maskingKey)`, `EndCloseClient`, `hardDenyDeep`,
`keyNameIsSensitive`, `parseRoutes`.

See `COMPATIBILITY.md` for what is a stable contract.
