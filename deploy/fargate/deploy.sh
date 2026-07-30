#!/usr/bin/env bash
# Deploy endclose-relay to AWS Fargate + EFS + ALB.
#
# Prerequisites: aws CLI v2, jq, credentials for the target account/region.
# You supply an existing VPC (public + private subnets) and an ACM certificate.
#
# Usage:
#   cp deploy/fargate/secrets.example.env deploy/fargate/secrets.env   # fill in
#   ./deploy/fargate/deploy.sh \
#     --region eu-west-1 \
#     --vpc vpc-xxx \
#     --public-subnets subnet-a,subnet-b \
#     --private-subnets subnet-c,subnet-d \
#     --certificate-arn arn:aws:acm:eu-west-1:123:certificate/… \
#     --secrets-file deploy/fargate/secrets.env
#
# Stack/cluster/service name defaults to endclose-relay (--stack to override).
# Re-run to update (new image tag, secret rotation after put-secret, etc.).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="${ROOT}/cloudformation.yaml"
IMAGE_DEFAULT='ghcr.io/end-close/relay:latest'
STACK_DEFAULT='endclose-relay'

STACK="$STACK_DEFAULT"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-}}"
VPC=''
PUBLIC_SUBNETS=''
PRIVATE_SUBNETS=''
CERTIFICATE_ARN=''
SECRETS_FILE=''
SECRET_NAME=''
IMAGE="$IMAGE_DEFAULT"
ADMIN_CIDR=''
ASSIGN_PUBLIC_IP='DISABLED'
CPU='512'
MEMORY='1024'
SKIP_SECRETS=0

usage() {
  sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
  cat <<EOF

Options:
  --stack NAME              CloudFormation stack name (default: ${STACK_DEFAULT})
  --region REGION           AWS region (required if not in env)
  --vpc ID                  VPC id (required)
  --public-subnets IDS      Comma-separated public subnet ids for the ALB (≥1)
  --private-subnets IDS     Comma-separated private subnet ids for tasks+EFS (≥2)
  --certificate-arn ARN     ACM certificate ARN in this region (required)
  --secrets-file PATH       dotenv file; create/update the Secrets Manager secret from it
  --secret-name NAME        Secrets Manager name (default: STACK/relay). Alone (no
                            --secrets-file) = use an existing secret, do not upload
  --skip-secrets            Same as omitting --secrets-file when the secret already exists
  --image URI               Container image (default: ${IMAGE_DEFAULT})
  --admin-cidr CIDR         Optional CIDR allowed to hit task :8081 (VPN/bastion)
  --assign-public-ip        Assign public IPs to tasks (no NAT); default off
  --cpu N                   Fargate CPU units (default: 512)
  --memory N                Fargate memory MiB (default: 1024)
  -h, --help                Show this help
EOF
  exit "${1:-0}"
}

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }

dotenv_get() {
  # Usage: dotenv_get FILE KEY → prints value (no export). Bash 3.2-safe.
  local file="$1" want="$2" line key value
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|\#*) continue ;;
    esac
    key="${line%%=*}"
    value="${line#*=}"
    key="$(printf '%s' "$key" | tr -d '[:space:]')"
    value="$(printf '%s' "$value" | sed -e 's/^["'\'']//' -e 's/["'\'']$//')"
    if [ "$key" = "$want" ]; then
      printf '%s' "$value"
      return 0
    fi
  done <"$file"
  return 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --stack) STACK="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --vpc) VPC="$2"; shift 2 ;;
    --public-subnets) PUBLIC_SUBNETS="$2"; shift 2 ;;
    --private-subnets) PRIVATE_SUBNETS="$2"; shift 2 ;;
    --certificate-arn) CERTIFICATE_ARN="$2"; shift 2 ;;
    --secrets-file) SECRETS_FILE="$2"; shift 2 ;;
    --secret-name) SECRET_NAME="$2"; shift 2 ;;
    --skip-secrets) SKIP_SECRETS=1; shift ;;
    --image) IMAGE="$2"; shift 2 ;;
    --admin-cidr) ADMIN_CIDR="$2"; shift 2 ;;
    --assign-public-ip) ASSIGN_PUBLIC_IP='ENABLED'; shift ;;
    --cpu) CPU="$2"; shift 2 ;;
    --memory) MEMORY="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

need aws
need jq

[ -n "$STACK" ] || die "--stack cannot be empty"
[ -n "$REGION" ] || die "--region is required (or set AWS_REGION)"
[ -n "$VPC" ] || die "--vpc is required"
[ -n "$PUBLIC_SUBNETS" ] || die "--public-subnets is required"
[ -n "$PRIVATE_SUBNETS" ] || die "--private-subnets is required"
[ -n "$CERTIFICATE_ARN" ] || die "--certificate-arn is required"
[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"

SECRET_NAME="${SECRET_NAME:-${STACK}/relay}"

# Existing secret only: --secret-name without --secrets-file (or explicit --skip-secrets).
if [ -z "$SECRETS_FILE" ]; then
  SKIP_SECRETS=1
fi

PUBLIC_COUNT="$(printf '%s' "$PUBLIC_SUBNETS" | awk -F, '{print NF}')"
PRIVATE_COUNT="$(printf '%s' "$PRIVATE_SUBNETS" | awk -F, '{print NF}')"
[ "$PUBLIC_COUNT" -ge 1 ] || die "need at least one public subnet"
[ "$PRIVATE_COUNT" -ge 2 ] || die "need at least two private subnets (EFS mount targets across AZs)"

# ── Secrets ───────────────────────────────────────────────────────────────────
upsert_secret() {
  local json
  json="$(jq -n \
    --arg a "$1" --arg b "$2" --arg c "$3" --arg d "$4" --arg e "$5" \
    '{
      ENDCLOSE_API_KEY:$a,
      PAYABLI_WEBHOOK_SECRET:$b,
      RELAY_DATA_KEY:$c,
      MASKING_HMAC_KEY:$d,
      ADMIN_BASIC_AUTH:$e
    }')"

  if aws secretsmanager describe-secret --region "$REGION" --secret-id "$SECRET_NAME" >/dev/null 2>&1; then
    echo "→ updating secret $SECRET_NAME"
    aws secretsmanager put-secret-value \
      --region "$REGION" \
      --secret-id "$SECRET_NAME" \
      --secret-string "$json" >/dev/null
  else
    echo "→ creating secret $SECRET_NAME"
    aws secretsmanager create-secret \
      --region "$REGION" \
      --name "$SECRET_NAME" \
      --secret-string "$json" \
      --tags "Key=Name,Value=${STACK}-relay" >/dev/null
  fi
}

if [ "$SKIP_SECRETS" -eq 0 ]; then
  [ -f "$SECRETS_FILE" ] || die "secrets file not found: $SECRETS_FILE"

  ENDCLOSE_API_KEY="$(dotenv_get "$SECRETS_FILE" ENDCLOSE_API_KEY)" || die "secrets file missing ENDCLOSE_API_KEY"
  PAYABLI_WEBHOOK_SECRET="$(dotenv_get "$SECRETS_FILE" PAYABLI_WEBHOOK_SECRET)" || die "secrets file missing PAYABLI_WEBHOOK_SECRET"
  RELAY_DATA_KEY="$(dotenv_get "$SECRETS_FILE" RELAY_DATA_KEY)" || die "secrets file missing RELAY_DATA_KEY"
  MASKING_HMAC_KEY="$(dotenv_get "$SECRETS_FILE" MASKING_HMAC_KEY)" || die "secrets file missing MASKING_HMAC_KEY"
  ADMIN_BASIC_AUTH="$(dotenv_get "$SECRETS_FILE" ADMIN_BASIC_AUTH)" || die "secrets file missing ADMIN_BASIC_AUTH"

  case "$ADMIN_BASIC_AUTH" in
    *:*) ;;
    *) die "ADMIN_BASIC_AUTH must be user:password" ;;
  esac
  [ "${#RELAY_DATA_KEY}" -ge 32 ] || die "RELAY_DATA_KEY must be ≥32 characters"
  [ "${#MASKING_HMAC_KEY}" -ge 32 ] || die "MASKING_HMAC_KEY must be ≥32 characters"

  upsert_secret "$ENDCLOSE_API_KEY" "$PAYABLI_WEBHOOK_SECRET" "$RELAY_DATA_KEY" "$MASKING_HMAC_KEY" "$ADMIN_BASIC_AUTH"
else
  echo "→ using existing secret $SECRET_NAME (not uploading from a file)"
fi

SECRET_ARN="$(aws secretsmanager describe-secret \
  --region "$REGION" \
  --secret-id "$SECRET_NAME" \
  --query ARN --output text)"
[ -n "$SECRET_ARN" ] && [ "$SECRET_ARN" != None ] || die "could not resolve secret ARN for $SECRET_NAME"

# ── CloudFormation parameters (JSON avoids comma-parsing issues) ──────────────
PARAMS_FILE="$(mktemp)"
trap 'rm -f "$PARAMS_FILE"' EXIT

jq -n \
  --arg vpc "$VPC" \
  --arg pub "$PUBLIC_SUBNETS" \
  --arg priv "$PRIVATE_SUBNETS" \
  --arg cert "$CERTIFICATE_ARN" \
  --arg secret "$SECRET_ARN" \
  --arg image "$IMAGE" \
  --arg service "$STACK" \
  --arg pip "$ASSIGN_PUBLIC_IP" \
  --arg cpu "$CPU" \
  --arg mem "$MEMORY" \
  --arg admin "$ADMIN_CIDR" \
  '[
    {ParameterKey:"VpcId",ParameterValue:$vpc},
    {ParameterKey:"PublicSubnetIds",ParameterValue:$pub},
    {ParameterKey:"PrivateSubnetIds",ParameterValue:$priv},
    {ParameterKey:"CertificateArn",ParameterValue:$cert},
    {ParameterKey:"SecretArn",ParameterValue:$secret},
    {ParameterKey:"Image",ParameterValue:$image},
    {ParameterKey:"ServiceName",ParameterValue:$service},
    {ParameterKey:"AssignPublicIp",ParameterValue:$pip},
    {ParameterKey:"Cpu",ParameterValue:$cpu},
    {ParameterKey:"Memory",ParameterValue:$mem},
    {ParameterKey:"AdminCidr",ParameterValue:$admin}
  ]' >"$PARAMS_FILE"

echo "→ deploying stack $STACK in $REGION"
echo "   image: $IMAGE"
echo "   secret: $SECRET_ARN"

ACTION=none
if aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" >/dev/null 2>&1; then
  set +e
  OUT="$(aws cloudformation update-stack \
    --region "$REGION" \
    --stack-name "$STACK" \
    --template-body "file://${TEMPLATE}" \
    --capabilities CAPABILITY_IAM \
    --parameters "file://${PARAMS_FILE}" 2>&1)"
  RC=$?
  set -e
  if [ "$RC" -ne 0 ]; then
    if echo "$OUT" | grep -qi 'No updates are to be performed'; then
      echo "→ stack already up to date"
    else
      echo "$OUT" >&2
      die "update-stack failed"
    fi
  else
    ACTION=update
    echo "→ waiting for UPDATE_COMPLETE"
    if ! aws cloudformation wait stack-update-complete --region "$REGION" --stack-name "$STACK"; then
      aws cloudformation describe-stack-events --region "$REGION" --stack-name "$STACK" \
        --query 'StackEvents[?ResourceStatus!=`UPDATE_COMPLETE` && ResourceStatus!=`CREATE_COMPLETE`]|[0:15].[Timestamp,ResourceStatus,ResourceType,LogicalResourceId,ResourceStatusReason]' \
        --output table >&2 || true
      die "stack update failed"
    fi
  fi
else
  ACTION=create
  aws cloudformation create-stack \
    --region "$REGION" \
    --stack-name "$STACK" \
    --template-body "file://${TEMPLATE}" \
    --capabilities CAPABILITY_IAM \
    --parameters "file://${PARAMS_FILE}" \
    --tags "Key=Application,Value=endclose-relay" >/dev/null
  echo "→ waiting for CREATE_COMPLETE (EFS + service often ~5–10 minutes)"
  if ! aws cloudformation wait stack-create-complete --region "$REGION" --stack-name "$STACK"; then
    aws cloudformation describe-stack-events --region "$REGION" --stack-name "$STACK" \
      --query 'StackEvents[?ResourceStatus==`CREATE_FAILED` && ResourceStatusReason!=`Resource creation cancelled`].[Timestamp,LogicalResourceId,ResourceStatusReason]' \
      --output table >&2 || true
    die "stack create failed — delete the ROLLBACK_COMPLETE stack before retrying: aws cloudformation delete-stack --region $REGION --stack-name $STACK"
  fi
fi

# Secret-only changes do not update the task definition — force a bounce.
if [ "$SKIP_SECRETS" -eq 0 ] && [ "$ACTION" = none ]; then
  echo "→ forcing ECS service redeploy to pick up secret values"
  aws ecs update-service \
    --region "$REGION" \
    --cluster "$STACK" \
    --service "$STACK" \
    --force-new-deployment >/dev/null
fi

echo "→ waiting for ECS service stable"
aws ecs wait services-stable \
  --region "$REGION" \
  --cluster "$STACK" \
  --services "$STACK"

outputs_json="$(aws cloudformation describe-stacks \
  --region "$REGION" \
  --stack-name "$STACK" \
  --query 'Stacks[0].Outputs' --output json)"

alb_dns="$(echo "$outputs_json" | jq -r '.[] | select(.OutputKey=="LoadBalancerDns") | .OutputValue')"
ingest="$(echo "$outputs_json" | jq -r '.[] | select(.OutputKey=="IngestBaseUrl") | .OutputValue')"
fs_id="$(echo "$outputs_json" | jq -r '.[] | select(.OutputKey=="FileSystemId") | .OutputValue')"

cat <<EOF

══════════════════════════════════════════════════════════════════════════════
  endclose-relay is deployed
══════════════════════════════════════════════════════════════════════════════
  Stack:     $STACK
  Region:    $REGION
  Image:     $IMAGE
  ALB DNS:   $alb_dns
  Ingest:    $ingest/ingest/<route-id>
  EFS:       $fs_id  (DeletionPolicy=Retain — stack delete does NOT wipe data)
  Secret:    $SECRET_ARN

Next steps:
  1. DNS: create an Alias/CNAME from your relay hostname → $alb_dns
     (must match the ACM certificate).

  2. Admin / bootstrap — pick one (wrappers resolve the running task; stack defaults to endclose-relay):
       a) Tailscale/VPN (with --admin-cidr):
            ./deploy/fargate/relay-task.sh admin --open
       b) ECS Exec + relayctl (uses ADMIN_BASIC_AUTH from env; needs Session Manager plugin):
            ./deploy/fargate/relay-task.sh exec
            relayctl status
            relayctl config apply - < relay.yaml

  3. Payabli notifications → https://<your-hostname>/ingest/payabli-settlements
     and .../ingest/payabli-batches with Authorization = PAYABLI_WEBHOOK_SECRET.

  4. Upgrade later: re-run with --image ghcr.io/end-close/relay:<new> (same EFS).
══════════════════════════════════════════════════════════════════════════════
EOF
