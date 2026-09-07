import { hardDenyDeep, keyNameIsSensitive } from '../mask/defaults.js'
import type { Json } from '../mask/paths.js'

// Host-supplied enrichments: named functions registered via createRelay({ enrichments })
// and referenced from a route's map with `enrich: <name>`. They run in the host process
// at dispatch time, after mapping and before the bulk POST. The engine never calls out
// anywhere on their behalf; whatever a function does with its input is the host's code.

export interface EnrichContext {
  routeId: string
  /** The route's processor adapter name, e.g. "payabli". */
  source: string
  /** Adapter-derived id, e.g. "ApprovedPayment:txn_1" (or "sha256:…" when unknown). */
  eventId: string
  eventType: string | null
  receivedAt: string
  /** Output field being computed: "metadata.<key>" or "description". */
  field: string
  /** The decrypted webhook payload, for inputs beyond the `source` value. */
  payload: Json
}

/**
 * Compute the value for one enriched field from the value at its `source` (after any
 * transforms). Return `undefined` to omit the field and still send the record. Throw to
 * retry the whole event later with backoff (the host's database was unavailable); throw
 * `EnrichmentError` to park it instead (the input is bad and a retry cannot help).
 */
export type Enrichment = (input: Json, ctx: EnrichContext) => Json | undefined | Promise<Json | undefined>

/** Enrichment cannot be applied to this event. Parks the event; never retried. */
export class EnrichmentError extends Error {}

export class EnrichTimeoutError extends Error {}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  if (typeof value === 'number') return `number ${String(value)}`
  if (typeof value === 'object') return `a ${value.constructor?.name ?? 'non-plain object'}`
  return `a ${typeof value}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function assertJson(value: unknown, path: string): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return
    throw new EnrichmentError(`enriched value at "${path}" is not JSON (${describe(value)})`)
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertJson(v, `${path}[${i}]`))
    return
  }
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (keyNameIsSensitive(k)) {
        throw new EnrichmentError(
          `enriched value at "${path}.${k}" matches the hard denylist (cvv/ssn/account number/...) and cannot be forwarded`,
        )
      }
      assertJson(v, `${path}.${k}`)
    }
    return
  }
  throw new EnrichmentError(`enriched value at "${path}" is not JSON (${describe(value)})`)
}

/**
 * Check what an enrichment returned before it may enter a record: JSON only (no
 * undefined-in-objects, functions, NaN, class instances), no sensitive key names at any
 * depth, and the hard denylist applied to every string. `undefined` means "omit".
 */
export function validateEnrichedValue(value: unknown, field: string): Json | undefined {
  if (value === undefined) return undefined
  assertJson(value, field)
  return hardDenyDeep(value as Json)
}

/**
 * Run a host callback under a deadline. A synchronous throw becomes a rejection; the timer
 * is cleared on settle so it never keeps the process alive. A timed-out call is abandoned,
 * not cancelled: hosts must treat enrichments as reads that may run more than once.
 */
export function withTimeout<T>(run: () => T | Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new EnrichTimeoutError(`timed out after ${ms} ms`)), ms)
    Promise.resolve()
      .then(run)
      .then(
        (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        (e: unknown) => {
          clearTimeout(timer)
          reject(e)
        },
      )
  })
}
