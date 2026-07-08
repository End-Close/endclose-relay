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

**Only the fields named in your configuration's map blocks.** There is no mode in which
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

**Verify it yourself:** the admin UI's config tab has a **map preview**: paste a sample
payload and see the exact record that would be sent, the source of every field, and
every payload field that is *not* forwarded. It runs locally and sends nothing. Your
security team signs off on the map; every applied configuration is stored as an
immutable version with its SHA-256 hash, and any later change is visible in the audit
log and the version history.

## What End Close can and cannot do


|                                                                |                                           |
| -------------------------------------------------------------- | ----------------------------------------- |
| Receive the mapped records you configured                      | ✅                                         |
| See raw webhook payloads, unmapped fields, or hashed originals | ❌ no code path                            |
| Reach into the appliance (any inbound connection)              | ❌ all connections are outbound            |
| Flip killswitches, change config, or execute anything remotely | ❌ admin plane is host-local, credentialed by you |
| See your processor credentials or the appliance's keys         | ❌ never transmitted or stored server-side |


The relay makes exactly one kind of outbound connection: HTTPS to
`api.endclose.com:443`, authenticated by an API key you hold. Revoking that key (or
blocking that egress) severs the relationship completely; buffered data stays on your
volume.

## Network surface

- **Inbound:** one port, `:8443` (webhook ingest). Front it with your own TLS
termination / load balancer. Requests are verified per route (processor auth header
compared in constant time, plus optional source-IP allowlist) before anything is
stored.
- **Admin plane** `:8081`**:** the management UI/API, protected by **mandatory basic
auth** (`ADMIN_BASIC_AUTH`, a credential you generate and hold). The shipped compose
file publishes it to the **host's loopback only** — reachable via SSH tunnel; exposing
it wider is a deliberate action on your side and should sit behind your internal TLS
(basic auth over plaintext HTTP is only acceptable host-locally). Mutating requests
additionally reject cross-site browser calls (`Sec-Fetch-Site` checks; CORS disabled),
so a malicious page cannot ride an operator's cached credentials. Failed
authentications are delayed to blunt brute force.
- **Setup mode:** if required env (`RELAY_DATA_KEY`, `MASKING_HMAC_KEY`,
`ADMIN_BASIC_AUTH`) is missing or invalid at boot, the relay does not run — it serves a
static setup page on `:8081` naming the offending variable names and answers everything
else with 503. That page is intentionally unauthenticated: it exists precisely because
the admin credential may be the thing that's missing, it appears only while the relay
holds no data and accepts no webhooks, and it discloses nothing but env-var names.
- **Metrics** `:9090`**:** not published by default. If you opt in, it exposes operational
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

All secrets enter as environment variables on the relay container, provided through
whatever secret-management mechanism you already use: the End Close API key, processor
webhook secrets, and the two appliance keys. Configuration references secrets **by
env-var name only** — it contains no secret material and is safe to keep in your git. Secrets are never written to the database, the logs, or the audit
log. The logging layer only accepts scalar metadata by construction — there is no API
for logging a payload. Missing secrets degrade safely: the UI banners any
config-referenced secret that isn't set, and a missing End Close API key means events
buffer locally without forwarding — nothing is lost and nothing falls open.

## Configuration provenance

The appliance database is the configuration's source of truth. Every applied config is
an **immutable version row** — full YAML, SHA-256 hash, timestamp — and the history is
retained and browsable in the UI. A `relay.yaml` file is read exactly once, to seed an
empty appliance; after that no file, image update, or redeploy can alter configuration —
only an authenticated admin request can, and each one appends a version and an audit
entry. The active config is exportable as YAML at any time (for sign-off records, your
git, or seeding a replacement appliance). Secrets are not part of configuration: the
YAML references env-var names only, and the UI can neither display nor set secret
values — rotating a credential means changing the container's environment through your
secret-management mechanism and recreating the container.

## Killswitches and audit

You hold three levers, flippable only through the authenticated admin plane, never
remotely by End Close:


| Lever            | Ingest             | Forwarding             | Data loss                                |
| ---------------- | ------------------ | ---------------------- | ---------------------------------------- |
| per-route pause  | acks + buffers     | stopped for that route | none                                     |
| global pause     | acks + buffers     | stopped                | none                                     |
| panic            | refused (HTTP 503) | stopped                | none within the processor's retry window |


Every killswitch flip, config apply, and event replay is written to an **append-only
audit log** with timestamp and detail — exportable as JSONL from the UI. Attribution is
instance-level (the appliance records *that* an authenticated admin acted and *what*
changed); per-person attribution, if you need it, comes from your own access records for
the admin credential and host.

## Container hardening

The shipped image and compose file run: non-root user, read-only root filesystem
(tmpfs for `/tmp`, the data volume as the only writable mount), `no-new-privileges`,
seed config mounted read-only. Version updates replace the image only; configuration
and buffered data live on the volume, which updates never touch.

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

- *What data leaves our network?* Only explicitly mapped fields; preview any payload in
the UI's config tab; hard denylist on top.
- *Can End Close access our systems?* No. No inbound connections, a host-local admin
plane credentialed by you, read-only visibility limited to the records you send.
- *Where does data live and for how long?* Encrypted SQLite on your volume; 7-day
payload retention, 30-day ledger, parked events until you resolve them.
- *How fast can we stop it?* One click in the admin UI (pause or panic); or revoke the
API key / block egress. Nothing is lost while paused.
- *Who can operate it?* Whoever holds the admin credential (and host access for
secrets); every action is auditable, attributed at instance level.

