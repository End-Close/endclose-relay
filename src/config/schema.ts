import { z } from 'zod'
import { keyNameIsSensitive } from '../mask/defaults.js'

// Dot-notation path into the webhook payload, e.g. "batchId", "batch.id",
// "transactions.*.id" (a `*` segment fans out over an array).
const dotPath = z
  .string()
  .regex(/^[^\s.]+(\.[^\s.]+)*$/, 'must be a dot-notation path like batchId or batch.id')

export const transformNameSchema = z.enum(['trim', 'lowercase', 'hash'])
export type TransformName = z.infer<typeof transformNameSchema>

// A mapped field: either a bare source path, or an object with optional transforms
// (single or array, applied in order).
//   external_id: transferId
//   customer_email: { source: CustomerEmail, transform: hash }
//   customer_email: { source: CustomerEmail, transform: [trim, lowercase, hash] }
export const fieldRefSchema = z.union([
  dotPath,
  z.object({
    source: dotPath,
    transform: z.union([transformNameSchema, z.array(transformNameSchema).min(1)]).optional(),
  }),
])
export type FieldRef = z.infer<typeof fieldRefSchema>

export function refSource(ref: FieldRef): string {
  return typeof ref === 'string' ? ref : ref.source
}
export function refTransforms(ref: FieldRef): TransformName[] {
  if (typeof ref === 'string' || ref.transform === undefined) return []
  return Array.isArray(ref.transform) ? ref.transform : [ref.transform]
}

const dateRefSchema = z.union([
  dotPath,
  z.object({
    source: dotPath,
    format: z.enum(['iso8601', 'mdy_hms']).default('iso8601'),
  }),
])
export type DateRef = z.infer<typeof dateRefSchema>

export const payabliAuthSchema = z.object({
  mode: z.literal('static_header'),
  header: z.string().default('authorization'),
  // Name of the env var holding the expected header value. The value itself never
  // appears in config or the database.
  secret_env: z.string(),
  allowed_ips: z.array(z.string()).default([]),
})

export const genericHmacAuthSchema = z.object({
  mode: z.literal('hmac'),
  header: z.string(),
  algorithm: z.enum(['sha256', 'sha512']).default('sha256'),
  secret_env: z.string(),
  // What gets signed: '{body}' or '{timestamp}.{body}'
  signed_content: z.enum(['body', 'timestamp.body']).default('body'),
  timestamp_header: z.string().optional(),
  tolerance_seconds: z.number().int().positive().default(300),
  // Where this processor keeps its stable event ID / event type in the payload.
  event_id: dotPath.optional(),
  event_type: dotPath.optional(),
})

// How a webhook event becomes an End Close record. This block is the complete answer to
// "what leaves our network": only fields named here are forwarded, ever.
export const recordMapSchema = z
  .object({
    data_stream_key: z.string().min(1),
    external_id: fieldRefSchema,
    // Source of a string amount like "3,762.87"; converted to integer cents.
    amount: fieldRefSchema,
    direction: z.enum(['credit', 'debit']),
    // Optional payload timestamp. Absent -> the record is dated by receive time.
    date: dateRefSchema.optional(),
    description: fieldRefSchema.optional(),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .optional(),
    // Extra fields to forward, as output_name: source. Output names are what End Close
    // property definitions see, so choose clean snake_case names.
    metadata: z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), fieldRefSchema).default({}),
  })
  .superRefine((map, ctx) => {
    for (const [outputKey, ref] of Object.entries(map.metadata)) {
      const sourceLeaf = refSource(ref).split('.').at(-1)!
      for (const name of [outputKey, sourceLeaf]) {
        if (keyNameIsSensitive(name) && !refTransforms(ref).includes('hash')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['metadata', outputKey],
            message: `"${name}" matches the hard denylist (cvv/ssn/account number/...); it cannot be forwarded in clear — use transform: hash or remove it`,
          })
        }
      }
    }
  })

export const routeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'route id must be a lowercase slug'),
  source: z.enum(['payabli', 'generic_hmac']),
  auth: z.discriminatedUnion('mode', [payabliAuthSchema, genericHmacAuthSchema]),
  // Payload event types accepted by this route (adapter-extracted; glob '*' allowed).
  // Non-matching events persist locally as dropped_by_filter and are never forwarded.
  events: z.array(z.string()).min(1).optional(),
  map: recordMapSchema,
  max_body_bytes: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024)
    .default(1024 * 1024),
})

export const relayConfigSchema = z.object({
  endclose: z.object({
    base_url: z.string().url().default('https://api.endclose.com/v1'),
    api_key_env: z.string().default('ENDCLOSE_API_KEY'),
  }),
  ingest: z
    .object({
      port: z.number().int().default(8443),
      host: z.string().default('0.0.0.0'),
    })
    .default({}),
  storage: z
    .object({
      db_path: z.string().default('/var/lib/endclose-relay/relay.db'),
    })
    .default({}),
  dispatch: z
    .object({
      batch_max: z.number().int().positive().max(1000).default(100),
      poll_interval_ms: z.number().int().positive().default(250),
      backoff_base_ms: z.number().int().positive().default(1000),
      backoff_cap_ms: z.number().int().positive().default(600_000),
      park_after_ms: z
        .number()
        .int()
        .positive()
        .default(7 * 24 * 3600 * 1000),
    })
    .default({}),
  routes: z.array(routeSchema).min(1),
})

export type RelayConfig = z.infer<typeof relayConfigSchema>
export type RouteConfig = z.infer<typeof routeSchema>
export type RecordMap = z.infer<typeof recordMapSchema>
export type PayabliAuth = z.infer<typeof payabliAuthSchema>
export type GenericHmacAuth = z.infer<typeof genericHmacAuthSchema>
