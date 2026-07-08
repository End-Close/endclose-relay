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

## The admin UI

Everything is managed in a web UI served by the appliance itself at `:8081` (React, built
into the image — no CDN assets, so egress allowlists stay tight), protected by **mandatory
basic auth** (`ADMIN_BASIC_AUTH`). The shipped compose file publishes it to the Docker
host's loopback only; reach it over an SSH tunnel, or deliberately expose it behind your
own internal TLS proxy.

- **status** — queues, killswitch state and controls (pause/resume/panic with
  confirmations), per-route pause toggles.
- **events** — browse buffered/delivered/parked events (payloads are never shown);
  replay parked events individually or in bulk.
- **config** — the declarative YAML config, edited in place: validate against the
  schema, **preview exactly what would leave your network** for a sample payload
  (including every field that is *not* forwarded), apply, and browse/restore the full
  version history. Download the active config as YAML at any time.
- **audit** — the append-only audit log (killswitch flips, config applies, replays),
  downloadable as JSONL.

Boot checks: if required env (`RELAY_DATA_KEY`, `MASKING_HMAC_KEY`, `ADMIN_BASIC_AUTH`)
is missing or invalid, the relay serves an unauthenticated **setup page** on `:8081`
naming exactly what's wrong instead of crash-looping — nothing else runs until it's
fixed. Once running, the UI banners any config-referenced secret that isn't set (a
missing End Close API key buffers events rather than failing boot).

Prometheus metrics + `/healthz` `/readyz` probes are at `:9090` (optional basic auth via
`METRICS_BASIC_AUTH`): `relay_ingest_total`, `relay_forward_total`, `relay_queue_depth`,
`relay_delivery_lag_seconds`, `relay_killswitch_state`, `relay_db_bytes`.

Retention: payloads of delivered/filtered events are wiped after 7 days and their rows
(the idempotency ledger) deleted after 30 (`retention:` in the config). Parked events are
kept until replayed — never silently dropped.

## Documentation

- **[docs/SECURITY.md](docs/SECURITY.md)** — the security-review packet: what leaves
  your network, what End Close can and cannot do, encryption, retention, audit,
  supply chain. Start here if you're a security team.
- **[docs/ONBOARDING.md](docs/ONBOARDING.md)** — install → Payabli setup → masking
  sign-off → go-live → operations runbooks.
- **[docs/CONFIG.md](docs/CONFIG.md)** — the complete configuration reference.

## Quick start

```sh
mkdir -p /etc/endclose-relay
cp relay.example.yaml /etc/endclose-relay/relay.yaml   # the first-boot seed
cat > .env <<'EOF'
ENDCLOSE_API_KEY=...
PAYABLI_WEBHOOK_SECRET=Bearer <random-token-you-also-set-in-payabli>
RELAY_DATA_KEY=<32+ random chars>
MASKING_HMAC_KEY=<32+ random chars>
ADMIN_BASIC_AUTH=admin:<strong password>
EOF
docker compose up -d
```

Open `http://127.0.0.1:8081` (basic auth) on the host — the config tab shows the seeded
config; from here on the UI is how configuration changes. Then configure the Payabli
notifications (`payout_batch_settlement_funded`, `payout_batch_paid`) to POST to
`https://<your-host>/ingest/payabli-settlements` and `.../ingest/payabli-batches` with
the matching `Authorization` header via `webHeaderParameters`.

## Configuration vs. updates

- **Config lives in the appliance, on your volume.** The database is authoritative:
  every change made in the UI becomes a new immutable config version (hash + timestamp,
  full history retained). `relay.yaml` on disk is only read once, to seed an empty
  appliance — redeploys, image updates, and host re-provisioning can never clobber
  UI-made changes, because the config travels with the `relay-data` volume, which
  updates don't touch.
- **Updates are ours.** A new version is a new image tag; updating = pull + recreate
  against the same volume. End Close commits to config-schema compatibility within a
  major version (additive changes only) — enforced mechanically in CI, where the shipped
  configs must stay parseable.
- **Export for your records.** Download the active YAML from the config tab (e.g. after
  a masking sign-off, or to keep a copy in your git); seeding a replacement appliance
  with an exported file reproduces the config exactly.
- **Undeploy ≠ update.** `docker compose down -v` deletes the volume — config *and*
  buffered events. It's a killswitch, not an upgrade path. Include the volume in your
  backups.

## Development

```sh
pnpm install
pnpm test        # unit + integration (mock End Close API)
pnpm typecheck
pnpm dev:all     # mprocs: relay (watch mode) + mock End Close API
```

`pnpm dev:all` starts [mprocs](https://github.com/pvolok/mprocs) with the relay in watch
mode (seed config `dev/relay.dev.yaml`, dev secrets from `mprocs.yaml`, admin auth
`dev:dev`) and a mock End Close API that prints every record the relay forwards. Select
the `webhooks` process and press `s` to fire the Payabli fixture webhooks; `test` runs
vitest in watch mode; `ui` runs the admin UI (`ui/`) on :5173 with Vite HMR, proxying API
calls to the relay — the relay itself serves the built UI from `dist/admin-ui` after
`pnpm build`. Config is seeded into `./data/dev.db` on first boot; `rm -rf data/` to
reseed from the YAML.

## Egress

The relay makes outbound connections to `api.endclose.com:443` only.
