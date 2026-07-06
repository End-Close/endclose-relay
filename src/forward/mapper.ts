import type { RouteConfig } from '../config/schema.js'
import { mask } from '../mask/engine.js'
import { getAtPointer, type Json } from '../mask/paths.js'

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

/**
 * Map a webhook payload to an End Close record. Masking runs here, at dispatch time:
 * everything in `metadata` has been through the mask engine, so this function is the
 * only place payload data crosses toward the network path.
 */
export function mapEvent(
  route: RouteConfig,
  payload: Json,
  receivedAt: string,
  maskingKey: Buffer,
): EndCloseRecord {
  const { map: m } = route

  const externalId = getAtPointer(payload, m.external_id_pointer)
  if (typeof externalId !== 'string' && typeof externalId !== 'number') {
    throw new MappingError(`missing external id at ${m.external_id_pointer}`)
  }

  const amount = toCents(getAtPointer(payload, m.amount_pointer) ?? null)

  const date = m.date_pointer
    ? parseDate(getAtPointer(payload, m.date_pointer) ?? null, m.date_format)
    : receivedAt.slice(0, 10)

  const { output } = mask(route.mask, payload, maskingKey)
  const metadata =
    output !== null && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, Json>)
      : {}

  const record: EndCloseRecord = {
    date,
    data_stream_key: m.data_stream_key,
    amount,
    direction: m.direction,
    external_id: String(externalId),
    metadata,
  }
  if (m.currency) record.currency = m.currency
  if (m.description_pointer) {
    const desc = getAtPointer(payload, m.description_pointer)
    if (typeof desc === 'string') record.description = desc
  }
  return record
}
