# Configuration Reference

The complete configuration surface — a declarative YAML document, edited and versioned
in the admin UI's config tab (a `relay.yaml` file seeds the appliance once, on first
boot). Authoritative source: `src/config/schema.ts` (zod); anything the schema rejects
fails validation in the UI and at boot. Shipped configs (`relay.example.yaml`,
`dev/relay.dev.yaml`) are validated in CI, which is how we keep the compatibility
promise: schema changes that would break an existing config fail our build.

Secrets never appear in this file — fields ending in `_env` name an **environment
variable** that holds the secret.

## The config document: routes only

The config document contains exactly one top-level key — `routes` — and **everything in
it applies live** on apply; there is no restart-pending state. Anything boot-time
(endpoints, ports, tuning) is an environment setting instead: mixing the two in one
editable document is how "I changed it in the UI but nothing happened" incidents occur.

Legacy configs containing the old sections (`endclose`, `ingest`, …) still parse — the
sections are ignored with a warning shown by validate/apply.

## Environment settings

| Env var | Default | Notes |
|---|---|---|
| `ENDCLOSE_API_KEY` | — | the End Close API key (fixed name) |
| `ENDCLOSE_BASE_URL` | `https://api.endclose.com/v1` | override for staging/testing |
| `ADMIN_BASIC_AUTH` | — | **required**; `user:password` protecting the admin UI/API |
| `RELAY_DATA_KEY` / `MASKING_HMAC_KEY` | — | **required**; 32+ chars each (`openssl rand -hex 32`) |
| `RELAY_DB_PATH` | `/var/lib/endclose-relay/relay.db` | SQLite location (must be known before config can load) |
| `RELAY_CONFIG` | `/etc/endclose-relay/relay.yaml` | first-boot seed file path |
| `RELAY_SECRETS_FILE` | — | strict mode: load secrets from a mounted file |
| `RELAY_INGEST_PORT` / `RELAY_INGEST_HOST` | `8443` / `0.0.0.0` | webhook listener |
| `RELAY_ADMIN_PORT` / `RELAY_ADMIN_HOST` | `8081` / `0.0.0.0` | admin UI/API (compose publishes host-loopback only) |
| `RELAY_METRICS_PORT` / `RELAY_METRICS_HOST` | `9090` / `0.0.0.0` | Prometheus + `/healthz` `/readyz`; optional `METRICS_BASIC_AUTH` |
| `RELAY_BATCH_MAX` | `100` | records per bulk POST (max 1000) |
| `RELAY_POLL_INTERVAL_MS` | `250` | dispatcher wake interval |
| `RELAY_BACKOFF_BASE_MS` / `RELAY_BACKOFF_CAP_MS` | `1000` / `600000` | retry curve: base·2ⁿ ±20% jitter, capped |
| `RELAY_PARK_AFTER_MS` | 7 days | retrying events park (never dropped) after this |
| `RELAY_RETENTION_DELIVERED_DAYS` | `7` | payloads of delivered/filtered events wiped after |
| `RELAY_RETENTION_LEDGER_DAYS` | `30` | their rows (idempotency ledger) deleted after |
| `LOG_LEVEL` | `info` | pino level |

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
YAML, SHA-256 hash, timestamp) and an audit entry, and **takes effect immediately**
(the document is routes-only; nothing in it needs a restart). The version history
supports loading any previous version back into the editor to restore it, and the
active config can be downloaded as YAML at any time.
