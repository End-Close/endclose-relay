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
- Four secrets generated into `.env` (see `relay.example.yaml` header):
  `ENDCLOSE_API_KEY` (issued by End Close), `PAYABLI_WEBHOOK_SECRET` (random token you
  will also configure in Payabli, e.g. `Bearer $(openssl rand -hex 24)`),
  `RELAY_DATA_KEY` and `MASKING_HMAC_KEY` (32+ random chars each; back these up — data
  at rest is unreadable without them).

**End Close side (we do this with you):**
- Create one data stream per route: `payabli_settlements_funded`,
  `payabli_batches_paid` (type `api`).
- Property definitions for the mapped metadata fields (`batch_id`, `batch_number`,
  `total_amount`, `return_amount`, `entry_point`, `paypoint`, `method`) so they are
  validated and displayed in the dashboard.
- Issue an environment-scoped API key for the appliance (sandbox first, production at
  go-live).

## 1. Install (sandbox)

```sh
mkdir -p /opt/endclose-relay /etc/endclose-relay
cd /opt/endclose-relay
# copy docker-compose.yaml + .env here, and relay.yaml to /etc/endclose-relay/
docker compose up -d

# install the host CLI wrapper once
docker compose exec relay cat /app/bin/relayctl | sudo tee /usr/local/bin/relayctl > /dev/null
sudo chmod +x /usr/local/bin/relayctl

relayctl status        # expect: killswitch none, both routes listed, 0 events
```

Start from `relay.example.yaml`; the reference for every field is `docs/CONFIG.md`. For
sandbox, set the Payabli IP allowlist to the sandbox egress IP (`52.3.204.115`).

**Checkpoint:** `relayctl status` is green and the End Close dashboard shows the relay's
data streams (empty).

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

Fire test transactions in the Payabli sandbox and watch:

```sh
relayctl status                 # delivered counts increment
relayctl events ls --limit 10   # both event types, status=delivered
```

**Checkpoint:** records visible in the End Close staging data streams with the expected
amounts and metadata.

## 3. Masking sign-off (the trust ceremony)

With your security contact, review exactly what leaves your network:

```sh
relayctl map preview --route payabli-settlements --sample settlement.json
relayctl map preview --route payabli-batches --sample batch.json
```

The output is the exact outbound record, each field's source, and — the important part —
`not_forwarded`: every payload field that stays local. Iterate on the `map` blocks until
your security team approves, then record the approved config:

```sh
relayctl config validate    # prints the config_hash
```

End Close pins that hash on our side and alerts if a relay ever reports a different one.
Any local change is also visible in `relayctl audit export` (action `config.apply`, with
actor and hash).

**Checkpoint:** written sign-off referencing the config_hash.

## 4. Go-live

1. End Close issues the production API key; swap it in `.env`.
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

- *Parked events* (`relayctl events ls --status parked`): read `last_error`. Mapping
  errors usually mean a payload-shape change — fix the map, `relayctl config apply`,
  then `relayctl events replay --parked`. Rejected-by-End-Close rows: contact us, then
  replay.
- *Pause for a change window*: `relayctl pause` (events keep buffering, nothing is
  lost), do your work, `relayctl resume`, watch the queue drain.
- *Relay down longer than ~10 minutes*: Payabli only retries a failed delivery 2 times
  at 5-minute intervals, so an extended outage (or `panic`) can miss events. Recover
  via Payabli's notification logs: search `POST /api/v2/notificationlogs` for failed
  deliveries in the window and replay each with
  `GET /api/v2/notificationlogs/{uuid}/retry` (or bulk retry). The relay dedupes
  anything that was actually delivered, so over-replaying is safe. As a belt-and-braces
  audit, Payabli's `/Query/transactions` can be compared against the End Close data
  stream for the outage window.

**Upgrades:** version updates never touch your config (see README "Configuration vs.
updates"). A managed update flow ships together with fleet distribution; until then,
End Close will coordinate updates with you directly.

## Support

- Incident contact: <ops@endclose.com>
- When contacting us, include: `relayctl status` output and, if relevant,
  `relayctl events ls --status parked`. Never send payload contents — we don't want
  them, and `relayctl` never prints them.
