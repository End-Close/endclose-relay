// Typed client for the relay admin API (same origin; Vite proxies in dev).
// Basic auth is handled by the browser (401 → prompt); fetch reuses the cached credential.

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
  mode: 'bootstrap' | 'running'
  uptime_s: number
  secret_envs: { name: string; set: boolean }[]
  config_hash: string | null
  config_applied_at: string | null
  restart_pending: boolean
  killswitch: { global: 'none' | 'pause' | 'panic'; routes_paused: string[] }
  queue: Partial<Record<string, number>>
  routes: RouteStatus[]
  storage: { db_path: string; db_bytes: number; persistent: boolean | null }
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

export interface ConfigInfo {
  yaml: string
  hash: string
}

export interface ValidationResult {
  valid: boolean
  hash?: string
  routes?: string[]
  secret_envs?: { name: string; set: boolean }[]
  error?: string
}

export interface PreviewResult {
  record?: Record<string, unknown>
  report?: { mapped: Record<string, string>; hashed: string[]; not_forwarded: string[] }
  error?: string
}

export interface ConfigVersion {
  id: number
  applied_at: string
  config_hash: string
  applied_by: string
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? null : JSON.stringify(body),
  })
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

const get = <T>(path: string) => request<T>('GET', path)
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body)

export const fetchStatus = () => get<Status>('/status')

export function fetchEvents(filter: { status?: string; route?: string; limit?: number }) {
  const params = new URLSearchParams()
  if (filter.status) params.set('status', filter.status)
  if (filter.route) params.set('route', filter.route)
  params.set('limit', String(filter.limit ?? 100))
  return get<EventSummary[]>(`/events?${params}`)
}

export const fetchAudit = (limit = 200) => get<AuditRow[]>(`/audit?limit=${limit}`)

export const setKillswitch = (state: 'none' | 'pause' | 'panic') =>
  post<{ global: string }>('/killswitch', { state })

export const setRoutePaused = (route: string, paused: boolean) =>
  post<{ route: string; paused: boolean }>(`/routes/${route}/pause`, { paused })

export const replayEvent = (id: number) => post<{ replayed: number }>(`/events/${id}/replay`)
export const replayAllParked = () => post<{ replayed: number }>('/events/replay-parked')

export const fetchConfig = () => get<ConfigInfo>('/config')
export const validateConfig = (yaml: string) => post<ValidationResult>('/config/validate', { yaml })
export const saveConfig = (yaml: string) =>
  post<{ applied: string; restart_pending: boolean; restarting?: boolean }>('/config', { yaml })
export const previewConfig = (yaml: string, route: string, sample: unknown) =>
  post<PreviewResult>('/config/preview', { yaml, route, sample })
export const fetchConfigVersions = () => get<ConfigVersion[]>('/config/versions')
export const fetchConfigVersion = (id: number) =>
  get<ConfigVersion & { config_yaml: string }>(`/config/versions/${id}`)
