import { createHmac } from 'node:crypto'
import {
  refSource,
  refTransform,
  type DateRef,
  type FieldRef,
  type RouteConfig,
} from '../config/schema.js'
import { hardDenyDeep } from '../mask/defaults.js'
import { getAtPath, leafPaths, type Json } from '../mask/paths.js'

export interface EndCloseRecord {
  date: string
  data_stream_key: string
  amount: number
  currency?: string
  direction: 'credit' | 'debit'
  description?: string
  external_id: string
  metadata: Record<string, Json>
}

export interface MapReport {
  /** output field -> source path (values marked when transformed) */
  mapped: Record<string, string>
  hashed: string[]
  /** payload leaf paths that do NOT leave the network */
  not_forwarded: string[]
}

export class MappingError extends Error {}

/** "3,762.87" | "3762.87" | "$38.00" | 3762.87 → integer cents. */
export function toCents(value: Json): number {
  let s: string
  if (typeof value === 'number') s = String(value)
  else if (typeof value === 'string') s = value.replace(/[$,\s]/g, '')
  else throw new MappingError(`amount is not a string or number: ${JSON.stringify(value)}`)
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw new MappingError(`unparseable amount: ${s}`)
  const negative = s.startsWith('-')
  if (negative) s = s.slice(1)
  const [whole = '0', frac = ''] = s.split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0') || '0')
  return negative ? -cents : cents
}

/** Payabli transferTime arrives as "M/D/YYYY H:mm:ss"; End Close wants an ISO date. */
export function parseDate(value: Json, format: 'iso8601' | 'mdy_hms'): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MappingError(`date is not a string: ${JSON.stringify(value)}`)
  }
  if (format === 'mdy_hms') {
    const m = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/)
    if (!m) throw new MappingError(`unparseable M/D/YYYY date: ${value}`)
    return `${m[3]}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`
  }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) throw new MappingError(`unparseable date: ${value}`)
  return parsed.toISOString().slice(0, 10)
}

function hashValue(maskingKey: Buffer, value: Json): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value)
  return 'hmac256:' + createHmac('sha256', maskingKey).update(raw, 'utf8').digest('hex')
}

function resolve(ref: FieldRef, payload: Json, maskingKey: Buffer): Json | undefined {
  const value = getAtPath(payload, refSource(ref))
  if (value === undefined) return undefined
  if (refTransform(ref) === 'hash') return hashValue(maskingKey, value)
  return value
}

function dateSource(ref: DateRef): { source: string; format: 'iso8601' | 'mdy_hms' } {
  return typeof ref === 'string' ? { source: ref, format: 'iso8601' } : ref
}

export interface MappedEvent {
  record: EndCloseRecord
  report: MapReport
}

/**
 * Map a webhook payload to an End Close record. Only fields named in the route's `map`
 * block are forwarded — the map IS the allowlist. Every mapped value additionally passes
 * through the hard denylist (PAN/SSN redaction), so no configuration can forward those
 * in clear. This is the only place payload data crosses toward the network path.
 */
export function mapEvent(
  route: RouteConfig,
  payload: Json,
  receivedAt: string,
  maskingKey: Buffer,
): MappedEvent {
  const { map: m } = route
  const report: MapReport = { mapped: {}, hashed: [], not_forwarded: [] }
  const usedPaths = new Set<string>()

  const use = (field: string, ref: FieldRef): Json | undefined => {
    const value = resolve(ref, payload, maskingKey)
    if (value === undefined) return undefined
    report.mapped[field] = refSource(ref)
    if (refTransform(ref) === 'hash') report.hashed.push(field)
    usedPaths.add(refSource(ref))
    return value
  }

  const externalId = use('external_id', m.external_id)
  if (typeof externalId !== 'string' && typeof externalId !== 'number') {
    throw new MappingError(`missing external id at ${refSource(m.external_id)}`)
  }

  const amount = toCents(use('amount', m.amount) ?? null)

  let date: string
  if (m.date) {
    const { source, format } = dateSource(m.date)
    date = parseDate(getAtPath(payload, source) ?? null, format)
    report.mapped['date'] = source
    usedPaths.add(source)
  } else {
    date = receivedAt.slice(0, 10)
    report.mapped['date'] = '(receive time)'
  }

  const metadata: Record<string, Json> = {}
  for (const [outputKey, ref] of Object.entries(m.metadata)) {
    const value = use(`metadata.${outputKey}`, ref)
    if (value !== undefined) metadata[outputKey] = hardDenyDeep(value)
  }

  const record: EndCloseRecord = {
    date,
    data_stream_key: m.data_stream_key,
    amount,
    direction: m.direction,
    external_id: String(externalId),
    metadata,
  }
  if (m.currency) record.currency = m.currency
  if (m.description) {
    const desc = use('description', m.description)
    if (typeof desc === 'string') record.description = hardDenyDeep(desc)
  }

  // Everything in the payload that was not explicitly mapped stays local.
  const wildcardPrefixes = [...usedPaths]
    .filter((p) => p.includes('*'))
    .map((p) => new RegExp('^' + p.split('.').map((s) => (s === '*' ? '[^.]+' : escapeRe(s))).join('\\.') + '$'))
  report.not_forwarded = leafPaths(payload).filter(
    (leaf) => !usedPaths.has(leaf) && !wildcardPrefixes.some((re) => re.test(leaf)),
  )

  return { record, report }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
