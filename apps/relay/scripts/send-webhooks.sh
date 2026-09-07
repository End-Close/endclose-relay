#!/usr/bin/env bash
# Fire the Payabli fixture webhooks at the locally running relay (see mprocs.yaml).
set -euo pipefail
cd "$(dirname "$0")/.."

AUTH="${PAYABLI_WEBHOOK_SECRET:-Bearer dev-webhook-secret}"
BASE="${RELAY_URL:-http://127.0.0.1:8443}"

echo "→ settlement funded"
curl -sS -X POST "$BASE/ingest/payabli-settlements" \
  -H "content-type: application/json" -H "authorization: $AUTH" \
  --data-binary @test/fixtures/payabli-settlement-funded.json
echo

echo "→ batch paid"
curl -sS -X POST "$BASE/ingest/payabli-batches" \
  -H "content-type: application/json" -H "authorization: $AUTH" \
  --data-binary @test/fixtures/payabli-batch-paid.json
echo

echo "→ duplicate settlement (should ack as duplicate)"
curl -sS -X POST "$BASE/ingest/payabli-settlements" \
  -H "content-type: application/json" -H "authorization: $AUTH" \
  --data-binary @test/fixtures/payabli-settlement-funded.json
echo
