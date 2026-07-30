#!/usr/bin/env bash
# Resolve the running Fargate task and open a shell / print the admin URL.
#
# Usage:
#   ./deploy/fargate/relay-task.sh exec
#   ./deploy/fargate/relay-task.sh admin          # print http://<ip>:8081
#   ./deploy/fargate/relay-task.sh admin --open   # also open in the browser (macOS)
#   ./deploy/fargate/relay-task.sh ip
#   ./deploy/fargate/relay-task.sh task
#
# Defaults (override with flags or env):
#   --stack / RELAY_STACK / ENDCLOSE_RELAY_STACK  (default: endclose-relay)
#   --region / RELAY_REGION / AWS_REGION           (prompted if missing)
#   --container / RELAY_CONTAINER                 (default: relay)
set -euo pipefail

STACK_DEFAULT='endclose-relay'
STACK="${RELAY_STACK:-${ENDCLOSE_RELAY_STACK:-$STACK_DEFAULT}}"
REGION="${RELAY_REGION:-${AWS_REGION:-${AWS_DEFAULT_REGION:-}}}"
CONTAINER="${RELAY_CONTAINER:-relay}"
OPEN_BROWSER=0
CMD=''

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [options]

Commands:
  exec              ECS Exec into the running task (/bin/sh)
  admin [--open]    Print admin UI URL (http://<private-ip>:8081)
  ip                Print the task private IPv4
  task              Print the running task ARN

Options:
  --stack NAME      CloudFormation / ECS cluster+service name (default: ${STACK_DEFAULT})
  --region REGION   AWS region (prompted if omitted)
  --container NAME  Container name (default: relay)
  --open            With admin: open the URL (macOS \`open\`, else xdg-open)
  -h, --help        Show this help

Env defaults: RELAY_STACK, RELAY_REGION (or AWS_REGION), RELAY_CONTAINER
EOF
  exit "${1:-0}"
}

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "missing dependency: $1"; }

# Prompt on a TTY when a value is missing; fail clearly in non-interactive use.
ask() {
  local prompt="$1" value=''
  if [ ! -t 0 ]; then
    die "$2"
  fi
  printf '%s' "$prompt" >&2
  IFS= read -r value || true
  value="$(printf '%s' "$value" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  [ -n "$value" ] || die "$2"
  printf '%s' "$value"
}

while [ $# -gt 0 ]; do
  case "$1" in
    exec|admin|ip|task)
      [ -z "$CMD" ] || die "unexpected extra command: $1"
      CMD="$1"
      shift
      ;;
    --stack) STACK="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --container) CONTAINER="$2"; shift 2 ;;
    --open) OPEN_BROWSER=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$CMD" ] || usage 1
if [ -z "$REGION" ]; then
  REGION="$(ask 'AWS region: ' '--region is required (or set AWS_REGION / RELAY_REGION)')"
fi

need aws

running_task() {
  local arn
  arn="$(aws ecs list-tasks \
    --region "$REGION" \
    --cluster "$STACK" \
    --service-name "$STACK" \
    --desired-status RUNNING \
    --query 'taskArns[0]' \
    --output text)"
  if [ -z "$arn" ] || [ "$arn" = None ] || [ "$arn" = null ]; then
    die "no RUNNING task on cluster/service $STACK ($REGION)"
  fi
  printf '%s' "$arn"
}

task_private_ip() {
  local arn="$1" ip
  ip="$(aws ecs describe-tasks \
    --region "$REGION" \
    --cluster "$STACK" \
    --tasks "$arn" \
    --query 'tasks[0].attachments[0].details[?name==`privateIPv4Address`].value | [0]' \
    --output text)"
  if [ -z "$ip" ] || [ "$ip" = None ] || [ "$ip" = null ]; then
    die "could not resolve private IP for $arn"
  fi
  printf '%s' "$ip"
}

case "$CMD" in
  task)
    running_task
    echo
    ;;
  ip)
    task_private_ip "$(running_task)"
    echo
    ;;
  admin)
    url="http://$(task_private_ip "$(running_task)"):8081"
    echo "$url"
    if [ "$OPEN_BROWSER" -eq 1 ]; then
      if command -v open >/dev/null; then
        open "$url"
      elif command -v xdg-open >/dev/null; then
        xdg-open "$url"
      else
        die "no browser opener found (install open/xdg-open, or copy the URL)"
      fi
    fi
    ;;
  exec)
    need session-manager-plugin
    arn="$(running_task)"
    echo "exec → $STACK / $arn ($CONTAINER)" >&2
    exec aws ecs execute-command \
      --region "$REGION" \
      --cluster "$STACK" \
      --task "$arn" \
      --container "$CONTAINER" \
      --interactive \
      --command '/bin/sh'
    ;;
esac
