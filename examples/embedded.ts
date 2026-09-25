// Minimal embedding with nothing but Node built-ins: the engine mounted on node:http with an
// in-memory store, dispatching once per second. From the repo root:
//
//   pnpm build:packages
//   ENDCLOSE_API_KEY=... PAYABLI_WEBHOOK_SECRET='Bearer x' pnpm --filter @end-close/relay-examples embedded
//
// Set REMOTE_CONFIG=1 to leave `routes` out: the engine then fetches them from End Close
// with the API key (which is environment-scoped, so it alone picks the environment).
//
// Then POST a Payabli fixture:
//   curl -X POST localhost:9000/webhooks/payabli-settlements -H 'authorization: Bearer x' \
//        --data-binary @apps/relay/test/fixtures/payabli-settlement-funded.json
// or a transaction, whose resident_name is filled by the enrichment below:
//   curl -X POST localhost:9000/webhooks/payabli-transactions -H 'authorization: Bearer x' \
//        --data-binary @apps/relay/test/fixtures/payabli-transaction.json
import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import {
  createRelay,
  parseRoutes,
  envSecrets,
  memoryStore,
  consoleLogger,
  type Enrichment,
} from "@end-close/relay";

// Stand-in for the host's own database: payer id → resident. In a real backend this is
// a query; the engine never sees the connection and makes no call of its own.
const residents = new Map([
  ["payor_4471", { fullName: "Pat Example", unit: "12B" }],
]);

const enrichments: Record<string, Enrichment> = {
  // Receives the value at the field's `source` (PayorId). undefined omits the field;
  // a throw retries the event later; `throw new EnrichmentError(...)` parks it.
  resident_name: (payorId) => residents.get(String(payorId))?.fullName,
};

// Same shape as the `routes` block of relay.yaml — a plain object, not YAML.
// The first two routes match relay.example.yaml (without Payabli's egress IP pin);
// the transaction route is added here, where the enrichment it names is registered.
const localRoutes = () =>
  parseRoutes(
    {
      routes: [
        {
          id: "payabli-transactions",
          source: "payabli",
          auth: {
            mode: "static_header",
            header: "authorization",
            secret_env: "PAYABLI_WEBHOOK_SECRET",
          },
          events: ["ApprovedPayment"],
          map: {
            data_stream_key: "payabli_transactions",
            external_id: "TransactionId",
            amount: "NetAmount",
            direction: "credit",
            date: { source: "TransactionTime", format: "mdy_hms" },
            metadata: {
              paypoint: "Paypoint",
              resident_name: { source: "PayorId", enrich: "resident_name" },
            },
          },
        },
      ],
    },
    { enrichments },
  );

const relay = createRelay({
  routes: localRoutes(),
  store: memoryStore(),
  secrets: envSecrets(process.env),
  endclose: {
    apiKey: process.env.ENDCLOSE_API_KEY ?? "",
    ...(process.env.ENDCLOSE_BASE_URL
      ? { baseUrl: process.env.ENDCLOSE_BASE_URL }
      : {}),
  },
  encryption: "none",
  maskingKey: "example-masking-key-not-a-secret",
  enrichments,
  logger: consoleLogger,
});
relay.on("delivered", (e) => console.log("delivered", e.routeId));
relay.on("forward", (e) => console.log(e.result, e.routeId, e.count));

createServer(async (req, res) => {
  const m = req.url?.match(/^\/webhooks\/([a-z0-9-_]+)$/);
  if (req.method !== "POST" || !m) return res.writeHead(404).end();
  const result = await relay.ingest(m[1]!, {
    rawBody: await buffer(req),
    headers: req.headers,
    remoteIp: req.socket.remoteAddress ?? "",
  });
  res
    .writeHead(result.status, { "content-type": "application/json" })
    .end(JSON.stringify(result.body));
}).listen(9000, () => console.log("listening on :9000"));
