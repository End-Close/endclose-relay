import { z } from 'zod'

// A JSON Pointer path with optional `*` wildcard segments, e.g. /transactions/*/Id
const jsonPointer = z
  .string()
  .regex(/^\/(?:[^/]+)(?:\/[^/]+)*$/, 'must be a JSON Pointer like /Field or /a/*/b')

export const maskTransformSchema = z.object({
  path: jsonPointer,
  action: z.enum(['redact', 'hash', 'drop']),
})

export const maskConfigSchema = z.object({
  mode: z.enum(['allowlist', 'denylist']).default('allowlist'),
  allow: z.array(jsonPointer).default([]),
  transforms: z.array(maskTransformSchema).default([]),
})

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
  event_id_pointer: jsonPointer.optional(),
  event_type_pointer: jsonPointer.optional(),
})

export const fieldExtractorSchema = z.object({
  pointer: jsonPointer,
})

// How a webhook event becomes an End Close record.
export const recordMapSchema = z.object({
  data_stream_key: z.string().min(1),
  external_id_pointer: jsonPointer,
  // Pointer to a string amount like "3762.87"; converted to integer cents.
  amount_pointer: jsonPointer,
  direction: z.enum(['credit', 'debit']),
  // Optional: pointer to a date/timestamp field. Absent -> received_at date.
  date_pointer: jsonPointer.optional(),
  date_format: z.enum(['iso8601', 'mdy_hms']).default('iso8601'),
  description_pointer: jsonPointer.optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional(),
})

export const routeSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-_]*$/, 'route id must be a lowercase slug'),
  source: z.enum(['payabli', 'generic_hmac']),
  auth: z.discriminatedUnion('mode', [payabliAuthSchema, genericHmacAuthSchema]),
  filter: z
    .object({
      // Payload Event values accepted by this route, e.g. ["TransferFunded"]. Glob '*' allowed.
      event_types: z.array(z.string()).min(1),
    })
    .optional(),
  mask: maskConfigSchema.default({ mode: 'allowlist', allow: [], transforms: [] }),
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
export type MaskConfig = z.infer<typeof maskConfigSchema>
export type MaskTransform = z.infer<typeof maskTransformSchema>
export type RecordMap = z.infer<typeof recordMapSchema>
export type PayabliAuth = z.infer<typeof payabliAuthSchema>
export type GenericHmacAuth = z.infer<typeof genericHmacAuthSchema>
