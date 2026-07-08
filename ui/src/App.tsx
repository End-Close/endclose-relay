import { useEffect, useState } from 'react'
import {
  fetchAudit,
  fetchEvents,
  fetchStatus,
  type AuditRow,
  type EventSummary,
  type Status,
} from './api.js'
import { fmtAgo, fmtBytes, fmtDuration, fmtTime } from './format.js'

const REFRESH_MS = 5000

/** Poll a fetcher while its consumer is mounted; null until the first response. */
function usePolled<T>(fetcher: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null } {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const tick = () =>
      fetcher().then(
        (d) => live && (setData(d), setError(null)),
        (e: Error) => live && setError(e.message),
      )
    tick()
    const timer = setInterval(tick, REFRESH_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, error }
}

function KillswitchPill({ status }: { status: Status }) {
  const ks = status.killswitch.global
  if (ks === 'none') return <span className="pill ok">forwarding</span>
  return <span className={`pill ${ks === 'panic' ? 'bad' : 'warn'}`}>killswitch: {ks}</span>
}

function RoutesTable({ status }: { status: Status }) {
  return (
    <table>
      <thead>
        <tr>
          <th>route</th><th>stream</th><th>state</th><th>pending</th><th>retry</th>
          <th>parked</th><th>delivered</th><th>oldest pending</th><th>last delivered</th>
        </tr>
      </thead>
      <tbody>
        {status.routes.map((r) => (
          <tr key={r.id}>
            <td>{r.id}</td>
            <td>{r.data_stream_key}</td>
            <td>{r.paused ? <span className="warn">paused</span> : 'active'}</td>
            <td>{r.counts.pending ?? 0}</td>
            <td>{r.counts.retry ?? 0}</td>
            <td className={r.counts.parked ? 'bad' : ''}>{r.counts.parked ?? 0}</td>
            <td>{r.counts.delivered ?? 0}</td>
            <td>{r.oldest_pending_age_s == null ? '—' : fmtDuration(r.oldest_pending_age_s)}</td>
            <td title={fmtTime(r.last_delivered_at)}>{fmtAgo(r.last_delivered_at)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

const EVENT_STATUSES = ['', 'pending', 'retry', 'delivering', 'delivered', 'parked', 'dropped_by_filter']

function EventsTab({ routes }: { routes: string[] }) {
  const [status, setStatus] = useState('')
  const [route, setRoute] = useState('')
  const { data, error } = usePolled(
    () => fetchEvents({ ...(status && { status }), ...(route && { route }) }),
    [status, route],
  )
  return (
    <>
      <div className="filters">
        <label>
          status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            {EVENT_STATUSES.map((s) => (
              <option key={s} value={s}>{s || 'all'}</option>
            ))}
          </select>
        </label>
        <label>
          route{' '}
          <select value={route} onChange={(e) => setRoute(e.target.value)}>
            <option value="">all</option>
            {routes.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </label>
        {error && <span className="bad">{error}</span>}
      </div>
      <table>
        <thead>
          <tr>
            <th>#</th><th>status</th><th>route</th><th>event</th><th>received</th>
            <th>attempts</th><th>last error</th>
          </tr>
        </thead>
        <tbody>
          {(data ?? []).map((e: EventSummary) => (
            <tr key={e.id}>
              <td>{e.id}</td>
              <td className={e.status === 'parked' ? 'bad' : e.status === 'retry' ? 'warn' : ''}>{e.status}</td>
              <td>{e.route_id}</td>
              <td>{e.event_type ?? '?'}</td>
              <td title={fmtTime(e.received_at)}>{fmtAgo(e.received_at)}</td>
              <td>{e.attempts}</td>
              <td className="error-cell muted">{e.last_error ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <div className="empty">no events match</div>}
      {data && data.some((e) => e.status === 'parked') && (
        <p className="muted">replay parked events with: relayctl events replay --parked</p>
      )}
    </>
  )
}

function AuditTab() {
  const { data, error } = usePolled(() => fetchAudit(), [])
  return (
    <>
      {error && <p className="bad">{error}</p>}
      <table>
        <thead>
          <tr><th>at</th><th>actor</th><th>action</th><th>detail</th></tr>
        </thead>
        <tbody>
          {(data ?? []).map((a: AuditRow) => (
            <tr key={a.id}>
              <td title={fmtTime(a.at)}>{fmtAgo(a.at)}</td>
              <td>{a.actor}</td>
              <td>{a.action}</td>
              <td className="muted">{a.detail_json}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.length === 0 && <div className="empty">no audit entries</div>}
    </>
  )
}

const TABS = ['status', 'events', 'audit'] as const

export default function App() {
  const [tab, setTab] = useState<(typeof TABS)[number]>('status')
  const { data: status, error } = usePolled(fetchStatus, [])

  return (
    <>
      <h1>
        endclose-relay <small>{status ? `v${status.version}` : ''}</small>
      </h1>
      <p className="meta">
        {error && <span className="bad">relay unreachable: {error}</span>}
        {status && (
          <>
            uptime {fmtDuration(status.uptime_s)} · db {fmtBytes(status.storage.db_bytes)} · config{' '}
            <code className="hash" title={status.config_hash ?? ''}>
              {(status.config_hash ?? '?').slice(0, 19)}
            </code>{' '}
            · <KillswitchPill status={status} />
          </>
        )}
      </p>
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {tab === 'status' && status && <RoutesTable status={status} />}
      {tab === 'events' && <EventsTab routes={status?.routes.map((r) => r.id) ?? []} />}
      {tab === 'audit' && <AuditTab />}
    </>
  )
}
