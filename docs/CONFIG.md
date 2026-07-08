# Configuration Reference

The complete configuration surface — a declarative YAML document, edited and versioned
in the admin UI's config tab (a `relay.yaml` file seeds the appliance once, on first
boot). Authoritative source: `src/config/schema.ts` (zod); anything the schema rejects
fails validation in the UI and at boot. Shipped configs (`relay.example.yaml`,
`dev/relay.dev.yaml`) are validated in CI, which is how we keep the compatibility
promise: schema changes that would break an existing config fail our build.

Secrets never appear in this file — fields ending in `_env` name an **environment
variable** that holds the secret.

## Top level

| Section | Field | Default | Notes |
|---|---|---|---|
| `endclose` | `base_url` | `https://api.endclose.com/v1` | End Close public API |
| | `api_key_env` | `ENDCLOSE_API_KEY` | env var holding the API key |
| `ingest` | `port` / `host` | `8443` / `0.0.0.0` | webhook listener |
| `admin` | `port` / `host` | `8081` / `0.0.0.0` | admin UI/API; **mandatory** `ADMIN_BASIC_AUTH=user:pass`; compose publishes it to the host's loopback only |
| `metrics` | `port` / `host` | `9090` / `0.0.0.0` | Prometheus + `/healthz` `/readyz`; not published by default; optional `METRICS_BASIC_AUTH=user:pass` |
| `dispatch` | `batch_max` | `100` | records per bulk POST (max 1000) |
| | `poll_interval_ms` | `250` | dispatcher wake interval |
| | `backoff_base_ms` / `backoff_cap_ms` | `1000` / `600000` | retry curve: base·2ⁿ ±20% jitter, capped |
| | `park_after_ms` | 7 days | retrying events park (never dropped) after this |
| `retention` | `delivered_days` | `7` | payloads of delivered/filtered events wiped after |
| | `ledger_days` | `30` | their rows (idempotency ledger) deleted after |
| `routes` | | *required, ≥1* | see below |

Additional env vars (not in the config): `ADMIN_BASIC_AUTH` (required), `RELAY_CONFIG`
(seed file path, default `/etc/endclose-relay/relay.yaml`), `RELAY_DB_PATH` (SQLite
buffer, default `/var/lib/endclose-relay/relay.db` — env-only since the database must
open before config can be read from it), `RELAY_DATA_KEY` (at-rest encryption),
`MASKING_HMAC_KEY` (keys the `hash` transform), `METRICS_BASIC_AUTH`, `LOG_LEVEL`.

## Routes

One route = one inbound webhook source = one End Close data stream.

```yaml
routes:
  - id: payabli-settlements          # lowercase slug; URL: POST /ingest/<id>
    source: payabli                  # adapter: payabli | generic_hmac
    auth: { ... }                    # per-source, below
    events: ["TransferFunded"]       # optional; payload event types this route accepts
                                     # ('*' globs allowed). Others persist locally as
                                     # dropped_by_filter and are never forwarded.
    max_body_bytes: 1048576          # default 1 MiB, max 10 MiB
    map: { ... }                     # below — the complete answer to "what leaves"
```

### `auth` — `mode: static_header` (Payabli)

Payabli doesn't sign webhooks; verification is a constant-time header compare plus an
optional source-IP allowlist.

| Field | Default | Notes |
|---|---|---|
| `header` | `authorization` | header to compare |
| `secret_env` | *required* | env var with the expected value (set the same value in Payabli via `webHeaderParameters`) |
| `allowed_ips` | `[]` | Payabli egress: sandbox `52.3.204.115`, production `54.166.54.170` |

### `auth` — `mode: hmac` (generic, processors #2..N)

| Field | Default | Notes |
|---|---|---|
| `header` | *required* | signature header |
| `algorithm` | `sha256` | or `sha512` |
| `secret_env` | *required* | signing secret |
| `signed_content` | `body` | or `timestamp.body` (Stripe-style) |
| `timestamp_header` / `tolerance_seconds` | — / `300` | required for `timestamp.body`; stale requests are rejected |
| `event_id` / `event_type` | — | dot paths to the processor's stable ID / event type |

## `map` — what leaves your network

Only fields named here are forwarded, ever. Paths are **dot notation** into the payload:
`batchId`, `batch.id`, `lines.*.id` (`*` fans out over an array).

| Field | Required | Notes |
|---|---|---|
| `data_stream_key` | ✅ | target End Close data stream |
| `external_id` | ✅ | stable processor ID → idempotency at both ends |
| `amount` | ✅ | string/number in currency format (`"3,762.87"`, `"$38.00"`) → integer cents |
| `direction` | ✅ | literal `credit` or `debit` |
| `date` | — | omit → record dated by receive time. `transferTime`-style fields: `{ source: transferTime, format: mdy_hms }` (`M/D/YYYY H:mm:ss`); default format `iso8601` |
| `description` | — | optional text field |
| `currency` | — | ISO 4217; End Close defaults to USD |
| `metadata` | `{}` | `output_name: source` entries — output names are what End Close property definitions see (snake_case) |

Every mapped field is either a bare source path or an object with transforms:

```yaml
external_id: transferId                                    # bare path
customer_email: { source: CustomerEmail, transform: hash } # single transform
customer_email:
  source: CustomerEmail
  transform: [trim, lowercase, hash]                       # applied in order
```

Transforms: `trim`, `lowercase` (strings; elementwise over wildcard arrays), `hash`
(keyed HMAC-SHA256 under `MASKING_HMAC_KEY` — deterministic, so End Close can match
values it never sees raw; the key never leaves the appliance).

**Hard denylist (not configurable):** Luhn-valid PANs and SSN patterns inside mapped
string values are redacted, and validation rejects mapping sensitive-named fields (cvv,
account/routing numbers, ssn, password, api key, …) unless hashed.

**Preview before anything is sent:** the config tab's map preview runs any sample
payload through a route's map — against the draft in the editor, before saving — and
shows the outbound record plus every field that is *not* forwarded.

## Lifecycle

The database is authoritative. `relay.yaml` seeds an empty appliance on first boot and
is ignored afterwards. Edits happen in the config tab: **validate** (schema + secret
env status), **preview**, **apply** — each apply appends an immutable version (full
YAML, SHA-256 hash, timestamp) and an audit entry. Route-level changes take effect
immediately; changes to ports, the `endclose` block, or dispatch/retention tuning apply
on the next container restart (the UI flags "restart pending"). The version history
supports loading any previous version back into the editor to restore it, and the
active config can be downloaded as YAML at any time.
