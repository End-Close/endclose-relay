import { createHash, timingSafeEqual } from 'node:crypto'
import { resolveSecret } from '../../config/load.js'
import type { RouteConfig } from '../../config/schema.js'
import { getAtPath, type Json } from '../../mask/paths.js'
import { headerValue, type ProcessorAdapter, type RawRequest, type VerifyResult } from './types.js'

// Payabli does not sign webhooks. Trust boundary: a customer-defined static header
// (configured on the Payabli notification via webHeaderParameters) compared in constant
// time, plus an optional source-IP allowlist (Payabli publishes one static IP per env:
// sandbox 52.3.204.115, production 54.166.54.170).

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) {
    // Compare against self to keep timing independent of the mismatch position.
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

// Stable-ID field per payload Event type, per Payabli's OpenAPI webhook schemas.
const EVENT_ID_PATHS: Record<string, string> = {
  TransferFunded: 'transferId', // payout_batch_settlement_funded
  PayOutBatchPaid: 'BatchId', // payout_batch_paid
}

export const payabliAdapter: ProcessorAdapter = {
  name: 'payabli',

  verify(req: RawRequest, route: RouteConfig): VerifyResult {
    if (route.auth.mode !== 'static_header') {
      return { ok: false, reason: 'route auth mode mismatch' }
    }
    if (route.auth.allowed_ips.length > 0 && !route.auth.allowed_ips.includes(req.remoteIp)) {
      return { ok: false, reason: 'source ip not allowed' }
    }
    const presented = headerValue(req.headers, route.auth.header)
    if (!presented) return { ok: false, reason: `missing ${route.auth.header} header` }
    const expected = resolveSecret(route.auth.secret_env)
    if (!constantTimeEquals(presented, expected)) return { ok: false, reason: 'bad auth header' }
    return { ok: true }
  },

  extractEventId(body: Json, req: RawRequest): string {
    const eventType = getAtPath(body, 'Event')
    if (typeof eventType === 'string') {
      const path = EVENT_ID_PATHS[eventType]
      if (path) {
        const id = getAtPath(body, path)
        if (typeof id === 'string' && id.length > 0) return `${eventType}:${id}`
      }
    }
    return 'sha256:' + createHash('sha256').update(req.rawBody).digest('hex')
  },

  extractEventType(body: Json): string | null {
    const t = getAtPath(body, 'Event')
    return typeof t === 'string' ? t : null
  },
}
