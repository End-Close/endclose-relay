# endclose-relay — Security Overview

This document is written for the security team reviewing a deployment of endclose-relay
inside your infrastructure. It describes exactly what the appliance does, what data
leaves your network, what End Close can and cannot do, and how to verify all of it
yourself. Where a claim is enforceable by inspection, we say how to inspect it.

## What it is

endclose-relay is a self-hosted webhook relay: your payment processor's webhooks are
pointed at it, it durably buffers them inside your network, maps an explicitly
configured subset of each payload into a financial record, and forwards those records to
End Close's public API for reconciliation. It runs as **one container plus one Docker
volume** on a host you control. The source code is available for review.

```
Payment processor ──HTTPS──▶ relay :8443   (verify → encrypt → persist → ack)
                              │
                              ▼
                    SQLite buffer (encrypted payloads, your volume)
                              │  explicit field map = allowlist
                              ▼
                    api.endclose.com:443   (HTTPS, X-API-KEY)
```

## What leaves your network

**Only the fields named in your `relay.yaml` map blocks.** There is no mode in which
unnamed fields are forwarded:

- Each route maps a webhook to a record: date, amount, direction, an external ID, and a
  `metadata` object containing **only** explicitly listed `output_name: source_path`
  entries. Unmapped payload fields never leave the appliance.
- Fields can be forwarded hashed (`transform: hash`): a deterministic HMAC-SHA256 keyed
  by `MASKING_HMAC_KEY`, which **never leaves the appliance**. End Close can match equal
  values across records without ever seeing the raw value.
- A **non-configurable hard denylist** applies on top of every mapped value: Luhn-valid
  card numbers (PANs) and SSN patterns inside strings are redacted, and config
  validation refuses to map fields whose names indicate card verification codes,
  account/routing numbers, SSNs, passwords, or API keys unless they are hashed. No
  configuration option disables this; it is compiled into the binary
  (`src/mask/defaults.ts`).

**Verify it yourself:** `relayctl map preview --route <id> --sample <payload.json>`
prints the exact record that would be sent, the source of every field, and every payload
field that is *not* forwarded. It runs locally and sends nothing. Your security team
signs off on the map; the config's SHA-256 hash is recorded (`relayctl config validate`)
and any later change is visible in the audit log and the config-version history.

## What End Close can and cannot do

| | |
|---|---|
| Receive the mapped records you configured | ✅ |
| See raw webhook payloads, unmapped fields, or hashed originals | ❌ no code path |
| Reach into the appliance (any inbound connection) | ❌ all connections are outbound |
| Flip killswitches, change config, or execute anything remotely | ❌ admin plane is loopback-only |
| See your processor credentials or the appliance's keys | ❌ never transmitted or stored server-side |

The relay makes exactly one kind of outbound connection: HTTPS to
`api.endclose.com:443`, authenticated by an API key you hold. Revoking that key (or
blocking that egress) severs the relationship completely; buffered data stays on your
volume.

## Network surface

- **Inbound:** one port, `:8443` (webhook ingest). Front it with your own TLS
  termination / load balancer. Requests are verified per route (processor auth header
  compared in constant time, plus optional source-IP allowlist) before anything is
  stored.
- **Admin plane `:8081`:** binds to the container's loopback; not published by the
  shipped compose file; unreachable from any network. Operating it requires `docker
  exec` on the host — the security boundary is host access, which you administer.
- **Metrics `:9090`:** not published by default. If you opt in, it exposes operational
  counters only (no payload data), with optional basic auth (`METRICS_BASIC_AUTH`).
- **Egress allowlist for your firewall:** `api.endclose.com:443`, plus your image
  registry for pulls. Nothing else. No telemetry, no phone-home.

## Data at rest

- Buffered payloads are encrypted with **AES-256-GCM** (per-row random IV) under a key
  derived from `RELAY_DATA_KEY`, which you generate and hold. A copied volume or backup
  exposes ciphertext.
- Storage is a single SQLite database on a named Docker volume, written with
  `synchronous=FULL` so an acknowledged webhook survives power loss.
- **Retention:** payloads of successfully delivered (or filtered) events are wiped after
  7 days; their rows — kept as an idempotency ledger — are deleted after 30. Both are
  configurable. Failed events are **parked**, kept until you replay or resolve them,
  and never silently dropped.

## Secrets

All secrets enter via environment variables (`.env`, which you manage): the End Close
API key, processor webhook secrets, and the two appliance keys. `relay.yaml` references
secrets **by env-var name only** — the file contains no secret material and is safe to
keep in your git. Secrets are never written to the database, the logs, or the audit
log. The logging layer only accepts scalar metadata by construction — there is no API
for logging a payload.

## Killswitches and audit

You hold three levers, flippable only from the host (`relayctl`, which requires Docker
access), never remotely:

| Lever | Ingest | Forwarding | Data loss |
|---|---|---|---|
| `pause --route <id>` | acks + buffers | stopped for that route | none |
| `pause` (global) | acks + buffers | stopped | none |
| `panic` | refused (HTTP 503) | stopped | none within the processor's retry window |

Every killswitch flip, config apply, and event replay is written to an **append-only
audit log** with timestamp, actor (the invoking OS user), and detail — exportable as
JSONL via `relayctl audit export`. The status UI and API are read-only; all mutations go
through the CLI so they carry an identity.

## Container hardening

The shipped image and compose file run: non-root user, read-only root filesystem
(tmpfs for `/tmp`, the data volume as the only writable mount), `no-new-privileges`,
config mounted read-only from a host path outside the compose project. Version updates
replace the image only; there is no write path from the relay (or from End Close) to
your config.

## Supply chain

- Dependency policy enforced at every install and in CI (`pnpm-workspace.yaml`):
  packages must be at least 24 hours old at resolution time, and only two named packages
  (`better-sqlite3`, `esbuild`) may run install scripts. Exact versions are locked in
  `pnpm-lock.yaml`; the package manager itself is version-pinned.
- CI runs typecheck, the full test suite, a production build, config-schema
  compatibility checks against shipped configs, and a Docker image build on every
  change.
- Signed images with SBOMs are planned as part of the release pipeline; until then,
  builds are reproducible from source and you can build the image yourself from a
  reviewed checkout.

## Questions this document should have answered

- *What data leaves our network?* Only explicitly mapped fields; preview with
  `relayctl map preview`; hard denylist on top.
- *Can End Close access our systems?* No. No inbound connections, loopback-only admin,
  read-only visibility limited to the records you send.
- *Where does data live and for how long?* Encrypted SQLite on your volume; 7-day
  payload retention, 30-day ledger, parked events until you resolve them.
- *How fast can we stop it?* One command (`relayctl pause` or `panic`); or revoke the
  API key / block egress. Nothing is lost while paused.
- *Who can operate it?* Whoever you give Docker access on the host; every action is
  attributed and auditable.
