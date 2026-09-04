import type { RouteConfig } from '../../config/schema.js'
import type { Json } from '../../mask/paths.js'

export interface RawRequest {
  rawBody: Buffer
  headers: Record<string, string | string[] | undefined>
  remoteIp: string
}

export type VerifyResult = { ok: true } | { ok: false; reason: string }

/** Resolved by the engine before verification so adapters stay pure and synchronous. */
export interface VerifyContext {
  /** The value of the route's `auth.secret_env` reference. */
  secret: string
}

export interface ProcessorAdapter {
  name: string
  /** Verify authenticity over the raw bytes. Must be constant-time on secret comparisons. */
  verify(req: RawRequest, route: RouteConfig, ctx: VerifyContext): VerifyResult
  /** Stable per-event ID used for idempotency. Falls back to a raw-body hash. */
  extractEventId(body: Json, req: RawRequest, route: RouteConfig): string
  extractEventType(body: Json, req: RawRequest, route: RouteConfig): string | null
}

export function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const v = headers[name.toLowerCase()]
  return Array.isArray(v) ? v[0] : v
}
