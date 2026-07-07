# endclose-relay

A small self-hosted webhook relay appliance for [End Close](https://endclose.com) customers
who don't want to grant End Close direct access to their payment processors or internal systems.

Payment-processor webhooks (Payabli first) point at the relay inside **your** infrastructure.
The relay:

1. **Verifies** each webhook (static-header + source-IP for Payabli; HMAC for processors that sign).
2. **Persists it durably** (encrypted, SQLite `synchronous=FULL`) *before* acknowledging — no
   data loss if End Close is unreachable.
3. **Maps** each event to an End Close record through an explicit field map — the map *is*
   the allowlist: nothing leaves your network unless a field is named in it (optionally
   hashed with an appliance-local key). A non-configurable hard denylist (PANs, SSNs,
   CVV/account-number-named fields) applies on top of every mapped value.
4. **Forwards** records to End Close's public API (`POST /v1/records/bulk`, `X-API-KEY`),
   with exponential-backoff retries and idempotency at both ends. Failed events park
   visibly; they are never silently dropped.

You hold the killswitches: `pause` (buffer locally, forward nothing) and `panic` (refuse
ingest entirely). Neither can be flipped remotely — End Close's visibility into the relay is
read-only and metadata-only.

## Operations

Everything operational goes through `relayctl` (backed by a loopback-only admin API on
`:8081` — the security boundary is host access; End Close cannot reach it):

```sh
relayctl status                      # queues, killswitch, per-route delivery state
relayctl pause | resume | panic      # global killswitch (per-route: --route <id>)
relayctl events ls --status parked   # inspect events (payloads never shown)
relayctl events replay --parked      # re-queue parked events
relayctl audit export                # append-only audit log as JSONL
relayctl config plan | apply         # diff/apply an edited relay.yaml without restart
```

In Docker: `docker compose exec relay node dist/cli/relayctl.js status`.

A read-only status page is served at `http://127.0.0.1:8081/`, and Prometheus metrics +
`/healthz` `/readyz` probes at `:9090` (optional basic auth via `METRICS_BASIC_AUTH`):
`relay_ingest_total`, `relay_forward_total`, `relay_queue_depth`,
`relay_delivery_lag_seconds`, `relay_killswitch_state`, `relay_db_bytes`.

Retention: payloads of delivered/filtered events are wiped after 7 days and their rows
(the idempotency ledger) deleted after 30 (`retention:` in relay.yaml). Parked events are
kept until replayed — never silently dropped.

## Quick start

```sh
cp relay.example.yaml relay.yaml   # review masking/routes with End Close
cat > .env <<'EOF'
ENDCLOSE_API_KEY=...
PAYABLI_WEBHOOK_SECRET=Bearer <random-token-you-also-set-in-payabli>
RELAY_DATA_KEY=<32+ random chars>
MASKING_HMAC_KEY=<32+ random chars>
EOF
docker compose up -d
```

Then configure the Payabli notifications (`payout_batch_settlement_funded`,
`payout_batch_paid`) to POST to `https://<your-host>/ingest/payabli-settlements` and
`.../ingest/payabli-batches` with the matching `Authorization` header via
`webHeaderParameters`.

## Preview what leaves your network

```sh
pnpm relayctl map preview --config relay.yaml --route payabli-settlements \
  --sample test/fixtures/payabli-settlement-funded.json
```

Prints the exact End Close record that would be forwarded, which source field each output
came from, and every payload field that is **not** forwarded. Runs locally; nothing is
sent anywhere.

## Configuration vs. updates

Your config and End Close's version updates travel on **separate channels that cannot
touch each other**:

- **Config is yours.** `relay.yaml` lives at an absolute path on your host
  (`/etc/endclose-relay/` by default), outside anything a deployment tool manages, and is
  mounted read-only. The relay has no write path to its own config — there is no API, UI,
  or update mechanism that can modify it. Changing the masking allowlist requires host
  access, through whatever change process you already use (git + config management,
  Terraform templating a file, or hand edits — the file is the interface).
- **Updates are ours.** A new version is a new image tag. Updating = pull + recreate; the
  container starts against the same mounted config and the same data volume. End Close
  commits to config-schema compatibility within a major version (additive changes only),
  and release notes flag anything config-related.
- **Preflight before you update.** Validate your existing config against a new image
  before switching to it:

  ```sh
  docker run --rm -v /etc/endclose-relay:/etc/endclose-relay:ro \
    ghcr.io/endclose/relay:<new-version> node dist/cli/relayctl.js config validate
  ```

  Schema problems exit non-zero and name the offending field.
- **Undeploy ≠ update.** A fleet-manager undeploy (`docker compose down -v`) deletes the
  buffered-events volume. It's a killswitch, not an upgrade path.

## Development

```sh
pnpm install
pnpm test        # unit + integration (mock End Close API)
pnpm typecheck
pnpm dev:all     # mprocs: relay (watch mode) + mock End Close API
```

`pnpm dev:all` starts [mprocs](https://github.com/pvolok/mprocs) with the relay in watch
mode (dev config `dev/relay.dev.yaml`, dev secrets from `mprocs.yaml`) and a mock End Close
API that prints every record the relay forwards. Select the `webhooks` process and press
`s` to fire the Payabli fixture webhooks at the relay; `test` runs vitest in watch mode.

## Egress

The relay makes outbound connections to `api.endclose.com:443` only.
