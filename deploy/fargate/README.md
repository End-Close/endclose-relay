# Fargate deploy

Idempotent CloudFormation + helper script: one Fargate task, EFS (access point
uid/gid `999`), public ALB for ingest `:8443`, admin `:8081` not on the ALB.

Taggable resources are labelled so they are easy to spot in the AWS console and in
cost reports:

| Tag | Meaning |
|---|---|
| `Application` | always `endclose-relay` |
| `Name` | `${ServiceName}` or `${ServiceName}-…` (e.g. `-alb`, `-data`) |
| `Component` | what the resource is (`alb`, `efs-data`, `ecs-service`, …) |
| `ManagedBy` | CloudFormation stack name |

Security group descriptions and IAM role descriptions also say **End Close relay**.
ECS service tags propagate to tasks (`PropagateTags: SERVICE`). EFS mount targets
cannot be tagged by AWS.

## Prerequisites

- AWS CLI v2 + `jq`
- Credentials for the target account
- Existing VPC with:
  - ≥1 **public** subnet (ALB)
  - ≥2 **private** subnets in **different AZs** (tasks + EFS mount targets) with NAT
    (or pass `--assign-public-ip`)
- An **ACM certificate in the same region as the stack** for the public relay hostname
  (see [TLS certificate](#tls-certificate) below — not created by this script)

## TLS certificate

Payabli (and browsers) call the ALB over HTTPS. The ALB HTTPS listener needs a
certificate in **Amazon Certificate Manager in the deploy region**. That is separate
from any TLS Cloudflare (or another CDN) terminates at their edge.

Cert provisioning is **intentionally outside** this stack: certs are often shared,
validation depends on who hosts DNS, and tying a cert to stack delete is risky. Pass
the issued ARN as `--certificate-arn`.

### 1. Request a certificate (same region as the ALB)

```sh
aws acm request-certificate \
  --region <region> \
  --domain-name relay.example.com \
  --validation-method DNS \
  --query CertificateArn --output text
```

Use a hostname you control (a subdomain is fine). The ARN is what you pass to
`deploy` once the cert is **Issued**.

### 2. DNS validation CNAME (prove domain ownership)

While status is **Pending validation**, ACM tells you a **CNAME** to create. This
record is only for validation — it does **not** send traffic to the relay.

```sh
aws acm describe-certificate \
  --region <region> \
  --certificate-arn <arn> \
  --query 'Certificate.DomainValidationOptions[].ResourceRecord' \
  --output table
```

Or in the console: **Certificate Manager → certificate → Domains**.

Add that name/value at your DNS host (Route 53, **Cloudflare**, etc.), then wait until
ACM shows **Issued** (often a few minutes after the CNAME is live).

**Cloudflare:** Universal SSL on the orange-cloud proxy does **not** replace this ACM
cert. The ALB still needs its own cert in ACM. Create the ACM validation CNAME as a
normal DNS record in Cloudflare (DNS-only / grey cloud is fine for the `_acm-validations`
name). For the later traffic record, prefer **Full (strict)** to origin once the ALB
has the ACM cert.

### 3. Traffic DNS (after deploy)

When `deploy` finishes it prints the **ALB DNS** name
(`….elb.amazonaws.com`). Point your relay hostname at it:

| DNS provider | Record |
|---|---|
| Route 53 | **A – Alias** to the ALB (preferred) |
| Cloudflare / other | **CNAME** `relay.example.com` → ALB hostname |

That hostname must match the ACM certificate (or be covered by it).

**Admin UI** does not use this hostname: `:8081` stays off the public ALB. Reach it via
VPN / Tailscale into the VPC (`--admin-cidr`) or ECS Exec — private IP is enough.
ECS Exec needs writable mounts for the SSM agent under the container’s read-only root;
the template provides those (`/managed-agents`, `/var/lib/amazon/ssm`, `/var/log/amazon/ssm`).
After changing the task definition, force a new deployment so the running task picks it up.

## Secrets

```sh
cp deploy/fargate/secrets.example.env deploy/fargate/secrets.env
# edit secrets.env — RELAY_DATA_KEY and MASKING_HMAC_KEY must be ≥32 chars each
```

`deploy/fargate/secrets.env` is gitignored; do not commit it.

## Deploy

```sh
chmod +x deploy/fargate/deploy

./deploy/fargate/deploy \
  --region eu-west-1 \
  --vpc vpc-xxxxxxxx \
  --public-subnets subnet-aaa,subnet-bbb \
  --private-subnets subnet-ccc,subnet-ddd \
  --certificate-arn arn:aws:acm:eu-west-1:123456789012:certificate/… \
  --secrets-file deploy/fargate/secrets.env
```

Stack / ECS cluster / service name defaults to **`endclose-relay`** (`--stack` to override).

Optional:

| Flag | Purpose |
|---|---|
| `--stack NAME` | CloudFormation stack name (default `endclose-relay`) |
| `--secrets-file PATH` | Create/update the Secrets Manager secret from a dotenv file |
| `--secret-name NAME` | Secrets Manager name (default `<stack>/relay`). Without `--secrets-file`, use that existing secret as-is |
| `--image ghcr.io/end-close/relay:v0.7.0` | Pin/override image (default is `latest`) |
| `--admin-cidr 10.0.0.0/16` | Allow `:8081` from a VPN/bastion CIDR |
| `--assign-public-ip` | Tasks in public subnets without NAT |
| `--skip-secrets` | Alias for “don’t upload”; same as omitting `--secrets-file` |

First create often takes **5–10 minutes** (EFS mount targets + service stability).

The ALB target group health-checks **`:8081/healthz`** (not ingest `:8443`), because a
fresh volume boots in bootstrap mode with ingest down until you apply config.

## After deploy

1. Finish [traffic DNS](#3-traffic-dns-after-deploy) if you have not already.
2. Bootstrap config — either open the admin UI on `:8081` (VPN / Tailscale) or
   ECS Exec + **`relayctl`** (in-image; uses `ADMIN_BASIC_AUTH`, no password prompt).
   Use [`ops`](./ops) so you don’t chase the task ARN. Command reference:
   [`docs/RELAYCTL.md`](../../docs/RELAYCTL.md).

   ```sh
   ./deploy/fargate/ops admin --open   # Tailscale → http://<ip>:8081
   ./deploy/fargate/ops exec          # ECS Exec shell
   # then inside the container:
   relayctl status
   relayctl config apply /path/to/relay.yaml    # or: relayctl config edit
   ```

   Defaults to stack `endclose-relay` (`--stack` / `RELAY_STACK` to override). Region is
   taken from `AWS_REGION` / `RELAY_REGION`, or prompted. Requires the
   [Session Manager plugin](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)
   for `exec` (`brew install --cask session-manager-plugin` on macOS).
3. Configure Payabli to `https://<hostname>/ingest/payabli-settlements` and
   `.../payabli-batches`.

## Upgrade

Re-run the same command with a new `--image` tag. EFS is retained; config and
buffer survive. Deployment uses min healthy 0% / max 100% so only one writer runs.

## Tear down

```sh
./deploy/fargate/ops delete
# or non-interactive: ./deploy/fargate/ops delete -y --region eu-west-1
```

The **EFS filesystem is retained** (`DeletionPolicy: Retain`) so undeploy does not
wipe buffered events or config. Delete the filesystem (and secret) explicitly if
you intend a full wipe.
