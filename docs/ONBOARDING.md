# endclose-relay — Onboarding Playbook

The path from first install to production, for a customer deploying the relay with
Payabli as the payment processor. Each phase ends with a concrete checkpoint. Expect the
whole sandbox phase to take about an hour of hands-on time.

## 0. Prerequisites

**Customer side:**
- A Linux host (VM is fine) with Docker + Compose, reachable by your processor's
  webhooks (typically behind your own TLS terminator / load balancer on 443 → relay
  :8443).
- Egress allowed to `api.endclose.com:443` and your image registry. Nothing else is
  needed (see `docs/SECURITY.md`).
- Five secrets provided to the relay container as **environment variables**, through
  whatever mechanism you normally use for secrets (your secret manager's env injection,
  Compose `env_file`, systemd credentials, …): `ENDCLOSE_API_KEY` (issued by End Close),
  `PAYABLI_WEBHOOK_SECRET` (random token you will also configure in Payabli, e.g.
  `Bearer $(openssl rand -hex 24)`), `RELAY_DATA_KEY` and `MASKING_HMAC_KEY` (32+ random
  chars each; back these up — data at rest is unreadable without them), and
  `ADMIN_BASIC_AUTH=user:password` for the admin UI. See the `relay.example.yaml` header
  for what each one does.

**End Close side (we do this with you):**
- Create one data stream per route: `payabli_settlements_funded`,
  `payabli_batches_paid` (type `api`).
- Property definitions for the mapped metadata fields (`batch_id`, `batch_number`,
  `total_amount`, `return_amount`, `entry_point`, `paypoint`, `method`) so they are
  validated and displayed in the dashboard.
- Issue an environment-scoped API key for the appliance (sandbox first, production at
  go-live).

## 1. Install (sandbox)

### Option A — Distr-managed (recommended)

End Close distributes and updates the relay through [Distr](https://distr.sh): a small
open-source agent on your host polls outbound-only and applies versions you approve.
You'll receive an invite to your Distr Customer Portal from End Close.

1. **Create the data volume** (once — it's `external`, so undeploying the relay never
   deletes it):
   ```sh
   docker volume create endclose-relay-data
   ```
2. **Provide the five secrets** — either enter them as Secrets in your Distr Customer
   Portal (write-only after creation; never visible to End Close), or strict mode:
   ```sh
   install -m 600 relay.env /etc/endclose-relay/relay.env   # the five variables
   # then set RELAY_SECRETS_FILE=/host-config/relay.env in the deployment env
   ```
   The trade-offs are laid out in `docs/SECURITY.md` (Secrets + Fleet management).
3. **Install the agent** with the one-liner from your portal (per deployment target):
   ```sh
   curl "https://app.distr.sh/api/v1/connect?targetId=...&targetSecret=..." | docker compose -f - up -d
   ```
4. **Deploy the relay** from the portal — pick the version End Close published and
   fill the env values (only `RELAY_SECRETS_FILE` if you use strict mode).
5. **Configure it**: the relay boots into **bootstrap mode** (no webhooks accepted
   yet). Open the admin UI — `ssh -L 8081:127.0.0.1:8081 <host>` then
   `http://127.0.0.1:8081` (basic auth from `ADMIN_BASIC_AUTH`) — paste your initial
   configuration, validate, preview, apply. The relay restarts itself into running
   mode.

### Option B — manual compose

```sh
mkdir -p /opt/endclose-relay /etc/endclose-relay
cd /opt/endclose-relay
# copy docker-compose.yaml here, optionally a seed relay.yaml to /etc/endclose-relay/,
# and wire the five environment variables into the relay service (secret manager,
# env_file, ... — however you manage secrets)
docker compose up -d
```

With a seed file the relay comes up configured; without one it boots into bootstrap
mode exactly as above. Start any seed from `relay.example.yaml`; the reference for
every field is `docs/CONFIG.md`.

### Either way

If any required variable is missing or invalid, the relay serves a **setup page** on
`:8081` naming exactly what's wrong (and does nothing else) — fix the environment and
recreate the container. For sandbox, set the Payabli IP allowlist to the sandbox egress
IP (`52.3.204.115`).

**Checkpoint:** the status tab shows both routes, killswitch "forwarding", 0 events —
and the End Close dashboard shows the relay's data streams (empty).

## 2. Point Payabli at the relay

Create two `web` notifications in Payabli (API `POST /api/Notification`, or
PartnerHub/PayHub → Settings → Reports & Notifications):

| Payabli notification | Target URL |
|---|---|
| `payout_batch_settlement_funded` | `https://<your-host>/ingest/payabli-settlements` |
| `payout_batch_paid` | `https://<your-host>/ingest/payabli-batches` |

For each, set the auth header via `webHeaderParameters` to exactly the value of
`PAYABLI_WEBHOOK_SECRET`, e.g.:

```json
{ "key": "Authorization", "value": "Bearer <your token>" }
```

> ⚠️ **Duplicate-notification warning:** Payabli fires a notification for *each* level
> it's configured at. If the same event is configured on both the organization
> (`ownerType: 0`) and a paypoint (`ownerType: 2`), you'll receive it twice. The relay
> dedupes by stable event ID, so this is harmless — but configure one level to keep the
> logs clean.

Fire test transactions in the Payabli sandbox and watch the admin UI: the status tab's
delivered counts increment, and the events tab shows both event types with status
`delivered`.

**Checkpoint:** records visible in the End Close staging data streams with the expected
amounts and metadata.

## 3. Masking sign-off (the trust ceremony)

With your security contact, open the admin UI's **config tab** and use **map preview**:
paste a sample payload for each route and review the exact outbound record, each field's
source, and — the important part — `not_forwarded`: every payload field that stays
local. Iterate on the `map` blocks in the editor (preview works on the draft, before
anything is saved) until your security team approves, then **apply**. The applied
version's `config_hash` is shown in the header and version history.

End Close pins that hash on our side and alerts if a relay ever reports a different one.
Every later change appends a new version and an audit entry. **Download the approved
YAML** from the config tab for your sign-off records.

**Checkpoint:** written sign-off referencing the config_hash; exported YAML archived.

## 4. Go-live

1. End Close issues the production API key; update `ENDCLOSE_API_KEY` in your secret
   store and recreate the container.
2. Update the route IP allowlists to Payabli's production egress IP (`54.166.54.170`).
3. Configure the production Payabli notifications (same two events, production
   paypoint), fire a low-value live transaction if feasible.
4. End Close wires the reconciliations to the relay-fed data streams.
5. Both teams watch the first real settlement cycle reconcile end to end.

**Checkpoint:** first settlement funded event reconciles in End Close production.

## 5. Ongoing operations

**Ownership split:** you own the host, the config, the killswitches, and your secrets.
End Close owns publishing relay versions and monitoring ingestion on our side (we alert
when a stream goes quiet or bulk-request failures climb — with no visibility into
payloads).

**Your monitoring** — scrape `:9090` (opt-in port mapping) and consider alerts on:

| Signal | Suggested alert |
|---|---|
| `relay_queue_depth{status="parked"}` | > 0 for 15m — events need attention |
| `relay_queue_depth{status="retry"}` | growing for 30m — End Close unreachable? |
| `relay_delivery_lag_seconds` p95 | > 300s |
| `relay_ingest_total{result="rejected_auth"}` | rate spike — mis-config or probing |
| `/readyz` | non-200 |

**Runbooks:**

- *Parked events* (events tab, filter status=parked): read `last_error`. Mapping
  errors usually mean a payload-shape change — fix the map in the config tab, apply,
  then "replay all parked". Rejected-by-End-Close rows: contact us, then replay.
- *Pause for a change window*: pause from the status tab (events keep buffering,
  nothing is lost), do your work, resume, watch the queue drain.
- *Relay down longer than ~10 minutes*: Payabli only retries a failed delivery 2 times
  at 5-minute intervals, so an extended outage (or `panic`) can miss events. Recover
  via Payabli's notification logs: search `POST /api/v2/notificationlogs` for failed
  deliveries in the window and replay each with
  `GET /api/v2/notificationlogs/{uuid}/retry` (or bulk retry). The relay dedupes
  anything that was actually delivered, so over-replaying is safe. As a belt-and-braces
  audit, Payabli's `/Query/transactions` can be compared against the End Close data
  stream for the outage window.

**Upgrades (Distr-managed):** End Close publishes a new version; it appears in your
Distr portal (deployments show as "outdated") with release notes. You approve; the
agent applies it — a pull + recreate against the same data volume, so configuration,
buffered events, and audit history are untouched (verify anytime: config hash in the
admin UI header is unchanged after an upgrade). **Rollback**: redeploy the previous
version from the portal — config versions are forward-compatible within a major
version, so the older relay reads the same config. **Undeploy** stops and removes the
relay's containers but preserves the `endclose-relay-data` volume; a redeploy picks up
exactly where it left off. Deleting data is a separate, explicit
`docker volume rm endclose-relay-data`. Manual-compose installs upgrade with
`docker compose pull && docker compose up -d`.

## Support

- Incident contact: <ops@endclose.com>
- When contacting us, include: the status tab contents (a screenshot is fine) and, if
  relevant, the parked-events list. Never send payload contents — we don't want them,
  and the UI never displays them.
