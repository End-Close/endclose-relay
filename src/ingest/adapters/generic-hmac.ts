import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { resolveSecret } from '../../config/load.js'
import type { RouteConfig } from '../../config/schema.js'
import { getAtPointer, type Json } from '../../mask/paths.js'
import { headerValue, type ProcessorAdapter, type RawRequest, type VerifyResult } from './types.js'

// Generic HMAC-signature adapter: covers processors that sign `body` or `timestamp.body`
// with a shared secret. Configuration lives entirely in the route's auth block, so most
// future processors need no code.

export const genericHmacAdapter: ProcessorAdapter = {
  name: 'generic_hmac',

  verify(req: RawRequest, route: RouteConfig): VerifyResult {
    if (route.auth.mode !== 'hmac') return { ok: false, reason: 'route auth mode mismatch' }
    const auth = route.auth

    let signedContent: Buffer = req.rawBody
    if (auth.signed_content === 'timestamp.body') {
      if (!auth.timestamp_header) return { ok: false, reason: 'timestamp_header not configured' }
      const ts = headerValue(req.headers, auth.timestamp_header)
      if (!ts) return { ok: false, reason: `missing ${auth.timestamp_header} header` }
      const skew = Math.abs(Date.now() / 1000 - Number(ts))
      if (!Number.isFinite(skew) || skew > auth.tolerance_seconds) {
        return { ok: false, reason: 'stale timestamp' }
      }
      signedContent = Buffer.concat([Buffer.from(`${ts}.`, 'utf8'), req.rawBody])
    }

    const presented = headerValue(req.headers, auth.header)
    if (!presented) return { ok: false, reason: `missing ${auth.header} header` }

    const secret = resolveSecret(auth.secret_env)
    const expectedHex = createHmac(auth.algorithm, secret).update(signedContent).digest('hex')
    // Accept optional "sha256=" style prefixes.
    const presentedHex = (presented.includes('=') && !/^[0-9a-f]+$/i.test(presented)
      ? presented.slice(presented.indexOf('=') + 1)
      : presented
    ).toLowerCase()

    const a = Buffer.from(expectedHex, 'utf8')
    const b = Buffer.from(presentedHex, 'utf8')
    if (a.length !== b.length) {
      timingSafeEqual(a, a)
      return { ok: false, reason: 'bad signature' }
    }
    if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' }
    return { ok: true }
  },

  extractEventId(body: Json, req: RawRequest, route: RouteConfig): string {
    if (route.auth.mode === 'hmac' && route.auth.event_id_pointer) {
      const id = getAtPointer(body, route.auth.event_id_pointer)
      if ((typeof id === 'string' && id.length > 0) || typeof id === 'number') return String(id)
    }
    return 'sha256:' + createHash('sha256').update(req.rawBody).digest('hex')
  },

  extractEventType(body: Json, _req: RawRequest, route: RouteConfig): string | null {
    if (route.auth.mode === 'hmac' && route.auth.event_type_pointer) {
      const t = getAtPointer(body, route.auth.event_type_pointer)
      return typeof t === 'string' ? t : null
    }
    return null
  },
}
