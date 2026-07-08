// Typed client for the relay admin API (same origin; Vite proxies in dev).
// Read-only by design: mutations go through relayctl so they carry an actor.

export interface RouteStatus {
  id: string
  source: string
  data_stream_key: string
  paused: boolean
  counts: Partial<Record<string, number>>
  last_delivered_at: string | null
  oldest_pending_age_s: number | null
}

export interface Status {
  version: string
  uptime_s: number
  config_hash: string | null
  config_applied_at: string | null
  killswitch: { global: 'none' | 'pause' | 'panic'; routes_paused: string[] }
  queue: Partial<Record<string, number>>
  routes: RouteStatus[]
  storage: { db_path: string; db_bytes: number }
}

export interface EventSummary {
  id: number
  route_id: string
  source: string
  event_id: string
  event_type: string | null
  received_at: string
  status: string
  attempts: number
  next_attempt_at: string | null
  delivered_at: string | null
  bulk_request_id: string | null
  last_error: string | null
}

export interface AuditRow {
  id: number
  at: string
  actor: string
  action: string
  detail_json: string
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json() as Promise<T>
}

export const fetchStatus = () => get<Status>('/status')

export function fetchEvents(filter: { status?: string; route?: string; limit?: number }) {
  const params = new URLSearchParams()
  if (filter.status) params.set('status', filter.status)
  if (filter.route) params.set('route', filter.route)
  params.set('limit', String(filter.limit ?? 100))
  return get<EventSummary[]>(`/events?${params}`)
}

export const fetchAudit = (limit = 200) => get<AuditRow[]>(`/audit?limit=${limit}`)
