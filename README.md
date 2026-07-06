# endclose-relay

A small self-hosted webhook relay appliance for [End Close](https://endclose.com) customers
who don't want to grant End Close direct access to their payment processors.

Payment-processor webhooks (Payabli first) point at the relay inside **your** infrastructure.
The relay:

1. **Verifies** each webhook (static-header + source-IP for Payabli; HMAC for processors that sign).
2. **Persists it durably** (encrypted, SQLite `synchronous=FULL`) *before* acknowledging — no
   data loss if End Close is unreachable.
3. **Masks** the payload with declarative allowlist rules — nothing leaves your network unless
   the config names it, and a non-configurable hard denylist (PANs, CVV, ACH numbers, SSNs,
   secret-named keys) applies on top in every mode.
4. **Maps + forwards** events as records to End Close's public API
   (`POST /v1/records/bulk`, `X-API-KEY`), with exponential-backoff retries and idempotency
   at both ends. Failed events park visibly; they are never silently dropped.

You hold the killswitches: `pause` (buffer locally, forward nothing) and `panic` (refuse
ingest entirely). Neither can be flipped remotely — End Close's visibility into the relay is
read-only and metadata-only.

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
pnpm relayctl mask preview --config relay.yaml --route payabli-settlements \
  --sample test/fixtures/payabli-settlement-funded.json
```

Prints the exact masked output plus a per-field kept/dropped/hashed report. Runs locally;
nothing is sent anywhere.

## Development

```sh
pnpm install
pnpm test        # unit + integration (mock End Close API)
pnpm typecheck
pnpm dev         # needs RELAY_CONFIG + the env vars above
```

## Egress

The relay makes outbound connections to `api.endclose.com:443` only.
